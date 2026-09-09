// sw.js — Service Worker para GlosarioBachatero
// Cachea el "app shell" en el install (rápido). Los videos (figuras-manifest.json)
// y las canciones (script.js) se cachean aparte, disparados por mensaje desde la
// página, con reintentos y resume — así una descarga larga que se corta (batería,
// pantalla apagada, se cierra la pestaña) puede retomarse en vez de perderse toda.

const CACHE_VERSION = 'glosario-bachatero-v6'; // subí este número cuando quieras forzar un recache del shell
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
      const lenHeader = response.headers.get('content-length');
      if (lenHeader && Number(lenHeader) < MIN_MEDIA_BYTES) {
        throw new Error(`Respuesta sospechosamente chica (${lenHeader} bytes) — ¿404 disfrazado de 200?`);
      }

      await cache.put(url, response);
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
    const existing = await cache.match(url);
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

// Reporta cuánto hay cacheado hoy (sin descargar nada) — para mostrar estado al abrir.
async function reportStatus(target) {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const [videoUrls, songUrls] = await Promise.all([getVideoUrls(), getSongUrls()]);
    let videosDone = 0;
    for (const u of videoUrls) if (await cache.match(u)) videosDone++;
    let songsDone = 0;
    for (const u of songUrls) if (await cache.match(u)) songsDone++;

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
  }
});

// El <video>/<audio> pide con header "Range" (para poder buscar/adelantar).
// Cache.match() encuentra igual la entrada completa por URL, pero si se la
// devolvemos entera cuando pidieron un rango, algunos reproductores no la
// aceptan. Acá recortamos la respuesta ya cacheada para devolver un 206 real.
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
  // Limpiamos headers que podrían quedar en conflicto con el body recortado
  // (ej: Content-Encoding/Content-Length del archivo completo original).
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
      const cached = await caches.match(event.request);
      if (cached) {
        const rangeHeader = event.request.headers.get('range');
        if (rangeHeader) {
          try {
            return await serveRange(cached, rangeHeader);
          } catch (err) {
            // Si algo falla armando el 206 parcial, mejor servir el archivo
            // completo (200) que dejar la reproducción rota del todo.
            console.warn('No se pudo armar respuesta parcial, sirvo el archivo completo', err);
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
