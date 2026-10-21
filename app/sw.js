// Service Worker de InventIA: cachea el app shell para que la app abra al instante y siga
// abriendo aunque no haya conexión (los datos en sí se piden a Supabase aparte; sin conexión, la
// app los muestra vacíos/cacheados por el navegador y encola los conteos nuevos hasta que vuelva
// la señal).
//
// Estrategia: se entrega SIEMPRE la copia guardada y en paralelo se baja la nueva para la próxima
// vez. Antes era al revés -- red primero, caché solo si la red fallaba -- y eso obligaba a esperar
// la descarga completa en cada apertura aunque hubiera una copia perfecta en el teléfono. Medido
// con la red frenada a lo que hay en faena: la app son 927 KB (245 KB comprimidos) y bajarlos
// costaba 5,4 s de los 6,0 s que tardaba en abrir en 3G. Eso lo paga la persona en terreno, cada
// vez que la caché del navegador se enfría.
//
// El costo de servir la copia guardada es que una versión recién publicada se ve recién a la
// siguiente apertura. Por eso, cuando la descarga de fondo trae un HTML distinto al guardado, se
// le avisa a la pestaña abierta y aparece la barra "Hay una versión nueva. Recarga para usarla"
// que ya existía. Nunca se recarga sola: la persona puede estar a mitad de un conteo.
const CACHE_NAME = 'inventia-shell-v3';
const APP_SHELL = [
  './', './index.html', './inventario.html', './manifest.json', './lib/pdf-lib.min.js', './lib/xlsx.full.min.js', './lib/html5-qrcode.min.js',
  '../icons/icon-192.png', '../icons/icon-512.png', '../icons/icon-maskable-512.png', '../icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  // add() uno por uno y no addAll(): addAll() es todo o nada, así que un solo ícono que falte
  // dejaría la app sin caché y sin arreglo offline.
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(APP_SHELL.map(ruta => cache.add(ruta))))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(nombres => Promise.all(nombres.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// ¿Esta petición es la página en sí? Solo para esas tiene sentido avisar "hay una versión nueva".
function esDocumento(req){
  if(req.mode === 'navigate' || req.destination === 'document') return true;
  const ruta = new URL(req.url).pathname;
  return ruta.endsWith('/') || ruta.endsWith('.html');
}

// Sin número de versión (la app es un HTML servido por GitHub Pages), así que la versión es lo que
// diga el servidor: ETag, y si no hay, la fecha de modificación o el largo.
function marcaVersion(res){
  return res ? (res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length')) : null;
}
function cambioLaVersion(anterior, nueva){
  const a = marcaVersion(anterior), b = marcaVersion(nueva);
  return !!a && !!b && a !== b;
}

// Qué versión del HTML se le entregó a cada pantalla (id de la pestaña → ETag). La app lo pregunta
// al arrancar para saber qué está corriendo de verdad: si es la copia guardada y el servidor ya
// tiene otra, muestra el aviso. Sin esto la app tomaba como suya la versión del servidor (ya
// nueva) y nunca notaba la diferencia. Vive en memoria: si el navegador apaga el service worker
// entre medio, la app se queda con el chequeo de siempre.
const versionesEntregadas = new Map();
function recordarVersionEntregada(clienteId, res){
  const marca = marcaVersion(res);
  if(!clienteId || !marca) return;
  versionesEntregadas.set(clienteId, marca);
  if(versionesEntregadas.size > 50) versionesEntregadas.delete(versionesEntregadas.keys().next().value);
}
self.addEventListener('message', event => {
  if(!event.data || event.data.tipo !== 'inventia-que-version' || !event.source) return;
  event.source.postMessage({tipo:'inventia-version-entregada', version: versionesEntregadas.get(event.source.id) || null});
});

async function avisarVersionNueva(clienteId){
  const pestanas = await self.clients.matchAll({type:'window'});
  // La pantalla que se está abriendo puede no figurar todavía entre las pestañas: se le avisa igual.
  if(clienteId && !pestanas.some(c => c.id === clienteId)){
    const nueva = await self.clients.get(clienteId);
    if(nueva) pestanas.push(nueva);
  }
  pestanas.forEach(c => c.postMessage({tipo:'inventia-version-nueva'}));
}

// No se intercepta nada de otro origen (Supabase, fuentes de Google) para no interferir con esas
// llamadas. Tampoco nada que no sea GET: el chequeo de versión de la app va por HEAD y tiene que
// llegar al servidor de verdad.
self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;
  if(new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const guardada = await cache.match(req);
    const esDoc = esDocumento(req);
    if(guardada && esDoc) recordarVersionEntregada(event.resultingClientId, guardada);

    const desdeLaRed = (async () => {
      try{
        // El HTML se revalida siempre con el servidor (no-cache: si no cambió, responde 304 y no
        // baja nada). Pasó de verdad el 21/10/2026: GitHub Pages lo sirve con max-age=600, así que
        // durante diez minutos después de cada apertura esta descarga "nueva" volvía con la copia
        // vieja de la caché del navegador; la versión publicada no llegaba y no salía el aviso.
        // redirect:'manual', como la navegación original: una redirección no se guarda.
        const res = esDoc
          ? await fetch(new Request(req.url, {cache:'no-cache', credentials:'same-origin', redirect:'manual'}))
          : await fetch(req);
        if(res && res.ok){
          await cache.put(req, res.clone());
          if(!guardada && esDoc) recordarVersionEntregada(event.resultingClientId, res);
          if(guardada && esDoc && cambioLaVersion(guardada, res)) await avisarVersionNueva(event.resultingClientId);
        }
        return res;
      }catch(e){
        // Sin señal: lo guardado, y si esto era una navegación a algo que no tenemos, la app.
        return guardada || (await cache.match('./index.html'));
      }
    })();

    // Con copia guardada se responde al instante y la descarga sigue en segundo plano.
    // waitUntil la mantiene viva: sin eso el navegador puede matarla al terminar la respuesta y
    // la caché nunca se actualizaría.
    if(guardada){ event.waitUntil(desdeLaRed); return guardada; }
    return desdeLaRed;
  })());
});
