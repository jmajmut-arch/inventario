// Tests end-to-end con un navegador real (Playwright + Chromium), a diferencia de
// tests/app.test.js que corre el <script> en un sandbox de Node sin DOM real.
// Estos SÍ prueban render real, CSS, clicks reales y wiring de eventos.
//
// Todas las llamadas a Supabase se interceptan con page.route() — no dependen de
// ningún backend real, para que corran igual de rápido y estables en CI.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

let fallos = 0;
function assert(cond, msg){
  if(!cond){ fallos++; console.error('FALLO:', msg); }
}

const ROOT = path.join(__dirname, '..');
const PORT = 8942;
// Cuánto esperar a que aparezca un elemento. Acá la app lo dibuja en menos de un segundo, pero en
// CI el runner arranca en frío --recién descargado Chromium-- y con 5 s la suite daba rojos falsos
// sin que hubiera nada roto: pasó en el PR #421, donde el primer login expiró esperando .tabbar y
// la re-ejecución del mismo commit pasó sin tocar una línea. Un rojo falso cada tantos merges
// enseña a ignorar la suite, que es peor que no tenerla. 15 s sigue siendo 15 veces lo que tarda
// de verdad, así que una falla real se sigue notando rápido.
const ESPERA = Number(process.env.E2E_TIMEOUT_MS) || 15000;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };

// `version` simula publicar: cambia el ETag, como hace GitHub Pages al subir una versión nueva.
// Lo usa la prueba del service worker, que necesita que el servidor tenga algo distinto a lo
// guardado en el teléfono.
const servidorEstado = { version: 1 };
function iniciarServidor(){
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
      fs.readFile(filePath, (err, data) => {
        if(err){ res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
          'ETag': `"v${servidorEstado.version}-${urlPath}"`, 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

// Perfil de prueba: admin, plan profesional (todo habilitado).
const PERFIL_ADMIN_PRO = {
  id: 'perfil-1', nombre: 'Ana Torres', rol: 'admin', es_super_admin: false, empresa_id: 'emp-1',
  empresas: { nombre: 'Minera Andes', codigo_invitacion: 'ABC12345', planes: {
    nombre:'profesional', etiqueta:'Profesional', max_bodegas:null, max_usuarios:15,
    offline_habilitado:true, dashboard_ejecutivo_habilitado:true, auditoria_habilitada:true,
  } },
};

// Varias aserciones leen datos que llegan por fetch DESPUÉS de que el contenedor ya existe, así
// que esperar solo al contenedor deja una carrera. Acá los mocks responden al instante y casi
// siempre pasaba; en CI falló tres veces seguidas por tres motivos distintos (el valor de la orden
// en el Ingreso, las opciones de bodega del traslado, y el tabbar del primer login). Estos dos
// ayudantes esperan al DATO y devuelven false si no llegó a tiempo, para que la aserción de al lado
// siga dando su mensaje con lo que sí había, en vez de una excepción cruda de Playwright.
async function esperarCondicion(page, fn, arg){
  try{ await page.waitForFunction(fn, arg === undefined ? null : arg, { timeout:ESPERA }); return true; }
  catch(e){ return false; }
}
async function esperarVisible(page, selector){
  try{ await page.waitForSelector(selector, { state:'visible', timeout:ESPERA }); return true; }
  catch(e){ return false; }
}

// Segunda barrera contra el problema que arregla el guard de sentryOnLoad: aunque la app ya no
// inicializa Sentry fuera de producción, acá se corta el Loader y el ingest de raíz. Si alguien
// rompe el guard, estas pruebas no vuelven a ensuciar el Sentry de producción con errores de
// localhost (pasó: el issue JAVASCRIPT-4 salió de esta misma suite).
async function bloquearSentry(page){
  await page.route('**/js.sentry-cdn.com/**', route => route.abort());
  await page.route('**/*.sentry.io/**', route => route.abort());
  await page.route('**/*.ingest.*/**', route => route.abort());
}

async function mockearSupabaseApp(page, perfil){
  await bloquearSentry(page);
  // Playwright prioriza el handler registrado AL FINAL cuando varios matchean la misma
  // URL ("el último gana"). El catch-all va primero para que los mocks específicos
  // (registrados después) sean los que realmente respondan.
  await page.route('**/rest/v1/**', route => {
    const method = route.request().method();
    if(method === 'GET') route.fulfill({ status:200, contentType:'application/json', body:'[]' });
    else route.fulfill({ status:201, contentType:'application/json', body:'' });
  });
  await page.route('**/rest/v1/usuarios**', route => {
    route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([perfil]) });
  });
  await page.route('**/auth/v1/token**', route => {
    route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({
      access_token:'fake-token', refresh_token:'fake-refresh', user:{ id:'auth-user-1', email:'ana@minera-andes.cl' },
    }) });
  });
}

async function loguear(page, perfil){
  await mockearSupabaseApp(page, perfil);
  await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
  await page.fill('#f-email', 'ana@minera-andes.cl');
  await page.fill('#f-pass', '123456');
  await page.click('#auth-form button[type="submit"]');
  await page.waitForSelector('.tabbar', { timeout:ESPERA });
}

