// Prueba de carga de InventIA contra Supabase en producción: cuántas personas pueden estar
// contando a la vez sin que la app se ponga lenta.
//
// Cada usuario virtual (VU) es UNA persona real, con el ritmo medido en terreno (Escondida, 60
// días hasta el 13/10/2026: como máximo 2 conteos por minuto por persona) y las mismas llamadas
// que hace la app hoy:
//   - Contador (9 de cada 10 VU): busca el material (dos búsquedas mientras escribe, por
//     buscar_skus_lectura), guarda el conteo (POST /conteos con idempotency_key, como
//     guardarConteo), sube la foto al bucket en 8 de cada 10 conteos (~400 KB, el promedio real
//     es 423 KB) y la asocia en conteo_fotos; cada 5 conteos refresca el plan de la semana
//     (plan_ventana_pantalla) y cada 10 revisa la sesión (mi_estado_bloqueo,
//     tengo_otra_sesion_activa). Entre conteo y conteo, 20 a 40 s: caminar, buscar el bin,
//     contar.
//   - Supervisor (1 de cada 10 VU): abre el Dashboard (dashboard_ejecutivo) y el plan del mes
//     cada 60 a 120 s.
//
// Corre por niveles (NIVELES, p. ej. "50,100,200"): cada nivel es un escenario de VU constantes
// que dura MINUTOS_POR_NIVEL, uno detrás de otro, y el resumen sale separado por nivel. Si los
// errores pasan del 5% la prueba se corta sola, para no seguir castigando producción.
//
// Usa empresas de prueba creadas para esto (EMPRESA_IDS, la primera es la grande), nunca las
// de clientes. setup() crea un usuario por empresa; teardown() borra las fotos subidas. Los
// conteos, los usuarios y las empresas se borran aparte, con loadtest/limpieza_manual.sql.
//
// Se corre desde GitHub: Actions -> "Prueba de carga (k6)" -> Run workflow.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import exec from 'k6/execution';

const SUPABASE_URL = __ENV.SUPABASE_URL;
const ANON_KEY = __ENV.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = __ENV.SUPABASE_SERVICE_ROLE_KEY;
const EMPRESA_IDS = (__ENV.EMPRESA_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const NIVELES = (__ENV.NIVELES || '50,100,200,300,500').split(',').map(Number).filter(n => n > 0);
const MINUTOS = Number(__ENV.MINUTOS_POR_NIVEL || 3);
const RAMPA_S = 45;
const RUN_ID = `${Date.now()}`;
const BUCKET = 'fotos-inventario';
const FOTO = open('./foto-prueba.jpg', 'b');

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || EMPRESA_IDS.length === 0) {
  throw new Error('Faltan variables de entorno: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, EMPRESA_IDS');
}

const ACCIONES = ['buscar', 'guardar', 'foto', 'plan', 'sesion', 'dashboard'];
const tiempo = {};
for (const a of ACCIONES) tiempo[a] = new Trend(`t_${a}`, true);
const errores = new Rate('errores');
const conteosGuardados = new Counter('conteos_guardados');

// Un escenario por nivel, en fila. Cada uno parte con una rampa corta (los VU de un nivel nuevo
// arrancan desfasados, como gente que va llegando) y mide solo lo que pasa en su ventana.
const scenarios = {};
const thresholds = {
  errores: [{ threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '60s' }],
};
NIVELES.forEach((vus, i) => {
  const nombre = `n${String(vus).padStart(4, '0')}`;
  scenarios[nombre] = {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [{ duration: `${RAMPA_S}s`, target: vus }, { duration: `${MINUTOS}m`, target: vus }],
    gracefulRampDown: '20s',
    startTime: `${i * (RAMPA_S + MINUTOS * 60 + 25)}s`,
    tags: { nivel: nombre },
  };
  // Umbrales "de registro": no cortan nada, sirven para que el resumen traiga cada nivel aparte.
  thresholds[`http_req_failed{nivel:${nombre}}`] = ['rate<1'];
  thresholds[`errores{nivel:${nombre}}`] = ['rate<1'];
  thresholds[`http_reqs{nivel:${nombre}}`] = ['count>=0'];
  thresholds[`conteos_guardados{nivel:${nombre}}`] = ['count>=0'];
  for (const a of ACCIONES) thresholds[`t_${a}{nivel:${nombre}}`] = ['p(95)<600000'];
});

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '120s',
  teardownTimeout: '300s',
};

