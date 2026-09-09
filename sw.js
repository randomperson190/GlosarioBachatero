// sw.js — Service Worker para GlosarioBachatero
// Cachea el "app shell" + todos los videos (figuras-manifest.json) + todas
// las canciones (parseadas desde script.js) para que la app ande 100% offline.

const CACHE_VERSION = 'glosario-bachatero-v3'; // subí este número cuando quieras forzar un recache
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

// Cachea una lista de URLs en tandas chicas, sin que un fallo tumbe el resto,
// y avisando progreso por postMessage.
async function cacheUrlsInBatches(cache, urls, label) {
  const total = urls.length;
  let done = 0;
  let failed = 0;
  const BATCH = 6; // pocas descargas simultáneas: en datos móviles, más batch = más timeouts

  broadcast({ type: 'sw-cache-progress', label, done: 0, total, failed: 0 });

  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    await Promise.all(
      batch.map((url) =>
        cache.add(url).then(
          () => { done++; },
          (err) => { failed++; console.warn(`No se pudo cachear (${label})`, url, err); }
        )
      )
    );
    broadcast({ type: 'sw-cache-progress', label, done, total, failed });
  }

  console.log(`[${label}] Cacheados ${done}/${total} (${failed} fallaron).`);
  broadcast({ type: 'sw-cache-done', label, done, total, failed });
  return { done, total, failed };
}

// Saca las rutas de video (file7t / file8t) de figuras-manifest.json
async function getVideoUrls() {
  const res = await fetch('./figuras-manifest.json');
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
  const res = await fetch('./script.js');
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

// --- INSTALL ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      // 1. Shell básico — item por item, para que si uno falla no tumbe todo lo demás
      for (const url of APP_SHELL) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn('No se pudo cachear (shell)', url, err);
        }
      }

      // 2. Videos de las figuras
      try {
        const videoUrls = await getVideoUrls();
        await cacheUrlsInBatches(cache, videoUrls, 'videos');
      } catch (err) {
        console.error('No se pudo leer figuras-manifest.json', err);
        broadcast({ type: 'sw-cache-error', label: 'videos', message: String(err) });
      }

      // 3. Canciones
      try {
        const songUrls = await getSongUrls();
        await cacheUrlsInBatches(cache, songUrls, 'canciones');
      } catch (err) {
        console.error('No se pudo leer script.js para sacar las canciones', err);
        broadcast({ type: 'sw-cache-error', label: 'canciones', message: String(err) });
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
