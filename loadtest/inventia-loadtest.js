// Prueba de carga real de InventIA contra Supabase en producción.
//
// Qué hace: simula gente contando inventario en varias empresas al mismo tiempo —
// carga la página de SKU, a veces revisa el color del último conteo, guarda un conteo,
// y de vez en cuando refresca el Dashboard — con pausas entre acciones como una persona
// real caminando/tipeando, no un martillazo continuo.
//
// Corre contra 5 empresas de prueba ya creadas en la base real (__LOADTEST_1__ .. _5__,
// 300 SKU cada una), completamente aisladas de Escondida y de tus clientes reales.
//
// CÓMO CORRERLO desde un GitHub Codespace (funciona desde el iPad, en Safari):
//   1. En github.com/jmajmut-arch/inventario, botón verde "Code" > pestaña "Codespaces" >
//      "Create codespace on main". Espera a que termine de construirse (unos 2-3 min la
//      primera vez) — k6 ya queda instalado solo, no hay que hacer nada más.
//   2. En la terminal que se abre, exporta las variables (copia/pega tal cual, cambiando
//      solo el Service Role Key):
//        export SUPABASE_URL="https://ncvwgsbcvklhbyvurxzz.supabase.co"
//        export SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jdndnc2JjdmtsaGJ5dnVyeHp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTcwMDAsImV4cCI6MjEwMjA3MzAwMH0.ElSrlTk0Mheb9P37BCGOLHqgGIxMVmoRLdpnlDSZYbE"
//        export SUPABASE_SERVICE_ROLE_KEY="<pégalo acá — Supabase > Project Settings > API > service_role. Es secreto, no lo subas a git>"
//        export EMPRESA_IDS="6c48f715-a2a3-4c04-a356-53d956443773,d66aad43-ac9d-49f4-8a4a-867639e8fcb1,32a41cca-f995-44e3-bfdb-edb3f0390f3d,b95a77fc-4bfa-4036-a3f0-8d2cd7ceba23,35e94cb9-1149-464e-8ccc-780109fde275"
//   3. Corre: k6 run loadtest/inventia-loadtest.js
//   4. Al terminar, k6 imprime un resumen con p95/p99 de latencia y % de errores por
//      endpoint. Si quieres graficarlo: agrega "--out json=resultado.json" al comando.
//
// Ajusta VUS_MAX y las stages más abajo si quieres una rampa más agresiva o más suave.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const SUPABASE_URL = __ENV.SUPABASE_URL;
const ANON_KEY = __ENV.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = __ENV.SUPABASE_SERVICE_ROLE_KEY;
const EMPRESA_IDS = (__ENV.EMPRESA_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const RUN_ID = `${Date.now()}`;
const MAX_VUS = Number(__ENV.MAX_VUS || 300);

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || EMPRESA_IDS.length === 0) {
  throw new Error('Faltan variables de entorno: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, EMPRESA_IDS');
}

const skuPageDuration = new Trend('sku_page_duration', true);
const dashboardDuration = new Trend('dashboard_duration', true);
const conteoInsertDuration = new Trend('conteo_insert_duration', true);
const ultimoConteoDuration = new Trend('ultimo_conteo_duration', true);
const errorRate = new Rate('errores');

export const options = {
  scenarios: {
    contando_inventario: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: Math.min(50, MAX_VUS) },   // arranque suave
        { duration: '2m', target: Math.min(150, MAX_VUS) },  // ritmo de un equipo grande
        { duration: '2m', target: MAX_VUS },                 // rampa hasta el techo a probar
        { duration: '3m', target: MAX_VUS },                 // sostenido, para ver si se degrada con el tiempo
        { duration: '1m', target: 0 },                        // enfriamiento
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    'errores': ['rate<0.01'],                    // menos de 1% de fallos
    'sku_page_duration': ['p(95)<800'],
    'dashboard_duration': ['p(95)<2000'],
    'conteo_insert_duration': ['p(95)<800'],
    'http_req_failed': ['rate<0.02'],
  },
};