(async () => {
  const server = await iniciarServidor();
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const erroresPagina = [];

  // ===== App: login real, con clicks reales y render real =====
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('login: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    assert(await page.isVisible('.tabbar'), 'tras loguearse debe verse la barra de navegación inferior');
    assert(await page.isVisible('[data-tab="dashboard"].active'), 'debe quedar parado en la pestaña Dashboard tras el login');
    // Fase 6 (Navegación): cabecera de una fila (≤ 60 px) con dos íconos de 44 px; barra inferior
    // de cinco posiciones; "Más" abre una hoja con Salir y se cierra con el fondo.
    const cabecera = await page.evaluate(() => ({ h: Math.round(document.querySelector('.topbar').getBoundingClientRect().height), iconos: [...document.querySelectorAll('.topbar .btn-icon-header')].filter(b => b.offsetParent).map(b => Math.round(b.getBoundingClientRect().height)), tabs: document.querySelectorAll('.tabbar .tab').length }));
    assert(cabecera.h <= 60 && cabecera.iconos.length === 2 && cabecera.iconos.every(h => h >= 44) && cabecera.tabs === 5, 'cabecera de una fila con dos íconos de 44 px y barra de cinco, obtuvo '+JSON.stringify(cabecera));
    await page.click('#tab-mas');
    await page.waitForSelector('#tab-mas-hoja', { state:'visible', timeout:ESPERA });
    assert(await page.isVisible('#btn-logout') && await page.isVisible('[data-tab="ciclos"]'), 'la hoja "Más" muestra Salir y Períodos');
    await page.click('#tab-mas-fondo', { position:{ x:10, y:10 } });
    await page.waitForSelector('#tab-mas-hoja', { state:'hidden', timeout:ESPERA });
    // Fase 1 del rediseño del Panel: la primera cifra ("Avance global", tarjeta hero) tiene que
    // verse sin desplazar la pantalla, en celular y en iPad, y el detalle viene plegado.
    const heroMovil = await page.$('.dash-kpis .kpi.hero');
    const cajaMovil = heroMovil ? await heroMovil.boundingBox() : null;
    assert(cajaMovil && cajaMovil.y >= 0 && cajaMovil.y + cajaMovil.height <= 900 - 56, 'a 420×900 la tarjeta "Avance global" debe verse completa sin desplazar (por encima de la barra inferior), obtuvo: '+JSON.stringify(cajaMovil));
    assert(await page.$('details.dash-detalle:not([open])') !== null, 'el bloque "Detalle" del Panel debe venir plegado');
    await context.close();
  }
  // ===== Panel: "Estado general de SKU" separa Merma y Excedente (Joel, 14/10/2026) =====
  // Cambiar la criticidad vuelve a pedir el resumen al servidor: la leyenda tiene que mostrar las
  // dos porciones nuevas con lo que respondió, y no la "Diferencia" de antes.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('resumen-merma: '+err.message));
    let cuerpoResumen = null;
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.route('**/rest/v1/rpc/resumen_general_skus_signos**', route => {
      cuerpoResumen = route.request().postData();
      route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{ total_activo:990, no_contado:888, cuadrado:78, con_diferencia:24, merma:15, excedente:9, pendiente:0 }]) });
    });
    await page.evaluate(() => { const d = document.querySelector('details.dash-detalle'); if(d && !d.open) d.querySelector('summary').click(); });
    await page.waitForSelector('#rg-criticidad', { state:'visible', timeout:ESPERA });
    await page.selectOption('#rg-criticidad', 'criticos');
    await page.waitForFunction(() => document.body.innerText.includes('Merma (15)'), null, { timeout:ESPERA });
    // El bloque "Detalle" se queda abierto al repintar: antes se cerraba solo con cada cambio de
    // criticidad o de Torta/Barras y el gráfico desaparecía de la vista.
    assert(await page.$eval('#dash-detalle', el => el.open), 'tras cambiar la criticidad, "Detalle" debe seguir abierto');
    await page.click('[data-resumen-grafico="barras"]');
    await page.waitForSelector('.dash-estado-cuerpo rect', { timeout:ESPERA });
    assert(await page.$eval('#dash-detalle', el => el.open), 'tras pasar a Barras, "Detalle" debe seguir abierto');
    const leyenda = await page.$eval('.dash-estado-leyenda', el => el.innerText);
    assert(leyenda.includes('Merma (15)') && leyenda.includes('Excedente (9)') && !leyenda.includes('Diferencia'), 'la leyenda debe mostrar Merma y Excedente en vez de Diferencia, obtuvo: '+leyenda);
    assert(JSON.parse(cuerpoResumen||'{}').p_criticidad === 'criticos', 'el resumen debe pedirse con la criticidad elegida, obtuvo: '+cuerpoResumen);
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(desborde <= 0, 'a 420 px el Panel no debe desbordar a lo ancho, desborda '+desborde+' px');
    if(process.env.CAPTURA_RESUMEN) await (await page.$('.dash-estado-cuerpo')).screenshot({ path: process.env.CAPTURA_RESUMEN });
    // Al cerrarlo a mano queda cerrado aunque la pantalla se repinte.
    await page.click('#dash-detalle > summary');
    await page.evaluate(() => render());
    assert(!(await page.$eval('#dash-detalle', el => el.open)), 'cerrado a mano, "Detalle" debe seguir cerrado tras repintar');
    await context.close();
  }
  // ===== Bloqueo por MFA: la cabecera y las pestañas siguen funcionando (Sentry JAVASCRIPT-E) =====
  // Con la MFA obligatoria vigente, un admin sin segundo factor ve el bloqueo en vez de la vista,
  // pero state.view sigue diciendo la vista elegida. bind() la ataba igual y cada toque de la lupa,
  // de Configuraciones o de una pestaña fallaba con "Cannot read properties of null". Pasó de
  // verdad en Escondida con una copia guardada de la app que tenía el plazo al 1 de octubre.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    const erroresMfa = [];
    page.on('pageerror', err => erroresMfa.push(err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.evaluate(() => { state.perfil.empresas.mfa_obligatoria_admins = true; state.mfaFactores = []; state.mfaFactoresCargado = true; render(); });
    await page.waitForSelector('#btn-mfa-activar', { timeout:ESPERA });
    await page.click('#btn-ir-buscar');
    await page.click('#btn-config');
    for (const tab of ['plan','conteo','reconteo','dashboard']) await page.click(`.tabbar [data-tab="${tab}"]`);
    assert(erroresMfa.length === 0, 'con el bloqueo por MFA, la lupa, Configuraciones y las pestañas no deben fallar, obtuvo: '+erroresMfa.join(' | '));
    assert(await page.isVisible('#btn-mfa-activar'), 'el bloqueo sigue en pantalla con su botón Activar');
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport:{ width:1024, height:768 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('login-ipad: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    const heroIpad = await page.$('.dash-kpis .kpi.hero');
    const cajaIpad = heroIpad ? await heroIpad.boundingBox() : null;
    assert(cajaIpad && cajaIpad.y >= 0 && cajaIpad.y + cajaIpad.height <= 768 - 56, 'a 1024×768 la tarjeta "Avance global" debe verse completa sin desplazar, obtuvo: '+JSON.stringify(cajaIpad));
    const kpis = await page.$$eval('.dash-kpis .kpi', els => els.map(e => e.getBoundingClientRect().top));
    assert(kpis.length === 4 && kpis.every(t => Math.abs(t - kpis[0]) < 2), 'a 1024 px las cuatro cifras de "¿Cómo vamos?" deben ir en una sola fila, obtuvo tops: '+JSON.stringify(kpis));
    await context.close();
  }

  // ===== App: plan básico oculta Ejecutivo y Auditoría (en navegador real, no solo en el sandbox de unit tests) =====
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('plan-basico: '+err.message));
    const perfilBasico = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilBasico.empresas.planes = { nombre:'basico', etiqueta:'Básico', max_bodegas:1, max_usuarios:3, offline_habilitado:false, dashboard_ejecutivo_habilitado:false, auditoria_habilitada:false };
    await loguear(page, perfilBasico);
    const btnEjecutivo = await page.$('[data-dash-modo="ejecutivo"]');
    assert(btnEjecutivo === null, 'plan básico: el botón Ejecutivo no debe existir en el DOM real');
    assert(await page.isVisible('text=Ejecutivo 🔒'), 'plan básico: debe verse el candado de "Ejecutivo" bloqueado');
    await page.click('[data-tab="config"], [data-tab="conteo"]').catch(()=>{});
    await context.close();
  }

  // ===== App: con suscripción activa aparece el botón para cambiar de plan, y pide confirmación =====
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('cambiar-plan: '+err.message));
    const perfilActivo = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilActivo.empresas.flow_subscription_status = 'activa';
    await loguear(page, perfilActivo);
    await page.click('#btn-config');
    await page.waitForSelector('[data-cambiar-plan]');
    const etiquetaBoton = await page.textContent('[data-cambiar-plan]');
    assert(etiquetaBoton.includes('Básico'), 'con plan Profesional activo, el botón debe ofrecer cambiar a Básico, obtuvo: '+etiquetaBoton);
    let dialogVisto = null;
    page.on('dialog', async d => { dialogVisto = d.message(); await d.dismiss(); });
    await page.click('[data-cambiar-plan]');
    await page.waitForTimeout(200);
    assert(!!dialogVisto && dialogVisto.includes('Básico'), 'al hacer click debe pedir confirmación antes de cambiar de plan, obtuvo: '+dialogVisto);
    await context.close();
  }

  // ===== App: el botón de escáner abre y cierra el modal de verdad =====
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('escaner: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.click('[data-tab="conteo"]');
    await page.waitForSelector('#btn-abrir-escaner');
    await page.click('#btn-abrir-escaner');
    await page.waitForTimeout(300);
    assert(await page.isVisible('#escaner-modal-backdrop'), 'al hacer click en el botón de escáner debe abrirse el modal');
    await page.click('#escaner-modal-close');
    await page.waitForTimeout(200);
    assert(!(await page.isVisible('#escaner-modal-backdrop')), 'al cerrar el modal de escáner debe desaparecer del DOM/quedar oculto');
    // Lectura de un material que NO está entre los 500 precargados (bug real, 14/10/2026): el
    // código se busca en el servidor. La cámara no existe en el navegador de pruebas: la lectura se
    // simula llamando al mismo callback que usa la librería.
    await page.route('**/rest/v1/skus_lectura?select=id,sku_code,**', route => {
      const u = decodeURIComponent(route.request().url());
      if(!u.includes('or=(sku_code.in.')) return route.fallback();
      const filas = u.includes('"10475828"') ? [{ id:'e2e-lejos', sku_code:'10475828', descripcion:'REDUCER,LH,FLENDER', bodega:'B501', ubicacion:'0100', storage_bin:'3029-A', stock_sistema:1, unidad_medida:'EA' }] : [];
      return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(filas) });
    });
    await page.route('**/rest/v1/rpc/buscar_skus_lectura**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'e2e-asociar', sku_code:'11172553', descripcion:'MOTOR,MTR,2300KW', bodega:'B501', ubicacion:'0100', storage_bin:'3029-A', stock_sistema:2, unidad_medida:'EA' } ]) }));
    await page.click('#btn-abrir-escaner');
    await page.waitForSelector('#escaner-modal-backdrop', { timeout:ESPERA });
    await page.evaluate(() => onCodigoEscaneado('000000000010475828'));
    assert(await esperarVisible(page, '#c-cant'), 'un código leído fuera de los 500 precargados abre el formulario de conteo de ese material');
    assert(await page.isVisible('text=10475828'), 'el formulario es del material leído');
    // Código desconocido: buscar para asociar sin reemplazar el campo mientras se escribe (iOS).
    await page.click('#btn-quitar-sku').catch(()=>{});
    await page.click('#btn-abrir-escaner');
    await page.waitForSelector('#escaner-modal-backdrop', { timeout:ESPERA });
    await page.evaluate(() => onCodigoEscaneado('CODIGO-SIN-ASOCIAR'));
    await page.waitForSelector('#escaner-buscar', { timeout:ESPERA });
    await page.evaluate(() => { window.__campoAsociar = document.getElementById('escaner-buscar'); });
    await page.type('#escaner-buscar', 'motor', { delay:40 });
    assert(await esperarVisible(page, '[data-asociar-btn="e2e-asociar"]'), 'la búsqueda para asociar trae resultados del maestro completo');
    assert(await page.evaluate(() => window.__campoAsociar === document.getElementById('escaner-buscar') && document.activeElement === window.__campoAsociar), 'el campo no se reemplaza ni pierde el foco mientras se escribe');
    const desbordeEsc = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeEsc <= 0, 'a 420 px el escáner no desborda, obtuvo '+desbordeEsc);
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/escaner-asociar-420.png' });
    await context.close();
  }

  // ===== Contar (Fase 2a del rediseño): tarjeta de lugar → lista por bin → formulario =====
  // Con el navegador real: un toque en la tarjeta del lugar carga la lista (misma cascada que los
  // <select>), las filas son táctiles (≥ 64 px) y un toque abre el formulario del SKU; a 420 px no
  // desborda. Los <select> siguen en el DOM, plegados.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('contar-lugares: '+err.message));
    await mockearSupabaseApp(page, PERFIL_ADMIN_PRO);
    await page.route('**/rest/v1/plan_semanal_detalle**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'e2e-plan-1', fecha:new Date().toISOString().slice(0,10), bodega:'B501', ubicacion:'0100', storage_bin:'3029-A', solo_sin_ubicacion:false, por_sku:false, responsable_id:null, responsable_nombre:null, skus_excluidos:[], skus_incluidos:[] },
    ]) }));
    await page.route('**/rest/v1/rpc/universo_entradas_plan_contar**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ 'e2e-plan-1': [
      { id:'e2e-sku-1', sku_code:'10475828', descripcion:'REDUCER,LH,FLENDER', bodega:'B501', ubicacion:'0100', storage_bin:'3029-A', batch:'NEW', stock_sistema:1, unidad_medida:'EA' },
      { id:'e2e-sku-2', sku_code:'11172553', descripcion:'MOTOR,MTR,2300KW', bodega:'B501', ubicacion:'0100', storage_bin:'3029-A', batch:null, stock_sistema:2, unidad_medida:'EA' },
    ] }) }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('[data-tab="conteo"]');
    assert(await esperarVisible(page, '.contar-lugar'), 'al entrar a Contar debe verse la tarjeta del lugar planificado');
    const tarjeta = await page.$eval('.contar-lugar', el => ({ h: el.getBoundingClientRect().height, t: el.querySelector('.contar-lugar-titulo').textContent.trim() }));
    assert(tarjeta.h >= 64 && tarjeta.t === 'B501 · 0100', 'la tarjeta del lugar es grande y nombra bodega · ubicación, obtuvo '+JSON.stringify(tarjeta));
    assert(!(await page.isVisible('#contar-bodega')), 'los <select> de bodega/ubicación quedan plegados (existen, no se ven)');
    assert(await page.$('#contar-bodega') !== null, 'el <select> de bodega sigue en el DOM para quien prefiera la cascada');
    // Bug real (Joel, 13/10/2026): elegir bodega en "Cambiar día o lugar" repintaba la pantalla y el
    // panel se cerraba; había que reabrirlo para elegir la ubicación, y se volvía a cerrar.
    const panelAbierto = () => page.$eval('#contar-cambiar', el => el.open);
    // CPU lenta, como el runner de CI: ahí un repintado alcanzaba a adelantarse al evento toggle.
    const cdpLento = await context.newCDPSession(page);
    await cdpLento.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await page.click('#contar-cambiar > summary');
    await page.selectOption('#contar-bodega', 'B501');
    assert(await esperarVisible(page, '#contar-ubic'), 'tras elegir bodega se ve el <select> de ubicación');
    assert(await panelAbierto(), 'elegir bodega no cierra "Cambiar día o lugar"');
    await page.selectOption('#contar-ubic', '0100');
    assert(await esperarVisible(page, '.contar-lista .list-item'), 'elegir ubicación carga la lista de SKU pendientes');
    assert(await panelAbierto(), 'elegir ubicación no cierra "Cambiar día o lugar"');
    await page.click('#contar-cambiar > summary');
    assert(!(await panelAbierto()), 'la persona lo cierra tocando su cabecera');
    await page.click('#btn-contar-cambiar-lugar');
    assert(await esperarVisible(page, '.contar-lugar'), '"Cambiar lugar" vuelve a las tarjetas de lugar');
    assert(!(await panelAbierto()), 'cerrado por la persona, sigue cerrado tras repintar');
    await cdpLento.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.click('.contar-lugar');
    assert(await esperarVisible(page, '.contar-lista .list-item'), 'tocar la tarjeta debe cargar la lista de SKU pendientes');
    const filas = await page.$$eval('.contar-lista .list-item', els => els.map(e => e.getBoundingClientRect().height));
    assert(filas.length === 2 && filas.every(h => h >= 64), 'las filas de la lista son táctiles (≥ 64 px), obtuvo '+JSON.stringify(filas));
    assert(await page.isVisible('text=Bin 3029-A · 2 pendientes'), 'la lista va agrupada por storage bin con su cabecera');
    assert(await page.isVisible('#btn-contar-cambiar-lugar') && await page.isVisible('#btn-escanear-plan'), 'con el lugar elegido se ven "Cambiar lugar" y "Escanear"');
    const desbordeLista = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeLista <= 0, 'a 420 px la lista no desborda, obtuvo '+desbordeLista);
    await page.click('.contar-lista .list-item');
    assert(await esperarVisible(page, '#c-cant'), 'tocar una fila abre el formulario de conteo del SKU');
    assert(await page.isVisible('text=10475828'), 'el formulario muestra el SKU tocado');
    // Fase 2b: todos los controles del formulario miden al menos 44 px (48 los principales), el
    // stepper escribe en el mismo #c-cant, "Sin stock (0)" lo deja en 0, Guardar mide 56 px y el
    // chip "Sincronizado" está en la cabecera.
    // Se mide recién cuando el formulario terminó de pintarse: #c-cant aparece antes que el resto y
    // un repintado pendiente puede reemplazarlo justo al medir. Pasó en el CI de main (12/10/2026):
    // "obtuvo: []", ningún control medido, y al repetir pasó sin cambiar nada. Si la espera se
    // agota no se calla nada: el assert de abajo falla con lo que haya medido.
    const SELECTOR_CONTROLES = '#form-conteo button, #form-conteo input:not([type=file]):not([type=checkbox]), #form-conteo textarea, #btn-quitar-sku';
    await page.waitForFunction(sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent).length >= 8, SELECTOR_CONTROLES, { timeout:ESPERA }).catch(() => {});
    const controles = await page.$$eval(SELECTOR_CONTROLES, els => els.filter(e => e.offsetParent).map(e => ({ id: e.id || e.textContent.trim().slice(0,16), h: Math.round(e.getBoundingClientRect().height) })));
    const chicos = controles.filter(c => c.h < 44);
    assert(controles.length >= 8 && chicos.length === 0, 'todos los controles del formulario deben medir al menos 44 px, obtuvo: '+JSON.stringify(chicos.length ? chicos : controles));
    const guardarH = await page.$eval('#form-conteo button[type=submit]', e => Math.round(e.getBoundingClientRect().height));
    assert(guardarH >= 56, '"Guardar conteo" mide al menos 56 px, obtuvo '+guardarH);
    await page.click('#c-cant-mas'); await page.click('#c-cant-mas'); await page.click('#c-cant-menos');
    assert((await page.inputValue('#c-cant')) === '1', 'el stepper escribe en #c-cant (+1 +1 −1 = 1), obtuvo '+(await page.inputValue('#c-cant')));
    // Sentry JAVASCRIPT-D: cambiar solo .value no toca el DOM y Sentry tomaba los toques de "+" como
    // "rage click". El stepper deja también el atributo, que sí es un cambio visible del DOM.
    assert((await page.getAttribute('#c-cant', 'value')) === '1', 'el stepper debe dejar también el atributo value, obtuvo '+(await page.getAttribute('#c-cant', 'value')));
    await page.click('#c-cant-cero');
    assert((await page.inputValue('#c-cant')) === '0' && (await page.getAttribute('#c-cant', 'value')) === '0', '"Sin stock (0)" deja #c-cant en 0, valor y atributo');
    assert(await page.isVisible('#chip-conexion') && (await page.textContent('#chip-conexion')).trim() === 'Sincronizado', 'en Contar la cabecera muestra el chip "Sincronizado"');
    const desbordeForm = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeForm <= 0, 'a 420 px el formulario no desborda, obtuvo '+desbordeForm);
    // Daños (pedido de Joel, 13/10/2026): marcar repinta el formulario y no puede borrar lo
    // tecleado; el campo de unidades aparece solo con material dañado y también se conserva.
    await page.fill('#c-cant', '3');
    await page.click('#c-material-danado');
    assert(await esperarVisible(page, '#c-cant-danada'), 'al marcar material dañado aparece el campo de unidades dañadas');
    assert((await page.inputValue('#c-cant')) === '3', 'marcar material dañado no borra la cantidad tecleada, obtuvo '+(await page.inputValue('#c-cant')));
    await page.fill('#c-cant-danada', '2');
    await page.click('#c-packing-danado');
    await page.waitForTimeout(100);
    assert((await page.inputValue('#c-cant-danada')) === '2' && (await page.inputValue('#c-cant')) === '3', 'marcar packing dañado conserva la cantidad y las unidades dañadas');
    assert(await page.isChecked('#c-material-danado') && await page.isChecked('#c-packing-danado'), 'las dos marcas quedan marcadas tras el repintado');
    const desbordeDanos = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeDanos <= 0, 'a 420 px el formulario con daños no desborda, obtuvo '+desbordeDanos);
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/contar-danos-420.png', fullPage: true });
    // Pedido de Joel (09/10): más de 1 sin foto avisa antes de guardar, sin bloquear. El primer
    // toque de Guardar no manda nada; "Guardar sin foto" sí guarda.
    const postsConteo = [];
    const cuerposConteo = [];
    page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/rest/v1/conteos')) { postsConteo.push(req.url()); try { cuerposConteo.push(JSON.parse(req.postData())[0]); } catch(e) {} } });
    await page.fill('#c-cant', '5');
    await page.click('#form-conteo button[type=submit]');
    assert(await esperarVisible(page, '.conteo-aviso-foto'), 'con 5 y sin foto, Guardar debe mostrar el aviso');
    assert((await page.textContent('.conteo-aviso-foto')).includes('Vas a guardar 5 sin foto'), 'el aviso nombra la cantidad');
    await page.waitForTimeout(300);
    assert(postsConteo.length === 0, 'el aviso no guarda nada todavía, obtuvo '+postsConteo.length+' envíos');
    assert((await page.inputValue('#c-cant')) === '5', 'lo tecleado sigue en el campo');
    const botonesAviso = await page.$$eval('.conteo-aviso-foto .btn', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    assert(botonesAviso.length === 2 && botonesAviso.every(h => h >= 44), 'los dos botones del aviso miden al menos 44 px, obtuvo '+JSON.stringify(botonesAviso));
    const desbordeAviso = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeAviso <= 0, 'a 420 px el aviso no desborda, obtuvo '+desbordeAviso);
    await page.click('#btn-aviso-guardar-sin-foto');
    for (let i = 0; i < 30 && !postsConteo.length; i++) await page.waitForTimeout(100);
    assert(postsConteo.length >= 1, '"Guardar sin foto" debe guardar el conteo');
    const cuerpo = cuerposConteo.find(c => c && c.cantidad_contada === 5);
    assert(cuerpo && cuerpo.packing_danado === true && cuerpo.material_danado === true && cuerpo.cantidad_danada === 2, 'el conteo viaja con las marcas de daño y las unidades dañadas, obtuvo '+JSON.stringify(cuerpo));
    await context.close();
  }

  // ===== Contar: la X del buscador vacía el campo sin reemplazar el <input> =====
  // Pedido de Joel (29/09): "un botón para eliminar el SKU anotado, así rápidamente escribo otro".
  // Se marca el nodo: si render() lo reemplazara, en iPad el teclado volvería a letras.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('limpiar-buscador: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.route('**/rest/v1/rpc/buscar_skus_lectura**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'s1', sku_code:'11164514', descripcion:'CLIP,ELEC,PRESS', bodega:'B501', ubicacion:'0102', storage_bin:'N1E-027-B1', batch:null, stock_sistema:3, unidad_medida:'EA' },
    ]) }));
    await page.click('[data-tab="conteo"]');
    await page.waitForSelector('#sku-search');
    await page.waitForTimeout(800);
    assert(!(await page.isVisible('#btn-limpiar-sku-search')), 'con el campo vacío la X no se muestra');
    await page.evaluate(() => { document.getElementById('sku-search').dataset.marca = 'original'; });
    await page.click('#sku-search');
    await page.keyboard.type('11164514');
    await page.waitForSelector('[data-pick-btn="s1"]', { timeout:ESPERA });
    assert(await page.isVisible('#btn-limpiar-sku-search'), 'al escribir aparece la X');
    const caja = await page.$eval('#btn-limpiar-sku-search', el => { const r = el.getBoundingClientRect(); return { w:r.width, h:r.height }; });
    assert(caja.w >= 40 && caja.h >= 40, 'la X tiene un área táctil de al menos 40 px, obtuvo '+JSON.stringify(caja));
    await page.click('#btn-limpiar-sku-search');
    await page.waitForTimeout(200);
    const tras = await page.evaluate(() => { const el = document.getElementById('sku-search'); return { valor: el.value, mismo: el.dataset.marca === 'original', foco: document.activeElement === el }; });
    assert(tras.valor === '' && tras.mismo && tras.foco, 'la X vacía el campo, conserva el mismo <input> y lo deja enfocado, obtuvo '+JSON.stringify(tras));
    assert(!(await page.isVisible('[data-pick-btn="s1"]')) && !(await page.isVisible('#btn-limpiar-sku-search')), 'se van los resultados y la X');
    await page.keyboard.type('10');
    const otro = await page.inputValue('#sku-search');
    assert(otro === '10', 'se puede escribir el siguiente código de inmediato, obtuvo "'+otro+'"');
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desborde <= 0, 'a 420 px no hay desborde horizontal, obtuvo '+desborde);
    await context.close();
  }

  // ===== Alta manual de SKU: sitio por desplegables y revisión del código (Joel, 29/09) =====
  // Con el navegador real: el código existente muestra sus posiciones y completa los datos del
  // material; los desplegables se encadenan; "+ Otra…" abre un campo que se puede
  // teclear sin que se reemplace (en iPad eso reiniciaría el teclado); a 420 px no desborda.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('alta-sku: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.route('**/rest/v1/rpc/catalogos_pantalla_skus**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({
      categorias:['Repuestos'], unidades:['EA'], batches:[],
      generales:[{bodega:'Nave Mina', cantidad_skus:3}, {bodega:'Nave Planta', cantidad_skus:1}],
      ubicaciones:[{id:'u1', bodega:'Nave Mina', ubicacion:null, activo:true}, {id:'u2', bodega:'Nave Planta', ubicacion:null, activo:true}, {id:'u3', bodega:'Nave Mina', ubicacion:'Pasillo 3', activo:true}],
    }) }));
    await page.route('**/rest/v1/ubicaciones_especificas**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{bodega:'Nave Mina', ubicacion:'Pasillo 3', cantidad_skus:2}]) }));
    // Los bins de la ubicación quedan retenidos hasta que se empieza a escribir el bin: así la
    // prueba reproduce que lleguen mientras la persona teclea (antes repintaban y reemplazaban el
    // campo; en CI pasó por azar del orden de llegada).
    let soltarBinsUbicacion;
    const binsUbicacionRetenidos = new Promise(r => { soltarBinsUbicacion = r; });
    await page.route('**/rest/v1/ubicaciones_bins**', async route => {
      const porUbicacion = route.request().url().includes('ubicacion=eq.');
      if(porUbicacion) await binsUbicacionRetenidos;
      await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(porUbicacion
        ? [{bodega:'Nave Mina', ubicacion:'Pasillo 3', storage_bin:'A-01', cantidad_skus:1}, {bodega:'Nave Mina', ubicacion:'Pasillo 3', storage_bin:'A-03', cantidad_skus:1}]
        : [{bodega:'Nave Mina', ubicacion:'Pasillo 3', storage_bin:'A-01', cantidad_skus:1}]) });
    });
    await page.route('**/rest/v1/skus?activo=eq.true&sku_code=eq.**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      {id:'e1', sku_code:'10371892', descripcion:'FILTRO ACEITE', unidad_medida:'EA', categoria:'Repuestos', costo_unitario:1500, critico:false, bodega:'Nave Mina', ubicacion:'Pasillo 3', storage_bin:'A-01', batch:null},
    ]) }));
    await page.evaluate(() => setState({view:'skus'}));
    await page.waitForSelector('#form-sku');
    // "Lista primero": el alta manual va plegada sobre la tabla; se abre tocando su línea.
    if(!(await page.isVisible('#s-code'))) await page.click('#skus-agregar > summary');
    await page.waitForSelector('#s-code', { state:'visible', timeout:ESPERA });
    await page.waitForFunction(() => document.querySelectorAll('#s-bodega option').length >= 4, null, { timeout:ESPERA });
    await page.fill('#s-code', '10371892');
    await page.press('#s-code', 'Tab');
    await page.waitForSelector('#sku-codigo-existente', { timeout:ESPERA });
    const desc = await page.inputValue('#s-desc');
    assert(desc === 'FILTRO ACEITE', 'el código existente completa la descripción del material, obtuvo "'+desc+'"');
    await page.selectOption('#s-bodega', 'Nave Mina');
    await page.waitForFunction(() => [...document.querySelectorAll('#s-ubic option')].some(o=>o.value==='Pasillo 3'), null, { timeout:ESPERA });
    const codigoSigue = await page.inputValue('#s-code');
    assert(codigoSigue === '10371892', 'elegir la bodega no borra lo escrito en otros campos, obtuvo "'+codigoSigue+'"');
    await page.selectOption('#s-ubic', 'Pasillo 3');
    // El bin se escribe, con los de esa ubicación como sugerencias (Joel, 19/10/2026).
    await page.waitForFunction(() => [...document.querySelectorAll('#dl-bins-sku option')].some(o=>o.value==='A-01'), null, { timeout:ESPERA });
    assert(await page.evaluate(() => document.getElementById('s-bin').tagName === 'INPUT' && document.getElementById('s-bin').getAttribute('list') === 'dl-bins-sku'), 'el storage bin es un campo de texto con sugerencias');
    await page.evaluate(() => { document.getElementById('s-bin').dataset.marca = 'original'; });
    await page.click('#s-bin');
    await page.keyboard.type('A-');
    soltarBinsUbicacion();
    await page.waitForFunction(() => [...document.querySelectorAll('#dl-bins-sku option')].some(o=>o.value==='A-03'), null, { timeout:ESPERA });
    await page.keyboard.type('02');
    const binNuevo = await page.evaluate(() => { const el = document.getElementById('s-bin'); return { valor: el.value, mismo: el.dataset.marca === 'original', estado: state.skuForm.storage_bin }; });
    assert(binNuevo.valor === 'A-02' && binNuevo.mismo && binNuevo.estado === 'A-02', 'escribir el bin no reemplaza el campo y queda en el estado, obtuvo '+JSON.stringify(binNuevo));
    // Un repintado (otro campo cambia) conserva lo escrito.
    await page.evaluate(() => conservandoCamposSku(() => setState({skuForm:{...state.skuForm}})));
    assert(await page.inputValue('#s-bin') === 'A-02', 'el bin escrito sobrevive a un repintado');
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desborde <= 0, 'a 420 px el formulario no desborda, obtuvo '+desborde);
    await context.close();
  }

  // ===== Contar: "ya contado este período" no borra la cantidad que se está escribiendo =====
  // La respuesta de contado_periodo llega después de elegir el SKU; con señal lenta (o al fallar
  // sin señal) llegaba cuando la persona ya había escrito la cantidad, y su render() la borraba:
  // en CI (20/10/2026) el conteo sin señal quedó sin cantidad y no se guardó. Se retiene la
  // respuesta hasta después de escribir, para reproducirlo siempre.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('veces-periodo: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    let soltarVeces;
    const vecesRetenido = new Promise(r => { soltarVeces = r; });
    await page.route('**/rest/v1/rpc/contado_periodo**', async route => {
      await vecesRetenido;
      await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ veces:2, ultima_fecha:'2026-10-19T14:05:00Z', ultima_cantidad:7, ultimo_por:'Pedro Soto' }) });
    });
    await page.evaluate(() => setState({ view:'conteo', skuSeleccionado:{ id:'sv-1', sku_code:'10418772', descripcion:'BEARING UNIT', bodega:'B521', ubicacion:'0200', storage_bin:null, batch:null, stock_sistema:5, unidad_medida:'EA' }, conteoOrigenPlan:true }));
    await page.waitForSelector('#c-cant', { timeout:ESPERA });
    await page.evaluate(() => { document.getElementById('c-cant').dataset.marca = 'original'; });
    await page.click('#c-cant');
    await page.keyboard.type('12');
    soltarVeces();
    assert(await esperarCondicion(page, () => (document.getElementById('conteo-veces-periodo')||{}).textContent.includes('Ya contado 2 veces')), 'el aviso "ya contado" aparece al llegar la respuesta');
    const cant = await page.evaluate(() => { const el = document.getElementById('c-cant'); return { valor: el.value, mismo: el.dataset.marca === 'original', foco: document.activeElement === el }; });
    assert(cant.valor === '12' && cant.mismo && cant.foco, 'la respuesta no reemplaza el campo cantidad ni borra lo escrito, obtuvo '+JSON.stringify(cant));
    await context.close();
  }

  // ===== Carga de Excel: filas repetidas que se suman (Joel, 20/10/2026) =====
  // Un WMS anota cada pallet en su propia fila. Con el archivo real en el navegador a 420 px: el
  // aviso muestra qué stock queda con cada opción, se elige "Sumar" y el upsert lleva la suma.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('carga-sumar: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    const upserts = [];
    await page.route('**/rest/v1/skus?on_conflict=**', r=> { upserts.push(...JSON.parse(r.request().postData())); return r.fulfill({ status:201, contentType:'application/json', body:'' }); });
    await page.evaluate(() => setState({ view:'carga' }));
    await page.waitForSelector('#file-skus', { state:'attached', timeout:ESPERA });
    const csv = 'Codigo,Descripcion,Bodega,Ubicacion,Storage Bin,Batch,Stock,Costo\n'
      + 'P-100,Filtro de aire,CD1,RK,R-01-02,L1,1,1500\n'
      + 'P-100,Filtro de aire,CD1,RK,R-01-02,L1,1,1500\n'
      + 'P-100,Filtro de aire,CD1,RK,R-01-02,L2,3,1500\n'
      + 'P-200,Correa B-52,CD1,RK,R-02-01,L9,4,800\n'
      + 'P-200,Correa B-52,CD1,RK,R-02-01,L9,5,800\n';
    await page.setInputFiles('#file-skus', { name:'stock-wms.csv', mimeType:'text/csv', buffer: Buffer.from(csv) });
    await page.waitForSelector('input[name="repetidas-carga"]', { timeout:ESPERA });
    for(const [campo, col] of [['sku_code','Codigo'],['descripcion','Descripcion'],['bodega','Bodega'],['storage_bin','Storage Bin'],['batch','Batch'],['stock_sistema','Stock'],['ubicacion','Ubicacion'],['costo_unitario','Costo']]){
      if(await page.$eval(`#map-${campo}`, el=>el.value) !== col){ await page.selectOption(`#map-${campo}`, col); await page.waitForTimeout(150); }
    }
    const aviso = await page.evaluate(() => ({ texto: [...document.querySelectorAll('.card')].map(c=>c.textContent).find(t=>t.includes('comparten identidad'))||'', marcado: (document.querySelector('input[name="repetidas-carga"]:checked')||{}).value, desborde: document.documentElement.scrollWidth - window.innerWidth }));
    assert(aviso.texto.includes('2 fila(s) del archivo comparten identidad') && aviso.marcado==='ultima', 'el aviso cuenta las repetidas y por defecto queda la última, obtuvo '+JSON.stringify(aviso));
    assert(aviso.desborde<=0, 'a 420 px el aviso de repetidas no desborda la página, obtuvo '+aviso.desborde);
    await page.check('input[name="repetidas-carga"][value="sumar"]');
    assert(await esperarCondicion(page, () => state.cargaPreview.repetidas==='sumar' && document.body.textContent.includes('2 fila(s) repetidas se suman a su material')), 'al elegir Sumar, el resumen lo dice');
    // La bodega de prueba no existe en la empresa simulada: se confirma el aviso, como lo haría una persona.
    if(await page.$('#chk-confirma-aviso-bodega')) await page.check('#chk-confirma-aviso-bodega');
    await page.click('#btn-confirmar-carga');
    assert(await esperarCondicion(page, () => !!state.cargaResultado), 'la carga termina');
    const stock = (code, batch) => (upserts.find(f=>f.sku_code===code && f.batch===batch)||{}).stock_sistema;
    assert(upserts.length===3 && stock('P-100','L1')===2 && stock('P-100','L2')===3 && stock('P-200','L9')===9, 'el upsert lleva 3 materiales con la suma de sus pallets (1+1, 3, 4+5), obtuvo '+JSON.stringify(upserts.map(f=>[f.sku_code,f.batch,f.stock_sistema])));
    await context.close();
  }

  // ===== Sin señal y sin espacio en el celular: el conteo no se da por guardado =====
  // Con el localStorage real de Chromium lleno: antes la pantalla decía "conteo guardado en este
  // dispositivo" y el conteo vivía solo en memoria. Ahora avisa sobre el botón y deja lo escrito.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('sin-espacio: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.evaluate(() => setState({ view:'conteo', skuSeleccionado:{ id:'sl-1', sku_code:'10418772', descripcion:'BEARING UNIT', bodega:'B521', ubicacion:'0200', storage_bin:null, batch:null, stock_sistema:5, unidad_medida:'EA' }, conteoOrigenPlan:true }));
    await page.waitForSelector('#c-cant', { timeout:ESPERA });
    // Con señal y un error del servidor, la cantidad escrita tampoco se borra (antes el repintado
    // de "guardando…" la dejaba vacía).
    await page.route('**/rest/v1/conteos?**', r=> r.request().method()==='POST' ? r.fulfill({ status:400, contentType:'application/json', body: JSON.stringify({ message:'la cantidad contada es inválida' }) }) : r.fallback());
    await page.fill('#c-cant', '3');
    await page.click('#form-conteo .conteo-pie button[type="submit"]');
    if(await esperarVisible(page, '#btn-aviso-guardar-sin-foto')) await page.click('#btn-aviso-guardar-sin-foto');
    assert(await esperarCondicion(page, () => [...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('la cantidad contada es inválida'))), 'el error del servidor se muestra con su mensaje');
    const trasError = await page.evaluate(() => ({ cant: document.getElementById('c-cant').value, sku: !!state.skuSeleccionado }));
    assert(trasError.cant==='3' && trasError.sku, 'tras un error del servidor, la cantidad escrita sigue en el campo, obtuvo '+JSON.stringify(trasError));
    await page.unroute('**/rest/v1/conteos?**');
    await page.route(u=> /\/(rest|auth|storage)\/v1\//.test(u.toString()), r=> r.abort('internetdisconnected'));
    await context.setOffline(true);
    const relleno = await page.evaluate(() => {
      let n = 0;
      for(const tam of [1<<20, 1<<16, 1<<12, 1<<8]){
        const bloque = 'x'.repeat(tam);
        for(;;){ try{ localStorage.setItem('relleno-'+(n++), bloque); }catch(e){ break; } }
      }
      return n;
    });
    await page.fill('#c-cant', '3');
    await page.click('#form-conteo .conteo-pie button[type="submit"]');
    if(await esperarVisible(page, '#btn-aviso-guardar-sin-foto')) await page.click('#btn-aviso-guardar-sin-foto');
    assert(await esperarVisible(page, '.conteo-no-guardado'), 'sin espacio, el conteo avisa sobre el botón que no se guardó (relleno: '+relleno+' bloques)');
    const sinEspacio = await page.evaluate(() => ({ cant: document.getElementById('c-cant').value, cola: state.colaOffline.length, guardada: JSON.parse(localStorage.getItem('cola_offline_conteos')||'[]').length, aviso: document.querySelector('.conteo-no-guardado').textContent, desborde: document.documentElement.scrollWidth - window.innerWidth }));
    assert(sinEspacio.cant==='3' && sinEspacio.cola===0 && sinEspacio.guardada===0, 'sin espacio, lo escrito sigue y nada aparece como por enviar, obtuvo '+JSON.stringify(sinEspacio));
    assert(sinEspacio.aviso.includes('no tiene espacio') && sinEspacio.desborde<=0, 'el aviso dice el motivo y no desborda a 420 px, obtuvo '+JSON.stringify(sinEspacio));
    // Liberado el espacio, el mismo conteo se guarda sin volver a escribirlo.
    await page.evaluate(() => { Object.keys(localStorage).filter(k=>k.startsWith('relleno-')).forEach(k=>localStorage.removeItem(k)); });
    await page.click('#form-conteo .conteo-pie button[type="submit"]');
    if(await esperarVisible(page, '#btn-aviso-guardar-sin-foto')) await page.click('#btn-aviso-guardar-sin-foto');
    assert(await esperarCondicion(page, () => state.colaOffline.length===1 && JSON.parse(localStorage.getItem('cola_offline_conteos')||'[]').length===1), 'con espacio liberado, el conteo queda guardado en el celular');
    await context.close();
  }

  // ===== Preparar para sin señal, Contar y Reconteo sin señal (Joel, 20/10/2026) =====
  // En el navegador real a 420 px: con señal se prepara (todos los lugares del día y los
  // reconteos); sin señal se abre un lugar nunca tocado, se cuenta y el SKU sale de la lista;
  // Reconteo muestra la lista guardada con sus acciones de administrador apagadas; y al volver la
  // señal todo se envía y el aviso de plan guardado se va solo.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('preparar-sin-senal: '+err.message));
    await mockearSupabaseApp(page, PERFIL_ADMIN_PRO);
    const hoy = await page.evaluate(()=>{ const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }).catch(()=>new Date().toISOString().slice(0,10));
    const J = (route, x) => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(x) });
    const entrada = (id, bodega, ubicacion, bin) => ({ id, fecha:hoy, bodega, ubicacion, storage_bin:bin, solo_sin_ubicacion:false, por_sku:false, responsable_id:null, responsable_nombre:null, skus_excluidos:[], skus_incluidos:[] });
    const sku = (id, code, desc, bodega, ubic, bin) => ({ id, sku_code:code, descripcion:desc, bodega, ubicacion:ubic, storage_bin:bin, batch:null, stock_sistema:5, unidad_medida:'EA' });
    const universo = { 'pe-1': [ sku('ps-1','10475828','REDUCER,LH','B501','0100','3029-A'), sku('ps-2','11172553','MOTOR,MTR','B501','0100','3029-A') ], 'pe-2': [ sku('ps-3','10418772','BEARING UNIT','B521','0200',null) ] };
    const rec = (id, conteo, code, desc, fecha) => ({ id, conteo_id:conteo, sku_code:code, descripcion:desc, bodega:'B501', ubicacion:'0100', storage_bin:'3029-A', stock_sistema:10, ultima_cantidad_contada:8, ultima_diferencia:-2, ultimo_conteo_fecha:fecha, causa_probable:'Sin patrón detectado', fotos:[] });
    const reconteos = [ rec('ps-1','rc-1','10475828','REDUCER,LH', hoy+'T12:00:00Z'), rec('ps-9','rc-9','10999999','VALVULA', hoy+'T11:00:00Z') ];
    const conteosEnviados = [];
    let sinRed = false;
    await page.route('**/rest/v1/plan_semanal_detalle**', r=> J(r, [ entrada('pe-1','B501','0100','3029-A'), entrada('pe-2','B521','0200',null) ]));
    await page.route('**/rest/v1/rpc/universo_entradas_plan_contar**', r=> { const ids = (r.request().postDataJSON()||{}).p_plan_ids||[]; const o = {}; ids.forEach(i=>{ if(universo[i]) o[i] = universo[i]; }); return J(r, o); });
    await page.route('**/rest/v1/reconteo_pendiente?**', r=> J(r, reconteos));
    await page.route('**/rest/v1/conteos?on_conflict=**', r=> { conteosEnviados.push(JSON.parse(r.request().postData())[0]); return J(r, [{ id:'cnt-e2e-'+conteosEnviados.length }]); });
    // La última ruta registrada atiende primero: sin señal, todo lo que va al servidor falla.
    await page.route(u=> /\/(rest|auth|storage)\/v1\//.test(u.toString()), r=> sinRed ? r.abort('internetdisconnected') : r.fallback());
    const cortarSenal = async v => { sinRed = v; await context.setOffline(v); };
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('[data-tab="conteo"]');
    assert(await esperarVisible(page, '#btn-preparar-sin-senal'), 'con señal, Contar ofrece "Preparar para sin señal"');
    await page.click('#btn-preparar-sin-senal');
    assert(await esperarVisible(page, '.contar-sin-senal.listo'), 'tras preparar, Contar dice que quedó listo');
    const listo = await page.textContent('.contar-sin-senal.listo');
    assert(listo.includes('2 lugares, 3 SKU y 2 reconteos guardados'), 'dice cuántos lugares, SKU y reconteos quedaron en el celular, obtuvo '+listo);
    if(process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/preparar-sin-senal-420.png', fullPage:true });

    await cortarSenal(true);
    await page.click('.contar-lugar:has-text("B521")');
    assert(await esperarVisible(page, '.contar-lista [data-pick-plan="ps-3"]'), 'sin señal, un lugar que nunca se abrió muestra sus SKU (quedó preparado)');
    await page.click('[data-pick-plan="ps-3"]');
    await page.waitForSelector('#c-cant', { timeout:ESPERA });
    await page.fill('#c-cant', '4');
    await page.click('#form-conteo .conteo-pie button[type="submit"]');
    if(await esperarVisible(page, '#btn-aviso-guardar-sin-foto')) await page.click('#btn-aviso-guardar-sin-foto');
    assert(await esperarCondicion(page, ()=> state.colaOffline.length===1 && !state.skuSeleccionado), 'el conteo queda en la cola del celular');
    assert(await esperarVisible(page, '#contar-por-enviar'), 'Contar nombra lo contado por enviar');
    const lista = await page.evaluate(()=> ({ quedan: [...document.querySelectorAll('.contar-lista [data-pick-plan]')].map(b=>b.dataset.pickPlan), porEnviar: document.getElementById('contar-por-enviar').textContent }));
    assert(!lista.quedan.includes('ps-3') && lista.porEnviar.includes('1 contado, por enviar: 10418772'), 'el SKU contado sin señal sale de la lista, obtuvo '+JSON.stringify(lista));

    await page.click('[data-tab="reconteo"]');
    assert(await esperarVisible(page, '#reconteo-sin-senal'), 'sin señal, Reconteo muestra la lista guardada y lo dice');
    // El aviso sale apenas se corta la señal; la lista guardada se pinta un momento después (pasó
    // en el CI: se leyó la tabla antes de que llegara).
    assert(await esperarCondicion(page, ()=> document.querySelectorAll('[data-recontar]').length===2), 'la lista guardada llega a la tabla');
    const recSin = await page.evaluate(()=> { const b = s => document.querySelector(s); return { filas: document.querySelectorAll('[data-recontar]').length, recontarActivo: !!b('[data-recontar="ps-1"]') && !b('[data-recontar="ps-1"]').disabled, descartarApagado: !!b('[data-descartar-reconteo="rc-1"]') && b('[data-descartar-reconteo="rc-1"]').disabled }; });
    assert(recSin.filas===2 && recSin.recontarActivo && recSin.descartarApagado, 'Recontar funciona y Descartar se apaga sin señal, obtuvo '+JSON.stringify(recSin));
    const desbordeRec = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeRec <= 0, 'a 420 px Reconteo sin señal no desborda, obtuvo '+desbordeRec);
    if(process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/reconteo-sin-senal-420.png', fullPage:true });

    await page.click('[data-tab="conteo"]');
    await cortarSenal(false);
    assert(await esperarCondicion(page, ()=> state.colaOffline.length===0), 'al volver la señal el conteo se envía solo');
    assert(conteosEnviados.length===1 && conteosEnviados[0].cantidad_contada===4 && conteosEnviados[0].sku_id==='ps-3', 'llega el conteo con su SKU, obtuvo '+JSON.stringify(conteosEnviados));
    assert(await esperarCondicion(page, ()=> !state.contarPlan.desdeCache && ![...document.querySelectorAll('main .badge')].some(b=> b.textContent.includes('mostrando el plan guardado'))), 'el aviso de plan guardado se va solo al volver la señal');
    await context.close();
  }

  // ===== Crear y contar un SKU sin señal (Joel, 14/10/2026) =====
  // En el navegador real: sin señal se crea el SKU desde el formulario, "Contar ahora" lleva a
  // Contar con el material elegido, el conteo queda guardado detrás del SKU y, al volver la señal,
  // sale primero el SKU y después el conteo con el id que el servidor le dio.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('crear-contar-sin-senal: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    let conSenal = false;
    const enviados = [];
    await page.route('**/rest/v1/rpc/catalogos_pantalla_skus**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({
      categorias:['Repuestos'], unidades:['EA'], batches:[],
      generales:[{bodega:'Nave Mina', cantidad_skus:3}],
      ubicaciones:[{id:'u1', bodega:'Nave Mina', ubicacion:null, activo:true}],
    }) }));
    await page.route('**/rest/v1/skus?activo=eq.true&sku_code=eq.**', route => conSenal
      ? route.fulfill({ status:200, contentType:'application/json', body:'[]' }) : route.abort('internetdisconnected'));
    await page.route('**/rest/v1/skus', route => {
      if(route.request().method() !== 'POST') return route.fallback();
      if(!conSenal) return route.abort('internetdisconnected');
      const fila = JSON.parse(route.request().postData())[0];
      enviados.push({ tipo:'sku', fila });
      return route.fulfill({ status:201, contentType:'application/json', body: JSON.stringify([{ id:'srv-sku-77', activo:true, ...fila }]) });
    });
    await page.route('**/rest/v1/conteos?on_conflict=**', route => {
      if(!conSenal) return route.abort('internetdisconnected');
      const fila = JSON.parse(route.request().postData())[0];
      enviados.push({ tipo:'conteo', fila });
      return route.fulfill({ status:201, contentType:'application/json', body: JSON.stringify([{ id:'conteo-77' }]) });
    });
    await page.route('**/rest/v1/rpc/buscar_skus_lectura**', route => conSenal
      ? route.fulfill({ status:200, contentType:'application/json', body:'[]' }) : route.abort('internetdisconnected'));

    await page.evaluate(() => setState({view:'skus'}));
    await page.waitForSelector('#form-sku');
    if(!(await page.isVisible('#s-code'))) await page.click('#skus-agregar > summary');
    await page.waitForSelector('#s-code', { state:'visible', timeout:ESPERA });
    await page.waitForFunction(() => [...document.querySelectorAll('#s-bodega option')].some(o=>o.value==='Nave Mina'), null, { timeout:ESPERA });
    await page.fill('#s-code', 'NUEVO-77');
    await page.press('#s-code', 'Tab');
    // Sin señal la revisión del código no se puede hacer y lo dice sin alarmar (no lo da por nuevo
    // y deja claro que se puede guardar igual; Joel, 19/10/2026: el texto en rojo confundía).
    assert(await esperarCondicion(page, () => !!document.getElementById('sku-codigo-sin-senal')), 'sin señal, la revisión del código avisa que no se pudo hacer');
    const avisoSinSenal = await page.textContent('#sku-codigo-sin-senal');
    assert(avisoSinSenal.includes('Puedes guardarlo igual') && !avisoSinSenal.includes('No se pudo revisar'), 'el aviso dice que se puede guardar igual, obtuvo '+avisoSinSenal);
    await page.fill('#s-desc', 'Valvula de bola');
    await page.selectOption('#s-bodega', 'Nave Mina');
    await page.fill('#s-bin', 'N1E-001-A1');
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/sku-form-sin-senal-420.png', fullPage: true });
    await page.fill('#s-stock', '3');
    await page.click('#form-sku button[type=submit]');
    assert(await esperarVisible(page, '#btn-contar-sku-creado'), 'sin señal, el SKU guardado ofrece "Contar ahora"');
    assert((await page.textContent('#sku-recien-creado')).includes('Sin enviar'), 'el aviso dice que el SKU no se ha enviado');
    const desbordeAvisoSku = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeAvisoSku <= 0, 'a 420 px el aviso del SKU creado no desborda, obtuvo '+desbordeAvisoSku);
    // El desplazamiento es suave: se espera a que termine. El aviso entero queda bajo la cabecera.
    const avisoVisible = await esperarCondicion(page, () => { const r = document.getElementById('sku-recien-creado').getBoundingClientRect(); const cab = document.querySelector('.topbar').getBoundingClientRect().bottom; return r.top >= cab && r.bottom <= window.innerHeight; });
    assert(avisoVisible, 'tras guardar, el aviso con "Contar ahora" queda entero a la vista');
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/sku-creado-sin-senal-420.png' });

    await page.click('#btn-contar-sku-creado');
    await page.waitForSelector('#form-conteo', { timeout:ESPERA });
    const ficha = await page.textContent('.conteo-ficha');
    assert(ficha.includes('SKU nuevo, sin enviar') && ficha.includes('Valvula de bola'), 'la ficha de Contar muestra el SKU nuevo y avisa que no se ha enviado, obtuvo '+ficha);
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/contar-sku-sin-enviar-420.png' });
    await page.fill('#c-cant', '1');
    await page.click('#form-conteo button[type=submit]');
    const guardado = await esperarCondicion(page, () => state.colaOffline.length === 2 && state.colaOffline.some(i => i.tipo==='conteo' && i.sku_local_id && !i.sku_id) && !state.skuSeleccionado);
    assert(guardado, 'el conteo queda en la cola detrás de su SKU');
    assert(!enviados.length, 'sin señal no se envía nada');

    // El buscador de Contar lo encuentra aunque no esté en el servidor.
    await page.click('#sku-search');
    await page.keyboard.type('NUEVO-77');
    assert(await esperarVisible(page, '[data-pick-local-btn]'), 'el buscador de Contar muestra el SKU sin enviar');
    assert(await esperarCondicion(page, () => document.getElementById('buscador-libre-resultados').textContent.includes('No se pudo buscar en el maestro')), 'sin señal, el buscador dice que no pudo buscar, no que no hay coincidencias');
    assert(await page.isVisible('[data-pick-local-btn]'), 'el SKU sin enviar sigue en la lista junto al error del maestro');
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/buscador-sin-senal-420.png' });

    conSenal = true;
    await page.evaluate(() => sincronizarColaOffline());
    const enviado = await esperarCondicion(page, () => state.colaOffline.length === 0);
    assert(enviado, 'con señal, la cola se vacía');
    assert(enviados[0] && enviados[0].fila.storage_bin === 'N1E-001-A1', 'el bin escrito sin señal llega con el SKU, obtuvo '+JSON.stringify(enviados[0] && enviados[0].fila));
    assert(enviados.length === 2 && enviados[0].tipo === 'sku' && enviados[1].tipo === 'conteo' && enviados[1].fila.sku_id === 'srv-sku-77' && enviados[1].fila.cantidad_contada === 1,
      'sale el SKU y después su conteo, con el id del SKU, obtuvo '+JSON.stringify(enviados.map(e => ({ tipo:e.tipo, sku_id:e.fila.sku_id }))));
    await context.close();
  }

  // ===== Planificación en el celular (Joel, 29/09): días plegables, "Agregar" plegado, Asignar =====
  // Con el navegador real a 420 px: con muchas entradas en Mes cada día es un bloque (solo hoy
  // abierto), el resumen va antes del formulario, "+ Agregar" abre el formulario con Ubicación
  // específica y Storage bin uno bajo el otro, la lista de bins crece al llenarse, "Asignar"
  // lleva a la reasignación con las entradas sin responsable ya elegidas, y la barra de abajo
  // muestra cada pestaña en una sola línea.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('planificacion: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    const hoy = await page.evaluate(() => fechaISO(new Date()));
    const mes = hoy.slice(0,8);
    const entradas = Array.from({length:50}, (_,i) => ({
      id:'pl'+i, fecha: i===0 ? hoy : mes+String(1+(i%10)).padStart(2,'0'), bodega:'Nave Mina', ubicacion:'Pasillo '+(i%5), storage_bin:null,
      responsable_id: i%4===0 ? null : 'r1', responsable_nombre: i%4===0 ? null : 'Pedro Soto', ciclo_nombre:null, nota:null, skus_excluidos:[], por_sku:false,
    }));
    let cuerpoPlan = null;
    await page.route('**/rest/v1/rpc/plan_ventana_pantalla**', route => {
      cuerpoPlan = JSON.parse(route.request().postData());
      const lista = entradas.filter(e => !cuerpoPlan.p_desde || (e.fecha>=cuerpoPlan.p_desde && e.fecha<=cuerpoPlan.p_hasta));
      const cuerpo = {entradas: lista};
      if(cuerpoPlan.p_resumido) cuerpo.resumen = lista.map(e => ({plan_id:e.id, total:12, propios:12}));
      else cuerpo.universo = {};
      route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(cuerpo) });
    });
    await page.route('**/rest/v1/usuarios?activo=eq.true&select=id,nombre,rol**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{id:'r1', nombre:'Pedro Soto', rol:'operador'}, {id:'r2', nombre:'María Rojas', rol:'operador'}]) }));
    await page.route('**/rest/v1/ubicaciones_generales**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{bodega:'Nave Mina', cantidad_skus:40, cantidad_pendiente:30}]) }));
    await page.route('**/rest/v1/ubicaciones_especificas**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{bodega:'Nave Mina', ubicacion:'Pasillo 3', cantidad_skus:2600, cantidad_pendiente:2500}]) }));
    // "Todas": 2 bins. Pasillo 3: 1.000 filas, el tope de PostgREST (la lista llega cortada).
    await page.route('**/rest/v1/ubicaciones_bins**', route => {
      const url = decodeURIComponent(route.request().url());
      const filas = url.includes('ubicacion=eq.Pasillo 3')
        ? Array.from({length:1000}, (_,i) => ({bodega:'Nave Mina', ubicacion:'Pasillo 3', storage_bin:'B-'+String(i).padStart(4,'0'), cantidad_skus:2}))
        : [{bodega:'Nave Mina', ubicacion:'Pasillo 3', storage_bin:'A-01', cantidad_skus:4}, {bodega:'Nave Mina', ubicacion:'Pasillo 3', storage_bin:'A-02', cantidad_skus:4}];
      route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(filas) });
    });
    // Pendientes sin storage bin: conteo exacto del servidor (content-range), no la resta.
    await page.route(/skus_disponibles_planificar\?.*storage_bin\.is\.null/, route => {
      const url = decodeURIComponent(route.request().url());
      const n = url.includes('ubicacion=eq.Pasillo 3') ? 147 : 22;
      route.fulfill({ status:200, contentType:'application/json', headers:{'content-range':`0-0/${n}`, 'access-control-expose-headers':'content-range', 'access-control-allow-origin':'*'}, body:'[]' });
    });
    await page.evaluate(() => { setState({view:'plan'}); cambiarModoPlan('mes'); });
    await page.waitForSelector('.plan-dia-toggle', { timeout:ESPERA });
    assert(cuerpoPlan && cuerpoPlan.p_resumido === true && cuerpoPlan.p_desde === mes+'01', 'Mes pide plan_ventana_pantalla resumido desde el día 1, obtuvo '+JSON.stringify(cuerpoPlan));
    const dias = await page.evaluate(() => [...document.querySelectorAll('.plan-dia-toggle')].map(b => ({iso:b.dataset.planDia, abierto:b.getAttribute('aria-expanded')==='true'})));
    assert(dias.length === new Set(entradas.map(e=>e.fecha)).size && dias.filter(d=>d.abierto).length === 1 && dias.find(d=>d.abierto).iso === hoy, 'un bloque por día y solo hoy abierto, obtuvo '+JSON.stringify(dias));
    const orden = await page.evaluate(() => { const r = document.querySelector('.section-head h2'); const heads = [...document.querySelectorAll('.section-head h2')].map(h=>h.textContent); const res = [...document.querySelectorAll('.section-head h2')].find(h=>/Resumen del mes/.test(h.textContent)); const card = document.getElementById('plan-agregar-card'); return !!res && !!card && (res.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'ok' : heads.join('|'); });
    assert(orden === 'ok', 'el resumen va antes de "Agregar a la planificación", obtuvo '+orden);
    const otro = dias.find(d=>!d.abierto).iso;
    await page.click(`[data-plan-dia="${otro}"]`);
    await page.waitForFunction(iso => document.querySelector(`[data-plan-dia="${iso}"]`).getAttribute('aria-expanded') === 'true', otro, { timeout:ESPERA });
    // "Asignar": quedan elegidas las entradas sin responsable y se llega a "Reasignar a…".
    await page.click('#btn-asignar-sin-responsable');
    await page.waitForSelector('#plan-reasignar-select', { timeout:ESPERA });
    const asignar = await page.evaluate(() => ({ n: state.plan.seleccionados.length, foco: document.activeElement && document.activeElement.id }));
    assert(asignar.n === entradas.filter(e=>!e.responsable_id).length && asignar.foco === 'plan-reasignar-select', 'Asignar elige las sin responsable y enfoca "Reasignar a…", obtuvo '+JSON.stringify(asignar));
    // Barra de selección (Joel, 30/09): dice SKU y storage bin de lo elegido, y sus botones no se
    // salen de la pantalla (antes "Eliminar" quedaba 60 px fuera a 420 px).
    const barraSel = await page.evaluate(() => ({ resumen: document.querySelector('.plan-seleccion-resumen').textContent, derecha: Math.max(...['plan-reasignar-select','btn-reasignar-seleccion-plan','btn-cancelar-seleccion-plan','btn-borrar-seleccion-plan'].map(id => document.getElementById(id).getBoundingClientRect().right)), ancho: window.innerWidth }));
    assert(barraSel.resumen === '156 SKU · 0 storage bin · 13 entradas sin storage bin fijo' && barraSel.derecha <= barraSel.ancho, 'la barra de selección resume SKU y bins y sus botones caben a 420 px, obtuvo '+JSON.stringify(barraSel));
    await page.click('#btn-cancelar-seleccion-plan');
    // "Seleccionar día" (Joel, 14/10/2026): la casilla del encabezado elige las entradas de ese día
    // sin abrirlo ni cerrarlo, la barra de acciones masivas aparece y el área táctil mide 44 px.
    const cerrado = dias.find(d=>!d.abierto && d.iso!==otro).iso;
    const esperadasDia = entradas.filter(e=>e.fecha===cerrado).map(e=>e.id).sort();
    const areaDia = await page.$eval(`[data-select-dia="${cerrado}"]`, el => { const r = el.closest('label').getBoundingClientRect(); return {w:Math.round(r.width), h:Math.round(r.height)}; });
    assert(areaDia.w >= 44 && areaDia.h >= 44, 'la casilla del día debe tener un área táctil de al menos 44 px, obtuvo '+JSON.stringify(areaDia));
    await page.click(`[data-select-dia="${cerrado}"]`);
    await page.waitForSelector('#btn-reasignar-seleccion-plan', { timeout:ESPERA });
    const selDia = await page.evaluate(iso => ({ ids: state.plan.seleccionados.slice().sort(), marcada: document.querySelector(`[data-select-dia="${iso}"]`).checked, abierto: document.querySelector(`[data-plan-dia="${iso}"]`).getAttribute('aria-expanded') }), cerrado);
    assert(JSON.stringify(selDia.ids) === JSON.stringify(esperadasDia) && selDia.marcada && selDia.abierto === 'false', 'marcar el día elige solo sus entradas y no lo abre, obtuvo '+JSON.stringify(selDia));
    const desbordePlan = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert(desbordePlan <= 0, 'a 420 px Planificación no debe desbordar a lo ancho con la casilla por día, desborda '+desbordePlan+' px');
    if(process.env.CAPTURA_PLAN_DIA) await page.screenshot({ path: process.env.CAPTURA_PLAN_DIA, clip: await (await page.$(`[data-plan-dia="${cerrado}"]`)).evaluate(el => { const c = el.closest('.plan-dia').getBoundingClientRect(); return {x:0, y:Math.max(0, c.top-170+window.scrollY), width:420, height:330}; }), fullPage:true });
    await page.click(`[data-select-dia="${cerrado}"]`);
    await page.waitForFunction(() => state.plan.seleccionados.length === 0, null, { timeout:ESPERA });
    // "+ Agregar": el formulario aparece; Ubicación específica y Storage bin apilados; bins crece.
    assert(!(await page.isVisible('#form-plan')), 'con entradas, el formulario parte oculto');
    await page.click('#btn-toggle-agregar-plan');
    await page.waitForSelector('#form-plan', { state:'visible', timeout:ESPERA });
    const binVacio = await page.evaluate(() => document.getElementById('p-bin').size);
    await page.selectOption('#p-bodega', 'Nave Mina');
    await page.waitForFunction(() => [...document.querySelectorAll('#p-bin option')].some(o=>o.value==='A-01'), null, { timeout:ESPERA });
    const sitio = await page.evaluate(() => { const u = document.getElementById('p-ubic').getBoundingClientRect(), b = document.getElementById('p-bin').getBoundingClientRect(); return { apilados: b.top >= u.bottom, anchoIgual: Math.abs(u.width-b.width) < 2, binLleno: document.getElementById('p-bin').size }; });
    assert(binVacio === 2 && sitio.binLleno === 6 && sitio.apilados && sitio.anchoIgual, 'a 420 px Ubicación específica y Storage bin van apilados y la lista de bins crece al llenarse, obtuvo '+JSON.stringify({binVacio, ...sitio}));
    // Pendientes sin storage bin (Joel, B501 · 0098: "36/44" y la lista decía "3 bin / 4 SKU"):
    // la bodega tiene 30 pendientes y sus bins suman 8, así que 22 no tienen bin. Se dicen en el
    // resumen y en la ayuda; entran con "Seleccionar todos" y quedan fuera al elegir bins puntuales.
    const sinBinTodos = await page.evaluate(() => ({ resumen: document.getElementById('p-bin-resumen').textContent, hint: document.getElementById('p-bin-hint').textContent }));
    assert(sinBinTodos.resumen === '(2 bin / 8 SKU · 22 sin storage bin)' && sinBinTodos.hint.includes('también entran los 22 SKU sin storage bin'), 'con "Seleccionar todos" se dicen los pendientes sin bin, obtuvo '+JSON.stringify(sinBinTodos));
    await page.selectOption('#p-bin', 'A-01');
    const sinBinParcial = await page.textContent('#p-bin-resumen');
    assert(sinBinParcial === '(1 de 2 bin / 4 SKU · 22 sin storage bin quedan fuera)', 'al elegir bins puntuales se avisa que los sin bin quedan fuera, obtuvo '+sinBinParcial);
    await page.check('#p-bin-todos');
    const sinBinDeNuevo = await page.textContent('#p-bin-resumen');
    assert(sinBinDeNuevo === '(2 bin / 8 SKU · 22 sin storage bin)', 'al volver a "Seleccionar todos" los sin bin vuelven a entrar, obtuvo '+sinBinDeNuevo);
    // Lista cortada en 1.000 filas (Joel, B521 "Todas": decía "1929 sin storage bin" y eran 147):
    // el número sale del conteo del servidor y, con todo elegido, el resumen da los totales reales
    // del sitio (2.500 pendientes − 147 sin bin), no lo que suman los bins que alcanzaron a llegar.
    await page.selectOption('#p-ubic', 'Pasillo 3');
    await page.waitForFunction(() => document.querySelectorAll('#p-bin option').length === 1000, null, { timeout:ESPERA });
    const cortada = await page.evaluate(() => ({ resumen: document.getElementById('p-bin-resumen').textContent, hint: document.getElementById('p-bin-hint').textContent }));
    assert(cortada.resumen === '(2.353 SKU con storage bin · 147 sin storage bin)' && cortada.hint.includes('también entran los 147 SKU sin storage bin') && cortada.hint.includes('primeros 1.000 storage bin (hay más)'), 'con la lista cortada, el resumen usa los totales reales y la ayuda lo dice, obtuvo '+JSON.stringify(cortada));
    await page.selectOption('#p-bin', ['B-0000', 'B-0001']);
    const cortadaParcial = await page.textContent('#p-bin-resumen');
    assert(cortadaParcial === '(2 de los primeros 1000 bin / 4 SKU · 147 sin storage bin quedan fuera)', 'con elección puntual en lista cortada, lo elegido es exacto, obtuvo '+cortadaParcial);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.tabbar .tab')].map(t => t.clientHeight));
    assert(tabs.length && Math.max(...tabs) === Math.min(...tabs) && Math.max(...tabs) < 60, 'cada pestaña de la barra de abajo en una sola línea (misma altura, sin partirse), obtuvo '+JSON.stringify(tabs));
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desborde <= 0, 'a 420 px Planificación no desborda, obtuvo '+desborde);
    await context.close();
  }

  // ===== Contar: marcar la foto con rayas y flechas antes de guardarla (Joel, 30/09) =====
  // Con el navegador real: se adjunta una foto blanca, "Marcar" abre el editor, se dibuja un trazo
  // con el mouse y una flecha, y al tocar Listo la foto de la entrada queda reemplazada por un JPEG
  // con el dibujo aplanado (píxel rojo donde pasó el trazo, blanco donde no), la miniatura dice
  // "Marcada" y los trazos siguen editables (deshacer). A 420 px el editor no desborda.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('editor-foto: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.evaluate(() => setState({ view:'conteo', skuSeleccionado:{ id:'sku-ef-1', sku_code:'EF-001', descripcion:'Filtro de prueba', bodega:'Nave', ubicacion:'Pasillo 1', storage_bin:'A-01', stock_sistema:3, unidad_medida:'UN' } }));
    await page.waitForSelector('#c-foto', { timeout:ESPERA });
    // Foto blanca de 320x240 generada en la propia página (PNG sin comprimir, ~KB), como archivo.
    const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 320; c.height = 240; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0,0,320,240); return c.toDataURL('image/png'); });
    await page.setInputFiles('#c-foto', { name:'cajon.png', mimeType:'image/png', buffer: Buffer.from(png.split(',')[1], 'base64') });
    await page.waitForSelector('[data-marcar-foto="0"]', { timeout:ESPERA });
    // Regresión (10/10/2026): abrir el editor borraba la cantidad y la observación ya escritas.
    await page.fill('#c-cant', '13'); await page.fill('#c-obs', 'caja abierta');
    const camposConteo = () => page.evaluate(() => [document.getElementById('c-cant').value, document.getElementById('c-obs').value].join('|'));
    await page.click('[data-marcar-foto="0"]');
    await page.waitForSelector('#editor-foto-canvas', { timeout:ESPERA });
    const camposConEditor = await camposConteo();
    assert(camposConEditor === '13|caja abierta', 'abrir el editor de la foto no debe borrar la cantidad ni la observación, obtuvo '+camposConEditor);
    await page.waitForFunction(() => document.getElementById('editor-foto-canvas').width === 320, null, { timeout:ESPERA });
    const caja = await page.locator('#editor-foto-canvas').boundingBox();
    // Trazo horizontal por el centro (de 20% a 80% del ancho, a media altura).
    await page.mouse.move(caja.x + caja.width*0.2, caja.y + caja.height*0.5);
    await page.mouse.down();
    await page.mouse.move(caja.x + caja.width*0.5, caja.y + caja.height*0.5, { steps:5 });
    await page.mouse.move(caja.x + caja.width*0.8, caja.y + caja.height*0.5, { steps:5 });
    await page.mouse.up();
    await page.click('#editor-foto-flecha');
    await page.waitForSelector('#editor-foto-flecha.activa', { timeout:ESPERA });
    const caja2 = await page.locator('#editor-foto-canvas').boundingBox();
    await page.mouse.move(caja2.x + caja2.width*0.2, caja2.y + caja2.height*0.15);
    await page.mouse.down();
    await page.mouse.move(caja2.x + caja2.width*0.6, caja2.y + caja2.height*0.3, { steps:5 });
    await page.mouse.up();
    const trazos = await page.evaluate(() => state.editorFoto.trazos.map(t => t.tipo));
    assert(JSON.stringify(trazos)==='["trazo","flecha"]', 'debe registrar un trazo y una flecha, obtuvo '+JSON.stringify(trazos));
    const desbordeEditor = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeEditor <= 0, 'a 420 px el editor no desborda, obtuvo '+desbordeEditor);
    await page.click('#editor-foto-listo');
    await page.waitForFunction(() => !state.editorFoto && state.conteoFotos[0] && state.conteoFotos[0].trazos && state.conteoFotos[0].trazos.length === 2, null, { timeout:ESPERA });
    const camposTrasListo = await camposConteo();
    assert(camposTrasListo === '13|caja abierta', 'tras marcar la foto la cantidad y la observación siguen ahí, obtuvo '+camposTrasListo);
    const resultado = await page.evaluate(async () => {
      const f = state.conteoFotos[0];
      const img = new Image(); img.src = f.preview; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const px = (fx, fy) => Array.from(x.getImageData(Math.round(c.width*fx), Math.round(c.height*fy), 1, 1).data).slice(0,3);
      return { ancho: c.width, alto: c.height, tipo: f.file.type, nombre: f.file.name, tieneBase: !!f.base, centro: px(0.5, 0.5), esquina: px(0.05, 0.95), marcada: document.querySelector('.foto-preview-marcada') !== null };
    });
    assert(resultado.ancho===320 && resultado.alto===240 && resultado.tipo==='image/jpeg' && resultado.nombre==='cajon.jpg' && resultado.tieneBase && resultado.marcada, 'la foto marcada debe ser un JPEG del mismo tamaño, con la base guardada y la miniatura marcada, obtuvo '+JSON.stringify(resultado));
    assert(resultado.centro[0] > 180 && resultado.centro[1] < 90 && resultado.centro[2] < 90, 'donde pasó el trazo el píxel debe ser rojo, obtuvo '+JSON.stringify(resultado.centro));
    assert(resultado.esquina.every(v => v > 230), 'donde no se dibujó la foto sigue blanca, obtuvo '+JSON.stringify(resultado.esquina));
    // Volver a abrir: los trazos siguen ahí y Deshacer quita el último; Listo con uno solo.
    await page.click('[data-marcar-foto="0"]');
    await page.waitForSelector('#editor-foto-deshacer:not([disabled])', { timeout:ESPERA });
    await page.click('#editor-foto-deshacer');
    await page.waitForFunction(() => state.editorFoto && state.editorFoto.trazos.length === 1, null, { timeout:ESPERA });
    await page.click('#editor-foto-listo');
    await page.waitForFunction(() => !state.editorFoto && state.conteoFotos[0].trazos.length === 1, null, { timeout:ESPERA });
    await context.close();
  }

  // ===== Landing: honeypot silencioso (bot) no debe llamar a la red =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-honeypot: '+err.message));
    await bloquearSentry(page);
    let llamoRed = false;
    await page.route('**/rest/v1/leads_demo', route => { llamoRed = true; route.abort(); });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    await page.click('[data-abrir-demo]');
    await page.fill('#demo-nombre', 'Bot');
    await page.fill('#demo-email', 'bot@example.com');
    await page.fill('#demo-telefono', '+56911112222');
    await page.fill('#demo-web', 'http://spam.example'); // campo trampa
    await page.click('#demo-submit-btn');
    await page.waitForTimeout(300);
    assert(!llamoRed, 'el honeypot lleno no debe disparar ninguna llamada a la red');
    assert(await page.isVisible('#demo-modal-ok.open'), 'aun así debe mostrarse la pantalla de éxito (para no delatar la protección)');
    await context.close();
  }

  // ===== Landing: un teléfono sin número no se envía (bug real: llegó un lead con "+") =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-telefono: '+err.message));
    await bloquearSentry(page);
    let llamoRed = false;
    await page.route('**/rest/v1/leads_demo', route => { llamoRed = true; route.abort(); });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    await page.click('[data-abrir-demo]');
    await page.fill('#demo-nombre', 'Fabiola');
    await page.fill('#demo-email', 'fabiola@example.com');
    await page.fill('#demo-telefono', '+');
    await page.waitForTimeout(2100); // pasar el umbral anti-bot de 2 s
    await page.click('#demo-submit-btn');
    await page.waitForTimeout(300);
    assert(!llamoRed, 'con un teléfono sin dígitos no debe guardarse el lead');
    assert(await page.isVisible('#demo-error') && (await page.textContent('#demo-error')).includes('teléfono'), 'debe explicar que falta un teléfono válido');
    assert(!(await page.isVisible('#demo-modal-ok.open')), 'no debe mostrar la pantalla de éxito');
    await context.close();
  }

  // ===== Landing: un envío humano normal sí llama a la red y muestra las credenciales =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-demo: '+err.message));
    await bloquearSentry(page);
    let cuerpoEnviado = null;
    await page.route('**/rest/v1/leads_demo', route => {
      cuerpoEnviado = route.request().postDataJSON();
      route.fulfill({ status:201, body:'' });
    });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    await page.click('[data-abrir-demo]');
    await page.fill('#demo-nombre', 'Persona Real');
    await page.fill('#demo-email', 'real@example.com');
    await page.fill('#demo-telefono', '+56911114444');
    await page.waitForTimeout(2200); // pasa el chequeo anti-bot de "no fue instantáneo"
    await page.click('#demo-submit-btn');
    await page.waitForTimeout(300);
    assert(!!cuerpoEnviado && cuerpoEnviado[0].email==='real@example.com', 'un envío humano normal debe llegar a Supabase con los datos correctos, obtuvo: '+JSON.stringify(cuerpoEnviado));
    assert(await page.isVisible('text=demo@inventiapp.cl'), 'debe mostrar las credenciales de la demo tras el envío exitoso');
    await context.close();
  }

  // ===== Landing: el lead guarda de dónde vino (12/10/2026) =====
  // Primera visita desde un post de LinkedIn con enlace etiquetado; vuelve otro día escribiendo la
  // dirección y pide la demo: "primero" dice LinkedIn con su campaña, "visita" dice directo. Y si
  // la base rechazara el origen, el lead igual llega (se reenvía sin él): no se pierde un contacto.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-origen: '+err.message));
    await bloquearSentry(page);
    const cuerpos = [];
    let rechazarOrigen = false;
    await page.route('**/rest/v1/leads_demo', route => {
      const cuerpo = route.request().postDataJSON();
      cuerpos.push(cuerpo);
      if (rechazarOrigen && 'origen' in cuerpo[0]) return route.fulfill({ status:400, contentType:'application/json', body: JSON.stringify({ code:'PGRST204', message:"Could not find the 'origen' column of 'leads_demo' in the schema cache" }) });
      route.fulfill({ status:201, body:'' });
    });
    const pedirDemo = async () => {
      await page.click('[data-abrir-demo]');
      await page.fill('#demo-nombre', 'Persona Origen');
      await page.fill('#demo-email', 'origen@example.com');
      await page.fill('#demo-telefono', '+56911115555');
      await page.waitForTimeout(2200);
      await page.click('#demo-submit-btn');
      await page.waitForTimeout(400);
    };
    // 1) Llega desde LinkedIn con utm_* y navega a otra página del sitio.
    await page.goto(`http://localhost:${PORT}/inventario.html?utm_source=linkedin&utm_medium=social&utm_campaign=serie-videos&utm_content=video-01`, { waitUntil:'networkidle' });
    await page.goto(`http://localhost:${PORT}/bodega.html`, { waitUntil:'networkidle', referer:`http://localhost:${PORT}/inventario.html` });
    await pedirDemo();
    const o1 = cuerpos[0] && cuerpos[0][0].origen;
    assert(o1 && o1.primero.fuente==='linkedin' && o1.primero.medio==='social' && o1.primero.campana==='serie-videos' && o1.primero.contenido==='video-01' && o1.primero.pagina==='/inventario.html'
      && o1.visita.fuente==='linkedin' && o1.visita.campana==='serie-videos', 'la visita etiquetada queda como primera y como visita actual, aunque pase por otra página del sitio, obtuvo: '+JSON.stringify(o1));
    // 2) Otro día (sesión nueva, mismo navegador) vuelve escribiendo la dirección.
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    await pedirDemo();
    const o2 = cuerpos[1] && cuerpos[1][0].origen;
    assert(o2 && o2.primero.fuente==='linkedin' && o2.visita.fuente==='directo' && o2.visita.medio==='none', 'al volver directo, la primera visita sigue siendo LinkedIn y la del pedido es directa, obtuvo: '+JSON.stringify(o2));
    // 3) Un anuncio de Google Ads (gclid, sin utm) se reconoce como tal.
    await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
    await page.goto(`http://localhost:${PORT}/inventario.html?gclid=abc123`, { waitUntil:'networkidle' });
    await pedirDemo();
    const o3 = cuerpos[2] && cuerpos[2][0].origen;
    assert(o3 && o3.visita.fuente==='google' && o3.visita.medio==='cpc', 'gclid sin utm es Google Ads, obtuvo: '+JSON.stringify(o3));
    // 3b) Meta agrega fbclid en Facebook y en Instagram: con referente de Instagram es Instagram;
    // sin referente (navegador de la app en iPhone) no se adivina: "meta" = Facebook o Instagram.
    await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
    await page.goto(`http://localhost:${PORT}/inventario.html?fbclid=IwAR123`, { waitUntil:'networkidle', referer:'https://l.instagram.com/' });
    await pedirDemo();
    const o3b = cuerpos[cuerpos.length-1][0].origen;
    assert(o3b && o3b.visita.fuente==='instagram' && o3b.visita.medio==='social', 'fbclid con referente de Instagram es Instagram, obtuvo: '+JSON.stringify(o3b));
    await page.evaluate(() => { sessionStorage.clear(); localStorage.clear(); });
    await page.goto(`http://localhost:${PORT}/inventario.html?fbclid=IwAR456`, { waitUntil:'networkidle' });
    await pedirDemo();
    const o3c = cuerpos[cuerpos.length-1][0].origen;
    assert(o3c && o3c.visita.fuente==='meta', 'fbclid sin referente no se atribuye a Facebook: queda como "meta" (Facebook o Instagram), obtuvo: '+JSON.stringify(o3c));
    // 4) Si la base rechaza el origen, se reenvía sin él y la persona igual entra a la demo.
    rechazarOrigen = true;
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    const antes = cuerpos.length;
    await pedirDemo();
    const reintento = cuerpos.slice(antes);
    assert(reintento.length===2 && 'origen' in reintento[0][0] && !('origen' in reintento[1][0]) && reintento[1][0].email==='origen@example.com', 'si la base rechaza el origen, se reenvía una vez sin él, obtuvo: '+JSON.stringify(reintento));
    assert(await page.isVisible('text=demo@inventiapp.cl'), 'tras el reenvío sin origen igual debe mostrar las credenciales de la demo');
    await context.close();
  }

  // ===== Landing Inventario (destino de Google Ads): el botón de la portada abre la demo y
  // el formulario dice para qué se pide el teléfono, a 420 px =====
  {
    const context = await browser.newContext({ viewport:{ width:420, height:860 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-inventario: '+err.message));
    await bloquearSentry(page);
    await page.goto(`http://localhost:${PORT}/inventario.html`, { waitUntil:'networkidle' });
    const cta = page.locator('.hero .cta');
    assert((await cta.textContent()).includes('Probar la demo gratis'), 'el botón de la portada de Inventario debe decir "Probar la demo gratis"');
    const caja = await cta.boundingBox();
    assert(caja && caja.y + caja.height <= 860, 'a 420 px el botón de la demo debe verse sin bajar, quedó en y='+(caja && caja.y));
    await cta.click();
    assert(await page.isVisible('#demo-modal-backdrop.open'), 'el botón de la portada debe abrir el formulario de demo');
    assert((await page.textContent('label[for="demo-telefono"]')).includes('si pides un piloto'), 'el teléfono debe explicar para qué se pide');
    assert((await page.textContent('#demo-submit-btn')).trim() === 'Entrar a la demo', 'el botón del formulario debe decir "Entrar a la demo"');
    await context.close();
  }

  // ===== Landing: formulario de contacto — honeypot silencioso no debe llamar a la red =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-contacto-honeypot: '+err.message));
    await bloquearSentry(page);
    let llamoRed = false;
    await page.route('**/rest/v1/leads_demo', route => { llamoRed = true; route.abort(); });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    await page.click('[data-abrir-contacto]');
    await page.fill('#contacto-nombre', 'Bot');
    await page.fill('#contacto-email', 'bot@example.com');
    await page.fill('#contacto-mensaje', 'mensaje de prueba');
    await page.fill('#contacto-web', 'http://spam.example'); // campo trampa
    await page.click('#contacto-submit-btn');
    await page.waitForTimeout(300);
    assert(!llamoRed, 'el honeypot lleno en el formulario de contacto no debe disparar ninguna llamada a la red');
    assert(await page.isVisible('#contacto-modal-ok.open'), 'aun así debe mostrarse la pantalla de éxito (para no delatar la protección)');
    await context.close();
  }

  // ===== Landing: formulario de contacto — un envío humano normal sí llama a la red =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-contacto: '+err.message));
    await bloquearSentry(page);
    let cuerpoEnviado = null;
    await page.route('**/rest/v1/leads_demo', route => {
      cuerpoEnviado = route.request().postDataJSON();
      route.fulfill({ status:201, body:'' });
    });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    await page.click('[data-abrir-contacto]');
    await page.fill('#contacto-nombre', 'Persona Real');
    await page.fill('#contacto-email', 'contacto@example.com');
    await page.fill('#contacto-mensaje', 'Quiero cotizar el plan Profesional');
    await page.waitForTimeout(2200); // pasa el chequeo anti-bot de "no fue instantáneo"
    await page.click('#contacto-submit-btn');
    await page.waitForTimeout(300);
    assert(!!cuerpoEnviado && cuerpoEnviado[0].tipo==='contacto' && cuerpoEnviado[0].mensaje==='Quiero cotizar el plan Profesional', 'un envío humano normal debe llegar a Supabase con tipo=contacto y el mensaje correcto, obtuvo: '+JSON.stringify(cuerpoEnviado));
    assert(await page.isVisible('#contacto-modal-ok.open'), 'debe mostrar la pantalla de éxito tras el envío');
    await context.close();
  }

  // ===== Landing: los botones de precios abren el formulario de contacto con el mensaje puesto =====
  // Antes eran enlaces mailto: dependían del correo del visitante y no dejaban registro ni aviso.
  // Ahora abren el mismo modal "Escríbenos" con el mensaje prellenado, y el envío llega con
  // tipo=contacto igual que el enlace del pie.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-contacto-precios: '+err.message));
    await bloquearSentry(page);
    let cuerpoEnviado = null;
    await page.route('**/rest/v1/leads_demo', route => { cuerpoEnviado = route.request().postDataJSON(); route.fulfill({ status:201, body:'' }); });
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    assert((await page.locator('a[href^="mailto:"]').count()) === 0, 'la página principal ya no debe tener enlaces mailto');
    await page.click('[data-track-mailto="piloto_empresa"]');
    await page.waitForSelector('#contacto-modal-backdrop.open', { timeout:ESPERA });
    const mensajePrellenado = await page.inputValue('#contacto-mensaje');
    assert(mensajePrellenado === 'Quiero solicitar un piloto de InventIA con mi bodega.', '"Solicitar piloto" abre el formulario de contacto con el mensaje puesto, obtuvo '+mensajePrellenado);
    await page.fill('#contacto-nombre', 'Persona Real');
    await page.fill('#contacto-email', 'piloto@example.com');
    await page.fill('#contacto-empresa', 'Minera Ejemplo');
    await page.waitForTimeout(2200);
    await page.click('#contacto-submit-btn');
    await page.waitForTimeout(300);
    assert(!!cuerpoEnviado && cuerpoEnviado[0].tipo==='contacto' && cuerpoEnviado[0].mensaje==='Quiero solicitar un piloto de InventIA con mi bodega.' && cuerpoEnviado[0].empresa==='Minera Ejemplo', 'el envío desde precios llega como contacto con el mensaje prellenado, obtuvo '+JSON.stringify(cuerpoEnviado));
    await context.close();
  }

  // ===== Landing: qué compras, qué pruebas ahora y qué se coordina (revisión del 06/10) =====
  // Planes decía "Inventario o Bodega" con funciones solo de conteo; Bodega solo ofrecía "Pedir
  // una demostración" (un formulario de contacto titulado "Escríbenos") aunque la demo pública ya
  // tiene el módulo activado; y el cierre de Inventario prometía "tu propia bodega" llevando a la
  // demo de ejemplo. Ahora cada plan muestra sus funciones por módulo, las tres páginas abren la
  // misma demo con el mismo nombre, y "Solicitar piloto con mis datos" abre el contacto con su
  // propio título.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-modulos: '+err.message));
    await bloquearSentry(page);
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    const planes = await page.evaluate(() => [...document.querySelectorAll('.price-card')].map(c => ({
      modulos: [...c.querySelectorAll('.price-modulos .t')].map(t => t.textContent.trim()),
      bodega: /Despacho|Órdenes, recepciones/.test(c.textContent),
      ambos: !!c.querySelector('.price-ambos [data-abrir-contacto]'),
    })));
    assert(planes.length === 3 && planes[0].modulos.join('|') === 'Con Inventario|Con Bodega' && planes[1].modulos.join('|') === 'Con Inventario|Con Bodega', 'Básico y Profesional deben listar sus funciones por módulo, obtuvo '+JSON.stringify(planes));
    assert(planes[0].bodega && planes[1].bodega && planes[0].ambos && planes[1].ambos, 'cada plan debe nombrar funciones de Bodega y ofrecer "los dos módulos" dentro de la tarjeta, obtuvo '+JSON.stringify(planes));
    const demoBotones = await page.evaluate(() => [...document.querySelectorAll('[data-abrir-demo]')].map(b => b.textContent.trim()));
    assert(demoBotones.every(t => /Probar la demo|prueba la demo/i.test(t)), 'todos los botones de demo de la portada deben llamarse "Probar la demo", obtuvo '+JSON.stringify(demoBotones));
    assert((await page.locator('.closing-acciones [data-abrir-demo]').count()) === 1 && (await page.locator('.closing-acciones [data-abrir-contacto][data-titulo]').count()) === 1, 'el cierre de la portada ofrece la demo y el piloto por separado');
    assert(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)), 'la portada no debe desbordar a lo ancho en celular con las columnas por módulo');

    // Bodega: la demo directa y el piloto con su propio título en el formulario de contacto.
    await page.goto(`http://localhost:${PORT}/bodega.html`, { waitUntil:'networkidle' });
    assert((await page.locator('.hero [data-abrir-demo]').count()) === 1, 'la portada de Bodega debe abrir la demo directamente');
    await page.click('.closing-acciones [data-abrir-contacto]');
    await page.waitForSelector('#contacto-modal-backdrop.open', { timeout:ESPERA });
    assert((await page.textContent('#contacto-titulo')).trim() === 'Solicitar piloto con mis datos', 'el formulario abierto desde "Solicitar piloto" lleva ese título, obtuvo '+(await page.textContent('#contacto-titulo')));
    assert(/24 horas/.test(await page.textContent('#contacto-sub')), 'el subtítulo dice qué pasa después del envío');
    assert(/módulo Bodega/.test(await page.inputValue('#contacto-mensaje')), 'el mensaje viene prellenado para Bodega');
    await page.click('#contacto-modal-close');
    await page.click('.nav-links [data-abrir-contacto]').catch(() => {});
    if (await page.isVisible('#contacto-modal-backdrop.open')) {
      assert((await page.textContent('#contacto-titulo')).trim() === 'Escríbenos', 'el enlace Contacto del menú vuelve al título genérico, obtuvo '+(await page.textContent('#contacto-titulo')));
    }

    // Inventario: el cierre ya no promete "tu propia bodega" en el botón de la demo, y los
    // controles del carrusel miden lo que se puede tocar con el dedo.
    await page.goto(`http://localhost:${PORT}/inventario.html`, { waitUntil:'networkidle' });
    const cierre = await page.evaluate(() => ({
      titulo: document.querySelector('.closing h2').textContent.trim(),
      demo: !!document.querySelector('.closing-acciones [data-abrir-demo]'),
      piloto: !!document.querySelector('.closing-acciones [data-abrir-contacto][data-titulo]'),
      flecha: document.querySelector('#vista-prev').getBoundingClientRect().height,
      punto: document.querySelector('#vista-dots .carousel-dot').getBoundingClientRect().height,
    }));
    assert(!/propia bodega/.test(cierre.titulo) && cierre.demo && cierre.piloto, 'el cierre de Inventario separa la demo del piloto, obtuvo '+JSON.stringify(cierre));
    assert(cierre.flecha >= 44 && cierre.punto >= 44, 'las flechas y los puntos del carrusel deben medir al menos 44 px, obtuvo '+JSON.stringify(cierre));
    await context.close();
  }

  // ===== Landing: el acordeón de preguntas frecuentes abre con un click real =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-faq: '+err.message));
    await bloquearSentry(page);
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    const primeraPregunta = await page.$('.faq-item summary');
    assert(primeraPregunta !== null, 'debe existir al menos una pregunta frecuente');
    const detalleAbierto = await page.evaluate(() => document.querySelector('.faq-item').open);
    assert(detalleAbierto === false, 'la pregunta debe empezar cerrada');
    await primeraPregunta.click();
    const detalleTrasClick = await page.evaluate(() => document.querySelector('.faq-item').open);
    assert(detalleTrasClick === true, 'un click en la pregunta debe abrirla');
    await context.close();
  }

  // ===== Landing: las tres páginas del sitio público =====
  // Desde que el sitio se separó en portada + bodega.html + inventario.html, lo compartido
  // (estilos, menú, los dos formularios de captación y su envío) vive en assets/. Si un archivo
  // no carga o el JS se cae, las páginas se ven pero dejan de captar: por eso se comprueba en
  // las tres que el CSS aplicó, que los modales existen y que no hay errores de JavaScript.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const erroresJs = [];
    page.on('pageerror', err => erroresJs.push(err.message));
    await bloquearSentry(page);

    for(const archivo of ['index.html','bodega.html','inventario.html']){
      erroresJs.length = 0;
      await page.goto(`http://localhost:${PORT}/${archivo}`, { waitUntil:'networkidle' });
      // El sello del pie carga perezoso (loading="lazy"): hay que llegar hasta el pie, como un
      // visitante, para que el navegador lo pida; si no, mide 0×0 aunque el archivo esté bien.
      await page.evaluate(() => document.querySelector('footer')?.scrollIntoView());
      await page.waitForFunction(() => {
        const img = document.querySelector('footer .footer-star img');
        return !img || (img.complete && img.naturalWidth > 0);
      }, null, { timeout: 5000 }).catch(() => {});
      const estado = await page.evaluate(() => ({
        fondo: getComputedStyle(document.body).backgroundColor,
        modales: !!document.getElementById('demo-modal-backdrop') && !!document.getElementById('contacto-modal-backdrop'),
        whatsapp: !!document.getElementById('whatsapp-float-link'),
        nav: [...document.querySelectorAll('.nav-links a')].map(a => a.getAttribute('href')),
        star: [...document.querySelectorAll('footer a')].some(a => a.getAttribute('href') === 'https://cloudsecurityalliance.org/star/registry/inventia' && a.getAttribute('rel') === 'noopener noreferrer'),
        sello: (() => {
          const img = document.querySelector('footer a[href="https://cloudsecurityalliance.org/star/registry/inventia"][rel="noopener noreferrer"] img');
          if (!img) return null;
          const r = img.getBoundingClientRect();
          return { alt: img.getAttribute('alt') || '', cargado: img.complete && img.naturalWidth, natural: [img.naturalWidth, img.naturalHeight], visible: r.width > 40 && r.height > 40 && Math.abs(r.width - r.height) < 1 };
        })(),
        inicio: [...document.querySelectorAll('.nav-links a')].some(a => a.getAttribute('href') === 'index.html' && /inicio/i.test(a.textContent)),
        actual: [...document.querySelectorAll('.nav-links a[aria-current="page"]')].map(a => a.getAttribute('href')),
        desbordeH: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }));
      assert(estado.fondo === 'rgb(242, 243, 245)', `${archivo}: assets/comun.css no aplicó, el fondo quedó en ${estado.fondo}`);
      assert(estado.modales, `${archivo}: assets/comun.js no inyectó los modales de demo y contacto`);
      assert(estado.whatsapp, `${archivo}: falta el botón flotante de WhatsApp`);
      assert(estado.nav.includes('bodega.html') && estado.nav.includes('inventario.html'),
        `${archivo}: el menú debe enlazar a las dos páginas de módulo, obtuvo ${JSON.stringify(estado.nav)}`);
      // Desde una página de módulo, la única vuelta a la portada era el logo. Con tres páginas
      // el menú tiene que ofrecerla como tal, y decir en cuál está parado el visitante.
      assert(estado.inicio, `${archivo}: el menú debe ofrecer "Inicio" hacia index.html, obtuvo ${JSON.stringify(estado.nav)}`);
      // El registro CSA STAR es la prueba pública de seguridad que se le muestra a un comprador:
      // tiene que estar en el pie de las tres páginas (el pie vive repetido en cada archivo, y es
      // exactamente lo que se olvida al agregar una página nueva), con rel="noopener noreferrer"
      // porque abre en otra pestaña hacia un dominio ajeno.
      assert(estado.star, `${archivo}: el pie debe enlazar al registro CSA STAR con rel="noopener noreferrer"`);
      // El sello STAR Level One es marca de la CSA y sus condiciones de uso son dos: usarlo sin
      // modificar y enlazado a la entrada del registro. La imagen tiene que cargar de verdad
      // (un src roto pasa desapercibido en un pie), mantener el archivo original de 800×800 y
      // verse cuadrada, dentro del mismo enlace que el texto.
      assert(estado.sello, `${archivo}: el sello STAR debe ir como imagen dentro del enlace al registro`);
      if (estado.sello) {
        assert(estado.sello.cargado, `${archivo}: la imagen del sello STAR no cargó (¿falta img/csa-star-level-one.png?)`);
        assert(estado.sello.natural[0] === 800 && estado.sello.natural[1] === 800,
          `${archivo}: el sello STAR debe ser el archivo original de 800×800, obtuvo ${estado.sello.natural.join('×')}`);
        assert(estado.sello.visible, `${archivo}: el sello STAR debe verse cuadrado y de tamaño legible`);
        assert(/STAR/.test(estado.sello.alt) && /Cloud Security Alliance/.test(estado.sello.alt),
          `${archivo}: el alt del sello debe decir qué es y de quién, obtuvo "${estado.sello.alt}"`);
      }
      assert(estado.actual.length === 1 && estado.actual[0] === archivo,
        `${archivo}: el menú debe marcar la página actual con aria-current, obtuvo ${JSON.stringify(estado.actual)}`);
      assert(!estado.desbordeH, `${archivo}: la página no debe tener barra horizontal`);
      assert(erroresJs.length === 0, `${archivo}: sin errores de JavaScript, obtuvo: ${erroresJs.join(' | ')}`);
    }
    await context.close();
  }

  // ===== Landing: los enlaces viejos con ancla siguen llegando a destino =====
  // El sitio era una sola página; cualquier enlace ya enviado a /#bodega o /#inventario tiene
  // que terminar en la página nueva y no en una portada que ignora el ancla.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-anclas: '+err.message));
    await bloquearSentry(page);
    for(const [ancla, destino] of [['#bodega','bodega.html'], ['#inventario','inventario.html'], ['#resuelve','inventario.html'], ['#funciona','inventario.html']]){
      await page.goto(`http://localhost:${PORT}/index.html${ancla}`, { waitUntil:'networkidle' });
      await page.waitForTimeout(250);
      assert(page.url().endsWith(destino), `/index.html${ancla} debe terminar en ${destino}, terminó en ${page.url()}`);
    }
    // y dentro de su propia página, el ancla no debe redirigir en círculo
    await page.goto(`http://localhost:${PORT}/bodega.html#bodega`, { waitUntil:'networkidle' });
    await page.waitForTimeout(250);
    assert(page.url().endsWith('bodega.html#bodega'), 'el ancla propia de la página no debe redirigir, quedó en '+page.url());
    await context.close();
  }

  // ===== Landing: el formulario avisa la conversión =====
  // De este evento cuelga toda la medición de la publicidad: si deja de mandarse, Google Ads
  // sigue cobrando clics y deja de poder decir cuáles sirvieron, sin que nada se vea roto en
  // la pantalla. El formulario puede guardar perfecto y el evento no salir: pasó de verdad.
  // Se comprueba leyendo dataLayer, que es donde gtag empuja, porque assets/analitica.js
  // redefine window.gtag al cargar y un espía puesto antes queda pisado.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-conversion: '+err.message));
    await bloquearSentry(page);
    // El alta responde como PostgREST con Prefer: return=minimal: 201 y cuerpo vacío.
    await page.route('**/rest/v1/leads_demo**', r => r.fulfill({ status:201, body:'', headers:{'Content-Type':'application/json'} }));

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(600);
    await page.click('[data-abrir-demo]');
    // El antispam descarta lo enviado en menos de 2 s, así que hay que esperarlos de verdad.
    await page.waitForTimeout(2400);
    await page.fill('#demo-nombre', 'Prueba e2e');
    await page.fill('#demo-email', 'prueba@example.com');
    await page.fill('#demo-telefono', '+56 9 1234 5678');
    await page.fill('#demo-empresa', 'Minera de prueba');
    await page.click('#demo-submit-btn');
    await page.waitForSelector('#demo-modal-ok.open', { timeout: ESPERA });

    const r = await page.evaluate(() => {
      const capas = (window.dataLayer || []).map(a => Array.from(a));
      const eventos = capas.filter(a => a[0] === 'event');
      const lead = eventos.filter(a => a[1] === 'generate_lead');
      return {
        nombres: eventos.map(a => a[1]),
        veces: lead.length,
        tipo: lead.length ? (lead[0][2] || {}).lead_type : null,
        error: (document.getElementById('demo-error') || {}).textContent || ''
      };
    });

    assert(r.veces === 1, `el envío correcto debe mandar generate_lead exactamente una vez, mandó ${r.veces}. Eventos: ${JSON.stringify(r.nombres)}`);
    assert(r.tipo === 'demo', `generate_lead debe traer lead_type para distinguir demo de contacto, trajo ${JSON.stringify(r.tipo)}`);
    assert(r.nombres.includes('demo_modal_open'), `también debe registrarse la apertura, para poder comparar aperturas contra envíos. Eventos: ${JSON.stringify(r.nombres)}`);
    assert(!r.error, `el envío correcto no debe mostrar error, mostró: ${r.error}`);
    await context.close();
  }

  // ===== Landing: lo que el buscador lee =====
  // Los datos estructurados de preguntas frecuentes solo sirven si dicen exactamente lo mismo
  // que la página muestra: si se editan las preguntas y el JSON-LD queda atrás, Google trata la
  // diferencia como marcado engañoso y puede sacar el sitio de los resultados enriquecidos. No
  // hay forma de notarlo mirando la página, así que lo revisa esta prueba.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-seo: '+err.message));
    await bloquearSentry(page);

    for(const archivo of ['index.html','bodega.html','inventario.html']){
      await page.goto(`http://localhost:${PORT}/${archivo}`, { waitUntil:'domcontentloaded' });
      const d = await page.evaluate(() => {
        const bloques = [...document.querySelectorAll('script[type="application/ld+json"]')];
        const datos = [];
        const rotos = [];
        bloques.forEach(function(b, i){
          try { datos.push(JSON.parse(b.textContent)); } catch(e){ rotos.push(i + ': ' + e.message); }
        });
        const meta = function(sel){ const e = document.querySelector(sel); return e ? e.getAttribute('content') : null; };
        const canon = document.querySelector('link[rel="canonical"]');
        return {
          titulo: document.title,
          descripcion: meta('meta[name="description"]'),
          ogTitulo: meta('meta[property="og:title"]'),
          canonica: canon ? canon.getAttribute('href') : null,
          h1: document.querySelectorAll('h1').length,
          rotos: rotos,
          datos: datos,
          visibles: [...document.querySelectorAll('.faq-item summary')].map(e => e.textContent.replace(/\s+/g,' ').trim())
        };
      });

      assert(d.rotos.length === 0, `${archivo}: hay datos estructurados que no son JSON válido: ${d.rotos.join(' | ')}`);
      assert(d.titulo && d.titulo.length <= 65, `${archivo}: el título debe existir y no pasar de 65 caracteres (Google lo corta), tiene ${d.titulo.length}: "${d.titulo}"`);
      assert(d.descripcion && d.descripcion.length >= 70 && d.descripcion.length <= 165,
        `${archivo}: la meta descripción debe medir entre 70 y 165 caracteres, tiene ${d.descripcion ? d.descripcion.length : 0}`);
      assert(d.ogTitulo === d.titulo, `${archivo}: og:title debe decir lo mismo que el título, dice "${d.ogTitulo}"`);
      assert(d.canonica === `https://inventiapp.cl/${archivo}` || d.canonica === 'https://inventiapp.cl/',
        `${archivo}: falta la canónica o apunta a otra página, apunta a ${d.canonica}`);
      assert(d.h1 === 1, `${archivo}: debe tener exactamente un h1, tiene ${d.h1}`);

      const faq = d.datos.filter(x => x['@type'] === 'FAQPage');
      assert(faq.length === 1, `${archivo}: debe declarar exactamente un FAQPage, declara ${faq.length}`);
      if(faq.length === 1){
        const marcadas = (faq[0].mainEntity || []).map(q => (q.name||'').replace(/\s+/g,' ').trim());
        assert(marcadas.length === d.visibles.length,
          `${archivo}: el FAQPage declara ${marcadas.length} preguntas y la página muestra ${d.visibles.length}`);
        for(let i = 0; i < Math.min(marcadas.length, d.visibles.length); i++){
          assert(marcadas[i] === d.visibles[i],
            `${archivo}: la pregunta ${i+1} del FAQPage no coincide con la visible.\n    marcada: ${marcadas[i]}\n    visible: ${d.visibles[i]}`);
        }
        const sinRespuesta = (faq[0].mainEntity || []).filter(q => !(q.acceptedAnswer && q.acceptedAnswer.text)).length;
        assert(sinRespuesta === 0, `${archivo}: ${sinRespuesta} pregunta(s) del FAQPage no traen respuesta`);
      }
    }
    await context.close();
  }

  // ===== Landing: el sitemap no promete páginas que no existen =====
  {
    const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
    const urls = [...sitemap.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map(m => m[1]);
    assert(urls.length > 0, 'el sitemap no declara ninguna URL');
    for(const url of urls){
      const relativa = url.replace('https://inventiapp.cl/', '') || 'index.html';
      assert(fs.existsSync(path.join(ROOT, relativa)),
        `el sitemap declara ${url} pero ${relativa} no existe en el repo`);
    }
    for(const obligatoria of ['https://inventiapp.cl/', 'https://inventiapp.cl/bodega.html', 'https://inventiapp.cl/inventario.html']){
      assert(urls.includes(obligatoria), `el sitemap debe incluir ${obligatoria}`);
    }
    // Y al revés: una página pública nueva que nadie agregó al sitemap no se indexa. La excepción
    // es una página que pide explícitamente no indexarse (meta robots noindex, como la de destino
    // de la campaña de Ads): esa no debe ir en el sitemap, sería contradictorio.
    for(const publica of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))){
      const esperada = publica === 'index.html' ? 'https://inventiapp.cl/' : 'https://inventiapp.cl/' + publica;
      const html = fs.readFileSync(path.join(ROOT, publica), 'utf8');
      const noindex = /<meta\s+name="robots"\s+content="[^"]*noindex[^"]*"/i.test(html);
      if(noindex) assert(!urls.includes(esperada), `${publica} pide noindex y a la vez está en el sitemap: una de las dos sobra`);
      else assert(urls.includes(esperada), `${publica} es una página pública y no está en el sitemap: el buscador no la va a indexar`);
    }
  }

  // ===== Landing de la campaña de Ads (software-inventario.html) =====
  // Diagnóstico del 22/09: 28 sesiones pagadas, 0 aperturas del formulario, 19 s de lectura.
  // Esta página existe para que quien llega desde un anuncio vea qué es, cuánto cuesta y el
  // botón de demo sin scrollear, en celular y en escritorio. Lo que se comprueba es exactamente
  // eso, más lo que la haría fallar en silencio: que no se indexe (compite con inventario.html),
  // que use el mismo formulario de demo y avise su origen a Analytics, y que cargue sin errores.
  {
    for(const [ancho, alto] of [[420, 860], [1280, 800]]){
      const context = await browser.newContext({ viewport:{ width:ancho, height:alto } });
      const page = await context.newPage();
      const erroresJs = [];
      page.on('pageerror', e => erroresJs.push(e.message));
      await page.goto(`http://localhost:${PORT}/software-inventario.html`, { waitUntil:'networkidle' });
      const estado = await page.evaluate(() => {
        const cta = document.getElementById('cta-principal');
        const r = cta ? cta.getBoundingClientRect() : null;
        const foto = document.querySelector('.hero-shot img');
        return {
          fondo: getComputedStyle(document.body).backgroundColor,
          robots: (document.querySelector('meta[name="robots"]') || {}).content || '',
          modales: !!document.getElementById('demo-modal-backdrop') && !!document.getElementById('contacto-modal-backdrop'),
          whatsapp: !!document.getElementById('whatsapp-float-link'),
          ctaVisible: !!r && r.top >= 0 && r.bottom <= window.innerHeight && r.width > 100,
          precio: /\$160 USD/.test((document.querySelector('.hero-price') || {}).textContent || ''),
          fotoCargada: !!foto && foto.complete && foto.naturalWidth > 0,
          star: !!document.querySelector('footer a[href="https://cloudsecurityalliance.org/star/registry/inventia"][rel="noopener noreferrer"] img'),
          desbordeH: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });
      assert(estado.fondo === 'rgb(242, 243, 245)', `landing Ads ${ancho}px: assets/comun.css no aplicó`);
      assert(/noindex/.test(estado.robots), `landing Ads ${ancho}px: debe pedir noindex, obtuvo "${estado.robots}"`);
      assert(estado.modales && estado.whatsapp, `landing Ads ${ancho}px: assets/comun.js no inyectó los modales o el WhatsApp`);
      assert(estado.ctaVisible, `landing Ads ${ancho}px: el botón "Ver una demo" tiene que verse sin scrollear`);
      assert(estado.precio, `landing Ads ${ancho}px: el precio desde $160 USD tiene que estar en la primera pantalla`);
      assert(estado.fotoCargada, `landing Ads ${ancho}px: la captura de la app no cargó`);
      assert(estado.star, `landing Ads ${ancho}px: el pie debe llevar el sello STAR enlazado al registro`);
      assert(!estado.desbordeH, `landing Ads ${ancho}px: la página no debe tener barra horizontal`);
      // El botón abre el mismo formulario de demo del resto del sitio y avisa de dónde viene.
      await page.click('#cta-principal');
      await page.waitForTimeout(200);
      const modal = await page.evaluate(() => ({
        abierto: document.getElementById('demo-modal-backdrop').classList.contains('open'),
        aperturas: (window.dataLayer || []).filter(x => x[0] === 'event' && x[1] === 'demo_modal_open').map(x => x[2] && x[2].plan),
      }));
      assert(modal.abierto, `landing Ads ${ancho}px: el botón principal debe abrir el formulario de demo`);
      assert(modal.aperturas.length === 1 && modal.aperturas[0] === 'ads-inventario', `landing Ads ${ancho}px: la apertura debe llegar a Analytics con plan "ads-inventario", obtuvo ${JSON.stringify(modal.aperturas)}`);
      assert(erroresJs.length === 0, `landing Ads ${ancho}px: sin errores de JavaScript, obtuvo: ${erroresJs.join(' | ')}`);
      await context.close();
    }
  }

  // ===== Landing: las dos tarjetas del selector se ven sin scrollear =====
  // La regresión concreta: las tarjetas llevaban la clase .reveal, que las deja en opacity 0
  // hasta que el IntersectionObserver ve el 15% de ellas. Al compactar la portada quedaron
  // arriba del pliegue pero con solo un 9% dentro, así que el observador no disparaba: se veía
  // el título de la sección y debajo un hueco en blanco, peor que tenerlas más abajo. Son la
  // acción principal de la portada y tienen que estar visibles desde que la página carga.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-selector: '+err.message));
    await bloquearSentry(page);
    for(const [ancho, alto] of [[1280,800], [420,860]]){
      await page.setViewportSize({ width: ancho, height: alto });
      await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
      await page.waitForTimeout(400);   // sin scrollear: así la ve quien llega
      const tarjetas = await page.evaluate(() => Array.from(document.querySelectorAll('.path')).map(function(e){
        const r = e.getBoundingClientRect();
        return { destino:(e.getAttribute('href')||''), arriba:Math.round(r.top), opacidad:getComputedStyle(e).opacity };
      }));
      assert(tarjetas.length === 2, `la portada debe tener las dos tarjetas del selector, tiene ${tarjetas.length}`);
      // En celular las dos se apilan y la segunda no cabe: lo exigible es que la primera
      // asome, para que se entienda que hay que elegir, y que ninguna dependa del observador.
      assert(tarjetas[0].arriba < alto, `a ${ancho}px la primera tarjeta empieza en ${tarjetas[0].arriba}px, bajo el borde de ${alto}px`);
      for(const t of tarjetas){
        assert(t.opacidad === '1', `a ${ancho}px la tarjeta de ${t.destino} se ve a medias sin scrollear (opacidad ${t.opacidad})`);
      }
      const destinos = tarjetas.map(t => t.destino).sort().join(',');
      assert(destinos === 'bodega.html,inventario.html', `las tarjetas deben llevar a cada módulo, llevan a ${destinos}`);
    }
    await context.close();
  }

  // ===== Landing: ninguna captura sale deformada =====
  // La regresión concreta: un <img> con atributo height dentro de .phone-frame. El CSS fija
  // width:100% pero no el alto, así que el atributo se aplicaba como alto CSS y estiraba la
  // captura de Bodega a tres veces lo que le tocaba sin que nada fallara.
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-capturas: '+err.message));
    await bloquearSentry(page);

    for(const [archivo, esperada] of [['bodega.html','bodega-demo.png'], ['inventario.html','dashboard-demo.png']]){
      await page.goto(`http://localhost:${PORT}/${archivo}`, { waitUntil:'networkidle' });

      // Las capturas son de carga diferida: sin recorrer la página primero, naturalWidth es 0,
      // se saltan todas y la prueba pasaría sin haber medido nada.
      await page.evaluate(async () => {
        for(let y = 0; y <= document.body.scrollHeight; y += 600){
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
        const imgs = [...document.querySelectorAll('.phone-frame img, .comparativa-img')];
        await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => {
          i.addEventListener('load', r, {once:true}); i.addEventListener('error', r, {once:true});
        })));
      });

      const medidas = await page.evaluate(() => {
        const revisadas = [], malas = [];
        document.querySelectorAll('.phone-frame img, .comparativa-img').forEach(img => {
          const nombre = img.getAttribute('src').split('/').pop();
          if(!img.naturalWidth || !img.naturalHeight) return;
          const r = img.getBoundingClientRect();
          if(!r.width || !r.height) return;
          revisadas.push(nombre);
          const esperado = img.naturalHeight / img.naturalWidth;
          const real = r.height / r.width;
          if(Math.abs(real - esperado) / esperado > 0.02)
            malas.push(nombre + ': ' + real.toFixed(2) + ' en vez de ' + esperado.toFixed(2));
        });
        return { revisadas, malas };
      });
      assert(medidas.revisadas.includes(esperada),
        `${archivo}: la prueba tiene que alcanzar a medir ${esperada}; si no, pasa sin comprobar nada. Midió: ${medidas.revisadas.join(', ')}`);
      assert(medidas.malas.length === 0,
        `${archivo}: ninguna captura debe renderizarse con otra proporción que la suya, obtuvo: ${medidas.malas.join(' | ')}`);
    }
    await context.close();
  }

  // ===== Bodega: reservas y el atajo a la orden de compra, con clicks reales =====
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('reservas: '+err.message));
    const perfilBodega = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilBodega.empresas.modulo_bodega_habilitado = true;
    perfilBodega.empresas.bodega_funciones = {};
    await mockearSupabaseApp(page, perfilBodega);
    await page.route('**/rest/v1/reservas_lista**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'res-1', numero:'RES-000003', persona_id:'per-1', persona_nombre:'Juan Retira', persona_area:'Mantención',
        destino:'Detención chancador', fecha_necesaria:'2026-09-17', usuario_id:'perfil-1', usuario_nombre:'Ana Torres',
        cancelada_en:null, created_at:'2026-09-10T11:00:00Z', estado_guardado:'activa',
        lineas:1, cantidad_reservada:15, entregado:0, pendiente:15, lineas_descubiertas:1, estado:'descubierta' },
    ]) }));
    await page.route('**/rest/v1/reservas_lineas_detalle**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'rl1', reserva_id:'res-1', sku_id:'s1', sku_code:'BOD-001', descripcion:'Filtro', unidad_medida:'UN',
        cantidad:15, entregado:0, pendiente:15, stock:12, reservado_total:15, faltante:3 },
    ]) }));
    await page.route('**/rest/v1/proveedores**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'p-1', nombre:'Ferretería Andina', rut:'76.543.210-9', activo:true, email:null, telefono:null, contacto:null, direccion:null },
    ]) }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('[data-ir-vista="reservas"]');
    await page.waitForSelector('[data-reserva-ver="res-1"]', { timeout:ESPERA });
    assert(await esperarVisible(page, 'text=FALTA MATERIAL') || await page.isVisible('text=Falta material'), 'la reserva descubierta se avisa arriba de la lista');
    await page.click('[data-reserva-ver="res-1"]');
    await page.waitForSelector('[data-reserva-comprar="res-1"]', { timeout:ESPERA });
    assert(await esperarVisible(page, 'text=faltan 3'), 'el detalle muestra cuánto falta para cubrir la reserva');
    const sinDesbordeRes = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(sinDesbordeRes, 'el detalle de la reserva no debe desbordar a lo ancho en pantalla de celular');
    // El atajo que cierra el ciclo: el faltante se convierte en una orden de compra.
    await page.click('[data-reserva-comprar="res-1"]');
    await page.waitForSelector('[data-oc-cantidad]', { timeout:ESPERA });
    await esperarCondicion(page, () => {
      const el = document.querySelector('[data-oc-cantidad]');
      return !!el && el.value !== '';
    });
    const cantidadOc = await page.inputValue('[data-oc-cantidad]');
    assert(cantidadOc==='3', 'la orden se arma con el faltante (3), no con lo reservado (15), obtuvo: '+cantidadOc);
    const obs = await page.inputValue('#oc-observacion');
    assert(obs.includes('RES-000003'), 'la orden dice qué reserva viene a cubrir, obtuvo: '+obs);
    await context.close();
  }

  // ===== Bodega: órdenes de compra, con clicks reales =====
  // Igual que el traslado: acá se prueba el cableado (que los listeners estén en la vista donde
  // vive cada botón), que el sandbox de unit tests no ve porque llama las funciones directo.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('ordenes-compra: '+err.message));
    const perfilBodega = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilBodega.empresas.modulo_bodega_habilitado = true;
    await mockearSupabaseApp(page, perfilBodega);
    const OC = { id:'oc-1', numero:'OC-000007', proveedor_id:'p-1', proveedor_nombre:'Ferretería Andina',
      proveedor_rut:'76.543.210-9', proveedor_contacto:'Marcela Ríos', proveedor_email:'ventas@andina.cl',
      usuario_nombre:'Ana Torres', fecha:'2026-09-10', fecha_esperada:'2026-09-17', condiciones_pago:'30 días',
      lugar_entrega:'Bodega Central', observacion:null, afecta_iva:true, estado:'enviada', estado_guardado:'enviada',
      enviada_en:'2026-09-10T12:00:00Z', cerrada_en:null, anulada_en:null,
      lineas:1, cantidad_pedida:20, cantidad_recibida:0, lineas_pendientes:1, neto:50000, iva:9500, total:59500 };
    await page.route('**/rest/v1/ordenes_compra_lista**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([OC]) }));
    await page.route('**/rest/v1/ordenes_compra_lineas_detalle**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'l1', orden_compra_id:'oc-1', sku_id:'s1', sku_code:'BOD-001', descripcion:'Filtro', unidad_medida:'UN',
        cantidad:20, costo_unitario:2500, recibido:0, pendiente:20, exceso:0, total_linea:50000 },
    ]) }));
    await page.route('**/rest/v1/proveedores**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'p-1', nombre:'Ferretería Andina', rut:'76.543.210-9', activo:true, email:'ventas@andina.cl', telefono:null, contacto:'Marcela Ríos', direccion:null },
    ]) }));
    await page.route('**/rest/v1/rpc/lineas_por_recibir**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { sku_id:'s1', sku_code:'BOD-001', descripcion:'Filtro', unidad_medida:'UN', batch:null, bodega:'Bodega Central',
        ubicacion:null, storage_bin:'R-1', cantidad:20, recibido:0, pendiente:20, costo_unitario:2500 },
    ]) }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    // Se entra desde el Inicio de bodega, no desde la barra de pestañas (ya lleva cinco). El tile
    // abre el formulario en blanco, así que a la lista se llega por "Ver órdenes emitidas" -- que
    // existe justamente porque se quitó el botón chico de abajo y, sin él, habría que cancelar un
    // formulario que uno no quería abrir.
    await page.click('[data-nueva-orden]');
    await page.waitForSelector('#oc-ver-lista', { timeout:ESPERA });
    await page.click('#oc-ver-lista');
    await page.waitForSelector('[data-oc-ver="oc-1"]', { timeout:ESPERA });
    // Camino exacto que dejó encerrado a Joel: tile Orden de compra -> Ver órdenes emitidas, y
    // desde la lista no había vuelta (esta pantalla no está en la barra de abajo). Se prueba el
    // click de verdad, no solo que el botón esté dibujado.
    await page.click('.miga-volver');
    assert(await esperarVisible(page, '[data-nueva-orden]'), 'desde las órdenes emitidas se tiene que poder volver al Inicio de bodega');
    await page.click('[data-nueva-orden]');
    await page.waitForSelector('#oc-ver-lista', { timeout:ESPERA });
    await page.click('#oc-ver-lista');
    await page.waitForSelector('[data-oc-ver="oc-1"]', { timeout:ESPERA });
    await page.click('[data-oc-ver="oc-1"]');
    await page.waitForSelector('[data-oc-imprimir="oc-1"]', { timeout:ESPERA });
    assert(await esperarVisible(page, 'text=Marcela Ríos'), 'el detalle muestra el contacto del proveedor');
    const sinDesborde = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(sinDesborde, 'el detalle de la orden no debe desbordar a lo ancho en pantalla de celular');
    // "Recepcionar" lleva a la otra vista con los ítems pendientes ya cargados.
    await page.click('[data-oc-recibir="oc-1"]');
    // Esperar al DATO, no al elemento. El handler de data-oc-recibir hace setState({view:'ingreso'})
    // y recién después await usarOrdenCompraEnIngreso(), que es quien pide las líneas al servidor:
    // #bd-oc existe con valor vacío desde el primer render. Con el mock respondiendo al instante
    // casi siempre alcanzaba, pero en CI fallaba de a ratos -- el run 812 y el primer intento del
    // PR #422 -- con un "obtuvo: " vacío que parecía un bug de la app y no lo era.
    await page.waitForFunction(
      () => { const el = document.getElementById('bd-oc'); return !!el && el.value === 'OC-000007'; },
      null, { timeout:ESPERA });
    assert(await page.inputValue('#bd-oc')==='OC-000007', 'el número de la orden queda en la Recepción');
    await page.waitForSelector('.bd-costo', { timeout:ESPERA });
    const lineas = await page.$$eval('.bd-costo', els => els.length);
    assert(lineas===1, 'el ítem pendiente se carga solo en la Recepción, obtuvo: '+lineas);
    // Y la cantidad recibida se puede corregir con lo que de verdad llegó. Se prueba en navegador
    // real porque el riesgo es el cableado: el input escribe al estado sin repintar (para no
    // reemplazar el campo mientras se escribe) y recién al salir del campo se refrescan los avisos.
    const cantidades = await page.$$eval('.bd-cantidad-linea', els => els.map(e=>e.value));
    assert(cantidades.length===1 && cantidades[0]==='20', 'la cantidad viene con lo pendiente (20), obtuvo: '+JSON.stringify(cantidades));
    await page.fill('.bd-cantidad-linea', '4');
    await page.locator('.bd-cantidad-linea').dispatchEvent('change');
    assert(await esperarVisible(page, 'text=Quedan 16 por llegar'), 'recibir 4 de 20 avisa que quedan 16 por llegar');
    await page.fill('.bd-cantidad-linea', '20');
    await page.locator('.bd-cantidad-linea').dispatchEvent('change');
    // El tile "Orden de compra" del Inicio entra derecho al formulario, sin pasar por la lista.
    // Se prueba acá porque el riesgo real es el cableado: un listener registrado en el bloque de
    // bind equivocado no se nota en los unit tests (ya pasó con el botón Transferir de Stock).
    await page.click('[data-tab="inicio"]');
    await page.waitForSelector('[data-nueva-orden]', { timeout:ESPERA });
    const tiles = await page.$$eval('.inicio-tile', els => els.map(e => (e.querySelector('span span')||{}).textContent));
    assert(tiles[0] === 'Orden de compra', `el tile de orden de compra debe ir primero, obtuvo: ${JSON.stringify(tiles)}`);
    await page.click('[data-nueva-orden]');
    await page.waitForSelector('#oc-proveedor', { timeout:ESPERA });
    assert(await page.isVisible('#oc-buscar-sku'), 'el tile del Inicio debe abrir el formulario de orden nueva, no la lista');

    // Y el botón "Nueva orden" de la propia lista también responde a los clicks reales.
    await page.click('#oc-ver-lista');
    await page.waitForSelector('#btn-nueva-orden', { timeout:ESPERA });
    await page.click('#btn-nueva-orden');
    await page.waitForSelector('#oc-proveedor', { timeout:ESPERA });
    assert(await page.isVisible('#oc-buscar-sku'), 'el formulario de orden nueva trae el buscador de materiales');
    await context.close();
  }

  // ===== Bodega: escribir sin perder el cursor ni lo tecleado =====
  // Bug reportado por Joel ("en varios lados del módulo de bodega se pierde el cursor cuando estoy
  // escribiendo"). buscarSkuBodega renderiza al empezar a buscar y otra vez al llegar los
  // resultados, y render() rehace todo el DOM: se iba el foco Y el texto. Medido antes del
  // arreglo: al teclear "BOD-001" quedaba escrito solo "B", en Ingreso, Reservas y Órdenes.
  // Esto solo se ve con un navegador de verdad, por eso la prueba vive acá y no en app.test.js.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('foco-bodega: '+err.message));
    const perfilBodega = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilBodega.empresas.modulo_bodega_habilitado = true;
    await mockearSupabaseApp(page, perfilBodega);
    // Con latencia, como un servidor real: es en esa ventana donde se perdía lo tecleado.
    await page.route('**/rest/v1/rpc/buscar_skus_lectura**', async route => {
      await new Promise(r => setTimeout(r, 120));
      return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
        { id:'s1', sku_code:'BOD-001', descripcion:'Filtro', bodega:'Bodega Central', ubicacion:null,
          storage_bin:'R-1', batch:null, stock_sistema:5, unidad_medida:'UN', costo_unitario:1000,
          tipo_material:'Repuesto' },
      ]) });
    });
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });

    await page.click('[data-ir-vista="ingreso"]');
    await page.waitForSelector('#bd-sku', { timeout:ESPERA });
    await page.click('#bd-sku');
    // Tecla por tecla con pausas MAYORES al debounce de 250 ms: así la búsqueda dispara mientras
    // se sigue escribiendo, que es justo lo que hace alguien tecleando un código en terreno.
    let perdioElFoco = 0;
    for(const ch of 'BOD-001'){
      await page.keyboard.type(ch);
      await page.waitForTimeout(300);
      const activo = await page.evaluate(() => document.activeElement && document.activeElement.id);
      if(activo !== 'bd-sku') perdioElFoco++;
    }
    assert(perdioElFoco === 0, `el buscador de material no debe perder el foco al escribir, lo perdió ${perdioElFoco} de 7 veces`);
    const tecleado = await page.inputValue('#bd-sku');
    assert(tecleado === 'BOD-001', `debe quedar todo lo tecleado en el buscador, obtuvo: "${tecleado}"`);

    // Lo de al lado: si se escribe en otro campo mientras llega el resultado, ese texto tampoco se
    // puede perder, y el foco NO se lo puede robar el buscador de vuelta.
    await page.click('#bd-sku');
    await page.keyboard.type('FIL');
    await page.click('#bd-obs');
    await page.keyboard.type('Carga de prueba');
    await page.waitForTimeout(900);
    const trasBuscar = await page.evaluate(() => ({
      activo: document.activeElement && document.activeElement.id,
      obs: (document.getElementById('bd-obs') || {}).value,
    }));
    assert(trasBuscar.activo === 'bd-obs', `el resultado de la búsqueda no debe robarle el foco al campo que se está escribiendo, quedó en: ${trasBuscar.activo}`);
    assert(trasBuscar.obs === 'Carga de prueba', `lo escrito en Observación no se puede perder al llegar el resultado, obtuvo: "${trasBuscar.obs}"`);

    // El caso que se escapó del primer arreglo: NO es el buscador el que bota el foco, es render().
    // Cualquier setState que caiga encima sirve. Joel lo pilló escribiendo el SKU en una orden de
    // compra, donde el culpable era cargarOrdenesCompra() terminando. Se simula con la lista
    // llegando tarde, que es lo que pasa con una conexión de terreno.
    await page.route('**/rest/v1/ordenes_compra_lista**', async route => {
      await new Promise(r => setTimeout(r, 1500));
      return route.fulfill({ status:200, contentType:'application/json', body:'[]' });
    });
    await page.click('[data-tab="inicio"]');
    await page.waitForSelector('[data-nueva-orden]', { timeout:ESPERA });
    await page.click('[data-nueva-orden]');
    await page.waitForSelector('#oc-buscar-sku', { timeout:ESPERA });
    await page.click('#oc-buscar-sku');
    let perdioConCargaLenta = 0;
    for(const ch of '10371892'){
      await page.keyboard.type(ch);
      await page.waitForTimeout(220);
      const activo = await page.evaluate(() => document.activeElement && document.activeElement.id);
      if(activo !== 'oc-buscar-sku') perdioConCargaLenta++;
    }
    assert(perdioConCargaLenta === 0, `una carga de datos que termina mientras se escribe no puede botar el foco, lo botó ${perdioConCargaLenta} de 8 veces`);
    // Se lee tras asentar: leer justo después de la tecla puede pillar el DOM a medio repintar.
    await page.waitForTimeout(1200);
    const codigoOc = await page.inputValue('#oc-buscar-sku');
    assert(codigoOc === '10371892', `tampoco puede perder lo tecleado, obtuvo: "${codigoOc}"`);
    await page.unroute('**/rest/v1/ordenes_compra_lista**');
    await page.click('[data-tab="inicio"]');
    await page.click('[data-ir-vista="ingreso"]');
    await page.waitForSelector('#bd-sku', { timeout:ESPERA });

    // Y el cursor vuelve donde estaba, no al final: si no, escribir en medio de un código es un suplicio.
    await page.evaluate(() => { const el = document.getElementById('bd-sku'); el.value = 'FILTRO'; el.dispatchEvent(new Event('input', {bubbles:true})); });
    await page.waitForTimeout(900);
    await page.evaluate(() => { const el = document.getElementById('bd-sku'); el.focus(); el.setSelectionRange(3, 3); });
    await page.keyboard.type('X');
    await page.waitForTimeout(900);
    const enMedio = await page.evaluate(() => { const el = document.getElementById('bd-sku'); return { valor: el.value, cursor: el.selectionStart }; });
    assert(enMedio.valor === 'FILXTRO', `escribir en medio debe insertar donde está el cursor, obtuvo: "${enMedio.valor}"`);
    assert(enMedio.cursor === 4, `el cursor debe quedar donde estaba, no saltar al final, obtuvo: ${enMedio.cursor}`);

    // iPad: conservar el foco no basta. Si render() REEMPLAZA el <input>, iOS enfoca un elemento
    // nuevo y reinicia el teclado a la disposición de letras; tecleando un código como 10371892
    // hay que apretar "123" en cada dígito. Joel lo reportó en Crear orden de compra.
    // Medido antes del arreglo: el input se reemplazaba las 8 veces. Por eso el buscador de bodega
    // repinta solo #sku-bodega-resultados (actualizarResultadosSkuBodega) en vez de llamar render().
    // Se marca el nodo: si lo reemplazan, la marca se va con él.
    for(const [vista, input] of [['ingreso','bd-sku'], ['ordenes','oc-buscar-sku']]){
      await page.click('[data-tab="inicio"]');
      if(vista === 'ordenes'){
        await page.waitForSelector('[data-nueva-orden]', { timeout:ESPERA });
        await page.click('[data-nueva-orden]');
      }else{
        await page.click('[data-ir-vista="ingreso"]');
      }
      await page.waitForSelector('#'+input, { timeout:ESPERA });
      await page.waitForTimeout(1200); // que terminen las cargas de la vista, que sí hacen render()
      await page.evaluate(id => { document.getElementById(id).dataset.marca = 'original'; }, input);
      await page.click('#'+input);
      let reemplazos = 0;
      for(const ch of '10371892'){
        await page.keyboard.type(ch);
        await page.waitForTimeout(300);
        const sobrevivio = await page.evaluate(id => {
          const el = document.getElementById(id);
          const era = !!el && el.dataset.marca === 'original';
          if(el) el.dataset.marca = 'original';
          return era;
        }, input);
        if(!sobrevivio) reemplazos++;
      }
      assert(reemplazos === 0, `#${input}: escribir no puede reemplazar el <input> (en iPad eso reinicia el teclado), lo reemplazó ${reemplazos} de 8 veces`);
    }
    await context.close();
  }

  // ===== Bodega: el botón Ubicación del maestro de Stock abre la ventana de cambio de ubicación =====
  // En el sandbox de unit tests las funciones se llaman directo; acá se prueba el cableado real:
  // que el listener esté registrado en la vista donde de verdad vive el botón.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('transferencia: '+err.message));
    const perfilBodega = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilBodega.empresas.modulo_bodega_habilitado = true;
    await mockearSupabaseApp(page, perfilBodega);
    await page.route('**/rest/v1/stock_actual**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { sku_id:'s1', sku_code:'BOD-001', descripcion:'Filtro', batch:null, bodega:'Bodega Central', ubicacion:'Pasillo 1',
        storage_bin:'R-1', stock:6, unidad_medida:'UN', costo_unitario:1000, stock_minimo:null, bajo_minimo:false,
        falta_para_minimo:null, tipo_material:'Repuesto', valor:6000 },
    ]) }));
    await page.route('**/rest/v1/ubicaciones?**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { id:'u1', bodega:'Bodega Central', ubicacion:null, activo:true },
      { id:'u2', bodega:'Bodega Norte', ubicacion:null, activo:true },
    ]) }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('[data-tab="stock"]');
    await page.waitForSelector('[data-transferir-sku]', { timeout:ESPERA });
    await page.click('[data-transferir-sku]');
    await page.waitForSelector('#ubicacion-sku-backdrop', { timeout:ESPERA });
    assert(await page.isVisible('#us-bodega'), 'la ventana de cambio de ubicación debe abrirse desde Stock');
    // La cantidad viene con todo el saldo del sitio: el caso normal es que el material se mueva entero.
    assert(await page.inputValue('#us-cantidad')==='6', 'la cantidad parte en todo el saldo, obtuvo: '+await page.inputValue('#us-cantidad'));
    await esperarCondicion(page, () => {
      const sel = document.getElementById('us-bodega');
      return !!sel && Array.from(sel.options).some(o => o.value === 'Bodega Norte');
    });
    const opciones = await page.$$eval('#us-bodega option', els => els.map(e=>e.value));
    assert(opciones.includes('Bodega Norte'), 'la ventana ofrece las bodegas de destino, obtuvo: '+JSON.stringify(opciones));
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(desborde, 'la ventana de cambio de ubicación no debe desbordar a lo ancho en pantalla de celular');
    await page.click('#ubicacion-sku-cancelar');
    await page.waitForTimeout(200);
    assert(await page.$('#ubicacion-sku-backdrop') === null, 'Cancelar cierra la ventana');
    await context.close();
  }

  // ===== Landing: los puntos del carrusel cambian la lámina activa =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-carousel: '+err.message));
    await bloquearSentry(page);
    await page.goto(`http://localhost:${PORT}/inventario.html`, { waitUntil:'networkidle' });
    await page.addStyleTag({ content:'html{scroll-behavior:auto !important}' });
    await page.click('#vista-dots .carousel-dot:nth-child(2)');
    await page.waitForTimeout(600);
    const segundoActivo = await page.evaluate(() => document.querySelectorAll('#vista-dots .carousel-dot')[1].classList.contains('active'));
    assert(segundoActivo, 'al hacer click en el 2do punto del carrusel, debe quedar marcado como activo');
    await context.close();
  }

  // ===== El service worker entrega la copia guardada, no espera a la red =====
  // La app es un archivo de 927 KB y bajarlo costaba 5,4 de los 6,0 segundos que tardaba en abrir
  // en 3G. Con la copia guardada son ~200 ms. Se prueba sin cronómetro: el servidor demora la
  // respuesta 3 segundos a propósito, así que si la pantalla aparece antes, salió de la caché.
  // Con la estrategia anterior (red primero) esta prueba falla por tiempo de espera.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 }, serviceWorkers:'allow' });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('service-worker: '+err.message));
    await bloquearSentry(page);
    await page.route('**/rest/v1/**', route => route.fulfill({ status:200, contentType:'application/json', body:'[]' }));

    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'domcontentloaded' });
    await page.waitForSelector('#f-email', { state:'visible', timeout:ESPERA });
    const listo = await page.evaluate(() => navigator.serviceWorker
      ? navigator.serviceWorker.ready.then(()=>true).catch(()=>false) : false);
    assert(listo, 'el service worker tiene que quedar instalado');
    await page.waitForTimeout(1200); // que alcance a guardar el shell

    // Se "publica" una versión nueva. Con la copia guardada la pantalla sale igual de rápido, y el
    // aviso de versión nueva lo tiene que prender el service worker al terminar la descarga de
    // fondo: el chequeo por HEAD cada 15 minutos no sirve acá, porque compara contra lo primero
    // que vio, que ya sería la versión del servidor.
    servidorEstado.version = 2;
    await page.reload({ waitUntil:'domcontentloaded' });
    await page.waitForSelector('#f-email', { state:'visible', timeout:ESPERA });
    const aviso = await esperarCondicion(page, () => typeof state !== 'undefined' && state.versionNueva === true);
    assert(aviso, 'publicar una versión nueva tiene que prender el aviso "hay una versión nueva"');

    // Y sigue abriendo sin señal.
    await context.setOffline(true);
    const sinSenal = await context.newPage();
    const abrio = await sinSenal.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'domcontentloaded' })
      .then(() => sinSenal.waitForSelector('#f-email', { state:'visible', timeout:ESPERA }))
      .then(() => true).catch(() => false);
    assert(abrio, 'sin conexión la app tiene que seguir abriendo desde la copia guardada');
    await context.setOffline(false);
    await context.close();
  }

  // ===== Recargar deja a la persona en la pantalla en la que estaba =====
  // Pedido de Joel: estaba en Buscar, actualizó la página y la app lo devolvió al Dashboard.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('recarga-vista: '+err.message));
    await loguear(page, PERFIL_ADMIN_PRO);
    await page.click('#btn-ir-buscar');
    await page.waitForSelector('#b-texto', { timeout:ESPERA });
    await page.reload({ waitUntil:'networkidle' });
    const volvioABuscar = await page.waitForSelector('#b-texto', { timeout:ESPERA }).then(()=>true).catch(()=>false);
    assert(volvioABuscar, 'tras recargar, la app tiene que volver a Buscar, no al Dashboard');
    const vista = await page.evaluate(() => state.view);
    assert(vista === 'buscar', 'la vista restaurada es Buscar, obtuvo: '+vista);
    await context.close();
  }

  // ===== Buscar (Fase 4 del rediseño): caja grande, filtros plegables y chips, en el navegador =====
  // A 420 px: la caja mide 56 px y el botón va al lado; "Más filtros" parte cerrado pero sus
  // campos existen (el submit los lee); al buscar, los filtros se pliegan, aparecen los chips y
  // los resultados; "Limpiar filtros" vuelve los campos a cero sin buscar.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('buscar-filtros: '+err.message));
    await mockearSupabaseApp(page, PERFIL_ADMIN_PRO);
    await page.route('**/rest/v1/rpc/filas_busqueda_skus**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([
      { sku_id:'s-e2e-1', sku_code:'11164514', descripcion:'CLIP,ELEC,PRESS', bodega:'B501', ubicacion:'0102', storage_bin:'N1E-027-B1', batch:null, conteo_id:'c-1', cantidad_contada:3, estado:'con_diferencia', diferencia:-1, fecha_conteo:'2026-10-01T12:00:00Z', fotos:[], clase_abc:'A', critico:false, fuera_de_plan:false, packing_danado:true, material_danado:true, cantidad_danada:2, ultimo_conteo_n:2, ultimo_reconteo_n:1 },
    ]) }));
    await page.route('**/rest/v1/rpc/contar_busqueda_skus**', route => route.fulfill({ status:200, contentType:'application/json', body:'1' }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('#btn-ir-buscar');
    await page.waitForSelector('#b-texto', { timeout:ESPERA });
    const barra = await page.evaluate(() => { const i = document.getElementById('b-texto').getBoundingClientRect(), b = document.querySelector('.buscar-btn').getBoundingClientRect(); return { h: Math.round(i.height), lado: Math.abs(i.top-b.top) < 2 && b.left > i.right }; });
    assert(barra.h >= 56 && barra.lado, 'la caja mide 56 px y el botón Buscar va a su lado, obtuvo '+JSON.stringify(barra));
    assert(await page.isVisible('#b-estado') && !(await page.isVisible('#b-fecha-desde')) && await page.$('#b-fecha-desde') !== null, 'Estado se ve, "Contado desde" está plegado pero existe');
    await page.selectOption('#b-estado', 'con_diferencia');
    await page.fill('#b-texto', '11164514');
    await page.click('.buscar-btn');
    assert(await esperarVisible(page, 'text=1 resultado'), 'al buscar aparece el contador de resultados');
    assert(!(await page.isVisible('#b-estado')), 'tras buscar, los filtros se pliegan');
    const chips = await page.$$eval('#buscar-filtros .fchip', els => els.map(e => e.textContent.trim()));
    assert(chips.join('|') === '“11164514”|Con diferencia', 'los chips resumen la búsqueda hecha, obtuvo '+JSON.stringify(chips));
    // Regla del 14/10/2026: la fila dice qué conteo es ("Conteo 2.1" = 2.º conteo, 1.er reconteo).
    assert(await page.isVisible('.badge-steel:has-text("Conteo 2.1")'), 'la fila de Buscar muestra "Conteo 2.1" junto al estado');
    // Filtro por daños (14/10/2026): viaja como p_estado y el chip lo nombra.
    await page.click('#buscar-filtros > summary');
    await page.waitForSelector('#b-estado', { state:'visible', timeout:ESPERA });
    await page.selectOption('#b-estado', 'con_danos');
    const pedidoDanos = page.waitForRequest(r => r.url().includes('/rpc/filas_busqueda_skus') && (r.postDataJSON()||{}).p_estado === 'con_danos', { timeout:ESPERA }).then(()=>true).catch(()=>false);
    await page.click('.buscar-btn');
    assert(await pedidoDanos, 'buscar "Con daños" pide filas_busqueda_skus con p_estado=con_danos');
    assert(await esperarVisible(page, '#buscar-filtros .fchip:has-text("Con daños")'), 'el chip dice "Con daños"');
    if(!(await page.$eval('#buscar-filtros', el => el.open))) await page.click('#buscar-filtros > summary');
    await page.waitForSelector('#btn-limpiar-filtros-buscar', { state:'visible', timeout:ESPERA });
    await page.click('#btn-limpiar-filtros-buscar');
    await page.waitForTimeout(300);
    const limpio = await page.evaluate(() => ({ texto: document.getElementById('b-texto').value, estado: document.getElementById('b-estado').value, filas: document.querySelectorAll('.chk-buscar-fila').length }));
    assert(limpio.texto === '' && limpio.estado === '' && limpio.filas === 1, '"Limpiar filtros" vacía los campos sin tocar los resultados, obtuvo '+JSON.stringify(limpio));
    const desbordeBuscar = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeBuscar <= 0, 'a 420 px Buscar no desborda, obtuvo '+desbordeBuscar);
    // Daños del último conteo (13/10/2026): columna propia en la tabla, sin empujar la página.
    const danos = await page.$$eval('table .badge-danger', els => els.map(e => e.textContent.trim()));
    assert(danos.join('|') === 'Packing dañado|Material dañado: 2', 'la tabla de Buscar muestra los daños del último conteo, obtuvo '+JSON.stringify(danos));
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/buscar-danos-420.png', fullPage: true });
    await context.close();
  }

  // ===== Reconteo: un error del servidor se ve como error (14/10/2026) =====
  // Antes, mientras cargaba y si el servidor fallaba, decía "No hay materiales con diferencias
  // pendientes". Ahora muestra el motivo y "Reintentar", que vuelve a pedir la lista.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('reconteo-error: '+err.message));
    await mockearSupabaseApp(page, PERFIL_ADMIN_PRO);
    let fallar = true;
    await page.route('**/rest/v1/reconteo_pendiente?**', route => fallar
      ? route.fulfill({ status:500, contentType:'application/json', body: JSON.stringify({ message:'canceling statement due to statement timeout' }) })
      : route.fulfill({ status:200, contentType:'application/json', body:'[]' }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('[data-tab="reconteo"]');
    assert(await esperarVisible(page, '#btn-reintentar-reconteos'), 'con el servidor fallando, Reconteo muestra "Reintentar"');
    assert(await page.isVisible('text=No se pudo cargar la lista de reconteo: canceling statement due to statement timeout'), 'y el motivo del error');
    assert(!(await page.isVisible('text=No hay materiales con diferencias pendientes')), 'no se disfraza de "no hay pendientes"');
    const desbordeRec = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeRec <= 0, 'a 420 px el aviso no desborda, obtuvo '+desbordeRec);
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/reconteo-error-420.png', fullPage: true });
    fallar = false;
    await page.click('#btn-reintentar-reconteos');
    assert(await esperarVisible(page, 'text=No hay materiales con diferencias pendientes'), 'al reintentar con el servidor bien, se ve la lista real (vacía)');
    await context.close();
  }

  // ===== Calendario (Fase 5 del rediseño): estados por día en el navegador =====
  // Un día pasado con pendientes se marca atrasado, uno sin pendientes cumplido, uno por venir
  // futuro; el resumen de cumplimiento aparece; tocar un día abre su detalle con el estado.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('calendario: '+err.message));
    await mockearSupabaseApp(page, PERFIL_ADMIN_PRO);
    const hoyCal = new Date(); const iso = d => new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);
    const mas = n => { const d = new Date(hoyCal); d.setDate(d.getDate()+n); return iso(d); };
    const dias = [
      { fecha: mas(-1), planificado:31, contado:0, recontado:0, pendiente:31 },
      { fecha: mas(-2), planificado:8, contado:8, recontado:1, repetido:2, pendiente:0 },
      { fecha: mas(1), planificado:40, contado:0, recontado:0, pendiente:40 },
      // Cifras grandes (como el 27/10 real de Escondida): tienen que caber en la celda a 420 px.
      { fecha: mas(2), planificado:1149, contado:1234, recontado:128, pendiente:1149 },
    ].filter(d => d.fecha.slice(0,7) === iso(hoyCal).slice(0,7));
    // resumen_calendario_dias desde el 14/10/2026 (trae "repetido"; ver la regla de reconteo).
    await page.route('**/rest/v1/rpc/resumen_calendario_dias**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(dias) }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    // Fase 6: Calendario vive en la hoja "Más" de la barra inferior.
    assert(!(await page.isVisible('#btn-ir-calendario')), 'Calendario está en la hoja "Más", no a la vista');
    await page.click('#tab-mas');
    await page.waitForSelector('#btn-ir-calendario', { state:'visible', timeout:ESPERA });
    await page.click('#btn-ir-calendario');
    assert(await esperarVisible(page, '.cal-grid .cal-dia.es-hoy'), 'el calendario del mes se dibuja con el día de hoy marcado');
    assert(!(await page.isVisible('#tab-mas-hoja')), 'al navegar desde "Más", la hoja se cierra');
    const estados = await page.evaluate(ds => ds.map(d => { const el = document.querySelector(`[data-cal-dia="${d.fecha}"]`); return el ? el.className.split(' ').filter(c => ['atrasado','cumplido','parcial','futuro','vacio'].includes(c))[0] : null; }), dias);
    const esperado = dias.map(d => d.fecha < iso(hoyCal) ? (d.pendiente ? 'atrasado' : 'cumplido') : 'futuro');
    assert(JSON.stringify(estados) === JSON.stringify(esperado), 'cada día lleva su estado (atrasado / cumplido / futuro), obtuvo '+JSON.stringify(estados)+' esperaba '+JSON.stringify(esperado));
    if(dias.length) assert(await page.isVisible('text=Cumplimiento a hoy') || dias.every(d => d.fecha > iso(hoyCal)), 'la cabecera muestra el cumplimiento a hoy');
    const atrasado = dias.find(d => d.fecha < iso(hoyCal) && d.pendiente);
    if(atrasado){
      await page.click(`[data-cal-dia="${atrasado.fecha}"]`);
      assert(await esperarVisible(page, 'text=Detalle del día'), 'tocar un día abre su detalle');
      assert(await page.isVisible('.badge-danger:has-text("Atrasado")'), 'el detalle del día atrasado lleva su etiqueta');
    }
    // Regla del 14/10/2026: el detalle separa lo que se volvió a contar de lo recontado desde Reconteo.
    const cumplido = dias.find(d => d.fecha < iso(hoyCal) && d.repetido);
    if(cumplido){
      await page.click(`[data-cal-dia="${cumplido.fecha}"]`);
      await page.waitForFunction(f => document.body.innerText.includes('Contado otra vez'), cumplido.fecha, { timeout:ESPERA });
      const filasDetalle = await page.$$eval('.cal-detalle-fila', els => els.map(e => e.innerText.replace(/\s+/g,' ').trim()));
      assert(filasDetalle.some(t => /^Contado otra vez .*2$/.test(t)) && filasDetalle.some(t => /^Recontado \(desde Reconteo\) 1$/.test(t)), 'el detalle muestra "Contado otra vez 2" y "Recontado (desde Reconteo) 1", obtuvo '+JSON.stringify(filasDetalle));
    }
    const desbordeCal = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeCal <= 0, 'a 420 px el calendario no desborda, obtuvo '+desbordeCal);
    // C y R vuelven a la celda (14/10/2026): ninguna cifra se sale de su día, ni con miles.
    const celdasDesbordadas = await page.$$eval('.cal-grid .cal-dia', els => els.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.dataset.calDia));
    assert(celdasDesbordadas.length === 0, 'a 420 px ninguna celda del calendario se desborda, obtuvo '+JSON.stringify(celdasDesbordadas));
    if (process.env.E2E_CAPTURAS){
      await page.screenshot({ path: process.env.E2E_CAPTURAS + '/calendario-420.png', fullPage: true });
      await page.setViewportSize({ width:1024, height:1300 });
      await page.screenshot({ path: process.env.E2E_CAPTURAS + '/calendario-1024.png', fullPage: true });
    }
    await context.close();
  }

  // ===== Buscar con más de mil resultados (Joel, 19/10/2026: "me sale primeros 1.000, eso no
  // sirve, deben ser los datos reales") =====
  // Con 1.218 resultados: los gráficos salen del resumen del servidor mientras la lista completa
  // llega en segundo plano, con su avance a la vista, y al terminar se puede tocar una porción.
  // Con 5.003 la lista no se trae entera, pero los gráficos igual cuentan los 5.003.
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('buscar-total-real: '+err.message));
    await mockearSupabaseApp(page, PERFIL_ADMIN_PRO);
    let total = 1218;
    const fila = i => ({ sku_id:'M-'+i, sku_code:'M-'+i, descripcion:'Material '+i, bodega:'B501', ubicacion:'0102', storage_bin:null, batch:null, conteo_id:'c-'+i, cantidad_contada:5, estado: i%5===0 ? 'con_diferencia' : 'aprobado', diferencia: i%5===0 ? -1 : 0, fecha_conteo:'2026-10-16T12:00:00Z', fotos:[], clase_abc:'A', critico:false, fuera_de_plan:false, contado_por: i%2 ? 'Ana' : 'Beto', contado_por_id:'u-'+(i%2) });
    let soltarSegundaTanda;
    let segundaTanda = new Promise(r => { soltarSegundaTanda = r; });
    await page.route('**/rest/v1/rpc/filas_busqueda_skus**', async route => {
      const b = route.request().postDataJSON() || {};
      if(b.p_offset>0) await segundaTanda;
      const filas = [];
      for(let i=b.p_offset; i<Math.min(total, b.p_offset+b.p_limite); i++) filas.push(fila(i));
      await route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(filas) });
    });
    await page.route('**/rest/v1/rpc/contar_busqueda_skus**', route => route.fulfill({ status:200, contentType:'application/json', body: String(total) }));
    await page.route('**/rest/v1/rpc/resumen_busqueda_skus**', route => {
      const neg = Math.floor((total-1)/5)+1;
      route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ total, estados:{ no_contado:0, negativa:neg, positiva:0, pendiente:0, cuadrado: total-neg }, personas:[{nombre:'Beto', n:Math.ceil(total/2)}, {nombre:'Ana', n:Math.floor(total/2)}] }) });
    });
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('#btn-ir-buscar');
    await page.waitForSelector('#b-texto', { timeout:ESPERA });
    await page.click('.buscar-btn');
    await page.waitForSelector('#buscar-progreso-carga', { timeout:ESPERA });
    assert(await esperarVisible(page, 'text=Los 1.218 resultados'), 'mientras carga el resto, los gráficos ya cuentan los 1.218');
    const textoCargando = await page.evaluate(() => document.body.textContent.replace(/\s+/g,' '));
    assert(textoCargando.includes('1.218 resultados') && textoCargando.includes('Cuadrado (974)') && textoCargando.includes('Diferencia negativa (244)') && !textoCargando.includes('Primeros 1000'), 'título y gráficos con el total real, no con los mil primeros, obtuvo '+textoCargando.slice(textoCargando.indexOf('resultados')-20, textoCargando.indexOf('resultados')+500));
    assert((await page.$$('[data-estado-clave]')).length===0, 'mientras falta cargar, las porciones no filtran');
    if(process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/buscar-1218-cargando-420.png', fullPage: true });
    soltarSegundaTanda();
    await page.waitForSelector('#buscar-progreso-carga', { state:'detached', timeout:ESPERA });
    assert(await esperarVisible(page, 'text=1–15 de 1.218'), 'terminada la carga, la tabla pagina sobre los 1.218');
    await page.click('span[data-estado-clave="Diferencia negativa"]');
    await page.waitForSelector('#btn-quitar-filtro-estado', { timeout:ESPERA });
    const textoFiltrado = await page.evaluate(() => document.body.textContent.replace(/\s+/g,' '));
    assert(textoFiltrado.includes('244 de 1218 resultados'), 'tocar una porción filtra sobre los 1.218, obtuvo '+textoFiltrado.slice(textoFiltrado.indexOf('Filtrando'), textoFiltrado.indexOf('Filtrando')+120));
    if(process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/buscar-1218-completo-420.png', fullPage: true });

    // Más ancha que el tope de carga completa: solo la primera tanda, gráficos del total.
    total = 5003;
    segundaTanda = Promise.resolve();
    await page.click('.buscar-btn');
    assert(await esperarVisible(page, 'text=Los 5.003 resultados'), 'con 5.003, los gráficos cuentan los 5.003');
    const textoAncho = await page.evaluate(() => document.body.textContent.replace(/\s+/g,' '));
    assert(textoAncho.includes('Mostrando los primeros 1.000 de 5.003') && textoAncho.includes('acota la búsqueda a 5.000 resultados o menos'), 'el aviso dice cuánto de la tabla está cargado y cómo filtrar por porción, obtuvo '+textoAncho.slice(textoAncho.indexOf('Mostrando'), textoAncho.indexOf('Mostrando')+300));
    const anchoPagina = await page.evaluate(() => document.documentElement.scrollWidth);
    assert(anchoPagina<=420, 'a 420 px la pantalla no se desborda, ancho '+anchoPagina);
    if(process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/buscar-5003-420.png', fullPage: true });
    await context.close();
  }

  // ===== Buscar: varias porciones a la vez en "Quién contó" y "Resumen por estado" (Joel, 14/10/2026) =====
  // Tocar dos personas suma sus filas; tocar luego un estado cruza con esas personas; otro toque
  // quita la porción. Todo en el navegador real a 420 px, por la leyenda (el área cómoda del dedo).
  {
    const context = await browser.newContext({ viewport:{ width:420, height:900 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('buscar-graficos: '+err.message));
    await mockearSupabaseApp(page, PERFIL_ADMIN_PRO);
    const fila = (id, quien, dif) => ({ sku_id:id, sku_code:id, descripcion:'Material '+id, bodega:'B501', ubicacion:'0102', storage_bin:null, batch:null, conteo_id:'c-'+id, cantidad_contada:5, estado: dif ? 'con_diferencia' : 'aprobado', diferencia:dif, fecha_conteo:'2026-10-10T12:00:00Z', fotos:[], clase_abc:'A', critico:false, fuera_de_plan:false, contado_por:quien, contado_por_id:'u-'+quien });
    const filas = [fila('M-1','Ana',0), fila('M-2','Ana',-2), fila('M-3','Beto',0), fila('M-4','Caro',3)];
    await page.route('**/rest/v1/rpc/filas_busqueda_skus**', route => route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(filas) }));
    await page.route('**/rest/v1/rpc/contar_busqueda_skus**', route => route.fulfill({ status:200, contentType:'application/json', body:'4' }));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.click('#btn-ir-buscar');
    await page.waitForSelector('#b-texto', { timeout:ESPERA });
    await page.click('.buscar-btn');
    assert(await esperarVisible(page, 'text=4 resultados'), 'la búsqueda trae los 4 materiales');
    const codigos = () => page.$$eval('.chk-buscar-fila', els => els.map(e => e.dataset.skuId).sort());
    await page.click('span[data-porcion-clave="Ana"]');
    await page.waitForSelector('#btn-quitar-filtro-contador', { timeout:ESPERA });
    await page.click('span[data-porcion-clave="Beto"]');
    await page.waitForFunction(() => document.body.innerText.includes('Ana, Beto'), null, { timeout:ESPERA });
    const anaBeto = await codigos();
    assert(JSON.stringify(anaBeto) === JSON.stringify(['M-1','M-2','M-3']), 'Ana y Beto juntos muestran sus 3 materiales, obtuvo '+JSON.stringify(anaBeto));
    await page.click('span[data-estado-clave="Cuadrado"]');
    await page.waitForSelector('#btn-quitar-filtro-estado', { timeout:ESPERA });
    const anaBetoCuadrado = await codigos();
    assert(JSON.stringify(anaBetoCuadrado) === JSON.stringify(['M-1','M-3']), 'con Cuadrado se cruza: solo lo cuadrado de Ana y Beto, obtuvo '+JSON.stringify(anaBetoCuadrado));
    await page.click('span[data-porcion-clave="Ana"]');
    await page.waitForFunction(() => !document.body.innerText.includes('Ana, Beto'), null, { timeout:ESPERA });
    const soloBeto = await codigos();
    assert(JSON.stringify(soloBeto) === JSON.stringify(['M-3']), 'otro toque sobre Ana la quita: queda Beto cuadrado, obtuvo '+JSON.stringify(soloBeto));
    const desbordeGraficos = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeGraficos <= 0, 'a 420 px Buscar no desborda con los filtros de los gráficos, obtuvo '+desbordeGraficos);
    if (process.env.E2E_CAPTURAS) await page.screenshot({ path: process.env.E2E_CAPTURAS + '/buscar-graficos-420.png', fullPage: true });
    await context.close();
  }

  // ===== El PDF de Buscar lo arma la app con pdf-lib (real, en Chromium) =====
  // El doble de pdf-lib de app.test.js prueba la maqueta; acá se carga la librería de verdad desde
  // app/lib, se incrustan una foto JPEG y el logo PNG de la empresa, y se revisa que salga un PDF
  // válido con las hojas que corresponden (4 fichas: resumen + 3 + 1).
  {
    const JPG_PRUEBA = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCpRRRXin0p/9k=', 'base64');
    const LOGO_PRUEBA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAAgCAYAAADZubxIAAAAiElEQVR4nO3awQmDQBBA0RgsIaklvST12YvWYhGmAwOCET7vXWcPA5+57TC/H9uNrPvVC3AugeMEjhM4TuA4geMEjht/PXhN6z/24KDl89ydu+A4geMEjhM4TuA4geMEjhM4TuA4geMEjhM4TuA4geMEjhv8i25zwXECxwkcJ3CcwHECxwkc9wXWdgerkwIbJgAAAABJRU5ErkJggg==';
    const context = await browser.newContext({ viewport:{ width:820, height:1100 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('pdf-buscar: '+err.message));
    const perfilPdf = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilPdf.empresas.logo = LOGO_PRUEBA_PNG;
    await mockearSupabaseApp(page, perfilPdf);
    await page.route('**/storage/v1/object/sign/**', route => {
      if(route.request().method()==='POST'){
        const ruta = route.request().url().split('/object/sign/fotos-inventario/')[1];
        return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify({ signedURL:'/object/sign/fotos-inventario/'+ruta+'?token=fake' }) });
      }
      return route.fulfill({ status:200, contentType:'image/jpeg', body: JPG_PRUEBA });
    });
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    const resultado = await Promise.race([
      page.evaluate(async () => {
        window.entregarArchivoPdf = (bytes, nombre) => { window.__pdf = { bytes: Array.from(bytes), nombre }; };
        const filas = [0,1,2,3].map(i => ({ sku_id:'s'+i, sku_code:'1037189'+i, descripcion:'FILTRO DE ACEITE MOTOR CAT 3512 NUMERO '+i, bodega:'B501', ubicacion:'0102', storage_bin:'N1E-330-F'+i, batch:null, clase_abc:'A', critico:i===0,
          conteo_id: i===3 ? null : 'c'+i, cantidad_contada: i===3 ? null : 12+i, estado:'aprobado', diferencia:0, fecha_conteo:'2026-09-10T14:32:00Z', fuera_de_plan:true, ciclo_nombre:'Q1-MEL1', observacion:null,
          fotos: i===1 ? [{ foto_url:'emp-1/foto1.jpg' }] : [], contado_por:'Joel Majmut' }));
        state.busqueda.resultados = filas; state.busqueda.seleccionados = filas.map(f => f.sku_id);
        await exportarSeleccionadosBusquedaPDF();
        return { pdf: window.__pdf || null, libCargada: typeof PDFLib !== 'undefined', exportando: state.busqueda.exportandoPdf };
      }),
      new Promise(res => setTimeout(() => res('TIMEOUT'), 30000)),
    ]);
    assert(resultado !== 'TIMEOUT', 'generar el PDF de Buscar no puede quedarse pegado (30 s)');
    if(resultado !== 'TIMEOUT'){
      assert(resultado.libCargada, 'pdf-lib se carga desde app/lib al exportar');
      assert(!!resultado.pdf && /^InventIA-materiales-\d{4}-\d{2}-\d{2}\.pdf$/.test(resultado.pdf.nombre), 'se entrega un archivo .pdf con la fecha en el nombre, obtuvo: '+JSON.stringify(resultado.pdf && resultado.pdf.nombre));
      const pdf = Buffer.from(resultado.pdf ? resultado.pdf.bytes : []);
      const texto = pdf.toString('latin1');
      assert(texto.startsWith('%PDF-1.'), 'el archivo empieza como PDF, obtuvo: '+texto.slice(0,10));
      const paginas = (texto.match(/\/Type \/Page(?!s)/g) || []).length;
      assert(paginas === 3, `4 fichas son 3 hojas (resumen + 3 + 1), salieron ${paginas}`);
      assert((texto.match(/\/Subtype \/Image/g) || []).length === 2, 'lleva dos imágenes: la foto de una ficha y el logo (una vez, reutilizado en cada hoja), obtuvo: '+(texto.match(/\/Subtype \/Image/g) || []).length);
      assert(!resultado.exportando, 'al terminar, el botón vuelve a "Exportar a PDF"');
    }
    await context.close();
  }

  // ===== La orden de compra impresa cabe en una hoja =====
  // Joel vio una hoja en blanco de más en el PDF de la orden. Acá se imprime una orden real
  // (proveedor completo, tres líneas, IVA y términos y condiciones) al PDF de Chromium y se
  // cuentan las páginas: tiene que ser una. Chromium no reproduce la causa vista en Safari (el
  // 100vh del body al imprimir), así que esto vigila lo que sí puede pasar acá: que el contenido
  // de la orden crezca hasta pasarse de la hoja sin que nadie lo note.
  {
    const context = await browser.newContext({ viewport:{ width:794, height:1123 } });
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('pdf-orden: '+err.message));
    const perfilOc = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    perfilOc.empresas.modulo_bodega_habilitado = true;
    perfilOc.empresas.terminos_orden_compra = 'Pago a 30 días contra factura.\nEntregar en bodega central, lunes a viernes de 8:00 a 17:00.\nGarantía mínima de 12 meses.';
    await mockearSupabaseApp(page, perfilOc);
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    await page.fill('#f-email', 'ana@minera-andes.cl');
    await page.fill('#f-pass', '123456');
    await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:ESPERA });
    await page.evaluate(() => {
      window.print = () => {};
      const lineas = [0,1,2].map(i => ({ sku_code:'1037189'+i, descripcion:'FILTRO DE ACEITE MOTOR CAT 3512 '+i, unidad_medida:'UN', cantidad:2+i, costo_unitario:18500 }));
      state.ordenes.lista = [{ id:'oc-1', numero:'OC-000007', proveedor_nombre:'FINNING CHILE S A', proveedor_rut:'91.081.000-6', proveedor_contacto:'Marcela Ríos',
        proveedor_email:'ventas@finning.cl', proveedor_telefono:'+56 2 2000 0000', proveedor_direccion:'Av. Industrial 1234, Santiago', afecta_iva:true, fecha:'2026-09-10',
        fecha_esperada:'2026-09-20', condiciones_pago:'30 días', lugar_entrega:'Bodega central', observacion:'Entregar con guía', usuario_nombre:'Ana Torres' }];
      state.ordenes.detalle = { id:'oc-1', lineas };
      return imprimirOrdenCompra('oc-1');
    });
    const contenido = await page.evaluate(() => document.getElementById('print-buscar').innerHTML);
    assert(contenido.includes('Orden de compra OC-000007') && contenido.includes('Términos y condiciones'), 'la orden quedó lista para imprimir, con sus términos');
    const pdf = await page.pdf({ format:'Letter', printBackground:true, preferCSSPageSize:true });
    const paginas = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length;
    assert(paginas === 1, `la orden de compra impresa tiene que caber en una hoja, salieron ${paginas}`);
    await context.close();
  }

  // ===== App: instalar InventIA (aviso, guía para iPhone y diálogo del navegador) =====
  {
    const OPERADOR = JSON.parse(JSON.stringify(PERFIL_ADMIN_PRO));
    OPERADOR.rol = 'operador'; OPERADOR.nombre = 'Beto Rojas';
    // iPhone en Safari: no hay diálogo del navegador, así que el botón abre los pasos.
    const ctxIphone = await browser.newContext({ viewport:{ width:420, height:900 }, isMobile:true, hasTouch:true,
      userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
    const pIphone = await ctxIphone.newPage();
    pIphone.on('pageerror', err => erroresPagina.push('instalar-iphone: '+err.message));
    await loguear(pIphone, OPERADOR);
    assert(await pIphone.isVisible('#banner-instalar-app'), 'en un iPhone sin instalar debe verse el aviso para instalar InventIA');
    const desbordeIphone = await pIphone.evaluate(()=> document.documentElement.scrollWidth - window.innerWidth);
    assert(desbordeIphone <= 0, `el aviso no debe desbordar a 420 px, desborda ${desbordeIphone}px`);
    await pIphone.click('#btn-banner-instalar');
    await pIphone.waitForSelector('#instalar-app-modal-backdrop', { timeout:ESPERA });
    const guia = await pIphone.textContent('#instalar-app-modal-backdrop');
    assert(guia.includes('Agregar a pantalla de inicio') && guia.includes('Compartir') && guia.includes('iPhone'), 'la guía de iPhone debe explicar Compartir → Agregar a pantalla de inicio, obtuvo: '+guia);
    await pIphone.click('#instalar-app-modal-listo');
    assert(!(await pIphone.isVisible('#instalar-app-modal-backdrop')), '"Entendido" debe cerrar la guía');
    await pIphone.click('#btn-banner-instalar-no');
    assert(!(await pIphone.isVisible('#banner-instalar-app')), '"Ahora no" debe ocultar el aviso');
    await pIphone.reload({ waitUntil:'networkidle' });
    await pIphone.waitForSelector('.tabbar', { timeout:ESPERA }).catch(async ()=>{
      await pIphone.fill('#f-email', 'ana@minera-andes.cl'); await pIphone.fill('#f-pass', '123456');
      await pIphone.click('#auth-form button[type="submit"]'); await pIphone.waitForSelector('.tabbar', { timeout:ESPERA });
    });
    assert(!(await pIphone.isVisible('#banner-instalar-app')), 'después de recargar, el "Ahora no" debe seguir respetándose');
    await pIphone.click('#btn-config');
    await pIphone.waitForSelector('#btn-config-instalar', { timeout:ESPERA });
    assert(await pIphone.isVisible('#btn-config-instalar'), 'Configuraciones debe seguir ofreciendo instalarla aunque se haya ocultado el aviso');
    await ctxIphone.close();

    // Chrome/Edge: el navegador ofrece instalarla (beforeinstallprompt) y el botón abre su diálogo.
    const ctxChrome = await browser.newContext({ viewport:{ width:1024, height:900 } });
    const pChrome = await ctxChrome.newPage();
    pChrome.on('pageerror', err => erroresPagina.push('instalar-chrome: '+err.message));
    await loguear(pChrome, OPERADOR);
    assert(!(await pChrome.isVisible('#banner-instalar-app')), 'en un computador, sin que el navegador ofrezca instalarla, no debe aparecer el aviso');
    await pChrome.evaluate(()=>{
      const ev = new Event('beforeinstallprompt', { cancelable:true });
      ev.prompt = ()=>{ window.__dialogosInstalar = (window.__dialogosInstalar||0) + 1; };
      ev.userChoice = Promise.resolve({ outcome:'accepted' });
      window.dispatchEvent(ev);
      window.__prevenido = ev.defaultPrevented;
    });
    await pChrome.waitForSelector('#banner-instalar-app', { timeout:ESPERA });
    assert(await pChrome.evaluate(()=> window.__prevenido), 'la app debe tomar el evento (preventDefault) para ofrecerlo con su propio botón');
    await pChrome.click('#btn-banner-instalar');
    await pChrome.waitForFunction(()=> !document.getElementById('banner-instalar-app'), null, { timeout:ESPERA });
    assert(await pChrome.evaluate(()=> window.__dialogosInstalar)===1, 'Instalar debe abrir el diálogo de instalación del navegador una vez');
    await ctxChrome.close();
  }

  assert(erroresPagina.length===0, 'no debe haber errores de JS no capturados en ninguna página, obtuvo: '+JSON.stringify(erroresPagina));

  await browser.close();
  server.close();

  if(fallos > 0){
    console.error(`\n${fallos} test(s) e2e fallaron.`);
    process.exit(1);
  }
  console.log('TODOS LOS TESTS E2E PASARON');
})();
