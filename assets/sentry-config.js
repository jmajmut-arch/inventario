// Configuración del Loader de Sentry para el sitio público.
// Va en su propio archivo, sin tocar el DOM, para que tests/app.test.js pueda evaluarlo
// en un sandbox y comprobar el comportamiento, no la forma del texto.
// Debe cargarse ANTES del <script src> del Loader, que lee window.sentryOnLoad al arrancar.

// Misma regla que la app (ver app/index.html): Sentry solo reporta producción. La landing
// cargaba el Loader con el mismo DSN pero sin ninguna configuración, así que las pruebas e2e
// que la abren en un servidor local mandaban sus errores al proyecto de producción.
// Se apaga solo en local y en file://; cualquier otro host sigue reportando.
//
// Código ajeno inyectado en la página (extensiones del navegador, robots que la revisan) no es un
// error del sitio y no se reporta. Pasó de verdad el 02/10/2026 (JAVASCRIPT-C, issue #538):
// "ReferenceError: ab is not defined" desde un script "<anonymous>" en la landing, una sola vez,
// de una visita con aspecto de robot; el sitio no tiene ninguna variable "ab". El sitio no usa
// eval ni new Function, así que un error cuyos frames son TODOS "<anonymous>" nunca es nuestro.
// Si al menos un frame viene de un archivo (comun.js, la página, el Loader), se reporta igual.
function esCodigoInyectado(event) {
  var valores = event && event.exception && event.exception.values;
  if (!valores || !valores.length) return false;
  var frames = [];
  for (var i = 0; i < valores.length; i++) {
    var st = valores[i] && valores[i].stacktrace;
    if (st && st.frames) frames = frames.concat(st.frames);
  }
  if (!frames.length) return false;
  for (var j = 0; j < frames.length; j++) {
    var archivo = (frames[j] && (frames[j].filename || frames[j].abs_path)) || '';
    if (archivo !== '<anonymous>') return false;
  }
  return true;
}

window.sentryOnLoad = function () {
  var host = location.hostname;
  var esLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    || host === '' || location.protocol === 'file:';
  Sentry.init({
    enabled: !esLocal,
    environment: esLocal ? 'local' : 'production',
    beforeSend: function (event) { return esCodigoInyectado(event) ? null : event; }
  });
};
