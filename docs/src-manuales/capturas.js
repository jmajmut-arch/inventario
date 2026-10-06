// Capturas de pantalla de los manuales (docs/src-manuales/img/*.png), con una empresa ficticia
// ("Minera Andes") y datos inventados: nunca con datos reales de un cliente. Levanta la app en un
// servidor local, simula Supabase con rutas de Playwright y fotografía cada pantalla a 412 px de
// ancho con factor 2 (824 px), como las capturas originales.
//
// Uso (desde la raíz del repo, con el mismo Chromium de las pruebas e2e):
//   PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node docs/src-manuales/capturas.js
// Después: python3 docs/src-manuales/render.py usuario.html ../InventIA-Manual-de-Usuario.pdf "InventIA · Manual de usuario"
const { chromium } = require('../../node_modules/playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(__dirname, 'img');
const PORT = 8960;
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };

// ---------- Datos ficticios ----------
const hoy = new Date(); hoy.setHours(0,0,0,0);
const iso = d => { const z = new Date(d.getTime() - d.getTimezoneOffset()*60000); return z.toISOString().slice(0,10); };
const dias = n => { const d = new Date(hoy); d.setDate(d.getDate()+n); return iso(d); };
const ts = (n, h) => `${dias(n)}T${String(h).padStart(2,'0')}:12:00+00:00`;

const PERFIL = {
  id:'perfil-1', nombre:'Ana Torres', rol:'admin', es_super_admin:false, empresa_id:'emp-1', auth_user_id:'auth-1', activo:true,
  empresas:{ id:'emp-1', nombre:'Minera Andes', codigo_invitacion:'ANDES2026', logo:null, conteo_ciego:false, foto_obligatoria:false, stock_cero_en_plan:true,
    plan_id:'plan-pro', planes:{ nombre:'profesional', etiqueta:'Profesional', max_bodegas:null, max_usuarios:15, offline_habilitado:true, dashboard_ejecutivo_habilitado:true, auditoria_habilitada:true, precio_mensual:149000 } },
};
const PERSONAS = [
  { id:'perfil-1', nombre:'Ana Torres', rol:'admin', activo:true, email:'ana.torres@mineraandes.cl', created_at:'2026-03-02T12:00:00Z' },
  { id:'u-pedro', nombre:'Pedro Soto', rol:'operador', activo:true, email:'pedro.soto@mineraandes.cl', created_at:'2026-03-05T12:00:00Z' },
  { id:'u-ana-s', nombre:'Ana Silva', rol:'operador', activo:true, email:'ana.silva@mineraandes.cl', created_at:'2026-04-11T12:00:00Z' },
  { id:'u-carla', nombre:'Carla Muñoz', rol:'operador', activo:true, email:'carla.munoz@mineraandes.cl', created_at:'2026-06-20T12:00:00Z' },
];
const CICLOS = [
  { id:'c-t4', nombre:'T4 2026', es_actual:true, fecha_inicio:'2026-10-01' },
  { id:'c-t3', nombre:'T3 2026', es_actual:false, fecha_inicio:'2026-07-01' },
];
const SKU = (n, extra) => Object.assign({
  id:'s-'+n.sku_code, sku_code:n.sku_code, descripcion:n.descripcion, bodega:n.bodega||'Bodega Central', ubicacion:n.ubicacion||'Pasillo 3', storage_bin:n.storage_bin||null,
  batch:null, unidad_medida:n.unidad_medida||'EA', stock_sistema:n.stock_sistema==null? 10 : n.stock_sistema, costo_unitario:n.costo_unitario||12000, critico:!!n.critico, clase_abc:n.clase_abc||'B',
  categoria:n.categoria||'Repuestos', activo:true, codigo_barras:null, stock_bloqueado:0, stock_transito_1:0, stock_transito_2:0, stock_transferencia:0, stock_consignado:null, stock_en_proveedor:null,
  total_bloqueado:0, total_transito_1:0, total_transito_2:0, total_transferencia:0, total_consignado:0, total_en_proveedor:0, stock_minimo:null,
}, n, extra||{});
const SKUS = [
  SKU({ sku_code:'4400-1123', descripcion:'Filtro hidráulico 3"', storage_bin:'A-12', stock_sistema:14, costo_unitario:18500, clase_abc:'A', critico:true, categoria:'Filtros', ultimoEstado:'con_diferencia', ultimaDiferencia:-2 }),
  SKU({ sku_code:'4402-0044', descripcion:'Rodamiento SKF 6205', storage_bin:'A-12', stock_sistema:32, costo_unitario:6900, clase_abc:'A', categoria:'Rodamientos', ultimoEstado:'aprobado', ultimaDiferencia:0 }),
  SKU({ sku_code:'4410-0210', descripcion:'Correa trapezoidal B-52', storage_bin:'A-13', stock_sistema:8, costo_unitario:4200, clase_abc:'B', categoria:'Transmisión' }),
  SKU({ sku_code:'4420-0005', descripcion:'Aceite hidráulico ISO 68, 20 L', bodega:'Bodega Norte', ubicacion:'Rack 2', storage_bin:'B-01', unidad_medida:'UN', stock_sistema:40, costo_unitario:52000, clase_abc:'A', categoria:'Lubricantes', ultimoEstado:'con_diferencia', ultimaDiferencia:3 }),
  SKU({ sku_code:'4431-0087', descripcion:'Sello mecánico 1 1/2"', bodega:'Bodega Norte', ubicacion:'Rack 2', storage_bin:'B-02', stock_sistema:6, costo_unitario:31000, clase_abc:'B', critico:true, categoria:'Sellos' }),
  SKU({ sku_code:'4450-0012', descripcion:'Perno M16x60 zincado', storage_bin:'A-13', stock_sistema:250, costo_unitario:180, clase_abc:'C', categoria:'Ferretería', ultimoEstado:'aprobado', ultimaDiferencia:0 }),
];
const UBICACIONES = [
  { id:'ub-1', bodega:'Bodega Central', ubicacion:null, activo:true }, { id:'ub-2', bodega:'Bodega Central', ubicacion:'Pasillo 3', activo:true },
  { id:'ub-3', bodega:'Bodega Norte', ubicacion:null, activo:true }, { id:'ub-4', bodega:'Bodega Norte', ubicacion:'Rack 2', activo:true },
];
const GENERALES = [ { bodega:'Bodega Central', cantidad_skus:140, cantidad_pendiente:36 }, { bodega:'Bodega Norte', cantidad_skus:95, cantidad_pendiente:40 } ];
const ESPECIFICAS = [ { bodega:'Bodega Central', ubicacion:'Pasillo 3', cantidad_skus:44, cantidad_pendiente:36 }, { bodega:'Bodega Norte', ubicacion:'Rack 2', cantidad_skus:51, cantidad_pendiente:40 } ];
const BINS = [ { bodega:'Bodega Central', ubicacion:'Pasillo 3', storage_bin:'A-12', cantidad_skus:4 }, { bodega:'Bodega Central', ubicacion:'Pasillo 3', storage_bin:'A-13', cantidad_skus:4 } ];