function srv(path, method, body, extra = {}) {
  return http.request(method, `${SUPABASE_URL}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', ...extra },
  });
}

export function setup() {
  const usuarios = [];
  for (const empresaId of EMPRESA_IDS) {
    const email = `carga-${empresaId.slice(0, 8)}-${RUN_ID}@inventia-test.local`;
    const password = `Carga-${RUN_ID}-!Aa1`;
    const crear = srv('/auth/v1/admin/users', 'POST', {
      email, password, email_confirm: true,
      app_metadata: { empresa_id: empresaId, rol: 'admin', provider: 'email', providers: ['email'] },
      user_metadata: { nombre: 'Prueba de carga' },
    });
    if (crear.status < 200 || crear.status >= 300) throw new Error(`No se pudo crear el usuario de ${empresaId}: ${crear.status} ${crear.body}`);
    const authId = JSON.parse(crear.body).id;
    const perfil = srv('/rest/v1/usuarios?on_conflict=auth_user_id&select=id', 'POST',
      { auth_user_id: authId, nombre: 'Prueba de carga', rol: 'admin', empresa_id: empresaId, activo: true },
      { Prefer: 'return=representation,resolution=merge-duplicates' });
    if (perfil.status < 200 || perfil.status >= 300) throw new Error(`No se pudo crear el perfil de ${empresaId}: ${perfil.status} ${perfil.body}`);
    const perfilId = JSON.parse(perfil.body)[0].id;
    const login = http.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, JSON.stringify({ email, password }),
      { headers: { 'Content-Type': 'application/json', apikey: ANON_KEY } });
    if (login.status !== 200) throw new Error(`No se pudo iniciar sesión en ${empresaId}: ${login.status} ${login.body}`);
    // Códigos reales de la empresa para buscar (prefijo C<n>, ver la siembra de datos)
    const muestra = srv(`/rest/v1/skus?empresa_id=eq.${empresaId}&select=sku_code,descripcion&limit=400&order=sku_code`, 'GET');
    const skus = JSON.parse(muestra.body);
    if (!skus.length) throw new Error(`La empresa ${empresaId} no tiene materiales para buscar`);
    usuarios.push({ empresaId, authId, perfilId, token: JSON.parse(login.body).access_token, skus });
  }
  console.log(`Preparados ${usuarios.length} usuarios. Niveles: ${NIVELES.join(', ')} personas, ${MINUTOS} min cada uno.`);
  return { usuarios };
}

function uuid() {
  const h = '0123456789abcdef'; let s = '';
  for (let i = 0; i < 36; i++) s += [8, 13, 18, 23].includes(i) ? '-' : (i === 14 ? '4' : h[Math.floor(Math.random() * 16)]);
  return s;
}

function registrar(accion, res, ok) {
  tiempo[accion].add(res.timings.duration);
  errores.add(!ok);
  if (!ok && Math.random() < 0.02) console.warn(`${accion} ${res.status}: ${String(res.body).slice(0, 160)}`);
}

// 4 de cada 10 VU trabajan en la empresa grande (80.000 materiales, como Escondida).
function usuarioDe(data) {
  const n = data.usuarios.length;
  const r = (exec.vu.idInTest * 7919) % 10;
  return n === 1 || r < 4 ? data.usuarios[0] : data.usuarios[1 + (exec.vu.idInTest % (n - 1))];
}

const hoy = () => new Date().toISOString().slice(0, 10);
const masDias = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

export default function (data) {
  const u = usuarioDe(data);
  const h = { apikey: ANON_KEY, Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' };
  const esSupervisor = exec.vu.idInTest % 10 === 0;
  const iter = exec.vu.iterationInScenario;

  // Primera vuelta de cada VU: desfase al azar, para que no lleguen todos en el mismo segundo.
  if (iter === 0) sleep(Math.random() * 20);

  if (esSupervisor) {
    const d = http.post(`${SUPABASE_URL}/rest/v1/rpc/dashboard_ejecutivo`, JSON.stringify({ p_dias: 14, p_criticidad: null }), { headers: h, tags: { accion: 'dashboard' } });
    registrar('dashboard', d, check(d, { 'dashboard 200': r => r.status === 200 }));
    const p = http.post(`${SUPABASE_URL}/rest/v1/rpc/plan_ventana_pantalla`, JSON.stringify({ p_desde: '2026-10-01', p_hasta: '2026-10-31', p_resumido: true }), { headers: h, tags: { accion: 'plan' } });
    registrar('plan', p, check(p, { 'plan 200': r => r.status === 200 }));
    sleep(60 + Math.random() * 60);
    return;
  }

  // 1) Buscar: primero un trozo (lo que alcanzó a escribir), después el texto completo.
  const sku = u.skus[Math.floor(Math.random() * u.skus.length)];
  const porCodigo = Math.random() < 0.6;
  const completo = porCodigo ? sku.sku_code : sku.descripcion.split(' ').slice(0, 2).join(' ');
  const parcial = porCodigo ? completo.slice(0, 6) : completo.slice(0, Math.max(3, completo.length - 3));
  const sel = 'select=id,sku_code,descripcion,bodega,ubicacion,storage_bin,batch,stock_sistema,unidad_medida,critico,clase_abc';
  let elegido = null;
  for (const t of [parcial, completo]) {
    const b = http.post(`${SUPABASE_URL}/rest/v1/rpc/buscar_skus_lectura?${sel}`, JSON.stringify({ p_texto: t, p_limite: 8 }), { headers: h, tags: { accion: 'buscar' } });
    const ok = check(b, { 'buscar 200': r => r.status === 200 });
    registrar('buscar', b, ok);
    if (ok) { try { const filas = JSON.parse(b.body); if (filas.length) elegido = filas[0]; } catch (e) { /* respuesta rara: cuenta como error arriba */ } }
    sleep(1 + Math.random() * 2);
  }
  if (!elegido) { sleep(20); return; }

  // 2) Guardar el conteo, igual que guardarConteo.
  sleep(3 + Math.random() * 5); // contar y tipear la cantidad
  const clave = uuid();
  const g = http.post(`${SUPABASE_URL}/rest/v1/conteos?on_conflict=idempotency_key`, JSON.stringify([{
    sku_id: elegido.id, usuario_id: u.perfilId, empresa_id: u.empresaId,
    cantidad_contada: Math.max(0, Number(elegido.stock_sistema || 0) + (Math.random() < 0.15 ? -2 : 0)),
    ubicacion_contada: elegido.ubicacion || null, bodega: elegido.bodega || null, observacion: null,
    capturado_en: new Date().toISOString(), fuera_de_plan: Math.random() < 0.3, ubicacion_distinta: false, idempotency_key: clave,
  }]), { headers: { ...h, Prefer: 'resolution=ignore-duplicates,return=representation' }, tags: { accion: 'guardar' } });
  const okG = check(g, { 'guardar 201': r => r.status === 201 });
  registrar('guardar', g, okG);
  let conteoId = null;
  if (okG) { try { conteoId = JSON.parse(g.body)[0].id; conteosGuardados.add(1); } catch (e) { /* sin fila */ } }

  // 3) Foto (8 de cada 10 conteos), a la misma ruta que usa la app, y su fila en conteo_fotos.
  if (conteoId && Math.random() < 0.8) {
    // Misma carpeta de empresa que la app (la que revisa la política del bucket); la subcarpeta
    // fija en vez del código del material es solo para poder borrar todo al final de una vez.
    const ruta = `${u.empresaId}/__carga__/${clave}-0.jpg`;
    const f = http.post(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${ruta}`, FOTO,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${u.token}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, tags: { accion: 'foto' } });
    const okF = check(f, { 'foto 200': r => r.status === 200 });
    registrar('foto', f, okF);
    if (okF) {
      const cf = http.post(`${SUPABASE_URL}/rest/v1/conteo_fotos?on_conflict=foto_url`, JSON.stringify([{ conteo_id: conteoId, foto_url: ruta }]),
        { headers: { ...h, Prefer: 'resolution=ignore-duplicates,return=minimal' }, tags: { accion: 'foto' } });
      registrar('foto', cf, check(cf, { 'conteo_fotos 2xx': r => r.status >= 200 && r.status < 300 }));
    }
  }

  // 4) Cada 5 conteos refresca el plan de la semana; cada 10, la sesión (al volver a primer plano).
  if (iter % 5 === 4) {
    const p = http.post(`${SUPABASE_URL}/rest/v1/rpc/plan_ventana_pantalla`, JSON.stringify({ p_desde: masDias(-3), p_hasta: masDias(3), p_resumido: false }), { headers: h, tags: { accion: 'plan' } });
    registrar('plan', p, check(p, { 'plan 200': r => r.status === 200 }));
  }
  if (iter % 10 === 9) {
    for (const fn of ['mi_estado_bloqueo', 'tengo_otra_sesion_activa']) {
      const s = http.post(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, '{}', { headers: h, tags: { accion: 'sesion' } });
      registrar('sesion', s, check(s, { 'sesion 200': r => r.status === 200 }));
    }
  }

  // Caminar al siguiente material.
  sleep(20 + Math.random() * 20);
}

