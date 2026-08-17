// Service Worker de Certero: cachea el app shell para que la app siga
// abriendo aunque no haya conexión (los datos en sí se piden a Supabase
// aparte; sin conexión, la app los muestra vacíos/cacheados por el navegador
// y encola los conteos nuevos hasta que vuelva la señal).
const CACHE_NAME = 'certero-shell-v1';
const APP_SHELL = ['./', './index.html'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(nombres => Promise.all(nombres.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Network-first para el propio sitio: si hay conexión, siempre se sirve la
// versión más reciente (y se refresca la caché); si falla la red, se sirve
// la última copia cacheada. No se intercepta nada de otro origen (Supabase,
// fuentes de Google, etc.) para no interferir con esas llamadas.
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  if(new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        const copia = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, copia));
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
  );
});