const ENTRADAS = [
  { id:'e1', fecha:dias(0), bodega:'Bodega Central', ubicacion:'Pasillo 3', storage_bin:'A-12', por_sku:false, ciclo_id:'c-t4', ciclo_nombre:'T4 2026', responsable_id:'u-ana-s', responsable_nombre:'Ana Silva', nota:'Revisar merma', skus_excluidos:[], skus_incluidos:[], ubicacion_nula:false, solo_sin_ubicacion:false, usuario_id:'perfil-1', created_at:ts(-3,10) },
  { id:'e2', fecha:dias(0), bodega:'Bodega Central', ubicacion:'Pasillo 3', storage_bin:'A-13', por_sku:false, ciclo_id:'c-t4', ciclo_nombre:'T4 2026', responsable_id:null, responsable_nombre:null, nota:null, skus_excluidos:[], skus_incluidos:[], ubicacion_nula:false, solo_sin_ubicacion:false, usuario_id:'perfil-1', created_at:ts(-3,10) },
  { id:'e3', fecha:dias(1), bodega:'Bodega Norte', ubicacion:'Rack 2', storage_bin:null, por_sku:false, ciclo_id:'c-t4', ciclo_nombre:'T4 2026', responsable_id:'u-pedro', responsable_nombre:'Pedro Soto', nota:null, skus_excluidos:[], skus_incluidos:[], ubicacion_nula:false, solo_sin_ubicacion:false, usuario_id:'perfil-1', created_at:ts(-2,10) },
];
const UNIVERSO = { e1:[SKUS[0], SKUS[1]], e2:[SKUS[2], SKUS[5]], e3:[SKUS[3], SKUS[4]] };

