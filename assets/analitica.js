// Analítica y reporte de errores, compartido por las páginas del sitio público.
// Antes estaba repetido en el <head> de index.html; las páginas nuevas lo cargan de acá.
// El <script src> del cargador de Sentry sigue en el HTML y debe ir DESPUÉS de este archivo,
// porque el cargador lee window.sentryOnLoad al arrancar.

// Google Tag Manager
(function (w, d, s, l, i) {
  w[l] = w[l] || [];
  w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  var f = d.getElementsByTagName(s)[0],
    j = d.createElement(s),
    dl = l != 'dataLayer' ? '&l=' + l : '';
  j.async = true;
  j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i + dl;
  f.parentNode.insertBefore(j, f);
})(window, document, 'script', 'dataLayer', 'GTM-5RH88HLL');

// Google Analytics
window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'G-G5WNMGTXSH');
