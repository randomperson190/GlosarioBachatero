// sw.js — Service Worker para GlosarioBachatero
// Cachea el "app shell" en el install (rápido). Los videos (figuras-manifest.json)
// y las canciones (script.js) se cachean aparte, disparados por mensaje desde la
// página, con reintentos y resume — así una descarga larga que se corta (batería,
// pantalla apagada, se cierra la pestaña) puede retomarse en vez de perderse toda.

const CACHE_VERSION = 'glosario-bachatero-v4'; // subí este número cuando quieras forzar un recache del shell
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

// Intenta cachear una URL, con reintentos (útil en datos móviles inestables).
async function cacheOneWithRetry(cache, url, attempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      await cache.add(url);
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
function cacheAllMedia() {
  if (mediaCachingPromise) return mediaCachingPromise;

  mediaCachingPromise = (async () => {
    const cache = await caches.open(CACHE_VERSION);

    try {
      const videoUrls = await getVideoUrls();
      await cacheMissingUrls(cache, videoUrls, 'videos');
    } catch (err) {
      console.error('No se pudo leer figuras-manifest.json', err);
      broadcast({ type: 'sw-cache-error', label: 'videos', message: String(err) });
    }

    try {
      const songUrls = await getSongUrls();
      await cacheMissingUrls(cache, songUrls, 'canciones');
    } catch (err) {
      console.error('No se pudo leer script.js para sacar las canciones', err);
      broadcast({ type: 'sw-cache-error', label: 'canciones', message: String(err) });
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
    const p = cacheAllMedia();
    if (event.waitUntil) event.waitUntil(p);
  } else if (data.type === 'CACHE_STATUS') {
    const p = reportStatus(event.source);
    if (event.waitUntil) event.waitUntil(p);
  }
});

// --- FETCH: cache-first (con fallback a red) ---
self.addEventListener('fetch', (event) => {
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;

      try {
        const response = await fetch(event.request);
        if (response.ok && event.request.method === 'GET') {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(event.request, response.clone());
        }
        return response;
      } catch (err) {
        return cached || Response.error();
      }
    })()
  );
});