const DASH = {
  total:[ { bodega:'Bodega Central', skus_universo:140, skus_contados:109, porcentaje_avance:77.9 }, { bodega:'Bodega Norte', skus_universo:95, skus_contados:55, porcentaje_avance:57.9 } ],
  diario:[ { dia:ts(-1,3), bodega:'Bodega Central', reconteos:2, skus_contados:18, con_diferencia:3, total_unidades_contadas:412 }, { dia:ts(-2,3), bodega:'Bodega Norte', reconteos:0, skus_contados:12, con_diferencia:1, total_unidades_contadas:208 }, { dia:ts(-4,3), bodega:'Bodega Central', reconteos:1, skus_contados:21, con_diferencia:4, total_unidades_contadas:530 }, { dia:ts(-5,3), bodega:'Bodega Central', reconteos:0, skus_contados:15, con_diferencia:2, total_unidades_contadas:301 }, { dia:ts(-7,3), bodega:'Bodega Norte', reconteos:1, skus_contados:9, con_diferencia:0, total_unidades_contadas:122 } ],
  semanal:[ { bodega:'Bodega Central', semana:ts(-7,3), reconteos:3, skus_contados:54, con_diferencia:9, total_unidades_contadas:1243 }, { bodega:'Bodega Norte', semana:ts(-7,3), reconteos:1, skus_contados:21, con_diferencia:1, total_unidades_contadas:330 } ],
  mensual:[ { mes:ts(-7,3).slice(0,8)+'01T03:00:00+00:00', bodega:'Bodega Central', reconteos:5, skus_contados:109, con_diferencia:19, total_unidades_contadas:2610 }, { mes:ts(-7,3).slice(0,8)+'01T03:00:00+00:00', bodega:'Bodega Norte', reconteos:2, skus_contados:55, con_diferencia:6, total_unidades_contadas:890 } ],
  ranking:[ { nombre:'Pedro Soto', cantidad:41 }, { nombre:'Ana Silva', cantidad:26 }, { nombre:'Carla Muñoz', cantidad:8 } ],
  resumenAbc:[ { clase_abc:'A', cantidad_sku:24, pct_sku:10.2, pct_valor:80.1, pct_avance:91.7, valor_total:38400000, skus_contados:22 }, { clase_abc:'B', cantidad_sku:48, pct_sku:20.4, pct_valor:15.2, pct_avance:75.0, valor_total:7300000, skus_contados:36 }, { clase_abc:'C', cantidad_sku:163, pct_sku:69.4, pct_valor:4.7, pct_avance:65.0, valor_total:2250000, skus_contados:106 } ],
  valorizacion:[ { bodega:'Bodega Central', valor_contado:31200000, valor_perdidas:-412000, valor_excedentes:156000 }, { bodega:'Bodega Norte', valor_contado:10800000, valor_perdidas:-38000, valor_excedentes:54000 } ],
  resumenGeneral:[ { cuadrado:139, pendiente:0, no_contado:71, total_activo:235, con_diferencia:25 } ],
  exactitudBodega:[ { bodega:'Bodega Central', skus_contados:109, con_diferencia:19, sin_diferencia:90, ubicacion_correcta:101 }, { bodega:'Bodega Norte', skus_contados:55, con_diferencia:6, sin_diferencia:49, ubicacion_correcta:52 } ],
  cierresAjusteErp:{ n:4, valor:96000 },
  exactitudMensual:[ { mes:'2026-08-01T04:00:00+00:00', bodega:'Bodega Central', skus_contados:60, con_diferencia:18, sin_diferencia:42, ubicacion_correcta:55 }, { mes:'2026-09-01T04:00:00+00:00', bodega:'Bodega Central', skus_contados:80, con_diferencia:16, sin_diferencia:64, ubicacion_correcta:76 }, { mes:ts(-7,3).slice(0,8)+'01T04:00:00+00:00', bodega:'Bodega Central', skus_contados:109, con_diferencia:19, sin_diferencia:90, ubicacion_correcta:101 }, { mes:'2026-09-01T04:00:00+00:00', bodega:'Bodega Norte', skus_contados:30, con_diferencia:6, sin_diferencia:24, ubicacion_correcta:28 }, { mes:ts(-7,3).slice(0,8)+'01T04:00:00+00:00', bodega:'Bodega Norte', skus_contados:55, con_diferencia:6, sin_diferencia:49, ubicacion_correcta:52 } ],
  avancePlanPorCiclo:[ { bodega:'Bodega Central', ciclo_id:'c-t4', contados:109, total_planificados:140 }, { bodega:'Bodega Norte', ciclo_id:'c-t4', contados:55, total_planificados:95 }, { bodega:'Bodega Central', ciclo_id:'c-t3', contados:140, total_planificados:140 } ],
  diferenciasRecientes:[ { con_diferencia:9, sin_diferencia:66 } ],
  topDiferenciasNegativas:[ { sku_code:'4400-1123', descripcion:'Filtro hidráulico 3"', stock_sistema:14, ultima_cantidad_contada:12, ultima_diferencia:-2, causa_probable:'Diferencia recurrente', valor_diferencia_linea:-37000, reincidente:true, fotos:[] }, { sku_code:'4431-0087', descripcion:'Sello mecánico 1 1/2"', stock_sistema:6, ultima_cantidad_contada:5, ultima_diferencia:-1, causa_probable:'Sin patrón detectado', valor_diferencia_linea:-31000, fotos:[] } ],
  topDiferenciasPositivas:[ { sku_code:'4420-0005', descripcion:'Aceite hidráulico ISO 68, 20 L', stock_sistema:40, ultima_cantidad_contada:43, ultima_diferencia:3, causa_probable:'Ubicación distinta', valor_diferencia_linea:156000, fotos:[] } ],
};
const RECONTEO = [
  { id:'s-4400-1123', conteo_id:'ct-1', sku_code:'4400-1123', descripcion:'Filtro hidráulico 3"', bodega:'Bodega Central', ubicacion:'Pasillo 3', storage_bin:'A-12', batch:null, unidad_medida:'EA', critico:true, clase_abc:'A', costo_unitario:18500,
    stock_sistema:14, stock_sistema_anterior:12, stock_sistema_actualizado_en:ts(-6,14), ultima_cantidad_contada:12, ultima_diferencia:-2, diferencia_abs:2, causa_probable:'Diferencia recurrente', reincidente:true, diferencia_recurrente:true, veces_con_diferencia:3, ciclos_con_diferencia:2,
    ultimo_conteo_fecha:ts(-1,15), capturado_en:ts(-1,15), contado_por_id:'u-pedro', observacion:'Caja abierta', fotos:[], ubicacion_distinta:false, bodega_contada:null, ubicacion_contada:null, valor_diferencia_linea:-37000, total_bloqueado:1, total_transito_1:0, total_transito_2:0, total_transferencia:0, total_consignado:0, total_en_proveedor:0, stock_bloqueado:1, stock_transito_1:0, stock_transito_2:0, stock_transferencia:0, stock_consignado:null, stock_en_proveedor:null, cantidad_original:null, motivo_correccion:null, corregido_en:null },
  { id:'s-4420-0005', conteo_id:'ct-2', sku_code:'4420-0005', descripcion:'Aceite hidráulico ISO 68, 20 L', bodega:'Bodega Norte', ubicacion:'Rack 2', storage_bin:'B-01', batch:null, unidad_medida:'UN', critico:false, clase_abc:'A', costo_unitario:52000,
    stock_sistema:40, stock_sistema_anterior:null, stock_sistema_actualizado_en:null, ultima_cantidad_contada:43, ultima_diferencia:3, diferencia_abs:3, causa_probable:'Ubicación distinta', reincidente:false, diferencia_recurrente:false, veces_con_diferencia:1, ciclos_con_diferencia:1,
    ultimo_conteo_fecha:ts(-2,11), capturado_en:ts(-2,11), contado_por_id:'u-ana-s', observacion:null, fotos:[], ubicacion_distinta:true, bodega_contada:'Bodega Central', ubicacion_contada:'Pasillo 3', valor_diferencia_linea:156000, total_bloqueado:0, total_transito_1:0, total_transito_2:0, total_transferencia:0, total_consignado:0, total_en_proveedor:0, stock_bloqueado:0, stock_transito_1:0, stock_transito_2:0, stock_transferencia:0, stock_consignado:null, stock_en_proveedor:null, cantidad_original:null, motivo_correccion:null, corregido_en:null },
  { id:'s-4431-0087', conteo_id:'ct-3', sku_code:'4431-0087', descripcion:'Sello mecánico 1 1/2"', bodega:'Bodega Norte', ubicacion:'Rack 2', storage_bin:'B-02', batch:null, unidad_medida:'EA', critico:true, clase_abc:'B', costo_unitario:31000,
    stock_sistema:6, stock_sistema_anterior:null, stock_sistema_actualizado_en:null, ultima_cantidad_contada:5, ultima_diferencia:-1, diferencia_abs:1, causa_probable:'Sin patrón detectado', reincidente:false, diferencia_recurrente:false, veces_con_diferencia:1, ciclos_con_diferencia:1,
    ultimo_conteo_fecha:ts(-4,9), capturado_en:ts(-4,9), contado_por_id:'u-pedro', observacion:null, fotos:[], ubicacion_distinta:false, bodega_contada:null, ubicacion_contada:null, valor_diferencia_linea:-31000, total_bloqueado:0, total_transito_1:0, total_transito_2:0, total_transferencia:0, total_consignado:0, total_en_proveedor:0, stock_bloqueado:0, stock_transito_1:0, stock_transito_2:0, stock_transferencia:0, stock_consignado:null, stock_en_proveedor:null, cantidad_original:null, motivo_correccion:null, corregido_en:null },
];
const BUSQUEDA = SKUS.map((s,i)=>({ sku_id:s.id, sku_code:s.sku_code, descripcion:s.descripcion, bodega:s.bodega, ubicacion:s.ubicacion, storage_bin:s.storage_bin, batch:null, clase_abc:s.clase_abc, critico:s.critico, stock_sistema:s.stock_sistema,
  conteo_id: i===2? null : 'ct-'+i, cantidad_contada: i===2? null : (s.ultimaDiferencia!=null? s.stock_sistema+s.ultimaDiferencia : s.stock_sistema), estado: i===2? null : (s.ultimaDiferencia? 'con_diferencia' : 'aprobado'), diferencia: i===2? null : (s.ultimaDiferencia||0),
  fecha_conteo: i===2? null : ts(-1-i,10), capturado_en: i===2? null : ts(-1-i,10), fuera_de_plan: i===4, ciclo_nombre:'T4 2026', usuario_nombre: i%2? 'Pedro Soto' : 'Ana Silva', contado_por: i%2? 'Pedro Soto' : 'Ana Silva', fotos:[], reconteo_cierre_tipo:null }));
