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
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'networkidle' });
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
    await page.goto(`http://localhost:${PORT}/inicio/index.html`, { waitUntil:'networkidle' });
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
    await page.goto(`http://localhost:${PORT}/inicio/index.html`, { waitUntil:'networkidle' });
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

  // ===== Landing: el acordeón de preguntas frecuentes abre con un click real =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-faq: '+err.message));
    await page.goto(`http://localhost:${PORT}/inicio/index.html`, { waitUntil:'networkidle' });
    const primeraPregunta = await page.$('.faq-item summary');
    assert(primeraPregunta !== null, 'debe existir al menos una pregunta frecuente');
    const detalleAbierto = await page.evaluate(() => document.querySelector('.faq-item').open);
    assert(detalleAbierto === false, 'la pregunta debe empezar cerrada');
    await primeraPregunta.click();
    const detalleTrasClick = await page.evaluate(() => document.querySelector('.faq-item').open);
    assert(detalleTrasClick === true, 'un click en la pregunta debe abrirla');
    await context.close();
  }

  // ===== Landing: los puntos del carrusel cambian la lámina activa =====
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', err => erroresPagina.push('landing-carousel: '+err.message));
    await page.goto(`http://localhost:${PORT}/inicio/index.html`, { waitUntil:'networkidle' });
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