// setup() corre UNA vez, antes de la rampa de VUs. Crea un usuario admin real por cada
// empresa de prueba (vía la Admin API — el camino oficial, no manipulando auth.users a mano)
// y lo deja logueado, para que las VUs solo tengan que reusar el token.
export function setup() {
  const usuarios = [];
  for (const empresaId of EMPRESA_IDS) {
    const email = `loadtest-${empresaId.slice(0, 8)}-${RUN_ID}@inventia-test.local`;
    const password = `LoadTest-${RUN_ID}-!Aa1`;

    const crear = http.post(`${SUPABASE_URL}/auth/v1/admin/users`, JSON.stringify({
      email, password, email_confirm: true,
      app_metadata: { empresa_id: empresaId, rol: 'admin', provider: 'email', providers: ['email'] },
      user_metadata: { nombre: 'Carga de prueba' },
    }), {
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });
    if (crear.status < 200 || crear.status >= 300) {
      throw new Error(`No se pudo crear el usuario de prueba para ${empresaId}: ${crear.status} ${crear.body}`);
    }
    const userId = JSON.parse(crear.body).id;

    // La Admin API de Supabase no siempre deja el app_metadata puesto en el mismo INSERT
    // (a veces lo agrega con un UPDATE aparte), así que el trigger que crea el perfil en
    // "usuarios" a partir de app_metadata puede no alcanzar a verlo. Se crea el perfil acá
    // directo, con la Service Role Key (salta RLS), para no depender de esa carrera de tiempos.
    const perfil = http.post(`${SUPABASE_URL}/rest/v1/usuarios?on_conflict=auth_user_id`, JSON.stringify({
      auth_user_id: userId, nombre: 'Carga de prueba', rol: 'admin', empresa_id: empresaId, activo: true,
    }), {
      headers: {
        'Content-Type': 'application/json',
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Prefer': 'return=minimal,resolution=merge-duplicates',
      },
    });
    if (perfil.status < 200 || perfil.status >= 300) {
      throw new Error(`No se pudo crear el perfil (usuarios) para ${empresaId}: ${perfil.status} ${perfil.body}`);
    }

    const login = http.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json', 'apikey': ANON_KEY },
    });
    if (login.status < 200 || login.status >= 300) {
      throw new Error(`No se pudo loguear el usuario de prueba para ${empresaId}: ${login.status} ${login.body}`);
    }
    const token = JSON.parse(login.body).access_token;
    usuarios.push({ empresaId, userId, token });
  }
  console.log(`Preparados ${usuarios.length} usuarios de prueba (empresas distintas).`);
  return { usuarios };
}

export default function (data) {
  const u = data.usuarios[__VU % data.usuarios.length];
  const headers = {
    'apikey': ANON_KEY,
    'Authorization': `Bearer ${u.token}`,
    'Content-Type': 'application/json',
  };

  // 1) Cargar SKU (como la pantalla "Cargar SKU" / "Tomar Inventario" al abrir)
  const skuRes = http.get(
    `${SUPABASE_URL}/rest/v1/skus?empresa_id=eq.${u.empresaId}&activo=eq.true&order=sku_code.asc&limit=30&select=id,sku_code,descripcion,bodega,stock_sistema`,
    { headers, tags: { name: 'sku_page' } }
  );
  skuPageDuration.add(skuRes.timings.duration);
  const okSku = check(skuRes, { 'sku page 200': (r) => r.status === 200 });
  errorRate.add(!okSku);

  let skuIds = [];
  try { skuIds = JSON.parse(skuRes.body).map(s => s.id); } catch (e) { /* respuesta vacía o con error, se ignora */ }

  // 2) A veces (como en la tabla de SKU con el nuevo color rojo/verde) consulta el último conteo.
  if (skuIds.length && Math.random() < 0.3) {
    const idsParam = skuIds.slice(0, 30).join(',');
    const uc = http.get(
      `${SUPABASE_URL}/rest/v1/ultimo_conteo_por_sku?sku_id=in.(${idsParam})&select=sku_id,estado`,
      { headers, tags: { name: 'ultimo_conteo' } }
    );
    ultimoConteoDuration.add(uc.timings.duration);
    errorRate.add(uc.status !== 200);
  }

  // 3) Guardar un conteo (la acción principal de "estar contando")
  if (skuIds.length) {
    const skuId = skuIds[Math.floor(Math.random() * skuIds.length)];
    const ins = http.post(`${SUPABASE_URL}/rest/v1/conteos`, JSON.stringify([{
      sku_id: skuId,
      empresa_id: u.empresaId,
      cantidad_contada: Math.floor(Math.random() * 100),
      capturado_en: new Date().toISOString(),
    }]), { headers: { ...headers, 'Prefer': 'return=minimal' }, tags: { name: 'conteo_insert' } });
    conteoInsertDuration.add(ins.timings.duration);
    const okIns = check(ins, { 'conteo insert 2xx': (r) => r.status >= 200 && r.status < 300 });
    errorRate.add(!okIns);
  }

  // 4) De vez en cuando, refresca el Dashboard (no en cada iteración — nadie lo hace tan seguido).
  if (Math.random() < 0.2) {
    // avance_total no tiene columna empresa_id: RLS ya limita el resultado a la empresa
    // del usuario logueado (mismo mecanismo que usa la app real).
    const dash = http.get(
      `${SUPABASE_URL}/rest/v1/avance_total`,
      { headers, tags: { name: 'dashboard' } }
    );
    dashboardDuration.add(dash.timings.duration);
    errorRate.add(dash.status !== 200);
  }

  // Tiempo de "pensar" entre acciones: caminar al siguiente SKU, tipear la cantidad, sacar
  // la foto. Sin esto la prueba mide "cuántos requests por segundo aguanta", no "cuánta
  // gente puede estar contando a la vez", que es la pregunta real.
  sleep(3 + Math.random() * 5);
}

// teardown() corre UNA vez al final. Borra los conteos y usuarios de prueba que este run
// creó, para no dejar basura acumulándose en producción con cada corrida.
export function teardown(data) {
  for (const u of data.usuarios) {
    http.del(`${SUPABASE_URL}/rest/v1/conteos?empresa_id=eq.${u.empresaId}`, null, {
      headers: { 'apikey': SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
    });
    http.del(`${SUPABASE_URL}/auth/v1/admin/users/${u.userId}`, null, {
      headers: { 'apikey': SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SERVICE_ROLE_KEY}` },
    });
  }
  console.log('Limpieza lista: conteos y usuarios de prueba borrados.');
}
