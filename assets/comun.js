// Código compartido por index.html, bodega.html e inventario.html.
//
// Antes vivía entero dentro de index.html. Al separar el sitio en tres páginas, duplicarlo
// habría dejado los dos formularios de captación —lo único que convierte una visita en un
// contacto— existiendo en tres copias, y cada arreglo habría que hacerlo tres veces. Es la
// misma trampa de app/index.html y app/inventario.html, que ya obliga a copiar uno sobre otro
// antes de cada publicación.
//
// El HTML de los dos modales y el botón de WhatsApp se inyectan desde acá por la misma razón:
// un solo lugar donde tocarlos. El menú y el pie sí van en cada página, porque son enlaces
// internos y conviene que existan en el HTML aunque no corra el JavaScript.
//
// Se carga con defer, así que el DOM ya está armado cuando esto empieza.

(function () {
  'use strict';

  var SUPABASE_URL = 'https://ncvwgsbcvklhbyvurxzz.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jdndnc2JjdmtsaGJ5dnVyeHp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTcwMDAsImV4cCI6MjEwMjA3MzAwMH0.ElSrlTk0Mheb9P37BCGOLHqgGIxMVmoRLdpnlDSZYbE';

  function trackEvent(nombre, params) {
    if (typeof window.gtag === 'function') gtag('event', nombre, params || {});
  }
  window.trackEvent = trackEvent;

  // ---------------------------------------------------------------- enlaces viejos
  // La landing era una sola página con anclas. Cualquier enlace ya enviado a #bodega,
  // #inventario, #control, #resuelve o #funciona tiene que seguir llegando a destino.
  var DESTINOS = {
    '#bodega': 'bodega.html',
    '#inventario': 'inventario.html',
    '#control': 'inventario.html',
    '#resuelve': 'inventario.html',
    '#funciona': 'inventario.html'
  };
  var hash = location.hash;
  if (DESTINOS[hash] && !document.getElementById(hash.slice(1))) {
    location.replace(DESTINOS[hash]);
    return; // la página se va a reemplazar: no vale la pena armar nada más
  }

  // ---------------------------------------------------------------- menú
  var navToggle = document.getElementById('nav-toggle');
  var navLinks = document.getElementById('nav-links');
  if (navToggle && navLinks) {
    var cerrarMenuMovil = function () {
      navLinks.classList.remove('open');
      navToggle.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
      navToggle.setAttribute('aria-label', 'Abrir menú');
    };
    navToggle.addEventListener('click', function () {
      var abierto = navLinks.classList.toggle('open');
      navToggle.classList.toggle('open', abierto);
      navToggle.setAttribute('aria-expanded', abierto ? 'true' : 'false');
      navToggle.setAttribute('aria-label', abierto ? 'Cerrar menú' : 'Abrir menú');
    });
    navLinks.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', cerrarMenuMovil);
    });
  }

  // ---------------------------------------------------------------- modales y WhatsApp
  var trampa = function (id) {
    return '<div style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden" aria-hidden="true">'
      + '<label for="' + id + '">No completar este campo</label>'
      + '<input type="text" id="' + id + '" name="website" tabindex="-1" autocomplete="off"></div>';
  };

  var soporte = document.createElement('div');
  soporte.innerHTML = ''
    + '<div class="modal-backdrop" id="demo-modal-backdrop">'
    + '<div class="modal-card">'
    + '<button type="button" class="modal-close" id="demo-modal-close" aria-label="Cerrar">✕</button>'
    + '<div id="demo-modal-form-wrap">'
    + '<h3>Prueba Invent<span class="ia">IA</span> ahora</h3>'
    + '<p class="modal-sub">Te damos acceso a una bodega de ejemplo ya cargada, para que la explores tú mismo. Después, si te interesa, coordinamos un piloto real con tus propios datos.</p>'
    + '<form id="demo-form">'
    + '<label for="demo-nombre">Nombre</label><input type="text" id="demo-nombre" required autocomplete="name">'
    + '<label for="demo-email">Correo</label><input type="email" id="demo-email" required autocomplete="email">'
    + '<label for="demo-telefono">Teléfono</label><input type="tel" id="demo-telefono" required autocomplete="tel" placeholder="+56 9 1234 5678">'
    + '<label for="demo-empresa">Empresa <span style="font-weight:400;color:var(--text-faint)">(opcional)</span></label>'
    + '<input type="text" id="demo-empresa" autocomplete="organization">'
    + trampa('demo-web')
    + '<button type="submit" class="modal-submit" id="demo-submit-btn">Ver la demo</button>'
    + '<div class="modal-error" id="demo-error" style="display:none"></div>'
    + '</form></div>'
    + '<div id="demo-modal-ok" class="modal-ok">'
    + '<div class="check">✓</div><h3>Ya puedes entrar</h3>'
    + '<p class="modal-sub">Esta es una cuenta compartida de demostración: explórala con confianza, se restablece sola todas las noches.</p>'
    + '<div class="demo-creds"><div><span>Correo</span><span class="mono">demo@inventiapp.cl</span></div>'
    + '<div><span>Contraseña</span><span class="mono">DemoInventIA2026</span></div></div>'
    + '<a class="cta" id="demo-entrar-link" href="app/index.html" target="_blank" rel="noopener">Entrar a la demo ›</a>'
    + '<p class="modal-note">En las próximas 24 horas te escribimos para coordinar un piloto real y gratuito con el catálogo de tu propia bodega.</p>'
    + '</div></div></div>'

    + '<div class="modal-backdrop" id="contacto-modal-backdrop">'
    + '<div class="modal-card">'
    + '<button type="button" class="modal-close" id="contacto-modal-close" aria-label="Cerrar">✕</button>'
    + '<div id="contacto-modal-form-wrap">'
    + '<h3>Escríbenos</h3><p class="modal-sub">Cuéntanos qué necesitas y te respondemos a la brevedad.</p>'
    + '<form id="contacto-form">'
    + '<label for="contacto-nombre">Nombre</label><input type="text" id="contacto-nombre" required autocomplete="name">'
    + '<label for="contacto-email">Correo</label><input type="email" id="contacto-email" required autocomplete="email">'
    + '<label for="contacto-empresa">Empresa <span style="font-weight:400;color:var(--text-faint)">(opcional)</span></label>'
    + '<input type="text" id="contacto-empresa" autocomplete="organization">'
    + '<label for="contacto-mensaje">Mensaje</label>'
    + '<textarea id="contacto-mensaje" required rows="4" style="width:100%;font:inherit;padding:12px 14px;border-radius:12px;border:1px solid var(--line);background:var(--surface);color:var(--text);resize:vertical"></textarea>'
    + trampa('contacto-web')
    + '<button type="submit" class="modal-submit" id="contacto-submit-btn">Enviar mensaje</button>'
    + '<div class="modal-error" id="contacto-error" style="display:none"></div>'
    + '</form></div>'
    + '<div id="contacto-modal-ok" class="modal-ok"><div class="check">✓</div><h3>¡Recibido!</h3>'
    + '<p class="modal-sub">Gracias por escribirnos. Te respondemos a la brevedad.</p></div>'
    + '</div></div>'

    + '<a class="whatsapp-float" id="whatsapp-float-link" href="https://wa.me/56968372524?text=Hola%2C%20quiero%20saber%20m%C3%A1s%20de%20InventIA" target="_blank" rel="noopener" aria-label="Escríbenos por WhatsApp">'
    + '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm0 1.67c2.19 0 4.25.85 5.8 2.4a8.2 8.2 0 0 1 2.41 5.84c0 4.55-3.7 8.25-8.25 8.25a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.18 8.18 0 0 1-1.26-4.38c0-4.55 3.7-8.25 8.28-8.25zm-4.55 4.5c-.16 0-.42.06-.64.31-.22.25-.85.83-.85 2.03s.87 2.36.99 2.52c.12.16 1.7 2.72 4.2 3.7 2.08.82 2.5.66 2.95.62.45-.04 1.46-.6 1.66-1.18.2-.58.2-1.08.14-1.18-.06-.1-.22-.16-.46-.28-.24-.12-1.46-.72-1.68-.8-.23-.08-.39-.12-.56.12-.16.24-.64.8-.78.97-.14.16-.29.18-.53.06-.24-.12-1.02-.38-1.94-1.2-.72-.64-1.2-1.43-1.34-1.67-.14-.24-.02-.37.1-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.56-1.36-.78-1.86-.2-.49-.4-.42-.56-.43-.14-.01-.3-.01-.46-.01z"/></svg></a>';
  while (soporte.firstChild) document.body.appendChild(soporte.firstChild);

  var $ = function (id) { return document.getElementById(id); };

  // Un formulario de captación: mismo anti-spam, mismo envío, distintos campos.
  function armarFormulario(cfg) {
    var backdrop = $(cfg.prefijo + '-modal-backdrop');
    var formWrap = $(cfg.prefijo + '-modal-form-wrap');
    var ok = $(cfg.prefijo + '-modal-ok');
    var form = $(cfg.prefijo + '-form');
    var error = $(cfg.prefijo + '-error');
    var btn = $(cfg.prefijo + '-submit-btn');
    var abiertoEn = 0;

    function abrir(dato) {
      formWrap.style.display = '';
      if (cfg.alAbrir) cfg.alAbrir(dato);
      ok.classList.remove('open');
      error.style.display = 'none';
      backdrop.classList.add('open');
      abiertoEn = Date.now();
      trackEvent(cfg.eventoApertura, cfg.paramsApertura ? cfg.paramsApertura(dato) : undefined);
    }
    function cerrar() { backdrop.classList.remove('open'); }

    document.querySelectorAll('[' + cfg.atributoBoton + ']').forEach(function (b) {
      b.addEventListener('click', function (e) {
        if (b.tagName === 'A') e.preventDefault();
        abrir(b.getAttribute(cfg.atributoDato));
      });
    });
    $(cfg.prefijo + '-modal-close').addEventListener('click', cerrar);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) cerrar(); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      error.style.display = 'none';

      // Anti-spam silencioso: si el campo trampa viene lleno (típico de bots que
      // completan todos los campos del formulario) o si se envió casi al instante
      // de abrir el modal (nadie llena el formulario en menos de 2 segundos),
      // simulamos éxito sin insertar nada — así el bot no aprende que fue detectado.
      var esBot = $(cfg.prefijo + '-web').value.trim() !== '' || (Date.now() - abiertoEn) < 2000;
      if (esBot) { formWrap.style.display = 'none'; ok.classList.add('open'); return; }

      btn.disabled = true;
      btn.textContent = 'Enviando…';

      fetch(SUPABASE_URL + '/rest/v1/leads_demo', {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify([cfg.cuerpo()])
      }).then(function (res) {
        if (!res.ok) return res.json().catch(function () { return {}; }).then(function (data) {
          throw new Error((data && data.message) || cfg.errorGenerico);
        });
        formWrap.style.display = 'none';
        ok.classList.add('open');
        trackEvent('generate_lead', { lead_type: cfg.tipoLead });
      }).catch(function (err) {
        error.textContent = err.message;
        error.style.display = 'block';
      }).finally(function () {
        btn.disabled = false;
        btn.textContent = cfg.textoBoton;
      });
    });
  }

  armarFormulario({
    prefijo: 'demo',
    atributoBoton: 'data-abrir-demo',
    atributoDato: 'data-plan',
    eventoApertura: 'demo_modal_open',
    paramsApertura: function (plan) { return { plan: plan || 'general' }; },
    tipoLead: 'demo',
    textoBoton: 'Ver la demo',
    errorGenerico: 'No pudimos guardar tus datos. Intenta de nuevo.',
    cuerpo: function () {
      return {
        nombre: $('demo-nombre').value.trim(),
        email: $('demo-email').value.trim(),
        telefono: $('demo-telefono').value.trim(),
        empresa: $('demo-empresa').value.trim() || null
      };
    }
  });

  armarFormulario({
    prefijo: 'contacto',
    atributoBoton: 'data-abrir-contacto',
    atributoDato: 'data-mensaje',
    eventoApertura: 'contacto_modal_open',
    tipoLead: 'contacto',
    textoBoton: 'Enviar mensaje',
    errorGenerico: 'No pudimos enviar tu mensaje. Intenta de nuevo.',
    alAbrir: function (mensaje) { if (mensaje) $('contacto-mensaje').value = mensaje; },
    cuerpo: function () {
      return {
        tipo: 'contacto',
        nombre: $('contacto-nombre').value.trim(),
        email: $('contacto-email').value.trim(),
        empresa: $('contacto-empresa').value.trim() || null,
        mensaje: $('contacto-mensaje').value.trim()
      };
    }
  });

  $('demo-entrar-link').addEventListener('click', function () { trackEvent('demo_start'); });

  var waLink = $('whatsapp-float-link');
  if (waLink) waLink.addEventListener('click', function () { trackEvent('contact_whatsapp_click'); });

  // ---------------------------------------------------------------- carrusel (solo Inventario)
  var vistaTrack = $('vista-track');
  if (vistaTrack) {
    var vistaSlides = Array.prototype.slice.call(vistaTrack.children);
    var vistaDots = Array.prototype.slice.call(document.querySelectorAll('#vista-dots .carousel-dot'));
    var vistaPrev = $('vista-prev');
    var vistaNext = $('vista-next');
    var vistaActual = 0;

    var vistaIrA = function (i) {
      i = Math.max(0, Math.min(vistaSlides.length - 1, i));
      vistaTrack.scrollTo({ left: vistaSlides[i].offsetLeft, behavior: 'smooth' });
    };
    var vistaMarcarActiva = function (i) {
      vistaActual = i;
      vistaDots.forEach(function (dot, idx) { dot.classList.toggle('active', idx === i); });
    };

    vistaDots.forEach(function (dot, i) { dot.addEventListener('click', function () { vistaIrA(i); }); });
    vistaPrev.addEventListener('click', function () { vistaIrA(vistaActual - 1); });
    vistaNext.addEventListener('click', function () { vistaIrA(vistaActual + 1); });

    if ('IntersectionObserver' in window) {
      var vistaIo = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            vistaMarcarActiva(vistaSlides.indexOf(entry.target));
          }
        });
      }, { root: vistaTrack, threshold: [0.6] });
      vistaSlides.forEach(function (s) { vistaIo.observe(s); });
    }
  }

  // ---------------------------------------------------------------- aparición al bajar
  var els = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (el) { io.observe(el); });
  } else {
    els.forEach(function (el) { el.classList.add('in'); });
  }

  // ---------------------------------------------------------------- planes y correos
  // Suscribirme (Básico / Profesional): lleva a la pantalla de alta autoservicio de la app
  // (app/index.html?plan=basico|profesional, ver procesarRegistroPlanDesdeUrl), que crea la
  // empresa y redirige a Flow para registrar la tarjeta.
  document.querySelectorAll('[data-suscribir]').forEach(function (b) {
    b.addEventListener('click', function () {
      var plan = b.getAttribute('data-suscribir');
      trackEvent('subscribe_click', { plan: plan });
      window.location.href = 'app/index.html?plan=' + encodeURIComponent(plan);
    });
  });
  document.querySelectorAll('[data-track-mailto]').forEach(function (a) {
    a.addEventListener('click', function () { trackEvent('contact_email_click', { origen: a.getAttribute('data-track-mailto') }); });
  });
})();
