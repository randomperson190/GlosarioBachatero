// sw.js — Service Worker para GlosarioBachatero
// Cachea el "app shell" y TODOS los videos listados en figuras-manifest.json
// para que la app funcione 100% offline después de la primera carga.

const CACHE_VERSION = 'glosario-bachatero-v1'; // subí este número cuando cambies algo y quieras forzar recache
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

// --- INSTALL: cachea el shell + descubre y cachea todos los .mp4 ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      // 1. Shell básico
      await cache.addAll(APP_SHELL);

      // 2. Leer figuras-manifest.json y sacar todos los file7t / file8t
      try {
        const res = await fetch('./figuras-manifest.json');
        const data = await res.json();
        const videoUrls = new Set();

        for (const combo of data.combos || []) {
          for (const dificultad of Object.values(combo.dificultades || {})) {
            for (const variante of dificultad) {
              if (variante.file7t) videoUrls.add(variante.file7t);
              if (variante.file8t) videoUrls.add(variante.file8t);
            }
          }
        }

        // 3. Cachear los videos en tandas para no saturar el navegador
        const urls = Array.from(videoUrls);
        const BATCH = 10;
        for (let i = 0; i < urls.length; i += BATCH) {
          const batch = urls.slice(i, i + BATCH);
          await Promise.all(
            batch.map((url) =>
              cache.add(url).catch((err) =>
                console.warn('No se pudo cachear', url, err)
              )
            )
          );
        }
        console.log(`Cacheados ${urls.length} videos.`);
      } catch (err) {
        console.error('No se pudo leer figuras-manifest.json para cachear videos', err);
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
        // Guarda en cache lo que se va pidiendo de a poco (por si algo quedó afuera)
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