const CALENDARIO = [-5,-4,-3,-2,-1,0,1,2,5,6].map(n=>({ fecha:dias(n), planificado: 10+Math.abs(n)*2, contado: n<0? 10+Math.abs(n)*2-(n===-1?3:0) : (n===0? 4 : 0), recontado: n===-3? 1 : 0, pendiente: n<0? (n===-1? 3 : 0) : 10+Math.abs(n)*2-(n===0?4:0) })).filter(d=>d.fecha.slice(0,7)===dias(0).slice(0,7));

const CSV = 'Material,Material Description,Plant,Storage Location,Storage Bin,Batch,Unrestricted,Blocked Stock,Stock in Transit,Base Unit,Price\n4400-1123,Filtro hidráulico 3 pulg,Bodega Central,Pasillo 3,A-12,,14,1,0,EA,18500\n4402-0044,Rodamiento SKF 6205,Bodega Central,Pasillo 3,A-12,,32,0,0,EA,6900\n4420-0005,Aceite hidráulico ISO 68 20 L,Bodega Norte,Rack 2,B-01,,40,0,2,UN,52000\n';

// ---------- Rutas simuladas ----------
async function rutas(page, perfil){
  for(const p of ['**/js.sentry-cdn.com/**','**/*.sentry.io/**','**/*.ingest.*/**']) await page.route(p, r=>r.abort());
  await page.route('**/functions/v1/**', r=>r.fulfill({ status:200, contentType:'application/json', body:'{}' }));
  await page.route('**/auth/v1/token**', r=>r.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({ access_token:'t', refresh_token:'r', user:{ id:'auth-1', email:'ana.torres@mineraandes.cl' } }) }));
  await page.route('**/auth/v1/factors**', r=>r.fulfill({ status:200, contentType:'application/json', body:'[]' }));
  await page.route('**/auth/v1/user**', r=>r.fulfill({ status:200, contentType:'application/json', body:JSON.stringify({ id:'auth-1', email:'ana.torres@mineraandes.cl', factors:[] }) }));
  await page.route('**/rest/v1/**', r=>{
    const u = new URL(r.request().url()); const seg = u.pathname.replace(/^.*\/rest\/v1\//,''); const q = u.search;
    let body = '[]', headers = {};
    if(seg.startsWith('rpc/')){
      const n = seg.slice(4);
      body = ({
        tengo_otra_sesion_activa:'false', dashboard_ejecutivo:JSON.stringify(DASH), resumen_general_skus:JSON.stringify(DASH.resumenGeneral),
        plan_ventana_pantalla:(()=>{ let b = {}; try{ b = JSON.parse(r.request().postData()||'{}'); }catch(e){} return b.p_resumido ? JSON.stringify({ entradas:[], resumen:[] }) : JSON.stringify({ entradas:ENTRADAS, universo:UNIVERSO }); })(), universo_entradas_plan_contar:JSON.stringify(UNIVERSO), universo_entradas_plan_resumen:JSON.stringify(Object.entries(UNIVERSO).map(([plan_id, s])=>({ plan_id, total:s.length, propios:s.length, skus:s }))),
        buscar_skus_lectura:JSON.stringify([SKU({ sku_code:'4400-1123', descripcion:'Filtro hidráulico 3"', storage_bin:'A-12', stock_sistema:14 }), SKU({ sku_code:'4400-1123', descripcion:'Filtro hidráulico 3"', bodega:'Bodega Norte', ubicacion:'Rack 2', storage_bin:'B-04', stock_sistema:6, id:'s-4400-1123-b' })]),
        contado_periodo:JSON.stringify({ veces:2, ultima_fecha:ts(-1,15), ultima_cantidad:14, ultimo_por:'Pedro Soto' }),
        filas_busqueda_skus:JSON.stringify(BUSQUEDA), contar_busqueda_skus:String(BUSQUEDA.length),
        pagina_skus:JSON.stringify({ rows:SKUS, total:SKUS.length }), catalogos_pantalla_skus:JSON.stringify({ batches:[], unidades:['EA','UN','KG','L'], generales:GENERALES, categorias:['Filtros','Rodamientos','Transmisión','Lubricantes','Sellos','Ferretería'], ubicaciones:UBICACIONES }),
        reconteo_pendiente_por_semana:JSON.stringify([{ semana:dias(-6), pendientes:3 }]), resumen_calendario_mes:JSON.stringify(CALENDARIO), mi_estado_bloqueo:JSON.stringify([{ bloqueada:false, motivo:null, plan_nombre:'Profesional', empresa_nombre:'Minera Andes' }]),
        resumen_valorizacion_bodega:JSON.stringify([{ valor_total:42000000, bajo_minimo:3, sin_apertura:0 }]), resumen_plan_grupos:'[]',
      })[n] || '[]';
    }
    else if(seg==='usuarios') body = JSON.stringify(q.includes('rol=eq.operador')? PERSONAS.filter(p=>p.rol==='operador') : (q.includes('auth_user_id') || q.includes('id=eq.perfil-1'))? [perfil] : PERSONAS);
    else if(seg==='ciclos_conteo') body = JSON.stringify(CICLOS);
    else if(seg==='plan_semanal_detalle') body = JSON.stringify(ENTRADAS.filter(e=>e.fecha===dias(0)));
    else if(seg==='ubicaciones_generales') body = JSON.stringify(GENERALES);
    else if(seg==='ubicaciones_especificas') body = JSON.stringify(ESPECIFICAS);
    else if(seg==='ubicaciones_bins') body = JSON.stringify(BINS);
    else if(seg==='ubicaciones') body = JSON.stringify(UBICACIONES);
    else if(seg==='skus_disponibles_planificar'){ body = '[]'; headers = { 'content-range':'0-0/0', 'access-control-expose-headers':'content-range' }; }
    else if(seg==='reconteo_pendiente') body = JSON.stringify(RECONTEO);
    else if(seg==='skus_lectura' || seg==='skus') body = JSON.stringify(SKUS);
    else if(seg==='empresas') body = JSON.stringify([perfil.empresas]);
    r.fulfill({ status:200, contentType:'application/json', headers, body });
  });
}

