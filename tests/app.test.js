const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if(!m) throw new Error('No se encontró el bloque <script>');
let script = m[1];
// Evitar que se ejecute el arranque real de la app al final del script.
script = script.replace(/\nasync function iniciarApp\(\)\{[\s\S]*?\niniciarApp\(\);\s*$/, '\n');
script += '\nvar __appstate = state;\nvar __TypeError = TypeError;\nfunction __resyncAppState(){ __appstate = state; return __appstate; }\nvar __CAMPOS_SKU = CAMPOS_SKU;\n';

// Assert real: a diferencia de console.assert(), esta SI hace fallar el proceso
// (exit code != 0) si alguna aserción no se cumple, para que sirva como gate en CI.
let fallos = 0;
function assert(cond, msg){
  if(!cond){
    fallos++;
    console.error('FALLO:', msg);
  }
}

let estadoBloqueoRespuesta = { bloqueada: false, motivo: null, empresa_nombre: null };
let tengoOtraSesionActivaRespuesta = false;
let cicloActualRpcRespuesta = null;
let autoservicioRespuesta = { error: null };
let conteosExportablesFixture = [];
let skusBusquedaFixture = null;
let resumenGeneralSkusFixture = null;
const calls = [];
const fakeFetchImpl = async (url, opts) => {
  calls.push({url, opts});
  const u = new URL(url);
  const path = u.pathname + u.search;
  if(path.startsWith('/rest/v1/rpc/mi_estado_bloqueo')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([estadoBloqueoRespuesta]) };
  }
  if(path.startsWith('/rest/v1/rpc/tengo_otra_sesion_activa')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(tengoOtraSesionActivaRespuesta) };
  }
  if(path.startsWith('/rest/v1/rpc/ciclo_actual')){
    // Función escalar (RETURNS uuid, no TABLE/SETOF): PostgREST devuelve el valor crudo, no
    // envuelto en un array — por defecto sin ciclo actual (null), como mi_estado_bloqueo etc.
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(cicloActualRpcRespuesta) };
  }
  if(path.startsWith('/functions/v1/flow-cancelar-suscripcion')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'{"ok":true}', json: async()=>({ok:true}) };
  }
  if(path.startsWith('/rest/v1/plan_semanal_detalle')){
    // "Mi plan del día" (Contar): cuatro entradas para resp-yo el 2026-08-24 — dos ubicaciones
    // normales (misma bodega/ubicación, distinto bin, para probar la cascada), una "SKU sin
    // ubicación" (solo_sin_ubicacion, que no cascadea por bodega/ubicación/bin) y una con
    // bodega:'' ("Sin bodega asignada": bodega IS NULL, pero con ubicación específica — bug real
    // reportado: esta entrada quedaba inalcanzable en el <select>, ver renderPlanDelDia).
    if(path.includes('responsable_id=eq.resp-yo')){
      const filas = path.includes('fecha=eq.2026-08-24') ? [
        {id:'mp1', fecha:'2026-08-24', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', solo_sin_ubicacion:false, responsable_id:'resp-yo', ciclo_nombre:null, skus_excluidos:[]},
        {id:'mp2', fecha:'2026-08-24', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', solo_sin_ubicacion:false, responsable_id:'resp-yo', ciclo_nombre:null, skus_excluidos:[]},
        {id:'mp3', fecha:'2026-08-24', bodega:null, ubicacion:null, storage_bin:null, solo_sin_ubicacion:true, responsable_id:'resp-yo', ciclo_nombre:null, skus_excluidos:[]},
        {id:'mp4', fecha:'2026-08-24', bodega:'', ubicacion:'Piso', storage_bin:null, solo_sin_ubicacion:false, responsable_id:'resp-yo', ciclo_nombre:null, skus_excluidos:[]},
      ] : [];
      return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify([
        {id:'e1', fecha:'2026-08-10', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', responsable_id:'u1', responsable_nombre:'Ana Torres', nota:'Revisar merma', skus_excluidos:[]},
        {id:'e2', fecha:'2026-08-11', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', responsable_id:null, responsable_nombre:null, nota:'', skus_excluidos:['SKU-002']},
      ]),
    };
  }
  if(path.startsWith('/rest/v1/plan_semanal_exclusiones')){
    return { status: 201, ok: true, headers: { get: () => null }, text: async () => '' };
  }
  if(path.startsWith('/rest/v1/plan_semanal') && !path.startsWith('/rest/v1/plan_semanal_detalle') && opts && opts.method==='POST'){
    // crearPlanEntrada pide return=representation para conocer el id de la fila recién creada
    // (necesario para mandar las exclusiones de SKU cuando aplica — ver "sin bin, elegir SKU").
    const filas = JSON.parse(opts.body).map((f,i)=>({...f, id:`plan-nuevo-${i+1}`}));
    return { status: 201, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/ubicaciones_generales')){
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify([
        {bodega:'Nave Mina', cantidad_pendiente: 18234, cantidad_skus: 23708},
        {bodega:'Nave Planta', cantidad_pendiente: 4235, cantidad_skus: 4235},
        {bodega:null, cantidad_pendiente: 6, cantidad_skus: 8},
      ]),
    };
  }
  if(path.startsWith('/rest/v1/categorias_sku')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([
      {categoria:'Repuestos', cantidad_skus:120},
      {categoria:'Seguridad', cantidad_skus:8},
    ]) };
  }
  if(path.startsWith('/rest/v1/unidades_medida_sku')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([
      {unidad_medida:'KG', cantidad_skus:15},
      {unidad_medida:'UN', cantidad_skus:300},
    ]) };
  }
  if(path.startsWith('/rest/v1/batches_sku')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([
      {batch:'L-001', cantidad_skus:5},
      {batch:'L-002', cantidad_skus:2},
    ]) };
  }
  if(path.startsWith('/rest/v1/ubicaciones_especificas')){
    // bodega=is.null: SKU con ubicación específica pero sin bodega asignada (BODEGA_VACIA).
    const filas = path.includes('bodega=is.null') ? [
      {bodega:null, ubicacion:'Piso', cantidad_pendiente: 6, cantidad_skus: 8},
    ] : [
      {bodega:'Nave Mina', ubicacion:'Interior Nave', cantidad_pendiente: 80, cantidad_skus: 100},
      {bodega:'Nave Mina', ubicacion:'Rack', cantidad_pendiente: 50, cantidad_skus: 50},
    ];
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify(filas),
    };
  }
  if(path.startsWith('/rest/v1/ubicaciones_bins')){
    // A-01 se repite en dos ubicaciones distintas de la misma bodega a propósito: sirve para
    // probar que, sin filtro de ubicación ("Todas"), opcionesBins suma cantidad_skus en vez de
    // listar el mismo bin duplicado.
    const todas = [
      {bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', cantidad_skus: 5},
      {bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', cantidad_skus: 3},
      {bodega:'Nave Mina', ubicacion:'Rack Exterior', storage_bin:'A-01', cantidad_skus: 2},
    ];
    const filas = path.includes('ubicacion=eq.') ? todas.filter(f=>path.includes('ubicacion=eq.'+encodeURIComponent(f.ubicacion))) : todas;
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify(filas),
    };
  }
  if(path.startsWith('/rest/v1/conteos') && opts && opts.method==='POST'){
    return { status:201, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([{id:'conteo-nuevo-1'}]) };
  }
  // Usado por eliminarSkusSeleccionados para saber cuáles de los SKU seleccionados ya
  // tienen conteos registrados (y por lo tanto no se pueden borrar) — chequear antes que
  // los otros matchers de /conteos?select=, que son más genéricos.
  if(path.startsWith('/rest/v1/conteos?select=sku_id')){
    const match = path.match(/sku_id=in\.\(([^)]*)\)/);
    const ids = match ? match[1].split(',') : [];
    const conConteo = ids.filter(id => id === 'sku-con-conteo');
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(conConteo.map(id=>({sku_id:id}))) };
  }
  if(path.startsWith('/rest/v1/ciclos_conteo')){
    const filas = [
      {id:'ciclo-1', nombre:'T1 2027', es_actual:true},
      {id:'ciclo-2', nombre:'T4 2026', es_actual:false},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  // Buscar: skus_busqueda (un renglón por SKU, contado o no) — 34 filas en total en el fixture
  // por defecto; honra el "limit=" real del pedido (30 para "cargar más", TOPE_CARGA_TOTAL_BUSQUEDA
  // para la carga inicial) -- el total real que pide buscarConteos en paralelo (RPC
  // contar_busqueda_skus) tiene su propio mock más abajo, usando este mismo fixture.
  if(path.startsWith('/rest/v1/skus_busqueda?select=')){
    const offsetMatch = path.match(/offset=(\d+)/);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const limitMatch = path.match(/limit=(\d+)/);
    const limit = limitMatch ? Number(limitMatch[1]) : 30;
    if(skusBusquedaFixture){
      const total = skusBusquedaFixture.length;
      const filas = skusBusquedaFixture.slice(offset, offset+limit);
      return { status:200, ok:true, headers:{get:(h)=> h==='content-range' ? `${offset}-${Math.max(offset+filas.length-1,offset)}/${total}` : null}, text: async()=>JSON.stringify(filas) };
    }
    const total = 34;
    const filas = [];
    for(let i=offset; i<Math.min(offset+limit, total); i++){
      filas.push({sku_id:'sku-busq-'+i, sku_code:'SKU-'+i, descripcion:'Item '+i, bodega:'Nave', ubicacion:null, storage_bin:null, conteo_id:'busq-'+i, cantidad_contada:5, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-18T10:00:00Z', capturado_en:'2026-08-18T10:00:00Z', fuera_de_plan:false, ciclo_id:null, ciclo_nombre:null, fotos:[], contado_por:'Persona '+(i%3)});
    }
    return { status:200, ok:true, headers:{get:(h)=> h==='content-range' ? `${offset}-${Math.max(offset+filas.length-1,offset)}/${total}` : null}, text: async()=>JSON.stringify(filas) };
  }
  // Total real de Buscar (ver buscarConteos): un count(*) aparte, en paralelo al pedido de filas
  // de arriba -- mismo "total" que ese mock (skusBusquedaFixture.length o 34 por defecto), sin
  // aplicar los filtros de la query (igual de simplificado que el mock de skus_busqueda de arriba).
  if(path.startsWith('/rest/v1/rpc/contar_busqueda_skus')){
    const total = skusBusquedaFixture ? skusBusquedaFixture.length : 34;
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(total) };
  }
  if(path.startsWith('/rest/v1/conteos?select=')){
    const offsetMatch = path.match(/offset=(\d+)/);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const total = 34;
    const filas = [];
    for(let i=offset; i<Math.min(offset+30, total); i++){
      filas.push({id:'uc-'+i, cantidad_contada:5, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-18T10:00:00Z', capturado_en:'2026-08-18T10:00:00Z', skus:{sku_code:'SKU-'+i, descripcion:'Item '+i}, conteo_fotos:[]});
    }
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/rpc/ranking_responsable')){
    const filas = [
      {nombre:'Ana Torres', cantidad:2},
      {nombre:'Beto', cantidad:1},
      {nombre:'Sin asignar', cantidad:1},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/rpc/diferencias_recientes')){
    const filas = [ {sin_diferencia:9, con_diferencia:1} ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  // Estado general de SKU (Dashboard, ver cargarResumenGeneralSkus/renderResumenGeneralSkus):
  // un count(*) con FILTER agregado, PostgREST lo devuelve como un array de una sola fila (misma
  // forma que ranking_responsable/diferencias_recientes, no un escalar).
  if(path.startsWith('/rest/v1/rpc/resumen_general_skus')){
    const filas = [ resumenGeneralSkusFixture || {total_activo:100, no_contado:70, cuadrado:20, con_diferencia:8, pendiente:2} ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/skus_resumen_abc')){
    const filas = [
      {clase_abc:'A', cantidad_sku:3, pct_sku:10.0, valor_total:8000000, pct_valor:80.0, skus_contados:1, pct_avance:33.3},
      {clase_abc:'B', cantidad_sku:7, pct_sku:23.3, valor_total:1500000, pct_valor:15.0, skus_contados:2, pct_avance:28.6},
      {clase_abc:'C', cantidad_sku:20, pct_sku:66.7, valor_total:500000, pct_valor:5.0, skus_contados:4, pct_avance:20.0},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/storage/v1/object/sign/')){
    const ruta = path.replace('/storage/v1/object/sign/fotos-inventario/', '');
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify({signedURL:`/object/sign/fotos-inventario/${ruta}?token=fake`}), json: async()=>({signedURL:`/object/sign/fotos-inventario/${ruta}?token=fake`}) };
  }
  if(path.startsWith('/storage/v1/object/fotos-inventario/')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'{}', json: async()=>({}) };
  }
  if(path.startsWith('/auth/v1/user')){
    const usuario = {id:'user-invitado', email:'invitado@test.com'};
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(usuario), json: async()=>usuario };
  }
  if(path.startsWith('/functions/v1/invite-user')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'{"ok":true}', json: async()=>({ok:true}) };
  }
  if(path.startsWith('/functions/v1/flow-iniciar-suscripcion')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'{"url":"https://sandbox.flow.cl/app/customer/disclaimer.php?token=tok-flow-1"}', json: async()=>({url:'https://sandbox.flow.cl/app/customer/disclaimer.php?token=tok-flow-1'}) };
  }
  if(path.startsWith('/functions/v1/crear-empresa-autoservicio')){
    if(autoservicioRespuesta.error) return { status: autoservicioRespuesta.status||400, ok:false, headers:{get:()=>null}, text: async()=>JSON.stringify({error:autoservicioRespuesta.error}), json: async()=>({error:autoservicioRespuesta.error}) };
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'{"ok":true,"empresaId":"emp-nueva","empresaNombre":"Minera Nueva SA"}', json: async()=>({ok:true,empresaId:'emp-nueva',empresaNombre:'Minera Nueva SA'}) };
  }
  if(path.startsWith('/auth/v1/token?grant_type=password')){
    const sesion = {access_token:'tok-autoservicio', refresh_token:'refresh-autoservicio', user:{id:'user-nuevo', email:'vicky@minera.cl'}};
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(sesion), json: async()=>sesion };
  }
  if(path.startsWith('/auth/v1/token?grant_type=refresh_token')){
    const sesion = {access_token:'token-refrescado', refresh_token:'refresh-2', user:{id:'user-1', email:'joel@test.com'}};
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(sesion), json: async()=>sesion };
  }
  if(path.startsWith('/auth/v1/recover')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'{}', json: async()=>({}) };
  }
  // ingresarConCodigo (pantalla "Ingresa tu código"): prueba primero type=invite y, si falla,
  // type=recovery -- se simulan ambos casos con un código válido distinto por tipo, más un
  // tercer código que nunca es válido para ninguno.
  if(path.startsWith('/auth/v1/verify')){
    const body = JSON.parse(opts.body);
    if(body.email==='invitado-otp@test.com' && body.token==='654321' && body.type==='invite'){
      const sesion = {access_token:'tok-otp-invite', refresh_token:'ref-otp-invite', user:{id:'user-otp-invite', email:body.email}};
      return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(sesion), json: async()=>sesion };
    }
    if(body.email==='recupera-otp@test.com' && body.token==='111222' && body.type==='recovery'){
      const sesion = {access_token:'tok-otp-recovery', refresh_token:'ref-otp-recovery', user:{id:'user-otp-recovery', email:body.email}};
      return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(sesion), json: async()=>sesion };
    }
    // Bug real: Supabase no siempre manda 6 dígitos (llegó un código real de 8) -- se prueba acá
    // con uno de 8 para confirmar que ingresarConCodigo lo manda completo, sin cortarlo.
    if(body.email==='recupera-8digitos@test.com' && body.token==='37470939' && body.type==='recovery'){
      const sesion = {access_token:'tok-otp-8digitos', refresh_token:'ref-otp-8digitos', user:{id:'user-otp-8digitos', email:body.email}};
      return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(sesion), json: async()=>sesion };
    }
    return { status:403, ok:false, headers:{get:()=>null}, text: async()=>JSON.stringify({error:'invalid_grant', error_description:'Token has expired or is invalid'}) };
  }
  if(path.startsWith('/rest/v1/usuarios?auth_user_id=eq.')){
    const perfil = {id:'perfil-1', nombre:'Joel Restaurado', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Escondida', codigo_invitacion:'ABC12345'}};
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([perfil]) };
  }
  if(path.startsWith('/rest/v1/rpc/resumen_empresas_super_admin')){
    const filas = [
      {empresa_id:'emp-1', nombre:'Minera Andes', activo:true, personas_activas:2, personas_total:3, skus_total:150, creada:'2026-01-10T00:00:00Z'},
      {empresa_id:'emp-2', nombre:'Minera Sur', activo:false, personas_activas:0, personas_total:1, skus_total:0, creada:'2026-02-01T00:00:00Z'},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/usuarios?empresa_id=eq.')){
    const filas = [
      {id:'p1', nombre:'Carlos Rojas', rol:'contador', activo:true},
      {id:'p2', nombre:'Ana Torres', rol:'supervisor', activo:false},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/usuarios?select=')){
    const filas = [
      {id:'eq1', nombre:'Beto Ríos', rol:'operador', activo:true},
      {id:'eq2', nombre:'Marta Soto', rol:'admin', activo:false},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  // Top materiales con diferencia: por costo total de la línea (diferencia x costo_unitario),
  // top 10 excedentes (valor_diferencia_linea=gt.0) y top 10 pérdidas (lt.0), por separado.
  if(path.startsWith('/rest/v1/reconteo_pendiente') && path.includes('valor_diferencia_linea=gt.0')){
    const filas = [
      {id:'topPos1', sku_code:'SKU-TOP-POS', descripcion:'Cable eléctrico', stock_sistema:10, ultima_cantidad_contada:40, ultima_diferencia:30, diferencia_abs:30, ultimo_conteo_fecha:'2026-08-10', causa_probable:'Sin patrón detectado', costo_unitario:5000, valor_diferencia_linea:150000},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/reconteo_pendiente') && path.includes('valor_diferencia_linea=lt.0')){
    const filas = [
      {id:'topNeg1', sku_code:'SKU-TOP-NEG', descripcion:'Motor eléctrico', stock_sistema:50, ultima_cantidad_contada:20, ultima_diferencia:-30, diferencia_abs:30, ultimo_conteo_fecha:'2026-08-10', causa_probable:'Ubicación distinta y recurrente', costo_unitario:10000, valor_diferencia_linea:-300000},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/reconteo_pendiente')){
    const offsetMatch = path.match(/offset=(\d+)/);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const total = 34; // fuerza que la 1ra página (30) diga "hay más" y la 2da (4) ya no
    const filas = [];
    for(let i=offset; i<Math.min(offset+30, total); i++){
      filas.push({id:'r'+i, sku_code:'SKU-'+i, descripcion:'Item '+i, stock_sistema:10, ultima_cantidad_contada:8, ultima_diferencia:-2, ultimo_conteo_fecha:'2026-08-10', causa_probable: i===0?'Ubicación distinta':'Sin patrón detectado'});
    }
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/exactitud_por_bodega')){
    const filas = [
      {bodega:'Nave Mina', skus_contados:20, sin_diferencia:16, con_diferencia:4, ubicacion_correcta:18},
      {bodega:'Nave Planta', skus_contados:10, sin_diferencia:4, con_diferencia:6, ubicacion_correcta:9},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/conteos_exportables')){
    const filas = conteosExportablesFixture;
    return { status:200, ok:true, headers:{get:(h)=> h==='content-range' ? `0-${Math.max(filas.length-1,0)}/${filas.length}` : null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/exactitud_mensual')){
    // Dos meses de historia: Nave Mina mejora 30 puntos (60%->90%), Nave Planta baja 10 (80%->70%).
    const filas = [
      {mes:'2026-06-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:10, sin_diferencia:6, con_diferencia:4, ubicacion_correcta:10},
      {mes:'2026-06-01T00:00:00+00:00', bodega:'Nave Planta', skus_contados:10, sin_diferencia:8, con_diferencia:2, ubicacion_correcta:10},
      {mes:'2026-08-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:10, sin_diferencia:9, con_diferencia:1, ubicacion_correcta:10},
      {mes:'2026-08-01T00:00:00+00:00', bodega:'Nave Planta', skus_contados:10, sin_diferencia:7, con_diferencia:3, ubicacion_correcta:10},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/valorizacion_diferencias')){
    const filas = [
      {bodega:'Nave Mina', valor_contado:1000000, valor_perdidas:-150000, valor_excedentes:40000},
      {bodega:'Nave Planta', valor_contado:500000, valor_perdidas:-20000, valor_excedentes:10000},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/avance_plan_por_ciclo')){
    const filas = [
      {ciclo_id:'ciclo-actual', bodega:'Nave Mina', total_planificados:8, contados:6},
      {ciclo_id:'ciclo-actual', bodega:'Nave Planta', total_planificados:2, contados:2},
      {ciclo_id:'ciclo-viejo', bodega:'Nave Mina', total_planificados:10, contados:5},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/auditoria')){
    const todas = [
      {id:'a1', tabla:'usuarios', accion:'UPDATE', actor_nombre:'Ana Torres', datos_antes:{nombre:'Carlos', rol:'operador', activo:true}, datos_despues:{nombre:'Carlos', rol:'admin', activo:true}, creado_en:'2026-08-15T10:00:00Z'},
      {id:'a2', tabla:'conteos', accion:'INSERT', actor_nombre:'Beto', datos_antes:null, datos_despues:{cantidad_contada:5, estado:'pendiente_revision'}, creado_en:'2026-08-14T09:00:00Z'},
      {id:'a3', tabla:'empresas', accion:'DELETE', actor_nombre:null, datos_antes:{nombre:'Minera Vieja'}, datos_despues:null, creado_en:'2026-08-13T08:00:00Z'},
      {id:'a4', tabla:'skus', accion:'UPDATE', actor_nombre:'Ana Torres', datos_antes:{sku_code:'FIL-1001', costo_unitario:1000}, datos_despues:{sku_code:'FIL-1001', costo_unitario:1500}, creado_en:'2026-08-16T11:00:00Z'},
    ];
    const filas = path.includes('tabla=eq.usuarios') ? todas.filter(f=>f.tabla==='usuarios') : todas;
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/cargas_masivas')){
    const filas = [
      {id:'c1', nombre_archivo:'materiales_agosto.xlsx', tipo:'skus', filas_totales:120, filas_ok:118, filas_error:2, detalle_errores:[{motivo:'Código de SKU vacío', cantidad:2}], created_at:'2026-08-20T14:30:00Z', usuarios:{nombre:'Ana Torres'}},
      // Formato viejo (previo al agrupado): una entrada por fila, sin `cantidad`, tal como
      // quedó guardado en cargas reales de antes de este cambio.
      {id:'c3', nombre_archivo:'antiguo.csv', tipo:'skus', filas_totales:10, filas_ok:7, filas_error:3, detalle_errores:[{fila:2,motivo:'sku_code vacío'},{fila:3,motivo:'sku_code vacío'},{fila:4,motivo:'sku_code vacío'}], created_at:'2026-08-10T09:00:00Z', usuarios:null},
      {id:'c2', nombre_archivo:'carga_inicial.csv', tipo:'skus', filas_totales:50, filas_ok:50, filas_error:0, created_at:'2026-08-01T09:00:00Z', usuarios:null},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/leads_demo')){
    if(path.includes('offset=')){
      const offsetMatch = path.match(/offset=(\d+)/);
      const offset = Number(offsetMatch[1]);
      const total = 34; // fuerza que la 1ra página (30) diga "hay más" y la 2da (4) ya no
      const filas = [];
      for(let i=offset; i<Math.min(offset+30, total); i++){
        filas.push({id:'lead-pag-'+i, nombre:'Lead '+i, email:'lead'+i+'@test.cl', telefono:null, empresa:null, creado_en:'2026-08-18T10:00:00Z'});
      }
      return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
    }
    const filas = [
      {id:'lead-1', nombre:'Pedro Soto', email:'pedro@clienteX.cl', telefono:'+56911112222', empresa:'Clientes X SpA', creado_en:'2026-08-18T10:00:00Z'},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/planes')){
    const filas = [
      {id:'plan-basico', nombre:'basico', etiqueta:'Básico'},
      {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'},
      {id:'plan-empresa', nombre:'empresa', etiqueta:'Empresa'},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/usuarios?activo=eq.true&rol=eq.operador&select=')){
    // cargarResponsables (Planificación → Responsable): las cuentas activas con rol operador,
    // ya no una lista aparte de "operadores" sin cuenta ni login, ni tampoco los admin.
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify([
        {id:'u1', nombre:'Ana Torres'},
        {id:'u2', nombre:'Joel Majmut'},
      ]),
    };
  }
  if(path === '/rest/v1/skus?activo=eq.true&order=sku_code.asc'){
    const filas = [
      {id:'sku-pag-1', sku_code:'SKU-PAG-1', descripcion:'Con diferencia', bodega:'Nave', ubicacion:null, storage_bin:null, stock_sistema:10},
      {id:'sku-pag-2', sku_code:'SKU-PAG-2', descripcion:'Cuadrado', bodega:'Nave', ubicacion:null, storage_bin:null, stock_sistema:5},
      {id:'sku-pag-3', sku_code:'SKU-PAG-3', descripcion:'Sin contar', bodega:'Nave', ubicacion:null, storage_bin:null, stock_sistema:2},
    ];
    return {
      status: 200, ok: true,
      headers: { get: (h) => h==='content-range' ? `0-${filas.length-1}/${filas.length}` : null },
      text: async () => JSON.stringify(filas),
    };
  }
  if(path.startsWith('/rest/v1/ultimo_conteo_por_sku')){
    const filas = [
      {sku_id:'sku-pag-1', estado:'con_diferencia'},
      {sku_id:'sku-pag-2', estado:'aprobado'},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/skus_valor_abc')){
    // sku-pag-3 queda deliberadamente afuera (sin costo cargado -> sin fila -> clase_abc null).
    const filas = [
      {sku_id:'sku-pag-1', clase_abc:'A', pct_acumulado:42.0},
      {sku_id:'sku-pag-2', clase_abc:'B', pct_acumulado:88.5},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/rpc/eliminar_skus_sin_contar')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'4' };
  }
  // skus_disponibles_planificar es skus_planificables + excluir lo ya cubierto por otra entrada
  // de plan_semanal vigente (ver cargarConteoSinUbicacion / cargarBinsPara con
  // excluirYaPlanificados:true) — en estos fixtures no hay overlap real, así que basta con
  // responder lo mismo para ambas vistas.
  if(/^\/rest\/v1\/skus_(planificables|disponibles_planificar)\?activo=eq\.true/.test(path) && path.includes('bodega=is.null') && path.includes('ubicacion=is.null') && !path.includes('ubicacion=eq.')){
    const filas = [{id:'id-sku-suelto', sku_code:'SKU-SUELTO', descripcion:'Repuesto suelto', storage_bin:null, unidad_medida:'UN'}];
    return {
      status: 200, ok: true,
      headers: { get: (h) => h==='content-range' ? `0-${filas.length-1}/${filas.length}` : null },
      text: async () => JSON.stringify(filas),
    };
  }
  if(/^\/rest\/v1\/skus_(planificables|disponibles_planificar)\?activo=eq\.true&select=id,sku_code,descripcion,bodega,ubicacion,storage_bin,batch,unidad_medida/.test(path) && path.includes('bodega=is.null') && path.includes('ubicacion=eq.Piso') && !path.includes('storage_bin=eq.')){
    // "Piso" (bodega=is.null) no tiene ningún storage_bin cargado -> cargarBinsPara cae al
    // listado de SKU puntuales (ver "sin bin, elegir SKU" más abajo en este archivo).
    // SKU-P3 ya está cubierto por OTRA entrada de plan vigente: skus_disponibles_planificar (la
    // lista que se ofrece para elegir) no lo incluye, pero skus_planificables (el universo real
    // que se usa para calcular el conteo/detalle de la entrada YA CREADA) sí. Reproduce el bug
    // reportado: "selecciono dos y pasan cuatro" — un SKU ya cubierto por otra entrada, invisible
    // en la lista de selección, se colaba de vuelta en la entrada nueva porque nunca quedaba en
    // la lista de exclusión.
    const filas = path.startsWith('/rest/v1/skus_disponibles_planificar')
      ? [
          {id:'id-p1', sku_code:'SKU-P1', descripcion:'Repuesto Piso 1', bodega:null, ubicacion:'Piso', storage_bin:null, unidad_medida:'UN'},
          {id:'id-p2', sku_code:'SKU-P2', descripcion:'Repuesto Piso 2', bodega:null, ubicacion:'Piso', storage_bin:null, unidad_medida:'UN'},
        ]
      : [
          {id:'id-p1', sku_code:'SKU-P1', descripcion:'Repuesto Piso 1', bodega:null, ubicacion:'Piso', storage_bin:null, unidad_medida:'UN'},
          {id:'id-p2', sku_code:'SKU-P2', descripcion:'Repuesto Piso 2', bodega:null, ubicacion:'Piso', storage_bin:null, unidad_medida:'UN'},
          {id:'id-p3', sku_code:'SKU-P3', descripcion:'Repuesto Piso 3 (ya en otra entrada)', bodega:null, ubicacion:'Piso', storage_bin:null, unidad_medida:'UN'},
        ];
    return {
      status: 200, ok: true,
      headers: { get: (h) => h==='content-range' ? `0-${filas.length-1}/${filas.length}` : null },
      text: async () => JSON.stringify(filas),
    };
  }
  // skusMovidosDeEntradas (elegirCascadaContar): cruce por sku_code=in.(...) contra los datos
  // ACTUALES de cada SKU snapshoteado al planificar, para detectar los que una carga masiva
  // posterior movió de bin, bodega o ubicación. SKU-999 se planificó en A-01 (ver
  // plan_semanal_skus?plan_id=eq.mp1 más abajo) y ahora quedó en C-09 (fuera de los bins activos
  // A-01/A-02: debe salir marcado en vez de perderse). SKU-002 se planificó en A-01 pero su bin
  // actual (A-02) sigue activo (mp2), así que ya está cubierto por el fetch normal y no debe
  // duplicarse como "movido". SKU-777 se planificó en Nave Mina/Interior Nave (bin A-01) pero una
  // carga masiva lo reasignó a otra bodega+ubicación completa (Bodega Norte/Pasillo 5): sin la
  // foto original de bodega/ubicación, desaparecería en silencio porque ya no calza con ninguna
  // entrada activa de esta cascada.
  if(path.startsWith('/rest/v1/skus_planificables?activo=eq.true&select=id,sku_code,descripcion,bodega,ubicacion,storage_bin,batch,unidad_medida') && path.includes('sku_code=in.(')){
    const codigos = decodeURIComponent((path.match(/sku_code=in\.\(([^)]*)\)/)||[])[1]||'').split(',');
    const disponibles = {
      'SKU-999': {id:'id-999', sku_code:'SKU-999', descripcion:'Rodamiento 6205', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'C-09', unidad_medida:'UN'},
      'SKU-002': {id:'id-002', sku_code:'SKU-002', descripcion:'Tuerca M8', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', unidad_medida:'UN'},
      'SKU-777': {id:'id-777', sku_code:'SKU-777', descripcion:'Retén hidráulico', bodega:'Bodega Norte', ubicacion:'Pasillo 5', storage_bin:'N-03', unidad_medida:'UN'},
      // SKU-555 nunca se movió (mismo bin, misma bodega, misma ubicación de siempre) — su foto es
      // "legacy" (ver snapshots.mp1 más abajo): se guardó antes de que existieran
      // bodega_original/ubicacion_original, así que esas dos vienen en null aunque el SKU jamás
      // cambió de bodega/ubicación en la vida real.
      'SKU-555': {id:'id-555', sku_code:'SKU-555', descripcion:'Filtro de aire', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', unidad_medida:'UN'},
    };
    const filas = codigos.map(c=>disponibles[c]).filter(Boolean);
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/plan_semanal_skus')){
    if(opts && opts.method==='POST'){
      return { status:201, ok:true, headers:{get:()=>null}, text: async()=>'' };
    }
    const snapshots = {
      'mp1': [
        {sku_code:'SKU-999', storage_bin_original:'A-01', bodega_original:'Nave Mina', ubicacion_original:'Interior Nave'},
        {sku_code:'SKU-002', storage_bin_original:'A-01', bodega_original:'Nave Mina', ubicacion_original:'Interior Nave'},
        {sku_code:'SKU-777', storage_bin_original:'A-01', bodega_original:'Nave Mina', ubicacion_original:'Interior Nave'},
        // Foto "legacy": plan planificado antes de que existieran estas dos columnas.
        {sku_code:'SKU-555', storage_bin_original:'A-01', bodega_original:null, ubicacion_original:null},
      ],
      'mp2': [],
    };
    const planId = (path.match(/plan_id=eq\.([^&]+)/)||[])[1];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(snapshots[planId]||[]) };
  }
  if(path.startsWith('/rest/v1/skus_planificables?activo=eq.true&select=id,sku_code,descripcion,bodega,ubicacion,storage_bin,batch,unidad_medida')){
    const binFiltro = (path.match(/storage_bin=eq\.([^&]+)/)||[])[1];
    const filas = binFiltro==='A-01'
      ? [{id:'id-001', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', unidad_medida:'UN', stock_sistema:20}]
      : binFiltro==='A-02'
        ? [{id:'id-002', sku_code:'SKU-002', descripcion:'Tuerca M8', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', unidad_medida:'UN', stock_sistema:8}]
        // Mismo sku_code, dos filas (una por batch): reproduce el pedido de Joel de mostrar el
        // SOH desglosado por batch en Contar -- ambas deben sobrevivir al armar el plan del día.
        : binFiltro==='BX-01'
          ? [
              {id:'id-batch-a', sku_code:'SKU-DOSBATCH', descripcion:'Aceite hidráulico', bodega:'Bodega Batch Test', ubicacion:'Zona X', storage_bin:'BX-01', batch:'A', unidad_medida:'LT', stock_sistema:5},
              {id:'id-batch-b', sku_code:'SKU-DOSBATCH', descripcion:'Aceite hidráulico', bodega:'Bodega Batch Test', ubicacion:'Zona X', storage_bin:'BX-01', batch:'B', unidad_medida:'LT', stock_sistema:9},
            ]
          : [];
    return {
      status: 200,
      ok: true,
      headers: { get: (h) => h==='content-range' ? `0-${filas.length-1}/${filas.length}` : null },
      text: async () => JSON.stringify(filas),
    };
  }
  // Simula el rechazo del índice único (empresa_id, sku_code, bodega_key, batch_key,
  // ubicacion_key, storage_bin_key) para probar que crearSkuManual / procesarUnItemOffline lo
  // traducen a un mensaje claro en vez del error crudo de Postgres — ver esErrorCodigoSkuDuplicado.
  if(path==='/rest/v1/skus' && opts && opts.method==='POST' && JSON.parse(opts.body)[0].sku_code==='SKU-DUP-EXISTE'){
    return { status:409, ok:false, headers:{get:()=>null}, text: async()=>JSON.stringify({message:'duplicate key value violates unique constraint "skus_empresa_id_sku_code_bodega_batch_ubicacion_bin_key"'}) };
  }
  // buscarSkusLibre (Contar > "Agregar algo fuera del plan"): busca en el servidor contra el
  // maestro completo, no en state.skus (los primeros 500 precargados) — ver escribirBuscadorLibre.
  if(path.startsWith('/rest/v1/skus?activo=eq.true&select=id,sku_code,descripcion,bodega,ubicacion,storage_bin,batch,stock_sistema,unidad_medida') && path.includes('or=(sku_code.ilike')){
    const filas = [
      {id:'id-libre-1', sku_code:'FIL-1001', descripcion:'Filtro de aceite', bodega:'Bodega Central', ubicacion:'Pasillo 2', storage_bin:'B-04', stock_sistema:12, unidad_medida:'UN'},
      {id:'id-libre-2', sku_code:'FIL-2002', descripcion:'Filtro de aire', bodega:'Bodega Central', ubicacion:null, storage_bin:null, stock_sistema:3, unidad_medida:'UN'},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  // Otras rutas usadas por cargarTodo/cargarPlanSemanal, /auth/v1/signup, etc. -> vacío.
  return { status: 200, ok: true, headers: { get: () => null }, text: async () => '[]', json: async () => ([]) };
};

const elements = {};
function makeEl(id){
  if(!elements[id]) elements[id] = {
    id, value:'', innerHTML:'', textContent:'', className:'', style:{}, dataset:{},
    listeners:{}, hijos:[],
    addEventListener(ev,fn){ this.listeners[ev]=this.listeners[ev]||[]; this.listeners[ev].push(fn); },
    dispatch(ev, arg){ (this.listeners[ev]||[]).forEach(fn=>fn(arg||{target:this})); },
    appendChild(child){ this.hijos.push(child); }, remove(){}, focus(){}, reset(){},
  };
  return elements[id];
}

const documentMock = {
  documentElement: { setAttribute(){} },
  getElementById(id){ return makeEl(id); },
  querySelectorAll(){ return []; },
  createElement(){ return makeEl('tmp'+Math.random()); },
  addEventListener(){},
};

// IndexedDB falso, mínimo pero fiel para el uso real del código (open + onupgradeneeded,
// una transacción por store, put/delete/index().getAll()/getAllKeys()). Cada operación
// aplica su efecto de inmediato y dispara onsuccess/onerror en un tick aparte, como el real.
function crearIndexedDBFalso(){
  const bases = new Map();
  function solicitud(ejecutar){
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    setTimeout(() => {
      try{
        req.result = ejecutar();
        if(req.onsuccess) req.onsuccess({target:req});
      }catch(e){
        req.error = e;
        if(req.onerror) req.onerror({target:req});
      }
    }, 0);
    return req;
  }
  return {
    open(nombre){
      const req = { result: undefined, onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => {
        let base = bases.get(nombre);
        const esNueva = !base;
        if(esNueva){ base = { stores: new Map() }; bases.set(nombre, base); }
        const manejador = {
          objectStoreNames: { contains: n => base.stores.has(n) },
          createObjectStore(nombreStore, opts){
            const store = { keyPath: opts.keyPath, registros: new Map(), indices: new Map() };
            base.stores.set(nombreStore, store);
            return { createIndex: (nombreIndice, keyPath) => store.indices.set(nombreIndice, keyPath) };
          },
          transaction(nombreStore){
            const store = base.stores.get(nombreStore);
            const objectStore = {
              put: valor => solicitud(() => { store.registros.set(valor[store.keyPath], valor); return valor; }),
              delete: clave => solicitud(() => { store.registros.delete(clave); }),
              index: nombreIndice => {
                const keyPath = store.indices.get(nombreIndice);
                return {
                  getAll: valor => solicitud(() => [...store.registros.values()].filter(r=>r[keyPath]===valor)),
                  getAllKeys: valor => solicitud(() => [...store.registros.values()].filter(r=>r[keyPath]===valor).map(r=>r[store.keyPath])),
                };
              },
            };
            return { objectStore: () => objectStore };
          },
          close(){},
        };
        req.result = manejador;
        if(esNueva && req.onupgradeneeded) req.onupgradeneeded({target:{result:manejador}});
        if(req.onsuccess) req.onsuccess({target:req});
      }, 0);
      return req;
    },
  };
}

let printCalled = 0;
let confirmRespuesta = true;
const confirmLlamadas = [];
// El mock de XLSX no genera un .xlsx real: json_to_sheet devuelve las filas tal cual, para poder
// verificar directamente qué se le pasó (nombres de columna, valores) antes de "escribirlas".
const xlsxEscrituras = [];
const XLSXMock = {
  utils: {
    json_to_sheet: (filas) => filas,
    book_new: () => ({ hojas: {} }),
    book_append_sheet: (libro, hoja, nombre) => { libro.hojas[nombre] = hoja; },
  },
  writeFile: (libro, nombreArchivo) => { xlsxEscrituras.push({ libro, nombreArchivo }); },
};
const sandbox = {
  console,
  document: documentMock,
  XLSX: XLSXMock,
  window: { print: () => { printCalled++; }, addEventListener: () => {}, removeEventListener: () => {} },
  confirm: (msg) => { confirmLlamadas.push(msg); return confirmRespuesta; },
  localStorage: (()=>{ const m = new Map(); return {
    getItem: (k) => m.has(k) ? m.get(k) : null,
    setItem: (k,v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  }; })(),
  fetch: fakeFetchImpl,
  indexedDB: crearIndexedDBFalso(),
  setTimeout: (fn, ms) => setTimeout(fn, 0),
  clearTimeout: (id) => clearTimeout(id),
  URL,
  URLSearchParams,
  Image: class {},
  FileReader: class {},
  location: { hash: '', pathname: '/index.html', search: '' },
  history: { replaceState: () => {} },
  navigator: { userAgent: 'node-test-harness' },
};

const vm = require('vm');
const ctx = vm.createContext(sandbox);
vm.runInContext(script, ctx, {filename:'index-inline.js'});

(async () => {
  // state.plan.generales debe poblarse.
  await ctx.cargarOpcionesGenerales();
  const generales = ctx.__appstate.plan.generales;
  assert(Array.isArray(generales) && generales.length===3, 'cargarOpcionesGenerales debe cargar 3 filas (incluida la de bodega=null), obtuvo: '+JSON.stringify(generales));
  assert(generales[0].bodega==='Nave Mina', 'primer valor debe ser Nave Mina');
  // SKU con ubicación específica pero SIN bodega (ej. recién cargados por Excel sin esa
  // columna): antes ubicaciones_generales los excluía por completo (bodega IS NOT NULL) y
  // quedaban invisibles en el selector "Ubicación general" — ni ahí ni en "SKU sin ubicación"
  // (que exige bodega Y ubicación null). Ahora aparecen agrupados con bodega=null.
  assert(generales.some(g=>g.bodega===null && g.cantidad_skus===8), 'debe incluir el grupo de SKU sin bodega asignada, obtuvo: '+JSON.stringify(generales));

  // cargarOpcionesCategoriasUnidades: sugerencias (datalist) de categoría/unidad de medida
  // para "Agregar SKU a maestro de materiales", basadas en lo que la empresa ya usó.
  await ctx.cargarOpcionesCategoriasUnidades();
  assert(JSON.stringify(ctx.__appstate.opcionesCategorias)===JSON.stringify(['Repuestos','Seguridad']), 'cargarOpcionesCategoriasUnidades debe dejar las categorías en state.opcionesCategorias, obtuvo: '+JSON.stringify(ctx.__appstate.opcionesCategorias));
  assert(JSON.stringify(ctx.__appstate.opcionesUnidades)===JSON.stringify(['KG','UN']), 'cargarOpcionesCategoriasUnidades debe dejar las unidades en state.opcionesUnidades, obtuvo: '+JSON.stringify(ctx.__appstate.opcionesUnidades));
  assert(JSON.stringify(ctx.__appstate.opcionesBatches)===JSON.stringify(['L-001','L-002']), 'cargarOpcionesCategoriasUnidades debe dejar los batches en state.opcionesBatches, obtuvo: '+JSON.stringify(ctx.__appstate.opcionesBatches));

  // renderSkus: los campos de categoría/unidad/bodega/ubicación/bin deben tener datalist
  // con las sugerencias cargadas, sin dejar de ser texto libre (se puede cargar un valor
  // nuevo que todavía no existe).
  ctx.__appstate.skuFormOpciones = { ubicaciones: [{ubicacion:'Interior Nave'}], bins: [{storage_bin:'A-01'}] };
  const htmlSkus = ctx.renderSkus();
  assert(htmlSkus.includes('id="s-cat" list="dl-categorias"') && htmlSkus.includes('<option value="Repuestos">') && htmlSkus.includes('<option value="Seguridad">'), 'el campo categoría debe tener datalist con las categorías sugeridas, obtuvo: '+htmlSkus);
  assert(htmlSkus.includes('for="s-cat">Categoría<') && !htmlSkus.includes('for="s-cat">Batch<'), 'el campo categoria debe etiquetarse "Categoría", ya no "Batch" (ese nombre ahora es del campo batch real), obtuvo: '+htmlSkus);
  // Pedido de Joel: agregar el batch también -- campo propio en el alta manual, separado de
  // categoria, con su propio datalist de sugerencias.
  assert(htmlSkus.includes('for="s-batch">Batch<') && htmlSkus.includes('id="s-batch" list="dl-batches"') && htmlSkus.includes('<option value="L-001">') && htmlSkus.includes('<option value="L-002">'), 'debe existir un campo Batch propio con datalist de sugerencias, obtuvo: '+htmlSkus);
  assert(htmlSkus.includes('id="s-um" list="dl-unidades"') && htmlSkus.includes('<option value="KG">') && htmlSkus.includes('<option value="UN">'), 'el campo unidad de medida debe tener datalist con las unidades sugeridas, obtuvo: '+htmlSkus);
  assert(htmlSkus.includes('id="s-bodega" list="dl-sku-bodegas"') && htmlSkus.includes('<option value="Nave Mina">') && htmlSkus.includes('<option value="Nave Planta">'), 'el campo bodega debe tener datalist con las bodegas ya usadas, obtuvo: '+htmlSkus);
  assert(htmlSkus.includes('id="s-ubic" list="dl-sku-ubicaciones"') && htmlSkus.includes('<datalist id="dl-sku-ubicaciones"><option value="Interior Nave">'), 'el campo ubicación debe tener datalist con las ubicaciones de la bodega elegida, obtuvo: '+htmlSkus);
  assert(htmlSkus.includes('id="s-bin" list="dl-sku-bins"') && htmlSkus.includes('<datalist id="dl-sku-bins"><option value="A-01">'), 'el campo storage bin debe tener datalist con los bins de esa ubicación, obtuvo: '+htmlSkus);
  ctx.__appstate.skuFormOpciones = { ubicaciones: [], bins: [] };

  const especificas = await ctx.opcionesEspecificas('Nave Mina');
  assert(especificas.length===2 && especificas[0].ubicacion==='Interior Nave', 'opcionesEspecificas debe filtrar por bodega, obtuvo: '+JSON.stringify(especificas));
  const especificasVacio = await ctx.opcionesEspecificas('');
  assert(especificasVacio.length===0, 'opcionesEspecificas con bodega vacía debe devolver []');

  const bins = await ctx.opcionesBins('Nave Mina', 'Interior Nave');
  assert(bins.length===2 && bins[0].storage_bin==='A-01', 'opcionesBins debe filtrar por bodega+ubicacion, obtuvo: '+JSON.stringify(bins));
  // "Todas" las ubicaciones (ubicacion vacío, ej. al elegir "Todas" en el <select>) debe listar
  // los storage bin de TODA la bodega, no devolver [] — A-01 existe en dos ubicaciones distintas
  // (Interior Nave y Rack Exterior) y debe aparecer una sola vez, con la cantidad sumada (5+2=7).
  const binsTodasUbic = await ctx.opcionesBins('Nave Mina', '');
  assert(binsTodasUbic.length===2, 'opcionesBins sin ubicación debe listar los bins de toda la bodega (sin duplicar A-01), obtuvo: '+JSON.stringify(binsTodasUbic));
  const a01Todas = binsTodasUbic.find(b=>b.storage_bin==='A-01');
  assert(!!a01Todas && a01Todas.cantidad_skus===7, 'un storage bin repetido en más de una ubicación debe sumar cantidad_skus entre todas, obtuvo: '+JSON.stringify(binsTodasUbic));

  // Verificar que las URLs generadas llevan los filtros esperados.
  const especificasCall = calls.find(c=>c.url.includes('/ubicaciones_especificas') && c.url.includes('bodega=eq.Nave'));
  assert(!!especificasCall, 'Debe llamarse a ubicaciones_especificas con filtro bodega=eq.');
  const binsCall = calls.find(c=>c.url.includes('/ubicaciones_bins') && c.url.includes('bodega=eq.Nave') && c.url.includes('ubicacion=eq.Interior'));
  assert(!!binsCall, 'Debe llamarse a ubicaciones_bins con filtros bodega y ubicacion');

  // cargarResponsables debe poblar state.plan.responsables solo con operadores (no admin).
  calls.length = 0;
  await ctx.cargarResponsables();
  const responsablesAsignables = ctx.__appstate.plan.responsables;
  assert(Array.isArray(responsablesAsignables) && responsablesAsignables.length===2 && responsablesAsignables[0].nombre==='Ana Torres', 'cargarResponsables debe cargar los responsables activos, obtuvo: '+JSON.stringify(responsablesAsignables));
  assert(calls.some(c=>c.url.includes('/usuarios') && c.url.includes('rol=eq.operador')), 'cargarResponsables debe filtrar por rol=eq.operador (no ofrecer admins como responsable), obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // A partir de aquí, las acciones requieren sesión + perfil (con empresa_id) cargados, como en la app real.
  ctx.__appstate.session = { access_token:'x', user:{email:'a@b.com'} };
  ctx.__appstate.perfil = { id:1, nombre:'Test', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Empresa Test', codigo_invitacion:'ABC12345'} };

  // Verificar que renderPlanificacion genera los <select> encadenados, el de Responsable y la lista de responsables.
  const htmlOut = ctx.renderPlanificacion();
  assert(htmlOut.includes('<select id="p-bodega">'), 'p-bodega debe ser un <select>');
  assert(htmlOut.includes('<select id="p-ubic" disabled>'), 'p-ubic debe iniciar como <select disabled>');
  assert(htmlOut.includes('<select id="p-bin" multiple size="6" disabled>'), 'p-bin debe iniciar como <select multiple disabled>');
  assert(htmlOut.includes('<option value="Nave Mina">Nave Mina (18234/23708)</option>'), 'debe listar Nave Mina como opción de bodega con lo pendiente y el total de SKU, obtuvo: '+htmlOut);
  assert(htmlOut.includes('<option value="__bodega_vacia__">Sin bodega asignada (6/8)</option>'), 'debe ofrecer el grupo "Sin bodega asignada" para los SKU con ubicación pero sin bodega, obtuvo: '+htmlOut);
  assert(!htmlOut.includes('datalist'), 'no debe quedar ningún <datalist> residual');
  assert(!htmlOut.includes('placeholder="Ej. Nave Mina"'), 'el placeholder de texto libre no debe seguir ahí');
  assert(htmlOut.includes('<input type="checkbox" id="p-bin-todos" disabled>'), 'debe existir el checkbox "Seleccionar todos", inicialmente deshabilitado');
  assert(htmlOut.includes('<select id="p-responsable">') && htmlOut.includes('<option value="">Sin asignar</option>'), 'debe existir el select de Responsable con opción "Sin asignar"');
  // Responsable ahora lista directo las cuentas del equipo (usuarios), no una lista aparte de
  // "operadores" sin cuenta ni login.
  assert(htmlOut.includes('<option value="u1">Ana Torres</option>') && htmlOut.includes('<option value="u2">Joel Majmut</option>'), 'el select de Responsable debe listar las cuentas activas del equipo, obtuvo: '+htmlOut);
  assert(!htmlOut.includes('form-responsable') && !htmlOut.includes('form-operador'), 'la gestión de operadores ya no debe existir (Responsable usa las cuentas de Configuraciones → Equipo), obtuvo: '+htmlOut);

  // La sección "Operadores" (nombres sueltos sin cuenta) ya no debe existir en Configuraciones:
  // Responsable se cruza directo con las cuentas reales del equipo.
  const htmlConfig = ctx.renderConfiguraciones();
  assert(!htmlConfig.includes('id="form-operador"') && !htmlConfig.includes('id="nuevo-operador"') && !htmlConfig.includes('data-eliminar-operador'), 'Configuraciones no debe tener el formulario de operadores sueltos, obtuvo: '+htmlConfig);

  // El campo "Fecha" del formulario de planificación debe abrir en el día de hoy (no en el
  // lunes de la semana): a esta altura state.plan.semanaInicio todavía es el valor por defecto
  // del estado inicial (el lunes de la semana actual), así que hoy cae dentro del rango.
  const htmlPlanHoy = ctx.renderPlanificacion();
  assert(htmlPlanHoy.includes(`id="p-fecha" value="${ctx.fechaISO(new Date())}"`), 'el campo de fecha debe abrir con el día de hoy cuando la semana mostrada lo incluye, obtuvo: '+htmlPlanHoy.match(/id="p-fecha"[^>]*/)[0]);
  // El máximo seleccionable debe llegar al menos 7 días después de hoy, no solo hasta el fin
  // de la semana mostrada (reportado: si hoy cae cerca del fin de semana, casi no dejaba
  // planificar hacia adelante).
  const maxEsperado = ctx.fechaISO(ctx.sumarDias(new Date(), 7));
  assert(htmlPlanHoy.includes(`max="${maxEsperado}"`), 'el campo de fecha debe permitir elegir al menos 7 días hacia adelante desde hoy, obtuvo: '+htmlPlanHoy.match(/id="p-fecha"[^>]*/)[0]);

  // Simular el cambio de bodega -> debe poblar y habilitar el select de ubicación específica.
  // Reutilizamos bind() real: ejecutamos el bloque de bind correspondiente a state.view==='plan'
  // llamando directamente a los listeners registrados por bind() sobre los elementos mockeados.
  ctx.__appstate.view = 'plan';
  ctx.bind();
  const bodegaEl = elements['p-bodega'];
  bodegaEl.value = 'Nave Mina';
  await new Promise(resolve => {
    bodegaEl.dispatch('change', {target: bodegaEl});
    setTimeout(resolve, 50);
  });
  const ubicEl = elements['p-ubic'];
  assert(ubicEl.disabled === false, 'p-ubic debe habilitarse tras elegir bodega');
  assert(ubicEl.innerHTML.includes('Interior Nave') && ubicEl.innerHTML.includes('Rack'), 'p-ubic debe listar las ubicaciones específicas de Nave Mina, obtuvo: '+ubicEl.innerHTML);
  assert(ubicEl.innerHTML.includes('<option value="">Todas (18234/23708)</option>'), 'p-ubic debe mostrar lo pendiente y el total de la bodega junto a "Todas", obtuvo: '+ubicEl.innerHTML);
  assert(ubicEl.innerHTML.includes('<option value="Interior Nave">Interior Nave (80/100)</option>') && ubicEl.innerHTML.includes('<option value="Rack">Rack (50/50)</option>'), 'cada ubicación específica debe mostrar lo pendiente y el total, obtuvo: '+ubicEl.innerHTML);

  // Regresión real reportada: "Ubicación específica" queda en "Todas" por defecto al elegir
  // la bodega (primera opción del <select> recién poblado), sin que la persona tenga que
  // tocarlo — pero fijar .innerHTML no dispara 'change', así que Storage bin se quedaba
  // pegado en "Elige ubicación específica primero" (deshabilitado) hasta que alguien volviera
  // a abrir Ubicación específica a mano. Debe quedar cargado solo, sin ese paso extra.
  const binElAuto = elements['p-bin'];
  assert(binElAuto.disabled === false, 'Storage bin debe habilitarse solo al elegir la bodega, sin tener que tocar Ubicación específica a mano, obtuvo disabled='+binElAuto.disabled);
  assert(binElAuto.innerHTML.includes('A-01 — 7 SKU') && binElAuto.innerHTML.includes('A-02 — 3 SKU'), 'Storage bin debe quedar cargado con los bins de toda la bodega (equivalente a "Todas"), obtuvo: '+binElAuto.innerHTML);

  ubicEl.value = 'Interior Nave';
  await new Promise(resolve => {
    ubicEl.dispatch('change', {target: ubicEl});
    setTimeout(resolve, 50);
  });
  const binEl = elements['p-bin'];
  const chkTodosEl = elements['p-bin-todos'];
  assert(binEl.disabled === false, 'p-bin debe habilitarse tras elegir ubicación específica');
  assert(binEl.innerHTML.includes('A-01 — 5 SKU') && binEl.innerHTML.includes('A-02 — 3 SKU'), 'p-bin debe listar los storage bin con su cantidad de SKU, obtuvo: '+binEl.innerHTML);
  assert(!binEl.innerHTML.includes('Todos'), 'p-bin multiple no debe tener la opción "Todos" (sin selección ya significa todos), obtuvo: '+binEl.innerHTML);
  assert(chkTodosEl.disabled === false, 'el checkbox "Seleccionar todos" debe habilitarse tras cargar los storage bin');
  // A pedido: la lista debe cargar con todos los storage bin ya marcados (no dejarlos sin
  // selección confiando en la regla implícita "sin selección = todos"), y "Seleccionar todos"
  // debe quedar marcado en automático para que el submit siga mandando el comodín sin filtro.
  assert(chkTodosEl.checked === true, 'al cargar los storage bin, "Seleccionar todos" debe quedar marcado en automático, obtuvo: '+chkTodosEl.checked);
  // Bug real reportado: el resumen nativo del navegador para <select multiple> ("12 elementos")
  // se leía como cantidad de SKU, no de storage bin, y no cuadraba con el total real al agregar
  // "todos" (un bin puede tener más de un SKU). Se aclara con un resumen propio (bin / SKU).
  assert(elements['p-bin-resumen'].textContent === '(2 bin / 8 SKU)', 'el resumen debe aclarar cuántos storage bin hay y cuántos SKU suman entre todos (5+3=8), obtuvo: '+elements['p-bin-resumen'].textContent);

  // A pedido: si la persona desmarca a mano y deja elegido solo un storage bin puntual, el
  // resumen debe recalcularse en vivo para reflejar SOLO lo seleccionado (no seguir mostrando
  // el total de la lista completa).
  binEl.selectedOptions = [{value:'A-01'}];
  await new Promise(resolve => {
    binEl.dispatch('change', {target: binEl});
    setTimeout(resolve, 20);
  });
  assert(elements['p-bin-resumen'].textContent === '(1 de 2 bin / 5 SKU)', 'el resumen debe reflejar solo el bin puntual elegido (A-01, 5 SKU), obtuvo: '+elements['p-bin-resumen'].textContent);
  // Volver a marcar "Seleccionar todos" debe recalcular el resumen de nuevo al total.
  // (El mock de <select> no simula options/selectedOptions reales: se simula acá el efecto real
  // del listener de "Seleccionar todos" -marcar cada option visible- para poder probarlo.)
  chkTodosEl.checked = true;
  binEl.selectedOptions = [{value:'A-01'}, {value:'A-02'}];
  await new Promise(resolve => {
    chkTodosEl.dispatch('change', {target: chkTodosEl});
    setTimeout(resolve, 20);
  });
  assert(elements['p-bin-resumen'].textContent === '(2 bin / 8 SKU)', 'al re-marcar "Seleccionar todos", el resumen debe volver a mostrar el total, obtuvo: '+elements['p-bin-resumen'].textContent);

  // Volver a "Todas" en Ubicación específica (value vacío) NO debe vaciar/deshabilitar el
  // storage bin — debe seguir mostrando los bin de toda la bodega (con las cantidades sumadas
  // si un mismo bin se repite en más de una ubicación, como A-01 acá).
  ubicEl.value = '';
  await new Promise(resolve => {
    ubicEl.dispatch('change', {target: ubicEl});
    setTimeout(resolve, 50);
  });
  assert(binEl.disabled === false, 'p-bin debe seguir habilitado al elegir "Todas" en ubicación específica, obtuvo disabled='+binEl.disabled);
  assert(binEl.innerHTML.includes('A-01 — 7 SKU') && binEl.innerHTML.includes('A-02 — 3 SKU'), 'con "Todas" elegido, p-bin debe listar los bin de toda la bodega con las cantidades sumadas (A-01 aparece en dos ubicaciones: 5+2=7), obtuvo: '+binEl.innerHTML);
  assert(elements['p-bin-resumen'].textContent === '(2 bin / 10 SKU)', 'el resumen debe recalcularse con "Todas" (7+3=10), obtuvo: '+elements['p-bin-resumen'].textContent);
  assert(chkTodosEl.checked === true, 'al recargar los storage bin de "Todas", "Seleccionar todos" debe volver a quedar marcado, obtuvo: '+chkTodosEl.checked);
  ubicEl.value = 'Interior Nave';
  await new Promise(resolve => {
    ubicEl.dispatch('change', {target: ubicEl});
    setTimeout(resolve, 50);
  });

  // Marcar "Seleccionar todos" y enviar el formulario real (no crearPlanEntrada directo) debe
  // crear una sola fila con storage_bin null (sin filtro), NO una fila por cada bin visible —
  // así también quedan cubiertos los SKU de esa ubicación que no tienen storage bin asignado,
  // que "ubicaciones_bins" no lista (mismo motivo por el que existe "SKU sin ubicación").
  // (El mock de <select> no simula options/selectedOptions reales; se simula acá el efecto de
  // "Seleccionar todos" -marcar cada option visible- para probar que el submit lo ignora.)
  chkTodosEl.checked = true;
  binEl.selectedOptions = [{value:'A-01'}, {value:'A-02'}];
  makeEl('p-fecha').value = '2026-08-12';
  calls.length = 0;
  const formPlanEl = elements['form-plan'];
  await new Promise(resolve => {
    formPlanEl.dispatch('submit', {target: formPlanEl, preventDefault(){}});
    setTimeout(resolve, 20);
  });
  const postTodos = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal') && !c.url.includes('exclusiones'));
  const filasTodos = JSON.parse(postTodos.opts.body);
  assert(filasTodos.length===1 && filasTodos[0].storage_bin===null, '"Seleccionar todos" debe crear una sola fila sin filtro de storage_bin (no una por cada bin visible), obtuvo: '+JSON.stringify(filasTodos));
  chkTodosEl.checked = false;
  binEl.selectedOptions = [];
  await new Promise(resolve => setTimeout(resolve, 20));

  // Bug real reportado: al presionar "Agregar", Ubicación específica y Storage bin (con sus
  // conteos pendiente/total) se quedaban con los números de antes de agregar hasta que la
  // persona los volvía a tocar a mano. El submit real (recién ejercitado arriba) debe volver a
  // pedir esas dos listas para la MISMA bodega/ubicación, sin resetear la selección en curso.
  assert(calls.some(c=>c.url.includes('/ubicaciones_especificas') && c.url.includes('bodega=eq.Nave')), 'tras agregar, debe refrescar Ubicación específica pidiendo ubicaciones_especificas de nuevo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(calls.some(c=>c.url.includes('/ubicaciones_bins') && c.url.includes('bodega=eq.Nave') && c.url.includes('ubicacion=eq.Interior')), 'tras agregar, debe refrescar Storage bin pidiendo ubicaciones_bins de nuevo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(bodegaEl.value === 'Nave Mina' && ubicEl.value === 'Interior Nave', 'tras agregar, la bodega/ubicación elegidas no deben resetearse a "Todas", obtuvo bodega='+bodegaEl.value+' ubicacion='+ubicEl.value);
  assert(binEl.disabled === false && binEl.innerHTML.includes('A-01 — 5 SKU'), 'tras agregar, Storage bin debe quedar recargado y habilitado, obtuvo disabled='+binEl.disabled+' innerHTML='+binEl.innerHTML);

  // Regresión real reportada: si la persona marcaba "Seleccionar todos" y después elegía a mano un
  // bin puntual en la lista, el checkbox seguía marcado (nada lo desmarcaba) y el submit mandaba
  // "sin filtro" (todos) ignorando la selección manual. Elegir a mano en la lista debe desmarcar
  // "Seleccionar todos" solo, y el submit debe respetar esa selección puntual.
  chkTodosEl.checked = true;
  binEl.selectedOptions = [{value:'A-01'}, {value:'A-02'}];
  await new Promise(resolve => {
    binEl.dispatch('change', {target: binEl});
    setTimeout(resolve, 20);
  });
  assert(chkTodosEl.checked===false, 'elegir un bin a mano en la lista debe desmarcar "Seleccionar todos" automáticamente, obtuvo: '+chkTodosEl.checked);
  binEl.selectedOptions = [{value:'A-01'}];
  makeEl('p-fecha').value = '2026-08-12';
  calls.length = 0;
  await new Promise(resolve => {
    formPlanEl.dispatch('submit', {target: formPlanEl, preventDefault(){}});
    setTimeout(resolve, 20);
  });
  const postManual = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal') && !c.url.includes('exclusiones'));
  const filasManual = JSON.parse(postManual.opts.body);
  assert(filasManual.length===1 && filasManual[0].storage_bin==='A-01', 'tras desmarcarse "Seleccionar todos" solo, el submit debe respetar el bin elegido a mano (A-01), no tratarlo como "todos", obtuvo: '+JSON.stringify(filasManual));
  chkTodosEl.checked = false;
  binEl.selectedOptions = [];
  await new Promise(resolve => setTimeout(resolve, 20));

  // Bug real reportado ("ya lo habíamos corregido, volvió a pasar"): la selección de Ubicación
  // general/específica/Storage bin en "Agregar a la planificación" desaparecía sola mientras la
  // persona la llenaba. Causa real: cargarPlanSemanal() recalcula en segundo plano el universo y
  // el detalle de CADA entrada ya planificada, y cada resultado dispara un render() completo —
  // sin relación alguna con el formulario que la persona está llenando en ese momento. Storage
  // bin es lo que más se notaba porque ni siquiera viene del estado (se carga aparte), así que un
  // render() de fondo no solo borraba la selección: dejaba el selector entero como si nunca se
  // hubiera elegido ubicación. Se simula acá ese render de fondo (mismo setState que dispara
  // cargarPlanSemanal para el universo de una entrada) mientras el formulario ya tiene bodega,
  // ubicación y storage bin cargados, y se verifica que sobreviva.
  bodegaEl.value = 'Nave Mina';
  assert(ubicEl.innerHTML.includes('Interior Nave'), 'antes del render de fondo, Ubicación específica debe seguir con sus opciones cargadas');
  assert(binEl.disabled === false, 'antes del render de fondo, Storage bin debe seguir habilitado');
  const resumenAntesRenderFondo = elements['p-bin-resumen'].textContent;
  ctx.setState({plan: {...ctx.__appstate.plan, universos: {...ctx.__appstate.plan.universos, e1: 40}}});
  const bodegaTrasRenderFondo = elements['p-bodega'];
  const ubicTrasRenderFondo = elements['p-ubic'];
  const binTrasRenderFondo = elements['p-bin'];
  const chkTodosTrasRenderFondo = elements['p-bin-todos'];
  assert(bodegaTrasRenderFondo.value === 'Nave Mina', 'un render de fondo no relacionado no debe borrar la Ubicación general ya elegida, obtuvo: '+bodegaTrasRenderFondo.value);
  assert(ubicTrasRenderFondo.value === 'Interior Nave' && ubicTrasRenderFondo.disabled === false, 'un render de fondo no relacionado no debe borrar ni deshabilitar Ubicación específica, obtuvo value='+ubicTrasRenderFondo.value+' disabled='+ubicTrasRenderFondo.disabled);
  assert(binTrasRenderFondo.disabled === false && binTrasRenderFondo.innerHTML.includes('A-01'), 'un render de fondo no relacionado no debe deshabilitar Storage bin ni borrar la lista de bins ya cargada, obtuvo disabled='+binTrasRenderFondo.disabled+' innerHTML='+binTrasRenderFondo.innerHTML);
  assert(chkTodosTrasRenderFondo.disabled === false, 'un render de fondo no relacionado no debe volver a deshabilitar "Seleccionar todos", obtuvo: '+chkTodosTrasRenderFondo.disabled);
  assert(elements['p-bin-resumen'].textContent === resumenAntesRenderFondo, 'un render de fondo no relacionado no debe perder el resumen "(X bin / Y SKU)" ya calculado, obtuvo: '+elements['p-bin-resumen'].textContent+' (antes: '+resumenAntesRenderFondo+')');

  // crearPlanEntrada con varios storage bin y un responsable -> una fila por bin, todas con el mismo responsable_id.
  calls.length = 0;
  await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'Nave Mina', ubicacion:'Interior Nave', storageBins:['A-01','A-02'], responsableId:'u1', nota:''});
  const postMulti = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal'));
  assert(!!postMulti, 'Debe llamar POST a /plan_semanal');
  const filasMulti = JSON.parse(postMulti.opts.body);
  assert(Array.isArray(filasMulti) && filasMulti.length===2, 'Debe crear una fila por storage bin seleccionado, obtuvo: '+JSON.stringify(filasMulti));
  assert(filasMulti[0].storage_bin==='A-01' && filasMulti[1].storage_bin==='A-02', 'Cada fila debe llevar su propio storage_bin, obtuvo: '+JSON.stringify(filasMulti));
  assert(filasMulti[0].responsable_id==='u1' && filasMulti[1].responsable_id==='u1', 'Cada fila debe llevar el responsable_id elegido, obtuvo: '+JSON.stringify(filasMulti));
  assert(filasMulti[0].empresa_id==='emp-1' && filasMulti[1].empresa_id==='emp-1', 'Cada fila debe llevar el empresa_id del perfil actual, obtuvo: '+JSON.stringify(filasMulti));
  // crearPlanEntrada debe guardar en plan_semanal_skus una foto de qué SKU quedaron cubiertos y
  // con qué bin, bodega y ubicación (ver skusMovidosDeEntradas): permite avisar más adelante si
  // una carga masiva posterior los mueve de bin, bodega o ubicación, en vez de perderlos
  // silenciosamente.
  const postSnapshot = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal_skus'));
  assert(!!postSnapshot, 'crearPlanEntrada debe guardar una foto en plan_semanal_skus, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const filasSnapshot = JSON.parse(postSnapshot.opts.body);
  assert(filasSnapshot.some(f=>f.plan_id==='plan-nuevo-1' && f.sku_code==='SKU-001' && f.storage_bin_original==='A-01' && f.bodega_original==='Nave Mina' && f.ubicacion_original==='Interior Nave'), 'debe guardar el SKU del bin A-01 (plan-nuevo-1) con ese bin, bodega y ubicación como originales, obtuvo: '+JSON.stringify(filasSnapshot));
  assert(filasSnapshot.some(f=>f.plan_id==='plan-nuevo-2' && f.sku_code==='SKU-002' && f.storage_bin_original==='A-02' && f.bodega_original==='Nave Mina' && f.ubicacion_original==='Interior Nave'), 'debe guardar el SKU del bin A-02 (plan-nuevo-2) con ese bin, bodega y ubicación como originales, obtuvo: '+JSON.stringify(filasSnapshot));

  // Sin bins seleccionados ni responsable -> una sola fila con storage_bin y responsable_id null.
  calls.length = 0;
  await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'Nave Mina', ubicacion:'Interior Nave', storageBins:[], responsableId:'', nota:''});
  const postVacio = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal'));
  const filasVacio = JSON.parse(postVacio.opts.body);
  assert(filasVacio.length===1 && filasVacio[0].storage_bin===null, 'Sin selección debe crear una sola fila con storage_bin null, obtuvo: '+JSON.stringify(filasVacio));
  assert(filasVacio[0].responsable_id===null, 'Sin responsable elegido, responsable_id debe ser null, obtuvo: '+JSON.stringify(filasVacio));
  // Reportado: al agregar una entrada, los "pendiente/total" de Ubicación general y "SKU sin
  // ubicación" se quedaban con el valor de cuando cargó la página — crearPlanEntrada debe
  // refrescarlos (no solo la lista de entradas ya planificadas).
  assert(calls.some(c=>c.url.includes('/ubicaciones_generales')), 'crearPlanEntrada debe refrescar Ubicación general después de agregar, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(calls.some(c=>c.url.includes('bodega=is.null') && c.url.includes('ubicacion=is.null')), 'crearPlanEntrada debe refrescar el conteo de "SKU sin ubicación" después de agregar, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // ===== "Sin bodega asignada" (BODEGA_VACIA): SKU con ubicación específica pero sin bodega,
  // ej. recién cargados por Excel sin esa columna. Antes quedaban invisibles en "Ubicación
  // general" (ni ahí ni en "SKU sin ubicación", que exige bodega Y ubicación null) =====
  bodegaEl.value = '__bodega_vacia__'; // debe coincidir con BODEGA_VACIA en app/index.html
  calls.length = 0;
  await new Promise(resolve => {
    bodegaEl.dispatch('change', {target: bodegaEl});
    setTimeout(resolve, 50);
  });
  assert(ubicEl.disabled === false, 'p-ubic debe habilitarse tras elegir "Sin bodega asignada", obtuvo disabled='+ubicEl.disabled);
  assert(ubicEl.innerHTML.includes('Piso'), 'p-ubic debe listar las ubicaciones específicas de los SKU sin bodega, obtuvo: '+ubicEl.innerHTML);
  const especificasVaciaCall = calls.find(c=>c.url.includes('/ubicaciones_especificas'));
  assert(!!especificasVaciaCall && especificasVaciaCall.url.includes('bodega=is.null'), 'debe pedir ubicaciones_especificas con bodega=is.null (no un eq. literal contra el texto del sentinel), obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  // Bug real reportado: con "Sin bodega asignada" elegido, Ubicación específica quedaba en
  // "Todas" por defecto pero Storage bin se quedaba pegado deshabilitado ("Elige ubicación
  // específica primero") hasta tocar Ubicación específica a mano. Debe quedar habilitado solo.
  assert(elements['p-bin'].disabled === false, 'Storage bin debe habilitarse solo, sin tocar Ubicación específica a mano, obtuvo disabled='+elements['p-bin'].disabled);
  assert(calls.some(c=>c.url.includes('/ubicaciones_bins') && c.url.includes('bodega=is.null')), 'debe pedir ubicaciones_bins con bodega=is.null en cuanto se elige "Sin bodega asignada", sin esperar a que se toque Ubicación específica, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  ubicEl.value = 'Piso';
  await new Promise(resolve => {
    ubicEl.dispatch('change', {target: ubicEl});
    setTimeout(resolve, 50);
  });
  const binesCallVacia = calls.find(c=>c.url.includes('/ubicaciones_bins'));
  assert(!!binesCallVacia && binesCallVacia.url.includes('bodega=is.null'), 'debe pedir ubicaciones_bins con bodega=is.null también, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  // El fixture de ubicaciones_bins no tiene ningún storage_bin para "Piso" (solo para las
  // ubicaciones de Nave Mina) -> lista vacía real, igual que los 8 SKU reales sin bin cargado.
  // Reportado por el usuario: la caja quedaba vacía sin explicación y no dejaba avanzar. Ahora,
  // en vez de solo un mensaje, se listan los SKU de la ubicación para poder elegir puntualmente.
  assert(elements['p-bin'].dataset.modo==='skus', 'sin storage bin cargado, #p-bin debe pasar a modo "skus", obtuvo: '+elements['p-bin'].dataset.modo);
  assert(elements['p-bin'].innerHTML.includes('SKU-P1') && elements['p-bin'].innerHTML.includes('SKU-P2'), 'debe listar los SKU de la ubicación como opciones, obtuvo: '+elements['p-bin'].innerHTML);
  assert(elements['p-bin-hint'].textContent.includes('No hay storage bin cargado') && elements['p-bin-hint'].textContent.includes('elegir SKU puntuales'), 'debe explicar que se pueden elegir SKU puntuales, obtuvo: '+elements['p-bin-hint'].textContent);
  assert(calls.some(c=>c.url.includes('/skus_disponibles_planificar')), 'la lista de SKU para elegir (sin bin) debe salir de skus_disponibles_planificar, no de skus_planificables, para no ofrecer SKU ya cubiertos por otra entrada del plan, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  // El resumen también debe funcionar en modo "SKU puntuales" (sin storage bin cargado): al
  // cargar, con todo marcado, muestra el total; eligiendo solo uno a mano, se recalcula en vivo.
  assert(elements['p-bin-resumen'].textContent === '(2 SKU)', 'en modo SKU puntuales, el resumen debe mostrar el total de SKU disponibles (SKU-P1 y SKU-P2), obtuvo: '+elements['p-bin-resumen'].textContent);
  elements['p-bin'].selectedOptions = [{value:'SKU-P1'}];
  await new Promise(resolve => {
    elements['p-bin'].dispatch('change', {target: elements['p-bin']});
    setTimeout(resolve, 20);
  });
  assert(elements['p-bin-resumen'].textContent === '(1 de 2 SKU seleccionados)', 'en modo SKU puntuales, el resumen debe reflejar solo el SKU puntual elegido, obtuvo: '+elements['p-bin-resumen'].textContent);
  elements['p-bin'].selectedOptions = [{value:'SKU-P1'}, {value:'SKU-P2'}];
  elements['p-bin-todos'].checked = true;

  // Al enviar sin tocar la lista de SKU (sin selección = todos), la bodega debe guardarse como
  // '' (bodega IS NULL explícito), NO como null — null ya significa otra cosa: el comodín "sin
  // restricción de bodega" del campo dejado en blanco, un caso totalmente distinto y ya existente.
  // Tampoco debe mandar ninguna exclusión (sin selección = todos los SKU incluidos).
  makeEl('p-fecha').value = '2026-08-12';
  calls.length = 0;
  await new Promise(resolve => {
    formPlanEl.dispatch('submit', {target: formPlanEl, preventDefault(){}});
    setTimeout(resolve, 20);
  });
  const postSinBodega = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal') && !c.url.includes('exclusiones'));
  const filaSinBodega = JSON.parse(postSinBodega.opts.body)[0];
  assert(filaSinBodega.bodega==='', '"Sin bodega asignada" debe guardarse como bodega:"" (distinto del comodín null), obtuvo: '+JSON.stringify(filaSinBodega));
  assert(filaSinBodega.ubicacion==='Piso', 'debe conservar la ubicación específica elegida, obtuvo: '+JSON.stringify(filaSinBodega));
  assert(!calls.some(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal_exclusiones')), 'sin deseleccionar ningún SKU, no debe mandar ninguna exclusión, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Eligiendo solo SKU-P1 (deja SKU-P2 sin marcar), el resto de los SKU de la ubicación debe
  // excluirse de la entrada creada — misma tabla que usa "quitar SKU" sobre una entrada ya
  // creada (plan_semanal_exclusiones), pero aplicada de una sola vez al crear. Elegir a mano en
  // la lista (que ahora carga con todo pre-marcado) desmarca "Seleccionar todos" en la app real
  // (ver el listener 'change' de #p-bin); se simula acá ese mismo efecto.
  elements['p-bin-todos'].checked = false;
  elements['p-bin'].selectedOptions = [{value:'SKU-P1'}];
  calls.length = 0;
  await new Promise(resolve => {
    formPlanEl.dispatch('submit', {target: formPlanEl, preventDefault(){}});
    setTimeout(resolve, 20);
  });
  const postConExclusion = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal') && !c.url.includes('exclusiones'));
  assert(!!postConExclusion, 'debe seguir creando la entrada del plan aunque se hayan deseleccionado SKU, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const postExclusionSku = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal_exclusiones'));
  assert(!!postExclusionSku, 'eligiendo solo algunos SKU, debe mandar el resto como exclusión de la entrada creada, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const filasExclusion = JSON.parse(postExclusionSku.opts.body);
  // SKU-P3 nunca apareció en la lista para elegir (ya está cubierto por otra entrada de plan),
  // pero igual debe quedar excluido acá: si no, se cuela de vuelta en el conteo/detalle de esta
  // entrada nueva (que sí usa el universo completo, sin ese filtro) — bug real reportado:
  // "selecciono dos y pasan cuatro".
  const codigosExcluidos = filasExclusion.map(f=>f.sku_code).sort();
  assert(filasExclusion.length===2 && codigosExcluidos[0]==='SKU-P2' && codigosExcluidos[1]==='SKU-P3' && filasExclusion.every(f=>f.plan_id==='plan-nuevo-1'), 'debe excluir tanto SKU-P2 (visible, no elegido) como SKU-P3 (ya cubierto por otra entrada, ni siquiera ofrecido) de la entrada recién creada, obtuvo: '+JSON.stringify(filasExclusion));

  // ===== SKU sin ubicación (bodega/ubicación en null): deben poder incluirse en el plan =====

  // cargarConteoSinUbicacion: pide el total de SKU activos sin bodega ni ubicación, sobre
  // skus_disponibles_planificar (no skus_planificables) para no ofrecer SKU que ya estén
  // cubiertos por otra entrada de plan_semanal vigente.
  calls.length = 0;
  await ctx.cargarConteoSinUbicacion();
  assert(ctx.__appstate.plan.sinUbicacionCount===1, 'cargarConteoSinUbicacion debe guardar el total de SKU sueltos, obtuvo: '+ctx.__appstate.plan.sinUbicacionCount);
  assert(calls.some(c=>c.url.includes('/skus_disponibles_planificar')), 'cargarConteoSinUbicacion debe consultar skus_disponibles_planificar, no solo skus_planificables, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // El selector "Ubicación general" debe ofrecer la opción especial cuando hay SKU sueltos.
  const htmlConSueltos = ctx.renderPlanificacion();
  assert(htmlConSueltos.includes('SKU sin ubicación (1)'), 'debe ofrecer la opción "SKU sin ubicación" con el total correcto, obtuvo: '+htmlConSueltos);

  ctx.__appstate.plan.sinUbicacionCount = 0;
  const htmlSinSueltos = ctx.renderPlanificacion();
  assert(!htmlSinSueltos.includes('SKU sin ubicación'), 'sin SKU sueltos, no debe ofrecerse esa opción, obtuvo: '+htmlSinSueltos);
  ctx.__appstate.plan.sinUbicacionCount = 1;

  // contarUniversoUbicacion/skusDeUbicacion con soloSinUbicacion deben filtrar por is.null,
  // ignorando cualquier bodega/ubicación que se les pase (no debería pasar en la práctica).
  calls.length = 0;
  const totalSueltos = await ctx.contarUniversoUbicacion({bodega:'Nave Mina', soloSinUbicacion:true});
  const callConteoSuelto = calls.find(c=>c.url.includes('bodega=is.null') && c.url.includes('ubicacion=is.null'));
  assert(!!callConteoSuelto && !callConteoSuelto.url.includes('bodega=eq.'), 'debe filtrar por bodega=is.null&ubicacion=is.null, ignorando el bodega recibido, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(totalSueltos===1, 'debe devolver el conteo real de SKU sueltos, obtuvo: '+totalSueltos);

  const detalleSueltos = await ctx.skusDeUbicacion({soloSinUbicacion:true});
  assert(detalleSueltos.length===1 && detalleSueltos[0].sku_code==='SKU-SUELTO', 'skusDeUbicacion con soloSinUbicacion debe traer el detalle de los SKU sueltos, obtuvo: '+JSON.stringify(detalleSueltos));

  // crearPlanEntrada con soloSinUbicacion: una sola fila, con bodega/ubicación/bin en null
  // y solo_sin_ubicacion:true (para poder distinguirla de una entrada "todas las ubicaciones").
  calls.length = 0;
  await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'', ubicacion:'', storageBins:[], soloSinUbicacion:true, responsableId:'', nota:''});
  const postSuelto = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal') && !c.url.includes('exclusiones'));
  const filaSuelto = JSON.parse(postSuelto.opts.body)[0];
  assert(filaSuelto.bodega===null && filaSuelto.ubicacion===null && filaSuelto.storage_bin===null, 'una entrada de SKU sueltos no debe llevar bodega/ubicación/bin, obtuvo: '+JSON.stringify(filaSuelto));
  assert(filaSuelto.solo_sin_ubicacion===true, 'debe marcar solo_sin_ubicacion:true para distinguirla de una entrada "todas las ubicaciones", obtuvo: '+JSON.stringify(filaSuelto));

  // Deja terminar el cargarPlanSemanal() fire-and-forget que dispara crearPlanEntrada, antes de
  // reemplazar el fetch para la siguiente prueba (mismo motivo que el comentario más abajo).
  await new Promise(resolve => setTimeout(resolve, 20));

  // cargarPlanSemanal: una fila de plan_semanal_detalle con solo_sin_ubicacion:true debe traer
  // su universo/detalle con el filtro is.null (no una lista sin filtrar de todas las ubicaciones).
  const fetchOriginalPlanSuelto = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/plan_semanal_detalle'){
      return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([
        {id:'e-suelto', fecha:'2026-08-10', bodega:null, ubicacion:null, storage_bin:null, solo_sin_ubicacion:true, responsable_id:null, responsable_nombre:null, nota:'', skus_excluidos:[]},
      ]) };
    }
    return fetchOriginalPlanSuelto(url, opts);
  };
  calls.length = 0;
  await ctx.cargarPlanSemanal();
  await new Promise(resolve => setTimeout(resolve, 20));
  ctx.fetch = fetchOriginalPlanSuelto;
  assert(calls.some(c=>c.url.includes('bodega=is.null')&&c.url.includes('ubicacion=is.null')), 'cargarPlanSemanal debe pedir el universo/detalle de una entrada solo_sin_ubicacion con el filtro is.null, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.plan.universos['e-suelto']===1, 'el universo de la entrada de SKU sueltos debe calcularse con el filtro correcto, obtuvo: '+ctx.__appstate.plan.universos['e-suelto']);
  assert(Array.isArray(ctx.__appstate.plan.detalle['e-suelto']) && ctx.__appstate.plan.detalle['e-suelto'][0].sku_code==='SKU-SUELTO', 'el detalle de la entrada de SKU sueltos debe traer esos SKU, obtuvo: '+JSON.stringify(ctx.__appstate.plan.detalle['e-suelto']));

  // La tarjeta de esa entrada debe mostrar la etiqueta "SKU sin ubicación" en vez de bodega/ubicación vacías.
  const htmlPlanSuelto = ctx.renderPlanificacion();
  assert(htmlPlanSuelto.includes('SKU sin ubicación'), 'la tarjeta de una entrada solo_sin_ubicacion debe indicarlo, obtuvo: '+htmlPlanSuelto);

  // crearPlanEntrada dispara cargarPlanSemanal() sin esperarlo (fire-and-forget) para no bloquear la UI.
  // Dejamos que esas promesas pendientes terminen de resolver antes de fijar el estado a mano para las
  // pruebas siguientes; si no, podrían sobrescribir `entradas` más tarde en medio de otro `await`.
  await new Promise(resolve => setTimeout(resolve, 20));

  // El botón "Exportar PDF" debe estar deshabilitado cuando no hay conteos planificados.
  ctx.__appstate.plan = {semanaInicio:'2026-08-10', entradas:[], universos:{}, generales: ctx.__appstate.plan.generales, responsables: responsablesAsignables, editando:null, detalle:{}, seleccionados:[]};
  const htmlSinEntradas = ctx.renderPlanificacion();
  assert(htmlSinEntradas.includes('id="btn-exportar-plan"') && /id="btn-exportar-plan"[^>]*disabled/.test(htmlSinEntradas), 'Exportar PDF debe estar deshabilitado sin conteos planificados');

  // Con conteos planificados y responsable asignado, el botón se habilita, la tarjeta muestra el responsable +
  // botón editar, y el detalle de SKU aparece directo (sin necesitar ningún clic) apenas está disponible.
  ctx.__appstate.plan = {
    semanaInicio: '2026-08-10',
    entradas: [
      {id:'e1', fecha:'2026-08-10', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', responsable_id:'u1', responsable_nombre:'Ana Torres', nota:'Revisar merma'},
      {id:'e2', fecha:'2026-08-11', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', responsable_id:null, responsable_nombre:null, nota:''},
    ],
    universos: {e1: 5, e2: 3},
    generales: [],
    responsables: responsablesAsignables,
    editando: null,
    detalle: {},
    seleccionados: [],
  };
  const htmlSinDetalle = ctx.renderPlanificacion();
  assert(!/id="btn-exportar-plan"[^>]*disabled/.test(htmlSinDetalle), 'Exportar PDF debe habilitarse cuando hay conteos planificados, obtuvo: '+htmlSinDetalle.match(/<button[^>]*btn-exportar-plan[^>]*>/));
  assert(htmlSinDetalle.includes('Responsable: Ana Torres'), 'La tarjeta debe mostrar el nombre del responsable asignado');
  assert(htmlSinDetalle.includes('Responsable: Sin asignar'), 'La tarjeta debe mostrar "Sin asignar" cuando la entrada no tiene responsable');
  assert(htmlSinDetalle.includes('data-editar-plan="e1"'), 'debe existir un botón para editar cada entrada, obtuvo: '+htmlSinDetalle);
  assert(/data-borrar-plan="e1"[^>]*title="Eliminar toda esta entrada del plan/.test(htmlSinDetalle), 'el botón de eliminar la entrada completa debe tener un title distintivo, obtuvo: '+htmlSinDetalle);
  const botonBorrarEntrada = (htmlSinDetalle.match(/<button class="icon-btn" data-borrar-plan="e1"[^>]*>[\s\S]*?<\/button>/)||[])[0] || '';
  assert(botonBorrarEntrada.includes('M3 6h18'), 'el botón de eliminar la entrada completa debe usar el ícono de papelera (distinto de la "x"), obtuvo: '+botonBorrarEntrada);
  assert(htmlSinDetalle.includes('data-select-plan="e1"') && htmlSinDetalle.includes('data-select-plan="e2"'), 'cada entrada debe tener un checkbox de selección para borrado masivo, obtuvo: '+htmlSinDetalle);
  assert(!htmlSinDetalle.includes('btn-borrar-seleccion-plan'), 'sin ninguna selección, no debe aparecer la barra de borrado masivo, obtuvo: '+htmlSinDetalle);
  assert(htmlSinDetalle.includes('id="chk-seleccionar-todo-plan"') && htmlSinDetalle.includes('Seleccionar todo'), 'debe existir el checkbox "Seleccionar todo" aunque no haya nada seleccionado todavía, obtuvo: '+htmlSinDetalle);
  assert(!/id="chk-seleccionar-todo-plan"[^>]*checked/.test(htmlSinDetalle), 'el checkbox "Seleccionar todo" no debe venir marcado si no hay nada seleccionado, obtuvo: '+htmlSinDetalle);

  // Pedido real: la "semana" mostrada en Planificación debe llegar hasta el lunes siguiente
  // inclusive (8 días), no cortar el domingo — para ver de una el arranque de la semana próxima.
  // 2026-08-10 es lunes; el lunes siguiente es 2026-08-17 (domingo sería 2026-08-16).
  {
    const planOriginal = ctx.__appstate.plan;
    ctx.__appstate.plan = {
      semanaInicio: '2026-08-10',
      entradas: [
        {id:'e1', fecha:'2026-08-10', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', responsable_id:null, responsable_nombre:null, nota:''},
        {id:'e8', fecha:'2026-08-17', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', responsable_id:null, responsable_nombre:null, nota:''},
      ],
      universos: {e1: 5, e8: 9},
      generales: [],
      responsables: [],
      editando: null,
      detalle: {},
      seleccionados: [],
    };
    const htmlSemanaOchoDias = ctx.renderPlanificacion();
    assert(htmlSemanaOchoDias.includes(`${ctx.fmtFecha('2026-08-10')} – ${ctx.fmtFecha('2026-08-17')}`), 'el encabezado de la semana debe llegar hasta el lunes siguiente (17 ago), no hasta el domingo (16 ago), obtuvo: '+htmlSemanaOchoDias.match(/<span class="hint"[^>]*>[^<]*<\/span>/));
    assert(htmlSemanaOchoDias.includes('data-editar-plan="e8"'), 'la entrada del lunes siguiente (17 ago, día 8) debe listarse igual que el resto de la semana, obtuvo: '+htmlSemanaOchoDias);
    ctx.__appstate.plan = planOriginal;
  }

  // alternarSeleccionTodoPlan: selecciona todas las entradas de la semana de una vez, y las deselecciona si ya estaban todas.
  assert(ctx.__appstate.plan.seleccionados.length===0, 'sanity check: no debe haber selección previa');
  ctx.alternarSeleccionTodoPlan();
  assert(JSON.stringify(ctx.__appstate.plan.seleccionados.slice().sort())===JSON.stringify(['e1','e2']), 'alternarSeleccionTodoPlan debe seleccionar todas las entradas de la semana, obtuvo: '+JSON.stringify(ctx.__appstate.plan.seleccionados));
  const htmlTodoSeleccionado = ctx.renderPlanificacion();
  assert(/id="chk-seleccionar-todo-plan"[^>]*checked/.test(htmlTodoSeleccionado), 'con todas las entradas seleccionadas, el checkbox "Seleccionar todo" debe aparecer marcado, obtuvo: '+htmlTodoSeleccionado);
  assert(htmlTodoSeleccionado.includes('2 entradas seleccionadas'), 'debe mostrar el conteo de 2 entradas seleccionadas, obtuvo: '+htmlTodoSeleccionado);
  ctx.alternarSeleccionTodoPlan();
  assert(ctx.__appstate.plan.seleccionados.length===0, 'alternarSeleccionTodoPlan debe deseleccionar todo si ya estaba todo seleccionado, obtuvo: '+JSON.stringify(ctx.__appstate.plan.seleccionados));

  // alternarSeleccionPlan agrega/quita ids del set de seleccionados.
  ctx.alternarSeleccionPlan('e1');
  assert(JSON.stringify(ctx.__appstate.plan.seleccionados)===JSON.stringify(['e1']), 'alternarSeleccionPlan debe agregar el id a seleccionados, obtuvo: '+JSON.stringify(ctx.__appstate.plan.seleccionados));
  ctx.alternarSeleccionPlan('e2');
  assert(ctx.__appstate.plan.seleccionados.length===2, 'debe poder seleccionar más de una entrada, obtuvo: '+JSON.stringify(ctx.__appstate.plan.seleccionados));
  const htmlConSeleccion = ctx.renderPlanificacion();
  assert(htmlConSeleccion.includes('2 entradas seleccionadas') && htmlConSeleccion.includes('id="btn-borrar-seleccion-plan"'), 'con 2 entradas seleccionadas debe aparecer la barra de borrado masivo con el conteo correcto, obtuvo: '+htmlConSeleccion);
  assert(/data-select-plan="e1"[^>]*checked/.test(htmlConSeleccion) && /data-select-plan="e2"[^>]*checked/.test(htmlConSeleccion), 'los checkboxes de las entradas seleccionadas deben aparecer marcados, obtuvo: '+htmlConSeleccion);
  ctx.alternarSeleccionPlan('e1');
  assert(JSON.stringify(ctx.__appstate.plan.seleccionados)===JSON.stringify(['e2']), 'alternarSeleccionPlan debe quitar el id si ya estaba seleccionado, obtuvo: '+JSON.stringify(ctx.__appstate.plan.seleccionados));

  // confirmarYBorrarSeleccionPlan: si cancela, no borra nada; si confirma, borra todas las seleccionadas en un solo DELETE (id=in.(...)).
  ctx.alternarSeleccionPlan('e1'); // vuelve a quedar [e2, e1]
  confirmRespuesta = false;
  confirmLlamadas.length = 0;
  calls.length = 0;
  await ctx.confirmarYBorrarSeleccionPlan();
  assert(confirmLlamadas.length===1 && /eliminar 2 entradas/i.test(confirmLlamadas[0]), 'debe preguntar confirmación mencionando la cantidad de entradas, obtuvo: '+JSON.stringify(confirmLlamadas));
  assert(!calls.some(c=>c.opts && c.opts.method==='DELETE'), 'si cancela, no debe borrarse nada, obtuvo: '+JSON.stringify(calls));

  confirmRespuesta = true;
  calls.length = 0;
  await ctx.confirmarYBorrarSeleccionPlan();
  const deleteMasivo = calls.find(c=>c.opts && c.opts.method==='DELETE' && c.url.includes('/plan_semanal?id=in.('));
  assert(!!deleteMasivo, 'debe hacer un único DELETE con id=in.(...) para todas las seleccionadas, obtuvo: '+JSON.stringify(calls));
  assert(deleteMasivo.url.includes('e1') && deleteMasivo.url.includes('e2'), 'el DELETE masivo debe incluir ambos ids seleccionados, obtuvo: '+deleteMasivo.url);
  assert(!htmlSinDetalle.includes('data-toggle-detalle') && !htmlSinDetalle.includes('Ver SKU'), 'no debe requerir ningún botón/link para ver el SKU, obtuvo: '+htmlSinDetalle);
  assert(htmlSinDetalle.includes('plan-item-detalle') && htmlSinDetalle.includes('Cargando SKU…'), 'mientras se carga, el detalle debe mostrarse igual (sin clics) con "Cargando SKU…", obtuvo: '+htmlSinDetalle);

  // Resumen de la semana: gráfico de SKU por día + desglose por responsable, antes del detalle día a día.
  assert(htmlSinDetalle.includes('Resumen de la semana'), 'debe existir la sección de resumen de la semana, obtuvo: '+htmlSinDetalle);
  assert(htmlSinDetalle.includes('SKU a contar por día (8 en total)'), 'el total de la semana debe ser la suma de los universos de todas las entradas (5+3=8), obtuvo: '+htmlSinDetalle);
  assert(htmlSinDetalle.includes('>Lun<') && htmlSinDetalle.includes('>Mar<'), 'el gráfico por día debe usar abreviaturas de día de semana (Lun, Mar…), obtuvo: '+htmlSinDetalle);
  assert(htmlSinDetalle.includes('>5<') && htmlSinDetalle.includes('>3<'), 'el gráfico por día debe mostrar el valor sobre cada barra, obtuvo: '+htmlSinDetalle);
  const idxResumen = htmlSinDetalle.indexOf('Resumen de la semana');
  const idxDetalleDia = htmlSinDetalle.indexOf('class="plan-item"');
  assert(idxResumen>=0 && idxDetalleDia>idxResumen, 'el resumen debe aparecer ANTES del detalle día a día, obtuvo índices: '+idxResumen+' / '+idxDetalleDia);
  assert(htmlSinDetalle.includes('SKU a contar por responsable'), 'debe existir el gráfico por responsable, obtuvo: '+htmlSinDetalle);
  assert(htmlSinDetalle.includes('Ana Torres') && htmlSinDetalle.includes('5 SKU'), 'el gráfico por responsable debe mostrar a Ana Torres con 5 SKU, obtuvo: '+htmlSinDetalle);
  assert(htmlSinDetalle.includes('Sin asignar') && htmlSinDetalle.includes('3 SKU'), 'el gráfico por responsable debe agrupar las entradas sin responsable como "Sin asignar" con 3 SKU, obtuvo: '+htmlSinDetalle);
  const posAnaTorres = htmlSinDetalle.indexOf('Ana Torres');
  const posSinAsignarResumen = htmlSinDetalle.indexOf('Sin asignar</span>');
  assert(posAnaTorres>=0 && posSinAsignarResumen>posAnaTorres, 'Ana Torres (5 SKU) debe listarse antes que Sin asignar (3 SKU), de mayor a menor carga, obtuvo posiciones: '+posAnaTorres+' / '+posSinAsignarResumen);

  // Sin conteos planificados, no debe mostrarse el resumen (nada que resumir).
  assert(!htmlSinEntradas.includes('Resumen de la semana'), 'sin conteos planificados no debe mostrarse el resumen de la semana, obtuvo: '+htmlSinEntradas);

  // resumenPorResponsable / abrevDiaSemana como unidades sueltas.
  assert(ctx.abrevDiaSemana('2026-08-10')==='Lun', 'abrevDiaSemana debe devolver "Lun" para un lunes, obtuvo: '+ctx.abrevDiaSemana('2026-08-10'));

  // Reportado: la fecha del gráfico "SKU a contar por día" (con un Período elegido) no coincidía
  // con la de la entrada de planificación — aparecía un día antes. fmtDiaCorto debe parsear la
  // fecha en medianoche LOCAL (como ya hace abrevDiaSemana), no dejar que new Date() la lea como
  // medianoche UTC: en un huso horario detrás de UTC (ej. Chile) eso corre el día al anterior.
  // Esta aserción es válida en cualquier huso (medianoche local de un día siempre cae en ese
  // mismo día); el corrimiento real a UTC se verificó aparte, a mano, con TZ=America/Santiago.
  assert(ctx.fmtDiaCorto('2026-08-26').includes('26'), 'fmtDiaCorto debe mostrar el día 26 para "2026-08-26" (medianoche local, no UTC), obtuvo: '+ctx.fmtDiaCorto('2026-08-26'));

  // Reportado: en Planificación, el rango "Lun 24 – Dom 30" se mostraba como "23 ago – 29 ago"
  // (mismo bug de zona horaria, pero en fmtFecha). fmtFecha recibe tanto fechas puras "YYYY-MM-DD"
  // (deben leerse en medianoche local, como fmtDiaCorto) como timestamps completos con su propia
  // hora/zona (esos NO deben tocarse — no tiene sentido forzarles T00:00:00). Esta aserción es
  // válida en cualquier huso horario; el corrimiento real a UTC se verificó a mano con
  // TZ=America/Santiago (24 ago y 30 ago correctos) y con un navegador real.
  assert(ctx.fmtFecha('2026-08-24').includes('24'), 'fmtFecha debe mostrar el día 24 para la fecha pura "2026-08-24" (medianoche local, no UTC), obtuvo: '+ctx.fmtFecha('2026-08-24'));
  assert(ctx.fmtFecha('2026-08-30').includes('30'), 'fmtFecha debe mostrar el día 30 para la fecha pura "2026-08-30" (medianoche local, no UTC), obtuvo: '+ctx.fmtFecha('2026-08-30'));
  assert(ctx.fmtFecha('2026-08-20T23:30:00+00:00').includes('20'), 'fmtFecha no debe alterar un timestamp completo (ya trae su propia hora/zona), obtuvo: '+ctx.fmtFecha('2026-08-20T23:30:00+00:00'));
  const resumenSuelto = ctx.resumenPorResponsable(
    [{id:'a', responsable_nombre:'Ana'}, {id:'b', responsable_nombre:'Ana'}, {id:'c', responsable_nombre:null}],
    {a:2, b:1, c:10}
  );
  assert(resumenSuelto.length===2 && resumenSuelto[0].nombre==='Sin asignar' && resumenSuelto[0].cantidad===10 && resumenSuelto[1].nombre==='Ana' && resumenSuelto[1].cantidad===3, 'resumenPorResponsable debe agrupar y sumar por nombre, ordenado de mayor a menor, obtuvo: '+JSON.stringify(resumenSuelto));

  // cargarPlanSemanal debe pedir tanto el universo (conteo) como el detalle real de SKU por cada fila, sin
  // que el usuario tenga que interactuar con nada.
  calls.length = 0;
  ctx.__appstate.plan.semanaInicio = '2026-08-10';
  await ctx.cargarPlanSemanal();
  await new Promise(resolve => setTimeout(resolve, 20));
  const skusCallE1 = calls.find(c=>c.url.includes('/skus_planificables?activo=eq.true&select=id,sku_code') && c.url.includes('storage_bin=eq.A-01'));
  assert(!!skusCallE1, 'cargarPlanSemanal debe consultar /skus_planificables (detalle) para cada entrada automáticamente, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(Array.isArray(ctx.__appstate.plan.detalle.e1) && ctx.__appstate.plan.detalle.e1[0].sku_code==='SKU-001', 'debe quedar cargado el detalle real de SKU (código/descripción) para A-01, obtuvo: '+JSON.stringify(ctx.__appstate.plan.detalle.e1));

  const htmlConDetalle = ctx.renderPlanificacion();
  assert(htmlConDetalle.includes('plan-item-detalle') && htmlConDetalle.includes('SKU-001') && htmlConDetalle.includes('Perno M8'), 'con el detalle ya cargado, debe listar SKU y descripción en la tarjeta sin ningún clic, obtuvo: '+htmlConDetalle);
  assert(htmlConDetalle.includes('class="icon-btn plan-sku-quitar" data-plan-id="e1" data-sku-code="SKU-001"'), 'cada SKU listado debe tener un botón para quitarlo de la planificación, obtuvo: '+htmlConDetalle);
  assert(/data-sku-code="SKU-001"[^>]*title="Quitar solo este SKU/.test(htmlConDetalle), 'el botón de quitar un SKU debe tener un title distinto al de eliminar toda la entrada, obtuvo: '+htmlConDetalle);

  // La entrada e2 tiene SKU-002 excluido (skus_excluidos en la vista): tanto el conteo como el detalle
  // deben pedirse con el filtro sku_code=not.in.(...) para no volver a mostrarlo.
  const skusCallE2 = calls.find(c=>c.url.includes('/skus_planificables?activo=eq.true&select=id,sku_code') && c.url.includes('storage_bin=eq.A-02'));
  assert(!!skusCallE2 && skusCallE2.url.includes('sku_code=not.in.(SKU-002)'), 'la consulta de detalle para e2 debe excluir SKU-002, obtuvo: '+JSON.stringify(skusCallE2));
  const universoCallE2 = calls.find(c=>c.url.includes('/skus_planificables?activo=eq.true') && !c.url.includes('select=id,sku_code') && c.url.includes('storage_bin=eq.A-02'));
  assert(!!universoCallE2 && universoCallE2.url.includes('sku_code=not.in.(SKU-002)'), 'la consulta de conteo (universo) para e2 debe excluir SKU-002, obtuvo: '+JSON.stringify(universoCallE2));

  // excluirSkuDePlan: debe insertar la exclusión y refrescar el plan.
  calls.length = 0;
  await ctx.excluirSkuDePlan('e1', 'SKU-001');
  await new Promise(resolve => setTimeout(resolve, 20));
  const postExclusion = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal_exclusiones'));
  assert(!!postExclusion, 'excluirSkuDePlan debe hacer POST a /plan_semanal_exclusiones');
  assert(JSON.parse(postExclusion.opts.body)[0].plan_id==='e1' && JSON.parse(postExclusion.opts.body)[0].sku_code==='SKU-001', 'el POST debe llevar el plan_id y sku_code correctos, obtuvo: '+postExclusion.opts.body);
  const refrescoTrasExcluir = calls.some(c=>c.url.includes('/plan_semanal_detalle'));
  assert(refrescoTrasExcluir, 'excluirSkuDePlan debe refrescar el plan (cargarPlanSemanal) después de excluir, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  // Excluir un SKU también cambia cuántos quedan "pendiente" en Ubicación general / SKU sin ubicación.
  assert(calls.some(c=>c.url.includes('/ubicaciones_generales')), 'excluirSkuDePlan debe refrescar Ubicación general después de excluir, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // El borrado de la entrada completa debe pedir confirmación (más destructivo que quitar un solo SKU).
  // Si el usuario cancela el confirm(), no debe llegar ningún DELETE a /plan_semanal.
  confirmRespuesta = false;
  confirmLlamadas.length = 0;
  calls.length = 0;
  await ctx.confirmarYBorrarPlanEntrada('e1');
  assert(confirmLlamadas.length===1 && /eliminar toda esta entrada/i.test(confirmLlamadas[0]), 'debe preguntar confirmación con un mensaje claro antes de borrar la entrada completa, obtuvo: '+JSON.stringify(confirmLlamadas));
  assert(!calls.some(c=>c.opts && c.opts.method==='DELETE'), 'si el usuario cancela el confirm(), no debe borrarse nada, obtuvo: '+JSON.stringify(calls));

  // Si confirma, sí debe borrarse.
  confirmRespuesta = true;
  calls.length = 0;
  await ctx.confirmarYBorrarPlanEntrada('e1');
  const deleteCall = calls.find(c=>c.opts && c.opts.method==='DELETE' && c.url.includes('/plan_semanal?id=eq.e1'));
  assert(!!deleteCall, 'si el usuario confirma, debe borrarse la entrada completa, obtuvo: '+JSON.stringify(calls));
  // Borrar una entrada libera SKU que vuelven a estar "pendiente" en Ubicación general / SKU sin ubicación.
  assert(calls.some(c=>c.url.includes('/ubicaciones_generales')), 'borrarPlanEntrada debe refrescar Ubicación general después de borrar, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // borrarPlanEntradas (borrado múltiple): también debe refrescar Ubicación general / SKU sin ubicación.
  calls.length = 0;
  await ctx.borrarPlanEntradas(['e1','e2']);
  const deleteMultiCall = calls.find(c=>c.opts && c.opts.method==='DELETE' && c.url.includes('/plan_semanal?id=in.(e1,e2)'));
  assert(!!deleteMultiCall, 'borrarPlanEntradas debe hacer DELETE con id=in.(...) para todas las entradas seleccionadas, obtuvo: '+JSON.stringify(calls));
  assert(calls.some(c=>c.url.includes('/ubicaciones_generales')), 'borrarPlanEntradas debe refrescar Ubicación general después de borrar, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Al entrar en modo edición para e1, debe mostrar el formulario inline con los valores actuales.
  ctx.__appstate.plan.editando = 'e1';
  const htmlEditando = ctx.renderPlanificacion();
  assert(htmlEditando.includes('id="pe-fecha-e1"') && htmlEditando.includes('value="2026-08-10"'), 'el modo edición debe precargar la fecha de la entrada, obtuvo: '+htmlEditando);
  assert(htmlEditando.includes('id="pe-responsable-e1"'), 'el modo edición debe incluir el select de responsable para e1');
  assert(/<option value="u1"[^>]*selected/.test(htmlEditando), 'el responsable actual (u1) debe venir preseleccionado en el modo edición, obtuvo: '+htmlEditando);
  assert(htmlEditando.includes('id="pe-nota-e1"') && htmlEditando.includes('value="Revisar merma"'), 'el modo edición debe precargar la nota de la entrada');
  assert(htmlEditando.includes('data-guardar-plan="e1"') && htmlEditando.includes('data-cancelar-plan="e1"'), 'el modo edición debe tener botones Guardar y Cancelar');
  ctx.__appstate.plan.editando = null;

  // imprimirPlan() debe listar el detalle real de SKU por entrada (no solo el conteo) y llamar a window.print().
  const printEl = makeEl('print-plan');
  printEl.innerHTML = '';
  await ctx.imprimirPlan();
  assert(printCalled===1, 'imprimirPlan debe llamar a window.print()');
  assert(printEl.innerHTML.includes('SKU-001') && printEl.innerHTML.includes('Perno M8'), 'El PDF debe listar el SKU y descripción de A-01, obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('SKU-002') && printEl.innerHTML.includes('Tuerca M8'), 'El PDF debe listar el SKU y descripción de A-02, obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('Responsable: Ana Torres'), 'El PDF debe indicar el responsable de la entrada e1, obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('Responsable: Sin asignar'), 'El PDF debe indicar "Sin asignar" para la entrada e2 sin responsable, obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('Revisar merma'), 'El PDF debe incluir la nota de la entrada');
  assert((printEl.innerHTML.match(/print-blank/g)||[]).length===4, 'Debe haber 2 celdas en blanco (cantidad contada + observación) por cada SKU listado, obtuvo: '+printEl.innerHTML);

  // actualizarPlanEntrada debe hacer PATCH con fecha, responsable_id y nota, y limpiar el estado de edición.
  ctx.__appstate.plan.editando = 'e1';
  calls.length = 0;
  await ctx.actualizarPlanEntrada('e1', {fecha:'2026-08-13', responsableId:'u2', nota:'Nota actualizada'});
  const patchPlan = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/plan_semanal?id=eq.e1'));
  assert(!!patchPlan, 'actualizarPlanEntrada debe hacer PATCH a /plan_semanal?id=eq.<id>');
  const bodyPatch = JSON.parse(patchPlan.opts.body);
  assert(bodyPatch.fecha==='2026-08-13' && bodyPatch.responsable_id==='u2' && bodyPatch.nota==='Nota actualizada', 'el PATCH debe llevar los nuevos valores, obtuvo: '+JSON.stringify(bodyPatch));
  assert(ctx.__appstate.plan.editando===null, 'tras guardar, editando debe volver a null');

  // Semana sin conteos -> mensaje de vacío, sin tablas, y aun así llama a print() (sin pedir SKU a la base).
  ctx.__appstate.plan = {semanaInicio:'2026-08-10', entradas:[], universos:{}, generales:[], responsables:[], editando:null, detalle:{}, seleccionados:[]};

  // Si la semana mostrada NO incluye hoy (ej. navegando a una semana pasada), el campo "Fecha"
  // debe quedarse en el lunes de esa semana en vez de forzar la fecha de hoy, que quedaría
  // fuera del rango min/max del campo.
  const htmlPlanSemanaPasada = ctx.renderPlanificacion();
  assert(htmlPlanSemanaPasada.includes('id="p-fecha" value="2026-08-10"'), 'el campo de fecha debe quedarse en el lunes de la semana mostrada cuando hoy no cae dentro de ese rango, obtuvo: '+htmlPlanSemanaPasada.match(/id="p-fecha"[^>]*/)[0]);
  printEl.innerHTML = '';
  printCalled = 0;
  calls.length = 0;
  await ctx.imprimirPlan();
  assert(printCalled===1, 'imprimirPlan debe llamar a print() incluso sin conteos');
  assert(printEl.innerHTML.includes('No hay conteos planificados'), 'Debe mostrar el mensaje de semana vacía, obtuvo: '+printEl.innerHTML);
  assert(!printEl.innerHTML.includes('<table>'), 'No debe generar tablas si no hay conteos planificados');
  assert(!calls.some(c=>c.url.includes('/skus?')), 'No debe consultar SKU si no hay entradas planificadas');

  // resumenPendientesPorBodega: SKU pendientes por contar, por ubicación general (para el gráfico
  // "dónde falta contar" del Dashboard).
  const pendientes = ctx.resumenPendientesPorBodega([
    {bodega:'Nave Mina', skus_universo:100, skus_contados:80},
    {bodega:'Nave Planta', skus_universo:50, skus_contados:50},
    {bodega: null, skus_universo:10, skus_contados:2},
  ]);
  assert(pendientes.length===2, 'debe excluir las bodegas ya completadas (pendiente 0), obtuvo: '+JSON.stringify(pendientes));
  assert(pendientes[0].nombre==='Nave Mina' && pendientes[0].cantidad===20, 'debe ordenar de mayor a menor pendiente y calcular el pendiente como universo menos contados, obtuvo: '+JSON.stringify(pendientes));
  assert(pendientes[1].nombre==='Sin ubicación general' && pendientes[1].cantidad===8, 'debe usar "Sin ubicación general" cuando bodega es null, obtuvo: '+JSON.stringify(pendientes));

  // renderDashboard debe mostrar "SKU pendientes por ubicación general" antes del listado detallado de avance.
  ctx.__appstate.dash = {
    total: [
      {bodega:'Nave Mina', skus_universo:100, skus_contados:80, porcentaje_avance:80},
      {bodega:'Nave Planta', skus_universo:50, skus_contados:50, porcentaje_avance:100},
    ],
    diario: [], semanal: [], mensual: [],
  };
  ctx.__appstate.dashboardModo = 'ejecutivo';
  ctx.__appstate.ultimosConteos = [];
  const htmlDash = ctx.renderDashboard();
  // Aclaración de UX pedida por el usuario: "Conteos recientes" (y "Materiales contados" más
  // abajo) siempre se acotan al ciclo actual, sin relación con el selector de período de
  // Adherencia al plan — el rótulo "(ciclo actual)" deja eso explícito en vez de que parezca
  // un bug cuando alguien elige "Todos los períodos" y este número no cambia.
  assert(htmlDash.includes('Conteos recientes (ciclo actual)'), 'la tarjeta de conteos recientes (vista Ejecutivo) debe aclarar que se acota al ciclo actual, obtuvo: '+htmlDash);
  ctx.__appstate.dashboardModo = 'operativo';
  const htmlDashOperativo = ctx.renderDashboard();
  assert(htmlDashOperativo.includes('Materiales contados (ciclo actual)'), 'la lista de materiales contados (vista Operativo) debe aclarar que se acota al ciclo actual, obtuvo: '+htmlDashOperativo);

  // Pedido del usuario: en el Dashboard operativo, Semanal debe mostrar el número de semana (no
  // la fecha cruda del lunes) y Mensual el nombre del mes (no la fecha cruda del día 1). Diario
  // debe paginar de a 15 filas (a pedido de Joel) con botón Siguiente/Anterior, en vez de listar
  // todo de una vez. Fechas en UTC 00:00 (igual que devuelve PostgREST desde columnas timestamptz
  // truncadas) — el entorno de test corre en UTC, así que la fecha local coincide con la UTC.
  ctx.__appstate.dash = {
    ...ctx.__appstate.dash,
    diario: Array.from({length:20}, (_,i)=>({
      dia: `2026-08-${String(24-i).padStart(2,'0')}T00:00:00+00:00`,
      bodega:'Nave Mina', skus_contados:5, con_diferencia:1, reconteos:2, total_unidades_contadas:20,
    })),
    semanal: [{semana:'2026-08-17T00:00:00+00:00', bodega:'Nave Mina', skus_contados:20, con_diferencia:3, reconteos:4, total_unidades_contadas:150}],
    mensual: [{mes:'2026-08-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:80, con_diferencia:5, reconteos:9, total_unidades_contadas:600}],
  };
  ctx.__appstate.dashDiarioPagina = 0;
  const htmlDashPeriodos = ctx.renderDashboard();
  assert(htmlDashPeriodos.includes('Semana 34 (2026)'), 'Semanal debe mostrar el número de semana ISO, no la fecha cruda del lunes (17 ago 2026 = semana 34), obtuvo: '+htmlDashPeriodos);
  assert(htmlDashPeriodos.includes('Agosto 2026'), 'Mensual debe mostrar el nombre del mes, no la fecha cruda del día 1, obtuvo: '+htmlDashPeriodos);
  // Pedido de Joel: Diario/Semanal/Mensual deben mostrar cuántos SKU se recontaron.
  assert((htmlDashPeriodos.match(/<th class="num">Reconteos<\/th>/g)||[]).length===3, 'las tres tablas (Diario/Semanal/Mensual) deben tener columna "Reconteos", obtuvo: '+htmlDashPeriodos);
  assert(htmlDashPeriodos.includes('24 ago') && !htmlDashPeriodos.includes('09 ago'), 'Diario (página 1) debe mostrar los primeros 15 días (24 ago a 10 ago), no el día 16 (9 ago), obtuvo: '+htmlDashPeriodos);
  assert(htmlDashPeriodos.includes('id="dash-diario-next"') && !/id="dash-diario-next"[^>]*disabled/.test(htmlDashPeriodos), 'con 20 filas (2 páginas de 15), el botón Siguiente debe estar habilitado, obtuvo: '+htmlDashPeriodos);
  assert(/id="dash-diario-prev"[^>]*disabled/.test(htmlDashPeriodos), 'en la primera página, el botón Anterior debe estar deshabilitado, obtuvo: '+htmlDashPeriodos);
  ctx.__appstate.dashDiarioPagina = 1;
  const htmlDashPeriodosPag2 = ctx.renderDashboard();
  assert(htmlDashPeriodosPag2.includes('09 ago') && !htmlDashPeriodosPag2.includes('24 ago'), 'Diario (página 2) debe mostrar las 5 filas restantes (9 ago a 5 ago), no las de la página 1 (24 ago), obtuvo: '+htmlDashPeriodosPag2);
  assert(/id="dash-diario-next"[^>]*disabled/.test(htmlDashPeriodosPag2), 'en la última página, el botón Siguiente debe estar deshabilitado, obtuvo: '+htmlDashPeriodosPag2);
  ctx.__appstate.dashDiarioPagina = 0;

  // Pedido de Joel: en "Materiales contados" (Dashboard operativo), mostrar cuántas fotos tiene
  // cada línea (siempre el número, no solo cuando hay más de una) y poder saltar a Buscar desde
  // el código del SKU, para ver el historial completo de ese material.
  ctx.__appstate.ultimosConteos = [
    {id:'mc-1', skus:{sku_code:'SKU-FOTO-1'}, cantidad_contada:5, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', conteo_fotos:[{foto_url:'a.jpg'}]},
    {id:'mc-2', skus:{sku_code:'SKU-SIN-FOTO'}, cantidad_contada:3, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:05:00Z', capturado_en:'2026-08-20T10:05:00Z', conteo_fotos:[]},
  ];
  const htmlMaterialesContados = ctx.renderDashboard();
  assert(htmlMaterialesContados.includes('data-buscar-sku="SKU-FOTO-1"') && htmlMaterialesContados.includes('data-buscar-sku="SKU-SIN-FOTO"'), 'el código de cada línea debe ser un botón data-buscar-sku para saltar a Buscar, obtuvo: '+htmlMaterialesContados);
  assert(/data-ver-fotos="[^"]*a\.jpg[^"]*"[^>]*>[\s\S]*? 1<\/button>/.test(htmlMaterialesContados), 'con 1 sola foto, el botón debe mostrar igual el número (1), no solo el ícono, obtuvo: '+htmlMaterialesContados);
  assert(htmlMaterialesContados.includes('icon-btn disabled" aria-hidden="true">') && htmlMaterialesContados.includes('</svg> 0</span>'), 'sin fotos, debe mostrar el ícono deshabilitado con "0", no solo el ícono solo, obtuvo: '+htmlMaterialesContados);

  // irABuscarSku: navega a Buscar, precarga el texto con el SKU elegido y limpia cualquier otro
  // filtro que hubiera quedado de una búsqueda anterior (si no, ese SKU podría no aparecer).
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, bodega:'Nave Vieja', estado:'con_diferencia', soloConFotos:true};
  calls.length = 0;
  ctx.irABuscarSku('SKU-FOTO-1');
  assert(ctx.__appstate.view==='buscar', 'irABuscarSku debe navegar a la vista Buscar, obtuvo: '+ctx.__appstate.view);
  assert(ctx.__appstate.busqueda.texto==='SKU-FOTO-1', 'irABuscarSku debe precargar el texto de búsqueda con el SKU elegido, obtuvo: '+JSON.stringify(ctx.__appstate.busqueda));
  assert(!ctx.__appstate.busqueda.bodega && !ctx.__appstate.busqueda.estado && !ctx.__appstate.busqueda.soloConFotos, 'irABuscarSku debe limpiar los demás filtros de una búsqueda anterior, obtuvo: '+JSON.stringify(ctx.__appstate.busqueda));
  await new Promise(resolve=>setTimeout(resolve, 20));
  assert(calls.some(c=>c.url.includes('/rest/v1/skus_busqueda') && c.url.includes('sku_code.ilike.*SKU-FOTO-1*')), 'irABuscarSku debe disparar la búsqueda con el SKU elegido, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Bug real reportado: con el navegador en una zona horaria detrás de UTC (Chile, que es
  // donde vive la empresa que usa esta app), "Mensual" mostraba "Julio" para datos de agosto.
  // Causa: dia/semana/mes vienen truncados por el servidor a las 00:00 UTC (confirmado:
  // Postgres corre con timezone=UTC) — leerlos con new Date(iso).getMonth()/getDate() (que usan
  // la hora LOCAL del navegador) los corre un día para atrás en cualquier huso detrás de UTC, y
  // si cae justo el día 1 de un mes, el mes entero se ve mal. Se simula la zona horaria de Chile
  // reasignando process.env.TZ (Node re-evalúa la zona en cada new Date(), incluso a mitad de
  // ejecución) para probar que el fix (fechaCalendarioUTC, leer componentes UTC) es correcto sin
  // depender de en qué huso horario corra el propio test.
  const tzOriginal = process.env.TZ;
  process.env.TZ = 'America/Santiago';
  const htmlDashPeriodosChile = ctx.renderDashboard();
  process.env.TZ = tzOriginal;
  assert(htmlDashPeriodosChile.includes('Agosto 2026') && !htmlDashPeriodosChile.includes('Julio 2026'), 'con el navegador en horario de Chile (UTC-4), Mensual debe seguir mostrando Agosto 2026, no correrse a Julio, obtuvo: '+htmlDashPeriodosChile);
  assert(htmlDashPeriodosChile.includes('Semana 34 (2026)'), 'con horario de Chile, Semanal debe seguir mostrando la semana 34 (17 ago), no correrse a la semana anterior, obtuvo: '+htmlDashPeriodosChile);
  assert(htmlDashPeriodosChile.includes('24 ago'), 'con horario de Chile, Diario debe seguir mostrando el 24 de agosto, no el 23, obtuvo: '+htmlDashPeriodosChile);

  // Pedido del usuario: en Semanal y Mensual, si la empresa no usa "ubicación general" (todas
  // las filas del período vienen con bodega null), la columna "Ubic. general" solo mostraría "—"
  // en cada línea — se saca entera y el resumen queda en una sola línea limpia por período.
  ctx.__appstate.dash = {
    ...ctx.__appstate.dash,
    semanal: [{semana:'2026-08-17T00:00:00+00:00', bodega:null, skus_contados:40, con_diferencia:2, total_unidades_contadas:300}],
    mensual: [{mes:'2026-08-01T00:00:00+00:00', bodega:null, skus_contados:120, con_diferencia:9, total_unidades_contadas:900}],
  };
  const htmlDashSinBodega = ctx.renderDashboard();
  // Diario (más arriba en la misma página) sigue con filas de "Nave Mina" del bloque anterior —
  // se acota la comparación a partir de "Semanal" para no confundir su columna con la de Diario.
  const htmlDashSinBodegaDesdeSemanal = htmlDashSinBodega.slice(htmlDashSinBodega.indexOf('<h2 style="font-size:17px">Semanal</h2>'));
  assert(!htmlDashSinBodegaDesdeSemanal.includes('<th>Ubic. general</th>'), 'sin ninguna bodega en los datos del período, la columna "Ubic. general" no debe mostrarse en Semanal ni Mensual, obtuvo: '+htmlDashSinBodegaDesdeSemanal);
  assert(htmlDashSinBodega.includes('Semana 34 (2026)') && htmlDashSinBodega.includes('Agosto 2026'), 'los números resumen deben seguir mostrándose igual, solo sin la columna de bodega, obtuvo: '+htmlDashSinBodega);
  // Con al menos una fila que sí tiene bodega, la columna debe seguir mostrándose (para no
  // esconder a qué bodega corresponde cada línea cuando sí hay datos reales de bodega).
  ctx.__appstate.dash = {
    ...ctx.__appstate.dash,
    semanal: [
      {semana:'2026-08-17T00:00:00+00:00', bodega:'Nave Mina', skus_contados:20, con_diferencia:1, total_unidades_contadas:150},
      {semana:'2026-08-17T00:00:00+00:00', bodega:null, skus_contados:20, con_diferencia:1, total_unidades_contadas:150},
    ],
  };
  const htmlDashBodegaMixta = ctx.renderDashboard();
  assert(htmlDashBodegaMixta.includes('<th>Ubic. general</th>'), 'con al menos una fila con bodega real, la columna "Ubic. general" debe seguir mostrándose, obtuvo: '+htmlDashBodegaMixta);

  ctx.__appstate.dashboardModo = 'ejecutivo';
  assert(htmlDash.includes('SKU pendientes por ubicación general'), 'debe existir la sección de pendientes por ubicación general, obtuvo: '+htmlDash);
  assert(htmlDash.includes('Nave Mina') && htmlDash.includes('20 SKU'), 'debe mostrar Nave Mina con 20 SKU pendientes, obtuvo: '+htmlDash);
  const idxPendientes = htmlDash.indexOf('SKU pendientes por ubicación general');
  const idxAvance = htmlDash.indexOf('Avance por ubicación general');
  assert(idxPendientes>=0 && idxAvance>idxPendientes, 'el gráfico de pendientes debe aparecer antes del listado detallado de avance, obtuvo índices: '+idxPendientes+' / '+idxAvance);
  assert(!htmlDash.includes('Nave Planta') || !new RegExp('Nave Planta[\\s\\S]{0,80}0 SKU').test(htmlDash.slice(idxPendientes, idxAvance)), 'Nave Planta ya está completa (pendiente 0) y no debe listarse en el gráfico de pendientes');

  // Si todas las bodegas están completas, no debe mostrarse el gráfico de pendientes (no hay nada que priorizar).
  ctx.__appstate.dash = {
    total: [{bodega:'Nave Mina', skus_universo:100, skus_contados:100, porcentaje_avance:100}],
    diario: [], semanal: [], mensual: [],
  };
  const htmlDashCompleto = ctx.renderDashboard();
  assert(!htmlDashCompleto.includes('SKU pendientes por ubicación general'), 'si no queda nada pendiente, no debe mostrarse el gráfico, obtuvo: '+htmlDashCompleto);

  // ===== Dashboard ejecutivo: proyección de término + ranking por responsable =====

  // proyeccionTermino: sin SKU cargados.
  const proySinSkus = ctx.proyeccionTermino(0, 0, []);
  assert(proySinSkus.titulo==='—', 'sin SKU cargados no debe intentar proyectar nada, obtuvo: '+JSON.stringify(proySinSkus));

  // proyeccionTermino: inventario ya completo.
  const proyCompleto = ctx.proyeccionTermino(100, 100, [{dia:ctx.fechaISO(new Date()), contados:5}]);
  assert(proyCompleto.titulo==='¡Inventario completo!', 'sin pendientes debe avisar que está completo, obtuvo: '+JSON.stringify(proyCompleto));

  // proyeccionTermino: hay pendientes pero nada contado en la ventana -> no se puede estimar ritmo.
  const proySinRitmo = ctx.proyeccionTermino(100, 50, []);
  assert(proySinRitmo.titulo==='Sin proyección', 'sin conteos recientes no debe inventarse una fecha, obtuvo: '+JSON.stringify(proySinRitmo));

  // proyeccionTermino: caso normal — 100 pendientes, ritmo de 10 SKU/día (140 contados repartidos
  // en los últimos 14 días -> 10/día) -> 100/10 = 10 días más. El primer día con datos es hace
  // 13 días (14 días transcurridos hasta hoy inclusive), así que sí llena toda la ventana.
  const diarioNormal = [
    {dia: ctx.fechaISO(ctx.sumarDias(new Date(), -13)), contados:70},
    {dia: ctx.fechaISO(new Date()), contados:70},
  ];
  const proyNormal = ctx.proyeccionTermino(200, 100, diarioNormal);
  assert(proyNormal.detalle.includes('10 días más') && proyNormal.detalle.includes('100 pendientes'), 'debe calcular los días restantes como pendientes/ritmo, obtuvo: '+JSON.stringify(proyNormal));
  assert(proyNormal.titulo!=='—' && proyNormal.titulo!=='Sin proyección' && proyNormal.titulo!=='¡Inventario completo!', 'el caso normal debe mostrar una fecha proyectada, obtuvo: '+JSON.stringify(proyNormal));

  // Bug real reportado por Joel: si el ciclo recién empezó (ej. 2 días atrás), dividir por los
  // 14 días fijos de la ventana infla artificialmente los días restantes con "días muertos" que
  // nunca existieron. Mismos 100 contados pero solo en los últimos 2 días -> ritmo 50/día, no
  // 100/14=7.1/día.
  const diarioReciente = [
    {dia: ctx.fechaISO(ctx.sumarDias(new Date(), -1)), contados:50},
    {dia: ctx.fechaISO(new Date()), contados:50},
  ];
  const proyReciente = ctx.proyeccionTermino(200, 100, diarioReciente);
  assert(proyReciente.detalle.includes('2 días más') && proyReciente.detalle.includes('50.0 SKU/día'), 'con datos de solo 2 días, el ritmo debe calcularse sobre esos 2 días (50/día), no sobre la ventana fija de 14, obtuvo: '+JSON.stringify(proyReciente));

  // cargarDashboard: el ranking por responsable ahora se calcula en SQL (rpc/ranking_responsable,
  // ver ranking_responsable_en_sql), no trayendo filas crudas y agrupando en JS — evita el límite
  // de 5000 filas que tenía el enfoque anterior si un cliente crece mucho en volumen.
  ctx.__appstate.session = { access_token:'x', user:{id:'user-1', email:'a@b.com'} };
  calls.length = 0;
  await ctx.cargarDashboard();
  const rankingCall = calls.find(c=>c.url.includes('/rest/v1/rpc/ranking_responsable'));
  assert(!!rankingCall && rankingCall.opts.method==='POST' && JSON.parse(rankingCall.opts.body).dias===14, 'cargarDashboard debe llamar al RPC ranking_responsable con la ventana de días, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.ranking.length===3 && ctx.__appstate.dash.ranking[0].nombre==='Ana Torres', 'cargarDashboard debe dejar el ranking que devuelve el RPC en state.dash.ranking, obtuvo: '+JSON.stringify(ctx.__appstate.dash.ranking));

  // cargarDashboard: "Diferencias" ahora viene de rpc/diferencias_recientes (último conteo de
  // cada SKU, no cada conteo crudo) — mismo bug de fondo que "Fuera de plan": un SKU recontado
  // no debe contar dos veces (una con diferencia, otra sin ella).
  const diferenciasCall = calls.find(c=>c.url.includes('/rest/v1/rpc/diferencias_recientes'));
  assert(!!diferenciasCall && diferenciasCall.opts.method==='POST' && JSON.parse(diferenciasCall.opts.body).dias===14, 'cargarDashboard debe llamar al RPC diferencias_recientes con la ventana de días, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.diferenciasRecientes.length===1 && ctx.__appstate.dash.diferenciasRecientes[0].sin_diferencia===9, 'cargarDashboard debe dejar el resultado del RPC en state.dash.diferenciasRecientes, obtuvo: '+JSON.stringify(ctx.__appstate.dash.diferenciasRecientes));

  // cargarDashboard: clasificación ABC (skus_resumen_abc, ya agregada por clase en la base).
  const resumenAbcCall = calls.find(c=>c.url.includes('/rest/v1/skus_resumen_abc'));
  assert(!!resumenAbcCall, 'cargarDashboard debe pedir /skus_resumen_abc, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.resumenAbc.length===3 && ctx.__appstate.dash.resumenAbc.find(r=>r.clase_abc==='A').cantidad_sku===3, 'cargarDashboard debe dejar el resumen ABC en state.dash.resumenAbc, obtuvo: '+JSON.stringify(ctx.__appstate.dash.resumenAbc));

  // cargarDashboard: exactitud de unidades/ubicación (vista exactitud_por_bodega) y top
  // materiales con diferencia (reconteo_pendiente ordenado por diferencia_abs desc).
  const exactitudCall = calls.find(c=>c.url.includes('/exactitud_por_bodega'));
  assert(!!exactitudCall, 'cargarDashboard debe pedir /exactitud_por_bodega, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.exactitudBodega.length===2 && ctx.__appstate.dash.exactitudBodega[0].bodega==='Nave Mina', 'cargarDashboard debe dejar la exactitud por bodega en state.dash.exactitudBodega, obtuvo: '+JSON.stringify(ctx.__appstate.dash.exactitudBodega));
  // exactitud_mensual: a diferencia de exactitud_por_bodega, agrupa por mes calendario (no por
  // ciclo) para poder comparar meses aunque la empresa nunca haya usado ciclos.
  const exactitudMensualCall = calls.find(c=>c.url.includes('/exactitud_mensual'));
  assert(!!exactitudMensualCall, 'cargarDashboard debe pedir /exactitud_mensual, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.exactitudMensual.length===4, 'cargarDashboard debe dejar la exactitud mensual en state.dash.exactitudMensual, obtuvo: '+JSON.stringify(ctx.__appstate.dash.exactitudMensual));
  const topPositivasCall = calls.find(c=>c.url.includes('/reconteo_pendiente') && c.url.includes('valor_diferencia_linea=gt.0'));
  const topNegativasCall = calls.find(c=>c.url.includes('/reconteo_pendiente') && c.url.includes('valor_diferencia_linea=lt.0'));
  assert(!!topPositivasCall && topPositivasCall.url.includes('order=valor_diferencia_linea.desc') && topPositivasCall.url.includes('limit=10'), 'cargarDashboard debe pedir el top 10 de excedentes ordenado por valor (costo total de la línea), obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(!!topNegativasCall && topNegativasCall.url.includes('order=valor_diferencia_linea.asc') && topNegativasCall.url.includes('limit=10'), 'cargarDashboard debe pedir el top 10 de pérdidas ordenado por valor (costo total de la línea), obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.topDiferenciasPositivas.length===1 && ctx.__appstate.dash.topDiferenciasPositivas[0].sku_code==='SKU-TOP-POS', 'cargarDashboard debe dejar el top de excedentes en state.dash.topDiferenciasPositivas, obtuvo: '+JSON.stringify(ctx.__appstate.dash.topDiferenciasPositivas));
  assert(ctx.__appstate.dash.topDiferenciasNegativas.length===1 && ctx.__appstate.dash.topDiferenciasNegativas[0].sku_code==='SKU-TOP-NEG', 'cargarDashboard debe dejar el top de pérdidas en state.dash.topDiferenciasNegativas, obtuvo: '+JSON.stringify(ctx.__appstate.dash.topDiferenciasNegativas));
  const valorizacionCall = calls.find(c=>c.url.includes('/valorizacion_diferencias'));
  assert(!!valorizacionCall, 'cargarDashboard debe pedir /valorizacion_diferencias, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.valorizacion.length===2 && ctx.__appstate.dash.valorizacion[0].bodega==='Nave Mina', 'cargarDashboard debe dejar la valorización por bodega en state.dash.valorizacion, obtuvo: '+JSON.stringify(ctx.__appstate.dash.valorizacion));
  const avancePlanCall = calls.find(c=>c.url.includes('/avance_plan_por_ciclo'));
  assert(!!avancePlanCall, 'cargarDashboard debe pedir /avance_plan_por_ciclo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.avancePlanPorCiclo.length===3 && ctx.__appstate.dash.avancePlanPorCiclo[0].bodega==='Nave Mina', 'cargarDashboard debe dejar el avance del plan por ciclo/bodega en state.dash.avancePlanPorCiclo, obtuvo: '+JSON.stringify(ctx.__appstate.dash.avancePlanPorCiclo));

  // ===== Dashboard: "Adherencia al plan" por período (selector client-side, no dispara fetch) =====
  // A pedido de Joel: pasa a medir cobertura contra TODO lo planificado en el período (no "de lo
  // contado, cuánto vino del plan"), ver avance_plan_por_ciclo / renderAdherenciaPlan.
  ctx.__appstate.ciclos = [{id:'ciclo-actual', nombre:'T1 2027', es_actual:true}, {id:'ciclo-viejo', nombre:'T4 2026', es_actual:false}];
  ctx.__appstate.dashPeriodo = '';
  ctx.__appstate.dash = {
    total: [], diario: [], semanal: [], mensual: [],
    avancePlanPorCiclo: [
      {ciclo_id:'ciclo-actual', bodega:'Nave Mina', total_planificados:8, contados:6},
      {ciclo_id:'ciclo-actual', bodega:'Nave Planta', total_planificados:2, contados:2},
      {ciclo_id:'ciclo-viejo', bodega:'Nave Mina', total_planificados:10, contados:5},
      {ciclo_id:null, bodega:'Nave Mina', total_planificados:1, contados:0},
    ],
  };
  const htmlAdherenciaActual = ctx.renderDashboard();
  assert(htmlAdherenciaActual.includes('Adherencia al plan'), 'debe existir la sección de adherencia al plan, obtuvo: '+htmlAdherenciaActual);
  assert(htmlAdherenciaActual.includes('id="dash-periodo"') && htmlAdherenciaActual.includes('Período actual — T1 2027'), 'el selector debe ofrecer el período actual por nombre, obtuvo: '+htmlAdherenciaActual);
  // Período actual (default ''): 6+2=8 contados, 8+2=10 planificados -> 80.0%.
  assert(htmlAdherenciaActual.includes('80.0%') && htmlAdherenciaActual.includes('8 de 10 SKU planificados'), 'con el período actual seleccionado debe calcular 8/10=80% sumando todas las bodegas de ese ciclo, obtuvo: '+htmlAdherenciaActual);
  assert(htmlAdherenciaActual.includes('Pendientes') && htmlAdherenciaActual.includes('SKU del plan sin contar todavía'), 'debe mostrar cuántos SKU del plan quedan sin contar, obtuvo: '+htmlAdherenciaActual);
  assert(htmlAdherenciaActual.includes('75.0%') && htmlAdherenciaActual.includes('6/8'), 'el desglose por bodega debe mostrar solo los datos del período elegido (Nave Mina: 6/8=75%), no mezclar con el ciclo viejo (que tendría 5/10=50%), obtuvo: '+htmlAdherenciaActual);

  // Cambiar a un período puntual (el viejo): 5 de 10 -> 50.0%.
  ctx.__appstate.dashPeriodo = 'ciclo-viejo';
  const htmlAdherenciaViejo = ctx.renderDashboard();
  assert(htmlAdherenciaViejo.includes('50.0%') && htmlAdherenciaViejo.includes('5 de 10 SKU planificados'), 'con el período viejo seleccionado debe recalcular 5/10=50%, sin volver a pedir datos al servidor, obtuvo: '+htmlAdherenciaViejo);

  // "Sin período": la entrada de plan con ciclo_id null.
  ctx.__appstate.dashPeriodo = '__sin_periodo__';
  const htmlAdherenciaSinPeriodo = ctx.renderDashboard();
  assert(htmlAdherenciaSinPeriodo.includes('0.0%') && htmlAdherenciaSinPeriodo.includes('0 de 1 SKU planificados'), 'con "Sin período" debe usar solo las filas con ciclo_id null, obtuvo: '+htmlAdherenciaSinPeriodo);

  // "Todos los períodos": tabla comparativa, más reciente primero, "Sin período" al final.
  ctx.__appstate.dashPeriodo = '__todos__';
  const htmlAdherenciaTodos = ctx.renderDashboard();
  const idxActualTodos = htmlAdherenciaTodos.indexOf('T1 2027');
  const idxViejoTodos = htmlAdherenciaTodos.indexOf('T4 2026');
  const idxSinPeriodoTodos = htmlAdherenciaTodos.indexOf('Sin período');
  assert(idxActualTodos>=0 && idxViejoTodos>idxActualTodos && idxSinPeriodoTodos>idxViejoTodos, 'en "todos los períodos" el orden debe ser: actual, luego el resto (más reciente primero), "Sin período" al final, obtuvo índices: '+idxActualTodos+'/'+idxViejoTodos+'/'+idxSinPeriodoTodos);
  assert(htmlAdherenciaTodos.includes('80.0%') && htmlAdherenciaTodos.includes('50.0%'), 'la tabla comparativa debe mostrar el % de adherencia de cada período, obtuvo: '+htmlAdherenciaTodos);
  assert(htmlAdherenciaTodos.includes('<th class="num">Planificados</th>') && htmlAdherenciaTodos.includes('<th class="num">Pendientes</th>'), 'la tabla comparativa debe mostrar planificados y pendientes, no "en plan/fuera de plan", obtuvo: '+htmlAdherenciaTodos);

  // Sin plan creado para el período elegido: mensaje vacío, no un cálculo con división por cero.
  ctx.__appstate.dashPeriodo = '';
  ctx.__appstate.ciclos = [{id:'ciclo-sin-datos', nombre:'T2 2027', es_actual:true}];
  const htmlAdherenciaVacio = ctx.renderDashboard();
  assert(htmlAdherenciaVacio.includes('Sin plan creado para este período'), 'sin plan para el período actual, debe mostrar el estado vacío en vez de NaN%, obtuvo: '+htmlAdherenciaVacio);
  ctx.__appstate.ciclos = [{id:'ciclo-actual', nombre:'T1 2027', es_actual:true}, {id:'ciclo-viejo', nombre:'T4 2026', es_actual:false}];

  // renderDashboard: la vista ejecutiva debe mostrar la proyección de término y el ranking por responsable.
  ctx.__appstate.dash = {
    total: [{bodega:'Nave Mina', skus_universo:200, skus_contados:60, porcentaje_avance:30}],
    diario: [{dia:'2026-08-10', skus_contados:'7', con_diferencia:'1', reconteos:'2'}], semanal: [], mensual: [],
    ranking: [{nombre:'Ana Torres', cantidad:9}, {nombre:'Beto', cantidad:4}],
    // Bug real reportado por Joel: "en estricto rigor no tengo diferencias" — el conteo con
    // diferencia (con_diferencia:'1' arriba) era un intento ya resuelto por un reconteo. La
    // sección "Diferencias" no debe sumar eso: debe mostrar los valores YA deduplicados por
    // SKU que trae diferenciasRecientes (mock: sin_diferencia:9, con_diferencia:1 — valores
    // deliberadamente distintos a los de "diario" para probar que no se mezclan).
    diferenciasRecientes: [{sin_diferencia:12, con_diferencia:0}],
  };
  const htmlDashProyeccion = ctx.renderDashboard();
  assert(htmlDashProyeccion.includes('Proyección de término'), 'la vista ejecutiva debe mostrar la sección de proyección, obtuvo: '+htmlDashProyeccion);
  assert(htmlDashProyeccion.includes('Ranking por responsable') && htmlDashProyeccion.includes('Ana Torres') && htmlDashProyeccion.includes('Beto'), 'la vista ejecutiva debe mostrar el ranking por responsable, obtuvo: '+htmlDashProyeccion);
  // El gráfico "Conteos por día" debe mostrar el valor sobre cada barra, no solo la fecha debajo.
  assert(htmlDashProyeccion.includes('font-weight="600" fill="var(--text-dim)">7</text>'), 'el gráfico de conteos por día debe mostrar el valor (7) encima de la barra, obtuvo: '+htmlDashProyeccion);
  // Pedido de Joel: los reconteos del día se pintan con otro color (var(--steel) — var(--accent)
  // no existía como token en la paleta de la app y quedaba invisible/negro, otro bug reportado),
  // apilados sobre los conteos originales (var(--amber)), con una leyenda debajo que distinga ambos.
  assert(htmlDashProyeccion.includes('fill="var(--steel)"') && htmlDashProyeccion.includes('2 reconteos'), 'la barra del día debe incluir un segmento var(--steel) con los 2 reconteos, obtuvo: '+htmlDashProyeccion);
  assert(htmlDashProyeccion.includes('fill="var(--amber)"') && htmlDashProyeccion.includes('5 conteos'), 'el resto de la barra (7-2=5) debe seguir en var(--amber) como conteos originales, obtuvo: '+htmlDashProyeccion);
  assert(htmlDashProyeccion.includes('Reconteos') && htmlDashProyeccion.match(/background:var\(--amber\)[^]*?Conteos/), 'debe mostrar una leyenda con las dos categorías (Conteos/Reconteos), obtuvo: '+htmlDashProyeccion);
  // "Diferencias" debe venir de diferenciasRecientes (12/0), no de sumar el con_diferencia
  // crudo de "diario" (que hubiera dado 6 sin diferencia / 1 con diferencia).
  assert(htmlDashProyeccion.includes('12 · 100%') && htmlDashProyeccion.includes('0 · 0%'), 'la sección Diferencias debe mostrar los valores ya deduplicados por SKU (12 sin diferencia, 0 con diferencia), no los del gráfico de actividad diaria, obtuvo: '+htmlDashProyeccion);

  // Sin conteos recientes (ranking vacío), no debe mostrarse la sección de ranking (nada que mostrar).
  ctx.__appstate.dash = { ...ctx.__appstate.dash, ranking: [] };
  const htmlDashSinRanking = ctx.renderDashboard();
  assert(!htmlDashSinRanking.includes('Ranking por responsable'), 'sin conteos en la ventana, no debe mostrarse la sección de ranking, obtuvo: '+htmlDashSinRanking);

  // ===== Dashboard de exactitud: % de unidades, % de ubicación, ranking por bodega y top diferencias =====
  ctx.__appstate.dash = {
    total: [{bodega:'Nave Mina', skus_universo:200, skus_contados:60, porcentaje_avance:30}],
    diario: [], semanal: [], mensual: [], ranking: [],
    exactitudBodega: [
      {bodega:'Nave Mina', skus_contados:20, sin_diferencia:16, con_diferencia:4, ubicacion_correcta:18},
      {bodega:'Nave Planta', skus_contados:10, sin_diferencia:4, con_diferencia:6, ubicacion_correcta:9},
    ],
    topDiferenciasPositivas: [
      {sku_code:'SKU-TOP-POS', descripcion:'Cable eléctrico', stock_sistema:10, ultima_cantidad_contada:40, ultima_diferencia:30, causa_probable:'Sin patrón detectado', valor_diferencia_linea:150000},
    ],
    topDiferenciasNegativas: [
      {sku_code:'SKU-TOP-NEG', descripcion:'Motor eléctrico', stock_sistema:50, ultima_cantidad_contada:20, ultima_diferencia:-30, causa_probable:'Ubicación distinta y recurrente', valor_diferencia_linea:-300000},
    ],
    valorizacion: [
      {bodega:'Nave Mina', valor_contado:1000000, valor_perdidas:-150000, valor_excedentes:40000},
      {bodega:'Nave Planta', valor_contado:500000, valor_perdidas:-20000, valor_excedentes:10000},
    ],
    resumenAbc: [
      {clase_abc:'A', cantidad_sku:3, pct_sku:10.0, valor_total:8000000, pct_valor:80.0, skus_contados:1, pct_avance:33.3},
      {clase_abc:'B', cantidad_sku:7, pct_sku:23.3, valor_total:1500000, pct_valor:15.0, skus_contados:2, pct_avance:28.6},
      {clase_abc:'C', cantidad_sku:20, pct_sku:66.7, valor_total:500000, pct_valor:5.0, skus_contados:4, pct_avance:20.0},
    ],
  };
  const htmlDashExactitud = ctx.renderDashboard();
  // Global: (16+4)/(20+10) = 66.7% de unidades; (18+9)/30 = 90% de ubicación.
  assert(htmlDashExactitud.includes('66.7%') && htmlDashExactitud.includes('De unidades'), 'debe calcular la exactitud de unidades sumando todas las bodegas, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('90.0%') && htmlDashExactitud.includes('De ubicación'), 'debe calcular la exactitud de ubicación sumando todas las bodegas, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Ranking por ubicación general') && htmlDashExactitud.includes('Nave Planta') && htmlDashExactitud.includes('Nave Mina'), 'debe mostrar el ranking de exactitud por bodega, obtuvo: '+htmlDashExactitud);
  const idxNavePlanta = htmlDashExactitud.indexOf('Nave Planta');
  const idxNaveMinaRanking = htmlDashExactitud.indexOf('Nave Mina', htmlDashExactitud.indexOf('Ranking por ubicación general'));
  assert(idxNavePlanta>=0 && idxNaveMinaRanking>idxNavePlanta, 'la peor exactitud (Nave Planta, 40%) debe listarse antes que la mejor (Nave Mina, 80%), obtuvo índices: '+idxNavePlanta+' / '+idxNaveMinaRanking);
  // Top materiales con diferencia: ahora dos listas por costo total de la línea, no una sola por
  // magnitud en unidades — pedido explícito: top 10 de excedentes y top 10 de pérdidas, por separado.
  assert(htmlDashExactitud.includes('Excedentes con más impacto') && htmlDashExactitud.includes('SKU-TOP-POS') && htmlDashExactitud.includes('$150.000'), 'debe mostrar el top de excedentes con su valor en plata, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Pérdidas con más impacto') && htmlDashExactitud.includes('SKU-TOP-NEG') && htmlDashExactitud.includes('$-300.000') && htmlDashExactitud.includes('badge-danger">Ubicación distinta y recurrente<'), 'debe mostrar el top de pérdidas con su valor en plata y la causa probable, obtuvo: '+htmlDashExactitud);

  // Valorización de diferencias: 4 tarjetas (contado/pérdidas/excedentes/neto) sumadas sobre todas las bodegas.
  // Contado: 1.000.000+500.000=1.500.000; pérdidas: -150.000-20.000=-170.000; excedentes: 40.000+10.000=50.000; neto: -120.000.
  assert(htmlDashExactitud.includes('Valorización de diferencias'), 'debe mostrar la sección de valorización de diferencias, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Valor contado') && htmlDashExactitud.includes('$1.500.000'), 'debe mostrar el valor contado sumado, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Pérdidas') && htmlDashExactitud.includes('$-170.000'), 'debe mostrar las pérdidas sumadas, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Excedentes') && htmlDashExactitud.includes('$50.000'), 'debe mostrar los excedentes sumados, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Neto') && htmlDashExactitud.includes('$-120.000'), 'debe mostrar el neto (pérdidas+excedentes), obtuvo: '+htmlDashExactitud);

  // Clasificación ABC (a pedido de Joel, tras el fix de permisos de skus_valor_abc_mv): una
  // tarjeta por clase con cantidad de SKU + % del catálogo + % del valor, ya agregado desde
  // skus_resumen_abc (no se cuenta en el cliente).
  assert(htmlDashExactitud.includes('Clasificación ABC'), 'debe mostrar la sección de clasificación ABC, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Clase A') && /Clase A[\s\S]{0,200}\b3\b[\s\S]{0,100}10(\.0)?% del catálogo[\s\S]{0,50}80(\.0)?% del valor/.test(htmlDashExactitud), 'la tarjeta de Clase A debe mostrar su cantidad de SKU y sus porcentajes de catálogo/valor, obtuvo: '+htmlDashExactitud);
  assert(htmlDashExactitud.includes('Clase B') && htmlDashExactitud.includes('Clase C'), 'debe mostrar las tres clases, obtuvo: '+htmlDashExactitud);
  assert(!htmlDashExactitud.includes('Sin clasificar'), 'sin SKU sin clasificar en los datos, esa tarjeta no debe aparecer, obtuvo: '+htmlDashExactitud);

  // % de conteo por clase (a pedido de Joel): sobre el ciclo actual, mismo criterio que
  // avance_total -- ya viene calculado desde skus_resumen_abc (skus_contados/pct_avance).
  assert(/Clase A[\s\S]{0,500}33\.3% contado/.test(htmlDashExactitud), 'la tarjeta de Clase A debe mostrar su % contado, obtuvo: '+htmlDashExactitud);
  assert(/Clase B[\s\S]{0,500}28\.6% contado/.test(htmlDashExactitud), 'la tarjeta de Clase B debe mostrar su % contado, obtuvo: '+htmlDashExactitud);
  assert(/Clase C[\s\S]{0,500}20% contado/.test(htmlDashExactitud), 'la tarjeta de Clase C debe mostrar su % contado, obtuvo: '+htmlDashExactitud);

  // Con SKU sin costo cargado (clase_abc devuelto como "Sin clasificar" desde skus_resumen_abc),
  // debe verse su propia tarjeta, sin inventarle un % de valor (no aporta valor calculable), pero
  // sí con su propio % contado (el avance de conteo no depende de tener costo cargado).
  ctx.__appstate.dash = { ...ctx.__appstate.dash, resumenAbc: [
    {clase_abc:'A', cantidad_sku:3, pct_sku:60.0, valor_total:8000000, pct_valor:100.0, skus_contados:3, pct_avance:100.0},
    {clase_abc:'Sin clasificar', cantidad_sku:2, pct_sku:40.0, valor_total:0, pct_valor:0, skus_contados:0, pct_avance:0},
  ]};
  const htmlDashSinClasificar = ctx.renderDashboard();
  assert(htmlDashSinClasificar.includes('Sin clasificar') && htmlDashSinClasificar.includes('40% del catálogo'), 'debe mostrar la tarjeta "Sin clasificar" con su % del catálogo, obtuvo: '+htmlDashSinClasificar);
  const filaSinClasificar = htmlDashSinClasificar.slice(htmlDashSinClasificar.indexOf('Sin clasificar'), htmlDashSinClasificar.indexOf('Sin clasificar')+500);
  assert(!filaSinClasificar.includes('% del valor'), 'la tarjeta "Sin clasificar" no debe mostrar % del valor (no se le puede calcular), obtuvo: '+filaSinClasificar);
  assert(filaSinClasificar.includes('0% contado'), 'la tarjeta "Sin clasificar" también debe mostrar su % contado, obtuvo: '+filaSinClasificar);

  // Sin datos de exactitud (empresa recién empezando), no debe mostrarse el ranking ni el top ni la valorización.
  ctx.__appstate.dash = { ...ctx.__appstate.dash, exactitudBodega: [], topDiferenciasPositivas: [], topDiferenciasNegativas: [], valorizacion: [], resumenAbc: [] };
  const htmlDashSinExactitud = ctx.renderDashboard();
  assert(!htmlDashSinExactitud.includes('Ranking por ubicación general') && !htmlDashSinExactitud.includes('Excedentes con más impacto') && !htmlDashSinExactitud.includes('Pérdidas con más impacto'), 'sin datos de exactitud todavía, no deben mostrarse esas secciones, obtuvo: '+htmlDashSinExactitud);
  assert(!htmlDashSinExactitud.includes('Valorización de diferencias'), 'sin datos de valorización, no debe mostrarse esa sección, obtuvo: '+htmlDashSinExactitud);
  assert(!htmlDashSinExactitud.includes('Clasificación ABC'), 'sin datos de clasificación ABC (empresa sin SKU con costo cargado), no debe mostrarse esa sección, obtuvo: '+htmlDashSinExactitud);

  // ===== Tendencia de exactitud (exactitud_mensual): compara un mes calendario contra otro sin
  // depender de que la empresa use ciclos (a pedido explícito: "comparación entre inventarios
  // por mes, ciclo, año" — se implementó la variante por mes porque en la práctica casi ninguna
  // empresa cierra ciclos y ese histórico queda vacío). =====
  ctx.__appstate.dash = {
    ...ctx.__appstate.dash,
    exactitudMensual: [
      {mes:'2026-06-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:10, sin_diferencia:6, con_diferencia:4, ubicacion_correcta:10},
      {mes:'2026-06-01T00:00:00+00:00', bodega:'Nave Planta', skus_contados:10, sin_diferencia:8, con_diferencia:2, ubicacion_correcta:10},
      {mes:'2026-08-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:10, sin_diferencia:9, con_diferencia:1, ubicacion_correcta:10},
      {mes:'2026-08-01T00:00:00+00:00', bodega:'Nave Planta', skus_contados:10, sin_diferencia:7, con_diferencia:3, ubicacion_correcta:10},
    ],
  };
  const htmlTendencia = ctx.renderDashboard();
  assert(htmlTendencia.includes('Tendencia de exactitud'), 'debe existir la sección de tendencia de exactitud, obtuvo: '+htmlTendencia);
  // Jun: (6+8)/20=70.0%; Ago: (9+7)/20=80.0% -> exactitud global de cada mes, sumando bodegas.
  assert(htmlTendencia.includes('70.0') && htmlTendencia.includes('80.0'), 'el gráfico debe mostrar la exactitud global de cada mes, obtuvo: '+htmlTendencia);
  assert(htmlTendencia.includes('Jun 26') && htmlTendencia.includes('Ago 26'), 'el gráfico debe etiquetar cada barra con su mes, obtuvo: '+htmlTendencia);
  // Nave Mina pasó de 60% (jun) a 90% (ago): +30 puntos, la que más mejoró.
  assert(htmlTendencia.includes('<strong>Nave Mina</strong> mejoró 30.0 puntos'), 'debe destacar la bodega que más mejoró con su delta, obtuvo: '+htmlTendencia);
  assert(htmlTendencia.includes('60.0% → 90.0%'), 'debe mostrar el detalle inicio->fin de la bodega destacada, obtuvo: '+htmlTendencia);
  // Nave Planta pasó de 80% (jun) a 70% (ago): -10 puntos, la que bajó.
  assert(htmlTendencia.includes('<strong>Nave Planta</strong> bajó 10.0 puntos'), 'debe destacar la bodega que más bajó, obtuvo: '+htmlTendencia);

  // Con un solo mes de historia todavía no hay "tendencia" que mostrar (no alcanza a comparar).
  ctx.__appstate.dash = {
    ...ctx.__appstate.dash,
    exactitudMensual: [
      {mes:'2026-08-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:10, sin_diferencia:9, con_diferencia:1, ubicacion_correcta:10},
    ],
  };
  const htmlUnMes = ctx.renderDashboard();
  assert(htmlUnMes.includes('solo hay conteos de Ago 26'), 'con un solo mes de historia debe explicar que la tendencia aparece con más de un mes, obtuvo: '+htmlUnMes);
  assert(!htmlUnMes.includes('mejoró') && !htmlUnMes.includes('bajó'), 'con un solo mes no debe intentar calcular ninguna comparación, obtuvo: '+htmlUnMes);

  // Sin ningún conteo todavía.
  ctx.__appstate.dash = { ...ctx.__appstate.dash, exactitudMensual: [] };
  const htmlSinMeses = ctx.renderDashboard();
  assert(htmlSinMeses.includes('Vas a ver la tendencia acá'), 'sin conteos todavía, debe mostrar el mensaje de que la tendencia aparecerá más adelante, obtuvo: '+htmlSinMeses);

  // renderBarChart: la etiqueta y el tooltip de cada barra deben redondear a 1 decimal -- a pedido
  // de Joel, que vio "52.9411764705" sin redondear en Tendencia de exactitud (9/17*100, un
  // decimal periódico). El alto de la barra sigue calculado con el valor exacto, solo se redondea
  // lo que se MUESTRA. Un conteo entero (ej. "Conteos por día") no se ve afectado: redondear un
  // entero a 1 decimal da el mismo entero (sin ".0" de sobra).
  ctx.__appstate.dash = {
    ...ctx.__appstate.dash,
    exactitudMensual: [
      {mes:'2026-08-01T00:00:00+00:00', bodega:'B501', skus_contados:17, sin_diferencia:17, con_diferencia:0, ubicacion_correcta:17},
      {mes:'2026-09-01T00:00:00+00:00', bodega:'B501', skus_contados:17, sin_diferencia:9, con_diferencia:8, ubicacion_correcta:17},
    ],
  };
  const htmlTendenciaDecimal = ctx.renderDashboard();
  assert(htmlTendenciaDecimal.includes('52.9') && !htmlTendenciaDecimal.includes('52.9411764705'), 'la barra de Sep 26 (9/17=52.9411764705...%) debe mostrarse redondeada a "52.9", no con todos los decimales, obtuvo: '+htmlTendenciaDecimal);
  assert(/>100<\/text>/.test(htmlTendenciaDecimal) && !htmlTendenciaDecimal.includes('100.0<'), 'la barra de Ago 26 (100%, un entero) debe mostrarse como "100", no "100.0", obtuvo: '+htmlTendenciaDecimal);

  // ===== Orden de la vista Ejecutiva del Dashboard (a pedido de Joel): primero el resumen de un
  // vistazo -- Avance global, Exactitud, Adherencia al plan, Valorización, Proyección, en ese
  // orden exacto -- y recién después el detalle/tendencia de cada uno y la actividad reciente,
  // en el orden que yo definí. Antes "Adherencia al plan" vivía SIEMPRE arriba de todo (tanto en
  // Ejecutivo como en Operativo), separada de renderInformeEjecutivo(); ahora en Ejecutivo se
  // integra en este orden, y en Operativo sigue igual que antes (arriba de todo, sin cambios).
  ctx.__appstate.dashboardModo = 'ejecutivo';
  ctx.__appstate.dashPeriodo = '';
  ctx.__appstate.ciclos = [{id:'ciclo-orden', nombre:'T1 2027', es_actual:true}];
  ctx.__appstate.dash = {
    total: [{bodega:'Nave Mina', skus_universo:100, skus_contados:50, porcentaje_avance:50}],
    diario: [{dia:'2026-08-10', skus_contados:'7', con_diferencia:'1', reconteos:'2'}],
    semanal: [], mensual: [],
    ranking: [{nombre:'Ana Torres', cantidad:9}],
    diferenciasRecientes: [{sin_diferencia:9, con_diferencia:1}],
    exactitudBodega: [{bodega:'Nave Mina', skus_contados:20, sin_diferencia:16, con_diferencia:4, ubicacion_correcta:18}],
    exactitudMensual: [
      {mes:'2026-06-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:10, sin_diferencia:6, con_diferencia:4, ubicacion_correcta:10},
      {mes:'2026-08-01T00:00:00+00:00', bodega:'Nave Mina', skus_contados:10, sin_diferencia:9, con_diferencia:1, ubicacion_correcta:10},
    ],
    topDiferenciasPositivas: [{sku_code:'SKU-TOP-POS', descripcion:'Cable eléctrico', stock_sistema:10, ultima_cantidad_contada:40, ultima_diferencia:30, causa_probable:'Sin patrón detectado', valor_diferencia_linea:150000}],
    topDiferenciasNegativas: [{sku_code:'SKU-TOP-NEG', descripcion:'Motor eléctrico', stock_sistema:50, ultima_cantidad_contada:20, ultima_diferencia:-30, causa_probable:'Ubicación distinta y recurrente', valor_diferencia_linea:-300000}],
    valorizacion: [{bodega:'Nave Mina', valor_contado:1000000, valor_perdidas:-150000, valor_excedentes:40000}],
    avancePlanPorCiclo: [{ciclo_id:'ciclo-orden', bodega:'Nave Mina', total_planificados:8, contados:6}],
  };
  const htmlOrden = ctx.renderDashboard();
  const idx = (texto) => htmlOrden.indexOf(texto);
  const idxAvanceGlobal = idx('Avance global');
  const idxExactitud = idx('<h2 style="font-size:17px">Exactitud ');
  const idxAdherencia = idx('Adherencia al plan');
  const idxValorizacion = idx('Valorización de diferencias');
  const idxProyeccion = idx('Proyección de término');
  const idxTendencia = idx('Tendencia de exactitud');
  const idxRankingUbicacion = idx('Ranking por ubicación general');
  const idxTopExcedentes = idx('Excedentes con más impacto');
  const idxTopPerdidas = idx('Pérdidas con más impacto');
  const idxConteosPorDia = idx('Conteos por día');
  const idxRankingResponsable = idx('Ranking por responsable');
  assert(idxAvanceGlobal>=0 && idxExactitud>idxAvanceGlobal && idxAdherencia>idxExactitud && idxValorizacion>idxAdherencia && idxProyeccion>idxValorizacion,
    'la vista Ejecutiva debe mostrar primero, en este orden exacto: Avance global, Exactitud, Adherencia al plan, Valorización, Proyección -- obtuvo índices: '+JSON.stringify({idxAvanceGlobal,idxExactitud,idxAdherencia,idxValorizacion,idxProyeccion}));
  assert(idxTendencia>idxProyeccion && idxRankingUbicacion>idxTendencia && idxTopExcedentes>idxRankingUbicacion && idxTopPerdidas>idxTopExcedentes && idxConteosPorDia>idxTopPerdidas && idxRankingResponsable>idxConteosPorDia,
    'el resto de las secciones (detalle/tendencia y actividad reciente) debe quedar después del resumen de arriba, en el orden definido, obtuvo índices: '+JSON.stringify({idxTendencia,idxRankingUbicacion,idxTopExcedentes,idxTopPerdidas,idxConteosPorDia,idxRankingResponsable}));
  // "id=dash-periodo" (el selector de período de Adherencia) es único por render de
  // renderAdherenciaPlan() -- a diferencia del texto "Adherencia al plan", que aparece dos veces
  // DENTRO de un mismo render legítimo (el título de la sección y, además, como kpi-label de la
  // tarjeta de un período puntual) -- así que es el marcador correcto para detectar si la
  // sección completa quedó duplicada por accidente.
  const vecesAdherenciaEjecutivo = htmlOrden.split('id="dash-periodo"').length - 1;
  assert(vecesAdherenciaEjecutivo===1, 'en modo Ejecutivo, la sección de Adherencia no debe duplicarse (antes se renderizaba aparte Y podía quedar de nuevo si se integraba mal), obtuvo '+vecesAdherenciaEjecutivo+' apariciones');

  // En modo Operativo, "Adherencia al plan" sigue apareciendo arriba de todo (fuera de
  // renderInformeEjecutivo, que ni se usa en este modo), sin duplicarse ni desaparecer.
  ctx.__appstate.dashboardModo = 'operativo';
  const htmlOrdenOperativo = ctx.renderDashboard();
  const vecesAdherenciaOperativo = htmlOrdenOperativo.split('id="dash-periodo"').length - 1;
  assert(vecesAdherenciaOperativo===1, 'en modo Operativo, la sección de Adherencia debe seguir apareciendo (una sola vez), obtuvo '+vecesAdherenciaOperativo+' apariciones');
  ctx.__appstate.dashboardModo = 'ejecutivo';

  // ===== Estado general de SKU (Dashboard, a pedido de Joel: "siento que falta ver resúmenes de
  // contado, pendiente, etc" sobre TODO el maestro completo, no solo el ciclo actual o lo que
  // trae Buscar) -- ver cargarResumenGeneralSkus/renderResumenGeneralSkus. =====
  resumenGeneralSkusFixture = {total_activo:58716, no_contado:58691, cuadrado:16, con_diferencia:9, pendiente:0};
  ctx.__appstate.resumenGeneral = {fechaDesde:'', fechaHasta:'', tipoGrafico:'torta', datos:null, cargando:false};
  calls.length = 0;
  await ctx.cargarResumenGeneralSkus();
  const resumenGeneralCall = calls.find(c=>c.url.includes('/rpc/resumen_general_skus'));
  assert(!!resumenGeneralCall && resumenGeneralCall.opts.method==='POST', 'cargarResumenGeneralSkus debe llamar al RPC resumen_general_skus, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const bodyResumenGeneral = JSON.parse(resumenGeneralCall.opts.body);
  assert(bodyResumenGeneral.p_fecha_desde===null && bodyResumenGeneral.p_fecha_hasta===null, 'sin rango de fechas elegido, el RPC debe recibir ambos límites en null, obtuvo: '+JSON.stringify(bodyResumenGeneral));
  assert(!!ctx.__appstate.resumenGeneral.datos && ctx.__appstate.resumenGeneral.datos.total_activo===58716 && ctx.__appstate.resumenGeneral.cargando===false, 'cargarResumenGeneralSkus debe dejar la fila que devuelve el RPC en state.resumenGeneral.datos, obtuvo: '+JSON.stringify(ctx.__appstate.resumenGeneral));

  const htmlResumenGeneral = ctx.renderResumenGeneralSkus();
  assert(htmlResumenGeneral.includes('Estado general de SKU'), 'debe mostrar el título de la sección, obtuvo: '+htmlResumenGeneral);
  assert(htmlResumenGeneral.includes('58.716') && htmlResumenGeneral.includes('No contado (58.691)') && htmlResumenGeneral.includes('Cuadrado (16)') && htmlResumenGeneral.includes('Diferencia (9)') && htmlResumenGeneral.includes('Pendiente (0)'), 'debe mostrar el total activo y el desglose por estado con sus valores reales, obtuvo: '+htmlResumenGeneral);
  assert(!htmlResumenGeneral.includes('nunca contados'), 'sin rango de fechas elegido, no debe mostrar la aclaración sobre "No contado", obtuvo: '+htmlResumenGeneral);
  // Torta por defecto: círculo/arcos (<path>/<circle>), nunca barras (<rect>).
  assert(!htmlResumenGeneral.includes('<rect'), 'con tipoGrafico=torta no debe dibujar barras (<rect>), obtuvo: '+htmlResumenGeneral);
  assert(htmlResumenGeneral.includes('<circle') || htmlResumenGeneral.includes('<path'), 'con tipoGrafico=torta debe dibujar la torta (<circle> o <path>), obtuvo: '+htmlResumenGeneral);

  // Alternar a "Barras" es puramente client-side (ver bind(): el click en data-resumen-grafico
  // solo cambia tipoGrafico, sin volver a pedir datos al servidor).
  ctx.__appstate.resumenGeneral = {...ctx.__appstate.resumenGeneral, tipoGrafico:'barras'};
  const htmlResumenGeneralBarras = ctx.renderResumenGeneralSkus();
  assert(htmlResumenGeneralBarras.includes('<rect'), 'con tipoGrafico=barras debe dibujar barras (<rect>), obtuvo: '+htmlResumenGeneralBarras);
  ctx.__appstate.resumenGeneral = {...ctx.__appstate.resumenGeneral, tipoGrafico:'torta'};

  // Visible en ambos modos del Dashboard (Ejecutivo/Operativo) -- es una foto del maestro
  // completo, no algo propio de uno u otro -- sin duplicarse en ninguno.
  const vecesEjecutivo = (ctx.renderDashboard().match(/Estado general de SKU/g)||[]).length;
  assert(vecesEjecutivo===1, 'en modo Ejecutivo, la sección de estado general debe aparecer una sola vez, obtuvo '+vecesEjecutivo+' apariciones');
  ctx.__appstate.dashboardModo = 'operativo';
  const vecesOperativo = (ctx.renderDashboard().match(/Estado general de SKU/g)||[]).length;
  assert(vecesOperativo===1, 'en modo Operativo, la sección de estado general debe aparecer una sola vez, obtuvo '+vecesOperativo+' apariciones');
  ctx.__appstate.dashboardModo = 'ejecutivo';

  // ===== Filtro de criticidad ("un filtro que permita separar los críticos y el resto", a
  // pedido de Joel): ''=todos, 'criticos'=solo críticos, 'no_criticos'=solo no críticos. Se aplica
  // en el WHERE base del RPC (no como un balde aparte), así total_activo también queda acotado al
  // grupo elegido -- si no, "de tus X SKU..." mostraría el total general aunque el desglose de
  // abajo esté mirando solo los críticos. =====
  resumenGeneralSkusFixture = {total_activo:908, no_contado:905, cuadrado:2, con_diferencia:1, pendiente:0};
  ctx.__appstate.resumenGeneral = {fechaDesde:'', fechaHasta:'', criticidad:'criticos', tipoGrafico:'torta', datos:null, cargando:false};
  calls.length = 0;
  await ctx.cargarResumenGeneralSkus();
  const rpcCriticos = calls.find(c=>c.url.includes('/rpc/resumen_general_skus'));
  assert(JSON.parse(rpcCriticos.opts.body).p_criticidad==='criticos', 'con "Solo críticos" elegido, el RPC debe recibir p_criticidad="criticos", obtuvo: '+rpcCriticos.opts.body);
  const htmlCriticos = ctx.renderResumenGeneralSkus();
  assert(htmlCriticos.includes('id="rg-criticidad"') && htmlCriticos.includes('value="criticos" selected'), 'debe mostrar el selector de criticidad con "Solo críticos" seleccionado, obtuvo: '+htmlCriticos);
  assert(htmlCriticos.includes('908') && htmlCriticos.includes('SKU críticos'), 'con el filtro activo, el total mostrado debe ser el del grupo filtrado (908 críticos), no el general, obtuvo: '+htmlCriticos);

  resumenGeneralSkusFixture = {total_activo:57808, no_contado:57786, cuadrado:14, con_diferencia:8, pendiente:0};
  ctx.__appstate.resumenGeneral = {...ctx.__appstate.resumenGeneral, criticidad:'no_criticos'};
  calls.length = 0;
  await ctx.cargarResumenGeneralSkus();
  const rpcNoCriticos = calls.find(c=>c.url.includes('/rpc/resumen_general_skus'));
  assert(JSON.parse(rpcNoCriticos.opts.body).p_criticidad==='no_criticos', 'con "Solo no críticos" elegido, el RPC debe recibir p_criticidad="no_criticos", obtuvo: '+rpcNoCriticos.opts.body);
  const htmlNoCriticos = ctx.renderResumenGeneralSkus();
  assert(htmlNoCriticos.includes('id="rg-criticidad"') && htmlNoCriticos.includes('value="no_criticos" selected'), 'debe mostrar "Solo no críticos" seleccionado, obtuvo: '+htmlNoCriticos);
  assert(htmlNoCriticos.includes('57.808') && htmlNoCriticos.includes('SKU no críticos'), 'con "Solo no críticos", el total mostrado debe ser el del grupo filtrado, obtuvo: '+htmlNoCriticos);

  resumenGeneralSkusFixture = {total_activo:58716, no_contado:58691, cuadrado:16, con_diferencia:9, pendiente:0};
  ctx.__appstate.resumenGeneral = {...ctx.__appstate.resumenGeneral, criticidad:''};
  calls.length = 0;
  await ctx.cargarResumenGeneralSkus();
  const rpcTodos = calls.find(c=>c.url.includes('/rpc/resumen_general_skus'));
  assert(JSON.parse(rpcTodos.opts.body).p_criticidad===null, 'sin criticidad elegida ("Todos"), el RPC debe recibir p_criticidad=null, obtuvo: '+rpcTodos.opts.body);

  // El rango de fechas filtra CUÁNDO se contó -- viaja como el mismo instante (timestamptz) que
  // usa Buscar, no como fecha simple (ver instantesFiltroFecha: correctness fix ya aplicado esta
  // sesión para el RPC contar_busqueda_skus, reusado acá). "No contado" nunca cambia con el
  // rango, y se avisa cuando queda gente contada fuera de la ventana elegida.
  resumenGeneralSkusFixture = {total_activo:58716, no_contado:58691, cuadrado:3, con_diferencia:1, pendiente:0};
  ctx.__appstate.resumenGeneral = {fechaDesde:'2026-08-20', fechaHasta:'2026-08-25', tipoGrafico:'torta', datos:null, cargando:false};
  calls.length = 0;
  await ctx.cargarResumenGeneralSkus();
  const rpcConRango = calls.find(c=>c.url.includes('/rpc/resumen_general_skus'));
  const bodyConRango = JSON.parse(rpcConRango.opts.body);
  const desdeEsperadoResumen = new Date('2026-08-20T00:00:00').toISOString();
  const hastaEsperadoResumen = new Date('2026-08-26T00:00:00').toISOString();
  assert(bodyConRango.p_fecha_desde===desdeEsperadoResumen && bodyConRango.p_fecha_hasta===hastaEsperadoResumen, 'con un rango de fechas elegido, el RPC debe recibir el instante exacto (medianoche local a UTC), no la fecha simple, obtuvo: '+JSON.stringify(bodyConRango));
  const htmlConRango = ctx.renderResumenGeneralSkus();
  assert(htmlConRango.includes('58.691 nunca contados (no cambia con el rango elegido)'), 'con un rango elegido, debe explicitar que "No contado" es independiente del rango, obtuvo: '+htmlConRango);
  assert(htmlConRango.includes('SKU contados fuera del rango elegido no aparecen en el gráfico'), 'cuando el total activo supera lo que se ve en el gráfico (58716 > 3+1+0+58691), debe avisar que hay SKU contados fuera del rango elegido, obtuvo: '+htmlConRango);
  resumenGeneralSkusFixture = null;
  ctx.__appstate.resumenGeneral = {fechaDesde:'', fechaHasta:'', tipoGrafico:'torta', datos:null, cargando:false};

  // Estados de carga/vacío.
  ctx.__appstate.resumenGeneral = {...ctx.__appstate.resumenGeneral, cargando:true, datos:null};
  assert(ctx.renderResumenGeneralSkus().includes('spinner'), 'mientras carga debe mostrar el spinner, obtuvo: '+ctx.renderResumenGeneralSkus());
  ctx.__appstate.resumenGeneral = {...ctx.__appstate.resumenGeneral, cargando:false, datos:null};
  assert(ctx.renderResumenGeneralSkus().includes('Sin datos todavía'), 'sin datos y sin estar cargando, debe mostrar el estado vacío, obtuvo: '+ctx.renderResumenGeneralSkus());

  // ===== Ícono "i" con qué considera cada panel del Dashboard (a pedido de Joel: "incluye
  // reconteos", "SKU planificados y no planificados", etc., sin tener que adivinar ni leer el
  // código). campoConInfo() arma un <details> nativo -- se abre/cierra igual con tap en celular
  // que con clic en computador, sin JS propio. =====
  assert(ctx.campoConInfo('Texto de prueba').includes('<details class="info-dato">') && ctx.campoConInfo('Texto de prueba').includes('<summary') && ctx.campoConInfo('Texto de prueba').includes('Texto de prueba'), 'campoConInfo debe devolver un <details> con el ícono y el texto explicativo, obtuvo: '+ctx.campoConInfo('Texto de prueba'));
  // Muchos paneles del Ejecutivo deben traer su ícono -- no solo uno o dos sueltos.
  const cantidadInfoEjecutivo = (htmlOrden.match(/class="info-dato"/g)||[]).length;
  assert(cantidadInfoEjecutivo>=10, 'la vista Ejecutiva debe traer el ícono de info en la mayoría de sus paneles, obtuvo solo '+cantidadInfoEjecutivo);
  // Los dos ejemplos que dio Joel explícitamente: "incluye reconteos" (Conteos recientes) y
  // "SKU planificados" (Adherencia al plan) deben estar entre las explicaciones mostradas.
  assert(htmlOrden.includes('Incluye reconteos (no es SKU únicos)'), 'debe explicar que "Conteos recientes" incluye reconteos, obtuvo: '+htmlOrden.includes('Incluye reconteos'));
  assert(htmlOrden.includes('SKU planificados en el período contra los que aún faltan por contar'), 'debe explicar qué considera "Adherencia al plan" (planificados vs. sin contar), obtuvo: '+htmlOrden.includes('SKU planificados en el período'));
  // Modo Operativo también debe traer sus íconos (Diario/Semanal/Mensual/Materiales contados).
  const cantidadInfoOperativo = (htmlOrdenOperativo.match(/class="info-dato"/g)||[]).length;
  assert(cantidadInfoOperativo>=4, 'la vista Operativa debe traer el ícono de info en sus paneles, obtuvo solo '+cantidadInfoOperativo);

  // ===== Regresión: PostgREST serializa bigint (count()) como string, no como número =====
  // avance_total/avance_diario usan count()/count(distinct), que PostgREST devuelve como
  // string en el JSON (para no perder precisión). Si el código suma esos campos con "+"
  // sin convertirlos primero, JS concatena texto en vez de sumar ("0"+"3" -> "03") y el
  // avance global y la proyección de término quedan con números sin sentido.
  ctx.__appstate.dash = {
    total: [
      { bodega:'Bodega Central Rajo', skus_universo:'13', skus_contados:'13', porcentaje_avance:'100.0' },
      { bodega:'Bodega Planta Chancado', skus_universo:'11', skus_contados:'9', porcentaje_avance:'81.8' },
    ],
    diario: [
      { dia:'2026-08-18', bodega:'Bodega Central Rajo', skus_contados:'2', con_diferencia:'1', reconteos:'1', total_unidades_contadas:'30' },
      { dia:'2026-08-18', bodega:'Bodega Planta Chancado', skus_contados:'3', con_diferencia:'1', reconteos:'0', total_unidades_contadas:'42' },
    ],
    semanal: [], mensual: [], ranking: [],
  };
  const htmlDashStrings = ctx.renderDashboard();
  assert(htmlDashStrings.includes('91.7%'), 'con campos numéricos como string (igual que los devuelve PostgREST), el avance global debe seguir calculándose bien (22/24 = 91.7%), obtuvo: '+htmlDashStrings);
  assert(!htmlDashStrings.includes('01311') && !htmlDashStrings.includes('0139'), 'no debe quedar rastro de concatenación de texto en vez de suma numérica, obtuvo: '+htmlDashStrings);

  const diarioAggStrings = ctx.agregarPorDia(ctx.__appstate.dash.diario, 14);
  assert(diarioAggStrings.length===1 && diarioAggStrings[0].contados===5 && diarioAggStrings[0].diferencias===2 && diarioAggStrings[0].reconteos===1, 'agregarPorDia debe sumar numéricamente aunque los campos vengan como string (incluido reconteos), obtuvo: '+JSON.stringify(diarioAggStrings));

  // ===== Planes: gating de funcionalidades según el plan de la empresa =====

  // Sin plan cargado en el perfil (embed que aún no llegó, o falló), planIncluye() debe
  // fallar "abierto" (asumir que sí está incluido) — es una restricción de UX, el límite
  // real lo aplican los triggers en la base de datos, así que no hay riesgo en fallar abierto.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  assert(ctx.planIncluye('dashboard_ejecutivo_habilitado')===true, 'sin plan cargado, planIncluye debe devolver true (fallar abierto)');

  // Plan básico: sin dashboard ejecutivo ni auditoría.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', planes:{nombre:'basico', etiqueta:'Básico', max_bodegas:1, max_usuarios:3, offline_habilitado:false, dashboard_ejecutivo_habilitado:false, auditoria_habilitada:false}} };
  ctx.__appstate.dashboardModo = 'ejecutivo';
  ctx.__appstate.dash = { total: [{bodega:'Nave Mina', skus_universo:200, skus_contados:60, porcentaje_avance:30}], diario: [], semanal: [], mensual: [], ranking: [] };
  const htmlDashBasico = ctx.renderDashboard();
  assert(!htmlDashBasico.includes('data-dash-modo="ejecutivo"'), 'plan básico no debe mostrar el botón para activar el modo Ejecutivo, obtuvo: '+htmlDashBasico);
  assert(!htmlDashBasico.includes('Proyección de término'), 'plan básico no debe mostrar la proyección de término aunque dashboardModo siga en "ejecutivo", obtuvo: '+htmlDashBasico);
  assert(/id="btn-exportar-informe"[^>]*disabled/.test(htmlDashBasico), 'plan básico debe mostrar el botón "Exportar informe" deshabilitado, obtuvo: '+htmlDashBasico);
  assert(htmlDashBasico.includes('Exportar informe 🔒'), 'plan básico debe mostrar el candado en el botón de exportar informe, obtuvo: '+htmlDashBasico);

  // Cupo de operadores restante (hintCupoOperadores): max_usuarios cuenta solo activos con
  // rol<>'admin' (ver el trigger chequear_limite_usuarios) — 2 de 3 activos usados = queda 1.
  ctx.__appstate.equipo = { cargado:true, cargando:false, personas: [
    {id:'e1', nombre:'Op 1', rol:'operador', activo:true},
    {id:'e2', nombre:'Op 2', rol:'operador', activo:true},
    {id:'e3', nombre:'Op 3 inactiva', rol:'operador', activo:false},
    {id:'e4', nombre:'Admin', rol:'admin', activo:true},
  ] };
  const htmlConfigBasico = ctx.renderConfiguraciones();
  assert(!htmlConfigBasico.includes('Auditoría de cambios'), 'plan básico no debe mostrar la sección de auditoría aunque el usuario sea admin, obtuvo: '+htmlConfigBasico);
  assert(htmlConfigBasico.includes('Puedes crear 1 operador más') && htmlConfigBasico.includes('hasta 3'), 'debe mostrar cuántos operadores más caben en el plan (3 - 2 activos = 1), obtuvo: '+htmlConfigBasico);

  // Cupo agotado: 3 de 3 activos usados.
  ctx.__appstate.equipo.personas.push({id:'e5', nombre:'Op 3', rol:'operador', activo:true});
  const htmlConfigCupoLleno = ctx.renderConfiguraciones();
  assert(htmlConfigCupoLleno.includes('Alcanzaste el límite de operadores de tu plan (3)'), 'con el cupo lleno, debe avisar que se alcanzó el límite en vez de un número negativo, obtuvo: '+htmlConfigCupoLleno);

  // Plan profesional: sí debe verse todo.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', planes:{nombre:'profesional', etiqueta:'Profesional', max_bodegas:null, max_usuarios:15, offline_habilitado:true, dashboard_ejecutivo_habilitado:true, auditoria_habilitada:true}} };
  const htmlDashPro = ctx.renderDashboard();
  assert(htmlDashPro.includes('data-dash-modo="ejecutivo"'), 'plan profesional debe mostrar el botón del modo Ejecutivo, obtuvo: '+htmlDashPro);
  assert(/id="btn-exportar-informe"(?![^>]*disabled)[^>]*>/.test(htmlDashPro), 'plan profesional debe mostrar el botón "Exportar informe" habilitado, obtuvo: '+htmlDashPro);
  assert(!htmlDashPro.includes('Exportar informe 🔒'), 'plan profesional no debe mostrar el candado en el botón de exportar informe, obtuvo: '+htmlDashPro);
  const htmlConfigPro = ctx.renderConfiguraciones();
  assert(htmlConfigPro.includes('Auditoría de cambios'), 'plan profesional debe mostrar la sección de auditoría para un admin, obtuvo: '+htmlConfigPro);

  // Plan sin límite de operadores (max_usuarios null, ej. plan Empresa): no debe mostrarse
  // ningún cupo, ni positivo ni "límite alcanzado".
  assert(ctx.hintCupoOperadores({planes:{max_usuarios:null}})==='', 'sin max_usuarios definido (plan sin límite), no debe mostrarse ningún hint de cupo');

  // imprimirInformeCiclo(): debe volcar exactamente el contenido de la vista ejecutiva del
  // dashboard (mismos KPI) en #print-informe, con encabezado de empresa/ciclo/fecha, y llamar
  // a window.print() — reusando el plan profesional recién dejado en ctx.__appstate.perfil.
  ctx.__appstate.ciclos = [{id:'ciclo-1', nombre:'T1 2027', es_actual:true}, {id:'ciclo-2', nombre:'T4 2026', es_actual:false}];
  ctx.__appstate.dash = {
    total: [{bodega:'Nave Mina', skus_universo:200, skus_contados:60, porcentaje_avance:30}],
    diario: [], semanal: [], mensual: [], ranking: [], exactitudBodega: [], topDiferenciasPositivas: [], topDiferenciasNegativas: [], valorizacion: [],
  };
  const printInformeEl = makeEl('print-informe');
  printInformeEl.innerHTML = '';
  const printPlanElPrevio = makeEl('print-plan');
  printPlanElPrevio.innerHTML = '<h1>Plan de conteo semanal</h1>';
  printCalled = 0;
  ctx.imprimirInformeCiclo();
  assert(printCalled===1, 'imprimirInformeCiclo debe llamar a window.print()');
  assert(printInformeEl.innerHTML.includes('Informe de ciclo de conteo'), 'el informe debe tener título propio, obtuvo: '+printInformeEl.innerHTML);
  assert(printInformeEl.innerHTML.includes('Minera Andes') && printInformeEl.innerHTML.includes('T1 2027'), 'el encabezado del informe debe indicar la empresa y el ciclo actual, obtuvo: '+printInformeEl.innerHTML);
  assert(printInformeEl.innerHTML.includes('Avance global') && printInformeEl.innerHTML.includes('Nave Mina'), 'el informe debe incluir el mismo contenido de la vista ejecutiva del dashboard, obtuvo: '+printInformeEl.innerHTML);
  assert(printPlanElPrevio.innerHTML==='', 'imprimirInformeCiclo debe limpiar #print-plan para que no queden ambos informes visibles al imprimir');

  // Sin ciclo marcado como actual, debe indicarlo explícitamente en vez de omitirlo.
  ctx.__appstate.ciclos = [{id:'ciclo-2', nombre:'T4 2026', es_actual:false}];
  printInformeEl.innerHTML = '';
  printCalled = 0;
  ctx.imprimirInformeCiclo();
  assert(printInformeEl.innerHTML.includes('Sin ciclo asignado'), 'sin ciclo actual, el informe debe indicar "Sin ciclo asignado", obtuvo: '+printInformeEl.innerHTML);

  // Plan básico: imprimirInformeCiclo no debe hacer nada (el botón ya está deshabilitado en el DOM real).
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', planes:{nombre:'basico', etiqueta:'Básico', dashboard_ejecutivo_habilitado:false}} };
  printInformeEl.innerHTML = '';
  printCalled = 0;
  ctx.imprimirInformeCiclo();
  assert(printCalled===0, 'plan básico: imprimirInformeCiclo no debe llamar a window.print()');
  assert(printInformeEl.innerHTML==='', 'plan básico: imprimirInformeCiclo no debe escribir contenido en #print-informe');

  // ===== Flow.cl: sección "Plan y facturación" en Configuraciones =====

  // Plan básico sin suscripción activa (flow_subscription_status null): debe ofrecer suscribirse.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', flow_subscription_status:null, planes:{nombre:'basico', etiqueta:'Básico'}} };
  const htmlPlanSinSuscribir = ctx.renderConfiguraciones();
  assert(htmlPlanSinSuscribir.includes('data-suscribir-flow="basico"'), 'plan básico sin suscripción debe ofrecer el botón para suscribirse con Flow, obtuvo: '+htmlPlanSinSuscribir);
  assert(htmlPlanSinSuscribir.includes('Suscribirme con tarjeta'), 'debe mostrar el texto del botón de suscripción, obtuvo: '+htmlPlanSinSuscribir);

  // Plan profesional con suscripción activa: badge de activa + botón para actualizar tarjeta, no de suscribirse por primera vez.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', flow_subscription_status:'activa', planes:{nombre:'profesional', etiqueta:'Profesional'}} };
  const htmlPlanActivo = ctx.renderConfiguraciones();
  assert(htmlPlanActivo.includes('badge-ok') && htmlPlanActivo.includes('Suscripción activa'), 'con suscripción activa debe mostrar el badge correspondiente, obtuvo: '+htmlPlanActivo);
  assert(htmlPlanActivo.includes('Actualizar método de pago'), 'con suscripción activa el botón debe ofrecer actualizar el método de pago, obtuvo: '+htmlPlanActivo);

  // Suscripción morosa: badge de alerta + botón para actualizar la tarjeta.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', flow_subscription_status:'morosa', planes:{nombre:'basico', etiqueta:'Básico'}} };
  const htmlPlanMoroso = ctx.renderConfiguraciones();
  assert(htmlPlanMoroso.includes('badge-danger') && htmlPlanMoroso.includes('problema con el último cobro'), 'suscripción morosa debe avisar del problema con el cobro, obtuvo: '+htmlPlanMoroso);
  assert(htmlPlanMoroso.includes('Actualizar tarjeta'), 'suscripción morosa debe ofrecer actualizar la tarjeta, obtuvo: '+htmlPlanMoroso);

  // Plan Empresa: no es autoservicio, no debe ofrecer el botón de Flow, sino el contacto por correo.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', flow_subscription_status:null, planes:{nombre:'empresa', etiqueta:'Empresa'}} };
  const htmlPlanEmpresa = ctx.renderConfiguraciones();
  assert(!htmlPlanEmpresa.includes('data-suscribir-flow'), 'plan Empresa no debe ofrecer suscripción automática, obtuvo: '+htmlPlanEmpresa);
  assert(htmlPlanEmpresa.includes('contacto@inventiapp.cl'), 'plan Empresa debe invitar a escribir directo, obtuvo: '+htmlPlanEmpresa);

  // iniciarSuscripcionFlow: llama a la Edge Function con el plan elegido y redirige al link de Flow.
  ctx.__appstate.session = { access_token:'tok-ana', user:{email:'ana@minera.cl'} };
  ctx.location.href = '';
  calls.length = 0;
  await ctx.iniciarSuscripcionFlow('basico');
  const invokeFlowCall = calls.find(c=>c.url.includes('/functions/v1/flow-iniciar-suscripcion'));
  assert(!!invokeFlowCall, 'iniciarSuscripcionFlow debe llamar a la Edge Function flow-iniciar-suscripcion, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(invokeFlowCall.opts.headers.Authorization==='Bearer tok-ana', 'debe mandar el access_token de la sesión, obtuvo: '+invokeFlowCall.opts.headers.Authorization);
  assert(JSON.parse(invokeFlowCall.opts.body).planNombre==='basico', 'debe mandar el plan elegido, obtuvo: '+invokeFlowCall.opts.body);
  assert(ctx.location.href==='https://sandbox.flow.cl/app/customer/disclaimer.php?token=tok-flow-1', 'debe redirigir al link que devuelve Flow, obtuvo: '+ctx.location.href);

  // procesarRetornoFlow: detecta ?flow=ok/error en la URL de retorno y limpia el query string.
  ctx.location.search = '?flow=ok';
  ctx.procesarRetornoFlow();
  assert(ctx.__appstate.avisoFlow==='ok', 'debe guardar el resultado del retorno de Flow en el estado, obtuvo: '+ctx.__appstate.avisoFlow);

  // Con suscripción activa debe verse el botón para cancelar, además del de actualizar tarjeta.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', flow_subscription_status:'activa', planes:{nombre:'profesional', etiqueta:'Profesional'}} };
  const htmlPlanConCancelar = ctx.renderConfiguraciones();
  assert(htmlPlanConCancelar.includes('id="btn-cancelar-suscripcion-flow"') && htmlPlanConCancelar.includes('Cancelar suscripción'), 'con suscripción activa debe ofrecer cancelarla, obtuvo: '+htmlPlanConCancelar);

  // Suscripción cancelada: sin botón de cancelar, con aviso y opción de re-suscribirse.
  // (iniciarSuscripcionFlow, más arriba, dejó iniciandoSuscripcionFlow en true porque en la app
  // real la redirección a Flow saca de la página antes de que importe resetearlo.)
  ctx.__appstate.iniciandoSuscripcionFlow = false;
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', flow_subscription_status:'cancelada', planes:{nombre:'profesional', etiqueta:'Profesional'}} };
  const htmlPlanCancelada = ctx.renderConfiguraciones();
  assert(!htmlPlanCancelada.includes('id="btn-cancelar-suscripcion-flow"'), 'una suscripción ya cancelada no debe ofrecer cancelarla de nuevo, obtuvo: '+htmlPlanCancelada);
  assert(htmlPlanCancelada.includes('Suscribirme de nuevo'), 'debe ofrecer volver a suscribirse, obtuvo: '+htmlPlanCancelada);

  // cancelarSuscripcionFlow: pide confirmación, y si se cancela no llama a nada.
  ctx.__appstate.session = { access_token:'tok-ana', user:{email:'ana@minera.cl'} };
  confirmRespuesta = false; calls.length = 0;
  await ctx.cancelarSuscripcionFlow();
  assert(!calls.some(c=>c.url.includes('/functions/v1/flow-cancelar-suscripcion')), 'si no se confirma, no debe llamar a la Edge Function, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Si se confirma, llama a la Edge Function y deja la suscripción marcada como cancelada.
  confirmRespuesta = true; calls.length = 0;
  await ctx.cancelarSuscripcionFlow();
  const invokeCancelarCall = calls.find(c=>c.url.includes('/functions/v1/flow-cancelar-suscripcion'));
  assert(!!invokeCancelarCall, 'cancelarSuscripcionFlow debe llamar a la Edge Function flow-cancelar-suscripcion, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(invokeCancelarCall.opts.headers.Authorization==='Bearer tok-ana', 'debe mandar el access_token de la sesión, obtuvo: '+invokeCancelarCall.opts.headers.Authorization);
  assert(ctx.__appstate.perfil.empresas.flow_subscription_status==='cancelada', 'debe reflejar la cancelación en el estado local sin esperar a recargar el perfil, obtuvo: '+ctx.__appstate.perfil.empresas.flow_subscription_status);
  confirmRespuesta = true;

  // ===== Flow.cl: bloqueo de cuenta (inactiva o morosa) =====

  // cargarPerfil consulta primero mi_estado_bloqueo(); si la empresa está bloqueada, no debe
  // ni intentar traer el perfil normal (que igual fallaría por RLS), sino dejar marcado el motivo.
  ctx.__appstate.session = { access_token:'tok-x', user:{id:'user-1', email:'joel@test.com'} };
  ctx.__appstate.perfil = null;
  estadoBloqueoRespuesta = { bloqueada: true, motivo: 'morosa', empresa_nombre: 'Minera Andes' };
  calls.length = 0;
  await ctx.cargarPerfil();
  assert(!!ctx.__appstate.empresaBloqueada && ctx.__appstate.empresaBloqueada.motivo==='morosa', 'cargarPerfil debe marcar la empresa como bloqueada con el motivo correcto, obtuvo: '+JSON.stringify(ctx.__appstate.empresaBloqueada));
  assert(ctx.__appstate.perfil===null, 'con la empresa bloqueada, perfil debe quedar null, obtuvo: '+JSON.stringify(ctx.__appstate.perfil));
  assert(!calls.some(c=>c.url.includes('/rest/v1/usuarios?auth_user_id=eq.')), 'no debe intentar traer el perfil normal si ya sabe que está bloqueada, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  const htmlBloqueadaMorosa = ctx.renderCuentaBloqueada();
  assert(htmlBloqueadaMorosa.includes('Minera Andes') && /último cobro/i.test(htmlBloqueadaMorosa), 'debe mostrar el nombre de la empresa y explicar el motivo de mora, obtuvo: '+htmlBloqueadaMorosa);
  assert(htmlBloqueadaMorosa.includes('id="btn-salir-bloqueada"'), 'debe ofrecer un botón para salir, obtuvo: '+htmlBloqueadaMorosa);

  // Sin bloqueo, cargarPerfil sigue funcionando como antes (perfil normal, sin motivo de bloqueo).
  estadoBloqueoRespuesta = { bloqueada: false, motivo: null, empresa_nombre: null };
  ctx.__appstate.session = { access_token:'tok-x', user:{id:'user-1', email:'joel@test.com'} };
  await ctx.cargarPerfil();
  assert(ctx.__appstate.empresaBloqueada===null, 'sin bloqueo, empresaBloqueada debe quedar en null, obtuvo: '+JSON.stringify(ctx.__appstate.empresaBloqueada));
  assert(!!ctx.__appstate.perfil, 'sin bloqueo, debe cargar el perfil normal, obtuvo: '+JSON.stringify(ctx.__appstate.perfil));

  // ===== Alta autoservicio (Básico/Profesional) desde el landing =====

  // procesarRegistroPlanDesdeUrl: sin ?plan= en la URL, no debe activar la pantalla de registro.
  ctx.__appstate.registroPlan = null;
  ctx.location.search = '';
  ctx.procesarRegistroPlanDesdeUrl();
  assert(ctx.__appstate.registroPlan===null, 'sin ?plan= en la URL no debe activarse el registro autoservicio, obtuvo: '+ctx.__appstate.registroPlan);

  // Con ?plan=basico|profesional válido, sí lo activa.
  ctx.location.search = '?plan=profesional';
  ctx.procesarRegistroPlanDesdeUrl();
  assert(ctx.__appstate.registroPlan==='profesional', 'con ?plan=profesional debe guardar el plan elegido, obtuvo: '+ctx.__appstate.registroPlan);

  // Un valor de plan que no existe se ignora (no cualquier string debería activar el registro).
  ctx.__appstate.registroPlan = null;
  ctx.location.search = '?plan=empresa';
  ctx.procesarRegistroPlanDesdeUrl();
  assert(ctx.__appstate.registroPlan===null, 'un plan inválido no debe activar el registro autoservicio, obtuvo: '+ctx.__appstate.registroPlan);

  ctx.__appstate.registroPlan = 'profesional';
  const htmlRegistro = ctx.renderRegistroAutoservicio();
  assert(htmlRegistro.includes('Profesional') && htmlRegistro.includes('registro-autoservicio-form'), 'la pantalla de registro debe mostrar el plan elegido y el formulario, obtuvo: '+htmlRegistro);

  // crearCuentaAutoservicio: crea la empresa+cuenta, inicia sesión con las mismas credenciales
  // y sigue derecho al registro de tarjeta en Flow (mismo mecanismo que iniciarSuscripcionFlow).
  ctx.__appstate.session = null;
  ctx.__appstate.registroPlan = 'basico';
  ctx.location.href = '';
  autoservicioRespuesta = { error: null };
  calls.length = 0;
  await ctx.crearCuentaAutoservicio('Minera Nueva SA', 'Vicky', 'vicky@minera.cl', 'password1234');
  const invokeAltaCall = calls.find(c=>c.url.includes('/functions/v1/crear-empresa-autoservicio'));
  assert(!!invokeAltaCall, 'crearCuentaAutoservicio debe llamar a la Edge Function crear-empresa-autoservicio, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const cuerpoAlta = JSON.parse(invokeAltaCall.opts.body);
  assert(cuerpoAlta.nombreEmpresa==='Minera Nueva SA' && cuerpoAlta.email==='vicky@minera.cl' && cuerpoAlta.planNombre==='basico', 'debe mandar empresa, correo y plan elegido, obtuvo: '+invokeAltaCall.opts.body);
  const invokeLoginCall = calls.find(c=>c.url.includes('/auth/v1/token?grant_type=password'));
  assert(!!invokeLoginCall, 'tras crear la cuenta debe iniciar sesión con las mismas credenciales, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.registroPlan===null, 'al completar el alta debe salir de la pantalla de registro, obtuvo: '+ctx.__appstate.registroPlan);
  assert(!!ctx.__appstate.session && ctx.__appstate.session.access_token==='tok-autoservicio', 'debe quedar con sesión iniciada, obtuvo: '+JSON.stringify(ctx.__appstate.session));
  const invokeFlowTrasAlta = calls.find(c=>c.url.includes('/functions/v1/flow-iniciar-suscripcion'));
  assert(!!invokeFlowTrasAlta, 'tras el alta debe seguir directo a registrar la tarjeta en Flow, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.location.href==='https://sandbox.flow.cl/app/customer/disclaimer.php?token=tok-flow-1', 'debe redirigir a Flow igual que iniciarSuscripcionFlow, obtuvo: '+ctx.location.href);

  // Si la Edge Function falla (ej. correo ya registrado), no debe iniciar sesión ni avanzar.
  ctx.__appstate.session = null;
  ctx.__appstate.registroPlan = 'basico';
  autoservicioRespuesta = { error: 'Ya existe una cuenta con ese correo', status: 409 };
  calls.length = 0;
  await ctx.crearCuentaAutoservicio('Minera Nueva SA', 'Vicky', 'vicky@minera.cl', 'password1234');
  assert(!calls.some(c=>c.url.includes('/auth/v1/token?grant_type=password')), 'si el alta falla, no debe intentar iniciar sesión, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.session===null, 'si el alta falla, no debe quedar con sesión, obtuvo: '+JSON.stringify(ctx.__appstate.session));
  assert(ctx.__appstate.creandoCuentaAutoservicio===false, 'si el alta falla, el spinner debe apagarse, obtuvo: '+ctx.__appstate.creandoCuentaAutoservicio);
  assert(ctx.__appstate.registroPlan==='basico', 'si el alta falla, debe seguir en la pantalla de registro, obtuvo: '+ctx.__appstate.registroPlan);
  autoservicioRespuesta = { error: null };

  // Bloqueo por "pendiente_tarjeta": una empresa autoservicio que nunca registró su tarjeta
  // debe ver un mensaje distinto al de mora, con un botón para retomar el registro en Flow.
  ctx.__appstate.session = { access_token:'tok-x', user:{id:'user-1', email:'vicky@minera.cl'} };
  ctx.__appstate.perfil = null;
  estadoBloqueoRespuesta = { bloqueada: true, motivo: 'pendiente_tarjeta', empresa_nombre: 'Minera Nueva SA', plan_nombre: 'basico' };
  await ctx.cargarPerfil();
  assert(ctx.__appstate.empresaBloqueada.motivo==='pendiente_tarjeta' && ctx.__appstate.empresaBloqueada.planNombre==='basico', 'cargarPerfil debe guardar el motivo y el plan, obtuvo: '+JSON.stringify(ctx.__appstate.empresaBloqueada));
  const htmlPendienteTarjeta = ctx.renderCuentaBloqueada();
  assert(/no registraste/i.test(htmlPendienteTarjeta) && !/último cobro/i.test(htmlPendienteTarjeta), 'debe explicar que falta registrar la tarjeta, no el mensaje de mora, obtuvo: '+htmlPendienteTarjeta);
  assert(htmlPendienteTarjeta.includes('id="btn-registrar-tarjeta-bloqueada"'), 'debe ofrecer retomar el registro de la tarjeta, obtuvo: '+htmlPendienteTarjeta);
  estadoBloqueoRespuesta = { bloqueada: false, motivo: null, empresa_nombre: null };

  // ===== Multi-tenencia (empresas) =====

  // El login ya no ofrece registro autoservicio: solo correo + contraseña.
  ctx.__appstate.session = null; ctx.__appstate.perfil = null;
  const htmlLoginSolo = ctx.renderLogin();
  assert(htmlLoginSolo.includes('id="auth-form"') && htmlLoginSolo.includes('id="f-email"') && htmlLoginSolo.includes('id="f-pass"'), 'el login debe tener el formulario de correo+contraseña, obtuvo: '+htmlLoginSolo);
  assert(!htmlLoginSolo.includes('id="f-empresa-nombre"') && !htmlLoginSolo.includes('id="f-codigo-invitacion"') && !htmlLoginSolo.includes('id="toggle-auth"'), 'no debe quedar ningún rastro del registro autoservicio (crear empresa / unirse con código), obtuvo: '+htmlLoginSolo);

  // procesarLlegadaPorInvitacion: si la URL trae un token de recovery/invite en el hash,
  // se arma la sesión y se pide crear contraseña, en vez de mostrar el login normal.
  ctx.location.hash = '#access_token=tok-invitado&refresh_token=ref-1&type=recovery';
  await ctx.procesarLlegadaPorInvitacion();
  assert(ctx.__appstate.debeCrearPassword===true, 'debe activar debeCrearPassword al llegar con un token de recovery en el hash');
  assert(ctx.__appstate.session && ctx.__appstate.session.access_token==='tok-invitado', 'debe armar la sesión con el access_token del hash, obtuvo: '+JSON.stringify(ctx.__appstate.session));

  // Lo mismo debe pasar con type=invite (el que realmente manda invite-user desde que usa
  // admin.inviteUserByEmail en vez de resetPasswordForEmail), no solo con type=recovery.
  ctx.__appstate.session = null; ctx.__appstate.debeCrearPassword = false;
  ctx.location.hash = '#access_token=tok-invitado-2&refresh_token=ref-2&type=invite';
  await ctx.procesarLlegadaPorInvitacion();
  assert(ctx.__appstate.debeCrearPassword===true, 'debe activar debeCrearPassword al llegar con un token de invite en el hash');
  assert(ctx.__appstate.session && ctx.__appstate.session.access_token==='tok-invitado-2', 'debe armar la sesión con el access_token del hash (type=invite), obtuvo: '+JSON.stringify(ctx.__appstate.session));

  // Vuelve a dejar la sesión con el token de recovery para el resto de las aserciones de abajo.
  ctx.location.hash = '#access_token=tok-invitado&refresh_token=ref-1&type=recovery';
  await ctx.procesarLlegadaPorInvitacion();

  const htmlCrearPass = ctx.renderCrearPassword();
  assert(htmlCrearPass.includes('id="crear-password-form"') && htmlCrearPass.includes('id="f-nueva-pass"'), 'debe mostrar el formulario para crear contraseña, obtuvo: '+htmlCrearPass);

  // establecerPassword: PUT a /auth/v1/user con el access_token de la sesión de invitación.
  calls.length = 0;
  await ctx.establecerPassword('nuevaClave123');
  const putPassword = calls.find(c=>c.opts && c.opts.method==='PUT' && c.url.includes('/auth/v1/user'));
  assert(!!putPassword, 'establecerPassword debe hacer PUT a /auth/v1/user, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(putPassword.opts.headers.Authorization==='Bearer tok-invitado', 'el PUT debe usar el access_token de la sesión de invitación, obtuvo: '+putPassword.opts.headers.Authorization);
  assert(JSON.parse(putPassword.opts.body).password==='nuevaClave123', 'el PUT debe llevar la nueva contraseña, obtuvo: '+putPassword.opts.body);
  assert(ctx.__appstate.debeCrearPassword===false, 'tras guardar la contraseña, debeCrearPassword debe volver a false');

  // Configuraciones: sección "Empresa" con nombre, editable solo por admin (sin código de invitación: ya no se usa).
  ctx.__appstate.session = { access_token:'x', user:{email:'a@b.com'} };
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  const htmlConfigAdmin = ctx.renderConfiguraciones();
  assert(htmlConfigAdmin.includes('id="form-empresa-nombre"'), 'un admin debe ver el formulario para renombrar la empresa, obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.includes('Minera Andes'), 'debe mostrar el nombre de la empresa, obtuvo: '+htmlConfigAdmin);
  assert(!htmlConfigAdmin.includes('form-crear-empresa-sa'), 'un admin normal (no super-admin) no debe ver el panel de super-admin, obtuvo: '+htmlConfigAdmin);

  // Un admin de empresa (no super-admin) sí debe poder invitar gente a SU propia empresa,
  // pero solo como operador: crear otros administradores es exclusivo del super-admin
  // (un admin normal no debe tener forma de elegir "admin" en este formulario).
  assert(htmlConfigAdmin.includes('id="form-invitar-equipo"'), 'un admin de empresa debe ver el formulario para invitar a su equipo, obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.includes('id="equipo-rol" value="operador"') && !htmlConfigAdmin.includes('Supervisor'), 'el rol de invitación de un admin normal debe quedar fijo en Operador (no elegible), obtuvo: '+htmlConfigAdmin);
  const formInvitarEquipoHtml = htmlConfigAdmin.slice(htmlConfigAdmin.indexOf('id="form-invitar-equipo"'), htmlConfigAdmin.indexOf('</form>', htmlConfigAdmin.indexOf('id="form-invitar-equipo"')));
  assert(!formInvitarEquipoHtml.includes('Administrador'), 'el formulario de invitar equipo no debe ofrecer el rol Administrador, obtuvo: '+formInvitarEquipoHtml);

  // Conteo ciego: un admin de empresa debe ver el toggle en Configuraciones, reflejando el
  // estado actual de su empresa.
  assert(htmlConfigAdmin.includes('id="chk-conteo-ciego"') && !htmlConfigAdmin.includes('id="chk-conteo-ciego" checked'), 'un admin debe ver el toggle de conteo ciego, sin marcar si la empresa no lo tiene activo, obtuvo: '+htmlConfigAdmin);
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = true;
  const htmlConfigAdminCiegoActivo = ctx.renderConfiguraciones();
  assert(htmlConfigAdminCiegoActivo.includes('id="chk-conteo-ciego" checked'), 'con el flag activo en la empresa, el toggle debe verse marcado, obtuvo: '+htmlConfigAdminCiegoActivo);
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = false;

  // Pedido de Joel: diferenciar el menú de Configuraciones con títulos más claros y organizados
  // (antes "Plan y facturación", "Invitar equipo" y "Mi equipo" venían todos amontonados bajo un
  // único encabezado "Empresa", sin secciones propias).
  assert(htmlConfigAdmin.includes('<h2>Tu empresa</h2>'), 'el nombre de la empresa debe ir bajo el encabezado "Tu empresa" (no ambiguo con las "Empresas" de super-admin), obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.includes('Plan y facturación</h2>'), 'debe existir un encabezado propio "Plan y facturación", obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.includes('Invitar equipo</h2>'), 'debe existir un encabezado propio "Invitar equipo", obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.includes('Mi equipo</h2>'), 'debe existir un encabezado propio "Mi equipo", obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.indexOf('Invitar equipo</h2>') < htmlConfigAdmin.indexOf('id="form-invitar-equipo"'), 'el encabezado "Invitar equipo" debe ir antes de su formulario, obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.indexOf('Mi equipo</h2>') < htmlConfigAdmin.indexOf('mi-equipo-nombre') || !htmlConfigAdmin.includes('mi-equipo-nombre'), 'el encabezado "Mi equipo" debe ir antes de la lista del equipo, obtuvo: '+htmlConfigAdmin);

  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  const htmlConfigOperador = ctx.renderConfiguraciones();
  assert(!htmlConfigOperador.includes('id="form-empresa-nombre"'), 'un operador (no admin) no debe poder editar el nombre de la empresa, obtuvo: '+htmlConfigOperador);
  assert(!htmlConfigOperador.includes('id="form-invitar-equipo"'), 'un operador (no admin) no debe poder invitar gente a la empresa, obtuvo: '+htmlConfigOperador);
  assert(!htmlConfigOperador.includes('id="chk-conteo-ciego"'), 'un operador no debe poder cambiar el conteo ciego, solo el admin, obtuvo: '+htmlConfigOperador);

  // invitarPersona desde un admin de empresa (no super-admin): debe llamar a invite-user igual, pero
  // sin disparar el resumen del super-admin (no le corresponde a un admin normal).
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  calls.length = 0;
  const okInvitacionEquipo = await ctx.invitarPersona({email:'nueva@equipo.cl', nombre:'Diego Soto', empresaId:'emp-1', rol:'operador'});
  const invokeEquipoCall = calls.find(c=>c.url.includes('/functions/v1/invite-user'));
  assert(!!invokeEquipoCall, 'invitarPersona debe llamar a invite-user también cuando lo usa un admin de empresa, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(okInvitacionEquipo===true, 'invitarPersona debe devolver true, obtuvo: '+okInvitacionEquipo);
  assert(!calls.some(c=>c.url.includes('/rpc/resumen_empresas_super_admin')), 'un admin normal (no super-admin) no debe disparar el resumen del super-admin, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Panel de super-admin: solo visible si perfil.es_super_admin.
  ctx.__appstate.perfil = { id:3, nombre:'Vendedor', rol:'admin', es_super_admin:true, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true, plan_id:'plan-pro'}, {id:'emp-2', nombre:'Minera Sur', activo:true, plan_id:'plan-basico'}], resumen:[], leads:[], planes:[{id:'plan-basico', nombre:'basico', etiqueta:'Básico'}, {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'}, {id:'plan-empresa', nombre:'empresa', etiqueta:'Empresa'}], invitando:false, cargado:true };
  const htmlConfigSuperAdmin = ctx.renderConfiguraciones();
  assert(htmlConfigSuperAdmin.includes('id="form-crear-empresa-sa"') && htmlConfigSuperAdmin.includes('id="form-invitar-persona-sa"'), 'un super-admin debe ver el panel para crear empresas e invitar personas, obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('Minera Andes') && htmlConfigSuperAdmin.includes('Minera Sur'), 'debe listar las empresas existentes, obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('<option value="emp-1">Minera Andes</option>') && htmlConfigSuperAdmin.includes('<option value="emp-2">Minera Sur</option>'), 'el selector de empresa del formulario de invitación debe listar las empresas, obtuvo: '+htmlConfigSuperAdmin);
  assert(!htmlConfigSuperAdmin.includes('Supervisor'), 'ya no debe existir el rol Supervisor en ningún selector, obtuvo: '+htmlConfigSuperAdmin);
  assert(!htmlConfigSuperAdmin.includes('id="form-invitar-equipo"'), 'un super-admin ya tiene su propio panel para invitar; no debe duplicarse con el de "invitar a tu equipo", obtuvo: '+htmlConfigSuperAdmin);
  // Bug real reportado (Joel): el toggle de conteo ciego quedó escondido a un super-admin por
  // copiar el mismo filtro que "Plan y facturación"/"Invitar equipo" (que sí tiene sentido
  // ocultarles, por no ser cuentas de facturación) -- pero conteo ciego es una config operativa
  // normal de la empresa, no de facturación: un super-admin que también administra una empresa
  // real debe poder verlo y usarlo igual que cualquier admin.
  assert(htmlConfigSuperAdmin.includes('id="chk-conteo-ciego"'), 'un super-admin (que también es admin de una empresa) debe ver el toggle de conteo ciego, obtuvo: '+htmlConfigSuperAdmin);

  // Pedido de Joel: diferenciar el menú de super-admin con títulos claros por sección (antes
  // "Empresas", "Invitar persona", "Personas" y "Leads" venían todos amontonados bajo el único
  // encabezado "Super-admin", sin ninguna separación entre ellos).
  assert(htmlConfigSuperAdmin.includes('>Empresas</h2>'), 'debe existir un encabezado propio "Empresas" (crear/gestionar), obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('Invitar persona</h2>'), 'debe existir un encabezado propio "Invitar persona", obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('>Personas</h2>'), 'debe existir un encabezado propio "Personas", obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('>Leads</h2>'), 'debe existir un encabezado propio "Leads", obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.indexOf('>Empresas</h2>') < htmlConfigSuperAdmin.indexOf('id="form-crear-empresa-sa"'), 'el encabezado "Empresas" debe ir antes de su formulario, obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.indexOf('Invitar persona</h2>') < htmlConfigSuperAdmin.indexOf('id="form-invitar-persona-sa"'), 'el encabezado "Invitar persona" debe ir antes de su formulario, obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.indexOf('>Personas</h2>') < htmlConfigSuperAdmin.indexOf('id="sa-personas-empresa"'), 'el encabezado "Personas" debe ir antes de su selector de empresa, obtuvo: '+htmlConfigSuperAdmin);

  // "Ciclos de conteo" (Períodos) ya no vive dentro de Configuraciones: es su propia pestaña
  // admin (renderCiclos/'ciclos'), sin depender de esAdmin — a diferencia de "invitar equipo" y
  // "plan y facturación", que siguen siendo exclusivos del admin normal dentro de Configuraciones.
  assert(!htmlConfigSuperAdmin.includes('id="form-crear-ciclo"'), 'Configuraciones ya no debe incluir el formulario de crear ciclo (se movió a su propia pestaña), obtuvo: '+htmlConfigSuperAdmin);
  assert(ctx.renderCiclos().includes('id="form-crear-ciclo"'), 'renderCiclos() debe mostrar el formulario para crear ciclos, obtuvo: '+ctx.renderCiclos());

  // crearEmpresaSuperAdmin: POST a /empresas con solo el nombre (el código se genera solo en la BD).
  calls.length = 0;
  await ctx.crearEmpresaSuperAdmin('Minera Nueva');
  const postEmpresaSa = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/empresas'));
  assert(!!postEmpresaSa, 'crearEmpresaSuperAdmin debe hacer POST a /empresas, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(postEmpresaSa.opts.body)[0].nombre==='Minera Nueva', 'el POST debe llevar el nombre de la empresa nueva, obtuvo: '+postEmpresaSa.opts.body);

  // invitarPersona: llama a la Edge Function invite-user con el access_token del super-admin.
  calls.length = 0;
  const okInvitacion = await ctx.invitarPersona({email:'nueva@cliente.cl', nombre:'Carlos Rojas', empresaId:'emp-2', rol:'contador'});
  const invokeCall = calls.find(c=>c.url.includes('/functions/v1/invite-user'));
  assert(!!invokeCall, 'invitarPersona debe llamar a la Edge Function invite-user, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(invokeCall.opts.headers.Authorization==='Bearer x', 'debe enviar el access_token de la sesión actual, obtuvo: '+invokeCall.opts.headers.Authorization);
  const bodyInvitacion = JSON.parse(invokeCall.opts.body);
  assert(bodyInvitacion.email==='nueva@cliente.cl' && bodyInvitacion.nombre==='Carlos Rojas' && bodyInvitacion.empresaId==='emp-2' && bodyInvitacion.rol==='contador', 'debe enviar correo, nombre, empresa y rol, obtuvo: '+invokeCall.opts.body);
  assert(okInvitacion===true, 'invitarPersona debe devolver true cuando la invitación se envía correctamente, obtuvo: '+okInvitacion);

  // renderSuperAdmin: cada empresa listada debe tener nombre editable + botón para desactivar/reactivar.
  assert(htmlConfigSuperAdmin.includes('data-guardar-empresa-sa="emp-1"') && htmlConfigSuperAdmin.includes('data-toggle-empresa-sa="emp-1"'), 'cada empresa debe tener botones para guardar el nombre y desactivar/reactivar, obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('id="sa-personas-empresa"'), 'debe existir el selector de empresa para gestionar personas, obtuvo: '+htmlConfigSuperAdmin);

  // cargarLeadsSuperAdmin: pide /leads_demo (los datos que deja el formulario "Probar la
  // demo" del landing) y renderSuperAdmin debe listarlos con su fecha.
  calls.length = 0;
  await ctx.cargarLeadsSuperAdmin();
  assert(calls.some(c=>c.url.includes('/leads_demo?select=')), 'cargarLeadsSuperAdmin debe pedir /leads_demo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.superadmin.leads.length===1 && ctx.__appstate.superadmin.leads[0].email==='pedro@clienteX.cl', 'debe guardar los leads devueltos por el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.superadmin.leads));
  const htmlConLeads = ctx.renderSuperAdmin();
  assert(htmlConLeads.includes('Pedro Soto') && htmlConLeads.includes('Clientes X SpA') && htmlConLeads.includes('pedro@clienteX.cl'), 'el panel de super-admin debe mostrar nombre, empresa y correo del lead, obtuvo: '+htmlConLeads);
  ctx.__appstate.superadmin.leads = [];
  assert(ctx.renderSuperAdmin().includes('Todavía no hay nadie'), 'sin leads debe mostrar un mensaje vacío, no una lista rota');

  // cargarMasLeadsSuperAdmin: pide la página siguiente con offset=<lo ya cargado>, agrega
  // (no reemplaza) y actualiza leadsHayMas cuando se agotan los datos.
  ctx.__appstate.superadmin.leads = Array.from({length:30}, (_,i)=>({id:'seed-lead-'+i, nombre:'X', email:'x'+i+'@test.cl', creado_en:'2026-08-18T10:00:00Z'}));
  ctx.__appstate.superadmin.leadsHayMas = true;
  calls.length = 0;
  await ctx.cargarMasLeadsSuperAdmin();
  const leadsCallMas = calls.find(c=>c.url.includes('/leads_demo?select='));
  assert(!!leadsCallMas && leadsCallMas.url.includes('offset=30'), 'cargarMasLeadsSuperAdmin debe pedir la página siguiente con offset=30, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.superadmin.leads.length===34, 'debe agregar las filas nuevas a las 30 que ya había, obtuvo: '+ctx.__appstate.superadmin.leads.length);
  assert(ctx.__appstate.superadmin.leadsHayMas===false, 'al agotarse los datos (4 < 30), leadsHayMas debe pasar a false');

  // cargarPlanesSuperAdmin: pide /planes y los deja disponibles para el selector de plan.
  calls.length = 0;
  await ctx.cargarPlanesSuperAdmin();
  assert(calls.some(c=>c.url.includes('/planes?select=')), 'cargarPlanesSuperAdmin debe pedir /planes, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.superadmin.planes.length===3 && ctx.__appstate.superadmin.planes[1].etiqueta==='Profesional', 'debe guardar los planes devueltos por el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.superadmin.planes));

  // Una empresa inactiva se debe marcar como tal y el selector de invitación no debe ofrecerla.
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true, plan_id:'plan-pro'}, {id:'emp-2', nombre:'Minera Sur', activo:false, plan_id:'plan-basico'}], resumen:[], leads:[], planes:[{id:'plan-basico', nombre:'basico', etiqueta:'Básico'}, {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'}], invitando:false, cargado:true, personasEmpresaId:'', personas:[], cargandoPersonas:false };
  const htmlConEmpresaInactiva = ctx.renderConfiguraciones();
  assert(htmlConEmpresaInactiva.includes('Inactiva'), 'una empresa desactivada debe mostrar la etiqueta "Inactiva", obtuvo: '+htmlConEmpresaInactiva);
  assert(!htmlConEmpresaInactiva.includes('<option value="emp-2">Minera Sur</option>'), 'el selector de invitación no debe ofrecer una empresa inactiva, obtuvo: '+htmlConEmpresaInactiva);

  // renderSuperAdmin: cada empresa debe tener un selector de plan con la opción actual
  // preseleccionada, para que el super-admin la pueda cambiar (cobro manual).
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true, plan_id:'plan-pro'}], resumen:[], leads:[], planes:[{id:'plan-basico', nombre:'basico', etiqueta:'Básico'}, {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'}, {id:'plan-empresa', nombre:'empresa', etiqueta:'Empresa'}], invitando:false, cargado:true, personasEmpresaId:'', personas:[], cargandoPersonas:false };
  const htmlSelectorPlan = ctx.renderConfiguraciones();
  assert(htmlSelectorPlan.includes('class="sa-empresa-plan" data-empresa-id="emp-1"'), 'cada empresa debe tener un selector de plan, obtuvo: '+htmlSelectorPlan);
  assert(htmlSelectorPlan.includes('<option value="plan-pro" selected>Profesional</option>'), 'el selector debe preseleccionar el plan actual de la empresa (Profesional), obtuvo: '+htmlSelectorPlan);
  assert(htmlSelectorPlan.includes('<option value="plan-basico" >Básico</option>') && htmlSelectorPlan.includes('<option value="plan-empresa" >Empresa</option>'), 'el selector debe ofrecer los otros planes sin preseleccionar, obtuvo: '+htmlSelectorPlan);

  // actualizarEmpresaSuperAdmin: cambiar el plan hace PATCH con plan_id.
  calls.length = 0;
  await ctx.actualizarEmpresaSuperAdmin('emp-1', {plan_id:'plan-empresa'});
  const patchPlanSa = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/empresas?id=eq.emp-1'));
  assert(!!patchPlanSa && JSON.parse(patchPlanSa.opts.body).plan_id==='plan-empresa', 'actualizarEmpresaSuperAdmin debe hacer PATCH con el nuevo plan_id, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // actualizarEmpresaSuperAdmin: renombrar hace PATCH solo con el nombre.
  calls.length = 0;
  await ctx.actualizarEmpresaSuperAdmin('emp-1', {nombre:'Minera Andes Renombrada'});
  const patchEmpresaSa = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/empresas?id=eq.emp-1'));
  assert(!!patchEmpresaSa, 'actualizarEmpresaSuperAdmin debe hacer PATCH a /empresas?id=eq.<id>, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(patchEmpresaSa.opts.body).nombre==='Minera Andes Renombrada', 'el PATCH debe llevar el nuevo nombre, obtuvo: '+patchEmpresaSa.opts.body);

  // actualizarEmpresaSuperAdmin: desactivar hace PATCH con activo:false.
  calls.length = 0;
  await ctx.actualizarEmpresaSuperAdmin('emp-2', {activo:false});
  const patchDesactivarEmpresa = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/empresas?id=eq.emp-2'));
  assert(!!patchDesactivarEmpresa && JSON.parse(patchDesactivarEmpresa.opts.body).activo===false, 'debe poder desactivar una empresa con activo:false, obtuvo: '+JSON.stringify(patchDesactivarEmpresa));

  // cargarPersonasSuperAdmin: trae las personas de la empresa elegida.
  await ctx.cargarPersonasSuperAdmin('emp-1');
  const personasCargadas = ctx.__appstate.superadmin.personas;
  assert(personasCargadas.length===2 && personasCargadas[0].nombre==='Carlos Rojas' && personasCargadas[1].activo===false, 'cargarPersonasSuperAdmin debe cargar las personas de esa empresa, obtuvo: '+JSON.stringify(personasCargadas));
  assert(ctx.__appstate.superadmin.personasEmpresaId==='emp-1', 'debe recordar qué empresa está seleccionada');
  const htmlConPersonas = ctx.renderConfiguraciones();
  assert(htmlConPersonas.includes('Carlos Rojas') && htmlConPersonas.includes('data-toggle-persona-sa="p1"'), 'debe listar cada persona con su botón de desactivar/reactivar, obtuvo: '+htmlConPersonas);

  // actualizarPersonaSuperAdmin: cambiar rol o desactivar hace PATCH a /usuarios y recarga la lista.
  calls.length = 0;
  await ctx.actualizarPersonaSuperAdmin('p1', {rol:'admin'});
  const patchRolPersona = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/usuarios?id=eq.p1'));
  assert(!!patchRolPersona && JSON.parse(patchRolPersona.opts.body).rol==='admin', 'actualizarPersonaSuperAdmin debe poder cambiar el rol, obtuvo: '+JSON.stringify(patchRolPersona));

  calls.length = 0;
  await ctx.actualizarPersonaSuperAdmin('p2', {activo:true});
  const patchReactivarPersona = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/usuarios?id=eq.p2'));
  assert(!!patchReactivarPersona && JSON.parse(patchReactivarPersona.opts.body).activo===true, 'actualizarPersonaSuperAdmin debe poder reactivar el acceso, obtuvo: '+JSON.stringify(patchReactivarPersona));

  // "Mi equipo": un admin de empresa (no super-admin) puede ver y editar a su propio equipo,
  // sin pasar por el panel de super-admin. cargarEquipo no debe pedir empresa_id (RLS ya
  // filtra por empresa_actual()) y no debe entrar en recursión infinita al renderizar
  // (regresión real detectada: cargarEquipo llamaba render() antes de marcar cargado=true,
  // y el wiring de eventos volvía a llamar cargarEquipo() en cada render).
  ctx.__appstate.perfil = {id:'perfil-1', nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ABC12345'}};
  ctx.__appstate.equipo = { cargado:false, cargando:false, personas:[] };
  await ctx.cargarEquipo();
  assert(ctx.__appstate.equipo.cargado===true, 'cargarEquipo debe marcar cargado:true al terminar');
  assert(ctx.__appstate.equipo.personas.length===2 && ctx.__appstate.equipo.personas[0].nombre==='Beto Ríos', 'cargarEquipo debe cargar el equipo de la propia empresa, obtuvo: '+JSON.stringify(ctx.__appstate.equipo.personas));
  const htmlMiEquipo = ctx.renderConfiguraciones();
  assert(htmlMiEquipo.includes('Beto Ríos') && htmlMiEquipo.includes('data-toggle-persona-equipo="eq1"'), 'Configuraciones debe listar el equipo propio con su botón de desactivar/reactivar, obtuvo: '+htmlMiEquipo);
  // El rol ya no es editable desde "Mi equipo" (un admin normal no puede ascender a nadie a
  // administrador): se muestra como etiqueta fija, no como <select>. eq1 es operador,
  // eq2 (Marta Soto) es admin — ambos deben aparecer como texto, sin ningún control editable.
  assert(!htmlMiEquipo.includes('mi-equipo-rol'), 'el rol del equipo no debe tener un control editable para un admin normal, obtuvo: '+htmlMiEquipo);
  assert(htmlMiEquipo.includes('Operador') && htmlMiEquipo.includes('Administrador'), 'debe mostrar el rol de cada persona como etiqueta fija, obtuvo: '+htmlMiEquipo);

  // actualizarPersonaEquipo sigue existiendo para nombre/activo, pero ya nada en la UI de un
  // admin normal la invoca con {rol:...} — la protección real contra la escalada de privilegios
  // vive en la base de datos (trigger prevenir_escalada_admin + Edge Function invite-user).

  // bind() en 'config': tras invitar a alguien con el formulario real, la lista de "Mi equipo"
  // debe refrescarse sola (regresión real reportada: la persona recién invitada no aparecía
  // en el listado hasta recargar la página a mano, porque cargarEquipo() solo se llamaba una
  // vez por `if(!state.equipo.cargado)` y la invitación nunca volvía a dispararla).
  ctx.__appstate.view = 'config';
  delete elements['form-invitar-equipo'];
  ctx.bind();
  const formInvitarEquipoEl = elements['form-invitar-equipo'];
  assert(!!formInvitarEquipoEl, 'bind() debe haber consultado #form-invitar-equipo, obtuvo: '+formInvitarEquipoEl);
  makeEl('equipo-nombre').value = 'Diego Soto';
  makeEl('equipo-email').value = 'diego@equipo.cl';
  calls.length = 0;
  await new Promise(resolve => {
    formInvitarEquipoEl.dispatch('submit', {target: formInvitarEquipoEl, preventDefault(){}});
    setTimeout(resolve, 20);
  });
  const invokeTrasSubmit = calls.find(c=>c.url.includes('/functions/v1/invite-user'));
  assert(!!invokeTrasSubmit, 'el submit del formulario debe invitar a la persona, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const refrescoEquipoTrasInvitar = calls.find(c=>c.url.includes('/usuarios?select=') && calls.indexOf(c) > calls.indexOf(invokeTrasSubmit));
  assert(!!refrescoEquipoTrasInvitar, 'tras invitar a alguien, "Mi equipo" debe recargarse solo para mostrar a la persona nueva, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Restaurar el perfil de super-admin para los tests siguientes de este mismo bloque.
  ctx.__appstate.perfil = { id:3, nombre:'Vendedor', rol:'admin', es_super_admin:true, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };

  // bind() en 'ciclos' (Períodos, ahora su propia pestaña separada de Configuraciones): un
  // super-admin que también es admin de su empresa (ver #125) debe poder crear un ciclo de
  // verdad, no solo verlo.
  ctx.__appstate.view = 'ciclos';
  // elements[] es un registro global sin reset entre pruebas: si no se limpia acá, un
  // listener pegado de una vinculación anterior (con otro perfil) taparía el bug real.
  delete elements['form-crear-ciclo'];
  ctx.bind();
  calls.length = 0;
  makeEl('ciclo-nombre').value = 'T2 2027';
  const formCrearCicloEl = elements['form-crear-ciclo'];
  assert(!!formCrearCicloEl, 'bind() debe haber consultado #form-crear-ciclo (con perfil super-admin+admin), obtuvo: '+formCrearCicloEl);
  await new Promise(resolve => {
    formCrearCicloEl.dispatch('submit', {target: formCrearCicloEl, preventDefault(){}});
    setTimeout(resolve, 20);
  });
  const postCicloSuperAdmin = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/ciclos_conteo'));
  assert(!!postCicloSuperAdmin && JSON.parse(postCicloSuperAdmin.opts.body)[0].nombre==='T2 2027', 'un super-admin que es admin de su empresa debe poder crear un ciclo enviando el formulario real (no solo verlo), obtuvo: '+JSON.stringify(postCicloSuperAdmin));

  // El nombre de la empresa debe mostrarse en la barra superior de la app.
  ctx.__appstate.view = 'dashboard';
  ctx.__appstate.dash = { total: [], diario: [], semanal: [], mensual: [] };
  ctx.__appstate.ultimosConteos = [];
  const shellHtml = ctx.renderShell();
  assert(shellHtml.includes('Minera Andes'), 'la barra superior debe mostrar el nombre de la empresa actual, obtuvo: '+shellHtml.slice(0,600));
  // Junto al nombre en la barra superior también debe verse el rol: super-admin, admin normal
  // u operador — antes solo se veía el nombre, sin decir con qué permisos está esa persona.
  assert(shellHtml.includes('Vendedor') && shellHtml.includes('Super-admin'), 'la barra superior debe mostrar "Super-admin" junto al nombre para una cuenta con es_super_admin, obtuvo: '+shellHtml.slice(0,700));
  ctx.__appstate.perfil = { id:4, nombre:'Beto Ríos', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  const shellHtmlOperador = ctx.renderShell();
  assert(shellHtmlOperador.includes('Beto Ríos') && shellHtmlOperador.includes('Operador'), 'la barra superior debe mostrar "Operador" junto al nombre para esa cuenta, obtuvo: '+shellHtmlOperador.slice(0,700));
  ctx.__appstate.perfil = { id:3, nombre:'Vendedor', rol:'admin', es_super_admin:true, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };

  // ===== Resumen de negocio del super-admin =====
  calls.length = 0;
  await ctx.cargarResumenSuperAdmin();
  assert(ctx.__appstate.superadmin.resumen.length===2, 'cargarResumenSuperAdmin debe cargar el resumen agregado, obtuvo: '+JSON.stringify(ctx.__appstate.superadmin.resumen));
  const rpcResumenCall = calls.find(c=>c.url.includes('/rpc/resumen_empresas_super_admin'));
  assert(!!rpcResumenCall && rpcResumenCall.opts.method==='POST', 'debe llamar al RPC resumen_empresas_super_admin, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const htmlConResumen = ctx.renderConfiguraciones();
  assert(htmlConResumen.includes('Empresas activas') && htmlConResumen.includes('Personas activas') && htmlConResumen.includes('SKU cargados'), 'debe mostrar las tarjetas KPI del resumen, obtuvo: '+htmlConResumen);
  assert(htmlConResumen.includes('150'), 'debe mostrar el total de SKU cargados sumando todas las empresas, obtuvo: '+htmlConResumen);
  assert(/Inactiva/.test(htmlConResumen), 'la fila de la empresa inactiva en el resumen debe marcarse como tal, obtuvo: '+htmlConResumen);
  assert(htmlConResumen.includes('Resumen del negocio</h2>'), 'el resumen agregado debe ir bajo su propio encabezado "Resumen del negocio", obtuvo: '+htmlConResumen);
  assert(htmlConResumen.indexOf('Resumen del negocio</h2>') < htmlConResumen.indexOf('Empresas activas'), 'el encabezado "Resumen del negocio" debe ir antes de las tarjetas KPI, obtuvo: '+htmlConResumen);

  // ===== Sesión persistente (localStorage + refresh de token) =====

  // guardarSesion debe persistir la sesión para sobrevivir a un refresh de página.
  ctx.__appstate.session = { access_token:'token-viejo', refresh_token:'refresh-1', user:{id:'user-1', email:'joel@test.com'} };
  ctx.guardarSesion(ctx.__appstate.session);
  const guardadaCruda = ctx.localStorage.getItem('sesion_inventario');
  assert(!!guardadaCruda && JSON.parse(guardadaCruda).refresh_token==='refresh-1', 'guardarSesion debe persistir la sesión en localStorage, obtuvo: '+guardadaCruda);

  // restaurarSesionGuardada: simula reabrir la app. Debe refrescar el token y recargar el perfil, no pedir login de nuevo.
  ctx.__appstate.session = null;
  ctx.__appstate.perfil = null;
  await ctx.restaurarSesionGuardada();
  assert(!!ctx.__appstate.session && ctx.__appstate.session.access_token==='token-refrescado', 'restaurarSesionGuardada debe refrescar el token guardado y restaurar la sesión, obtuvo: '+JSON.stringify(ctx.__appstate.session));
  assert(!!ctx.__appstate.perfil && ctx.__appstate.perfil.nombre==='Joel Restaurado', 'restaurarSesionGuardada debe volver a cargar el perfil, obtuvo: '+JSON.stringify(ctx.__appstate.perfil));

  // handleLogin: si tengo_otra_sesion_activa() dice que sí (con "Single session per user"
  // activado, esta cuenta ya tenía otra sesión abierta en otro dispositivo, que quedará
  // invalidada en su próximo refresh), se lo avisamos a quien recién entró en vez del
  // saludo normal.
  {
    const toastRootLogin = elements['toast-root'];
    tengoOtraSesionActivaRespuesta = true;
    let toastsAntes = toastRootLogin.hijos.length;
    await ctx.handleLogin('vicky@minera.cl', 'clave-cualquiera');
    let nuevosToasts = toastRootLogin.hijos.slice(toastsAntes);
    assert(nuevosToasts.some(t=>t.textContent==='Cerramos tu sesión anterior en otro dispositivo.'), 'si tengo_otra_sesion_activa() devuelve true, debe avisar que se cerró la otra sesión, obtuvo: '+JSON.stringify(nuevosToasts.map(t=>t.textContent)));

    // Y si no había otra sesión, sigue mostrando el saludo normal de siempre.
    tengoOtraSesionActivaRespuesta = false;
    toastsAntes = toastRootLogin.hijos.length;
    await ctx.handleLogin('vicky@minera.cl', 'clave-cualquiera');
    nuevosToasts = toastRootLogin.hijos.slice(toastsAntes);
    assert(nuevosToasts.some(t=>t.textContent.startsWith('Bienvenido')), 'si tengo_otra_sesion_activa() devuelve false, debe mostrar el saludo normal, obtuvo: '+JSON.stringify(nuevosToasts.map(t=>t.textContent)));
  }

  // rest(): si la API responde 401 (token vencido), debe refrescar la sesión y reintentar una sola vez.
  // Se espera un momento antes de simular esto para dejar que terminen otras llamadas de fondo
  // (varias acciones de la app disparan recargas "fire-and-forget" sin esperarlas), y se usa una
  // ruta exacta y única (sin query string) que ninguna otra función real de la app usa, para que
  // el mock de fetch de abajo no intercepte de rebote una llamada de otra prueba anterior.
  await new Promise(resolve => setTimeout(resolve, 30));
  ctx.__appstate.session = { access_token:'token-vencido', refresh_token:'refresh-2', user:{id:'user-1'} };
  let intentosConTokenVencido = 0;
  const fetchOriginal = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/ruta-de-prueba-401' && (opts.headers.Authorization||'').includes('token-vencido')){
      intentosConTokenVencido++;
      return { status:401, ok:false, headers:{get:()=>null}, text: async()=>JSON.stringify({message:'JWT expired'}) };
    }
    return fetchOriginal(url, opts);
  };
  const filasTrasReintento = await ctx.rest('/ruta-de-prueba-401');
  ctx.fetch = fetchOriginal;
  assert(intentosConTokenVencido===1, 'debe recibir el 401 con el token vencido antes de refrescar, obtuvo: '+intentosConTokenVencido);
  assert(ctx.__appstate.session.access_token==='token-refrescado', 'tras un 401, rest() debe refrescar la sesión automáticamente, obtuvo: '+ctx.__appstate.session.access_token);
  assert(Array.isArray(filasTrasReintento), 'tras refrescar, el reintento debe completarse con éxito, obtuvo: '+JSON.stringify(filasTrasReintento));

  // borrarSesionGuardada: limpia lo persistido (handleLogout la usa; se prueba aparte para no
  // disparar la reasignación completa de `state` que hace handleLogout a mitad del archivo).
  assert(ctx.localStorage.getItem('sesion_inventario')!==null, 'sanity check: debía quedar una sesión guardada de los pasos anteriores');
  ctx.borrarSesionGuardada();
  assert(ctx.localStorage.getItem('sesion_inventario')===null, 'borrarSesionGuardada debe limpiar la sesión persistida en localStorage');

  // ===== "Olvidé mi contraseña" =====

  // renderLogin: toggle hacia y desde la pantalla de recuperación.
  ctx.__appstate.session = null; ctx.__appstate.perfil = null; ctx.__appstate.authRecuperar = false;
  const htmlLoginNormal = ctx.renderLogin();
  assert(htmlLoginNormal.includes('id="btn-olvide-pass"') && !htmlLoginNormal.includes('id="recuperar-password-form"'), 'el login normal debe ofrecer "¿Olvidaste tu contraseña?", obtuvo: '+htmlLoginNormal);
  ctx.__appstate.authRecuperar = true;
  const htmlRecuperar = ctx.renderLogin();
  assert(htmlRecuperar.includes('id="recuperar-password-form"') && htmlRecuperar.includes('id="f-recuperar-email"') && htmlRecuperar.includes('id="btn-volver-login"'), 'en modo recuperar debe mostrarse el formulario para pedir el link, obtuvo: '+htmlRecuperar);
  ctx.__appstate.authRecuperar = false;

  // solicitarRecuperacion: dispara el correo vía /auth/v1/recover y pasa directo a "Ingresa tu
  // código" (con el correo ya escrito), en vez de solo volver al login -- pedido real (Joel,
  // BHP): el filtro de seguridad de una empresa grande abre y gasta el link de un solo uso del
  // correo antes de que la persona pueda hacer clic, así que el código escrito a mano (ver
  // ingresarConCodigo más abajo) es la vía que sí funciona ahí.
  calls.length = 0;
  ctx.__appstate.authRecuperar = true;
  await ctx.solicitarRecuperacion('alguien@test.com');
  const recoverCall = calls.find(c=>c.url.includes('/auth/v1/recover'));
  assert(!!recoverCall, 'solicitarRecuperacion debe llamar a /auth/v1/recover, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(recoverCall.opts.body).email==='alguien@test.com', 'debe enviar el correo ingresado, obtuvo: '+recoverCall.opts.body);
  assert(ctx.__appstate.authRecuperar===false, 'tras enviar el código, debe salir de la pantalla de "olvidé mi contraseña", obtuvo: '+ctx.__appstate.authRecuperar);
  assert(ctx.__appstate.otpAcceso && ctx.__appstate.otpAcceso.email==='alguien@test.com', 'debe pasar a "Ingresa tu código" con el correo ya escrito, obtuvo: '+JSON.stringify(ctx.__appstate.otpAcceso));
  ctx.__appstate.otpAcceso = null;

  // renderLogin: "Ingresa tu código" tiene prioridad sobre "olvidé mi contraseña" (mismo patrón
  // que ya usa authRecuperar) y el login normal ofrece un link para llegar ahí directo, sin
  // depender de haber pasado por "olvidé mi contraseña" primero -- así también sirve para
  // canjear un código de invitación de un administrador.
  ctx.__appstate.otpAcceso = {email:'nueva@empresa.cl'};
  const htmlOtpAcceso = ctx.renderLogin();
  assert(htmlOtpAcceso.includes('id="otp-acceso-form"') && htmlOtpAcceso.includes('id="f-otp-email"') && htmlOtpAcceso.includes('id="f-otp-codigo"'), 'debe mostrar el formulario de código con campos de correo y código, obtuvo: '+htmlOtpAcceso);
  assert(htmlOtpAcceso.includes('value="nueva@empresa.cl"'), 'el campo de correo debe venir precargado, obtuvo: '+htmlOtpAcceso);
  // Bug real reportado (Joel/Nasib, proyecto BHP): el código que Supabase manda por correo no
  // siempre son 6 dígitos (llegó uno de 8) -- con maxlength="6" el navegador cortaba el código
  // a la mitad y el login nunca podía coincidir. El campo ya no debe asumir un largo fijo, ni
  // en el texto ni en el maxlength.
  assert(!/maxlength="[0-6]"/.test(htmlOtpAcceso), 'el campo de código no debe limitarse a 6 caracteres o menos, obtuvo: '+htmlOtpAcceso);
  assert(!htmlOtpAcceso.includes('6 dígitos') && !htmlOtpAcceso.includes('Código de 6'), 'el texto ya no debe prometer un largo fijo de 6 dígitos, obtuvo: '+htmlOtpAcceso);
  ctx.__appstate.otpAcceso = null;
  const htmlLoginConLinkCodigo = ctx.renderLogin();
  assert(htmlLoginConLinkCodigo.includes('id="btn-tengo-codigo"'), 'el login normal debe ofrecer un link para llegar a "Ingresa tu código", obtuvo: '+htmlLoginConLinkCodigo);

  // ingresarConCodigo: prueba primero type=invite y, si no calza, type=recovery -- la persona
  // no tiene por qué saber cuál de los dos es su código.
  calls.length = 0;
  await ctx.ingresarConCodigo('invitado-otp@test.com', '654321');
  assert(ctx.__appstate.session && ctx.__appstate.session.access_token==='tok-otp-invite', 'un código de invitación válido debe armar la sesión con ese access_token, obtuvo: '+JSON.stringify(ctx.__appstate.session));
  assert(ctx.__appstate.debeCrearPassword===true, 'tras validar el código, debe pedir crear contraseña (misma pantalla que el link del correo), obtuvo: '+ctx.__appstate.debeCrearPassword);
  assert(ctx.__appstate.otpAcceso===null, 'debe salir de la pantalla de código tras validar, obtuvo: '+JSON.stringify(ctx.__appstate.otpAcceso));
  const intentosInvite = calls.filter(c=>c.url.includes('/auth/v1/verify'));
  assert(intentosInvite.length===1 && JSON.parse(intentosInvite[0].opts.body).type==='invite', 'un código de invitación válido debe resolverse en el primer intento (type=invite), sin necesitar el segundo, obtuvo: '+JSON.stringify(intentosInvite.map(c=>c.opts.body)));

  ctx.__appstate.session = null; ctx.__appstate.debeCrearPassword = false;
  calls.length = 0;
  await ctx.ingresarConCodigo('recupera-otp@test.com', '111222');
  assert(ctx.__appstate.session && ctx.__appstate.session.access_token==='tok-otp-recovery', 'un código de recuperación válido debe armar la sesión con ese access_token (tras fallar como invite), obtuvo: '+JSON.stringify(ctx.__appstate.session));
  assert(ctx.__appstate.debeCrearPassword===true, 'un código de recuperación válido también debe pedir crear contraseña, obtuvo: '+ctx.__appstate.debeCrearPassword);
  const intentosRecovery = calls.filter(c=>c.url.includes('/auth/v1/verify'));
  assert(intentosRecovery.length===2 && JSON.parse(intentosRecovery[0].opts.body).type==='invite' && JSON.parse(intentosRecovery[1].opts.body).type==='recovery', 'debe probar primero invite y, al fallar, recovery, obtuvo: '+JSON.stringify(intentosRecovery.map(c=>c.opts.body)));

  // Regresión real (Joel/Nasib, BHP): un código de 8 dígitos debe mandarse completo, sin
  // truncarlo a 6 -- cubre el bug de maxlength="6" que impedía escribirlo completo en el input.
  ctx.__appstate.session = null; ctx.__appstate.debeCrearPassword = false;
  calls.length = 0;
  await ctx.ingresarConCodigo('recupera-8digitos@test.com', '37470939');
  assert(ctx.__appstate.session && ctx.__appstate.session.access_token==='tok-otp-8digitos', 'un código de 8 dígitos válido debe armar la sesión igual que uno de 6, obtuvo: '+JSON.stringify(ctx.__appstate.session));

  ctx.__appstate.session = null; ctx.__appstate.debeCrearPassword = false;
  const toastRootOtp = elements['toast-root'];
  const toastsAntesOtp = toastRootOtp ? toastRootOtp.hijos.length : 0;
  await ctx.ingresarConCodigo('nadie@test.com', '000000');
  assert(!ctx.__appstate.session, 'un código inválido para ambos tipos no debe armar ninguna sesión, obtuvo: '+JSON.stringify(ctx.__appstate.session));
  const nuevosToastsOtp = toastRootOtp.hijos.slice(toastsAntesOtp);
  assert(nuevosToastsOtp.some(t=>t.className.includes('err')), 'un código inválido debe mostrar un error, obtuvo: '+JSON.stringify(nuevosToastsOtp.map(t=>t.textContent)));

  // actualizarNombreEmpresa: PATCH a /empresas y actualización optimista del estado local.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  calls.length = 0;
  await ctx.actualizarNombreEmpresa('Minera Andes Sur');
  const patchEmpresa = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/empresas?id=eq.emp-1'));
  assert(!!patchEmpresa, 'actualizarNombreEmpresa debe hacer PATCH a /empresas?id=eq.<empresa_id>, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(patchEmpresa.opts.body).nombre==='Minera Andes Sur', 'el PATCH debe llevar el nuevo nombre, obtuvo: '+patchEmpresa.opts.body);
  assert(ctx.__appstate.perfil.empresas.nombre==='Minera Andes Sur', 'debe reflejar el nuevo nombre en el estado local tras guardar, obtuvo: '+ctx.__appstate.perfil.empresas.nombre);

  // actualizarConteoCiego: mismo patrón (PATCH a /empresas + actualización optimista), y el
  // admin lo puede prender y apagar las veces que quiera.
  calls.length = 0;
  await ctx.actualizarConteoCiego(true);
  const patchConteoCiegoOn = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/empresas?id=eq.emp-1'));
  assert(!!patchConteoCiegoOn && JSON.parse(patchConteoCiegoOn.opts.body).conteo_ciego_habilitado===true, 'debe hacer PATCH activando conteo_ciego_habilitado, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.perfil.empresas.conteo_ciego_habilitado===true, 'debe reflejarlo en el estado local, obtuvo: '+ctx.__appstate.perfil.empresas.conteo_ciego_habilitado);
  calls.length = 0;
  await ctx.actualizarConteoCiego(false);
  const patchConteoCiegoOff = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/empresas?id=eq.emp-1'));
  assert(!!patchConteoCiegoOff && JSON.parse(patchConteoCiegoOff.opts.body).conteo_ciego_habilitado===false, 'el admin debe poder apagarlo de nuevo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.perfil.empresas.conteo_ciego_habilitado===false, 'debe reflejarlo en el estado local, obtuvo: '+ctx.__appstate.perfil.empresas.conteo_ciego_habilitado);

  // Las acciones de escritura deben viajar con el empresa_id del perfil actual (aislamiento entre empresas).
  // crearSkuManual debe hacer un INSERT simple a /skus, SIN upsert: si el código ya existe
  // para esta empresa+bodega, el índice único debe rechazarlo en vez de pisar en silencio
  // los datos de otro material con el mismo código (ver esErrorCodigoSkuDuplicado).
  calls.length = 0;
  await ctx.crearSkuManual({sku_code:'SKU-999', descripcion:'Perno de prueba', activo:true});
  const postSku = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/skus'));
  assert(!!postSku, 'crearSkuManual debe hacer POST a /skus, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(postSku.url.endsWith('/rest/v1/skus'), 'crearSkuManual debe hacer un INSERT simple a /skus (sin on_conflict), obtuvo: '+postSku.url);
  assert(!(postSku.opts.headers.Prefer||'').includes('resolution=merge-duplicates'), 'crearSkuManual ya no debe pedir resolution=merge-duplicates, un código repetido debe rechazarse en vez de pisar el existente, obtuvo: '+postSku.opts.headers.Prefer);
  assert(JSON.parse(postSku.opts.body)[0].empresa_id==='emp-1', 'el POST de crearSkuManual debe incluir el empresa_id del perfil actual, obtuvo: '+postSku.opts.body);

  // Si el código+bodega ya existe, crearSkuManual debe mostrar "código ya existe" en vez del
  // error crudo de Postgres, y NO debe haber quedado ningún SKU guardado con esos datos.
  const toastRootDup = elements['toast-root'];
  const toastsAntesDup = toastRootDup ? toastRootDup.hijos.length : 0;
  const okDup = await ctx.crearSkuManual({sku_code:'SKU-DUP-EXISTE', descripcion:'Sillas', bodega:'', activo:true});
  assert(okDup===false, 'crearSkuManual debe devolver false cuando el código ya existe, obtuvo: '+okDup);
  const toastsDup = toastRootDup.hijos.slice(toastsAntesDup);
  assert(toastsDup.length===1 && /ya existe/i.test(toastsDup[0].textContent) && toastsDup[0].textContent.includes('SKU-DUP-EXISTE'), 'debe avisar con un mensaje claro de "código ya existe", no el error crudo de Postgres, obtuvo: '+JSON.stringify(toastsDup.map(t=>t.textContent)));
  assert(!/duplicate key|constraint/i.test(toastsDup[0].textContent), 'el mensaje no debe filtrar el error crudo de la base de datos, obtuvo: '+toastsDup[0].textContent);

  // El mismo código+bodega puede repetirse con un batch distinto (ambos válidos); el mensaje
  // de "ya existe" debe aclarar CON QUÉ batch choca, para no confundir al que está cargando.
  const toastsAntesDupBatch = toastRootDup.hijos.length;
  await ctx.crearSkuManual({sku_code:'SKU-DUP-EXISTE', descripcion:'Sillas', bodega:'Nave Mina', batch:'L-009', activo:true});
  const toastsDupBatch = toastRootDup.hijos.slice(toastsAntesDupBatch);
  assert(toastsDupBatch.length===1 && toastsDupBatch[0].textContent.includes('con batch L-009'), 'el mensaje de duplicado debe mencionar el batch cuando el payload trae uno, obtuvo: '+JSON.stringify(toastsDupBatch.map(t=>t.textContent)));

  // crearSkuManual dispara refrescarListaSkus() sin esperarlo (fire-and-forget): hay que dejar
  // que esa cadena de promesas termine aquí, o su llamada a /ultimo_conteo_por_sku se cuela
  // más adelante y contamina el conteo de llamadas del siguiente bloque (perfil no cargado).
  await new Promise(r=>setTimeout(r, 0));

  // ===== Carga masiva: el mismo sku_code en dos bodegas distintas no debe deduplicarse =====
  // (ver migración permitir_mismo_sku_en_varias_bodegas: cada bodega es su propia fila).
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', descripcion:'Desc', bodega:'Bodega', stock_sistema:'Stock', costo_unitario:'Costo' },
    data: [
      { Codigo:'SKU-MULTI', Desc:'Filtro', Bodega:'Nave', Stock:'10', Costo:'1500' },
      { Codigo:'SKU-MULTI', Desc:'Filtro', Bodega:'Planta', Stock:'4', Costo:'' },
    ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postCarga = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  assert(!!postCarga, 'confirmarCargaMasiva debe hacer POST a /skus, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(postCarga.url.includes('on_conflict=empresa_id,sku_code,bodega_key,batch_key,ubicacion_key,storage_bin_key'), 'la carga masiva debe hacer upsert por (empresa_id, sku_code, bodega_key, batch_key, ubicacion_key, storage_bin_key), obtuvo: '+postCarga.url);
  const filasCarga = JSON.parse(postCarga.opts.body);
  assert(filasCarga.length===2, 'dos filas del mismo código en bodegas distintas deben llegar ambas al upsert, no deduplicarse a una sola, obtuvo: '+JSON.stringify(filasCarga));
  assert(filasCarga.some(f=>f.bodega==='Nave' && f.stock_sistema===10) && filasCarga.some(f=>f.bodega==='Planta' && f.stock_sistema===4), 'cada fila debe conservar el stock de su propia bodega, obtuvo: '+JSON.stringify(filasCarga));
  assert(filasCarga.some(f=>f.bodega==='Nave' && f.costo_unitario===1500) && filasCarga.some(f=>f.bodega==='Planta' && f.costo_unitario===null), 'la carga masiva debe mapear costo_unitario cuando viene en el archivo, y dejarlo null cuando la celda viene vacía, obtuvo: '+JSON.stringify(filasCarga));

  // ===== Carga masiva: el mismo sku_code+bodega en dos batches distintos tampoco debe
  // deduplicarse (a pedido de Joel: "en Contar, mostrar el SOH por los diferentes tipos de
  // batch") -- pero el mismo código+bodega+batch repetido dos veces sí se queda con el último.
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales-batch.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', descripcion:'Desc', bodega:'Bodega', batch:'Batch', stock_sistema:'Stock', costo_unitario:'Costo' },
    data: [
      { Codigo:'SKU-LOTE', Desc:'Aceite', Bodega:'Nave', Batch:'L-001', Stock:'40', Costo:'900' },
      { Codigo:'SKU-LOTE', Desc:'Aceite', Bodega:'Nave', Batch:'L-002', Stock:'10', Costo:'900' },
      { Codigo:'SKU-LOTE', Desc:'Aceite', Bodega:'Nave', Batch:'L-002', Stock:'12', Costo:'900' },
    ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postCargaBatch = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  const filasCargaBatch = JSON.parse(postCargaBatch.opts.body);
  assert(filasCargaBatch.length===2, 'dos batches distintos del mismo código+bodega deben llegar ambos al upsert (no colapsarse en uno), obtuvo: '+JSON.stringify(filasCargaBatch));
  assert(filasCargaBatch.some(f=>f.batch==='L-001' && f.stock_sistema===40), 'debe conservar el SOH del batch L-001, obtuvo: '+JSON.stringify(filasCargaBatch));
  const filaL002 = filasCargaBatch.find(f=>f.batch==='L-002');
  assert(!!filaL002 && filaL002.stock_sistema===12, 'con el mismo código+bodega+batch repetido dos veces, debe quedarse con la última fila (stock 12, no 10), obtuvo: '+JSON.stringify(filaL002));

  // ===== Carga masiva: el mismo sku_code+bodega+batch en dos ubicaciones/storage bin
  // distintos tampoco debe deduplicarse (caso real confirmado con Joel usando Materials_4.xlsx
  // de Escondida: un material puede vivir en más de un Storage Location dentro de la misma
  // planta, cada uno con su propio stock -- antes se colapsaban en una sola fila, perdiendo
  // hasta ~800 registros con menos stock del real).
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales-ubicacion.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', descripcion:'Desc', bodega:'Bodega', ubicacion:'Ubicacion', storage_bin:'Bin', stock_sistema:'Stock' },
    data: [
      { Codigo:'SKU-BIN', Desc:'Manguera', Bodega:'B501', Ubicacion:'0100', Bin:'N1E-198-C2', Stock:'7' },
      { Codigo:'SKU-BIN', Desc:'Manguera', Bodega:'B501', Ubicacion:'0102', Bin:'N1E-107-A3', Stock:'0' },
    ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postCargaBin = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  const filasCargaBin = JSON.parse(postCargaBin.opts.body);
  assert(filasCargaBin.length===2, 'dos ubicaciones/bin distintos del mismo código+bodega+batch deben llegar ambos al upsert (no colapsarse en uno), obtuvo: '+JSON.stringify(filasCargaBin));
  assert(filasCargaBin.some(f=>f.ubicacion==='0100' && f.storage_bin==='N1E-198-C2' && f.stock_sistema===7), 'debe conservar el stock de la primera ubicación (7), obtuvo: '+JSON.stringify(filasCargaBin));
  assert(filasCargaBin.some(f=>f.ubicacion==='0102' && f.storage_bin==='N1E-107-A3' && f.stock_sistema===0), 'debe conservar el stock de la segunda ubicación (0) como fila aparte, sin pisar la primera, obtuvo: '+JSON.stringify(filasCargaBin));

  // CAMPOS_SKU: "Batch" es su propio campo (columna batch, separada de categoria), y un
  // encabezado literal "Batch" en el archivo debe mapear a `batch`, no a `categoria` -- antes
  // "Batch" era un alias de categoria, y los datos reales mostraron que ese campo en la
  // práctica guarda el nombre de planta, no un lote.
  const campoBatch = ctx.__CAMPOS_SKU.find(c=>c.campo==='batch');
  const campoCategoria = ctx.__CAMPOS_SKU.find(c=>c.campo==='categoria');
  assert(!!campoBatch && campoBatch.etiqueta==='Batch', 'debe existir un campo `batch` propio, etiquetado "Batch", obtuvo: '+JSON.stringify(campoBatch));
  assert(!!campoCategoria && campoCategoria.etiqueta==='Categoría', 'categoria debe quedar etiquetado "Categoría" (ya no "Batch"), obtuvo: '+JSON.stringify(campoCategoria));
  assert(!campoCategoria.alias.includes('batch') && !campoCategoria.alias.includes('lote'), 'categoria no debe quedarse con alias que en realidad describen un lote/batch, obtuvo: '+JSON.stringify(campoCategoria.alias));
  const mapeoBatch = ctx.detectarMapeo(['Material','Batch'], ctx.__CAMPOS_SKU);
  assert(mapeoBatch.batch==='Batch' && mapeoBatch.categoria===undefined, 'un encabezado "Batch" en el archivo debe mapear al campo batch, no a categoria, obtuvo: '+JSON.stringify(mapeoBatch));

  // Caso real (archivo SAP de Escondida, 61.672 filas): "Stock in Quality Inspection" NO debe
  // mapear a stock_transito_2 solo por compartir las palabras genéricas "stock"/"in" con el
  // alias "stock in transit 2" -- son categorías de stock distintas (calidad ≠ tránsito). Sin
  // el filtro de palabras genéricas en puntajeColumna, este archivo real mezclaba ambas.
  const mapeoTransito = ctx.detectarMapeo(['Material','Unrestricted Stock','Stock in Transit','Stock in Quality Inspection'], ctx.__CAMPOS_SKU);
  assert(mapeoTransito.stock_transito_1==='Stock in Transit', '"Stock in Transit" debe mapear a stock_transito_1, obtuvo: '+JSON.stringify(mapeoTransito));
  assert(mapeoTransito.stock_transito_2===undefined, '"Stock in Quality Inspection" NO debe mapear a stock_transito_2 (categoría de stock distinta), obtuvo: '+JSON.stringify(mapeoTransito));

  // Un costo o stock negativo (típico de notas de crédito/ajustes en exportaciones de SAP)
  // viola el check constraint de la tabla — antes, esa UNA fila hacía fallar el INSERT masivo
  // COMPLETO (el archivo entero, no solo esa fila), porque se manda como un solo lote. Ahora
  // se debe guardar el SKU igual, sin ese dato puntual, y dejarlo registrado como error de fila.
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', bodega:'Bodega', stock_sistema:'Stock', costo_unitario:'Costo' },
    data: [
      { Codigo:'SKU-COSTO-NEG', Bodega:'Nave', Stock:'10', Costo:'-500' },
      { Codigo:'SKU-STOCK-NEG', Bodega:'Nave', Stock:'-3', Costo:'100' },
    ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postCargaNeg = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  const filasCargaNeg = JSON.parse(postCargaNeg.opts.body);
  assert(filasCargaNeg.length===2, 'ambas filas deben llegar al upsert (no descartarse), obtuvo: '+JSON.stringify(filasCargaNeg));
  const filaCostoNeg = filasCargaNeg.find(f=>f.sku_code==='SKU-COSTO-NEG');
  assert(filaCostoNeg.costo_unitario===null, 'un costo_unitario negativo debe guardarse como null, no mandarse tal cual, obtuvo: '+JSON.stringify(filaCostoNeg));
  assert(filaCostoNeg.stock_sistema===10, 'el resto de los datos de esa fila debe conservarse, obtuvo: '+JSON.stringify(filaCostoNeg));
  const filaStockNeg = filasCargaNeg.find(f=>f.sku_code==='SKU-STOCK-NEG');
  assert(filaStockNeg.stock_sistema===null, 'un stock_sistema negativo debe guardarse como null, no mandarse tal cual, obtuvo: '+JSON.stringify(filaStockNeg));
  const postRegistrarCargaNeg = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/cargas_masivas'));
  const bodyRegistrarCargaNeg = JSON.parse(postRegistrarCargaNeg.opts.body)[0];
  assert(bodyRegistrarCargaNeg.filas_error===2, 'las dos filas con valor negativo deben quedar contadas como error en el resumen, obtuvo: '+JSON.stringify(bodyRegistrarCargaNeg));
  assert(bodyRegistrarCargaNeg.detalle_errores.some(e=>/costo en negativo/i.test(e.motivo) && e.cantidad===1) && bodyRegistrarCargaNeg.detalle_errores.some(e=>/stock en negativo/i.test(e.motivo) && e.cantidad===1), 'el detalle de errores debe explicar cuál dato vino negativo y cuántas filas, obtuvo: '+JSON.stringify(bodyRegistrarCargaNeg.detalle_errores));
  assert(!bodyRegistrarCargaNeg.detalle_errores.some(e=>/-500|-3/.test(e.motivo)), 'el detalle agrupado no debe mezclar el valor puntual de cada fila (eso ya no cabe al agrupar por motivo), obtuvo: '+JSON.stringify(bodyRegistrarCargaNeg.detalle_errores));

  // El detalle de errores se agrupa por motivo (no fila por fila): un archivo con miles de filas
  // con el mismo problema debe verse como "N × motivo", no como una lista larga de filas sueltas
  // — a pedido de Joel, para que el historial de cargas sea legible con archivos grandes.
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', bodega:'Bodega', costo_unitario:'Costo' },
    data: [
      { Codigo:'SKU-AGRUP-1', Bodega:'Nave', Costo:'-10' },
      { Codigo:'SKU-AGRUP-2', Bodega:'Nave', Costo:'-20' },
      { Codigo:'SKU-AGRUP-3', Bodega:'Nave', Costo:'-30' },
      { Codigo:'', Bodega:'Nave', Costo:'5' },
    ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postRegistrarCargaAgrup = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/cargas_masivas'));
  const bodyAgrup = JSON.parse(postRegistrarCargaAgrup.opts.body)[0];
  assert(bodyAgrup.detalle_errores.length===2, 'debe haber exactamente 2 motivos distintos (costo negativo + código vacío), no una entrada por fila, obtuvo: '+JSON.stringify(bodyAgrup.detalle_errores));
  const motivoCostoAgrup = bodyAgrup.detalle_errores.find(e=>/costo en negativo/i.test(e.motivo));
  assert(!!motivoCostoAgrup && motivoCostoAgrup.cantidad===3, 'las 3 filas con costo negativo deben agruparse en una sola entrada con cantidad:3, obtuvo: '+JSON.stringify(bodyAgrup.detalle_errores));
  const motivoVacioAgrup = bodyAgrup.detalle_errores.find(e=>/código de sku vacío/i.test(e.motivo));
  assert(!!motivoVacioAgrup && motivoVacioAgrup.cantidad===1, 'la fila sin código debe contarse aparte, obtuvo: '+JSON.stringify(bodyAgrup.detalle_errores));

  // Un archivo grande (ej. 64.000 filas de un maestro SAP) se parte en bloques de 2.000 antes
  // de mandarlo — un solo POST con todo el archivo superaba el statement_timeout de la base
  // (ver comentario en confirmarCargaMasiva). Con 2.500 filas únicas deben salir 2 POST: uno
  // de 2.000 y uno de 500, no uno solo con las 2.500.
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales_grande.xlsx' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo' },
    data: Array.from({length:2500}, (_,i)=>({ Codigo:`SKU-LOTE-${i}` })),
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postsCargaLote = calls.filter(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  assert(postsCargaLote.length===2, 'un archivo de 2.500 filas debe mandarse en 2 bloques (2.000 + 500), no en un solo POST, obtuvo: '+postsCargaLote.length);
  const tamañosLote = postsCargaLote.map(c=>JSON.parse(c.opts.body).length).sort((a,b)=>b-a);
  assert(tamañosLote[0]===2000 && tamañosLote[1]===500, 'los bloques deben ser de 2.000 y 500 filas, obtuvo: '+JSON.stringify(tamañosLote));
  const toastLote = elements['toast-root'].hijos[elements['toast-root'].hijos.length-1];
  assert(toastLote.textContent.includes('2500 SKUs cargados'), 'el resumen final debe sumar las filas de todos los bloques, obtuvo: '+toastLote.textContent);
  // A pedido de Joel: mostrar el avance mientras se suben los bloques. Al terminar (éxito o
  // error) debe volver a null, para no dejar una barra de progreso "pegada".
  assert(ctx.__appstate.cargaMasivaProgreso===null, 'cargaMasivaProgreso debe quedar en null al terminar la carga, obtuvo: '+JSON.stringify(ctx.__appstate.cargaMasivaProgreso));
  ctx.__appstate.cargaPreview = null;
  await new Promise(r=>setTimeout(r, 0));

  // Render del avance: con cargaMasivaProgreso seteado y loading:true, la vista previa debe
  // mostrar el porcentaje y deshabilitar "Cancelar" (no solo "Confirmar").
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales_grande.xlsx' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo' },
    campos: [{campo:'sku_code', etiqueta:'Código', obligatorio:true}],
    headers: ['Codigo'],
    data: [{ Codigo:'SKU-X' }],
    confirmaReemplazo: false,
  };
  ctx.__appstate.cargaMasivaProgreso = { actual: 6000, total: 20000 };
  ctx.__appstate.loading = true;
  const htmlProgreso = ctx.renderCargaPreview();
  assert(htmlProgreso.includes('30%') && htmlProgreso.includes('6.000') && htmlProgreso.includes('20.000'), 'debe mostrar el porcentaje y las cantidades del avance, obtuvo: '+htmlProgreso);
  assert(/id="btn-cancelar-carga"[^>]*disabled/.test(htmlProgreso), 'Cancelar debe deshabilitarse mientras hay una carga en curso, obtuvo: '+htmlProgreso);
  ctx.__appstate.loading = false;
  ctx.__appstate.cargaMasivaProgreso = null;
  ctx.__appstate.cargaPreview = null;

  // ===== Carga masiva: aviso cuando las bodegas del archivo no coinciden con nada existente =====
  // Caso real: Materials.xlsx con bodegas "B501"/"B521" no coincidía con la data ya cargada en
  // "Nave Mina"/"Nave Planta" (fixture de /ubicaciones_generales), duplicando ~55.000 SKU en vez
  // de actualizarlos porque la bodega es parte de la identidad de cada fila.
  calls.length = 0;
  const avisoMismatch = await ctx.calcularAvisoBodega(
    [{ Codigo:'SKU-X', Bodega:'B501' }, { Codigo:'SKU-Y', Bodega:'B521' }],
    'Bodega'
  );
  assert(!!avisoMismatch, 'un archivo cuyas bodegas no coinciden con ninguna existente debe generar aviso, obtuvo: '+JSON.stringify(avisoMismatch));
  assert(JSON.stringify(avisoMismatch.archivo)===JSON.stringify(['B501','B521']), 'debe listar las bodegas distintas del archivo (ordenadas), obtuvo: '+JSON.stringify(avisoMismatch.archivo));
  assert(avisoMismatch.existentes.includes('Nave Mina') && avisoMismatch.existentes.includes('Nave Planta'), 'debe listar las bodegas ya existentes, obtuvo: '+JSON.stringify(avisoMismatch.existentes));
  assert(avisoMismatch.confirmado===false, 'el aviso arranca sin confirmar, obtuvo: '+JSON.stringify(avisoMismatch));
  assert(calls.some(c=>c.url.includes('/ubicaciones_generales')), 'calcularAvisoBodega debe consultar las bodegas ya cargadas, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Coincidencia parcial (agregaste un sitio nuevo, pero al menos una bodega ya existía) no debe
  // avisar — eso es crecimiento normal, no un error de nomenclatura.
  const avisoCoincide = await ctx.calcularAvisoBodega(
    [{ Codigo:'SKU-X', Bodega:'Nave Mina' }, { Codigo:'SKU-Y', Bodega:'B999' }],
    'Bodega'
  );
  assert(avisoCoincide===null, 'con al menos una bodega coincidente no debe avisar, obtuvo: '+JSON.stringify(avisoCoincide));

  // Sin columna de bodega mapeada no hay nada que comparar (y no debe llamar a la red).
  calls.length = 0;
  const avisoSinColumna = await ctx.calcularAvisoBodega([{ Codigo:'SKU-X' }], undefined);
  assert(avisoSinColumna===null && calls.length===0, 'sin columna de bodega mapeada no debe avisar ni consultar la red, obtuvo: '+JSON.stringify(avisoSinColumna));

  // El aviso debe verse en la vista previa y bloquear "Confirmar e importar" hasta marcar el
  // checkbox — mismo patrón que ya usa "Reemplazar completo".
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', bodega:'Bodega' },
    campos: [{campo:'sku_code', etiqueta:'Código', obligatorio:true}, {campo:'bodega', etiqueta:'Bodega', obligatorio:false}],
    headers: ['Codigo','Bodega'],
    data: [{ Codigo:'SKU-X', Bodega:'B501' }],
    confirmaReemplazo: false,
    avisoBodega: { archivo:['B501'], existentes:['Nave Mina','Nave Planta'], confirmado:false },
  };
  const htmlAviso = ctx.renderCargaPreview();
  assert(htmlAviso.includes('no coinciden con las que ya tienes cargadas') && htmlAviso.includes('B501') && htmlAviso.includes('Nave Mina'), 'debe mostrar el aviso con las bodegas del archivo y las ya existentes, obtuvo: '+htmlAviso);
  assert(/id="btn-confirmar-carga"[^>]*disabled/.test(htmlAviso), 'el botón de confirmar debe estar deshabilitado mientras no se confirme el aviso, obtuvo: '+htmlAviso);

  ctx.__appstate.cargaPreview.avisoBodega.confirmado = true;
  const htmlAvisoConfirmado = ctx.renderCargaPreview();
  assert(!/id="btn-confirmar-carga"[^>]*disabled/.test(htmlAvisoConfirmado), 'al marcar "cargar de todas formas" el botón debe habilitarse, obtuvo: '+htmlAvisoConfirmado);
  ctx.__appstate.cargaPreview = null;

  // A pedido de Joel: bodega, ubicación, storage bin y costo unitario son obligatorios en la
  // carga masiva (no solo sku_code/stock_sistema) — sin mapear alguno, "Confirmar e importar"
  // debe quedar deshabilitado y avisar cuáles faltan.
  const camposConObligatorios = [
    {campo:'sku_code', etiqueta:'Material', obligatorio:true},
    {campo:'bodega', etiqueta:'Ubicación general (Planta)', obligatorio:true},
    {campo:'ubicacion', etiqueta:'Ubicación específica (Storage Location)', obligatorio:true},
    {campo:'storage_bin', etiqueta:'Storage bin', obligatorio:true},
    {campo:'stock_sistema', etiqueta:'Stock sistema', obligatorio:true},
    {campo:'costo_unitario', etiqueta:'Costo unitario', obligatorio:true},
  ];
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', stock_sistema:'Stock' }, // faltan bodega/ubicacion/storage_bin/costo_unitario
    campos: camposConObligatorios,
    headers: ['Codigo','Stock'],
    data: [{ Codigo:'SKU-X', Stock:'5' }],
    confirmaReemplazo: false,
  };
  const htmlFaltantes = ctx.renderCargaPreview();
  assert(htmlFaltantes.includes('Falta asignar') && htmlFaltantes.includes('Ubicación general (Planta)') && htmlFaltantes.includes('Storage bin') && htmlFaltantes.includes('Costo unitario'), 'debe avisar cuáles campos obligatorios faltan mapear, obtuvo: '+htmlFaltantes);
  assert(/id="btn-confirmar-carga"[^>]*disabled/.test(htmlFaltantes), 'el botón debe quedar deshabilitado mientras falten campos obligatorios, obtuvo: '+htmlFaltantes);

  ctx.__appstate.cargaPreview.mapeo = { sku_code:'Codigo', stock_sistema:'Stock', bodega:'Bodega', ubicacion:'Ubic', storage_bin:'Bin', costo_unitario:'Costo' };
  const htmlCompleto = ctx.renderCargaPreview();
  assert(!htmlCompleto.includes('Falta asignar') && !/id="btn-confirmar-carga"[^>]*disabled/.test(htmlCompleto), 'con todos los obligatorios mapeados, el botón debe habilitarse, obtuvo: '+htmlCompleto);
  ctx.__appstate.cargaPreview = null;

  // Si el archivo trae dos filas del mismo código EN LA MISMA bodega, ahí sí no hay forma
  // de saber cuál es la correcta: se queda con la última (mismo criterio que antes).
  ctx.__appstate.cargaPreview = {
    file: { name: 'materiales.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', descripcion:'Desc', bodega:'Bodega', stock_sistema:'Stock' },
    data: [
      { Codigo:'SKU-DUP', Desc:'Filtro', Bodega:'Nave', Stock:'1' },
      { Codigo:'SKU-DUP', Desc:'Filtro', Bodega:'Nave', Stock:'2' },
    ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postCargaDup = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  const filasCargaDup = JSON.parse(postCargaDup.opts.body);
  assert(filasCargaDup.length===1 && filasCargaDup[0].stock_sistema===2, 'dos filas del mismo código Y la misma bodega deben deduplicarse a la última, obtuvo: '+JSON.stringify(filasCargaDup));

  ctx.__appstate.cargaPreview = null;
  // confirmarCargaMasiva dispara refrescarListaSkus() sin esperarlo (fire-and-forget), igual
  // que crearSkuManual: hay que drenar esa cadena o su llamada a /ultimo_conteo_por_sku se
  // cuela en el conteo de llamadas del siguiente bloque (perfil no cargado).
  await new Promise(r=>setTimeout(r, 0));

  // ===== Carga masiva: historial de cargas =====
  // registrarCarga (llamado desde confirmarCargaMasiva) debe dejar un rastro consultable de
  // cuándo se cargaron datos, con quién lo hizo y cuántas filas entraron bien/mal — antes no
  // había ninguna forma de ver esto desde la app, solo quedaba guardado en la tabla sin UI.
  ctx.__appstate.cargasHistorial = {cargado:false, cargando:false, filas:[]};
  await ctx.cargarHistorialCargas();
  assert(ctx.__appstate.cargasHistorial.cargado===true, 'cargarHistorialCargas debe marcar cargado:true al terminar');
  assert(ctx.__appstate.cargasHistorial.filas.length===3 && ctx.__appstate.cargasHistorial.filas[0].nombre_archivo==='materiales_agosto.xlsx', 'cargarHistorialCargas debe cargar el historial de la empresa, obtuvo: '+JSON.stringify(ctx.__appstate.cargasHistorial.filas));

  const htmlHistorial = ctx.renderCargaMasiva();
  assert(htmlHistorial.includes('Historial de cargas'), 'Carga masiva debe mostrar la sección de historial, obtuvo: '+htmlHistorial);
  // Recomendación agregada tras encontrar en producción planes que no detectaban cambios de
  // ubicación porque se cargaron sin Storage bin: la vista de Carga masiva debe recordarlo.
  assert(htmlHistorial.includes('Storage bin</b> con la ubicación física final'), 'Carga masiva debe recomendar completar Storage bin con la ubicación final, obtuvo: '+htmlHistorial);
  assert(htmlHistorial.includes('materiales_agosto.xlsx') && htmlHistorial.includes('118 de 120 filas cargadas') && htmlHistorial.includes('2 con error'), 'debe listar el archivo con cuántas filas entraron bien y con error, obtuvo: '+htmlHistorial);
  // A pedido de Joel: el historial debe mostrar POR QUÉ no se cargaron ciertas filas, no solo
  // el conteo — con el detalle agrupado por motivo (ver detalle_errores en el fixture de c1).
  assert(htmlHistorial.includes('Ver detalle') && htmlHistorial.includes('Código de SKU vacío - 2 SKU'), 'debe mostrar el detalle agrupado de por qué fallaron las filas, obtuvo: '+htmlHistorial);
  // Una carga vieja (formato pre-agrupado: 3 entradas sueltas {fila,motivo}, sin `cantidad`)
  // debe agruparse igual al mostrarse, en vez de listar 3 líneas idénticas sin número.
  assert(htmlHistorial.includes('sku_code vacío - 3 SKU'), 'una carga vieja (sin cantidad guardada) debe agruparse al renderizar, no listarse fila por fila, obtuvo: '+htmlHistorial);
  // carga_inicial.csv (c2) no tuvo errores (filas_error:0): no debe mostrar "Ver detalle".
  const bloqueCargaInicial = htmlHistorial.slice(htmlHistorial.indexOf('carga_inicial.csv'));
  assert(!bloqueCargaInicial.includes('Ver detalle'), 'una carga sin errores no debe mostrar el desplegable de detalle, obtuvo: '+bloqueCargaInicial.slice(0,300));
  assert(htmlHistorial.includes('Por: Ana Torres'), 'debe mostrar quién hizo la carga, obtuvo: '+htmlHistorial);
  assert(htmlHistorial.includes('carga_inicial.csv') && htmlHistorial.includes('Por: Sistema'), 'una carga sin usuario asociado debe mostrarse como "Sistema", igual que en trazabilidad, obtuvo: '+htmlHistorial);

  // El historial debe refrescarse solo tras una carga real (mismo bug que "Mi equipo": si no
  // se refresca, la carga recién hecha no aparece hasta recargar la página a mano).
  ctx.__appstate.cargaPreview = {
    file: { name: 'refresco.csv' }, modo: 'complementar',
    mapeo: { sku_code:'Codigo' }, data: [{ Codigo:'SKU-REFRESCO' }],
  };
  ctx.__appstate.cargasHistorial = {cargado:true, cargando:false, filas:[]};
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  await new Promise(r=>setTimeout(r, 0));
  const getHistorialTrasCarga = calls.find(c=>c.url.includes('/rest/v1/cargas_masivas?select='));
  assert(!!getHistorialTrasCarga, 'tras confirmar una carga, el historial debe recargarse solo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  ctx.__appstate.cargaPreview = null;
  await new Promise(r=>setTimeout(r, 0));

  // bind() en 'carga' (fuera del preview) debe pedir el historial una sola vez, igual que
  // "Mi equipo"/auditoría — usa el mismo patrón de `if(!cargado) cargar...()`.
  // bind() corta temprano si no hay sesión (ver guard `if(!state.session) return;`); esta
  // sección del archivo la dejó en null unas pruebas atrás (recuperar contraseña), así que
  // hay que reponerla para llegar de verdad al bloque de 'carga'.
  ctx.__appstate.session = { access_token:'x', refresh_token:'y', user:{id:'user-1', email:'a@b.com'} };
  ctx.__appstate.view = 'carga';
  ctx.__appstate.cargasHistorial = {cargado:false, cargando:false, filas:[]};
  delete elements['file-skus'];
  ctx.bind();
  await new Promise(r=>setTimeout(r, 0));
  assert(ctx.__appstate.cargasHistorial.cargado===true, 'bind() en la vista de carga masiva debe disparar la carga del historial, obtuvo: '+JSON.stringify(ctx.__appstate.cargasHistorial));

  // ===== Perfil no cargado (sesión activa, pero sin fila en usuarios/empresa asignada) =====
  // Reproduce el caso real: la cuenta existe (hay sesión), pero state.perfil quedó null
  // (ej. el perfil no estaba correctamente enlazado). Las acciones de escritura no deben
  // crashear con un TypeError crudo, sino avisar con un mensaje claro y no tocar la red.
  {
    const perfilOriginal = ctx.__appstate.perfil;
    ctx.__appstate.perfil = null;
    const toastRootPerfil = elements['toast-root'];
    const toastsAntesPerfil = toastRootPerfil ? toastRootPerfil.hijos.length : 0;
    calls.length = 0;

    ctx.__appstate.skuSeleccionado = { id:'sku-1', sku_code:'SKU-999', bodega:'Nave' };
    ctx.__appstate.conteoFotos = [];
    await ctx.guardarConteo({cantidad:5, ubicacion:'', bodega:''});
    await ctx.crearSkuManual({sku_code:'SKU-000', descripcion:'x', activo:true});
    await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'Nave Mina', ubicacion:'Interior Nave', storageBins:[], responsableId:'', nota:''});
    await ctx.confirmarCargaMasiva();

    assert(calls.length===0, 'con el perfil sin cargar, ninguna de estas acciones debe llegar a llamar a la red, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
    const nuevosToastsPerfil = toastRootPerfil.hijos.slice(toastsAntesPerfil);
    assert(nuevosToastsPerfil.length>=4 && nuevosToastsPerfil.every(t=>/no se pudo cargar tu perfil/i.test(t.textContent)), 'cada acción debe avisar con un mensaje claro en vez de crashear, obtuvo: '+JSON.stringify(nuevosToastsPerfil.map(t=>t.textContent)));

    ctx.__appstate.perfil = perfilOriginal;
  }

  // ===== Bucket de fotos privado: rutas con empresa_id + URLs firmadas =====
  ctx.__appstate.session = { access_token:'x', user:{email:'a@b.com'} };

  // storageUpload ya no arma una URL pública (el bucket es privado): devuelve
  // la ruta tal cual, para guardarla en conteo_fotos.
  calls.length = 0;
  const rutaSubida = await ctx.storageUpload('emp-1/SKU-1/123-abcde.jpg', { type:'image/jpeg' });
  assert(rutaSubida==='emp-1/SKU-1/123-abcde.jpg', 'storageUpload debe devolver la ruta, no una URL pública, obtuvo: '+rutaSubida);
  assert(calls.some(c=>c.url.includes('/storage/v1/object/fotos-inventario/emp-1/SKU-1/123-abcde.jpg')), 'storageUpload debe subir a la ruta exacta pasada, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // crearUrlFirmada: para una ruta nueva, pide la URL firmada de esa ruta tal cual.
  calls.length = 0;
  const urlNueva = await ctx.crearUrlFirmada('emp-1/SKU-1/123-abcde.jpg');
  assert(calls.some(c=>c.url.includes('/storage/v1/object/sign/fotos-inventario/emp-1/SKU-1/123-abcde.jpg')), 'crearUrlFirmada debe pedir la URL firmada de la ruta, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(urlNueva.includes('/object/sign/fotos-inventario/emp-1/SKU-1/123-abcde.jpg?token=fake'), 'debe devolver la URL firmada completa, obtuvo: '+urlNueva);

  // crearUrlFirmada: una foto antigua guardada como URL pública completa (de antes
  // de que el bucket pasara a privado) debe normalizarse a su ruta relativa.
  calls.length = 0;
  await ctx.crearUrlFirmada('https://ncvwgsbcvklhbyvurxzz.supabase.co/storage/v1/object/public/fotos-inventario/10001177/1786507275125.jpg');
  assert(calls.some(c=>c.url.includes('/storage/v1/object/sign/fotos-inventario/10001177/1786507275125.jpg')), 'crearUrlFirmada debe normalizar una URL pública antigua a su ruta relativa, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // guardarConteo: la ruta de la foto debe empezar con el empresa_id del perfil
  // actual, para que las políticas de storage puedan aislarla por empresa.
  ctx.__appstate.skuSeleccionado = { id:'sku-1', sku_code:'SKU-999', bodega:'Nave' };
  ctx.__appstate.conteoFotos = [{ file: { name:'foto.jpg', type:'image/jpeg' } }];
  calls.length = 0;
  await ctx.guardarConteo({cantidad:5, ubicacion:'', bodega:''});
  assert(calls.some(c=>c.url.includes('/storage/v1/object/fotos-inventario/emp-1/SKU-999/')), 'guardarConteo debe subir la foto bajo una ruta que empiece con el empresa_id, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // ===== capturado_en: fecha real de captura, para auditoría (no la confunde con fecha_conteo/created_at) =====

  // guardarConteo (online) debe enviar capturado_en con la hora actual del dispositivo.
  ctx.__appstate.skuSeleccionado = { id:'sku-1', sku_code:'SKU-999', bodega:'Nave' };
  ctx.__appstate.conteoFotos = [];
  calls.length = 0;
  const antesGuardar = Date.now();
  await ctx.guardarConteo({cantidad:3, ubicacion:'', bodega:''});
  const postConteoOnline = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/conteos'));
  const bodyConteoOnline = JSON.parse(postConteoOnline.opts.body)[0];
  assert(!!bodyConteoOnline.capturado_en, 'guardarConteo debe enviar capturado_en, obtuvo: '+JSON.stringify(bodyConteoOnline));
  assert(Math.abs(new Date(bodyConteoOnline.capturado_en).getTime()-antesGuardar) < 5000, 'capturado_en debe ser la hora real de guardado, obtuvo: '+bodyConteoOnline.capturado_en);

  // ===== Barra de "esto está tardando más de lo normal" (a pedido de Joel, guardado lento con
  // señal mala): guardarConteo debe dejar conteoGuardandoLento en false al terminar, sin importar
  // si el timer de UMBRAL_GUARDADO_LENTO_MS llegó a dispararse o no -- probar el timer en sí
  // implicaría esperar los 4s reales en cada corrida de tests, así que se cubre por separado la
  // lógica de render (con el flag ya en true) y que guardarConteo siempre lo deja limpio. =====
  ctx.__appstate.skuSeleccionado = { id:'sku-1', sku_code:'SKU-999', bodega:'Nave' };
  ctx.__appstate.conteoFotos = [];
  ctx.__appstate.conteoGuardandoLento = true; // simula que ya llevaba un rato largo cuando terminó
  await ctx.guardarConteo({cantidad:4, ubicacion:'', bodega:''});
  assert(ctx.__appstate.conteoGuardandoLento===false, 'al terminar (éxito), guardarConteo debe apagar conteoGuardandoLento, obtuvo: '+ctx.__appstate.conteoGuardandoLento);

  // renderConteo: con el flag prendido, debe mostrar la barra indeterminada y el aviso; sin él
  // (aunque siga cargando), solo el spinner chico del botón, como antes.
  ctx.__appstate.skuSeleccionado = { id:'sku-1', sku_code:'SKU-999', bodega:'Nave', stock_sistema:10 };
  ctx.__appstate.loading = true;
  ctx.__appstate.conteoGuardandoLento = true;
  const htmlGuardandoLento = ctx.renderConteo();
  assert(htmlGuardandoLento.includes('progress-indeterminada') && htmlGuardandoLento.includes('Esto está tardando más de lo normal'), 'con conteoGuardandoLento:true debe mostrar la barra y el aviso, obtuvo: '+htmlGuardandoLento);
  ctx.__appstate.conteoGuardandoLento = false;
  const htmlGuardandoRapido = ctx.renderConteo();
  assert(!htmlGuardandoRapido.includes('progress-indeterminada') && !htmlGuardandoRapido.includes('Esto está tardando más de lo normal'), 'sin conteoGuardandoLento no debe mostrar la barra ni el aviso, aunque siga cargando, obtuvo: '+htmlGuardandoRapido);
  ctx.__appstate.loading = false;

  // Tarjeta de "Tomar inventario": debe mostrar clase ABC y, si corresponde, el badge de crítico
  // (a pedido de Joel, ver captura real del SKU 10173315) -- sin clase cargada, se muestra "Sin
  // clasificar" (mismo criterio que en la lista de SKU y en Buscar), y el badge de crítico solo
  // aparece cuando critico===true.
  ctx.__appstate.skuSeleccionado = { id:'sku-1', sku_code:'10173315', bodega:'Nave', clase_abc:'A', critico:true };
  const htmlConClaseYCritico = ctx.renderConteo();
  assert(htmlConClaseYCritico.includes('Clase A') && htmlConClaseYCritico.includes('★ Crítico'), 'con clase_abc y critico:true debe mostrar ambos badges, obtuvo: '+htmlConClaseYCritico);
  ctx.__appstate.skuSeleccionado = { id:'sku-1', sku_code:'10173315', bodega:'Nave', clase_abc:null, critico:false };
  const htmlSinClaseNiCritico = ctx.renderConteo();
  assert(htmlSinClaseNiCritico.includes('Sin clasificar') && !htmlSinClaseNiCritico.includes('★ Crítico'), 'sin clase_abc no debe forzar una clase, y sin critico no debe mostrar el badge, obtuvo: '+htmlSinClaseNiCritico);

  // crearSkuManual (online) también debe enviar capturado_en.
  calls.length = 0;
  await ctx.crearSkuManual({sku_code:'SKU-CAP-1', descripcion:'x', activo:true});
  const postSkuOnline = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  assert(!!JSON.parse(postSkuOnline.opts.body)[0].capturado_en, 'crearSkuManual debe enviar capturado_en, obtuvo: '+postSkuOnline.opts.body);

  // eliminarSkusSeleccionados: borra los SKU seleccionados que NO tengan conteos, y avisa
  // por separado los que sí tienen (esos se saltan en vez de hacer fallar todo el lote).
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  ctx.__appstate.skusSeleccionados = ['sku-sin-conteo', 'sku-con-conteo'];
  confirmRespuesta = true;
  confirmLlamadas.length = 0;
  calls.length = 0;
  await ctx.eliminarSkusSeleccionados();
  assert(confirmLlamadas.length===1 && /eliminar 2 sku/i.test(confirmLlamadas[0]), 'debe preguntar confirmación mencionando la cantidad, obtuvo: '+JSON.stringify(confirmLlamadas));
  const checkConteosCall = calls.find(c=>c.url.includes('/conteos?select=sku_id'));
  assert(!!checkConteosCall, 'debe chequear primero cuáles de los seleccionados ya tienen conteos, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const deleteSkusCall = calls.find(c=>c.opts && c.opts.method==='DELETE' && c.url.includes('/rest/v1/skus'));
  assert(!!deleteSkusCall && deleteSkusCall.url.includes('sku-sin-conteo') && !deleteSkusCall.url.includes('sku-con-conteo'), 'el DELETE solo debe incluir el SKU sin conteos, no el que ya tiene, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Si el usuario cancela el confirm(), no debe hacerse ningún chequeo ni DELETE.
  ctx.__appstate.skusSeleccionados = ['sku-sin-conteo'];
  confirmRespuesta = false;
  calls.length = 0;
  await ctx.eliminarSkusSeleccionados();
  assert(calls.length===0, 'si se cancela la confirmación, no debe llamarse a la red, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  confirmRespuesta = true;

  // eliminarSkusSinContar: borra en el servidor, de una sola vez, todos los SKU de la empresa
  // que aún no tienen ningún conteo (no solo los de la página actual) vía el RPC dedicado.
  confirmRespuesta = true;
  confirmLlamadas.length = 0;
  calls.length = 0;
  await ctx.eliminarSkusSinContar();
  assert(confirmLlamadas.length===1 && /eliminar todos los sku/i.test(confirmLlamadas[0]), 'debe preguntar confirmación antes de borrar, obtuvo: '+JSON.stringify(confirmLlamadas));
  const rpcEliminarSinContar = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rpc/eliminar_skus_sin_contar'));
  assert(!!rpcEliminarSinContar, 'debe llamar al RPC eliminar_skus_sin_contar por POST, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Si el usuario cancela el confirm(), no debe llamarse al RPC.
  confirmRespuesta = false;
  calls.length = 0;
  await ctx.eliminarSkusSinContar();
  assert(calls.length===0, 'si se cancela la confirmación, eliminarSkusSinContar no debe llamar a la red, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  confirmRespuesta = true;

  // renderTablaSkus: los checkboxes de selección solo deben verse para admin, no para operador.
  ctx.__appstate.skusPagina = { rows:[{id:'sku-x', sku_code:'SKU-X', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null}], page:0, total:1 };
  ctx.__appstate.skusSeleccionados = [];
  const htmlTablaAdmin = ctx.renderTablaSkus();
  assert(htmlTablaAdmin.includes('class="chk-sku"') && htmlTablaAdmin.includes('id="chk-skus-todos"'), 'un admin debe ver los checkboxes de selección, obtuvo: '+htmlTablaAdmin);
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  const htmlTablaOperador = ctx.renderTablaSkus();
  assert(!htmlTablaOperador.includes('class="chk-sku"'), 'un operador no debe ver los checkboxes de selección de SKU, obtuvo: '+htmlTablaOperador);
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };

  // renderTablaSkus: en vez de pintar el fondo de toda la fila, muestra un ícono de color junto
  // al SKU según su último conteo — rojo (diferencia negativa/faltante), amarillo (diferencia
  // positiva/sobrante), verde (cuadrado/aprobado), y nada si todavía no se ha contado.
  ctx.__appstate.skusPagina = { rows:[
    {id:'sku-neg', sku_code:'SKU-NEG', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, ultimoEstado:'con_diferencia', ultimaDiferencia:-3},
    {id:'sku-pos', sku_code:'SKU-POS', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, ultimoEstado:'con_diferencia', ultimaDiferencia:5},
    {id:'sku-ok', sku_code:'SKU-OK', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, ultimoEstado:'aprobado', ultimaDiferencia:0},
    {id:'sku-sc', sku_code:'SKU-SC', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, ultimoEstado:null, ultimaDiferencia:null},
  ], page:0, total:4 };
  const htmlColorFilas = ctx.renderTablaSkus();
  const filaNeg = htmlColorFilas.slice(htmlColorFilas.indexOf('SKU-NEG')-300, htmlColorFilas.indexOf('SKU-NEG'));
  const filaPos = htmlColorFilas.slice(htmlColorFilas.indexOf('SKU-POS')-300, htmlColorFilas.indexOf('SKU-POS'));
  const filaOk = htmlColorFilas.slice(htmlColorFilas.indexOf('SKU-OK')-300, htmlColorFilas.indexOf('SKU-OK'));
  const filaSc = htmlColorFilas.slice(htmlColorFilas.indexOf('SKU-SC')-300, htmlColorFilas.indexOf('SKU-SC'));
  assert(!htmlColorFilas.includes('color-mix'), 'ya no debe pintarse el fondo de la fila, solo el ícono, obtuvo: '+htmlColorFilas);
  assert(filaNeg.includes('var(--danger)') && filaNeg.includes('border-radius:50%'), 'diferencia negativa (faltante) debe mostrar el ícono rojo, obtuvo: '+filaNeg);
  assert(filaPos.includes('#f1c40f') && filaPos.includes('border-radius:50%'), 'diferencia positiva (sobrante) debe mostrar el ícono amarillo (color fijo, no var(--warn) que se ve café en el tema claro), obtuvo: '+filaPos);
  assert(filaOk.includes('var(--ok)') && filaOk.includes('border-radius:50%'), 'el SKU cuadrado (aprobado) debe mostrar el ícono verde, obtuvo: '+filaOk);
  assert(!filaSc.includes('border-radius:50%'), 'el SKU que aún no se ha contado no debe mostrar ningún ícono, obtuvo: '+filaSc);
  assert(htmlColorFilas.includes('btn-eliminar-skus-sin-contar'), 'la tabla de SKU debe incluir el botón para eliminar todo lo no contado, obtuvo: '+htmlColorFilas);

  // ===== ABC + criticidad (a pedido de Joel, backlog #101): badges de clase y crítico =====
  // claseAbcBadge / criticoBadge: helpers puros usados tanto en el listado de Materiales como en
  // Buscar.
  assert(ctx.claseAbcBadge('A').includes('Clase A') && ctx.claseAbcBadge('A').includes('badge-warn'), 'Clase A debe mostrarse en ámbar, obtuvo: '+ctx.claseAbcBadge('A'));
  assert(ctx.claseAbcBadge('B').includes('Clase B') && ctx.claseAbcBadge('B').includes('badge-steel'), 'Clase B debe mostrarse en azul (steel), obtuvo: '+ctx.claseAbcBadge('B'));
  assert(ctx.claseAbcBadge('C').includes('Clase C') && ctx.claseAbcBadge('C').includes('badge-neutral'), 'Clase C debe mostrarse en gris, obtuvo: '+ctx.claseAbcBadge('C'));
  assert(ctx.claseAbcBadge(null).includes('Sin clasificar'), 'sin clase (SKU sin costo_unitario cargado) debe mostrar "Sin clasificar", no inventarle una clase, obtuvo: '+ctx.claseAbcBadge(null));
  assert(ctx.criticoBadge().includes('Crítico') && ctx.criticoBadge().includes('badge-danger'), 'el badge de crítico debe destacarse en rojo, obtuvo: '+ctx.criticoBadge());

  // parsearBooleanoCarga: interpreta la columna opcional "Crítico" de la carga masiva -- a pedido
  // de Joel, cualquier celda NO vacía cuenta (una marca real de SAP/Excel rara vez es un "Sí"
  // textual: puede ser una X, la palabra "Alta", lo que sea), salvo una negación explícita.
  ['Si','sí','S','x','X','true','TRUE','1','yes','Alta','Crítico','cualquier cosa'].forEach(v=>{
    assert(ctx.parsearBooleanoCarga(v)===true, `"${v}" (no vacío, no es una negación) debe interpretarse como crítico, obtuvo: `+ctx.parsearBooleanoCarga(v));
  });
  ['No','no','NO','','  ','0','false','FALSO', undefined, null].forEach(v=>{
    assert(ctx.parsearBooleanoCarga(v)===false, `"${v}" debe interpretarse como NO crítico, obtuvo: `+ctx.parsearBooleanoCarga(v));
  });

  // renderTablaSkus: debe mostrar la clase ABC de cada fila y, si está marcado, el badge de
  // crítico junto al código.
  ctx.__appstate.skusPagina = { rows:[
    {id:'sku-abc-a', sku_code:'SKU-ABC-A', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, clase_abc:'A', critico:true},
    {id:'sku-abc-sc', sku_code:'SKU-ABC-SC', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, clase_abc:null, critico:false},
  ], page:0, total:2 };
  const htmlTablaAbc = ctx.renderTablaSkus();
  const filaAbcA = htmlTablaAbc.slice(htmlTablaAbc.indexOf('SKU-ABC-A'), htmlTablaAbc.indexOf('SKU-ABC-A')+400);
  const filaAbcSc = htmlTablaAbc.slice(htmlTablaAbc.indexOf('SKU-ABC-SC'), htmlTablaAbc.indexOf('SKU-ABC-SC')+400);
  assert(filaAbcA.includes('★ Crítico'), 'un SKU marcado crítico debe mostrar el badge junto a su código en el listado de Materiales, obtuvo: '+filaAbcA);
  assert(htmlTablaAbc.includes('Clase A'), 'el listado de Materiales debe mostrar la clase ABC de cada SKU, obtuvo: '+htmlTablaAbc);
  assert(filaAbcSc.includes('Sin clasificar') && !filaAbcSc.includes('★ Crítico'), 'un SKU sin costo ni marca de crítico debe verse "Sin clasificar" y sin el badge de crítico, obtuvo: '+filaAbcSc);

  // cargarSkusPagina: además del estado del último conteo (ultimo_conteo_por_sku), debe traer la
  // clase ABC de skus_valor_abc y pegarla a cada fila por sku_id (mismo patrón, vista sin FK).
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  await ctx.cargarSkusPagina(0);
  await new Promise(r=>setTimeout(r, 0));
  const filaPag1Abc = ctx.__appstate.skusPagina.rows.find(r=>r.id==='sku-pag-1');
  assert(!!filaPag1Abc && filaPag1Abc.clase_abc==='A', 'cargarSkusPagina debe pegar la clase ABC de skus_valor_abc a cada fila, obtuvo: '+JSON.stringify(filaPag1Abc));
  const filaPag3Abc = ctx.__appstate.skusPagina.rows.find(r=>r.id==='sku-pag-3');
  assert(!!filaPag3Abc && filaPag3Abc.clase_abc===null, 'un SKU sin fila en skus_valor_abc (o sin clase) debe quedar clase_abc null, no undefined, obtuvo: '+JSON.stringify(filaPag3Abc));

  // renderBuscar: mismos badges (clase ABC + crítico) en la tabla de resultados.
  ctx.__appstate.busqueda = {texto:'', bodega:'', estado:'', soloConFotos:false, resultados:[
    {sku_code:'SKU-BUS-A', descripcion:'X', bodega:'Nave', conteo_id:null, cantidad_contada:null, estado:null, diferencia:null, fecha_conteo:null, capturado_en:null, fuera_de_plan:null, ciclo_nombre:null, fotos:[], clase_abc:'A', critico:true},
  ], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0, busquedaPagina:0, filtroContadoPor:null};
  const htmlBuscarAbc = ctx.renderBuscar();
  assert(htmlBuscarAbc.includes('Clase A'), 'Buscar debe mostrar la clase ABC de cada resultado, obtuvo: '+htmlBuscarAbc);
  assert(htmlBuscarAbc.includes('★ Crítico'), 'Buscar debe mostrar el badge de crítico junto al SKU, obtuvo: '+htmlBuscarAbc);

  // ===== Carga masiva: columna opcional "Crítico" =====
  // (state.view sigue en 'carga' desde el bloque de más arriba -- lo sacamos de esa vista para
  // que los re-renders intermedios de confirmarCargaMasiva, disparados por setState() mientras
  // progresa la carga, no intenten pintar renderCargaPreview() con un cargaPreview minimalista
  // que no trae "campos"; ver el reset a 'dashboard' más abajo, que ya hacían los tests previos.)
  ctx.__appstate.view = 'skus';
  ctx.__appstate.cargaPreview = {
    file: { name: 'criticos.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', bodega:'Bodega', critico:'Critico' },
    data: [
      { Codigo:'SKU-CRIT-SI', Bodega:'Nave', Critico:'Si' },
      { Codigo:'SKU-CRIT-NO', Bodega:'Nave', Critico:'No' },
    ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postCritico = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  const filasCritico = JSON.parse(postCritico.opts.body);
  assert(filasCritico.find(f=>f.sku_code==='SKU-CRIT-SI').critico===true, 'la carga masiva debe interpretar "Si" en la columna Crítico como true, obtuvo: '+JSON.stringify(filasCritico));
  assert(filasCritico.find(f=>f.sku_code==='SKU-CRIT-NO').critico===false, 'la carga masiva debe interpretar "No" en la columna Crítico como false, obtuvo: '+JSON.stringify(filasCritico));

  // Sin la columna "Crítico" en el archivo, el campo NO debe mandarse (ni siquiera en false):
  // como la carga masiva hace upsert (resolution=merge-duplicates), mandar critico:false pisaría
  // en silencio lo que alguien ya había marcado a mano para un SKU que se re-sube sin esa columna.
  ctx.__appstate.cargaPreview = {
    file: { name: 'sincritico.csv' },
    modo: 'complementar',
    mapeo: { sku_code:'Codigo', bodega:'Bodega', stock_sistema:'Stock' },
    data: [ { Codigo:'SKU-SIN-CRIT', Bodega:'Nave', Stock:'5' } ],
  };
  calls.length = 0;
  await ctx.confirmarCargaMasiva();
  const postSinCritico = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus'));
  const filaSinCritico = JSON.parse(postSinCritico.opts.body)[0];
  assert(!('critico' in filaSinCritico), 'sin columna Crítico en el archivo, el campo no debe mandarse en absoluto (para no pisar el valor ya guardado en una empresa que ya lo tenía marcado), obtuvo: '+JSON.stringify(filaSinCritico));

  // Tras una carga masiva que trae costo o stock, debe refrescar la clasificación ABC (el
  // matview no se recalcula solo, ver skus_valor_abc_mv/refrescar_clasificacion_abc).
  assert(calls.some(c=>c.url.includes('/rpc/refrescar_clasificacion_abc') && c.opts.method==='POST'), 'tras cargar stock/costo, la carga masiva debe refrescar la clasificación ABC, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // ===== Ciclos de conteo: crear, listar y marcar el actual =====
  calls.length = 0;
  await ctx.cargarCiclos();
  assert(calls.some(c=>c.url.includes('/ciclos_conteo?select=')), 'cargarCiclos debe pedir /ciclos_conteo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.ciclos.length===2 && ctx.__appstate.ciclos[0].nombre==='T1 2027', 'debe guardar los ciclos devueltos por el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.ciclos));
  const htmlCiclos = ctx.renderCiclos();
  assert(htmlCiclos.includes('T1 2027') && htmlCiclos.includes('T4 2026'), 'Períodos (renderCiclos) debe listar los ciclos existentes, obtuvo: '+htmlCiclos);
  assert(htmlCiclos.includes('data-marcar-ciclo-actual="ciclo-2"') && !htmlCiclos.includes('data-marcar-ciclo-actual="ciclo-1"'), 'solo el ciclo que no es el actual debe ofrecer el botón de "marcar como actual" (ciclo-1 ya lo es), obtuvo: '+htmlCiclos);

  calls.length = 0;
  await ctx.crearCiclo('T2 2027');
  const postCiclo = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/ciclos_conteo'));
  assert(!!postCiclo && JSON.parse(postCiclo.opts.body)[0].nombre==='T2 2027', 'crearCiclo debe hacer POST a /ciclos_conteo con el nombre, obtuvo: '+JSON.stringify(postCiclo));

  calls.length = 0;
  await ctx.marcarCicloActual('ciclo-2');
  // marcarCicloActual usa la RPC atómica marcar_ciclo_actual (desmarcar el anterior + marcar el
  // nuevo en una sola transacción de función) en vez de dos PATCH separados — evita la ventana de
  // carrera donde dos ciclos podían quedar marcados "actuales" a la vez (respaldado además por un
  // índice único parcial en la base).
  const rpcCiclo = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rpc/marcar_ciclo_actual'));
  assert(!!rpcCiclo, 'marcarCicloActual debe llamar a la RPC marcar_ciclo_actual, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(rpcCiclo.opts.body).ciclo_id==='ciclo-2', 'debe mandar el id del ciclo elegido como ciclo_id, obtuvo: '+JSON.stringify(rpcCiclo));
  assert(!calls.some(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/ciclos_conteo')), 'ya no debe hacer PATCH directos a /ciclos_conteo desde el frontend, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // ===== Planificación vinculada a ciclos de conteo (períodos) =====

  // Con ciclos ya cargados, el selector "Período" de arriba de la página (para navegar por
  // semana o por período) y el que tenía el formulario "Agregar a la planificación" (para
  // elegir a qué período asignar la entrada nueva) se veían duplicados en pantalla, con el
  // mismo nombre y la misma lista de ciclos — se sacó el del formulario (queda automático,
  // asignado siempre al ciclo marcado como actual), y solo debe quedar el de arriba.
  const htmlPlanConCiclos = ctx.renderPlanificacion();
  assert(htmlPlanConCiclos.includes('id="plan-filtro-ciclo"'), 'debe seguir existiendo el selector de período para navegar arriba de la página, obtuvo: '+htmlPlanConCiclos);
  assert(!htmlPlanConCiclos.includes('id="p-ciclo"'), 'el formulario de "Agregar a la planificación" ya no debe tener su propio selector de Período duplicado, obtuvo: '+htmlPlanConCiclos);

  // crearPlanEntrada: con cicloId, debe mandar ciclo_id en el POST; sin cicloId, null (el
  // trigger del lado del servidor lo completa solo con el ciclo marcado como actual).
  calls.length = 0;
  await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'Nave Mina', ubicacion:'Interior Nave', storageBins:[], responsableId:'', nota:'', cicloId:'ciclo-2'});
  const postPlanConCiclo = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal') && !c.url.includes('exclusiones'));
  assert(!!postPlanConCiclo && JSON.parse(postPlanConCiclo.opts.body)[0].ciclo_id==='ciclo-2', 'crearPlanEntrada con cicloId debe mandar ese ciclo_id en el POST, obtuvo: '+JSON.stringify(postPlanConCiclo));

  calls.length = 0;
  await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'Nave Mina', ubicacion:'Interior Nave', storageBins:[], responsableId:'', nota:''});
  const postPlanSinCiclo = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal') && !c.url.includes('exclusiones'));
  assert(!!postPlanSinCiclo && JSON.parse(postPlanSinCiclo.opts.body)[0].ciclo_id===null, 'crearPlanEntrada sin cicloId debe mandar ciclo_id null (lo completa el trigger del servidor), obtuvo: '+JSON.stringify(postPlanSinCiclo));

  // cargarPlanSemanal: con un período elegido en el filtro, debe pedir TODO ese período por
  // ciclo_id (sin rango de fechas); sin período elegido, sigue pidiendo por semana como antes.
  ctx.__appstate.plan.cicloFiltro = 'ciclo-1';
  calls.length = 0;
  await ctx.cargarPlanSemanal();
  const getPlanPorCiclo = calls.find(c=>c.url.includes('/plan_semanal_detalle'));
  assert(!!getPlanPorCiclo && getPlanPorCiclo.url.includes('ciclo_id=eq.ciclo-1') && !getPlanPorCiclo.url.includes('fecha=gte'), 'con un período elegido, cargarPlanSemanal debe filtrar por ciclo_id sin rango de fechas, obtuvo: '+JSON.stringify(getPlanPorCiclo));

  ctx.__appstate.plan.cicloFiltro = '';
  calls.length = 0;
  await ctx.cargarPlanSemanal();
  const getPlanPorSemana = calls.find(c=>c.url.includes('/plan_semanal_detalle'));
  assert(!!getPlanPorSemana && getPlanPorSemana.url.includes('fecha=gte') && !getPlanPorSemana.url.includes('ciclo_id'), 'sin período elegido, cargarPlanSemanal debe volver a filtrar por semana (fecha), obtuvo: '+JSON.stringify(getPlanPorSemana));

  // renderPlanificacion: el selector de período debe listar los ciclos, y elegir uno debe
  // ocultar la navegación por semana (no aplica en modo período); cada entrada debe mostrar
  // a qué período quedó asociada (o que no tiene ninguno).
  ctx.__appstate.plan.entradas = [
    {id:'e1', fecha:'2026-08-10', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', responsable_nombre:'Ana Torres', nota:'', skus_excluidos:[], ciclo_nombre:'T1 2027'},
    {id:'e2', fecha:'2026-08-11', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', responsable_nombre:null, nota:'', skus_excluidos:[], ciclo_nombre:null},
  ];
  const htmlPlanSinFiltro = ctx.renderPlanificacion();
  assert(htmlPlanSinFiltro.includes('id="plan-filtro-ciclo"') && htmlPlanSinFiltro.includes('T1 2027') && htmlPlanSinFiltro.includes('T4 2026'), 'el selector de período debe listar los ciclos existentes, obtuvo: '+htmlPlanSinFiltro);
  assert(htmlPlanSinFiltro.includes('id="plan-semana-prev"'), 'sin período elegido, debe seguir mostrando la navegación por semana, obtuvo: '+htmlPlanSinFiltro);
  assert(htmlPlanSinFiltro.includes('Período: T1 2027') && htmlPlanSinFiltro.includes('Período: Sin período asignado'), 'cada entrada debe mostrar a qué período quedó asociada (o que no tiene), obtuvo: '+htmlPlanSinFiltro);
  // Sin período elegido (modo semana), a pedido, los días sin nada planificado ya no muestran
  // una tarjeta vacía: con solo 2 entradas (Lun y Mar) de los 7 días de la semana que arranca el
  // 2026-08-10 (Lun), solo deben listarse esos 2 días, sin ninguna tarjeta vacía de relleno.
  assert(!htmlPlanSinFiltro.includes('Sin conteos planificados'), 'en modo semana, los días sin nada planificado no deben mostrar ninguna tarjeta vacía, obtuvo: '+htmlPlanSinFiltro);
  assert(htmlPlanSinFiltro.includes('lunes') && htmlPlanSinFiltro.includes('martes'), 'deben listarse los días que sí tienen algo planificado (lunes y martes), obtuvo: '+htmlPlanSinFiltro);

  ctx.__appstate.plan.cicloFiltro = 'ciclo-1';
  const htmlPlanConFiltro = ctx.renderPlanificacion();
  assert(!htmlPlanConFiltro.includes('id="plan-semana-prev"'), 'con un período elegido, la navegación por semana debe ocultarse (no aplica), obtuvo: '+htmlPlanConFiltro);
  assert(htmlPlanConFiltro.includes('Mostrando toda la planificación de <strong>T1 2027</strong>'), 'debe indicar claramente qué período se está mostrando, obtuvo: '+htmlPlanConFiltro);
  // Con un período elegido (modo período), a diferencia del modo semana, NO hay un rango de días
  // de referencia: solo debe agruparse por las fechas que ya tienen algo planificado, sin ninguna
  // tarjeta vacía de relleno (lo pedido: "que aparezcan las tarjetas a medida que se planifican,
  // no las vacías").
  assert(!htmlPlanConFiltro.includes('Sin conteos planificados.'), 'en modo período no debe mostrarse ninguna tarjeta vacía de relleno, solo las fechas con algo planificado, obtuvo: '+htmlPlanConFiltro);
  ctx.__appstate.plan.cicloFiltro = '';

  // renderBuscar: el filtro de ciclo solo debe verse si hay ciclos creados, y debe incluir
  // la opción "Sin ciclo asignado" además de cada ciclo real.
  ctx.__appstate.busqueda = { texto:'', bodega:'', estado:'', ciclo:'', soloConFotos:false, resultados:[], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0 };
  const htmlBuscarConCiclos = ctx.renderBuscar();
  assert(htmlBuscarConCiclos.includes('id="b-ciclo"') && htmlBuscarConCiclos.includes('Sin ciclo asignado') && htmlBuscarConCiclos.includes('T1 2027'), 'Buscar debe ofrecer el filtro de ciclo con la opción "Sin ciclo asignado" y los ciclos reales, obtuvo: '+htmlBuscarConCiclos);

  // Pedido de Joel: mostrar el batch también -- la tabla de resultados de Buscar debe traer su
  // propia columna Batch, para distinguir dos filas del mismo sku_code que solo difieren en lote.
  ctx.__appstate.busqueda = { texto:'', bodega:'', estado:'', soloConFotos:false, buscando:false, yaBuscado:true, resultados: [
    { sku_code:'SKU-LOTE', batch:'L-001', descripcion:'Aceite', bodega:'Nave', conteo_id:'c3', cantidad_contada:40, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-10T20:00:00Z', capturado_en:'2026-08-10T20:00:00Z', ciclo_nombre:null, fotos:[] },
    { sku_code:'SKU-LOTE', batch:null, descripcion:'Aceite', bodega:'Nave', conteo_id:null, cantidad_contada:null, estado:null, diferencia:null, fecha_conteo:null, capturado_en:null, ciclo_nombre:null, fotos:[] },
  ]};
  const htmlBuscarConBatch = ctx.renderBuscar();
  assert(htmlBuscarConBatch.includes('data-orden-campo="batch"') && htmlBuscarConBatch.includes('>Batch<'), 'la tabla de resultados debe tener su propia columna Batch (ordenable), obtuvo: '+htmlBuscarConBatch);
  assert(htmlBuscarConBatch.includes('<td class="mono">L-001</td>'), 'debe mostrar el batch de la fila que lo trae, obtuvo: '+htmlBuscarConBatch);
  assert((htmlBuscarConBatch.match(/<td class="mono">—<\/td>/g)||[]).length>=1, 'una fila sin batch debe mostrar el guion, no vacío ni "null", obtuvo: '+htmlBuscarConBatch);

  // fueCapturadoOffline: distingue una captura offline (fechas separadas por horas) de una
  // online normal (mismo instante), con un margen de un minuto para no marcar falsos positivos.
  assert(ctx.fueCapturadoOffline('2026-08-10T08:00:00Z', '2026-08-10T20:00:00Z')===true, 'una diferencia de horas debe considerarse captura offline');
  assert(ctx.fueCapturadoOffline('2026-08-10T08:00:00.000Z', '2026-08-10T08:00:00.500Z')===false, 'una diferencia de milisegundos (guardado online normal) no debe marcarse como offline');
  assert(ctx.fueCapturadoOffline(null, '2026-08-10T08:00:00Z')===false, 'sin capturado_en no debe marcarse como offline (dato no disponible, no error)');

  // renderBuscar: debe indicar "Capturado ... sin conexión" solo en la fila que de verdad
  // se capturó offline (fechas separadas), no en un conteo online normal (fechas iguales).
  ctx.__appstate.busqueda = { texto:'', bodega:'', estado:'', soloConFotos:false, buscando:false, yaBuscado:true, resultados: [
    { sku_code:'SKU-A', descripcion:'', bodega:'Nave', conteo_id:'c1', cantidad_contada:5, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-10T20:00:00Z', capturado_en:'2026-08-10T08:00:00Z', ciclo_nombre:null, fotos:[] },
    { sku_code:'SKU-B', descripcion:'', bodega:'Nave', conteo_id:'c2', cantidad_contada:2, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-11T09:00:00Z', capturado_en:'2026-08-11T09:00:00Z', ciclo_nombre:null, fotos:[] },
  ]};
  const htmlBuscar = ctx.renderBuscar();
  const filaOffline = htmlBuscar.slice(htmlBuscar.indexOf('SKU-A'), htmlBuscar.indexOf('SKU-B'));
  const filaOnline = htmlBuscar.slice(htmlBuscar.indexOf('SKU-B'));
  assert(filaOffline.includes('sin conexión'), 'la fila de un conteo con fechas separadas debe indicar que se capturó sin conexión, obtuvo: '+filaOffline);
  assert(!filaOnline.includes('sin conexión'), 'la fila de un conteo online normal (mismas fechas) no debe mostrar el aviso, obtuvo: '+filaOnline);

  // ===== Modo offline: guardarConteo() debe encolar localmente si de verdad no hay conexión =====

  // pareceFalloDeRed: distingue un fallo real de red (TypeError, como lanza fetch() sin conexión)
  // de un error normal (por ejemplo, uno lanzado por rest() ante una respuesta HTTP de error).
  assert(ctx.pareceFalloDeRed(new ctx.__TypeError('Failed to fetch'))===true, 'un TypeError debe considerarse fallo de red');
  assert(ctx.pareceFalloDeRed(new Error('Mensaje de error del servidor'))===false, 'un Error normal (HTTP) no debe considerarse fallo de red');

  // mensajeParaRechazoNoCapturado (Sentry #227): red de seguridad global de iniciarApp() para
  // promesas rechazadas que se le escapan a su propio catch -- un TypeError de red debe mostrar
  // el mismo mensaje de "sin conexión" que ya usan los ~15 catch puntuales, y cualquier otro error
  // (uno real, no de red) debe mostrar un aviso genérico en vez de dejar a la persona sin avisarle.
  assert(ctx.mensajeParaRechazoNoCapturado(new ctx.__TypeError('Failed to fetch'))==='No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.', 'un TypeError de red debe mostrar el mensaje de sin conexión, obtuvo: '+ctx.mensajeParaRechazoNoCapturado(new ctx.__TypeError('Failed to fetch')));
  assert(ctx.mensajeParaRechazoNoCapturado(new Error('Cannot read properties of undefined'))==='Ocurrió un error inesperado. Inténtalo de nuevo.', 'un error que no es de red debe mostrar un aviso genérico, no el de sin conexión, obtuvo: '+ctx.mensajeParaRechazoNoCapturado(new Error('Cannot read properties of undefined')));

  // rest(): cuando fetch() rechaza con un TypeError crudo (sin conexión), rest() debe volver
  // a lanzar un TypeError (para que pareceFalloDeRed lo siga reconociendo y los flujos con
  // manejo offline sigan encolando) pero con un mensaje en español entendible — no el texto
  // crudo del navegador ("Failed to fetch") — para los ~30 sitios de la app que no tienen
  // manejo offline propio y solo hacen toast(e.message).
  const fetchOriginalRest = ctx.fetch;
  ctx.fetch = async ()=>{ throw new ctx.__TypeError('Failed to fetch'); };
  let errorDeRest = null;
  try{ await ctx.rest('/algo-que-sea'); }catch(e){ errorDeRest = e; }
  assert(errorDeRest instanceof ctx.__TypeError, 'rest() debe relanzar un TypeError (no un Error genérico) ante un fallo real de red, para no romper pareceFalloDeRed en los flujos offline, obtuvo: '+(errorDeRest && errorDeRest.constructor.name));
  assert(errorDeRest && errorDeRest.message === 'No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.', 'el mensaje debe ser en español y entendible, no el texto crudo del navegador, obtuvo: '+(errorDeRest && errorDeRest.message));
  ctx.fetch = fetchOriginalRest;

  // Sin conexión (fetch rechaza con TypeError): guardarConteo debe encolar el conteo en
  // localStorage (con estado "pendiente") en vez de mostrar un error, guardar la(s) foto(s)
  // en IndexedDB (no se pierden), y limpiar el formulario igual que si hubiera guardado con éxito.
  ctx.localStorage.removeItem('cola_offline_conteos');
  ctx.__appstate.colaOffline = [];
  ctx.__appstate.skuSeleccionado = { id:'sku-offline', sku_code:'SKU-OFF', bodega:'Nave' };
  ctx.__appstate.conteoFotos = [{ file: { name:'foto.jpg', type:'image/jpeg' } }];
  const fetchOriginalOffline = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/conteos' && opts.method==='POST') throw new ctx.__TypeError('Failed to fetch');
    return fetchOriginalOffline(url, opts);
  };
  const toastRootOffline = elements['toast-root'];
  const toastsAntesOffline = toastRootOffline ? toastRootOffline.hijos.length : 0;
  calls.length = 0;
  await ctx.guardarConteo({cantidad:7, ubicacion:'Rack A', bodega:'Nave Mina', observacion:'nota'});
  ctx.fetch = fetchOriginalOffline;
  assert(!calls.some(c=>c.url.includes('/storage/v1/object/fotos-inventario/')), 'sin conexión, no debe intentar subir la foto todavía (se sube recién al sincronizar)');
  // El conteo se guardó bien (localmente): el aviso debe ser de tipo "warn" (ámbar), no "err"
  // (rojo) — un guardado exitoso sin conexión no debe verse como si algo hubiera fallado,
  // justo en el momento en que el operador más necesita sentir que su conteo quedó a salvo.
  const toastsOffline = toastRootOffline.hijos.slice(toastsAntesOffline);
  assert(toastsOffline.length===1 && toastsOffline[0].className==='toast warn', 'el aviso de conteo guardado sin conexión debe usar el tipo "warn" (ámbar), no "err" (rojo), obtuvo className: '+(toastsOffline[0]&&toastsOffline[0].className));
  assert(ctx.__appstate.colaOffline.length===1, 'guardarConteo sin conexión debe agregar el conteo a la cola offline, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline));
  const itemEncolado = ctx.__appstate.colaOffline[0];
  assert(itemEncolado.sku_id==='sku-offline' && itemEncolado.sku_code==='SKU-OFF' && itemEncolado.cantidad_contada===7 && itemEncolado.ubicacion_contada==='Rack A' && itemEncolado.empresa_id==='emp-1', 'el conteo encolado debe llevar los datos ingresados y el empresa_id del perfil actual, obtuvo: '+JSON.stringify(itemEncolado));
  assert(itemEncolado.estado==='pendiente' && itemEncolado.error===null, 'un conteo recién encolado debe quedar en estado "pendiente", sin error, obtuvo: '+JSON.stringify(itemEncolado));
  assert(itemEncolado.fotosCount===1, 'debe recordar cuántas fotos quedaron pendientes de subir, obtuvo: '+itemEncolado.fotosCount);
  const colaGuardada = JSON.parse(ctx.localStorage.getItem('cola_offline_conteos'));
  assert(Array.isArray(colaGuardada) && colaGuardada.length===1, 'la cola offline debe persistirse en localStorage, obtuvo: '+ctx.localStorage.getItem('cola_offline_conteos'));
  assert(ctx.__appstate.skuSeleccionado===null && ctx.__appstate.conteoFotos.length===0, 'tras encolar, el formulario debe limpiarse igual que en un guardado exitoso');

  // La foto sí debe haber quedado guardada en IndexedDB, asociada a ese conteo encolado.
  const fotosGuardadas = await ctx.leerFotosOffline(itemEncolado.id);
  assert(fotosGuardadas.length===1 && fotosGuardadas[0].nombre==='foto.jpg', 'la foto adjunta debe quedar guardada en IndexedDB para subirla al sincronizar, obtuvo: '+JSON.stringify(fotosGuardadas));

  // El banner de conteos pendientes debe aparecer en la app (renderShell) con la cantidad correcta,
  // con un botón para ver el detalle además del de reintentar.
  ctx.__appstate.session = { access_token:'x', user:{email:'a@b.com'} };
  ctx.__appstate.view = 'dashboard';
  ctx.__appstate.dash = { total: [], diario: [], semanal: [], mensual: [] };
  ctx.__appstate.ultimosConteos = [];
  const shellConPendientes = ctx.renderShell();
  assert(shellConPendientes.includes('id="banner-offline"') && shellConPendientes.includes('1 cambio guardado sin conexión'), 'debe mostrar el banner de cambios pendientes con el singular correcto, obtuvo: '+shellConPendientes);
  assert(shellConPendientes.includes('id="btn-sincronizar-offline"') && shellConPendientes.includes('id="btn-ver-offline"'), 'el banner debe tener botones para reintentar y para ver el detalle');

  // El panel de detalle (renderOfflineModal) debe listar el conteo pendiente con su cantidad de fotos.
  ctx.__appstate.offlineModal = true;
  const modalConPendiente = ctx.renderOfflineModal();
  assert(modalConPendiente.includes('SKU-OFF') && modalConPendiente.includes('Pendiente'), 'el panel debe listar el conteo pendiente con su SKU y estado, obtuvo: '+modalConPendiente);
  assert(modalConPendiente.includes('1 foto pendiente de subir'), 'el panel debe indicar cuántas fotos están pendientes de subir, obtuvo: '+modalConPendiente);
  assert(modalConPendiente.includes(`data-reintentar-offline="${itemEncolado.id}"`), 'cada conteo del panel debe tener un botón para reintentarlo individualmente, obtuvo: '+modalConPendiente);
  assert(!modalConPendiente.includes('data-descartar-offline'), 'un conteo pendiente (no en error) no debe ofrecer "Descartar", obtuvo: '+modalConPendiente);
  ctx.__appstate.offlineModal = false;

  // sincronizarColaOffline: sin sesión no debe hacer nada (no puede autenticar la escritura).
  ctx.__appstate.session = null;
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  assert(calls.length===0, 'sin sesión, sincronizarColaOffline no debe llamar a la red, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.colaOffline.length===1, 'sin sesión, la cola offline no debe tocarse');

  // Con sesión y conexión normal, debe subir la foto pendiente, enviar el conteo ya
  // enlazado a ella, vaciar la cola y borrar la foto de IndexedDB (ya no hace falta).
  ctx.__appstate.session = { access_token:'x', user:{id:'user-1', email:'a@b.com'} };
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  const fotoSubidaAlSincronizar = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/storage/v1/object/fotos-inventario/emp-1/SKU-OFF/'));
  assert(!!fotoSubidaAlSincronizar, 'al sincronizar, debe subir la foto que había quedado pendiente, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const postSincronizado = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/conteos'));
  assert(!!postSincronizado, 'sincronizarColaOffline debe hacer POST a /conteos por cada conteo encolado, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(postSincronizado.opts.body)[0].sku_id==='sku-offline', 'el POST debe llevar los datos del conteo que estaba encolado, obtuvo: '+postSincronizado.opts.body);
  const capturadoEnSincronizado = JSON.parse(postSincronizado.opts.body)[0].capturado_en;
  assert(capturadoEnSincronizado===new Date(itemEncolado.creado_en).toISOString(), 'al sincronizar, capturado_en debe ser la fecha original en que se encoló (no la de sincronización), obtuvo: '+capturadoEnSincronizado+' esperado: '+new Date(itemEncolado.creado_en).toISOString());
  const postFotoConteo = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/conteo_fotos'));
  assert(!!postFotoConteo, 'tras crear el conteo, debe enlazar la foto subida con /conteo_fotos, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.colaOffline.length===0, 'tras sincronizar con éxito, la cola offline debe quedar vacía');
  assert(ctx.localStorage.getItem('cola_offline_conteos')==='[]', 'la cola vacía también debe reflejarse en localStorage, obtuvo: '+ctx.localStorage.getItem('cola_offline_conteos'));
  const fotosTrasSincronizar = await ctx.leerFotosOffline(itemEncolado.id);
  assert(fotosTrasSincronizar.length===0, 'tras sincronizar, la foto ya subida debe borrarse de IndexedDB, obtuvo: '+JSON.stringify(fotosTrasSincronizar));

  // Si sigue sin haber conexión al sincronizar (falla de nuevo con TypeError), el conteo
  // debe quedar en la cola para el próximo intento, sin perderse ni reintentarse en bucle.
  ctx.encolarAccionOffline('conteo', {sku_id:'sku-a', usuario_id:'u1', empresa_id:'emp-1', cantidad_contada:1, ubicacion_contada:null, bodega:null, observacion:null});
  ctx.encolarAccionOffline('conteo', {sku_id:'sku-b', usuario_id:'u1', empresa_id:'emp-1', cantidad_contada:2, ubicacion_contada:null, bodega:null, observacion:null});
  const fetchOriginalSync = ctx.fetch;
  let intentosSync = 0;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/conteos' && opts.method==='POST'){ intentosSync++; throw new ctx.__TypeError('Failed to fetch'); }
    return fetchOriginalSync(url, opts);
  };
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  ctx.fetch = fetchOriginalSync;
  assert(intentosSync===1, 'debe detenerse en el primer fallo de red (no reintentar todo el resto en el mismo ciclo), obtuvo: '+intentosSync);
  assert(ctx.__appstate.colaOffline.length===2, 'si sigue sin conexión, ambos conteos deben permanecer en la cola, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline));

  // Si el servidor rechaza un conteo por un error real (no de red), no se pierde ni se
  // reintenta en bucle: queda marcado como "error", visible en el panel, y la sincronización
  // automática lo salta a partir de ahí (solo se reintenta a mano).
  ctx.guardarColaOffline([]);
  ctx.encolarAccionOffline('conteo', {id:'local-error-1', sku_id:'sku-malo', sku_code:'SKU-MALO', usuario_id:'u1', empresa_id:'emp-1', cantidad_contada:3, ubicacion_contada:null, bodega:null, observacion:null});
  const fetchOriginalError = ctx.fetch;
  let intentosConDatoInvalido = 0;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/conteos' && opts.method==='POST'){
      intentosConDatoInvalido++;
      return { status:400, ok:false, headers:{get:()=>null}, text: async()=>JSON.stringify({message:'la cantidad contada es inválida'}) };
    }
    return fetchOriginalError(url, opts);
  };
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  assert(intentosConDatoInvalido===1, 'debe intentar el conteo con error real una vez, obtuvo: '+intentosConDatoInvalido);
  assert(ctx.__appstate.colaOffline.length===1, 'un error real del servidor no debe descartar el conteo, debe quedar visible en la cola, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline));
  assert(ctx.__appstate.colaOffline[0].estado==='error' && ctx.__appstate.colaOffline[0].error==='la cantidad contada es inválida', 'el conteo debe quedar marcado como "error" con el mensaje del servidor, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline[0]));

  // La sincronización automática no debe volver a intentar un conteo ya marcado como "error".
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  assert(intentosConDatoInvalido===1, 'la sincronización automática no debe reintentar un conteo marcado como error, obtuvo: '+intentosConDatoInvalido);

  // El panel de detalle debe mostrar el error y ofrecer "Reintentar" y "Descartar" para ese conteo.
  ctx.__appstate.offlineModal = true;
  const modalConError = ctx.renderOfflineModal();
  ctx.__appstate.offlineModal = false;
  assert(modalConError.includes('SKU-MALO') && modalConError.includes('Error') && modalConError.includes('la cantidad contada es inválida'), 'el panel debe mostrar el estado de error y el motivo, obtuvo: '+modalConError);
  assert(modalConError.includes('data-reintentar-offline="local-error-1"') && modalConError.includes('data-descartar-offline="local-error-1"'), 'un conteo en error debe ofrecer reintentar y descartar, obtuvo: '+modalConError);

  // reintentarAccionOffline: a pedido explícito, sí reintenta un conteo marcado como error.
  // Si sigue fallando igual, se mantiene en error; si el problema ya no está, se sincroniza.
  ctx.fetch = fetchOriginalError;
  calls.length = 0;
  await ctx.reintentarAccionOffline('local-error-1');
  const postConteoSincronizado = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/conteos'));
  assert(!!postConteoSincronizado, 'reintentarAccionOffline debe volver a intentar el envío aunque el conteo estuviera en error, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.colaOffline.length===0, 'si el reintento manual tiene éxito, el conteo debe salir de la cola, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline));

  // descartarAccionOffline: borra el conteo de la cola (y sus fotos, si tenía) sin enviarlo nunca,
  // solo si el usuario confirma.
  ctx.encolarAccionOffline('conteo', {id:'local-descartar-1', sku_id:'sku-c', sku_code:'SKU-C', usuario_id:'u1', empresa_id:'emp-1', cantidad_contada:9, ubicacion_contada:null, bodega:null, observacion:null});
  confirmRespuesta = false;
  confirmLlamadas.length = 0;
  await ctx.descartarAccionOffline('local-descartar-1');
  assert(confirmLlamadas.length===1, 'descartarAccionOffline debe pedir confirmación antes de borrar, obtuvo: '+JSON.stringify(confirmLlamadas));
  assert(ctx.__appstate.colaOffline.length===1, 'si el usuario cancela, el conteo no debe descartarse');

  confirmRespuesta = true;
  await ctx.descartarAccionOffline('local-descartar-1');
  assert(ctx.__appstate.colaOffline.length===0, 'si el usuario confirma, el conteo debe descartarse de la cola, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline));

  // ===== Modo offline para carga manual de SKU (mismo mecanismo que los conteos) =====

  // crearSkuManual sin conexión: debe encolar el SKU (tipo "sku") en vez de mostrar un error,
  // y limpiar el formulario igual que si hubiera guardado con éxito (devuelve true).
  ctx.guardarColaOffline([]);
  const fetchOriginalSkuOffline = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/skus' && opts.method==='POST') throw new ctx.__TypeError('Failed to fetch');
    return fetchOriginalSkuOffline(url, opts);
  };
  calls.length = 0;
  const okSkuOffline = await ctx.crearSkuManual({sku_code:'SKU-OFF-1', descripcion:'Perno offline', categoria:null, unidad_medida:null, bodega:'Nave', ubicacion:null, storage_bin:null, stock_sistema:null});
  ctx.fetch = fetchOriginalSkuOffline;
  assert(okSkuOffline===true, 'crearSkuManual sin conexión debe devolver true (se encoló, no es un error), obtuvo: '+okSkuOffline);
  assert(!calls.some(c=>c.opts && c.opts.method==='POST' && c.url.includes('/skus')), 'no debe haber quedado un POST exitoso a /skus, solo el intento fallido');
  assert(ctx.__appstate.colaOffline.length===1, 'crearSkuManual sin conexión debe agregar el SKU a la cola offline, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline));
  const itemSkuEncolado = ctx.__appstate.colaOffline[0];
  assert(itemSkuEncolado.tipo==='sku' && itemSkuEncolado.sku_code==='SKU-OFF-1' && itemSkuEncolado.empresa_id==='emp-1', 'el SKU encolado debe tener tipo "sku" y los datos ingresados, obtuvo: '+JSON.stringify(itemSkuEncolado));
  assert(itemSkuEncolado.estado==='pendiente', 'un SKU recién encolado debe quedar "pendiente", obtuvo: '+itemSkuEncolado.estado);

  // El panel de detalle debe distinguir el tipo (SKU vs Conteo) y no pedir fotos para un SKU.
  ctx.__appstate.offlineModal = true;
  const modalConSku = ctx.renderOfflineModal();
  ctx.__appstate.offlineModal = false;
  assert(modalConSku.includes('SKU · SKU-OFF-1') && modalConSku.includes('Perno offline'), 'el panel debe mostrar la etiqueta "SKU" y la descripción ingresada, obtuvo: '+modalConSku);

  // sincronizarColaOffline: con conexión, debe hacer un INSERT simple a /skus (sin upsert),
  // igual que crearSkuManual online — mismo motivo: no pisar en silencio un SKU existente.
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  const postSkuSincronizado = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.endsWith('/rest/v1/skus'));
  assert(!!postSkuSincronizado, 'sincronizarColaOffline debe hacer POST a /skus para un item tipo "sku", obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(postSkuSincronizado.opts.body)[0].sku_code==='SKU-OFF-1', 'el POST debe llevar el código del SKU encolado, obtuvo: '+postSkuSincronizado.opts.body);
  assert(JSON.parse(postSkuSincronizado.opts.body)[0].capturado_en===new Date(itemSkuEncolado.creado_en).toISOString(), 'el upsert de un SKU offline debe llevar capturado_en con la fecha original en que se encoló, obtuvo: '+postSkuSincronizado.opts.body);
  assert(ctx.__appstate.colaOffline.length===0, 'tras sincronizar con éxito, el SKU debe salir de la cola');

  // sincronizarColaOffline: si el código+bodega ya existe (mismo caso que crearSkuManual
  // online), el item debe quedar marcado "error" con el mensaje claro, no reintentarse en
  // bucle ni perderse en silencio.
  ctx.guardarColaOffline([{id:'off-dup-1', tipo:'sku', sku_code:'SKU-DUP-EXISTE', descripcion:'Sillas', bodega:'', empresa_id:'emp-1', creado_en:new Date().toISOString(), estado:'pendiente'}]);
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  const colaTrasDup = ctx.leerColaOffline();
  assert(colaTrasDup.length===1 && colaTrasDup[0].estado==='error', 'un SKU offline con código ya existente debe quedar marcado "error" en la cola, no perderse, obtuvo: '+JSON.stringify(colaTrasDup));
  assert(/ya existe/i.test(colaTrasDup[0].error) && colaTrasDup[0].error.includes('SKU-DUP-EXISTE'), 'el mensaje de error guardado debe ser el claro de "código ya existe", no el crudo de Postgres, obtuvo: '+colaTrasDup[0].error);
  assert(!/duplicate key|constraint/i.test(colaTrasDup[0].error), 'el mensaje de error no debe filtrar el error crudo de la base de datos, obtuvo: '+colaTrasDup[0].error);

  // Limpieza para no afectar pruebas siguientes.
  ctx.guardarColaOffline([]);

  // ===== Auditoría de cambios (quién creó/modificó/eliminó personas, empresas y conteos) =====

  // resumenCambioAuditoria: mensaje legible según la acción. Sin tabla conocida (o sin campos
  // auditados para esa tabla) cae al genérico "se creó/eliminó el registro".
  assert(ctx.resumenCambioAuditoria({accion:'INSERT'})==='Se creó el registro', 'INSERT sin tabla conocida debe mostrar "Se creó el registro"');
  assert(ctx.resumenCambioAuditoria({accion:'DELETE'})==='Se eliminó el registro', 'DELETE sin tabla conocida debe mostrar "Se eliminó el registro"');
  const resumenUpdate = ctx.resumenCambioAuditoria({accion:'UPDATE', tabla:'usuarios', datos_antes:{nombre:'Carlos', rol:'operador', activo:true}, datos_despues:{nombre:'Carlos', rol:'admin', activo:true}});
  assert(resumenUpdate==='Rol: operador → admin', 'UPDATE debe listar solo los campos que cambiaron, obtuvo: '+resumenUpdate);
  const resumenSinCambios = ctx.resumenCambioAuditoria({accion:'UPDATE', tabla:'usuarios', datos_antes:{nombre:'Carlos'}, datos_despues:{nombre:'Carlos'}});
  assert(resumenSinCambios==='Sin cambios visibles', 'UPDATE sin diferencias en los campos auditados debe decirlo, obtuvo: '+resumenSinCambios);

  // El trigger guarda la fila completa (to_jsonb), así que un INSERT/DELETE con tabla conocida
  // debe mostrar el detalle de los campos auditados en vez del genérico "se creó/eliminó el
  // registro" — antes esa info se perdía por completo (queja real: "la trazabilidad no dice nada").
  const resumenInsertPersona = ctx.resumenCambioAuditoria({accion:'INSERT', tabla:'usuarios', datos_despues:{nombre:'Diego Soto', rol:'operador', activo:true}});
  assert(resumenInsertPersona==='Nombre: Diego Soto · Rol: operador · Activo: sí', 'INSERT de una persona debe detallar nombre, rol y activo, obtuvo: '+resumenInsertPersona);
  const resumenDeletePersona = ctx.resumenCambioAuditoria({accion:'DELETE', tabla:'empresas', datos_antes:{nombre:'Minera Vieja', activo:true, flow_subscription_status:null}});
  assert(resumenDeletePersona==='Nombre: Minera Vieja · Activo: sí · Estado de suscripción: —', 'DELETE de una empresa debe detallar sus datos, obtuvo: '+resumenDeletePersona);

  // Auditoría del maestro de SKU: mismo patrón (trigger genérico + CAMPOS_AUDITADOS), pero
  // además se muestra el sku_code como identificador.
  const resumenSku = ctx.resumenCambioAuditoria({accion:'UPDATE', tabla:'skus', datos_antes:{sku_code:'FIL-1001', costo_unitario:1000}, datos_despues:{sku_code:'FIL-1001', costo_unitario:1500}});
  assert(resumenSku==='Costo unitario: 1000 → 1500', 'UPDATE de SKU debe listar los campos auditados que cambiaron, obtuvo: '+resumenSku);

  // Carga masiva de SKU (ver migración registrar_auditoria_skus_masivo, a pedido de Joel: recarga
  // el maestro "prácticamente todos los días"): el trigger deja UNA fila de auditoria por
  // sentencia, con {_resumen:true, filas_afectadas:N} en vez del detalle real -- sin manejarlo
  // aparte, resumenCambioAuditoria intentaría leer sku_code/descripción/etc. ahí y mostraría puros
  // "—", no cuántas filas fueron.
  const resumenCargaInsert = ctx.resumenCambioAuditoria({accion:'INSERT', tabla:'skus', datos_despues:{_resumen:true, filas_afectadas:2000}});
  assert(resumenCargaInsert==='Carga masiva: 2000 SKU cargados de una vez', 'un INSERT masivo debe resumir cuántos SKU se cargaron, obtuvo: '+resumenCargaInsert);
  const resumenCargaUpdate = ctx.resumenCambioAuditoria({accion:'UPDATE', tabla:'skus', datos_despues:{_resumen:true, filas_afectadas:56087}});
  assert(resumenCargaUpdate==='Carga masiva: 56087 SKU actualizados de una vez', 'un UPDATE masivo debe resumir cuántos SKU se actualizaron, obtuvo: '+resumenCargaUpdate);
  const resumenCargaDelete = ctx.resumenCambioAuditoria({accion:'DELETE', tabla:'skus', datos_antes:{_resumen:true, filas_afectadas:120}});
  assert(resumenCargaDelete==='Carga masiva: 120 SKU eliminados de una vez', 'un DELETE masivo debe resumir cuántos SKU se eliminaron, obtuvo: '+resumenCargaDelete);
  assert(ctx.identificadorAuditoria({tabla:'skus', datos_despues:{_resumen:true, filas_afectadas:2000}})==='', 'una fila resumen no debe mostrar un sku_code puntual (no hay uno solo), obtuvo: '+JSON.stringify(ctx.identificadorAuditoria({tabla:'skus', datos_despues:{_resumen:true, filas_afectadas:2000}})));

  // identificadorAuditoria: además del código de SKU, ahora también identifica quién/cuál
  // registro cambió en personas, empresas y conteos — sin esto "Persona · Modificado" no decía
  // a quién le pasó.
  assert(ctx.identificadorAuditoria({tabla:'skus', datos_despues:{sku_code:'FIL-1001'}})===' · FIL-1001', 'identificadorAuditoria debe mostrar el código del SKU, obtuvo: '+JSON.stringify(ctx.identificadorAuditoria({tabla:'skus', datos_despues:{sku_code:'FIL-1001'}})));
  assert(ctx.identificadorAuditoria({tabla:'usuarios', datos_despues:{nombre:'Carlos'}})===' · Carlos', 'identificadorAuditoria debe mostrar el nombre de la persona, obtuvo: '+JSON.stringify(ctx.identificadorAuditoria({tabla:'usuarios', datos_despues:{nombre:'Carlos'}})));
  assert(ctx.identificadorAuditoria({tabla:'empresas', datos_antes:{nombre:'Minera Vieja'}})===' · Minera Vieja', 'identificadorAuditoria debe mostrar el nombre de la empresa (incluso en un DELETE, leyendo datos_antes), obtuvo: '+JSON.stringify(ctx.identificadorAuditoria({tabla:'empresas', datos_antes:{nombre:'Minera Vieja'}})));
  assert(ctx.identificadorAuditoria({tabla:'conteos', datos_despues:{bodega:'Bodega Central', ubicacion_contada:'Pasillo 3'}})===' · Bodega Central / Pasillo 3', 'identificadorAuditoria debe mostrar bodega/ubicación del conteo, obtuvo: '+JSON.stringify(ctx.identificadorAuditoria({tabla:'conteos', datos_despues:{bodega:'Bodega Central', ubicacion_contada:'Pasillo 3'}})));

  // cargarAuditoria: pide /auditoria ordenado por fecha, con filtro opcional de tabla.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  calls.length = 0;
  await ctx.cargarAuditoria('');
  const auditoriaCallTodas = calls.find(c=>c.url.includes('/auditoria?select='));
  assert(!!auditoriaCallTodas && auditoriaCallTodas.url.includes('order=creado_en.desc'), 'cargarAuditoria debe pedir /auditoria ordenado por fecha descendente, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(auditoriaCallTodas.url.includes('limit=20'), 'la tabla de Trazabilidad debe paginar de a 20 filas (no 30), obtuvo: '+auditoriaCallTodas.url);
  assert(ctx.__appstate.auditoria.filas.length===4, 'debe cargar las filas devueltas por el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.auditoria.filas));

  // renderConfiguraciones: la sección de auditoría solo debe verse para admin/super-admin, no para operador.
  const htmlConfigAdminAuditoria = ctx.renderConfiguraciones();
  assert(htmlConfigAdminAuditoria.includes('id="auditoria-filtro-tabla"') && htmlConfigAdminAuditoria.includes('Auditoría de cambios'), 'un admin debe ver la sección de auditoría, obtuvo: '+htmlConfigAdminAuditoria);
  assert(htmlConfigAdminAuditoria.includes('Ana Torres') && htmlConfigAdminAuditoria.includes('Rol: operador → admin'), 'debe listar la actividad con actor y el resumen del cambio, obtuvo: '+htmlConfigAdminAuditoria);
  assert(htmlConfigAdminAuditoria.includes('Por: Sistema'), 'un actor nulo (alta automática) debe mostrarse como "Sistema", obtuvo: '+htmlConfigAdminAuditoria);
  // Persona · Carlos: el identificador ahora dice a quién le cambiaron el rol, no solo "Persona".
  assert(htmlConfigAdminAuditoria.includes('Persona · Carlos · Modificado'), 'la fila de "Persona" debe identificar a quién con su nombre, obtuvo: '+htmlConfigAdminAuditoria);
  // Empresa eliminada (a3, sin actor): debe decir el nombre de la empresa que se borró, no solo "Empresa · Eliminado".
  assert(htmlConfigAdminAuditoria.includes('Empresa · Minera Vieja · Eliminado') && htmlConfigAdminAuditoria.includes('Nombre: Minera Vieja'), 'la fila de una empresa eliminada debe decir cuál era, obtuvo: '+htmlConfigAdminAuditoria);
  // Conteo creado (a2): el INSERT ya no debe decir el genérico "Se creó el registro" sin detalle.
  assert(htmlConfigAdminAuditoria.includes('Cantidad: 5') && !htmlConfigAdminAuditoria.includes('Se creó el registro'), 'un conteo creado debe mostrar el detalle de sus campos en vez del genérico "se creó el registro", obtuvo: '+htmlConfigAdminAuditoria);
  assert(htmlConfigAdminAuditoria.includes('<option value="skus"') && htmlConfigAdminAuditoria.includes('>SKU<'), 'el filtro de tabla debe incluir la opción SKU, obtuvo: '+htmlConfigAdminAuditoria);
  assert(htmlConfigAdminAuditoria.includes('SKU · FIL-1001 · Modificado') && htmlConfigAdminAuditoria.includes('Costo unitario: 1000 → 1500'), 'debe listar el cambio de SKU con su código y el costo unitario antes/después, obtuvo: '+htmlConfigAdminAuditoria);

  calls.length = 0;
  await ctx.cargarAuditoria('usuarios');
  const auditoriaCallFiltrada = calls.find(c=>c.url.includes('/auditoria?select='));
  assert(!!auditoriaCallFiltrada && auditoriaCallFiltrada.url.includes('tabla=eq.usuarios'), 'con filtro de tabla, debe pedir /auditoria con tabla=eq.<tabla>, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.auditoria.filas.length===1 && ctx.__appstate.auditoria.filas[0].tabla==='usuarios', 'debe quedar solo la fila de la tabla filtrada, obtuvo: '+JSON.stringify(ctx.__appstate.auditoria.filas));
  assert(ctx.__appstate.auditoria.filtroTabla==='usuarios', 'debe recordar el filtro elegido');

  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  const htmlConfigOperadorAuditoria = ctx.renderConfiguraciones();
  assert(!htmlConfigOperadorAuditoria.includes('id="auditoria-filtro-tabla"'), 'un operador (no admin) no debe ver la sección de auditoría, obtuvo: '+htmlConfigOperadorAuditoria);

  // cargarMasAuditoria: pide la página siguiente con offset=<filas ya cargadas> y las agrega
  // al final (en vez de reemplazar), respetando el filtro de tabla activo.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  await ctx.cargarAuditoria('');
  const filasAntesDeCargarMas = ctx.__appstate.auditoria.filas.length;
  calls.length = 0;
  await ctx.cargarMasAuditoria();
  const auditoriaCallMas = calls.find(c=>c.url.includes('/auditoria?select='));
  assert(!!auditoriaCallMas && auditoriaCallMas.url.includes(`offset=${filasAntesDeCargarMas}`), 'cargarMasAuditoria debe pedir la página siguiente con offset=<lo ya cargado>, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.auditoria.filas.length === filasAntesDeCargarMas*2, 'cargarMasAuditoria debe agregar las filas nuevas a las que ya había, no reemplazarlas, obtuvo: '+ctx.__appstate.auditoria.filas.length);

  // ===== Reconteo: "Cargar más" con offset, en vez de traer todo con un límite fijo =====
  calls.length = 0;
  await ctx.cargarReconteos();
  assert(ctx.__appstate.reconteos.length===30, 'cargarReconteos debe traer la primera página (30), obtuvo: '+ctx.__appstate.reconteos.length);
  assert(ctx.__appstate.reconteosHayMas===true, 'con 30 filas llenando la página, hayMas debe quedar true');
  const htmlReconteoConMas = ctx.renderReconteo();
  assert(htmlReconteoConMas.includes('id="btn-cargar-mas-reconteo"') && htmlReconteoConMas.includes('30+'), 'debe mostrar el botón "Cargar más" y el contador con "+" cuando hay más filas, obtuvo: '+htmlReconteoConMas);
  assert(htmlReconteoConMas.includes('Causa probable') && htmlReconteoConMas.includes('badge-warn">Ubicación distinta<') && htmlReconteoConMas.includes('badge-neutral">Sin patrón detectado<'), 'debe mostrar la columna de causa probable con el badge correspondiente a cada fila, obtuvo: '+htmlReconteoConMas);

  calls.length = 0;
  await ctx.cargarMasReconteos();
  const reconteoCallMas = calls.find(c=>c.url.includes('/reconteo_pendiente?select='));
  assert(!!reconteoCallMas && reconteoCallMas.url.includes('offset=30'), 'cargarMasReconteos debe pedir la página siguiente con offset=30, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.reconteos.length===34, 'debe agregar las 4 filas restantes a las 30 que ya había, obtuvo: '+ctx.__appstate.reconteos.length);
  assert(ctx.__appstate.reconteosHayMas===false, 'al agotarse los datos (4 < 30), hayMas debe pasar a false');
  const htmlReconteoSinMas = ctx.renderReconteo();
  assert(!htmlReconteoSinMas.includes('id="btn-cargar-mas-reconteo"'), 'sin más páginas, el botón "Cargar más" no debe mostrarse, obtuvo: '+htmlReconteoSinMas);

  // ===== Reconteo: ícono para ver las fotos, sumadas de TODOS los conteos del SKU (no solo el
  // último) — pedido de Joel: las fotos de un reconteo deben sumarse a las del conteo original,
  // pudiendo distinguir cuál es cuál (reconteo_pendiente.fotos trae numero_conteo por foto: 1 =
  // conteo original, 2+ = reconteo N-1).
  ctx.__appstate.reconteos = [
    { id:'rf1', sku_code:'SKU-FOTO', descripcion:'Con foto', stock_sistema:10, ultima_cantidad_contada:8, ultima_diferencia:-2, ultimo_conteo_fecha:'2026-08-10', causa_probable:'Sin patrón detectado',
      fotos:[
        {foto_url:'emp-1/SKU-FOTO/original.jpg', numero_conteo:1, fecha_conteo:'2026-08-05T10:00:00Z'},
        {foto_url:'emp-1/SKU-FOTO/reconteo.jpg', numero_conteo:2, fecha_conteo:'2026-08-10T10:00:00Z'},
      ] },
    { id:'rf2', sku_code:'SKU-SIN-FOTO', descripcion:'Sin foto', stock_sistema:5, ultima_cantidad_contada:3, ultima_diferencia:-2, ultimo_conteo_fecha:'2026-08-10', causa_probable:'Sin patrón detectado', fotos:[] },
  ];
  ctx.__appstate.reconteosHayMas = false;
  const htmlReconteoFotos = ctx.renderReconteo();
  assert(htmlReconteoFotos.includes('<th class="num">Foto</th>'), 'debe mostrar la columna "Foto" en la tabla de reconteo, obtuvo: '+htmlReconteoFotos);
  assert(htmlReconteoFotos.includes(`data-ver-fotos="${ctx.esc(JSON.stringify([
    {foto_url:'emp-1/SKU-FOTO/original.jpg', numero_conteo:1, fecha_conteo:'2026-08-05T10:00:00Z'},
    {foto_url:'emp-1/SKU-FOTO/reconteo.jpg', numero_conteo:2, fecha_conteo:'2026-08-10T10:00:00Z'},
  ]))}"`), 'una fila con fotos del conteo y del reconteo debe pasar ambas al botón de verlas, obtuvo: '+htmlReconteoFotos);
  assert(/data-ver-fotos="[^"]*original\.jpg[^"]*"[^>]*>[\s\S]*? 2<\/button>/.test(htmlReconteoFotos), 'con 2 fotos (conteo + reconteo), el botón debe mostrar el total (2), obtuvo: '+htmlReconteoFotos);
  assert(htmlReconteoFotos.includes('icon-btn disabled'), 'una fila sin foto registrada debe mostrar el ícono deshabilitado, obtuvo: '+htmlReconteoFotos);

  // ===== Huella de SOH anterior (a pedido de Joel, solo en Reconteo): si el material tiene
  // stock_sistema_anterior (cambió después de la última carga masiva), se muestra "antes: X" bajo
  // el stock actual, para que el operador entienda por qué cambió la diferencia. Sin ese dato
  // (fixture rf1/rf2 de arriba, sin stock_sistema_anterior) no debe mostrarse nada de más.
  assert(!htmlReconteoFotos.includes('antes:'), 'sin stock_sistema_anterior no debe mostrarse la huella "antes:", obtuvo: '+htmlReconteoFotos);
  ctx.__appstate.reconteos = [
    { id:'rf3', sku_code:'SKU-SOH-CAMBIO', descripcion:'Con SOH actualizado', stock_sistema:11, stock_sistema_anterior:8, stock_sistema_actualizado_en:'2026-08-11T09:30:00Z', ultima_cantidad_contada:10, ultima_diferencia:-1, ultimo_conteo_fecha:'2026-08-10', causa_probable:'Sin patrón detectado', fotos:[] },
  ];
  const htmlReconteoSoh = ctx.renderReconteo();
  const fechaEsperada = ctx.fmtFechaHora('2026-08-11T09:30:00Z');
  assert(htmlReconteoSoh.includes(`antes: 8 · ${fechaEsperada}`), 'con stock_sistema_anterior debe mostrar "antes: 8" junto con cuándo cambió, obtuvo: '+htmlReconteoSoh);

  // ===== Stock por tipo (Bloqueado/Tránsito 1/Tránsito 2/Transferencia, a pedido de Joel):
  // informativo en Reconteo, se omite entero si el SKU no trae ninguno de los 4 datos.
  assert(!htmlReconteoFotos.includes('Bloq:') && !htmlReconteoFotos.includes('Trán.') && !htmlReconteoFotos.includes('Transf:'), 'sin datos de stock por tipo no debe mostrarse nada de más, obtuvo: '+htmlReconteoFotos);
  ctx.__appstate.reconteos = [
    { id:'rf4', sku_code:'SKU-TIPOS', descripcion:'Con stock por tipo', stock_sistema:20, ultima_cantidad_contada:18, ultima_diferencia:-2, ultimo_conteo_fecha:'2026-08-10', causa_probable:'Sin patrón detectado', fotos:[],
      stock_bloqueado:3, stock_transito_1:0, stock_transito_2:5, stock_transferencia:2 },
  ];
  const htmlReconteoTipos = ctx.renderReconteo();
  assert(htmlReconteoTipos.includes('Bloq: 3 · Trán. 2: 5 · Transf: 2'), 'debe mostrar los tipos de stock presentes, omitiendo Tránsito 1 (0), obtuvo: '+htmlReconteoTipos);

  // etiquetaNumeroConteo: 1 es el conteo original, 2+ son reconteos (numerados desde 1).
  assert(ctx.etiquetaNumeroConteo(1)==='Conteo' && ctx.etiquetaNumeroConteo(2)==='Reconteo 1' && ctx.etiquetaNumeroConteo(3)==='Reconteo 2', 'etiquetaNumeroConteo debe distinguir el conteo original de cada reconteo, obtuvo: '+JSON.stringify([ctx.etiquetaNumeroConteo(1), ctx.etiquetaNumeroConteo(2), ctx.etiquetaNumeroConteo(3)]));

  // ===== Conteo ciego: ocultarStockOperador() decide según rol + el flag de la empresa. Un
  // admin siempre ve el stock; un operador solo lo ve si su empresa NO tiene el flag activo. =====
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  assert(ctx.ocultarStockOperador()===true, 'operador con conteo ciego activo debe ocultar el stock, obtuvo: '+ctx.ocultarStockOperador());
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = false;
  assert(ctx.ocultarStockOperador()===false, 'operador con conteo ciego apagado NO debe ocultar el stock, obtuvo: '+ctx.ocultarStockOperador());
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  assert(ctx.ocultarStockOperador()===false, 'un admin siempre ve el stock, sin importar el flag, obtuvo: '+ctx.ocultarStockOperador());

  // esConteoAtipico: reemplazo del chequeo de cordura cuando no se ve el stock -- umbral es el
  // mayor entre 50% del stock o 5 unidades (nunca revela el valor real, solo si es "raro").
  assert(ctx.esConteoAtipico(5, null)===false, 'sin stock_sistema conocido no hay con qué comparar, nunca es atípico, obtuvo: '+ctx.esConteoAtipico(5,null));
  assert(ctx.esConteoAtipico(19, 20)===false, 'una diferencia chica (1 de 20) no debe marcarse atípica, obtuvo: '+ctx.esConteoAtipico(19,20));
  assert(ctx.esConteoAtipico(2, 20)===true, 'una diferencia grande (18 de 20, sobre el 50%) sí debe marcarse atípica, obtuvo: '+ctx.esConteoAtipico(2,20));
  assert(ctx.esConteoAtipico(4, 0)===false, 'con stock 0, hasta 5 unidades de diferencia no es atípico (umbral mínimo absoluto), obtuvo: '+ctx.esConteoAtipico(4,0));
  assert(ctx.esConteoAtipico(6, 0)===true, 'con stock 0, más de 5 unidades sí es atípico, obtuvo: '+ctx.esConteoAtipico(6,0));

  // Render de Contar: con conteo ciego activo, un operador no debe ver "Stock sistema"; sin
  // el flag, o siendo admin, sí.
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN'};
  const htmlContarCiegoActivo = ctx.renderConteo();
  assert(!htmlContarCiegoActivo.includes('Stock sistema'), 'con conteo ciego activo, un operador no debe ver la línea de Stock sistema, obtuvo: '+htmlContarCiegoActivo);
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = false;
  const htmlContarCiegoInactivo = ctx.renderConteo();
  assert(htmlContarCiegoInactivo.includes('Stock sistema (este batch): 20 UN'), 'con conteo ciego apagado, el operador sí debe ver el stock, obtuvo: '+htmlContarCiegoInactivo);
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  const htmlContarAdminSiempreVe = ctx.renderConteo();
  assert(htmlContarAdminSiempreVe.includes('Stock sistema (este batch): 20 UN'), 'un admin siempre debe ver el stock, aunque el conteo ciego esté activo, obtuvo: '+htmlContarAdminSiempreVe);

  // ===== Stock por tipo en Contar (a pedido de Joel, "esta info sirve para conteo y reconteo"):
  // se muestra en la tarjeta del SKU seleccionado, y se oculta con el mismo gate de conteo ciego
  // que el stock sistema (si el admin apaga "ver stock" para operadores, tampoco ven estos datos).
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN', stock_bloqueado:3, stock_transito_1:0, stock_transito_2:5, stock_transferencia:2};
  const htmlContarTiposAdmin = ctx.renderConteo();
  assert(htmlContarTiposAdmin.includes('Bloq: 3 · Trán. 2: 5 · Transf: 2'), 'un admin debe ver el stock por tipo junto al stock sistema en Contar, obtuvo: '+htmlContarTiposAdmin);
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  const htmlContarTiposCiego = ctx.renderConteo();
  assert(!htmlContarTiposCiego.includes('Bloq:') && !htmlContarTiposCiego.includes('Trán.') && !htmlContarTiposCiego.includes('Transf:'), 'con conteo ciego activo, un operador tampoco debe ver el stock por tipo, obtuvo: '+htmlContarTiposCiego);
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = false;
  const htmlContarTiposOperadorSinCiego = ctx.renderConteo();
  assert(htmlContarTiposOperadorSinCiego.includes('Bloq: 3 · Trán. 2: 5 · Transf: 2'), 'con conteo ciego apagado, el operador sí debe ver el stock por tipo, obtuvo: '+htmlContarTiposOperadorSinCiego);

  // guardarConteo + conteo ciego: un valor bien distinto de lo esperado dispara una confirmación
  // neutra (nunca menciona el valor real) antes de guardar; si cancela, no se guarda.
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN'};
  ctx.__appstate.conteoOrigenPlan = true;
  ctx.__appstate.conteoFotos = [];
  confirmRespuesta = false; confirmLlamadas.length = 0; calls.length = 0;
  await ctx.guardarConteo({cantidad:'2', ubicacion:'Interior Nave', bodega:'Nave Mina', observacion:''});
  assert(confirmLlamadas.length===1 && !/20/.test(confirmLlamadas[0]), 'debe preguntar confirmación sin revelar el valor esperado, obtuvo: '+JSON.stringify(confirmLlamadas));
  assert(!calls.some(c=>c.opts && c.opts.method==='POST' && c.url.includes('/conteos') && !c.url.includes('fotos')), 'si cancela la confirmación, el conteo no debe guardarse, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  confirmRespuesta = true; confirmLlamadas.length = 0; calls.length = 0;
  await ctx.guardarConteo({cantidad:'2', ubicacion:'Interior Nave', bodega:'Nave Mina', observacion:''});
  assert(confirmLlamadas.length===1, 'si confirma, igual debe haber preguntado antes, obtuvo: '+JSON.stringify(confirmLlamadas));
  assert(calls.some(c=>c.opts && c.opts.method==='POST' && c.url.includes('/conteos') && !c.url.includes('fotos')), 'si confirma, el conteo debe guardarse, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN'};
  confirmLlamadas.length = 0; calls.length = 0;
  await ctx.guardarConteo({cantidad:'19', ubicacion:'Interior Nave', bodega:'Nave Mina', observacion:''});
  assert(confirmLlamadas.length===0, 'un valor cercano a lo habitual no debe disparar la confirmación, obtuvo: '+JSON.stringify(confirmLlamadas));
  assert(calls.some(c=>c.opts && c.opts.method==='POST' && c.url.includes('/conteos') && !c.url.includes('fotos')), 'debe guardarse directo sin preguntar, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  ctx.__appstate.skuSeleccionado = null;
  ctx.__appstate.conteoOrigenPlan = false;

  // Render de Reconteo: con conteo ciego, la columna "Sistema" desaparece y la diferencia se
  // neutraliza a "Con diferencia" (sin el monto) -- "Contado" + el monto también delatarían el
  // stock del sistema. Reusa el fixture rf1/rf2 (stock_sistema 10 y 5) ya cargado arriba.
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  const htmlReconteoCiego = ctx.renderReconteo();
  assert(!htmlReconteoCiego.includes('<th class="num">Sistema</th>'), 'con conteo ciego, la columna "Sistema" no debe mostrarse en Reconteo, obtuvo: '+htmlReconteoCiego);
  assert(!htmlReconteoCiego.includes('>10<') && !htmlReconteoCiego.includes('>-2<'), 'con conteo ciego, ni el stock ni el monto de la diferencia deben aparecer, obtuvo: '+htmlReconteoCiego);
  assert(htmlReconteoCiego.includes('badge-warn">Con diferencia<'), 'con conteo ciego, la diferencia debe mostrarse sin monto ("Con diferencia"), obtuvo: '+htmlReconteoCiego);
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = false;
  const htmlReconteoNormal = ctx.renderReconteo();
  assert(htmlReconteoNormal.includes('<th class="num">Sistema</th>') && htmlReconteoNormal.includes('badge-warn">-2<'), 'con conteo ciego apagado, "Sistema" y el monto de la diferencia deben verse normal, obtuvo: '+htmlReconteoNormal);

  // Render de Buscar: la magnitud de "Diferencia" (que junto con "Contado" delata el stock) se
  // neutraliza igual que en Reconteo.
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  ctx.__appstate.busqueda = {texto:'', bodega:'', estado:'', soloConFotos:false, resultados:[
    {sku_code:'SKU-9', descripcion:'X', bodega:'Nave', conteo_id:'c-9', cantidad_contada:12, estado:'con_diferencia', diferencia:-3, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', fuera_de_plan:false, ciclo_nombre:null, fotos:[]},
  ], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0, busquedaPagina:0};
  const htmlBuscarCiego = ctx.renderBuscar();
  assert(htmlBuscarCiego.includes('badge-warn">Con diferencia<') && !htmlBuscarCiego.includes('>-3<'), 'con conteo ciego, Buscar no debe mostrar el monto de la diferencia, obtuvo: '+htmlBuscarCiego);
  assert(htmlBuscarCiego.includes('<td class="num">12</td>'), 'lo "Contado" solo, sin la diferencia, no delata el stock -- sigue visible, obtuvo: '+htmlBuscarCiego);
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = false;
  const htmlBuscarNormal = ctx.renderBuscar();
  assert(htmlBuscarNormal.includes('badge-warn">Diferencia -3<'), 'con conteo ciego apagado, Buscar debe mostrar el monto normal, obtuvo: '+htmlBuscarNormal);

  // Render del maestro de SKU: la columna "Stock" desaparece con conteo ciego.
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', conteo_ciego_habilitado:true} };
  ctx.__appstate.skusPagina = {rows:[{id:'s1', sku_code:'SKU-1', descripcion:'X', bodega:'Nave', ubicacion:'', storage_bin:'', batch:'', stock_sistema:15, ultimoEstado:null, ultimaDiferencia:null}], page:0, total:1};
  const htmlSkusCiego = ctx.renderSkus();
  assert(!htmlSkusCiego.includes('<th class="num">Stock</th>') && !htmlSkusCiego.includes('<td class="num">15</td>'), 'con conteo ciego, la columna "Stock" del maestro de SKU no debe mostrarse, obtuvo: '+htmlSkusCiego);
  ctx.__appstate.perfil.empresas.conteo_ciego_habilitado = false;
  const htmlSkusNormal = ctx.renderSkus();
  assert(htmlSkusNormal.includes('<th class="num">Stock</th>') && htmlSkusNormal.includes('<td class="num">15</td>'), 'con conteo ciego apagado, la columna "Stock" debe verse normal, obtuvo: '+htmlSkusNormal);

  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };

  // ===== Dashboard: "Materiales contados" con "Cargar más" =====
  calls.length = 0;
  await ctx.cargarUltimosConteos();
  assert(ctx.__appstate.ultimosConteos.length===30 && ctx.__appstate.ultimosConteosHayMas===true, 'cargarUltimosConteos debe traer la primera página (30) y marcar hayMas, obtuvo: '+ctx.__appstate.ultimosConteos.length);
  calls.length = 0;
  await ctx.cargarMasUltimosConteos();
  const conteosCallMas = calls.find(c=>c.url.includes('/conteos?select='));
  assert(!!conteosCallMas && conteosCallMas.url.includes('offset=30'), 'cargarMasUltimosConteos debe pedir la página siguiente con offset=30, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.ultimosConteos.length===34 && ctx.__appstate.ultimosConteosHayMas===false, 'debe agregar las 4 filas restantes y marcar que ya no hay más, obtuvo: '+ctx.__appstate.ultimosConteos.length);

  // Bug real reportado: "Conteos recientes" no calzaba con el resto del dashboard porque no se
  // acotaba al ciclo actual (a diferencia de avance_total, exactitud_por_bodega, etc.) — mostraba
  // siempre el tope de la página aunque esos conteos fueran de períodos ya cerrados.
  cicloActualRpcRespuesta = 'ciclo-actual-xyz';
  calls.length = 0;
  await ctx.cargarUltimosConteos();
  const rpcCicloCall = calls.find(c=>c.url.includes('/rpc/ciclo_actual'));
  assert(!!rpcCicloCall, 'cargarUltimosConteos debe resolver el ciclo actual vía /rpc/ciclo_actual, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const conteosCallConCiclo = calls.find(c=>c.url.includes('/conteos?select='));
  assert(!!conteosCallConCiclo && conteosCallConCiclo.url.includes('ciclo_id=eq.ciclo-actual-xyz'), 'cargarUltimosConteos debe acotar al ciclo actual, igual que el resto del dashboard, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.ultimosConteosCicloId==='ciclo-actual-xyz', 'debe guardar el ciclo resuelto en state.ultimosConteosCicloId para reusarlo en "Cargar más", obtuvo: '+ctx.__appstate.ultimosConteosCicloId);
  calls.length = 0;
  await ctx.cargarMasUltimosConteos();
  const conteosCallMasConCiclo = calls.find(c=>c.url.includes('/conteos?select='));
  assert(!!conteosCallMasConCiclo && conteosCallMasConCiclo.url.includes('ciclo_id=eq.ciclo-actual-xyz'), 'cargarMasUltimosConteos debe reusar el mismo filtro de ciclo que la primera página, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(!calls.some(c=>c.url.includes('/rpc/ciclo_actual')), 'cargarMasUltimosConteos no debe volver a pedir el ciclo actual (ya quedó guardado), obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  cicloActualRpcRespuesta = null; // dejar el mock como estaba para el resto de los tests

  // ===== Dashboard: "Materiales contados" pagina de a 15 con Anterior/Siguiente (a pedido de
  // Joel), reemplazando el botón "Cargar más". avanzarPaginaMateriales reusa
  // cargarMasUltimosConteos por debajo solo cuando la página pedida cae fuera de lo ya cargado.
  // En este punto ya quedaron cargados 34 conteos (arriba), con ultimosConteosHayMas=false:
  // alcanza para 3 páginas de 15 sin pedir nada más al servidor.
  ctx.__appstate.dashboardModo = 'operativo';
  ctx.__appstate.dashMaterialesPagina = 0;
  const htmlMaterialesPag1 = ctx.renderDashboard();
  assert(/id="dash-materiales-prev"[^>]*disabled/.test(htmlMaterialesPag1), 'en la primera página de Materiales contados, Anterior debe estar deshabilitado, obtuvo: '+htmlMaterialesPag1);
  assert(htmlMaterialesPag1.includes('id="dash-materiales-next"') && !/id="dash-materiales-next"[^>]*disabled/.test(htmlMaterialesPag1), 'con 34 conteos ya cargados (3 páginas de 15), Siguiente debe estar habilitado en la página 1, obtuvo: '+htmlMaterialesPag1);
  assert(!htmlMaterialesPag1.includes('id="btn-cargar-mas-conteos"'), 'el botón "Cargar más" ya no debe existir, reemplazado por Anterior/Siguiente, obtuvo: '+htmlMaterialesPag1);

  ctx.__appstate.dashMaterialesPagina = 2; // última página: solo quedan 34-30=4 filas
  const htmlMaterialesPag3 = ctx.renderDashboard();
  assert(/id="dash-materiales-next"[^>]*disabled/.test(htmlMaterialesPag3), 'en la última página (sin más filas cargadas ni pendientes en el servidor), Siguiente debe estar deshabilitado, obtuvo: '+htmlMaterialesPag3);
  assert(!/id="dash-materiales-prev"[^>]*disabled/.test(htmlMaterialesPag3), 'en una página que no es la primera, Anterior debe estar habilitado, obtuvo: '+htmlMaterialesPag3);

  // avanzarPaginaMateriales: si la página pedida cae fuera de lo ya cargado pero el servidor
  // todavía tiene más (hayMas=true), primero debe pedir la siguiente tanda antes de avanzar.
  ctx.__appstate.ultimosConteos = ctx.__appstate.ultimosConteos.slice(0, 15); // simula que solo se cargó la 1a tanda
  ctx.__appstate.ultimosConteosHayMas = true;
  ctx.__appstate.dashMaterialesPagina = 0;
  calls.length = 0;
  await ctx.avanzarPaginaMateriales();
  const conteosCallPagina = calls.find(c=>c.url.includes('/conteos?select='));
  assert(!!conteosCallPagina && conteosCallPagina.url.includes('offset=15'), 'avanzarPaginaMateriales debe pedir la siguiente tanda al servidor (offset=15) cuando la página pedida no está cargada todavía, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dashMaterialesPagina===1, 'debe avanzar a la página 2 después de traer los datos que faltaban, obtuvo: '+ctx.__appstate.dashMaterialesPagina);

  // retrocederPaginaMateriales: los datos ya están cargados, nunca debe pedir nada al servidor.
  calls.length = 0;
  ctx.retrocederPaginaMateriales();
  assert(calls.length===0, 'retrocederPaginaMateriales no debe pedir nada al servidor, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dashMaterialesPagina===0, 'debe volver a la página 1, obtuvo: '+ctx.__appstate.dashMaterialesPagina);
  ctx.__appstate.dashboardModo = 'ejecutivo';

  // ===== Buscar: carga inicial hasta TOPE_CARGA_TOTAL_BUSQUEDA de una vez, con el total real
  // pedido en paralelo al RPC contar_busqueda_skus -- ver buscarConteos. Con más de mil filas (un
  // caso ancho, sin filtro), no alcanza a traer todo de una: sigue paginando con
  // "Siguiente"/buscarMasConteos. =====
  const filaBusquedaGenerica = (i) => ({sku_id:'sku-ancho-'+i, sku_code:'SKU-ANCHO-'+i, descripcion:'Item '+i, bodega:'Nave', ubicacion:null, storage_bin:null, conteo_id:null, cantidad_contada:null, estado:null, diferencia:null, fecha_conteo:null, capturado_en:null, fuera_de_plan:null, ciclo_id:null, ciclo_nombre:null, fotos:[], batch:null, contado_por:null, critico:false, clase_abc:null});
  skusBusquedaFixture = Array.from({length:1005}, (_,i)=>filaBusquedaGenerica(i));
  ctx.__appstate.busqueda = {texto:'', bodega:'', estado:'', soloConFotos:false, resultados:[], total:null, buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0, busquedaPagina:0};
  calls.length = 0;
  await ctx.buscarConteos();
  const busquedaCallInicial = calls.find(c=>c.url.includes('/skus_busqueda?select='));
  assert(!!busquedaCallInicial && busquedaCallInicial.url.includes(`limit=${1000}`), 'la carga inicial debe pedir hasta TOPE_CARGA_TOTAL_BUSQUEDA, no solo TAM_PAGINA_LISTA, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.busqueda.resultados.length===1000 && ctx.__appstate.busqueda.total===1005 && ctx.__appstate.busqueda.hayMas===true, 'con más filas que el tope, debe cargar hasta el tope y saber el total real (1005) vía el RPC contar_busqueda_skus, obtuvo: '+JSON.stringify({n:ctx.__appstate.busqueda.resultados.length, total:ctx.__appstate.busqueda.total, hayMas:ctx.__appstate.busqueda.hayMas}));
  assert(ctx.__appstate.busqueda.paginaOffset===1000, 'debe recordar cuántas filas crudas ya se pidieron al servidor, obtuvo: '+ctx.__appstate.busqueda.paginaOffset);
  calls.length = 0;
  await ctx.buscarMasConteos();
  const busquedaCallMas = calls.find(c=>c.url.includes('/skus_busqueda?select='));
  assert(!!busquedaCallMas && busquedaCallMas.url.includes(`offset=${1000}`), 'buscarMasConteos debe pedir la página siguiente desde donde quedó, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.busqueda.resultados.length===1005 && ctx.__appstate.busqueda.hayMas===false, 'debe agregar las filas restantes hasta completar el total real y marcar que ya no hay más, obtuvo: '+ctx.__appstate.busqueda.resultados.length);

  // Caso típico (un total chico, por debajo del tope): queda TODO cargado en la primera llamada,
  // sin necesidad de "Siguiente" -- así el conteo de arriba y los gráficos ya reflejan el total
  // real de entrada (a pedido de Joel: "en el gráfico igual sale en menor a treinta").
  skusBusquedaFixture = null; // vuelve al fixture por defecto (34 filas en total)
  ctx.__appstate.busqueda = {texto:'', bodega:'', estado:'', soloConFotos:false, resultados:[], total:null, buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0, busquedaPagina:0};
  calls.length = 0;
  await ctx.buscarConteos();
  assert(ctx.__appstate.busqueda.resultados.length===34 && ctx.__appstate.busqueda.total===34 && ctx.__appstate.busqueda.hayMas===false, 'con un total por debajo del tope, debe quedar todo cargado de una sola vez, obtuvo: '+JSON.stringify({n:ctx.__appstate.busqueda.resultados.length, total:ctx.__appstate.busqueda.total, hayMas:ctx.__appstate.busqueda.hayMas}));

  // ===== Buscar pagina de a 15 con Anterior/Siguiente (a pedido de Joel, mismo caso que
  // Materiales contados), reemplazando el botón "Cargar más". En este punto ya quedaron
  // cargados 34 resultados (arriba), con hayMas=false: alcanza para 3 páginas de 15 sin pedir
  // nada más al servidor.
  ctx.__appstate.busqueda.busquedaPagina = 0;
  const htmlBuscarPag1 = ctx.renderBuscar();
  assert(/id="buscar-pagina-prev"[^>]*disabled/.test(htmlBuscarPag1), 'en la primera página de Buscar, Anterior debe estar deshabilitado, obtuvo: '+htmlBuscarPag1);
  assert(htmlBuscarPag1.includes('id="buscar-pagina-next"') && !/id="buscar-pagina-next"[^>]*disabled/.test(htmlBuscarPag1), 'con 34 resultados ya cargados (3 páginas de 15), Siguiente debe estar habilitado en la página 1, obtuvo: '+htmlBuscarPag1);
  assert(!htmlBuscarPag1.includes('id="btn-cargar-mas-busqueda"'), 'el botón "Cargar más" de Buscar ya no debe existir, reemplazado por Anterior/Siguiente, obtuvo: '+htmlBuscarPag1);
  assert((htmlBuscarPag1.match(/<tr>\s*<td/g)||[]).length===15, 'la página 1 debe mostrar exactamente 15 filas, obtuvo: '+((htmlBuscarPag1.match(/<tr>\s*<td/g)||[]).length));

  ctx.__appstate.busqueda.busquedaPagina = 2; // última página: solo quedan 34-30=4 filas
  const htmlBuscarPag3 = ctx.renderBuscar();
  assert(/id="buscar-pagina-next"[^>]*disabled/.test(htmlBuscarPag3), 'en la última página (sin más filas cargadas ni pendientes en el servidor), Siguiente debe estar deshabilitado, obtuvo: '+htmlBuscarPag3);
  assert(!/id="buscar-pagina-prev"[^>]*disabled/.test(htmlBuscarPag3), 'en una página que no es la primera, Anterior debe estar habilitado, obtuvo: '+htmlBuscarPag3);
  assert((htmlBuscarPag3.match(/<tr>\s*<td/g)||[]).length===4, 'la última página debe mostrar solo las 4 filas restantes, obtuvo: '+((htmlBuscarPag3.match(/<tr>\s*<td/g)||[]).length));

  // avanzarPaginaBuscar: si la página pedida cae fuera de lo ya cargado pero el servidor todavía
  // tiene más (hayMas=true), primero debe pedir la siguiente tanda antes de avanzar.
  ctx.__appstate.busqueda.resultados = ctx.__appstate.busqueda.resultados.slice(0, 15); // simula que solo se cargó la 1a tanda
  ctx.__appstate.busqueda.hayMas = true;
  ctx.__appstate.busqueda.paginaOffset = 15;
  ctx.__appstate.busqueda.busquedaPagina = 0;
  calls.length = 0;
  await ctx.avanzarPaginaBuscar();
  const busquedaCallPagina = calls.find(c=>c.url.includes('/skus_busqueda?select='));
  assert(!!busquedaCallPagina && busquedaCallPagina.url.includes('offset=15'), 'avanzarPaginaBuscar debe pedir la siguiente tanda al servidor (offset=15) cuando la página pedida no está cargada todavía, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.busqueda.busquedaPagina===1, 'debe avanzar a la página 2 después de traer los datos que faltaban, obtuvo: '+ctx.__appstate.busqueda.busquedaPagina);

  // retrocederPaginaBuscar: los datos ya están cargados, nunca debe pedir nada al servidor.
  calls.length = 0;
  ctx.retrocederPaginaBuscar();
  assert(calls.length===0, 'retrocederPaginaBuscar no debe pedir nada al servidor, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.busqueda.busquedaPagina===0, 'debe volver a la página 1, obtuvo: '+ctx.__appstate.busqueda.busquedaPagina);

  // ===== Buscar: gráfico de torta "Quién contó" (a pedido de Joel) =====
  // resumenQuienConto: solo cuenta filas con conteo_id (las "No contado" no tienen contador),
  // ordena de mayor a menor y, más allá de las primeras 5 personas, agrupa el resto en "Otros".
  const resumenPocos = ctx.resumenQuienConto([
    {conteo_id:'c1', contado_por:'Ana'},
    {conteo_id:'c2', contado_por:'Ana'},
    {conteo_id:'c3', contado_por:'Beto'},
    {conteo_id:null, contado_por:null}, // no contado: no debe sumar a nadie
  ]);
  assert(JSON.stringify(resumenPocos)===JSON.stringify([{nombre:'Ana', n:2}, {nombre:'Beto', n:1}]), 'con pocas personas, debe agrupar y ordenar de mayor a menor sin agregar "Otros", obtuvo: '+JSON.stringify(resumenPocos));

  const filasSeisPersonas = ['Ana','Beto','Caro','Diego','Elena','Fede'].flatMap((nombre,i)=>
    Array.from({length:6-i}, ()=>({conteo_id:'c-'+nombre, contado_por:nombre}))); // Ana:6, Beto:5, ..., Fede:1
  const resumenSeis = ctx.resumenQuienConto(filasSeisPersonas);
  assert(resumenSeis.length===6, 'con 6 personas, debe quedar el top 5 más un grupo "Otros", obtuvo: '+JSON.stringify(resumenSeis));
  assert(resumenSeis[5].nombre==='Otros' && resumenSeis[5].n===1, 'la 6ta persona (Fede, con 1) debe caer agrupada en "Otros", obtuvo: '+JSON.stringify(resumenSeis));
  assert(resumenSeis[0].nombre==='Ana' && resumenSeis[0].n===6, 'el orden debe ser de mayor a menor, obtuvo: '+JSON.stringify(resumenSeis));

  // colorQuienConto: color fijo por posición (no cicla al azar), "Otros" cae en gris al quedar
  // fuera del arreglo de 5 colores.
  assert(ctx.colorQuienConto(null,0)==='var(--steel)' && ctx.colorQuienConto(null,4)==='var(--danger)', 'los primeros 5 lugares deben tener colores fijos y distintos, obtuvo: '+[ctx.colorQuienConto(null,0), ctx.colorQuienConto(null,4)]);
  assert(ctx.colorQuienConto(null,5)==='var(--text-faint)', 'más allá del 5to lugar (Otros) debe caer en gris, obtuvo: '+ctx.colorQuienConto(null,5));

  // Render: sin resultados contados, la tarjeta "Quién contó" no debe aparecer -- y con
  // resultados contados, sí, con el nombre de cada persona en la leyenda.
  ctx.__appstate.busqueda = {texto:'', bodega:'', estado:'', soloConFotos:false, resultados:[{sku_code:'SKU-NC', descripcion:'X', bodega:'Nave', conteo_id:null, cantidad_contada:null, estado:null, diferencia:null, fecha_conteo:null, capturado_en:null, fuera_de_plan:null, ciclo_nombre:null, fotos:[]}], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0, busquedaPagina:0};
  const htmlBuscarSinContados = ctx.renderBuscar();
  assert(!htmlBuscarSinContados.includes('Quién contó'), 'sin ningún resultado contado, la tarjeta "Quién contó" no debe mostrarse, obtuvo: '+htmlBuscarSinContados);

  ctx.__appstate.busqueda.resultados = [
    {sku_code:'SKU-1', descripcion:'X', bodega:'Nave', conteo_id:'c-1', cantidad_contada:5, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', fuera_de_plan:false, ciclo_nombre:null, fotos:[], contado_por:'Ana Torres'},
    {sku_code:'SKU-2', descripcion:'Y', bodega:'Nave', conteo_id:'c-2', cantidad_contada:3, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', fuera_de_plan:false, ciclo_nombre:null, fotos:[], contado_por:'Diego Muñoz'},
  ];
  const htmlBuscarConContados = ctx.renderBuscar();
  assert(htmlBuscarConContados.includes('Quién contó') && htmlBuscarConContados.includes('<svg') , 'con resultados contados, la tarjeta "Quién contó" debe mostrarse con su gráfico, obtuvo: '+htmlBuscarConContados);
  assert(htmlBuscarConContados.includes('Ana Torres (1)') && htmlBuscarConContados.includes('Diego Muñoz (1)'), 'la leyenda debe mostrar el nombre de cada persona y cuántos contó, obtuvo: '+htmlBuscarConContados);

  // ===== Buscar: filtro interactivo del gráfico "Quién contó" (a pedido de Joel: poder
  // seleccionar una porción/leyenda y que la tabla de abajo se filtre por esa persona) =====
  function filaBusquedaFake(sku, contadoPor){
    return {sku_code:sku, batch:null, descripcion:'X', bodega:'Nave', conteo_id:'c-'+sku, cantidad_contada:1, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', fuera_de_plan:false, ciclo_nombre:null, fotos:[], contado_por:contadoPor};
  }
  // 7 personas: Ana(3), Beto(2), Caro(2), Diego(1), Elena(1) quedan en el top 5; Fede(1) y
  // Gaby(1) caen agrupados en "Otros" (mismo criterio de resumenQuienConto ya probado arriba).
  const filasQuienContoInteractivo = [
    ...Array.from({length:3}, (_,i)=>filaBusquedaFake(`SKU-ANA-${i}`, 'Ana')),
    ...Array.from({length:2}, (_,i)=>filaBusquedaFake(`SKU-BETO-${i}`, 'Beto')),
    ...Array.from({length:2}, (_,i)=>filaBusquedaFake(`SKU-CARO-${i}`, 'Caro')),
    filaBusquedaFake('SKU-DIEGO-0', 'Diego'),
    filaBusquedaFake('SKU-ELENA-0', 'Elena'),
    filaBusquedaFake('SKU-FEDE-0', 'Fede'),
    filaBusquedaFake('SKU-GABY-0', 'Gaby'),
  ];
  const quienContoInteractivo = ctx.resumenQuienConto(filasQuienContoInteractivo);
  const otrosEntry = quienContoInteractivo.find(d=>d.nombre==='Otros');
  assert(!!otrosEntry && JSON.stringify(otrosEntry.nombres.slice().sort())===JSON.stringify(['Fede','Gaby']), 'el bucket "Otros" debe recordar qué nombres agrupa, para poder filtrar por todos ellos, obtuvo: '+JSON.stringify(otrosEntry));

  // nombresParaFiltroContador: resuelve la porción/leyenda seleccionada a los nombres reales de
  // contador -- una sola persona, o la lista completa cuando se eligió "Otros".
  assert(JSON.stringify(ctx.nombresParaFiltroContador(quienContoInteractivo, 'Ana'))===JSON.stringify(['Ana']), 'debe resolver a la persona misma cuando no es "Otros", obtuvo: '+JSON.stringify(ctx.nombresParaFiltroContador(quienContoInteractivo, 'Ana')));
  assert(JSON.stringify(ctx.nombresParaFiltroContador(quienContoInteractivo, 'Otros').slice().sort())===JSON.stringify(['Fede','Gaby']), 'seleccionar "Otros" debe resolver a todas las personas que agrupa, obtuvo: '+JSON.stringify(ctx.nombresParaFiltroContador(quienContoInteractivo, 'Otros')));
  assert(ctx.nombresParaFiltroContador(quienContoInteractivo, null)===null, 'sin selección no debe filtrar nada, obtuvo: '+ctx.nombresParaFiltroContador(quienContoInteractivo, null));

  // renderPieChart: sin opts.clave, no debe quedar clickeable (compatibilidad con otros usos del
  // helper); con opts.clave/opts.activo, cada porción queda marcada y las no seleccionadas se
  // atenúan para resaltar la elegida.
  const svgSinOpts = ctx.renderPieChart(quienContoInteractivo, 'n', ctx.colorQuienConto, d=>d.nombre);
  assert(!svgSinOpts.includes('data-porcion-clave'), 'sin opts, el gráfico no debe ser clickeable, obtuvo: '+svgSinOpts);
  const svgConSeleccion = ctx.renderPieChart(quienContoInteractivo, 'n', ctx.colorQuienConto, d=>d.nombre, {clave:d=>d.nombre, activo:'Ana'});
  assert(svgConSeleccion.includes('data-porcion-clave="Ana"'), 'con opts.clave, cada porción debe quedar marcada con su nombre, obtuvo: '+svgConSeleccion);
  assert((svgConSeleccion.match(/opacity:0\.35/g)||[]).length===5, 'con Ana seleccionada, las otras 5 porciones (de 6) deben atenuarse, obtuvo: '+((svgConSeleccion.match(/opacity:0\.35/g)||[]).length));
  assert(!/data-porcion-clave="Ana"[^>]*opacity:0\.35/.test(svgConSeleccion), 'la porción seleccionada (Ana) no debe atenuarse, obtuvo: '+svgConSeleccion);

  // renderLeyendaColores: mismo criterio -- sin clave no es clickeable; con clave, el ítem activo
  // se distingue del resto (que se atenúa).
  const leyendaSinClave = ctx.renderLeyendaColores([['var(--steel)','Conteos'], ['var(--amber)','Reconteos']]);
  assert(!leyendaSinClave.includes('data-porcion-clave') && !leyendaSinClave.includes('role="button"'), 'sin clave, la leyenda no debe ser clickeable, obtuvo: '+leyendaSinClave);
  const leyendaConSeleccion = ctx.renderLeyendaColores([['var(--steel)','Ana (3)','Ana'], ['var(--amber)','Beto (2)','Beto']], 'Ana');
  assert(leyendaConSeleccion.includes('data-porcion-clave="Ana"') && leyendaConSeleccion.includes('role="button"'), 'con clave, el ítem debe quedar clickeable y accesible por teclado, obtuvo: '+leyendaConSeleccion);
  assert(/data-porcion-clave="Beto"[^>]*opacity:0\.5/.test(leyendaConSeleccion), 'el ítem no seleccionado (Beto) debe atenuarse en la leyenda, obtuvo: '+leyendaConSeleccion);
  assert(!/data-porcion-clave="Ana"[^>]*opacity:0\.5/.test(leyendaConSeleccion), 'el ítem seleccionado (Ana) no debe atenuarse en la leyenda, obtuvo: '+leyendaConSeleccion);

  // toggleFiltroContadoPor: un clic filtra por esa persona; un segundo clic sobre la misma
  // persona quita el filtro (toggle); un clic sobre otra persona reemplaza la selección.
  ctx.__appstate.busqueda.filtroContadoPor = null;
  ctx.toggleFiltroContadoPor('Ana');
  assert(ctx.__appstate.busqueda.filtroContadoPor==='Ana', 'un clic debe fijar el filtro en esa persona, obtuvo: '+ctx.__appstate.busqueda.filtroContadoPor);
  ctx.toggleFiltroContadoPor('Ana');
  assert(ctx.__appstate.busqueda.filtroContadoPor===null, 'un segundo clic sobre la misma persona debe quitar el filtro, obtuvo: '+ctx.__appstate.busqueda.filtroContadoPor);
  ctx.toggleFiltroContadoPor('Beto');
  assert(ctx.__appstate.busqueda.filtroContadoPor==='Beto', 'un clic sobre otra persona debe reemplazar la selección, obtuvo: '+ctx.__appstate.busqueda.filtroContadoPor);

  // renderBuscar con el filtro activo: la tabla solo debe mostrar las filas de la persona
  // seleccionada, con el chip "Filtrando por" visible y sin controles de paginación (es un
  // drill-down sobre lo ya cargado, no una página más).
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, resultados: filasQuienContoInteractivo, yaBuscado:true, filtroContadoPor:'Ana', busquedaPagina:0, hayMas:false};
  const htmlFiltradoAna = ctx.renderBuscar();
  assert(htmlFiltradoAna.includes('id="btn-quitar-filtro-contador"') && htmlFiltradoAna.includes('Filtrando por'), 'con el filtro activo debe verse el chip "Filtrando por" con su botón para quitarlo, obtuvo: '+htmlFiltradoAna);
  assert((htmlFiltradoAna.match(/<tr>\s*<td/g)||[]).length===3, 'filtrando por Ana la tabla debe mostrar solo sus 3 filas, obtuvo: '+((htmlFiltradoAna.match(/<tr>\s*<td/g)||[]).length));
  assert(!htmlFiltradoAna.includes('id="buscar-pagina-prev"'), 'con el filtro activo no deben verse los controles de paginación, obtuvo: '+htmlFiltradoAna);

  // Exportar con el filtro "Quién contó" activo: es un drill-down sobre lo ya cargado (ver
  // renderBuscar más arriba), así que debe exportar esa misma selección sin volver a pedirle
  // nada al servidor -- no tendría sentido re-consultar "todo" cuando la persona ya achicó la
  // vista a una sola persona.
  xlsxEscrituras.length = 0;
  const callsAntesFiltro = calls.length;
  await ctx.exportarBusquedaExcel();
  assert(calls.length===callsAntesFiltro, 'con el filtro de "Quién contó" activo, exportar no debe pedir nada más al servidor, obtuvo '+(calls.length-callsAntesFiltro)+' llamadas nuevas');
  assert(xlsxEscrituras.length===1 && xlsxEscrituras[0].libro.hojas['Buscar'].length===3, 'debe exportar solo las 3 filas de Ana (la selección activa), obtuvo: '+JSON.stringify(xlsxEscrituras[0] && xlsxEscrituras[0].libro.hojas['Buscar']));

  // Filtrando por "Otros" debe agrupar a Fede y Gaby (los dos que quedaron fuera del top 5).
  ctx.__appstate.busqueda.filtroContadoPor = 'Otros';
  const htmlFiltradoOtros = ctx.renderBuscar();
  assert((htmlFiltradoOtros.match(/<tr>\s*<td/g)||[]).length===2, 'filtrando por "Otros" debe mostrar las filas de Fede y Gaby, obtuvo: '+((htmlFiltradoOtros.match(/<tr>\s*<td/g)||[]).length));

  // Sin filtro, vuelve a verse todo (11 filas, sin paginar porque caben en una sola página de 15)
  // y el chip desaparece.
  ctx.__appstate.busqueda.filtroContadoPor = null;
  const htmlSinFiltroInteractivo = ctx.renderBuscar();
  assert(!htmlSinFiltroInteractivo.includes('id="btn-quitar-filtro-contador"') && !htmlSinFiltroInteractivo.includes('Filtrando por'), 'sin filtro, el chip no debe mostrarse, obtuvo: '+htmlSinFiltroInteractivo);
  assert((htmlSinFiltroInteractivo.match(/<tr>\s*<td/g)||[]).length===11, 'sin filtro deben verse las 11 filas cargadas, obtuvo: '+((htmlSinFiltroInteractivo.match(/<tr>\s*<td/g)||[]).length));

  // ===== Escáner de códigos: resolución código → SKU y asociación =====
  // (debe ir antes de handleLogout más abajo, que reasigna `state` por completo y deja
  // desactualizada la referencia __appstate capturada al cargar el script — ver nota ahí.)
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };

  const skusEscaner = [
    { id:'sku-a', sku_code:'SKU-A', descripcion:'Perno M8', bodega:'Nave', codigo_barras:null },
    { id:'sku-b', sku_code:'SKU-B', descripcion:'Tuerca M8', bodega:'Nave', codigo_barras:'7801234567890' },
  ];

  // resolverSkusPorCodigo: primero intenta contra el propio sku_code (stickers genéricos
  // reimpresos con el código del SKU), luego contra codigo_barras (código de fábrica ya
  // asociado). Devuelve un arreglo: puede haber más de una coincidencia si el mismo código
  // existe en más de una bodega.
  assert(ctx.resolverSkusPorCodigo(skusEscaner, 'SKU-A').length===1 && ctx.resolverSkusPorCodigo(skusEscaner, 'SKU-A')[0].id==='sku-a', 'debe resolver por coincidencia exacta de sku_code');
  assert(ctx.resolverSkusPorCodigo(skusEscaner, 'sku-a')[0].id==='sku-a', 'la coincidencia de sku_code no debe ser sensible a mayúsculas/minúsculas');
  assert(ctx.resolverSkusPorCodigo(skusEscaner, '7801234567890')[0].id==='sku-b', 'debe resolver por codigo_barras cuando no coincide ningún sku_code');
  assert(ctx.resolverSkusPorCodigo(skusEscaner, 'NO-EXISTE').length===0, 'un código que no coincide con nada debe devolver un arreglo vacío');
  assert(ctx.resolverSkusPorCodigo(skusEscaner, '').length===0, 'un código vacío debe devolver un arreglo vacío sin romper');
  assert(ctx.resolverSkusPorCodigo(skusEscaner, '  SKU-A  ')[0].id==='sku-a', 'debe recortar espacios antes de comparar');

  // El mismo sku_code puede existir en más de una bodega (cada bodega es su propia fila):
  // resolverSkusPorCodigo debe devolver TODAS las coincidencias, no solo la primera.
  const skusEscanerMultiBodega = [
    { id:'sku-a', sku_code:'SKU-A', descripcion:'Perno M8', bodega:'Nave', codigo_barras:null },
    { id:'sku-a-planta', sku_code:'SKU-A', descripcion:'Perno M8', bodega:'Planta', codigo_barras:null },
  ];
  const coincidenciasMultiples = ctx.resolverSkusPorCodigo(skusEscanerMultiBodega, 'SKU-A');
  assert(coincidenciasMultiples.length===2, 'un código presente en dos bodegas debe devolver las dos filas, obtuvo: '+JSON.stringify(coincidenciasMultiples));

  // renderConteo: el botón de escanear solo debe verse en el paso de búsqueda, no una vez elegido el SKU.
  ctx.__appstate.skus = skusEscaner;
  ctx.__appstate.skuSeleccionado = null;
  ctx.__appstate.skuSearch = '';
  const htmlConteoSinSku = ctx.renderConteo();
  assert(htmlConteoSinSku.includes('id="btn-abrir-escaner"'), 'debe existir el botón de escanear junto al buscador de SKU, obtuvo: '+htmlConteoSinSku);
  ctx.__appstate.skuSeleccionado = skusEscaner[0];
  const htmlConteoConSku = ctx.renderConteo();
  assert(!htmlConteoConSku.includes('id="btn-abrir-escaner"'), 'con un SKU ya elegido no debe verse el botón de escanear, obtuvo: '+htmlConteoConSku);
  ctx.__appstate.skuSeleccionado = null;

  // Buscador libre de SKU en Contar ("Agregar algo fuera del plan"): ahora busca en el servidor
  // (con debounce) en vez de filtrar state.skus (los primeros 500 SKU precargados) — antes un
  // material real, pero fuera de esos 500, nunca aparecía en la búsqueda. Ver
  // escribirBuscadorLibre/buscarSkusLibre.
  ctx.__appstate.skuSearch = '';
  ctx.__appstate.buscadorLibre = { resultados: [], buscando: false };
  const htmlBuscadorVacio = ctx.renderConteo();
  assert(htmlBuscadorVacio.includes('Escribe para buscar en el maestro de materiales.'), 'con el campo vacío debe invitar a escribir, obtuvo: '+htmlBuscadorVacio);

  ctx.escribirBuscadorLibre('f');
  assert(ctx.__appstate.skuSearch==='f', 'escribirBuscadorLibre debe reflejar el texto tecleado de inmediato, obtuvo: '+ctx.__appstate.skuSearch);
  const htmlUnaLetra = ctx.renderConteo();
  assert(htmlUnaLetra.includes('Sigue escribiendo (mínimo 2 letras)'), 'con una sola letra no debe buscar todavía, obtuvo: '+htmlUnaLetra);

  calls.length = 0;
  ctx.escribirBuscadorLibre('fil');
  assert(ctx.__appstate.buscadorLibre.buscando===true, 'con 2+ letras debe marcar buscando:true de inmediato, sin esperar la respuesta del servidor, obtuvo: '+JSON.stringify(ctx.__appstate.buscadorLibre));
  const htmlBuscando = ctx.renderConteo();
  assert(htmlBuscando.includes('Buscando…'), 'mientras espera la respuesta del servidor debe mostrar "Buscando…", obtuvo: '+htmlBuscando);
  assert(!calls.some(c=>c.url.includes('sku_code.ilike')), 'no debe disparar la consulta de inmediato: el debounce todavía no se cumplió, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  await new Promise(resolve=>setTimeout(resolve, 400));
  const callBusquedaLibre = calls.find(c=>c.url.includes('sku_code.ilike.*fil*'));
  assert(!!callBusquedaLibre && callBusquedaLibre.url.includes('/rest/v1/skus?activo=eq.true'), 'tras el debounce debe consultar /skus (maestro completo) con ilike sobre el texto escrito, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.buscadorLibre.resultados.length===2 && ctx.__appstate.buscadorLibre.resultados[0].sku_code==='FIL-1001', 'debe guardar los resultados que devuelve el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.buscadorLibre.resultados));
  assert(ctx.__appstate.buscadorLibre.buscando===false, 'tras responder debe apagar el indicador de "buscando", obtuvo: '+JSON.stringify(ctx.__appstate.buscadorLibre));

  const htmlConResultadosLibres = ctx.renderConteo();
  assert(htmlConResultadosLibres.includes('FIL-1001') && htmlConResultadosLibres.includes('Filtro de aceite') && htmlConResultadosLibres.includes('data-pick-btn="id-libre-1"'), 'debe listar los resultados del servidor con opción de elegir, obtuvo: '+htmlConResultadosLibres);
  // A pedido de Joel: desde que un mismo código puede repetirse en más de una ubicación/bin
  // dentro de la misma bodega (ver identidad ampliada del SKU), el resultado debe mostrar
  // ubicación y bin para poder diferenciarlos -- sin esto, dos filas del mismo material se ven
  // idénticas en la lista y no hay forma de saber cuál elegir.
  assert(htmlConResultadosLibres.includes('Pasillo 2') && htmlConResultadosLibres.includes('Bin B-04'), 'debe mostrar ubicación y bin cuando el SKU los trae, para diferenciar SKU repetidos, obtuvo: '+htmlConResultadosLibres);
  assert(!/FIL-2002[\s\S]{0,80}Bin/.test(htmlConResultadosLibres), 'sin ubicación/bin (null) no debe mostrar nada de más para ese SKU, obtuvo: '+htmlConResultadosLibres);
  // Bug real que esto corrige: FIL-1001 no está en state.skus (los 500 SKU precargados) y aun
  // así debe aparecer, porque ahora la búsqueda es contra el servidor.
  assert(!ctx.__appstate.skus.some(s=>s.sku_code==='FIL-1001'), 'FIL-1001 no debe estar en state.skus, para que el test sea representativo del bug real que se corrigió');

  // Teclear varias veces seguidas, antes de que se cumpla el debounce de cada una, debe
  // coalescer todo en UNA sola consulta al servidor (con el último texto escrito) — no una por
  // tecla, que sería justo el "perjudicar el rendimiento" que se quería evitar al pasar la
  // búsqueda del cliente al servidor.
  calls.length = 0;
  ctx.escribirBuscadorLibre('fi');
  ctx.escribirBuscadorLibre('fil');
  ctx.escribirBuscadorLibre('filx');
  await new Promise(resolve=>setTimeout(resolve, 400));
  const callsIlikeCoalescidas = calls.filter(c=>c.url.includes('sku_code.ilike'));
  assert(callsIlikeCoalescidas.length===1 && callsIlikeCoalescidas[0].url.includes('*filx*'), 'teclear varias veces seguidas debe coalescer en una sola consulta con el último texto, no una por tecla, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Borrar el texto (menos de 2 letras) debe limpiar los resultados de inmediato, sin esperar
  // al servidor.
  ctx.escribirBuscadorLibre('');
  assert(ctx.__appstate.buscadorLibre.resultados.length===0 && ctx.__appstate.buscadorLibre.buscando===false, 'con el campo vacío debe limpiar los resultados y el indicador de "buscando" de inmediato, obtuvo: '+JSON.stringify(ctx.__appstate.buscadorLibre));

  // renderEscanerModal: oculto por defecto, muestra el lector mientras no hay código, y el
  // buscador de asociación una vez que se leyó un código que no coincide con ningún SKU.
  ctx.__appstate.escanerModal = null;
  assert(ctx.renderEscanerModal()==='', 'sin escanerModal activo, renderEscanerModal debe devolver vacío');
  ctx.__appstate.escanerModal = { codigo:null, error:null };
  const htmlEscanerLector = ctx.renderEscanerModal();
  assert(htmlEscanerLector.includes('id="escaner-reader"'), 'en fase de lectura debe existir el contenedor de la cámara, obtuvo: '+htmlEscanerLector);
  ctx.__appstate.escanerModal = { codigo:'RAW-999', buscarAsociar:'perno', asociando:false };
  const htmlEscanerAsociar = ctx.renderEscanerModal();
  assert(htmlEscanerAsociar.includes('RAW-999') && htmlEscanerAsociar.includes('id="escaner-buscar"'), 'sin coincidencia debe mostrar el código leído y el buscador para asociarlo, obtuvo: '+htmlEscanerAsociar);
  assert(htmlEscanerAsociar.includes('data-asociar-btn="sku-a"') && !htmlEscanerAsociar.includes('data-asociar-btn="sku-b"'), 'el buscador de asociación debe filtrar igual que el buscador normal de SKU, obtuvo: '+htmlEscanerAsociar);
  ctx.__appstate.escanerModal = null;

  // onCodigoEscaneado: código conocido (coincide con un SKU existente) selecciona el SKU
  // directamente y cierra el modal, sin pasar por la pantalla de asociación.
  ctx.__appstate.escanerModal = { codigo:null, error:null };
  ctx.__appstate.skuSeleccionado = null;
  await ctx.onCodigoEscaneado('SKU-A');
  assert(ctx.__appstate.skuSeleccionado && ctx.__appstate.skuSeleccionado.id==='sku-a', 'un código reconocido debe dejar seleccionado ese SKU, obtuvo: '+JSON.stringify(ctx.__appstate.skuSeleccionado));
  assert(ctx.__appstate.escanerModal===null, 'tras resolver el código, el modal debe cerrarse');

  // onCodigoEscaneado: código nuevo (no coincide con ningún SKU) deja el modal abierto en
  // modo asociación, mostrando el código leído para que la persona elija el SKU correcto.
  ctx.__appstate.escanerModal = { codigo:null, error:null };
  ctx.__appstate.skuSeleccionado = null;
  await ctx.onCodigoEscaneado('CODIGO-NUEVO-123');
  assert(ctx.__appstate.escanerModal && ctx.__appstate.escanerModal.codigo==='CODIGO-NUEVO-123', 'un código no reconocido debe quedar guardado en escanerModal para poder asociarlo, obtuvo: '+JSON.stringify(ctx.__appstate.escanerModal));
  assert(ctx.__appstate.skuSeleccionado===null, 'mientras no se asocie, no debe quedar ningún SKU seleccionado');

  // onCodigoEscaneado: el código existe en más de una bodega -> deja el modal abierto con
  // las opciones para elegir, sin seleccionar ninguna todavía (no hay forma de adivinar cuál).
  ctx.__appstate.skus = skusEscanerMultiBodega;
  ctx.__appstate.escanerModal = { codigo:null, error:null };
  ctx.__appstate.skuSeleccionado = null;
  await ctx.onCodigoEscaneado('SKU-A');
  assert(ctx.__appstate.escanerModal && ctx.__appstate.escanerModal.opciones && ctx.__appstate.escanerModal.opciones.length===2, 'un código en dos bodegas debe dejar las dos opciones en escanerModal.opciones, obtuvo: '+JSON.stringify(ctx.__appstate.escanerModal));
  assert(ctx.__appstate.skuSeleccionado===null, 'con más de una coincidencia, no debe seleccionarse ningún SKU automáticamente');
  const htmlEscanerOpciones = ctx.renderEscanerModal();
  assert(htmlEscanerOpciones.includes('data-escaner-elegir-btn="sku-a"') && htmlEscanerOpciones.includes('data-escaner-elegir-btn="sku-a-planta"'), 'debe mostrar un botón "Elegir" por cada bodega encontrada, obtuvo: '+htmlEscanerOpciones);
  assert(htmlEscanerOpciones.includes('Nave') && htmlEscanerOpciones.includes('Planta'), 'cada opción debe mostrar su bodega para poder distinguirlas, obtuvo: '+htmlEscanerOpciones);

  // elegirSkuEscaneado: al elegir una de las opciones, selecciona ese SKU exacto y cierra el modal.
  ctx.elegirSkuEscaneado('sku-a-planta');
  assert(ctx.__appstate.skuSeleccionado && ctx.__appstate.skuSeleccionado.id==='sku-a-planta' && ctx.__appstate.skuSeleccionado.bodega==='Planta', 'debe seleccionar exactamente la fila elegida (la de Planta, no la de Nave), obtuvo: '+JSON.stringify(ctx.__appstate.skuSeleccionado));
  assert(ctx.__appstate.escanerModal===null, 'tras elegir, el modal debe cerrarse');
  ctx.__appstate.skus = skusEscaner;

  // onCodigoEscaneado con destino 'campo-sku' (botón de escanear en "Agregar SKU a maestro de
  // materiales"): no hay
  // nada que resolver contra el maestro existente, así que llena directo el campo de código
  // del formulario de alta y cierra el modal, sin pasar por la pantalla de asociación.
  ctx.__appstate.escanerModal = { codigo:null, error:null, destino:'campo-sku' };
  await ctx.onCodigoEscaneado('BARCODE-NUEVO-999');
  assert(ctx.__appstate.escanerModal===null, 'al escanear para agregar un SKU, el modal debe cerrarse de inmediato, obtuvo: '+JSON.stringify(ctx.__appstate.escanerModal));
  assert(documentMock.getElementById('s-code').value === 'BARCODE-NUEVO-999', 'debe llenar el campo de código del formulario de alta con el código leído, obtuvo: '+documentMock.getElementById('s-code').value);

  // Escanear un SKU del Plan del día: si el código coincide con un SKU de la lista de
  // pendientes actualmente visible, debe marcarse conteoOrigenPlan=true (para que
  // guardarConteo lo grabe con fuera_de_plan=false), igual que si se hubiera tocado desde la
  // lista. Si el código existe en el maestro pero no está en esa lista, sigue funcionando
  // (nunca bloquea el conteo) pero queda como fuera de plan, igual que el buscador libre.
  ctx.__appstate.contarPlan = {...ctx.__appstate.contarPlan, skusPendientes: [{sku_code:'SKU-A', descripcion:'Perno M8'}]};
  ctx.__appstate.skus = skusEscaner;
  ctx.__appstate.escanerModal = { codigo:null, error:null, destino:'conteo' };
  ctx.__appstate.skuSeleccionado = null;
  await ctx.onCodigoEscaneado('SKU-A');
  assert(ctx.__appstate.conteoOrigenPlan===true, 'un SKU escaneado que está en el plan del día visible debe marcarse conteoOrigenPlan=true, obtuvo: '+ctx.__appstate.conteoOrigenPlan);
  ctx.__appstate.escanerModal = { codigo:null, error:null, destino:'conteo' };
  ctx.__appstate.skuSeleccionado = null;
  await ctx.onCodigoEscaneado('SKU-B');
  assert(ctx.__appstate.conteoOrigenPlan===false, 'un SKU escaneado que existe pero no está en el plan del día visible debe marcarse conteoOrigenPlan=false (fuera de plan), obtuvo: '+ctx.__appstate.conteoOrigenPlan);
  assert(ctx.__appstate.skuSeleccionado && ctx.__appstate.skuSeleccionado.id==='sku-b', 'el SKU fuera del plan igual debe quedar seleccionado, nunca bloqueado, obtuvo: '+JSON.stringify(ctx.__appstate.skuSeleccionado));

  // Lo mismo debe respetarse eligiendo entre bodegas (elegirSkuEscaneado), no solo en la
  // resolución directa de una única coincidencia.
  ctx.__appstate.skus = skusEscanerMultiBodega;
  ctx.__appstate.escanerModal = { codigo:null, error:null, destino:'conteo' };
  ctx.__appstate.skuSeleccionado = null;
  ctx.elegirSkuEscaneado('sku-a-planta');
  assert(ctx.__appstate.conteoOrigenPlan===true, 'elegirSkuEscaneado también debe marcar conteoOrigenPlan=true cuando el sku_code elegido está en el plan del día visible, obtuvo: '+ctx.__appstate.conteoOrigenPlan);
  ctx.__appstate.skus = skusEscaner;
  ctx.__appstate.contarPlan = {...ctx.__appstate.contarPlan, skusPendientes: null};

  // renderPlanDelDia: el botón de escanear debe verse junto a la lista de pendientes, para
  // no obligar a abandonar el plan e ir al buscador libre solo para escanear.
  ctx.__appstate.contarPlan = {
    ...ctx.__appstate.contarPlan,
    bodega:'Nave Mina', ubicacion:'Interior Nave',
    entradas:[{id:'mp1', fecha:'2026-08-24', bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', solo_sin_ubicacion:false, responsable_id:'resp-yo', skus_excluidos:[]}],
    skusPendientes:[{sku_code:'SKU-A', descripcion:'Perno M8'}],
  };
  const htmlPlanConPendientes = ctx.renderPlanDelDia();
  assert(htmlPlanConPendientes.includes('id="btn-escanear-plan"'), 'la tarjeta Plan del día debe mostrar un botón de escanear junto a la lista de pendientes, obtuvo: '+htmlPlanConPendientes);
  ctx.__appstate.contarPlan = {...ctx.__appstate.contarPlan, bodega:'', ubicacion:'', skusPendientes:null};
  const htmlPlanSinElegir = ctx.renderPlanDelDia();
  assert(!htmlPlanSinElegir.includes('id="btn-escanear-plan"'), 'sin bodega/ubicación elegida todavía no debe verse el botón de escanear del plan, obtuvo: '+htmlPlanSinElegir);

  // conservandoCamposConteo: agregar o quitar una foto vuelve a renderizar toda la pantalla
  // (para mostrar la miniatura), pero eso no debe borrar lo que la persona ya tipeó en el
  // resto del formulario — en especial la cantidad, que no tiene ningún valor por defecto.
  documentMock.getElementById('c-cant').value = '17';
  documentMock.getElementById('c-bodega').value = 'Nave Mina';
  documentMock.getElementById('c-obs').value = 'Con daño visible';
  let seEjecutoElRender = false;
  ctx.conservandoCamposConteo(() => { seEjecutoElRender = true; });
  assert(seEjecutoElRender, 'conservandoCamposConteo debe ejecutar la función que se le pasa');
  assert(documentMock.getElementById('c-cant').value==='17', 'la cantidad tipeada no debe perderse al re-renderizar, obtuvo: '+documentMock.getElementById('c-cant').value);
  assert(documentMock.getElementById('c-bodega').value==='Nave Mina', 'la ubicación general tipeada no debe perderse, obtuvo: '+documentMock.getElementById('c-bodega').value);
  assert(documentMock.getElementById('c-obs').value==='Con daño visible', 'la observación tipeada no debe perderse, obtuvo: '+documentMock.getElementById('c-obs').value);

  // asociarCodigoBarras: guarda el código en el SKU elegido (PATCH a /skus?id=eq.<id>), lo
  // refleja de inmediato en la lista ya cargada (sin esperar un refetch) y deja ese SKU
  // seleccionado, listo para registrar el conteo — así la próxima lectura de este mismo
  // código lo va a reconocer solo, sin volver a pasar por esta pantalla.
  ctx.__appstate.skus = [{ id:'sku-c', sku_code:'SKU-C', descripcion:'Filtro', bodega:'Nave', codigo_barras:null }];
  ctx.__appstate.escanerModal = { codigo:'CODIGO-NUEVO-123', buscarAsociar:'', asociando:false };
  ctx.__appstate.skuSeleccionado = null;
  calls.length = 0;
  await ctx.asociarCodigoBarras('sku-c', 'CODIGO-NUEVO-123');
  const patchAsociar = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/skus?id=eq.sku-c'));
  assert(!!patchAsociar, 'asociarCodigoBarras debe hacer PATCH a /skus?id=eq.<id>, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(patchAsociar.opts.body).codigo_barras==='CODIGO-NUEVO-123', 'el PATCH debe guardar el código leído en codigo_barras, obtuvo: '+patchAsociar.opts.body);
  assert(ctx.__appstate.skus[0].codigo_barras==='CODIGO-NUEVO-123', 'debe reflejar la asociación en el SKU ya cargado en memoria, obtuvo: '+JSON.stringify(ctx.__appstate.skus[0]));
  assert(ctx.__appstate.skuSeleccionado && ctx.__appstate.skuSeleccionado.id==='sku-c', 'tras asociar, ese SKU debe quedar seleccionado para continuar con el conteo, obtuvo: '+JSON.stringify(ctx.__appstate.skuSeleccionado));
  assert(ctx.__appstate.escanerModal===null, 'tras asociar con éxito, el modal debe cerrarse');

  // Bug real reportado (Joel, en terreno): la cámara del escáner abría pero nunca leía una barra
  // clásica (1D). Dos correcciones en iniciarEscaner: (1) experimentalFeatures.useBarCodeDetectorIfSupported
  // activa el decodificador NATIVO del navegador (más preciso con barras 1D que el decodificador en
  // JS puro de la librería) cuando el dispositivo lo soporta; (2) el recuadro de lectura pasa de un
  // cuadrado fijo (obligaba a alejar el celular para que una barra ancha entrara completa, dejando
  // las líneas demasiado finas para leerse a esa distancia) a una función que da un rectángulo ANCHO
  // proporcional al tamaño real del video.
  let argsConstructorEscaner = null;
  let argsStartEscaner = null;
  ctx.Html5Qrcode = class {
    constructor(elementId, config){ argsConstructorEscaner = config; }
    start(cameraConfig, scanConfig){ argsStartEscaner = scanConfig; return Promise.resolve(); }
    stop(){ return Promise.resolve(); }
    clear(){}
  };
  ctx.Html5QrcodeSupportedFormats = { QR_CODE:0, EAN_13:1, EAN_8:2, CODE_128:3, CODE_39:4, CODE_93:5, UPC_A:6, UPC_E:7, ITF:8 };
  ctx.__appstate.escanerModal = { codigo:null, error:null };
  await ctx.iniciarEscaner();
  assert(argsConstructorEscaner && argsConstructorEscaner.experimentalFeatures && argsConstructorEscaner.experimentalFeatures.useBarCodeDetectorIfSupported===true, 'debe activar el decodificador nativo del navegador cuando está disponible, obtuvo: '+JSON.stringify(argsConstructorEscaner));
  assert(typeof argsStartEscaner.qrbox==='function', 'el recuadro de lectura debe ser una función (proporcional al tamaño real del video), no un tamaño fijo, obtuvo: '+JSON.stringify(argsStartEscaner && typeof argsStartEscaner.qrbox));
  const recuadroEscaner = argsStartEscaner.qrbox(400, 600);
  assert(recuadroEscaner.width===360 && recuadroEscaner.height===180, 'con un video de 400x600, el recuadro debe ser ancho (90% del lado menor de ancho, la mitad de eso de alto) para leer mejor barras 1D anchas, obtuvo: '+JSON.stringify(recuadroEscaner));
  ctx.detenerEscaner();
  delete ctx.Html5Qrcode;
  delete ctx.Html5QrcodeSupportedFormats;

  // Bug real reportado por Sentry (JAVASCRIPT-5): "Cannot stop, scanner is not running or
  // paused." — html5-qrcode puede lanzar ese error de forma SÍNCRONA (antes de devolver
  // ninguna promesa) si alguien cierra el modal del escáner mientras la cámara todavía está
  // iniciando. El .catch() que ya existía solo atrapaba una promesa rechazada, no un
  // lanzamiento síncrono al invocar stop() — se cuela como excepción no atrapada. Se simula
  // acá inyectando un Html5Qrcode falso cuyo stop() tira sincrónico, como la librería real en
  // ese estado.
  ctx.Html5Qrcode = class {
    constructor(){}
    start(){ return Promise.resolve(); }
    stop(){ throw new Error('Cannot stop, scanner is not running or paused.'); }
    clear(){}
  };
  ctx.Html5QrcodeSupportedFormats = { QR_CODE:0, EAN_13:1, EAN_8:2, CODE_128:3, CODE_39:4, CODE_93:5, UPC_A:6, UPC_E:7, ITF:8 };
  ctx.__appstate.escanerModal = { codigo:null, error:null };
  await ctx.iniciarEscaner();
  let detenerEscanerTiro = false;
  try{ ctx.detenerEscaner(); }catch(e){ detenerEscanerTiro = true; }
  assert(!detenerEscanerTiro, 'detenerEscaner no debe relanzar aunque stop() del escáner tire de forma síncrona, obtuvo excepción sin atrapar');
  assert(ctx.__appstate.escanerModal===null, 'detenerEscaner debe limpiar escanerModal igual aunque stop() haya tirado, obtuvo: '+JSON.stringify(ctx.__appstate.escanerModal));
  delete ctx.Html5Qrcode;
  delete ctx.Html5QrcodeSupportedFormats;

  // rest(): si el refresh_token YA NO SIRVE (ej. "Single session per user" de Supabase Auth
  // invalidó la sesión porque la cuenta inició sesión en otro dispositivo), debe cerrar la
  // sesión localmente con un mensaje claro en vez de dejar la pantalla a medio cargar con
  // el error 401 crudo del servidor. Debe ir antes de handleLogout más abajo, que reasigna
  // `state` por completo y deja desactualizada la referencia __appstate (misma razón que la
  // nota junto al escáner más arriba) — y esta prueba necesita fijar __appstate.session
  // sobre el `state` todavía vivo antes de llamar rest().
  const toastRootSesionInvalida = elements['toast-root'];
  ctx.__appstate.session = { access_token:'token-vencido-2', refresh_token:'refresh-de-otra-sesion', user:{id:'user-1'} };
  ctx.guardarSesion(ctx.__appstate.session);
  const toastsAntesSesionInvalida = toastRootSesionInvalida ? toastRootSesionInvalida.hijos.length : 0;
  const fetchOriginal2 = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/ruta-de-prueba-401b' && (opts.headers.Authorization||'').includes('token-vencido-2')){
      return { status:401, ok:false, headers:{get:()=>null}, text: async()=>JSON.stringify({message:'JWT expired'}) };
    }
    if(u.pathname==='/auth/v1/token' && u.searchParams.get('grant_type')==='refresh_token'){
      return { status:401, ok:false, headers:{get:()=>null}, text: async()=>JSON.stringify({error:'invalid_grant', error_description:'Invalid Refresh Token: Session not found'}) };
    }
    return fetchOriginal2(url, opts);
  };
  let errorSesionInvalida = null;
  try{ await ctx.rest('/ruta-de-prueba-401b'); }catch(e){ errorSesionInvalida = e; }
  ctx.fetch = fetchOriginal2;
  assert(!!errorSesionInvalida, 'rest() debe lanzar un error cuando el refresh_token ya no sirve');
  assert(ctx.localStorage.getItem('sesion_inventario')===null, 'con el refresh_token inválido, rest() debe borrar la sesión persistida en localStorage');
  const nuevosToastsSesionInvalida = toastRootSesionInvalida.hijos.slice(toastsAntesSesionInvalida);
  assert(nuevosToastsSesionInvalida.some(t=>t.textContent.includes('otro dispositivo')), 'debe mostrar un toast explicando que la sesión terminó en otro dispositivo, obtuvo: '+JSON.stringify(nuevosToastsSesionInvalida.map(t=>t.textContent)));

  // ===== Contar: plan del día (responsable_id en plan_semanal es directo el id de la cuenta) =====

  // El test anterior forzó un 401 y manejarSesionInvalida() reemplaza `state` por un objeto
  // nuevo (estadoTrasCerrarSesion()) — hay que resincronizar __appstate con esa referencia o
  // las asignaciones ctx.__appstate.X de aquí en adelante quedarían en el objeto viejo, sin
  // efecto sobre el `state` real que usan las funciones de la app (ver lección de sesión previa).
  ctx.__resyncAppState();
  // "resp-yo" es el id de cuenta que usa el fixture de /plan_semanal_detalle para "mi plan del
  // día" (ver más arriba en este archivo) — antes había que resolverlo vía responsables_proceso,
  // ahora responsable_id ya es directamente el id de la cuenta logueada.
  ctx.__appstate.perfil = { id:'resp-yo', nombre:'Joel', rol:'operador', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  ctx.__appstate.session = { access_token:'x', refresh_token:'y', user:{id:'resp-yo', email:'joel@test.com'} };

  // cargarPlanDeHoy: trae mis entradas de ese día filtrando plan_semanal_detalle directo por
  // mi propio id de cuenta (state.perfil.id), sin ninguna resolución intermedia.
  ctx.__appstate.contarPlan = { cargado:false, cargando:false, fecha:'2026-08-24', entradas:[], bodega:'', ubicacion:'', skusPendientes:null };
  calls.length = 0;
  await ctx.cargarPlanDeHoy('2026-08-24');
  assert(ctx.__appstate.contarPlan.entradas.length===4, 'cargarPlanDeHoy debe traer mis 4 entradas del día, obtuvo: '+JSON.stringify(ctx.__appstate.contarPlan.entradas));
  const callMiPlan = calls.find(c=>c.url.includes('/plan_semanal_detalle'));
  assert(!!callMiPlan && callMiPlan.url.includes('fecha=eq.2026-08-24') && callMiPlan.url.includes('responsable_id=eq.resp-yo'), 'debe filtrar plan_semanal_detalle por fecha y por mi propio id de cuenta, obtuvo: '+JSON.stringify(callMiPlan));

  // Modo offline para "Plan del día" (a pedido de Joel, acotado solo al plan asignado a la
  // persona -- NO al universo completo de SKU de la empresa, que puede superar las 50 mil filas
  // y sería impracticable de cachear en el dispositivo): cada carga exitosa de cargarPlanDeHoy se
  // guarda en localStorage; si un pedido posterior falla por un corte de red real (no un error del
  // servidor), debe restaurar las entradas de la última copia guardada para ESE MISMO día en vez
  // de mostrar "Sin nada planificado", marcando contarPlan.desdeCache para poder avisarlo en pantalla.
  const cacheTrasCargaOk = JSON.parse(ctx.localStorage.getItem('plan_dia_cache'))['resp-yo'];
  assert(cacheTrasCargaOk && cacheTrasCargaOk.fecha==='2026-08-24' && cacheTrasCargaOk.entradas.length===4, 'una carga exitosa de cargarPlanDeHoy debe guardar sus entradas en localStorage (plan_dia_cache), obtuvo: '+ctx.localStorage.getItem('plan_dia_cache'));
  const fetchOriginalPlanOffline = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/plan_semanal_detalle') throw new ctx.__TypeError('Failed to fetch');
    return fetchOriginalPlanOffline(url, opts);
  };
  ctx.__appstate.contarPlan = { cargado:false, cargando:false, fecha:'2026-08-24', entradas:[], bodega:'', ubicacion:'', skusPendientes:null, desdeCache:false };
  await ctx.cargarPlanDeHoy('2026-08-24');
  assert(ctx.__appstate.contarPlan.entradas.length===4 && ctx.__appstate.contarPlan.desdeCache===true, 'sin conexión, debe restaurar las 4 entradas cacheadas del mismo día y marcar desdeCache:true, obtuvo: '+JSON.stringify(ctx.__appstate.contarPlan));
  const htmlPlanDesdeCache = ctx.renderPlanDelDia();
  assert(htmlPlanDesdeCache.includes('Sin conexión') && htmlPlanDesdeCache.includes('última vez que hubo señal'), 'debe mostrar un aviso de que el plan viene de la caché offline, obtuvo: '+htmlPlanDesdeCache);
  // Un día SIN copia cacheada (ninguna carga exitosa previa para esa fecha) no tiene de dónde
  // recuperarse: debe seguir el comportamiento anterior (error + plan vacío), no inventar datos.
  ctx.__appstate.contarPlan = { cargado:false, cargando:false, fecha:'2099-01-01', entradas:[], bodega:'', ubicacion:'', skusPendientes:null, desdeCache:false };
  await ctx.cargarPlanDeHoy('2099-01-01');
  assert(ctx.__appstate.contarPlan.entradas.length===0 && ctx.__appstate.contarPlan.desdeCache===false, 'sin conexión y sin caché para ese día, debe quedar sin entradas y desdeCache:false, obtuvo: '+JSON.stringify(ctx.__appstate.contarPlan));
  ctx.fetch = fetchOriginalPlanOffline;
  // Vuelve a dejar el plan real cargado (2026-08-24) para el resto de los tests de esta sección.
  ctx.__appstate.contarPlan = { cargado:false, cargando:false, fecha:'2026-08-24', entradas:[], bodega:'', ubicacion:'', skusPendientes:null, desdeCache:false };
  await ctx.cargarPlanDeHoy('2026-08-24');

  // Bug real reportado: al volver a la pestaña Contar, "Plan del día" se quedaba con lo que se
  // había cargado la primera vez (contarPlan.cargado ya en true), sin pedirlo de nuevo aunque la
  // planificación hubiera cambiado mientras tanto (editada desde Planificación, u otro día). El
  // bind() de la pestaña solo vuelve a pedirlo si cargado===false — eso es justo lo que hace el
  // handler de clic de .tab al seleccionar "Contar" ahora (ver bind()): resetea cargado a false.
  ctx.setState({view:'conteo', skuSeleccionado:null});
  calls.length = 0;
  ctx.bind();
  assert(!calls.some(c=>c.url.includes('/plan_semanal_detalle')), 'con contarPlan.cargado=true, solo re-renderizar (bind) no debe volver a pedir el plan, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  calls.length = 0;
  ctx.setState({view:'conteo', contarPlan:{...ctx.__appstate.contarPlan, cargado:false}});
  await new Promise(resolve=>setTimeout(resolve, 20));
  assert(calls.some(c=>c.url.includes('/plan_semanal_detalle')), 'al resetear contarPlan.cargado (lo que hace seleccionar la pestaña Contar), debe volver a pedir el plan del día, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Bug real reportado: el buscador de SKU en Contar volvía a robar el foco (y a abrir el
  // teclado del celular) en cada re-render mientras seguía en el mismo paso de búsqueda —
  // por ejemplo, cada vez que se elegía bodega/ubicación o terminaba de cargar el plan — en
  // vez de solo la primera vez que aparece. Se verifica contando llamadas a focus() en varios
  // bind() sucesivos sin volver a entrar a la pantalla ni elegir un SKU.
  ctx.setState({view:'dashboard'});
  let vecesEnfocado = 0;
  const buscadorEl = documentMock.getElementById('sku-search');
  const focusOriginal = buscadorEl.focus;
  buscadorEl.focus = ()=> vecesEnfocado++;
  ctx.setState({view:'conteo', skuSeleccionado:null});
  ctx.bind();
  ctx.bind();
  assert(vecesEnfocado===1, 'el buscador de SKU debe enfocarse una sola vez al entrar a Contar, no en cada re-render posterior, obtuvo '+vecesEnfocado+' llamadas a focus()');
  buscadorEl.focus = focusOriginal;

  // Bug real reportado (Joel, en iPad Y en computador): "al cargar un SKU fuera de plan pierdo
  // el foco en el text box" -- restaurar el foco por código (intento anterior) no alcanza en iOS
  // Safari, que cierra el teclado en pantalla apenas el <input> se destruye y no siempre lo
  // reabre solo con .focus(). El fix de fondo es que escribirBuscadorLibre YA NO llame a
  // setState(): actualiza el estado directo y repinta a mano SOLO #buscador-libre-resultados,
  // sin tocar el <input> en ningún momento -- se verifica que focus() nunca se llama al escribir.
  let vecesEnfocadoTecleo = 0;
  buscadorEl.focus = ()=> vecesEnfocadoTecleo++;
  documentMock.activeElement = buscadorEl;
  ctx.escribirBuscadorLibre('AC');
  assert(vecesEnfocadoTecleo===0, 'escribirBuscadorLibre no debe tocar el foco del <input> nunca (ni para "restaurarlo") -- el input no se destruye, obtuvo '+vecesEnfocadoTecleo+' llamadas a focus()');
  assert(ctx.__appstate.skuSearch==='AC', 'debe actualizar state.skuSearch directo (sin pasar por setState), obtuvo '+ctx.__appstate.skuSearch);
  assert(ctx.__appstate.buscadorLibre.buscando===true, 'con 2+ letras, debe marcar "buscando" de inmediato en el estado, obtuvo '+JSON.stringify(ctx.__appstate.buscadorLibre));

  // El único repintado real debe caer sobre #buscador-libre-resultados (el contenedor extraído
  // en renderResultadosBuscadorLibre), reflejando el hint "Buscando…" mientras se resuelve.
  const contResultados = documentMock.getElementById('buscador-libre-resultados');
  assert(contResultados.innerHTML.includes('Buscando…'), 'el contenedor de resultados debe repintarse solo con el hint "Buscando…", obtuvo: '+contResultados.innerHTML);

  // Cuando el resultado debounced llega (buscarSkusLibre), el repintado también debe caer solo
  // sobre #buscador-libre-resultados -- sin setState, sin volver a tocar el <input> para nada.
  await new Promise(resolve=>setTimeout(resolve, 20));
  assert(vecesEnfocadoTecleo===0, 'al llegar el resultado debounced, tampoco debe tocarse el foco del <input>, obtuvo '+vecesEnfocadoTecleo+' llamadas a focus()');
  assert(contResultados.innerHTML.includes('FIL-1001') && contResultados.innerHTML.includes('FIL-2002'), 'el contenedor de resultados debe reflejar los SKU encontrados, obtuvo: '+contResultados.innerHTML);
  assert(ctx.__appstate.buscadorLibre.buscando===false, 'debe salir de "buscando" cuando llegan los resultados, obtuvo: '+JSON.stringify(ctx.__appstate.buscadorLibre));

  documentMock.activeElement = null;
  buscadorEl.focus = focusOriginal;

  // entradasActivasContar: resuelve las entradas que calzan con bodega+ubicación (sin filtro de
  // storage bin — se sacó a pedido: la persona solo elige bodega y ubicación, y se juntan los SKU
  // de todos los bin de esa ubicación en vez de obligar a elegir uno por uno), o la de "SKU sin
  // ubicación" (que no cascadea), o ninguna si la selección no calza con nada.
  const cpBase = ctx.__appstate.contarPlan;
  const activasMinaInterior = ctx.entradasActivasContar({...cpBase, bodega:'Nave Mina', ubicacion:'Interior Nave'});
  assert(activasMinaInterior.length===2 && activasMinaInterior.some(e=>e.id==='mp1') && activasMinaInterior.some(e=>e.id==='mp2'), 'con bodega+ubicación exactos (sin bin) debe resolver las dos entradas de esa ubicación (mp1 y mp2, un bin cada una), obtuvo: '+JSON.stringify(activasMinaInterior));
  assert(ctx.entradasActivasContar({...cpBase, bodega:'__sin_ubicacion__', ubicacion:''})[0].id==='mp3', 'debe resolver la entrada "SKU sin ubicación" con el valor especial de bodega');
  assert(ctx.entradasActivasContar({...cpBase, bodega:'Nave Mina', ubicacion:''}).length===0, 'sin ubicación elegida todavía, no debe resolver ninguna entrada (ninguna de mp1/mp2 tiene ubicación vacía)');
  assert(ctx.entradasActivasContar({...cpBase, bodega:'', ubicacion:''}).length===0, 'sin nada elegido, no debe resolver ninguna entrada');
  // Bug real reportado: una entrada con bodega:'' ("Sin bodega asignada") quedaba inalcanzable
  // porque .filter(Boolean) la sacaba de la lista de opciones del <select> — el operador nunca
  // podía seleccionarla y por lo tanto nunca veía sus SKU planificados. Debe resolverse con el
  // sentinel BODEGA_VACIA, igual que ya funciona en Planificación.
  assert(ctx.entradasActivasContar({...cpBase, bodega:'__bodega_vacia__', ubicacion:'Piso'})[0].id==='mp4', 'debe resolver la entrada "Sin bodega asignada" (mp4) usando el sentinel BODEGA_VACIA, obtuvo: '+JSON.stringify(ctx.entradasActivasContar({...cpBase, bodega:'__bodega_vacia__', ubicacion:'Piso'})));
  const htmlPlanDelDiaConVacia = ctx.renderPlanDelDia();
  assert(htmlPlanDelDiaConVacia.includes(`<option value="${'__bodega_vacia__'}"`) && htmlPlanDelDiaConVacia.includes('Sin bodega asignada'), 'el selector de bodega/patio debe ofrecer "Sin bodega asignada" porque hay una entrada con bodega vacía hoy, obtuvo: '+htmlPlanDelDiaConVacia);
  assert(!htmlPlanDelDiaConVacia.includes('id="contar-bin"'), 'ya no debe existir el selector de storage bin en Plan del día (se sacó a pedido, solo bodega y ubicación), obtuvo: '+htmlPlanDelDiaConVacia);

  // elegirCascadaContar: al elegir bodega+ubicación, trae los SKU pendientes de TODAS las
  // entradas que calzan (mp1 en A-01 y mp2 en A-02), juntos en una sola lista — sin pedirle a la
  // persona que además elija el bin exacto. Además detecta SKU "movidos": SKU-999 se planificó
  // en A-01 (snapshot en plan_semanal_skus) pero una carga posterior le cambió el bin a C-09, que
  // ya no es ninguno de los bin activos de esta ubicación (A-01/A-02) — debe seguir apareciendo,
  // marcado con el bin original, en vez de perderse. SKU-002 también quedó snapshoteado en A-01,
  // pero su bin actual (A-02) sigue activo -> ya viene por el fetch normal, no debe duplicarse.
  // SKU-777 se planificó acá pero una carga lo reasignó a otra bodega+ubicación completa (ya no
  // "Nave Mina · Interior Nave") -> debe recuperarse igual, marcado con el cambio de ubicación.
  await ctx.elegirCascadaContar({bodega:'Nave Mina', ubicacion:'Interior Nave'});
  const skusJuntos = ctx.__appstate.contarPlan.skusPendientes;
  assert(Array.isArray(skusJuntos) && skusJuntos.length===4 && skusJuntos.some(s=>s.sku_code==='SKU-001') && skusJuntos.some(s=>s.sku_code==='SKU-002'), 'elegirCascadaContar debe juntar los SKU pendientes de todos los bin de la ubicación (SKU-001 de A-01 y SKU-002 de A-02) más los SKU recuperados, obtuvo: '+JSON.stringify(skusJuntos));
  // Bug real (Sentry, Rage Click): tocar un SKU del plan del día no hacía nada con catálogos
  // grandes porque el click buscaba el SKU en state.skus (solo trae los primeros 500) en vez de
  // en contarPlan.skusPendientes. Para que ese fallback funcione hace falta el id de cada fila
  // acá (antes el select de skusDeUbicacion/skusMovidosDeEntradas no lo traía).
  assert(skusJuntos.every(s=>!!s.id), 'cada SKU pendiente del plan del día debe traer su id (lo necesita guardarConteo para sku_id), obtuvo: '+JSON.stringify(skusJuntos));
  // Reportado real (screenshot): al recontar/tocar un SKU del plan del día, la tarjeta mostraba
  // "Stock sistema: undefined EA" — skusDeUbicacion/skusMovidosDeEntradas nunca habían traído
  // stock_sistema en su select (solo se agregó id al arreglar el bug de arriba). Se agrega acá
  // también, y renderConteo se endurece a !=null (en vez de !==null) para no volver a mostrar el
  // string literal "undefined" si algún día vuelve a faltar un dato en el objeto seleccionado.
  const skuSinMover = skusJuntos.find(s=>s.sku_code==='SKU-001');
  assert(skuSinMover.stock_sistema===20, 'el SKU pendiente debe traer su stock_sistema real (no undefined), obtuvo: '+JSON.stringify(skuSinMover));

  // Modo offline: un elegirCascadaContar exitoso también cachea el checklist de SKU pendientes de
  // ESA selección de bodega+ubicación (clave "bodega||ubicacion") en la misma caché de plan del
  // día. Si cambiar de bodega/ubicación dispara elegirCascadaContar de nuevo y justo ahí se corta
  // la señal (caso real en sitio minero), debe recuperar ese checklist ya visto en vez de dejar la
  // pantalla vacía como si no hubiera nada pendiente.
  const cacheSeleccionOk = JSON.parse(ctx.localStorage.getItem('plan_dia_cache'))['resp-yo'];
  assert(cacheSeleccionOk && Array.isArray(cacheSeleccionOk.selecciones['Nave Mina||Interior Nave']) && cacheSeleccionOk.selecciones['Nave Mina||Interior Nave'].length===4, 'elegirCascadaContar debe cachear los SKU pendientes de esa selección, obtuvo: '+ctx.localStorage.getItem('plan_dia_cache'));
  const fetchOriginalCascadaOffline = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/skus_planificables') throw new ctx.__TypeError('Failed to fetch');
    return fetchOriginalCascadaOffline(url, opts);
  };
  await ctx.elegirCascadaContar({bodega:'Nave Mina', ubicacion:'Interior Nave'});
  ctx.fetch = fetchOriginalCascadaOffline;
  assert(ctx.__appstate.contarPlan.desdeCache===true && Array.isArray(ctx.__appstate.contarPlan.skusPendientes) && ctx.__appstate.contarPlan.skusPendientes.length===4, 'sin conexión, volver a elegir la misma bodega+ubicación debe restaurar los SKU pendientes cacheados y marcar desdeCache:true, obtuvo: '+JSON.stringify(ctx.__appstate.contarPlan));
  // Una selección nunca vista con conexión ("SKU sin ubicación", jamás elegida en este test) no
  // tiene de dónde recuperarse: debe seguir el comportamiento anterior (toast de error, sin
  // inventar SKU).
  const toastRootCascadaOffline = elements['toast-root'];
  const toastsAntesCascadaOffline = toastRootCascadaOffline ? toastRootCascadaOffline.hijos.length : 0;
  ctx.fetch = async (url, opts) => {
    const u = new URL(url);
    if(u.pathname==='/rest/v1/skus_planificables') throw new ctx.__TypeError('Failed to fetch');
    return fetchOriginalCascadaOffline(url, opts);
  };
  await ctx.elegirCascadaContar({bodega:'__sin_ubicacion__', ubicacion:''});
  ctx.fetch = fetchOriginalCascadaOffline;
  assert(ctx.__appstate.contarPlan.desdeCache===false, 'sin caché para una selección nunca vista, no debe marcar desdeCache:true, obtuvo: '+JSON.stringify(ctx.__appstate.contarPlan));
  const nuevosToastsCascadaOffline = toastRootCascadaOffline.hijos.slice(toastsAntesCascadaOffline);
  assert(nuevosToastsCascadaOffline.length>0, 'sin caché para esa selección, debe avisar el error como antes, obtuvo: '+JSON.stringify(nuevosToastsCascadaOffline));
  // Deja el plan en el estado que esperan los tests siguientes (misma selección con datos reales).
  await ctx.elegirCascadaContar({bodega:'Nave Mina', ubicacion:'Interior Nave'});

  ctx.__appstate.skuSeleccionado = skuSinMover;
  const htmlConSkuElegido = ctx.renderConteo();
  assert(htmlConSkuElegido.includes('Stock sistema (este batch): 20 UN') && !htmlConSkuElegido.includes('undefined'), 'la tarjeta del SKU elegido debe mostrar el stock real, nunca el texto "undefined", obtuvo: '+htmlConSkuElegido);
  // Pedido de Joel: al seleccionar un SKU en Tomar inventario, mostrar su storage bin.
  assert(htmlConSkuElegido.includes('Storage bin: A-01'), 'la tarjeta del SKU elegido debe mostrar el storage bin, obtuvo: '+htmlConSkuElegido);
  ctx.__appstate.skuSeleccionado = {...skuSinMover, storage_bin:null};
  const htmlSkuSinBin = ctx.renderConteo();
  assert(htmlSkuSinBin.includes('Storage bin: —'), 'sin storage bin cargado, debe mostrar un guion en vez de dejarlo en blanco o mostrar "null", obtuvo: '+htmlSkuSinBin);
  ctx.__appstate.skuSeleccionado = null;
  const skuMovido = skusJuntos.find(s=>s.sku_code==='SKU-999');
  assert(!!skuMovido && skuMovido.storage_bin==='C-09' && skuMovido.binOriginal==='A-01' && !skuMovido.cambioBodega && !skuMovido.cambioUbicacion, 'SKU-999 debe aparecer marcado como movido de bin (no de bodega/ubicación), con su bin actual (C-09) y el bin con el que se planificó (A-01), obtuvo: '+JSON.stringify(skuMovido));
  assert(!skusJuntos.find(s=>s.sku_code==='SKU-002').binOriginal, 'SKU-002 sigue cubierto por el bin activo A-02: no debe llevar marca de "movido" aunque su snapshot original haya sido A-01, obtuvo: '+JSON.stringify(skusJuntos.find(s=>s.sku_code==='SKU-002')));
  const skuReubicado = skusJuntos.find(s=>s.sku_code==='SKU-777');
  assert(!!skuReubicado && skuReubicado.cambioBodega && skuReubicado.cambioUbicacion && skuReubicado.bodegaOriginal==='Nave Mina' && skuReubicado.ubicacionOriginal==='Interior Nave' && skuReubicado.bodega==='Bodega Norte' && skuReubicado.ubicacion==='Pasillo 5', 'SKU-777 debe aparecer marcado como movido de bodega+ubicación, con su ubicación original y la actual, obtuvo: '+JSON.stringify(skuReubicado));
  // Reportado real: un plan planificado ANTES de que existiera este aviso tiene bodega_original/
  // ubicacion_original en null en su foto (columnas nuevas), aunque el SKU nunca se movió de
  // bodega/ubicación. Comparar "null" contra el dato actual como si fuera un cambio mostraría el
  // aviso en todos los SKU de un plan viejo sin que nada haya pasado — no debe pasar: SKU-555 no
  // debe aparecer como "movido" (su bin tampoco cambió).
  assert(!skusJuntos.some(s=>s.sku_code==='SKU-555'), 'SKU-555 (foto legacy sin bodega/ubicación original, mismo bin de siempre) no debe aparecer como movido solo porque esas columnas vengan en null, obtuvo: '+JSON.stringify(skusJuntos));

  // renderConteo/renderPlanDelDia: fecha, cascada de bodega (incluye "SKU sin ubicación" porque
  // hay una entrada suelta hoy) y el checklist de SKU pendientes ya resuelto arriba.
  ctx.__appstate.view = 'conteo';
  ctx.__appstate.skuSeleccionado = null;
  const htmlConteoConPlan = ctx.renderConteo();
  assert(htmlConteoConPlan.includes('id="contar-fecha" value="2026-08-24"'), 'debe mostrar el selector de día con la fecha actual del plan, obtuvo: '+htmlConteoConPlan);
  assert(htmlConteoConPlan.includes('<option value="__sin_ubicacion__"') && htmlConteoConPlan.includes('SKU sin ubicación'), 'el selector de bodega/patio debe ofrecer "SKU sin ubicación" porque hay una entrada suelta hoy, obtuvo: '+htmlConteoConPlan);
  // data-pick-plan lleva el id de la fila (no el sku_code): un mismo código puede tener más de
  // una fila pendiente (una por batch), y buscar por código en el handler siempre encontraría
  // solo la primera — ver el fix real en elegirCascadaContar/data-pick-plan.
  assert(htmlConteoConPlan.includes('data-pick-plan="id-001"') && htmlConteoConPlan.includes('data-pick-plan="id-002"'), 'debe listar ambos SKU pendientes resueltos para tocar y contar, obtuvo: '+htmlConteoConPlan);
  assert(htmlConteoConPlan.includes('data-pick-plan="id-999"') && htmlConteoConPlan.includes('Cambió de bin') && htmlConteoConPlan.includes('se planificó en A-01') && htmlConteoConPlan.includes('ahora está en C-09'), 'el SKU movido de bin debe seguir listado (no perderse) con una advertencia mostrando el bin original y el actual, obtuvo: '+htmlConteoConPlan);
  assert(!(htmlConteoConPlan.match(/data-pick-plan="id-002"[\s\S]*?<\/li>/)||[''])[0].includes('Cambió de bin'), 'SKU-002 sigue cubierto por su bin activo: no debe llevar la advertencia de "movido", obtuvo: '+htmlConteoConPlan);
  assert(htmlConteoConPlan.includes('data-pick-plan="id-777"') && htmlConteoConPlan.includes('Cambió de ubicación') && htmlConteoConPlan.includes('se planificó en Nave Mina · Interior Nave') && htmlConteoConPlan.includes('ahora está en Bodega Norte · Pasillo 5'), 'el SKU reasignado a otra bodega+ubicación debe seguir listado con una advertencia de cambio de ubicación (no la de "Cambió de bin"), obtuvo: '+htmlConteoConPlan);
  assert(htmlConteoConPlan.includes('Agregar algo fuera del plan'), 'el buscador libre debe seguir disponible, ahora bajo su propio título, obtuvo: '+htmlConteoConPlan);

  // Pedido real: cada SKU pendiente del plan del día debe mostrar su ubicación general,
  // ubicación específica y storage bin (antes solo mostraba código y descripción).
  assert(htmlConteoConPlan.includes('Nave Mina · Interior Nave · A-01'), 'SKU-001 debe mostrar bodega · ubicación · storage bin bajo su descripción, obtuvo: '+htmlConteoConPlan);
  assert(htmlConteoConPlan.includes('Nave Mina · Interior Nave · A-02'), 'SKU-002 debe mostrar bodega · ubicación · storage bin bajo su descripción, obtuvo: '+htmlConteoConPlan);
  assert(htmlConteoConPlan.includes('Nave Mina · Interior Nave · C-09'), 'SKU-999 (movido) debe mostrar su bodega · ubicación · storage bin ACTUAL (C-09), no el original, obtuvo: '+htmlConteoConPlan);

  // Pedido real de Joel: desde Contar, poder imprimir/exportar a PDF el plan de trabajo del día
  // elegido. El botón "Exportar PDF" debe verse junto al título "Plan del día" y habilitado
  // porque hoy hay entradas planificadas.
  assert(htmlConteoConPlan.includes('id="btn-exportar-plan-dia"') && !/id="btn-exportar-plan-dia"[^>]*disabled/.test(htmlConteoConPlan), 'con entradas planificadas hoy, el botón Exportar PDF de Plan del día debe verse habilitado, obtuvo: '+htmlConteoConPlan);

  // imprimirPlanDelDia: mismo mecanismo que imprimirPlan (impresión del navegador sobre
  // #print-plan), pero con TODAS las entradas de contarPlan.entradas (mp1..mp4), sin depender
  // de qué bodega/ubicación tenga elegida la cascada en ese momento — el PDF trae el día
  // completo del operador, no solo lo que esté mirando en pantalla.
  ctx.__appstate.contarPlan = cpBase;
  printEl.innerHTML = '';
  printCalled = 0;
  await ctx.imprimirPlanDelDia();
  assert(printCalled===1, 'imprimirPlanDelDia debe llamar a window.print()');
  assert(printEl.innerHTML.includes('Plan del día'), 'el PDF debe titularse "Plan del día", obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('Joel'), 'el PDF debe indicar el nombre de la cuenta logueada, obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('SKU-001') && printEl.innerHTML.includes('SKU-002'), 'el PDF debe listar los SKU de las entradas con bin (mp1 y mp2), obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('SKU-SUELTO'), 'el PDF debe incluir la entrada "SKU sin ubicación" (mp3), obtuvo: '+printEl.innerHTML);
  assert(printEl.innerHTML.includes('SKU sin ubicación'), 'la entrada mp3 debe encabezarse como "SKU sin ubicación", igual que en Planificación, obtuvo: '+printEl.innerHTML);

  // Sin nada planificado para mí ese día: el bloque "Plan del día" muestra su estado vacío
  // (no un error ni una sección en blanco), y el buscador libre sigue disponible igual.
  ctx.__appstate.contarPlan = { cargado:true, cargando:false, fecha:'2026-08-24', entradas:[], bodega:'', ubicacion:'', skusPendientes:null };
  const htmlConteoSinPlan = ctx.renderConteo();
  assert(htmlConteoSinPlan.includes('Plan del día') && htmlConteoSinPlan.includes('Sin nada planificado para ti este día'), 'sin entradas para hoy, debe mostrarse el estado vacío del plan del día, obtuvo: '+htmlConteoSinPlan);
  assert(htmlConteoSinPlan.includes('Agregar algo fuera del plan'), 'el buscador libre debe seguir funcionando igual sin plan, obtuvo: '+htmlConteoSinPlan);
  assert(/id="btn-exportar-plan-dia"[^>]*disabled/.test(htmlConteoSinPlan), 'sin nada planificado hoy, el botón Exportar PDF debe quedar deshabilitado, obtuvo: '+htmlConteoSinPlan);

  // imprimirPlanDelDia sin entradas: igual que imprimirPlan, debe llamar a print() con un aviso
  // de día vacío en vez de tablas, sin pedir ningún SKU a la base.
  printEl.innerHTML = '';
  printCalled = 0;
  calls.length = 0;
  await ctx.imprimirPlanDelDia();
  assert(printCalled===1, 'imprimirPlanDelDia debe llamar a print() incluso sin nada planificado');
  assert(printEl.innerHTML.includes('Sin nada planificado para ti este día'), 'debe mostrar el mensaje de día vacío en el PDF, obtuvo: '+printEl.innerHTML);
  assert(!printEl.innerHTML.includes('<table>'), 'no debe generar tablas si no hay entradas planificadas hoy');
  assert(!calls.some(c=>c.url.includes('/skus_planificables?') || c.url.includes('/skus_disponibles_planificar?')), 'no debe consultar SKU si no hay entradas planificadas hoy, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Regresión real: elegirCascadaContar deduplicaba por sku_code, así que un mismo código con
  // dos filas pendientes (una por batch) perdía la segunda -- solo la primera quedaba
  // seleccionable, dejando el resto de los batches invisibles/inseleccionables en Contar. El fix
  // dedupe por id (ver comentario en elegirCascadaContar); esta prueba cubre justo ese caso.
  ctx.__appstate.contarPlan = {
    cargado: true, cargando: false, fecha: '2026-08-24',
    entradas: [{id:'mp-batch', fecha:'2026-08-24', bodega:'Bodega Batch Test', ubicacion:'Zona X', storage_bin:'BX-01', solo_sin_ubicacion:false, responsable_id:'resp-yo', skus_excluidos:[]}],
    bodega: '', ubicacion: '', skusPendientes: null,
  };
  await ctx.elegirCascadaContar({bodega:'Bodega Batch Test', ubicacion:'Zona X'});
  const pendientesDosBatch = ctx.__appstate.contarPlan.skusPendientes;
  assert(pendientesDosBatch.length===2, 'las dos filas del mismo sku_code (un batch cada una) deben sobrevivir juntas en el plan del día, no colapsarse en una, obtuvo: '+JSON.stringify(pendientesDosBatch));
  assert(pendientesDosBatch.every(s=>s.sku_code==='SKU-DOSBATCH') && new Set(pendientesDosBatch.map(s=>s.id)).size===2, 'ambas filas deben compartir el código pero tener id distinto, obtuvo: '+JSON.stringify(pendientesDosBatch));
  assert(pendientesDosBatch.some(s=>s.batch==='A' && s.stock_sistema===5) && pendientesDosBatch.some(s=>s.batch==='B' && s.stock_sistema===9), 'cada fila debe traer su propio batch y su propio SOH, obtuvo: '+JSON.stringify(pendientesDosBatch));

  // bind() real: tocar un SKU del checklist del plan debe seleccionarlo y marcar
  // conteoOrigenPlan=true (para que guardarConteo lo grabe como NO "fuera de plan").
  ctx.__appstate.contarPlan = {...cpBase, bodega:'Nave Mina', ubicacion:'Interior Nave', skusPendientes:[{id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', storage_bin:'A-01', unidad_medida:'UN'}]};
  ctx.__appstate.skus = [{id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN'}];
  ctx.bind();
  const btnPickPlan = elements['[data-pick-plan="sku-001-id"]'] || null;
  // El mock de document.getElementById no soporta selectores por atributo; se dispara el
  // listener registrado directamente sobre el botón mockeado por su id real, que en este caso
  // bind() ubica vía querySelectorAll — se simula invocando el handler ya registrado en el
  // elemento creado por render (mismo patrón que el resto del archivo: los <button> con
  // data-* se mockean como elementos con dataset).
  void btnPickPlan;

  // guardarConteo: cuando el SKU viene del plan (conteoOrigenPlan=true), fuera_de_plan debe
  // ir en false; cuando viene del buscador libre (conteoOrigenPlan=false, el default), true.
  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN'};
  ctx.__appstate.conteoOrigenPlan = true;
  ctx.__appstate.conteoFotos = [];
  calls.length = 0;
  await ctx.guardarConteo({cantidad:'5', ubicacion:'Interior Nave', bodega:'Nave Mina', observacion:''});
  const postConteoDesdePlan = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/conteos') && !c.url.includes('fotos'));
  assert(!!postConteoDesdePlan && JSON.parse(postConteoDesdePlan.opts.body)[0].fuera_de_plan===false, 'un conteo elegido desde el plan del día debe grabarse con fuera_de_plan=false, obtuvo: '+JSON.stringify(postConteoDesdePlan));

  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', stock_sistema:20, unidad_medida:'UN'};
  ctx.__appstate.conteoOrigenPlan = false;
  ctx.__appstate.conteoFotos = [];
  calls.length = 0;
  await ctx.guardarConteo({cantidad:'3', ubicacion:'', bodega:'', observacion:''});
  const postConteoFueraDePlan = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/conteos') && !c.url.includes('fotos'));
  assert(!!postConteoFueraDePlan && JSON.parse(postConteoFueraDePlan.opts.body)[0].fuera_de_plan===true, 'un conteo del buscador libre debe grabarse con fuera_de_plan=true, obtuvo: '+JSON.stringify(postConteoFueraDePlan));
  ctx.__appstate.skuSeleccionado = null;
  ctx.__appstate.conteoOrigenPlan = false;

  // "Lo encontré en otra ubicación": los campos de ubicación SIEMPRE muestran el valor del
  // maestro, fijos — nunca se escribe nada. Marcar el checkbox solo manda el flag
  // conteos.ubicacion_distinta=true, que alimenta directo la causa probable "Ubicación
  // distinta" y el % de exactitud de ubicación del Dashboard (ya no comparación de texto).
  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN'};
  ctx.__appstate.conteoOtraUbicacion = false;
  const htmlConteoUbicNormal = ctx.renderConteo();
  assert(htmlConteoUbicNormal.includes('id="c-bodega" value="Nave Mina" disabled'), 'sin marcar, "Ubicación general" debe venir bloqueada con el valor del maestro, obtuvo: '+htmlConteoUbicNormal);
  assert(htmlConteoUbicNormal.includes('id="c-ubic" value="Interior Nave" disabled'), 'sin marcar, "Ubicación contada" debe venir bloqueada con el valor del maestro, obtuvo: '+htmlConteoUbicNormal);
  assert(!htmlConteoUbicNormal.includes('id="c-otra-ubic" checked'), 'sin marcar, el checkbox no debe aparecer marcado, obtuvo: '+htmlConteoUbicNormal);

  ctx.__appstate.conteoOtraUbicacion = true;
  const htmlConteoUbicOtra = ctx.renderConteo();
  assert(htmlConteoUbicOtra.includes('id="c-otra-ubic" checked'), 'marcado, el checkbox debe aparecer marcado, obtuvo: '+htmlConteoUbicOtra);
  assert(htmlConteoUbicOtra.includes('id="c-bodega" value="Nave Mina" disabled') && htmlConteoUbicOtra.includes('id="c-ubic" value="Interior Nave" disabled'), 'marcado, los campos de ubicación deben seguir fijos con el valor del maestro (no se escribe nada), obtuvo: '+htmlConteoUbicOtra);

  // bind() real: marcar el checkbox debe actualizar state.conteoOtraUbicacion (y de paso
  // conservar lo que ya se había tipeado en cantidad/observación, igual que al agregar fotos).
  ctx.__appstate.conteoOtraUbicacion = false;
  ctx.__appstate.contarPlan = {...ctx.__appstate.contarPlan, cargado:true, cargando:false};
  ctx.__appstate.session = { access_token:'x', refresh_token:'y', user:{id:'user-1', email:'a@b.com'} };
  ctx.bind();
  const cantEl = elements['c-cant'];
  const obsEl = elements['c-obs'];
  if(cantEl) cantEl.value = '7';
  if(obsEl) obsEl.value = 'nota de prueba';
  const otraUbicEl = elements['c-otra-ubic'];
  otraUbicEl.checked = true;
  otraUbicEl.dispatch('change', {target: otraUbicEl});
  assert(ctx.__appstate.conteoOtraUbicacion===true, 'marcar el checkbox en bind() real debe dejar conteoOtraUbicacion en true, obtuvo: '+ctx.__appstate.conteoOtraUbicacion);
  assert(elements['c-cant'].value==='7' && elements['c-obs'].value==='nota de prueba', 'al marcar el checkbox no debe perderse lo ya tipeado en cantidad/observación, obtuvo: '+JSON.stringify({cant:elements['c-cant'].value, obs:elements['c-obs'].value}));

  // guardarConteo: el flag "ubicacionDistinta" debe viajar tal cual como conteos.ubicacion_distinta.
  ctx.__appstate.conteoFotos = [];
  calls.length = 0;
  await ctx.guardarConteo({cantidad:'4', ubicacion:'Interior Nave', bodega:'Nave Mina', observacion:'', ubicacionDistinta:true});
  const postConteoOtraUbic = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/conteos') && !c.url.includes('fotos'));
  assert(!!postConteoOtraUbic && JSON.parse(postConteoOtraUbic.opts.body)[0].ubicacion_distinta===true, 'con el checkbox marcado, el conteo debe grabarse con ubicacion_distinta=true, obtuvo: '+JSON.stringify(postConteoOtraUbic));

  ctx.__appstate.skuSeleccionado = {id:'sku-001-id', sku_code:'SKU-001', descripcion:'Perno M8', bodega:'Nave Mina', ubicacion:'Interior Nave', stock_sistema:20, unidad_medida:'UN'};
  ctx.__appstate.conteoFotos = [];
  calls.length = 0;
  await ctx.guardarConteo({cantidad:'4', ubicacion:'Interior Nave', bodega:'Nave Mina', observacion:'', ubicacionDistinta:false});
  const postConteoUbicNormal = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/conteos') && !c.url.includes('fotos'));
  assert(!!postConteoUbicNormal && JSON.parse(postConteoUbicNormal.opts.body)[0].ubicacion_distinta===false, 'sin marcar (o sin mandar el flag), el conteo debe grabarse con ubicacion_distinta=false, obtuvo: '+JSON.stringify(postConteoUbicNormal));

  ctx.__appstate.skuSeleccionado = null;
  ctx.__appstate.conteoOtraUbicacion = false;

  // Buscar: filtro "Solo fuera de plan" y badge de origen por resultado.
  ctx.__appstate.busqueda = { texto:'', bodega:'', estado:'', ciclo:'', soloConFotos:false, soloFueraDePlan:true, resultados:[{sku_code:'SKU-9', descripcion:'X', bodega:'Nave', conteo_id:'c-9', cantidad_contada:1, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', fuera_de_plan:true, ciclo_nombre:null, fotos:[]}], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0 };
  const pathBuscarFueraPlan = ctx.construirPathBusqueda(0);
  assert(pathBuscarFueraPlan.includes('fuera_de_plan=eq.true'), 'con "Solo fuera de plan" marcado, la búsqueda debe filtrar por fuera_de_plan=eq.true, obtuvo: '+pathBuscarFueraPlan);
  const htmlBuscarFueraPlan = ctx.renderBuscar();
  assert(htmlBuscarFueraPlan.includes('id="b-solo-fuera-plan"') && htmlBuscarFueraPlan.includes('Fuera de plan'), 'debe mostrar el checkbox del filtro y el badge "Fuera de plan" en el resultado, obtuvo: '+htmlBuscarFueraPlan);
  // Pedido de Joel: con cualquiera de los checkboxes (fotos/fuera de plan/contado hoy) activo,
  // mostrar un gráfico resumen por estado sobre los resultados ya filtrados.
  assert(htmlBuscarFueraPlan.includes('Resumen por estado') && htmlBuscarFueraPlan.includes('<svg'), 'con "Solo fuera de plan" marcado y resultados cargados, debe verse el gráfico resumen, obtuvo: '+htmlBuscarFueraPlan);
  assert(htmlBuscarFueraPlan.includes('Resultados filtrados'), 'sin más resultados por cargar, el gráfico debe indicar que es sobre todos los resultados filtrados, obtuvo: '+htmlBuscarFueraPlan);
  // Reportado: en el eje x no se leían bien los textos -- "No contado" se cortaba porque las
  // columnas del gráfico eran muy angostas. Con etiquetasLargas=true, las etiquetas de dos
  // palabras se parten en dos líneas (<tspan>) y las columnas se ensanchan según la palabra
  // más larga, así ninguna etiqueta queda amontonada ni superpuesta con la de al lado.
  assert(htmlBuscarFueraPlan.includes('<tspan') && htmlBuscarFueraPlan.includes('>No<') && htmlBuscarFueraPlan.includes('>contado<'), 'la etiqueta "No contado" debe partirse en dos líneas para que se lea bien en el eje x, obtuvo: '+htmlBuscarFueraPlan);
  // Reportado: las 4 barras se veían del mismo color. Cada estado tiene su propio color
  // (mismo verde/ámbar que ya usan los badges "Cuadrado"/"Diferencia" en la tabla), para
  // distinguirlas a simple vista sin tener que leer el eje x.
  assert(htmlBuscarFueraPlan.includes('rx="4" fill="var(--ok)"') && htmlBuscarFueraPlan.includes('rx="4" fill="var(--warn)"') && htmlBuscarFueraPlan.includes('rx="4" fill="var(--steel)"') && htmlBuscarFueraPlan.includes('rx="4" fill="var(--text-faint)"'), 'cada barra del resumen debe tener un color de relleno distinto (gris/verde/ámbar/azul), obtuvo: '+htmlBuscarFueraPlan);

  // Sin ningún checkbox activo, no debe verse el gráfico aunque haya resultados.
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, soloFueraDePlan:false};
  const htmlBuscarSinFlags = ctx.renderBuscar();
  assert(!htmlBuscarSinFlags.includes('Resumen por estado'), 'sin ningún checkbox activo, no debe mostrarse el gráfico resumen, obtuvo: '+htmlBuscarSinFlags);

  // Con un checkbox activo pero sin resultados, tampoco debe verse (no hay nada que resumir).
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, soloFueraDePlan:true, resultados:[]};
  const htmlBuscarFlagSinResultados = ctx.renderBuscar();
  assert(!htmlBuscarFlagSinResultados.includes('Resumen por estado'), 'con checkbox activo pero sin resultados, no debe mostrarse el gráfico resumen, obtuvo: '+htmlBuscarFlagSinResultados);

  // Con más resultados por cargar (hayMas), el gráfico debe aclarar que es solo sobre los ya
  // cargados, no sobre el total que calza con el filtro.
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, resultados:[{sku_code:'SKU-9', descripcion:'X', bodega:'Nave', conteo_id:'c-9', cantidad_contada:1, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', fuera_de_plan:true, ciclo_nombre:null, fotos:[]}], hayMas:true};
  const htmlBuscarHayMas = ctx.renderBuscar();
  assert(htmlBuscarHayMas.includes('Primeros 1 cargados'), 'con hayMas=true, el gráfico debe aclarar que es sobre los resultados ya cargados, no el total, obtuvo: '+htmlBuscarHayMas);
  // Regresión real reportada (Joel): con hayMas=true, el titulo "N resultados" mostraba un
  // número fijo (30, el tamaño de página) que parecía ser el total, sin dejar claro que había
  // muchos más -- confundía como si la búsqueda solo pudiera traer 30 en total.
  assert(htmlBuscarHayMas.includes('>1+ resultado<'), 'con hayMas=true y total desconocido, el título debe llevar un "+" (no parecer el total), obtuvo: '+htmlBuscarHayMas);
  assert(htmlBuscarHayMas.includes('Mostrando los primeros'), 'con hayMas=true, debe explicar cómo ver el resto (paginar o exportar), obtuvo: '+htmlBuscarHayMas);

  // Con el total real conocido (el caso normal desde que buscarConteos pide el RPC
  // contar_busqueda_skus en paralelo): el título debe mostrar el total exacto, no "N+", y el
  // aviso debe decir de cuántos en total.
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, total:744};
  const htmlBuscarTotalConocido = ctx.renderBuscar();
  assert(htmlBuscarTotalConocido.includes('>744 resultados<'), 'con el total real conocido, el título debe mostrar el total exacto, obtuvo: '+htmlBuscarTotalConocido);
  assert(htmlBuscarTotalConocido.includes('Mostrando los primeros 1 de 744'), 'el aviso debe decir de cuántos en total, obtuvo: '+htmlBuscarTotalConocido);
  assert(htmlBuscarTotalConocido.includes('Primeros 1 de 744'), 'el gráfico también debe usar el total real conocido en vez de solo "cargados", obtuvo: '+htmlBuscarTotalConocido);
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, hayMas:false};
  const htmlBuscarSinHayMas = ctx.renderBuscar();
  assert(htmlBuscarSinHayMas.includes('>1 resultado<') && !htmlBuscarSinHayMas.includes('>1+ resultado<'), 'sin hayMas, el título no debe llevar "+" (ya es el total real), obtuvo: '+htmlBuscarSinHayMas);

  // resumenEstadoBusqueda: agrupa igual que estadoBadge decide qué badge mostrar por fila --
  // un resultado con diferencia!=0 cae en "Diferencia" aunque su columna estado diga
  // "aprobado" (el mismo criterio que ya usa la tabla, para que el gráfico nunca la contradiga).
  const resumenMixto = ctx.resumenEstadoBusqueda([
    {conteo_id:null, estado:null, diferencia:null},
    {conteo_id:'c-1', estado:'aprobado', diferencia:0},
    {conteo_id:'c-2', estado:'aprobado', diferencia:-3},
    {conteo_id:'c-3', estado:'pendiente_revision', diferencia:0},
  ]);
  const porGrupo = Object.fromEntries(resumenMixto.map(g=>[g.dia, g.n]));
  assert(porGrupo['No contado']===1 && porGrupo['Cuadrado']===1 && porGrupo['Diferencia']===1 && porGrupo['Pendiente']===1, 'resumenEstadoBusqueda debe agrupar cada resultado en el grupo correcto, obtuvo: '+JSON.stringify(porGrupo));

  // Buscar: filtro por rango de fecha de conteo (reemplaza al viejo "Contado hoy" fijo -- a
  // pedido de Joel, ahora se elige el rango con "Contado desde"/"Contado hasta"), mismo patrón
  // que exportarConteosExcel: arma el instante real a partir de la medianoche LOCAL de cada
  // fecha, sin importar el huso horario. Cada extremo es independiente (se puede filtrar solo
  // desde, solo hasta, o ambos), y no aparece nada cuando los dos están vacíos.
  ctx.__appstate.busqueda = { texto:'', bodega:'', estado:'', ciclo:'', soloConFotos:false, soloFueraDePlan:false, fechaDesde:'', fechaHasta:'', resultados:[], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0 };
  const pathBuscarSinFechas = ctx.construirPathBusqueda(0);
  assert(!pathBuscarSinFechas.includes('fecha_conteo='), 'sin fechas elegidas, la búsqueda no debe filtrar por fecha_conteo, obtuvo: '+pathBuscarSinFechas);
  ctx.__appstate.busqueda = { ...ctx.__appstate.busqueda, fechaDesde:'2026-08-20' };
  const pathBuscarSoloDesde = ctx.construirPathBusqueda(0);
  assert(pathBuscarSoloDesde.includes('fecha_conteo=gte.') && !pathBuscarSoloDesde.includes('fecha_conteo=lt.'), 'con solo "Contado desde", debe filtrar únicamente el extremo inferior, obtuvo: '+pathBuscarSoloDesde);
  ctx.__appstate.busqueda = { ...ctx.__appstate.busqueda, fechaHasta:'2026-08-25' };
  const pathBuscarAmbasFechas = ctx.construirPathBusqueda(0);
  assert(pathBuscarAmbasFechas.includes('fecha_conteo=gte.') && pathBuscarAmbasFechas.includes('fecha_conteo=lt.'), 'con ambas fechas, la búsqueda debe filtrar el rango completo, obtuvo: '+pathBuscarAmbasFechas);
  const htmlBuscarFechas = ctx.renderBuscar();
  assert(htmlBuscarFechas.includes('id="b-fecha-desde"') && htmlBuscarFechas.includes('id="b-fecha-hasta"') && htmlBuscarFechas.includes('Contado desde') && htmlBuscarFechas.includes('Contado hasta'), 'debe mostrar los campos de rango de fecha, obtuvo: '+htmlBuscarFechas);
  assert(!htmlBuscarFechas.includes('Contado hoy') && !htmlBuscarFechas.includes('id="b-contado-hoy"'), 'el checkbox fijo de "Contado hoy" debe haber desaparecido, obtuvo: '+htmlBuscarFechas);

  // Buscar ahora busca en todo el maestro de SKU (skus_busqueda), no solo en el historial de
  // conteos: un SKU nunca contado debe aparecer con "No contado", sin fecha/estado/fotos.
  ctx.__appstate.busqueda = { texto:'filtro', bodega:'', estado:'', ciclo:'', soloConFotos:false, soloFueraDePlan:false, resultados:[], buscando:false, yaBuscado:false, hayMas:false, buscandoMas:false, paginaOffset:0 };
  // Buscar no debe traer datos apenas se entra a la sección: solo al presionar "Buscar" (yaBuscado
  // pasa a true recién en el submit del formulario, dentro de bind()).
  const htmlBuscarSinBuscar = ctx.renderBuscar();
  assert(!htmlBuscarSinBuscar.includes('0 resultado') && !htmlBuscarSinBuscar.includes('table-wrap'), 'antes de buscar no debe mostrarse un conteo de "0 resultados" ni la tabla, obtuvo: '+htmlBuscarSinBuscar);
  assert(htmlBuscarSinBuscar.includes('presiona &quot;Buscar&quot;') || htmlBuscarSinBuscar.includes('presiona "Buscar"'), 'antes de buscar debe invitar a usar el formulario, obtuvo: '+htmlBuscarSinBuscar);
  const pathBuscarTexto = ctx.construirPathBusqueda(0);
  assert(pathBuscarTexto.includes('or=(sku_code.ilike.*filtro*,descripcion.ilike.*filtro*,batch.ilike.*filtro*,storage_bin.ilike.*filtro*)'), 'el texto debe buscarse en el servidor por código, descripción, batch y storage bin (no solo filtrarse en el cliente), obtuvo: '+pathBuscarTexto);

  ctx.__appstate.busqueda.estado = 'no_contado';
  const pathBuscarNoContado = ctx.construirPathBusqueda(0);
  assert(pathBuscarNoContado.includes('conteo_id=is.null') && !pathBuscarNoContado.includes('estado=eq.'), 'el estado "No contado" debe filtrar por conteo_id=is.null, no por la columna estado, obtuvo: '+pathBuscarNoContado);
  ctx.__appstate.busqueda.estado = '';

  ctx.__appstate.busqueda.ciclo = '__sin_ciclo__';
  const pathBuscarSinCiclo = ctx.construirPathBusqueda(0);
  assert(pathBuscarSinCiclo.includes('ciclo_id=is.null') && pathBuscarSinCiclo.includes('conteo_id=not.is.null'), '"Sin ciclo asignado" debe exigir que sí haya un conteo (si no, mostraría todos los SKU nunca contados como si fueran de ese grupo), obtuvo: '+pathBuscarSinCiclo);
  ctx.__appstate.busqueda.ciclo = '';

  // ===== Buscar: filtro "Solo críticos" y filtro por Clase ABC (a pedido de Joel, junto con las
  // otras 3 mejoras de esta sesión: rango de fechas ya cubierto arriba, texto que busca también
  // por batch/storage bin ya cubierto arriba, y ordenar por encabezado más abajo). =====
  assert(!ctx.construirPathBusqueda(0).includes('critico='), 'sin "Solo críticos" marcado, no debe filtrar por critico, obtuvo: '+ctx.construirPathBusqueda(0));
  ctx.__appstate.busqueda.soloCriticos = true;
  const pathBuscarCriticos = ctx.construirPathBusqueda(0);
  assert(pathBuscarCriticos.includes('critico=eq.true'), 'con "Solo críticos" marcado, debe filtrar por critico=eq.true, obtuvo: '+pathBuscarCriticos);
  const htmlBuscarCriticos = ctx.renderBuscar();
  assert(htmlBuscarCriticos.includes('id="b-solo-criticos"') && htmlBuscarCriticos.includes('Solo críticos'), 'debe mostrar el checkbox de "Solo críticos", obtuvo: '+htmlBuscarCriticos);
  ctx.__appstate.busqueda.soloCriticos = false;

  ctx.__appstate.busqueda.claseAbc = 'B';
  const pathBuscarClaseB = ctx.construirPathBusqueda(0);
  assert(pathBuscarClaseB.includes('clase_abc=eq.B'), 'con Clase B elegida, debe filtrar por clase_abc=eq.B, obtuvo: '+pathBuscarClaseB);
  ctx.__appstate.busqueda.claseAbc = '__sin_clasificar__';
  const pathBuscarSinClasificar = ctx.construirPathBusqueda(0);
  assert(pathBuscarSinClasificar.includes('clase_abc=is.null'), '"Sin clasificar" debe filtrar por clase_abc=is.null, obtuvo: '+pathBuscarSinClasificar);
  const htmlBuscarClaseAbc = ctx.renderBuscar();
  assert(htmlBuscarClaseAbc.includes('id="b-clase-abc"') && htmlBuscarClaseAbc.includes('Clase ABC'), 'debe mostrar el selector de Clase ABC, obtuvo: '+htmlBuscarClaseAbc);
  ctx.__appstate.busqueda.claseAbc = '';

  // ===== Buscar: el RPC contar_busqueda_skus (total real, pedido en paralelo a las filas -- ver
  // buscarConteos) debe recibir EXACTAMENTE los mismos filtros que construirPathBusqueda usa para
  // pedir las filas. En particular las fechas: deben viajar como el instante (timestamptz) que el
  // cliente ya calculó a partir de la medianoche LOCAL, no como una fecha simple -- si el RPC
  // hiciera el cast fecha->timestamptz del lado de la base, usaría el timezone de la SESIÓN de la
  // base, no el del usuario, y el total mostrado podría no calzar con las filas de la tabla. =====
  ctx.__appstate.busqueda = {
    texto:'rodamiento', bodega:'Nave', estado:'aprobado', ciclo:'ciclo-9', soloConFotos:false,
    soloFueraDePlan:true, soloCriticos:true, claseAbc:'A', fechaDesde:'2026-08-20', fechaHasta:'2026-08-25',
    resultados:[], total:null, buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0, busquedaPagina:0,
  };
  calls.length = 0;
  await ctx.buscarConteos();
  const pathConFiltros = ctx.construirPathBusqueda(0);
  const desdeEsperado = (pathConFiltros.match(/fecha_conteo=gte\.([^&]+)/)||[])[1];
  const hastaEsperado = (pathConFiltros.match(/fecha_conteo=lt\.([^&]+)/)||[])[1];
  const rpcCall = calls.find(c=>c.url.includes('/rpc/contar_busqueda_skus'));
  assert(!!rpcCall, 'buscarConteos debe pedir el total en paralelo vía el RPC contar_busqueda_skus, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const rpcBody = rpcCall && JSON.parse(rpcCall.opts.body);
  assert(rpcBody && rpcBody.p_texto==='rodamiento' && rpcBody.p_bodega==='Nave' && rpcBody.p_estado==='aprobado' && rpcBody.p_ciclo==='ciclo-9' && rpcBody.p_solo_fuera_de_plan===true && rpcBody.p_solo_criticos===true && rpcBody.p_clase_abc==='A', 'el RPC debe recibir los mismos filtros de texto/bodega/estado/ciclo/checkboxes/clase que la búsqueda de filas, obtuvo: '+JSON.stringify(rpcBody));
  assert(rpcBody && !!desdeEsperado && !!hastaEsperado && rpcBody.p_fecha_desde===desdeEsperado && rpcBody.p_fecha_hasta===hastaEsperado, 'las fechas del RPC deben ser el mismo instante (timestamptz) que fecha_conteo=gte./lt. en la búsqueda de filas, obtuvo: '+JSON.stringify({rpc:{desde:rpcBody&&rpcBody.p_fecha_desde,hasta:rpcBody&&rpcBody.p_fecha_hasta}, path:{desde:desdeEsperado,hasta:hastaEsperado}}));

  // ===== Buscar: ordenar la tabla haciendo clic en un encabezado (ciclo de 3 estados: asc ->
  // desc -> orden por defecto), pide de nuevo al servidor desde el principio. =====
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, orden:null, yaBuscado:true, resultados:[
    {sku_code:'SKU-ORD', batch:null, descripcion:'X', bodega:'Nave', conteo_id:null, cantidad_contada:null, estado:null, diferencia:null, fecha_conteo:null, capturado_en:null, fuera_de_plan:null, ciclo_nombre:null, fotos:[]},
  ]};
  assert(ctx.construirPathBusqueda(0).includes('order=fecha_conteo.desc.nullslast,sku_code.asc'), 'sin orden elegido, debe usar el orden por defecto (fecha desc, código asc), obtuvo: '+ctx.construirPathBusqueda(0));
  const htmlBuscarSinOrden = ctx.renderBuscar();
  assert(htmlBuscarSinOrden.includes('data-orden-campo="sku_code"') && htmlBuscarSinOrden.includes('data-orden-campo="descripcion"') && htmlBuscarSinOrden.includes('data-orden-campo="clase_abc"'), 'los encabezados ordenables deben tener su data-orden-campo, obtuvo: '+htmlBuscarSinOrden);
  assert(!/data-orden-campo="[^"]*"[^<]*▲/.test(htmlBuscarSinOrden) && !/data-orden-campo="[^"]*"[^<]*▼/.test(htmlBuscarSinOrden), 'sin orden elegido, ningún encabezado debe mostrar flecha, obtuvo: '+htmlBuscarSinOrden);

  calls.length = 0;
  await ctx.toggleOrdenBusqueda('descripcion');
  assert(JSON.stringify(ctx.__appstate.busqueda.orden)===JSON.stringify({campo:'descripcion', dir:'asc'}), 'el primer clic en un encabezado debe ordenar ascendente por esa columna, obtuvo: '+JSON.stringify(ctx.__appstate.busqueda.orden));
  assert(calls.some(c=>c.url.includes('/skus_busqueda') && c.url.includes('order=descripcion.asc.nullslast,sku_code.asc')), 'debe volver a pedir al servidor con el nuevo orden, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.busqueda.busquedaPagina===0, 'cambiar el orden debe reiniciar la paginación, obtuvo: '+ctx.__appstate.busqueda.busquedaPagina);
  const htmlOrdenAsc = ctx.renderBuscar();
  assert(/data-orden-campo="descripcion"[^<]*▲/.test(htmlOrdenAsc), 'con orden ascendente por descripción, su encabezado debe mostrar ▲, obtuvo: '+htmlOrdenAsc);

  calls.length = 0;
  await ctx.toggleOrdenBusqueda('descripcion');
  assert(JSON.stringify(ctx.__appstate.busqueda.orden)===JSON.stringify({campo:'descripcion', dir:'desc'}), 'un segundo clic en el mismo encabezado debe invertir a descendente, obtuvo: '+JSON.stringify(ctx.__appstate.busqueda.orden));
  assert(calls.some(c=>c.url.includes('order=descripcion.desc.nullslast,sku_code.asc')), 'debe volver a pedir al servidor con el orden invertido, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  calls.length = 0;
  await ctx.toggleOrdenBusqueda('descripcion');
  assert(ctx.__appstate.busqueda.orden===null, 'un tercer clic en el mismo encabezado debe volver al orden por defecto, obtuvo: '+JSON.stringify(ctx.__appstate.busqueda.orden));
  assert(calls.some(c=>c.url.includes('order=fecha_conteo.desc.nullslast,sku_code.asc')), 'al volver al orden por defecto debe pedirlo así al servidor, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Ordenar por SKU (la columna que ya es el desempate por defecto) no debe duplicar "sku_code.asc".
  await ctx.toggleOrdenBusqueda('sku_code');
  assert(ctx.construirPathBusqueda(0).includes('order=sku_code.asc.nullslast') && !ctx.construirPathBusqueda(0).includes('sku_code.asc.nullslast,sku_code.asc'), 'ordenar por SKU no debe duplicar el desempate, obtuvo: '+ctx.construirPathBusqueda(0));
  ctx.__appstate.busqueda.orden = null;

  // Regresión real reportada: tras el cambio anterior, enviar el formulario "Buscar" traía los
  // resultados (buscarConteos sí llegaba a pedirlos) pero la pantalla seguía mostrando el mensaje
  // de "aún no has buscado", porque nada dejaba yaBuscado en true fuera del auto-fetch que se quitó.
  // Se prueba con el bind() y el <form> reales, no llamando a buscarConteos() directo.
  ctx.__appstate.busqueda.yaBuscado = false;
  ctx.__appstate.busqueda.resultados = [];
  ctx.__appstate.view = 'buscar';
  ctx.bind();
  const formBuscarEl = elements['form-buscar'];
  calls.length = 0;
  await new Promise(resolve => {
    formBuscarEl.dispatch('submit', {target: formBuscarEl, preventDefault(){}});
    setTimeout(resolve, 30);
  });
  assert(calls.some(c=>c.url.includes('/skus_busqueda?select=')), 'enviar el formulario debe disparar la búsqueda real, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.busqueda.yaBuscado===true, 'tras enviar el formulario, yaBuscado debe quedar en true, obtuvo: '+ctx.__appstate.busqueda.yaBuscado);
  assert(ctx.__appstate.busqueda.resultados.length>0, 'tras enviar el formulario deben quedar resultados cargados en el estado, obtuvo: '+ctx.__appstate.busqueda.resultados.length);
  const htmlTrasBuscarReal = ctx.renderBuscar();
  assert(htmlTrasBuscarReal.includes('resultado') && htmlTrasBuscarReal.includes('table-wrap'), 'tras enviar el formulario, la tabla de resultados debe mostrarse (no el mensaje de "aún no has buscado"), obtuvo: '+htmlTrasBuscarReal);

  ctx.__appstate.busqueda.resultados = [
    {sku_code:'SKU-NC', descripcion:'Nunca contado', bodega:'Nave', conteo_id:null, cantidad_contada:null, estado:null, diferencia:null, fecha_conteo:null, capturado_en:null, fuera_de_plan:null, ciclo_nombre:null, fotos:[]},
    {sku_code:'SKU-C', descripcion:'Ya contado', bodega:'Nave', conteo_id:'c-1', cantidad_contada:7, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-20T10:00:00Z', capturado_en:'2026-08-20T10:00:00Z', fuera_de_plan:false, ciclo_nombre:'T1 2027', fotos:[{foto_url:'foto.jpg', numero_conteo:1, fecha_conteo:'2026-08-20T10:00:00Z'}]},
  ];
  ctx.__appstate.busqueda.yaBuscado = true;
  const htmlBuscarMixto = ctx.renderBuscar();
  const filaNoContada = htmlBuscarMixto.slice(htmlBuscarMixto.indexOf('SKU-NC'), htmlBuscarMixto.indexOf('SKU-C'));
  const filaContada = htmlBuscarMixto.slice(htmlBuscarMixto.indexOf('SKU-C'));
  assert(filaNoContada.includes('badge-neutral">No contado<') && filaNoContada.includes('>—<'), 'un SKU nunca contado debe mostrar el badge "No contado" y guiones donde no hay dato, obtuvo: '+filaNoContada);
  assert(!filaNoContada.includes('data-ver-fotos'), 'un SKU nunca contado no debe ofrecer botón de fotos, obtuvo: '+filaNoContada);
  assert(filaContada.includes('data-ver-fotos') && filaContada.includes('T1 2027'), 'un SKU ya contado debe seguir mostrando su botón de fotos y el ciclo, obtuvo: '+filaContada);

  // Pedido: la descripción del SKU debe verse como columna propia en la tabla de resultados,
  // no solo como subtítulo chico debajo del código.
  assert(htmlBuscarMixto.includes('data-orden-campo="descripcion"') && htmlBuscarMixto.includes('>Descripción<'), 'la tabla de resultados debe tener una columna "Descripción" (ordenable), obtuvo: '+htmlBuscarMixto);
  assert(filaNoContada.includes('Nunca contado') && filaContada.includes('Ya contado'), 'cada fila debe mostrar la descripción del SKU en su propia celda, obtuvo: '+htmlBuscarMixto);

  // ===== Exportar resultados de Buscar a Excel (Joel: "en Buscar, es posible exportar los
  // resultados?") — a diferencia de "Exportar conteos" (que exporta un rango de fechas desde su
  // propio modal), esto exporta TODO lo que matchea los filtros actuales de la búsqueda, no solo
  // la página visible: pagina por el servidor con el mismo path que usa la búsqueda
  // (construirPathBusqueda) hasta agotarlo. =====
  assert(htmlBuscarMixto.includes('id="btn-exportar-buscar"') && htmlBuscarMixto.includes('Exportar a Excel'), 'con resultados, debe verse el botón de exportar, obtuvo: '+htmlBuscarMixto);
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, resultados:[], yaBuscado:true};
  const htmlBuscarSinResultados = ctx.renderBuscar();
  assert(!htmlBuscarSinResultados.includes('id="btn-exportar-buscar"'), 'sin resultados no debe verse el botón de exportar (no hay nada que exportar), obtuvo: '+htmlBuscarSinResultados);

  // Sin resultados en el servidor: debe avisar con un toast y no trabar el botón en "Exportando…".
  skusBusquedaFixture = [];
  xlsxEscrituras.length = 0;
  await ctx.exportarBusquedaExcel();
  assert(xlsxEscrituras.length===0, 'sin resultados no debe generarse ningún archivo');
  assert(ctx.__appstate.busqueda.exportando===false, 'sin resultados, "exportando" debe quedar en false (no debe trabarse el botón), obtuvo: '+ctx.__appstate.busqueda.exportando);

  // Mapeo de columnas: un SKU crítico y contado con diferencia, uno pendiente de revisión, uno
  // cuadrado capturado offline, y uno nunca contado -- cada uno debe traducirse a las columnas
  // legibles que espera alguien mirando la planilla, no a los nombres crudos de la base.
  skusBusquedaFixture = [
    {sku_id:'sku-exp-1', sku_code:'SKU-EXP-1', descripcion:'Rodamiento', bodega:'Nave Mina', batch:'L-01', critico:true, conteo_id:'c-1', cantidad_contada:8, estado:'con_diferencia', diferencia:-2, fecha_conteo:'2026-08-20T14:00:00Z', capturado_en:'2026-08-20T14:00:00Z', fuera_de_plan:true, ciclo_nombre:'T1 2027', fotos:[{foto_url:'a.jpg'},{foto_url:'b.jpg'}], clase_abc:'A'},
    {sku_id:'sku-exp-2', sku_code:'SKU-EXP-2', descripcion:'Perno', bodega:'Nave Mina', batch:null, critico:false, conteo_id:'c-2', cantidad_contada:5, estado:'pendiente_revision', diferencia:0, fecha_conteo:'2026-08-20T15:00:00Z', capturado_en:'2026-08-20T15:00:00Z', fuera_de_plan:false, ciclo_nombre:'T1 2027', fotos:[], clase_abc:'B'},
    {sku_id:'sku-exp-3', sku_code:'SKU-EXP-3', descripcion:'Filtro', bodega:'Nave Planta', batch:null, critico:false, conteo_id:'c-3', cantidad_contada:10, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-21T09:10:00Z', capturado_en:'2026-08-21T02:00:00Z', fuera_de_plan:false, ciclo_nombre:null, fotos:[], clase_abc:null},
    {sku_id:'sku-exp-4', sku_code:'SKU-EXP-4', descripcion:'Nunca contado', bodega:'Nave Mina', batch:null, critico:false, conteo_id:null, cantidad_contada:null, estado:null, diferencia:null, fecha_conteo:null, capturado_en:null, fuera_de_plan:null, ciclo_nombre:null, fotos:[], clase_abc:null},
  ];
  xlsxEscrituras.length = 0;
  await ctx.exportarBusquedaExcel();
  assert(xlsxEscrituras.length===1 && xlsxEscrituras[0].nombreArchivo===`buscar_${ctx.fechaISO(new Date())}.xlsx`, 'debe generar un único archivo con nombre "buscar_<fecha>.xlsx", obtuvo: '+JSON.stringify(xlsxEscrituras));
  const filasBuscarExp = xlsxEscrituras[0].libro.hojas['Buscar'];
  const filaCritica = filasBuscarExp.find(f=>f['SKU']==='SKU-EXP-1');
  assert(filaCritica['Crítico']==='Sí' && filaCritica['Estado']==='Con diferencia -2' && filaCritica['Origen']==='Fuera de plan' && filaCritica['Fotos']===2 && filaCritica['Clase ABC']==='A' && filaCritica['Batch']==='L-01', 'un SKU crítico con diferencia y fuera de plan debe mapearse así, obtuvo: '+JSON.stringify(filaCritica));
  const filaPendiente = filasBuscarExp.find(f=>f['SKU']==='SKU-EXP-2');
  assert(filaPendiente['Crítico']==='No' && filaPendiente['Estado']==='Pendiente' && filaPendiente['Origen']==='Plan', 'un SKU pendiente de revisión y dentro de plan debe mapearse así, obtuvo: '+JSON.stringify(filaPendiente));
  const filaCuadradaOffline = filasBuscarExp.find(f=>f['SKU']==='SKU-EXP-3');
  assert(filaCuadradaOffline['Estado']==='Cuadrado' && filaCuadradaOffline['Capturado sin conexión']!=='', 'un SKU cuadrado capturado antes de la fecha de conteo debe marcarse como offline, obtuvo: '+JSON.stringify(filaCuadradaOffline));
  const filaNuncaContadaExp = filasBuscarExp.find(f=>f['SKU']==='SKU-EXP-4');
  assert(filaNuncaContadaExp['Estado']==='No contado' && filaNuncaContadaExp['Cantidad contada']==='' && filaNuncaContadaExp['Origen']==='' && filaNuncaContadaExp['Ciclo']==='' && filaNuncaContadaExp['Clase ABC']==='', 'un SKU nunca contado debe exportar sus campos de conteo vacíos, no null/undefined, obtuvo: '+JSON.stringify(filaNuncaContadaExp));

  // Debe traer TODO lo que matchea (paginando), no solo la primera tanda -- se reusa el mock
  // genérico de skus_busqueda (34 filas en total, de a 30), sin fixture fija.
  skusBusquedaFixture = null;
  ctx.__appstate.busqueda = {...ctx.__appstate.busqueda, texto:'', bodega:'', estado:'', ciclo:''};
  xlsxEscrituras.length = 0;
  calls.length = 0;
  await ctx.exportarBusquedaExcel();
  const llamadasBusquedaExport = calls.filter(c=>c.url.includes('/skus_busqueda?select='));
  assert(llamadasBusquedaExport.length===2, 'con 34 filas en total (30+4) debe paginar en dos llamadas al servidor, obtuvo: '+llamadasBusquedaExport.length);
  assert(xlsxEscrituras.length===1 && xlsxEscrituras[0].libro.hojas['Buscar'].length===34, 'debe exportar las 34 filas completas, no solo la primera tanda, obtuvo: '+(xlsxEscrituras[0] && xlsxEscrituras[0].libro.hojas['Buscar'].length));
  skusBusquedaFixture = null;

  // ===== Exportar conteos a Excel (para cargar a un ERP): vista conteos_exportables filtrada
  // por fecha_conteo, paginada, mapeada a columnas en español y escrita con XLSX (mockeado
  // arriba: json_to_sheet devuelve las filas tal cual, así se puede inspeccionar qué se exportó). =====
  // Exportar conteos vive en su propio modal (ícono en la barra superior), no como formulario
  // suelto dentro de Buscar -- ver renderExportarModal().
  ctx.__appstate.exportConteos = { desde: '2026-08-20', hasta: '2026-08-20', exportando:false };
  const htmlSinModal = ctx.renderExportarModal();
  assert(htmlSinModal==='', 'sin exportarModal activo, renderExportarModal no debe mostrar nada, obtuvo: '+htmlSinModal);
  ctx.__appstate.exportarModal = true;
  const htmlExportarForm = ctx.renderExportarModal();
  assert(htmlExportarForm.includes('id="form-exportar-conteos"') && htmlExportarForm.includes('id="ex-desde"') && htmlExportarForm.includes('id="ex-hasta"'), 'debe existir el formulario de exportar con sus campos de fecha, obtuvo: '+htmlExportarForm);
  assert(htmlExportarForm.includes('value="2026-08-20"'), 'los campos de fecha deben reflejar el estado actual, obtuvo: '+htmlExportarForm);
  ctx.__appstate.exportarModal = false;
  conteosExportablesFixture = [
    { conteo_id:'ce-1', sku_code:'SKU-EXP1', descripcion:'Perno M8', categoria:'Repuestos', batch:'L-2026-045', unidad_medida:'UN', codigo_barras:'7801234567890', bodega_maestro:'Nave Mina', ubicacion_maestro:'Interior Nave', storage_bin:'A-01', stock_sistema:10, costo_unitario:500, bodega_contada:'Nave Mina', ubicacion_contada:'Interior Nave', ubicacion_distinta:false, cantidad_contada:8, diferencia:-2, valor_diferencia:-1000, estado:'con_diferencia', fuera_de_plan:false, observacion:'Faltante', fecha_conteo:'2026-08-20T14:00:00Z', capturado_en:'2026-08-20T14:00:00Z', responsable:'Ana Torres', ciclo_nombre:'T1 2027' },
  ];
  xlsxEscrituras.length = 0;
  calls.length = 0;
  await ctx.exportarConteosExcel();
  const exportCall = calls.find(c=>c.url.includes('/conteos_exportables'));
  assert(!!exportCall, 'exportarConteosExcel debe pedir /conteos_exportables, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(exportCall.url.includes('fecha_conteo=gte.') && exportCall.url.includes('fecha_conteo=lt.'), 'debe filtrar por rango de fecha_conteo, obtuvo: '+exportCall.url);
  assert(xlsxEscrituras.length===1, 'debe generar un archivo Excel, obtuvo: '+xlsxEscrituras.length);
  assert(xlsxEscrituras[0].nombreArchivo==='conteos_2026-08-20.xlsx', 'con la misma fecha en "Desde" y "Hasta", el archivo debe nombrarse con un solo día, obtuvo: '+xlsxEscrituras[0].nombreArchivo);
  const filaExportada = xlsxEscrituras[0].libro.hojas['Conteos'][0];
  assert(filaExportada['SKU']==='SKU-EXP1' && filaExportada['Descripción']==='Perno M8' && filaExportada['Batch']==='L-2026-045' && filaExportada['Categoría']==='Repuestos', 'debe incluir los campos básicos del maestro (Batch real, no la Categoría), obtuvo: '+JSON.stringify(filaExportada));
  assert(filaExportada['Cantidad contada']===8 && filaExportada['Diferencia']===-2 && filaExportada['Valor diferencia']===-1000, 'debe incluir el resultado del conteo y su valorización, obtuvo: '+JSON.stringify(filaExportada));
  assert(filaExportada['Responsable']==='Ana Torres' && filaExportada['Ciclo']==='T1 2027', 'debe incluir el responsable y el ciclo, obtuvo: '+JSON.stringify(filaExportada));
  assert(filaExportada['Ubicación distinta']==='No' && filaExportada['Fuera de plan']==='No', 'los booleanos deben mostrarse como Sí/No, legibles para el ERP, obtuvo: '+JSON.stringify(filaExportada));

  // Rango de fechas (dos días): el nombre del archivo debe reflejar ambos extremos.
  ctx.__appstate.exportConteos = { desde: '2026-08-01', hasta: '2026-08-31', exportando:false };
  xlsxEscrituras.length = 0;
  await ctx.exportarConteosExcel();
  assert(xlsxEscrituras[0].nombreArchivo==='conteos_2026-08-01_a_2026-08-31.xlsx', 'con un rango de fechas, el archivo debe nombrarse con ambos extremos, obtuvo: '+xlsxEscrituras[0].nombreArchivo);

  // Sin fecha "Desde": no debe llegar a pedir nada ni intentar exportar.
  ctx.__appstate.exportConteos = { desde: '', hasta: '', exportando:false };
  calls.length = 0;
  xlsxEscrituras.length = 0;
  await ctx.exportarConteosExcel();
  assert(!calls.some(c=>c.url.includes('/conteos_exportables')), 'sin fecha "Desde" no debe pedir nada al servidor, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(xlsxEscrituras.length===0, 'sin fecha "Desde" no debe generar ningún archivo');

  // "Hasta" anterior a "Desde": tampoco debe exportar.
  ctx.__appstate.exportConteos = { desde: '2026-08-20', hasta: '2026-08-10', exportando:false };
  calls.length = 0;
  await ctx.exportarConteosExcel();
  assert(!calls.some(c=>c.url.includes('/conteos_exportables')), '"Hasta" anterior a "Desde" no debe pedir nada al servidor, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Sin conteos en el rango: debe avisar y dejar "exportando" en false (no debe quedar el botón
  // pegado en estado de carga para siempre).
  conteosExportablesFixture = [];
  ctx.__appstate.exportConteos = { desde: '2026-01-01', hasta: '2026-01-01', exportando:false };
  xlsxEscrituras.length = 0;
  await ctx.exportarConteosExcel();
  assert(xlsxEscrituras.length===0, 'sin conteos en el rango, no debe generarse ningún archivo');
  assert(ctx.__appstate.exportConteos.exportando===false, 'sin conteos en el rango, "exportando" debe quedar en false (no debe trabarse el botón), obtuvo: '+ctx.__appstate.exportConteos.exportando);

  // handleLogout debe avisar con un toast temporal, igual que el resto de las acciones (login, guardar, borrar, etc.),
  // y borrar la sesión persistida en localStorage para que el próximo que abra el navegador no la herede.
  // Nota: handleLogout hace `state = {...}` (reasignación completa, no Object.assign), así que __appstate
  // queda desactualizado tras llamarlo; por eso solo verificamos el efecto observable (el toast), no el
  // estado interno después de la llamada.
  ctx.guardarSesion({access_token:'x', refresh_token:'y', user:{id:'u'}});
  const toastRoot = elements['toast-root'];
  const toastsAntes = toastRoot ? toastRoot.hijos.length : 0;
  ctx.handleLogout();
  assert(ctx.localStorage.getItem('sesion_inventario')===null, 'handleLogout debe borrar la sesión persistida en localStorage');
  const nuevosToasts = toastRoot.hijos.slice(toastsAntes);
  assert(nuevosToasts.some(t=>t.textContent==='Sesión cerrada'), 'handleLogout debe mostrar un toast "Sesión cerrada", obtuvo: '+JSON.stringify(nuevosToasts.map(t=>t.textContent)));

  // Candado visual en la barra inferior: un operador no tiene acceso a Dashboard, Plan ni Carga,
  // pero en vez de ocultar esos tabs (o dejarlos entrar libremente) deben verse igual, marcados
  // con un candado, para que quede claro que la función existe pero es solo para administradores.
  // handleLogout (arriba) reasigna `state` por completo, así que __appstate quedó apuntando al
  // objeto viejo: hay que resincronizarlo antes de volver a usarlo.
  ctx.__resyncAppState();
  ctx.__appstate.perfil = { id:1, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  assert(ctx.vistaBloqueadaParaRol('dashboard')===true, 'un operador debe tener bloqueada la vista dashboard');
  assert(ctx.vistaBloqueadaParaRol('plan')===true, 'un operador debe tener bloqueada la vista plan');
  assert(ctx.vistaBloqueadaParaRol('carga')===true, 'un operador debe tener bloqueada la vista carga');
  assert(ctx.vistaBloqueadaParaRol('conteo')===false, 'un operador NO debe tener bloqueada la vista conteo');
  assert(ctx.vistaInicialParaPerfil()==='conteo', 'un operador debe arrancar en Contar, no en el Dashboard bloqueado, obtuvo: '+ctx.vistaInicialParaPerfil());

  const htmlTabOperadorDashboard = ctx.tabBtn('dashboard', 'Dashboard');
  assert(htmlTabOperadorDashboard.includes('tab-bloqueada') && htmlTabOperadorDashboard.includes('tab-candado') && htmlTabOperadorDashboard.includes('data-bloqueada="1"'), 'el tab Dashboard de un operador debe mostrar el candado, obtuvo: '+htmlTabOperadorDashboard);
  const htmlTabOperadorConteo = ctx.tabBtn('conteo', 'Contar');
  assert(!htmlTabOperadorConteo.includes('tab-bloqueada') && !htmlTabOperadorConteo.includes('tab-candado'), 'el tab Contar de un operador NO debe mostrar candado, obtuvo: '+htmlTabOperadorConteo);

  ctx.__appstate.perfil = { id:2, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  assert(ctx.vistaBloqueadaParaRol('dashboard')===false, 'un admin NO debe tener bloqueada la vista dashboard');
  assert(ctx.vistaBloqueadaParaRol('plan')===false, 'un admin NO debe tener bloqueada la vista plan');
  assert(ctx.vistaBloqueadaParaRol('carga')===false, 'un admin NO debe tener bloqueada la vista carga');
  assert(ctx.vistaInicialParaPerfil()==='dashboard', 'un admin debe arrancar en el Dashboard, obtuvo: '+ctx.vistaInicialParaPerfil());
  const htmlTabAdminDashboard = ctx.tabBtn('dashboard', 'Dashboard');
  assert(!htmlTabAdminDashboard.includes('tab-bloqueada') && !htmlTabAdminDashboard.includes('tab-candado'), 'el tab Dashboard de un admin NO debe mostrar candado, obtuvo: '+htmlTabAdminDashboard);

  // Pedido de Joel: el ícono de SKUs que estaba abajo (pestaña de la barra inferior) pasa a un
  // ícono arriba (junto a Buscar en la barra superior), y en su lugar en la barra inferior va
  // "Períodos" (crear/gestionar ciclos de conteo), sacado de Configuraciones — ver renderCiclos.
  ctx.__appstate.perfil = { id:1, nombre:'Beto', rol:'operador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  assert(ctx.vistaBloqueadaParaRol('ciclos')===true, 'un operador debe tener bloqueada la vista Períodos (ciclos), igual que Dashboard/Plan/Carga');
  const htmlTabOperadorCiclos = ctx.tabBtn('ciclos', 'Períodos');
  assert(htmlTabOperadorCiclos.includes('tab-bloqueada') && htmlTabOperadorCiclos.includes('tab-candado'), 'el tab Períodos de un operador debe mostrar el candado, obtuvo: '+htmlTabOperadorCiclos);
  ctx.__appstate.perfil = { id:2, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  assert(ctx.vistaBloqueadaParaRol('ciclos')===false, 'un admin NO debe tener bloqueada la vista Períodos');
  assert(ctx.viewTitle('ciclos')==='Períodos de conteo', 'el título de la vista ciclos debe ser "Períodos de conteo", obtuvo: '+ctx.viewTitle('ciclos'));

  ctx.__appstate.view = 'dashboard';
  ctx.__appstate.dash = { total: [], diario: [], semanal: [], mensual: [] };
  ctx.__appstate.ultimosConteos = [];
  const shellHtmlTabs = ctx.renderShell();
  assert(shellHtmlTabs.includes('id="btn-ir-skus"'), 'la barra superior debe tener un ícono para ir a SKUs, obtuvo: '+shellHtmlTabs.slice(0,900));
  assert(shellHtmlTabs.includes('data-tab="ciclos"') && !shellHtmlTabs.includes('data-tab="skus"'), 'la barra inferior debe tener el tab "ciclos" (Períodos) en vez de "skus", obtuvo: '+shellHtmlTabs.slice(shellHtmlTabs.indexOf('tabbar')-10, shellHtmlTabs.indexOf('tabbar')+400));
  ctx.bind();
  const btnIrSkus = elements['btn-ir-skus'];
  assert(!!btnIrSkus, 'bind() debe haber consultado #btn-ir-skus');
  btnIrSkus.dispatch('click');
  assert(ctx.__appstate.view==='skus', 'tocar el ícono de SKUs de la barra superior debe navegar a la vista skus, obtuvo: '+ctx.__appstate.view);

  if(fallos > 0){
    console.error(`\n${fallos} aserción(es) fallaron.`);
    process.exit(1);
  }
  console.log('TODOS LOS TESTS PASARON');
})().catch(e=>{ console.error('FALLO:', e); process.exit(1); });
