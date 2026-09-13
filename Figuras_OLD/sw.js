// sw.js — Service Worker para GlosarioBachatero
// Cachea el "app shell" en el install (rápido). Los videos (figuras-manifest.json)
// y las canciones (script.js) se cachean aparte, disparados por mensaje desde la
// página, con reintentos y resume — así una descarga larga que se corta (batería,
// pantalla apagada, se cierra la pestaña) puede retomarse en vez de perderse toda.

const CACHE_VERSION = 'glosario-bachatero-v52'; // subí este número cuando quieras forzar un recache del shell
const APP_SHELL = [
  './',
  './index.html',
  './script.js',
  './style.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './figuras-manifest.json'
];

function broadcast(msg) {
  self.clients.matchAll().then((clients) => {
    clients.forEach((c) => c.postMessage(msg));
  });
}

// Saca las rutas de video (file7t / file8t) de figuras-manifest.json
async function getVideoUrls() {
  const res = await fetch('./figuras-manifest.json', { cache: 'no-store' });
  const data = await res.json();
  const urls = new Set();
  for (const combo of data.combos || []) {
    for (const dificultad of Object.values(combo.dificultades || {})) {
      for (const variante of dificultad) {
        if (variante.file7t) urls.add(variante.file7t);
        if (variante.file8t) urls.add(variante.file8t);
      }
    }
  }
  return Array.from(urls);
}

// Saca las rutas de canciones (Canciones/....mp3) del array `canciones` en script.js,
// ignorando las líneas comentadas con //.
async function getSongUrls() {
  const res = await fetch('./script.js', { cache: 'no-store' });
  const text = await res.text();
  const activeLines = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  const urls = new Set();
  const re = /file:\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(activeLines)) !== null) {
    urls.add(match[1]);
  }
  return Array.from(urls);
}

// Tamaño mínimo plausible para un video/mp3 real. Si el server devuelve una
// paginita de error con status 200 (muy común en hostings estáticos mal
// configurados), cache.add() la guardaría como si fuera el archivo real, sin
// avisar. Con esto la detectamos y la tratamos como fallo.
const MIN_MEDIA_BYTES = 20 * 1024; // 20 KB

// Intenta cachear una URL, con reintentos (útil en datos móviles inestables).
// A diferencia de cache.add(), acá SÍ inspeccionamos la respuesta antes de
// guardarla, para no cachear silenciosamente un 404 disfrazado de 200.
async function cacheOneWithRetry(cache, url, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, { cache: 'no-store' });

      if (response.type === 'opaque') {
        // Cross-origin sin CORS: no podemos leer status ni tamaño, la
        // guardamos igual (es el comportamiento estándar para este caso).
        await cache.put(url, response);
        return true;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      // OJO: acá antes hacíamos cache.put(url, response) directo, "en vivo"
      // (streaming). En datos móviles inestables eso puede guardar un video
      // CORTADO a la mitad sin que la promesa rechace — queda "cacheado"
      // (cache.match lo encuentra, el contador dice 100%) pero es un archivo
      // incompleto, y por eso al reproducirlo offline tira SRC_NOT_SUPPORTED
      // aunque el original en el servidor esté perfecto. Para evitarlo,
      // leemos el body COMPLETO a memoria primero y comparamos el tamaño
      // real contra el Content-Length declarado — si no coinciden, es un
      // corte a mitad de descarga y lo tratamos como fallo (reintenta).
      const blob = await response.blob();

      // Estos archivos vienen del servidor como 206 Partial Content INCLUSO
      // en el primer pedido normal (confirmado antes) — por eso hay que
      // sacar el tamaño total real del Content-Range cuando está, no solo
      // del Content-Length (que en un 206 es el tamaño del *pedazo*, salvo
      // que el pedazo sea el archivo entero).
      const contentRange = response.headers.get('content-range'); // "bytes 0-N/TOTAL"
      let expectedTotal = null;
      if (contentRange) {
        const m = /\/(\d+)$/.exec(contentRange);
        if (m) expectedTotal = Number(m[1]);
      } else {
        const lenHeader = response.headers.get('content-length');
        if (lenHeader) expectedTotal = Number(lenHeader);
      }

      if (expectedTotal && blob.size !== expectedTotal) {
        throw new Error(`Descarga incompleta o parcial: ${blob.size} de ${expectedTotal} bytes esperados`);
      }
      if (blob.size < MIN_MEDIA_BYTES) {
        throw new Error(`Respuesta sospechosamente chica (${blob.size} bytes) — ¿404 disfrazado de 200?`);
      }

      // CLAVE: guardamos SIEMPRE como 200 limpio, nunca como 206 — aunque el
      // servidor haya respondido 206 (que es lo normal acá). Guardar un 206
      // como si fuera "el archivo completo" es lo que rompía todo: después,
      // el Service Worker lo devolvía tal cual a cualquier pedido SIN header
      // Range, y un 206 respondiendo a un pedido sin rango es inválido — eso
      // es el SRC_NOT_SUPPORTED. El camino "reproducir uno por uno" nunca
      // tuvo este problema porque el fetch handler de abajo ya excluye
      // cachear respuestas 206 — pero acá, en la descarga en bloque, faltaba
      // esa misma regla.
      const headers = new Headers(response.headers);
      headers.delete('content-range');
      headers.set('content-length', String(blob.size));
      headers.set('accept-ranges', 'bytes');

      const normalizedResponse = new Response(blob, {
        status: 200,
        statusText: 'OK',
        headers
      });
      await cache.put(url, normalizedResponse);
      return true;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(`No se pudo cachear tras ${attempts} intentos:`, url, err);
        return false;
      }
      await new Promise((r) => setTimeout(r, 800 * (i + 1))); // backoff simple
    }
  }
  return false;
}