(async()=>{
  const server = http.createServer((req,res)=>{ const u = decodeURIComponent(req.url.split('?')[0]); fs.readFile(path.join(ROOT, u==='/'? '/index.html' : u), (e,d)=>{ if(e){ res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': MIME[path.extname(u)] || 'application/octet-stream' }); res.end(d); }); }).listen(PORT);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const abrir = async (perfil, opts={}) => {
    const ctx = await browser.newContext({ viewport:{ width:412, height:900 }, deviceScaleFactor:2, locale:'es-CL', timezoneId:'America/Santiago' });
    const page = await ctx.newPage(); await rutas(page, perfil);
    page.on('pageerror', e=>console.log('PAGEERR', e.message.slice(0,160)));
    await page.goto(`http://localhost:${PORT}/app/index.html`, { waitUntil:'networkidle' });
    if(opts.login) return { ctx, page };
    await page.fill('#f-email', 'ana.torres@mineraandes.cl'); await page.fill('#f-pass', '123456'); await page.click('#auth-form button[type="submit"]');
    await page.waitForSelector('.tabbar', { timeout:15000 }); await page.waitForTimeout(1500);
    // Sin el aviso de MFA ni el saludo: no son parte de lo que el manual explica en cada pantalla.
    await page.evaluate(()=>{ const b = document.getElementById('banner-mfa'); if(b) b.remove(); document.querySelectorAll('.toast').forEach(t=>t.remove()); });
    return { ctx, page };
  };
  const ir = async (page, v) => { await page.evaluate(v=>{ if(typeof detenerEscaner==='function') detenerEscaner(); setState({ view:v }); }, v); await page.waitForTimeout(1500); await page.evaluate(()=>{ const b = document.getElementById('banner-mfa'); if(b) b.remove(); document.querySelectorAll('.toast').forEach(t=>t.remove()); }); };
  const limpiar = page => page.evaluate(()=>{
    const b = document.getElementById('banner-mfa'); if(b) b.remove();
    document.querySelectorAll('.toast').forEach(t=>t.remove());
    [...document.querySelectorAll('div,p,span')].filter(e=>e.children.length===0 && /No se pudo acceder a la cámara/.test(e.textContent)).forEach(e=>e.remove());
  });
  // En una captura de página completa, la cabecera pegada y la barra inferior fija quedarían a la
  // mitad de la imagen: durante la captura pasan a fluir con el documento (la barra, al final).
  const guardar = async (page, nombre, o={}) => {
    await limpiar(page);
    if(o.full) await page.evaluate(()=>{ const t = document.querySelector('.topbar'); if(t) t.style.position = 'static'; const n = document.querySelector('.tabbar'); if(n){ n.style.position = 'absolute'; n.style.bottom = 'auto'; n.style.top = (document.documentElement.scrollHeight - n.offsetHeight) + 'px'; } document.body.style.position = 'relative'; });
    await page.screenshot(Object.assign({ path: path.join(OUT, nombre+'.png'), fullPage: !!o.full }, o.clip? { clip:o.clip } : {}));
    if(o.full) await page.evaluate(()=>{ const t = document.querySelector('.topbar'); if(t) t.style.position = ''; const n = document.querySelector('.tabbar'); if(n){ n.style.position = ''; n.style.bottom = ''; n.style.top = ''; } document.body.style.position = ''; });
  };
  const tarjeta = async (page, textoH2, nombre) => {
    const el = await page.evaluateHandle(t => { const h = [...document.querySelectorAll('h2')].find(x=>x.textContent.trim().startsWith(t)); if(!h) return null; const head = h.closest('.section-head'); let c = head && head.nextElementSibling; while(c && !c.classList.contains('card')) c = c.nextElementSibling; return c; }, textoH2);
    const e = el.asElement(); if(!e){ console.log('sin tarjeta', textoH2); return; }
    await e.scrollIntoViewIfNeeded(); await e.screenshot({ path: path.join(OUT, nombre+'.png') });
  };

  // Login
  { const { ctx, page } = await abrir(PERFIL, { login:true }); await guardar(page, 'login'); await ctx.close(); }
  // Panel (Ejecutivo con el detalle desplegado, y Operativo)
  { const { ctx, page } = await abrir(PERFIL);
    await page.evaluate(()=>{ const d = document.getElementById('dash-detalle'); if(d) d.open = true; }); await page.waitForTimeout(400);
    await guardar(page, 'dash-ejecutivo', { full:true });
    await page.click('[data-dash-modo="operativo"]'); await page.waitForTimeout(800); await guardar(page, 'dash-operativo', { full:true });
    // Navegación: la hoja "Más"
    await ir(page, 'conteo'); await page.click('#tab-mas'); await page.waitForTimeout(400); await guardar(page, 'nav-mas'); await page.click('#tab-mas-cerrar');
    // SKU (lista primero; el alta abierta para el manual)
    await ir(page, 'skus'); await page.evaluate(()=>{ const d = document.getElementById('skus-agregar'); if(d) d.open = true; }); await page.waitForTimeout(300); await guardar(page, 'skus', { full:true });
    // Carga masiva: se sube un archivo pequeño y se fotografía la revisión de columnas
    await ir(page, 'carga'); await page.setInputFiles('#file-skus', { name:'maestro.csv', mimeType:'text/csv', buffer: Buffer.from(CSV) }); await page.waitForTimeout(2500);
    const hayPreview = await page.$('main .card'); if(hayPreview){ await guardar(page, 'carga', { full:true }); }
    // Plan (semana, con "Agregar" abierto)
    await ir(page, 'plan'); await page.evaluate(()=>{ if(typeof cambiarModoPlan==='function') cambiarModoPlan('semana'); }); await page.waitForTimeout(1500);
    const btnAgregar = await page.$('#btn-toggle-agregar-plan'); if(btnAgregar && (await btnAgregar.getAttribute('aria-expanded'))==='false'){ await btnAgregar.click(); await page.waitForTimeout(800); }
    await guardar(page, 'plan', { full:true });
    // Contar: lugares, lista, mismo código en dos lugares y aviso de conteo repetido
    await ir(page, 'conteo'); await page.waitForTimeout(800);
    await guardar(page, 'contar-lugares', { full:true });
    const lugar = await page.$('.contar-lugar'); if(lugar){ await lugar.click(); await page.waitForTimeout(1500); await guardar(page, 'contar-lista', { full:true }); await page.click('#btn-contar-cambiar-lugar'); await page.waitForTimeout(600); }
    await page.fill('#sku-search', '4400'); await page.waitForSelector('[data-pick-btn]', { timeout:15000 }); await page.waitForTimeout(400);
    { const caja = await page.$('#sku-search'); const b = await caja.boundingBox(); const card = await page.evaluateHandle(()=>document.getElementById('sku-search').closest('.card')); const cb = await card.asElement().boundingBox(); await guardar(page, 'contar-repetido', { clip:{ x:0, y:Math.max(0, cb.y-56), width:412, height:Math.min(cb.height+70, 480) } }); }
    await page.click('[data-pick-btn]'); await page.waitForSelector('#c-cant', { timeout:15000 }); await page.waitForTimeout(1200);
    { const ficha = await page.$('.conteo-ficha'); if(ficha){ await ficha.screenshot({ path: path.join(OUT, 'contar-aviso.png') }); } await guardar(page, 'contar-form', { full:true }); }
    await page.click('#btn-quitar-sku'); await page.waitForTimeout(500);
    // Escáner
    await page.click('#btn-abrir-escaner'); await page.waitForTimeout(1500); await guardar(page, 'escaner'); await page.click('#escaner-modal-close').catch(()=>{});
    // Reconteo
    await ir(page, 'reconteo'); await page.waitForTimeout(800); await guardar(page, 'reconteo', { full:true });
    // Buscar: con resultados
    await ir(page, 'buscar'); await page.fill('#b-texto', '44'); await page.click('.buscar-btn'); await page.waitForTimeout(1500); await guardar(page, 'buscar', { full:true }); await guardar(page, 't-buscar');
    // Calendario
    await ir(page, 'calendario'); await page.waitForTimeout(800); await guardar(page, 'calendario', { full:true });
    // Configuraciones (y sus tarjetas para el manual técnico)
    await ir(page, 'config'); await page.waitForTimeout(1500); await guardar(page, 'config', { full:true });
    await tarjeta(page, 'Tu empresa', 't-empresa'); await tarjeta(page, 'Mi equipo', 't-equipo'); await tarjeta(page, 'Plan y facturación', 't-plan-facturacion');
    await ctx.close(); }
  // Módulo de bodega: Inicio
  { const perfilBodega = JSON.parse(JSON.stringify(PERFIL)); perfilBodega.empresas.modulo_bodega_habilitado = true; perfilBodega.empresas.bodega_funciones = {};
    const { ctx, page } = await abrir(perfilBodega); await page.waitForTimeout(800); await guardar(page, 'bodega-inicio', { full:true }); await ctx.close(); }
  await browser.close(); server.close();
  console.log('capturas listas en', OUT);
})();
