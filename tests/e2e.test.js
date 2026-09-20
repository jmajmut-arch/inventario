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
      assert(estado.fondo === 'rgb(250, 246, 238)', `${archivo}: assets/comun.css no aplicó, el fondo quedó en ${estado.fondo}`);
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
    // Y al revés: una página pública nueva que nadie agregó al sitemap no se indexa.
    for(const publica of fs.readdirSync(ROOT).filter(f => f.endsWith('.html'))){
      const esperada = publica === 'index.html' ? 'https://inventiapp.cl/' : 'https://inventiapp.cl/' + publica;
      assert(urls.includes(esperada), `${publica} es una página pública y no está en el sitemap: el buscador no la va a indexar`);
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
    await page.route('**/rest/v1/skus_lectura**', async route => {
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

  // ===== El PDF de Buscar lo arma la app con pdf-lib (real, en Chromium) =====
  // El doble de pdf-lib de app.test.js prueba la maqueta; acá se carga la librería de verdad desde
  // app/lib, se incrustan una foto JPEG y el logo PNG de la empresa, y se revisa que salga un PDF
  // válido con las hojas que corresponden (4 fichas: 2 + 2).
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
      assert(paginas === 2, `4 fichas son 2 hojas (2 + 2), salieron ${paginas}`);
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

  assert(erroresPagina.length===0, 'no debe haber errores de JS no capturados en ninguna página, obtuvo: '+JSON.stringify(erroresPagina));

  await browser.close();
  server.close();

  if(fallos > 0){
    console.error(`\n${fallos} test(s) e2e fallaron.`);
    process.exit(1);
  }
  console.log('TODOS LOS TESTS E2E PASARON');
})();