// Cachea una lista de URLs en tandas chicas, salteando lo que ya está cacheado
// (esto es lo que permite RESUMIR una descarga que se cortó antes de terminar).
async function cacheMissingUrls(cache, urls, label) {
  const total = urls.length;
  let done = 0;
  let failed = 0;
  const BATCH = 4; // pocas descargas simultáneas: en datos móviles, más batch = más timeouts

  const pending = [];
  for (const url of urls) {
    const existing = await cache.match(url, { ignoreVary: true });
    if (existing) {
      done++;
    } else {
      pending.push(url);
    }
  }

  broadcast({ type: 'sw-cache-progress', label, done, total, failed });

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    await Promise.all(
      batch.map((url) =>
        cacheOneWithRetry(cache, url, 3).then((ok) => {
          if (ok) done++;
          else failed++;
        })
      )
    );
    broadcast({ type: 'sw-cache-progress', label, done, total, failed });
  }

  console.log(`[${label}] Cacheados ${done}/${total} (${failed} fallaron).`);
  broadcast({ type: 'sw-cache-done', label, done, total, failed });
  return { done, total, failed };
}

// Evita que dos disparos de CACHE_MEDIA (ej: page load + botón "reintentar")
// corran el proceso en paralelo pisándose.
let mediaCachingPromise = null;
function cacheAllMedia(providedUrls) {
  if (mediaCachingPromise) return mediaCachingPromise;

  mediaCachingPromise = (async () => {
    const cache = await caches.open(CACHE_VERSION);

    try {
      // Preferimos SIEMPRE las URLs que manda la página (ya pasadas por
      // safeUrl/encodeURI, igual que al reproducir) — así garantizamos que
      // lo cacheado matchee con lo que realmente se va a pedir. getVideoUrls()
      // queda solo como respaldo si por algún motivo no llegaron en el mensaje.
      const videoUrls = (providedUrls && providedUrls.videoUrls && providedUrls.videoUrls.length)
        ? providedUrls.videoUrls
        : await getVideoUrls();
      await cacheMissingUrls(cache, videoUrls, 'videos');
    } catch (err) {
      console.error('No se pudo armar la lista de videos', err);
      broadcast({ type: 'sw-cache-error', label: 'videos', message: String(err) });
    }

    try {
      const songUrls = (providedUrls && providedUrls.songUrls && providedUrls.songUrls.length)
        ? providedUrls.songUrls
        : await getSongUrls();
      await cacheMissingUrls(cache, songUrls, 'canciones');
    } catch (err) {
      console.error('No se pudo armar la lista de canciones', err);
      broadcast({ type: 'sw-cache-error', label: 'canciones', message: String(err) });
    }

    // Reporta cuánto espacio quedó realmente usado — así se puede confirmar
    // si se guardaron de verdad los ~350MB o mucho menos (señal de que algo
    // se está descartando: cuota superada, respuestas chicas, etc).
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        broadcast({
          type: 'sw-cache-summary',
          usageMB: Math.round((usage || 0) / 1024 / 1024),
          quotaMB: Math.round((quota || 0) / 1024 / 1024)
        });
      } else {
        broadcast({ type: 'sw-cache-summary', usageMB: null, quotaMB: null });
      }
    } catch (err) {
      broadcast({ type: 'sw-cache-summary', usageMB: null, quotaMB: null });
    }
  })();

  mediaCachingPromise.finally(() => {
    mediaCachingPromise = null;
  });

  return mediaCachingPromise;
}

