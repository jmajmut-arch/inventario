// Genera one-page-ejecutivo.pdf desde el HTML. Uso: NODE_PATH=../../node_modules node render-one-page.js
const { chromium } = require('playwright');
(async()=>{
  const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
  const p = await b.newPage();
  await p.goto('file://' + require('path').resolve(__dirname, 'one-page-ejecutivo.html') + '', {waitUntil:'networkidle'});
  await p.evaluate(()=>document.fonts.ready); await p.waitForTimeout(500);
  const h = await p.evaluate(()=>document.querySelector('.page').getBoundingClientRect().height);
  console.log('page height px', h, 'A4 =', 297*96/25.4);
  await p.pdf({path:require('path').resolve(__dirname, 'one-page-ejecutivo.pdf'), format:'A4', printBackground:true, preferCSSPageSize:true, tagged:true});
  await b.close();
})();
