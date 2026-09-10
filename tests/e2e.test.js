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
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };

function iniciarServidor(){
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
      fs.readFile(filePath, (err, data) => {
        if(err){ res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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

async function mockearSupabaseApp(page, perfil){
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
  await page.waitForSelector('.tabbar', { timeout:5000 });
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
    await context.close();
  }

  // ===== Landing: honeypot silencioso (bot) no debe llamar a la red =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-honeypot: '+err.message));
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

  // ===== Landing: un envío humano normal sí llama a la red y muestra las credenciales =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-demo: '+err.message));
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

  // ===== Landing: formulario de contacto — honeypot silencioso no debe llamar a la red =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-contacto-honeypot: '+err.message));
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

  // ===== Landing: el acordeón de preguntas frecuentes abre con un click real =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-faq: '+err.message));
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
    await page.waitForSelector('.tabbar', { timeout:5000 });
    await page.click('[data-ir-vista="reservas"]');
    await page.waitForSelector('[data-reserva-ver="res-1"]', { timeout:5000 });
    assert(await page.isVisible('text=FALTA MATERIAL') || await page.isVisible('text=Falta material'), 'la reserva descubierta se avisa arriba de la lista');
    await page.click('[data-reserva-ver="res-1"]');
    await page.waitForSelector('[data-reserva-comprar="res-1"]', { timeout:5000 });
    assert(await page.isVisible('text=faltan 3'), 'el detalle muestra cuánto falta para cubrir la reserva');
    const sinDesbordeRes = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(sinDesbordeRes, 'el detalle de la reserva no debe desbordar a lo ancho en pantalla de celular');
    // El atajo que cierra el ciclo: el faltante se convierte en una orden de compra.
    await page.click('[data-reserva-comprar="res-1"]');
    await page.waitForSelector('[data-oc-cantidad]', { timeout:5000 });
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
    await page.waitForSelector('.tabbar', { timeout:5000 });
    // Se entra desde el Inicio de bodega, no desde la barra de pestañas (ya lleva cinco).
    await page.click('[data-ir-vista="ordenes"]');
    await page.waitForSelector('[data-oc-ver="oc-1"]', { timeout:5000 });
    await page.click('[data-oc-ver="oc-1"]');
    await page.waitForSelector('[data-oc-imprimir="oc-1"]', { timeout:5000 });
    assert(await page.isVisible('text=Marcela Ríos'), 'el detalle muestra el contacto del proveedor');
    const sinDesborde = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(sinDesborde, 'el detalle de la orden no debe desbordar a lo ancho en pantalla de celular');
    // "Recibir en Ingreso" lleva a la otra vista con las líneas pendientes ya cargadas.
    await page.click('[data-oc-recibir="oc-1"]');
    await page.waitForSelector('#bd-orden-compra', { timeout:5000 });
    const ocElegida = await page.inputValue('#bd-orden-compra');
    assert(ocElegida==='oc-1', 'el Ingreso queda enganchado a la orden, obtuvo: '+ocElegida);
    assert(await page.inputValue('#bd-oc')==='OC-000007', 'el número de la orden se copia al documento');
    const lineas = await page.$$eval('.bd-costo', els => els.length);
    assert(lineas===1, 'la línea pendiente se carga sola en el Ingreso, obtuvo: '+lineas);
    // Y el formulario de una orden nueva responde a los clicks reales.
    await page.click('[data-tab="inicio"]');
    await page.click('[data-ir-vista="ordenes"]');
    await page.waitForSelector('#btn-nueva-orden', { timeout:5000 });
    await page.click('#btn-nueva-orden');
    await page.waitForSelector('#oc-proveedor', { timeout:5000 });
    assert(await page.isVisible('#oc-buscar-sku'), 'el formulario de orden nueva trae el buscador de materiales');
    await context.close();
  }

  // ===== Bodega: el botón Transferir del maestro de Stock abre el modal de traslado =====
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
    await page.waitForSelector('.tabbar', { timeout:5000 });
    await page.click('[data-tab="stock"]');
    await page.waitForSelector('[data-transferir-sku]', { timeout:5000 });
    await page.click('[data-transferir-sku]');
    await page.waitForSelector('#transferencia-backdrop', { timeout:5000 });
    assert(await page.isVisible('#tra-bodega'), 'el modal de traslado debe abrirse desde el botón Transferir de Stock');
    const opciones = await page.$$eval('#tra-bodega option', els => els.map(e=>e.value));
    assert(opciones.includes('Bodega Norte'), 'el modal ofrece las bodegas de destino, obtuvo: '+JSON.stringify(opciones));
    const desborde = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    assert(desborde, 'el modal de traslado no debe desbordar a lo ancho en pantalla de celular');
    await page.click('#transferencia-cancelar');
    await page.waitForTimeout(200);
    assert(await page.$('#transferencia-backdrop') === null, 'Cancelar cierra el modal de traslado');
    await context.close();
  }

  // ===== Landing: los puntos del carrusel cambian la lámina activa =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-carousel: '+err.message));
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
    await page.addStyleTag({ content:'html{scroll-behavior:auto !important}' });
    await page.click('#vista-dots .carousel-dot:nth-child(2)');
    await page.waitForTimeout(600);
    const segundoActivo = await page.evaluate(() => document.querySelectorAll('#vista-dots .carousel-dot')[1].classList.contains('active'));
    assert(segundoActivo, 'al hacer click en el 2do punto del carrusel, debe quedar marcado como activo');
    await context.close();
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