// Inspección puntual de una URL cacheada, para debug desde la app cuando
// falla un video/audio — sin esto había que adivinar a ciegas.
async function inspectUrl(url, target) {
  const respond = (result) => {
    if (target) target.postMessage(result);
    else broadcast(result);
  };
  try {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(url, { ignoreVary: true });
    if (!cached) {
      respond({ type: 'sw-inspect-result', url, cached: false });
      return;
    }
    const result = {
      type: 'sw-inspect-result',
      url,
      cached: true,
      status: cached.status,
      statusText: cached.statusText,
      contentType: cached.headers.get('content-type'),
      contentLength: cached.headers.get('content-length'),
      contentRange: cached.headers.get('content-range'),
      acceptRanges: cached.headers.get('accept-ranges')
    };
    try {
      const blob = await cached.clone().blob();
      result.actualBlobSize = blob.size;
    } catch (err) {
      result.blobReadError = String(err);
    }
    respond(result);
  } catch (err) {
    respond({ type: 'sw-inspect-result', url, cached: false, error: String(err) });
  }
}

// Reporta cuánto hay cacheado hoy (sin descargar nada) — para mostrar estado al abrir.
async function reportStatus(target) {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const [videoUrls, songUrls] = await Promise.all([getVideoUrls(), getSongUrls()]);
    let videosDone = 0;
    for (const u of videoUrls) if (await cache.match(u, { ignoreVary: true })) videosDone++;
    let songsDone = 0;
    for (const u of songUrls) if (await cache.match(u, { ignoreVary: true })) songsDone++;

    const msg = {
      type: 'sw-cache-status',
      videos: { done: videosDone, total: videoUrls.length },
      canciones: { done: songsDone, total: songUrls.length }
    };
    if (target) target.postMessage(msg);
    else broadcast(msg);
  } catch (err) {
    console.error('No se pudo calcular el estado del cache', err);
  }
}

// --- INSTALL: solo el shell, chico y rápido. Los medios NO van acá. ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      for (const url of APP_SHELL) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn('No se pudo cachear (shell)', url, err);
        }
      }
      self.skipWaiting();
    })()
  );
});

// --- ACTIVATE: borra caches viejas ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      );
      self.clients.claim();
    })()
  );
});

// --- MENSAJES: la página dispara el cacheo de medios acá, fuera del install ---
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'CACHE_MEDIA') {
    const p = cacheAllMedia({ videoUrls: data.videoUrls, songUrls: data.songUrls });
    if (event.waitUntil) event.waitUntil(p);
  } else if (data.type === 'CACHE_STATUS') {
    const p = reportStatus(event.source);
    if (event.waitUntil) event.waitUntil(p);
  } else if (data.type === 'INSPECT_URL') {
    const p = inspectUrl(data.url, event.source);
    if (event.waitUntil) event.waitUntil(p);
  }
});

// El <video> pide con header "Range" incluso en la carga normal (confirmado:
// GitHub Pages le responde 206 Partial Content desde el primer pedido). Si
// desde el cache le devolvemos el archivo entero (200) cuando pidió un
// rango, Chrome lo rechaza como SRC_NOT_SUPPORTED — hay que recortarlo.
async function serveRange(cachedResponse, rangeHeader) {
  const blob = await cachedResponse.clone().blob();
  const size = blob.size;
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match) return cachedResponse;

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : size - 1;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= size) end = size - 1;

  if (start > end || size === 0) {
    return new Response(null, {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': `bytes */${size}` }
    });
  }

  const slice = blob.slice(start, end + 1);
  const headers = new Headers(cachedResponse.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('content-range');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(slice.size));
  headers.set('Accept-Ranges', 'bytes');

  return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}

// --- FETCH: cache-first (con fallback a red) ---
self.addEventListener('fetch', (event) => {
  event.respondWith(
    (async () => {
      let cached = null;
      try {
        cached = await caches.match(event.request, { ignoreVary: true });
      } catch (err) {
        broadcast({ type: 'sw-fetch-error', url: event.request.url, stage: 'match', message: String(err) });
      }

      if (cached) {
        const rangeHeader = event.request.headers.get('range');
        if (rangeHeader) {
          try {
            return await serveRange(cached, rangeHeader);
          } catch (err) {
            broadcast({ type: 'sw-fetch-error', url: event.request.url, stage: 'serveRange', range: rangeHeader, message: String(err) });
            return cached;
          }
        }
        return cached;
      }

      try {
        const response = await fetch(event.request);
        // Nunca cachear una respuesta parcial (206) como si fuera el
        // archivo completo — eso rompería futuros pedidos por rango.
        if (response.ok && response.status !== 206 && event.request.method === 'GET') {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (err) {
        return Response.error();
      }
    })()
  );
});