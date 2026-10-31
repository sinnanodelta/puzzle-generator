// The service worker (SPEC §9.2), completed at build time by vite.config.ts: FILES lists every
// built file and VERSION changes with their content. Each version is downloaded once into its own
// cache, then the app is served from it, offline too. A new deployment installs a new version,
// which takes over once every tab of the app is closed.
const VERSION = '__VERSION__';
const FILES = __FILES__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      return (await cache.match(r, { ignoreSearch: true })) || (r.mode === 'navigate' && (await cache.match('index.html'))) || fetch(r);
    })(),
  );
});