export function teardown(data) {
  // Solo las fotos: los archivos del bucket se borran por la API de Storage. Los conteos, los
  // usuarios y las empresas de prueba se borran después con loadtest/limpieza_manual.sql.
  for (const u of data.usuarios) {
    let borradas = 0;
    for (let vuelta = 0; vuelta < 500; vuelta++) {
      const l = srv(`/storage/v1/object/list/${BUCKET}`, 'POST', { prefix: `${u.empresaId}/__carga__/`, limit: 1000, offset: 0 });
      let objetos = [];
      try { objetos = JSON.parse(l.body); } catch (e) { break; }
      if (!Array.isArray(objetos) || !objetos.length) break;
      const rutas = objetos.map(o => `${u.empresaId}/__carga__/${o.name}`);
      const d = srv(`/storage/v1/object/${BUCKET}`, 'DELETE', { prefixes: rutas });
      if (d.status !== 200) { console.warn(`No se pudieron borrar fotos de ${u.empresaId}: ${d.status}`); break; }
      borradas += rutas.length;
    }
    console.log(`Limpieza ${u.empresaId}: ${borradas} fotos de prueba borradas.`);
  }
}

// Resumen por nivel, en una tabla que se lee directo en el registro de GitHub Actions.
export function handleSummary(data) {
  const m = data.metrics;
  const v = (k, s) => (m[k] && m[k].values && m[k].values[s] !== undefined ? m[k].values[s] : null);
  const ms = (x) => (x === null ? '   -  ' : (x >= 1000 ? `${(x / 1000).toFixed(1)}s` : `${Math.round(x)}ms`).padStart(6));
  const lineas = ['', 'RESULTADO POR NIVEL (tiempos p95 = el 95% de las respuestas tardó menos que esto)', ''];
  lineas.push('personas | req/s | errores | conteos |  buscar  guardar   foto    plan   sesion  dashboard | buscar p50 guardar p50');
  NIVELES.forEach((vus) => {
    const n = `n${String(vus).padStart(4, '0')}`;
    const reqs = v(`http_reqs{nivel:${n}}`, 'count');
    const dur = RAMPA_S + MINUTOS * 60;
    const err = v(`errores{nivel:${n}}`, 'rate');
    lineas.push([
      String(vus).padStart(8), (reqs === null ? '-' : (reqs / dur).toFixed(1)).padStart(5),
      (err === null ? '-' : `${(err * 100).toFixed(2)}%`).padStart(7), String(v(`conteos_guardados{nivel:${n}}`, 'count') ?? '-').padStart(7),
      ...ACCIONES.map(a => ms(v(`t_${a}{nivel:${n}}`, 'p(95)'))),
      ms(v(`t_buscar{nivel:${n}}`, 'med')), ms(v(`t_guardar{nivel:${n}}`, 'med')),
    ].join(' | '));
  });
  lineas.push('');
  return { stdout: lineas.join('\n') + '\n', 'resultado-loadtest.json': JSON.stringify(data, null, 1) };
}
