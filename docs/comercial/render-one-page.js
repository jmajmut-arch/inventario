// Genera el PDF de un one-page desde su HTML. Uso: NODE_PATH=../../node_modules node render-one-page.js [nombre]
// nombre: one-page-inventario (por omisión) u one-page-ejecutivo. El tamaño de hoja lo fija el @page del HTML.
const { chromium } = require('playwright');
const path = require('path');
(async()=>{
  const nombre = process.argv[2] || 'one-page-inventario';
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const p = await b.newPage();
  await p.goto('file://' + path.resolve(__dirname, nombre + '.html'), {waitUntil:'networkidle'});
  await p.evaluate(()=>document.fonts.ready); await p.waitForTimeout(500);
  const m = await p.evaluate(()=>{ const pg=document.querySelector('.page'); return { alto: pg.clientHeight, contenido: pg.scrollHeight }; });
  console.log('hoja', m.alto, 'px; contenido', m.contenido, 'px', m.contenido > m.alto ? '-> DESBORDA' : 'ok');
  await p.pdf({path:path.resolve(__dirname, nombre + '.pdf'), printBackground:true, preferCSSPageSize:true, tagged:true});
  await b.close();
})();
