// Configuración del Loader de Sentry para el sitio público.
// Va en su propio archivo, sin tocar el DOM, para que tests/app.test.js pueda evaluarlo
// en un sandbox y comprobar el comportamiento, no la forma del texto.
// Debe cargarse ANTES del <script src> del Loader, que lee window.sentryOnLoad al arrancar.

// Misma regla que la app (ver app/index.html): Sentry solo reporta producción. La landing
// cargaba el Loader con el mismo DSN pero sin ninguna configuración, así que las pruebas e2e
// que la abren en un servidor local mandaban sus errores al proyecto de producción.
// Se apaga solo en local y en file://; cualquier otro host sigue reportando.
window.sentryOnLoad = function () {
  var host = location.hostname;
  var esLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    || host === '' || location.protocol === 'file:';
  Sentry.init({ enabled: !esLocal, environment: esLocal ? 'local' : 'production' });
};
