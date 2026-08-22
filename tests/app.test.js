const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
if(!m) throw new Error('No se encontró el bloque <script>');
let script = m[1];
// Evitar que se ejecute el arranque real de la app al final del script.
script = script.replace(/\nasync function iniciarApp\(\)\{[\s\S]*?\niniciarApp\(\);\s*$/, '\n');
script += '\nvar __appstate = state;\nvar __TypeError = TypeError;\n';

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
let autoservicioRespuesta = { error: null };
const calls = [];
const fakeFetchImpl = async (url, opts) => {
  calls.push({url, opts});
  const u = new URL(url);
  const path = u.pathname + u.search;
  if(path.startsWith('/rest/v1/rpc/mi_estado_bloqueo')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify([estadoBloqueoRespuesta]) };
  }
  if(path.startsWith('/functions/v1/flow-cancelar-suscripcion')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'{"ok":true}', json: async()=>({ok:true}) };
  }
  if(path.startsWith('/rest/v1/plan_semanal_detalle')){
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
  if(path.startsWith('/rest/v1/ubicaciones_generales')){
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify([
        {bodega:'Nave Mina', cantidad_skus: 23708},
        {bodega:'Nave Planta', cantidad_skus: 4235},
      ]),
    };
  }
  if(path.startsWith('/rest/v1/ubicaciones_especificas')){
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify([
        {bodega:'Nave Mina', ubicacion:'Interior Nave', cantidad_skus: 100},
        {bodega:'Nave Mina', ubicacion:'Rack', cantidad_skus: 50},
      ]),
    };
  }
  if(path.startsWith('/rest/v1/ubicaciones_bins')){
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify([
        {bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-01', cantidad_skus: 5},
        {bodega:'Nave Mina', ubicacion:'Interior Nave', storage_bin:'A-02', cantidad_skus: 3},
      ]),
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
  // Búsqueda (columnas categoria,ubicacion en el select) — chequear antes que "materiales
  // contados" del dashboard, cuyo select es un prefijo del de búsqueda.
  if(path.startsWith('/rest/v1/conteos?select=') && path.includes('categoria,ubicacion')){
    const offsetMatch = path.match(/offset=(\d+)/);
    const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
    const total = 34;
    const filas = [];
    for(let i=offset; i<Math.min(offset+30, total); i++){
      filas.push({id:'busq-'+i, cantidad_contada:5, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-18T10:00:00Z', bodega:'Nave', skus:{sku_code:'SKU-'+i, descripcion:'Item '+i}, conteo_fotos:[]});
    }
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
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
      {id:'eq1', nombre:'Beto Ríos', rol:'inventariador', activo:true},
      {id:'eq2', nombre:'Marta Soto', rol:'admin', activo:false},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/reconteo_pendiente') && path.includes('order=diferencia_abs.desc')){
    const filas = [
      {id:'top1', sku_code:'SKU-TOP-1', descripcion:'Motor eléctrico', stock_sistema:50, ultima_cantidad_contada:20, ultima_diferencia:-30, diferencia_abs:30, ultimo_conteo_fecha:'2026-08-10', causa_probable:'Ubicación distinta y recurrente'},
      {id:'top2', sku_code:'SKU-TOP-2', descripcion:'Filtro hidráulico', stock_sistema:10, ultima_cantidad_contada:8, ultima_diferencia:-2, diferencia_abs:2, ultimo_conteo_fecha:'2026-08-09', causa_probable:'Sin patrón detectado'},
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
  if(path.startsWith('/rest/v1/auditoria')){
    const todas = [
      {id:'a1', tabla:'usuarios', accion:'UPDATE', actor_nombre:'Ana Torres', datos_antes:{nombre:'Carlos', rol:'inventariador', activo:true}, datos_despues:{nombre:'Carlos', rol:'admin', activo:true}, creado_en:'2026-08-15T10:00:00Z'},
      {id:'a2', tabla:'conteos', accion:'INSERT', actor_nombre:'Beto', datos_antes:null, datos_despues:{cantidad_contada:5, estado:'pendiente_revision'}, creado_en:'2026-08-14T09:00:00Z'},
      {id:'a3', tabla:'empresas', accion:'DELETE', actor_nombre:null, datos_antes:{nombre:'Minera Vieja'}, datos_despues:null, creado_en:'2026-08-13T08:00:00Z'},
    ];
    const filas = path.includes('tabla=eq.usuarios') ? todas.filter(f=>f.tabla==='usuarios') : todas;
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
  if(path.startsWith('/rest/v1/errores_cliente') && (!opts || opts.method!=='POST')){
    if(path.includes('offset=')){
      const offsetMatch = path.match(/offset=(\d+)/);
      const offset = Number(offsetMatch[1]);
      const total = 34;
      const filas = [];
      for(let i=offset; i<Math.min(offset+30, total); i++){
        filas.push({id:'err-pag-'+i, mensaje:'error '+i, url:'https://inventiapp.cl/index.html', empresas:{nombre:'Minera Andes'}, creado_en:'2026-08-18T10:00:00Z'});
      }
      return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
    }
    const filas = [
      {id:'err-1', mensaje:'algo falló', url:'https://inventiapp.cl/index.html', empresas:{nombre:'Minera Andes'}, creado_en:'2026-08-18T10:00:00Z'},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/errores_cliente')){
    return { status:201, ok:true, headers:{get:()=>null}, text: async()=>'' };
  }
  if(path.startsWith('/rest/v1/planes')){
    const filas = [
      {id:'plan-basico', nombre:'basico', etiqueta:'Básico'},
      {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'},
      {id:'plan-empresa', nombre:'empresa', etiqueta:'Empresa'},
    ];
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>JSON.stringify(filas) };
  }
  if(path.startsWith('/rest/v1/responsables_proceso')){
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
  if(path.startsWith('/rest/v1/rpc/eliminar_skus_sin_contar')){
    return { status:200, ok:true, headers:{get:()=>null}, text: async()=>'4' };
  }
  if(path.startsWith('/rest/v1/skus?activo=eq.true') && path.includes('bodega=is.null') && path.includes('ubicacion=is.null')){
    const filas = [{sku_code:'SKU-SUELTO', descripcion:'Repuesto suelto', storage_bin:null, unidad_medida:'UN'}];
    return {
      status: 200, ok: true,
      headers: { get: (h) => h==='content-range' ? `0-${filas.length-1}/${filas.length}` : null },
      text: async () => JSON.stringify(filas),
    };
  }
  if(path.startsWith('/rest/v1/skus?activo=eq.true&select=sku_code,descripcion,storage_bin,unidad_medida')){
    const binFiltro = (path.match(/storage_bin=eq\.([^&]+)/)||[])[1];
    const filas = binFiltro==='A-01'
      ? [{sku_code:'SKU-001', descripcion:'Perno M8', storage_bin:'A-01', unidad_medida:'UN'}]
      : binFiltro==='A-02'
        ? [{sku_code:'SKU-002', descripcion:'Tuerca M8', storage_bin:'A-02', unidad_medida:'UN'}]
        : [];
    return {
      status: 200,
      ok: true,
      headers: { get: (h) => h==='content-range' ? `0-${filas.length-1}/${filas.length}` : null },
      text: async () => JSON.stringify(filas),
    };
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
    appendChild(child){ this.hijos.push(child); }, remove(){}, focus(){},
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
const sandbox = {
  console,
  document: documentMock,
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
  assert(Array.isArray(generales) && generales.length===2, 'cargarOpcionesGenerales debe cargar 2 filas, obtuvo: '+JSON.stringify(generales));
  assert(generales[0].bodega==='Nave Mina', 'primer valor debe ser Nave Mina');

  const especificas = await ctx.opcionesEspecificas('Nave Mina');
  assert(especificas.length===2 && especificas[0].ubicacion==='Interior Nave', 'opcionesEspecificas debe filtrar por bodega, obtuvo: '+JSON.stringify(especificas));
  const especificasVacio = await ctx.opcionesEspecificas('');
  assert(especificasVacio.length===0, 'opcionesEspecificas con bodega vacía debe devolver []');

  const bins = await ctx.opcionesBins('Nave Mina', 'Interior Nave');
  assert(bins.length===2 && bins[0].storage_bin==='A-01', 'opcionesBins debe filtrar por bodega+ubicacion, obtuvo: '+JSON.stringify(bins));
  const binsVacio = await ctx.opcionesBins('Nave Mina', '');
  assert(binsVacio.length===0, 'opcionesBins sin ubicación debe devolver []');

  // Verificar que las URLs generadas llevan los filtros esperados.
  const especificasCall = calls.find(c=>c.url.includes('/ubicaciones_especificas') && c.url.includes('bodega=eq.Nave'));
  assert(!!especificasCall, 'Debe llamarse a ubicaciones_especificas con filtro bodega=eq.');
  const binsCall = calls.find(c=>c.url.includes('/ubicaciones_bins') && c.url.includes('bodega=eq.Nave') && c.url.includes('ubicacion=eq.Interior'));
  assert(!!binsCall, 'Debe llamarse a ubicaciones_bins con filtros bodega y ubicacion');

  // cargarResponsables debe poblar state.plan.responsables.
  await ctx.cargarResponsables();
  const responsablesAsignables = ctx.__appstate.plan.responsables;
  assert(Array.isArray(responsablesAsignables) && responsablesAsignables.length===2 && responsablesAsignables[0].nombre==='Ana Torres', 'cargarResponsables debe cargar los responsables activos, obtuvo: '+JSON.stringify(responsablesAsignables));

  // A partir de aquí, las acciones requieren sesión + perfil (con empresa_id) cargados, como en la app real.
  ctx.__appstate.session = { access_token:'x', user:{email:'a@b.com'} };
  ctx.__appstate.perfil = { id:1, nombre:'Test', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Empresa Test', codigo_invitacion:'ABC12345'} };

  // crearResponsable / quitarResponsable deben pegarle a responsables_proceso.
  calls.length = 0;
  await ctx.crearResponsable('Nuevo Responsable');
  const postResponsable = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/responsables_proceso'));
  assert(!!postResponsable, 'crearResponsable debe hacer POST a /responsables_proceso');
  assert(JSON.parse(postResponsable.opts.body)[0].nombre==='Nuevo Responsable', 'el POST debe llevar el nombre ingresado');
  assert(JSON.parse(postResponsable.opts.body)[0].empresa_id==='emp-1', 'el POST debe llevar el empresa_id del perfil actual');

  calls.length = 0;
  await ctx.quitarResponsable('u1');
  const patchResponsable = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/responsables_proceso?id=eq.u1'));
  assert(!!patchResponsable, 'quitarResponsable debe hacer PATCH a /responsables_proceso?id=eq.<id>');
  assert(JSON.parse(patchResponsable.opts.body).activo===false, 'quitarResponsable debe desactivar (activo:false), no borrar');

  // Verificar que renderPlanificacion genera los <select> encadenados, el de Responsable y la lista de responsables.
  const htmlOut = ctx.renderPlanificacion();
  assert(htmlOut.includes('<select id="p-bodega">'), 'p-bodega debe ser un <select>');
  assert(htmlOut.includes('<select id="p-ubic" disabled>'), 'p-ubic debe iniciar como <select disabled>');
  assert(htmlOut.includes('<select id="p-bin" multiple size="6" disabled>'), 'p-bin debe iniciar como <select multiple disabled>');
  assert(htmlOut.includes('<option value="Nave Mina">Nave Mina</option>'), 'debe listar Nave Mina como opción de bodega');
  assert(!htmlOut.includes('datalist'), 'no debe quedar ningún <datalist> residual');
  assert(!htmlOut.includes('placeholder="Ej. Nave Mina"'), 'el placeholder de texto libre no debe seguir ahí');
  assert(htmlOut.includes('<input type="checkbox" id="p-bin-todos" disabled>'), 'debe existir el checkbox "Seleccionar todos", inicialmente deshabilitado');
  assert(htmlOut.includes('<select id="p-responsable">') && htmlOut.includes('<option value="">Sin asignar</option>'), 'debe existir el select de Responsable con opción "Sin asignar"');
  assert(htmlOut.includes('<option value="u1">Ana Torres</option>') && htmlOut.includes('<option value="u2">Joel Majmut</option>'), 'el select de Responsable debe listar los responsables activos, obtuvo: '+htmlOut);
  assert(!htmlOut.includes('form-responsable') && !htmlOut.includes('form-operador'), 'la gestión de operadores ya no debe estar en Planificación (se movió a Configuraciones), obtuvo: '+htmlOut);

  // La gestión de operadores ahora vive en Configuraciones: formulario para agregar + lista con botón eliminar.
  const htmlConfig = ctx.renderConfiguraciones();
  assert(htmlConfig.includes('id="form-operador"') && htmlConfig.includes('id="nuevo-operador"'), 'Configuraciones debe tener el formulario para agregar operadores, obtuvo: '+htmlConfig);
  assert(htmlConfig.includes('data-eliminar-operador="u1"') && htmlConfig.includes('data-eliminar-operador="u2"'), 'Configuraciones debe listar cada operador con un botón para eliminarlo, obtuvo: '+htmlConfig);
  assert(htmlConfig.includes('Ana Torres') && htmlConfig.includes('Joel Majmut'), 'Configuraciones debe mostrar los nombres de los operadores existentes');

  // bind() en la vista 'config' debe conectar el formulario y los botones de eliminar a las funciones reales.
  ctx.__appstate.view = 'config';
  ctx.bind();
  calls.length = 0;
  const nuevoOperadorEl = makeEl('nuevo-operador');
  nuevoOperadorEl.value = 'Carlos Rojas';
  const formOperadorEl = elements['form-operador'];
  await new Promise(resolve => {
    formOperadorEl.dispatch('submit', {target: formOperadorEl, preventDefault(){}});
    setTimeout(resolve, 20);
  });
  const postOperador = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/responsables_proceso'));
  assert(!!postOperador && JSON.parse(postOperador.opts.body)[0].nombre==='Carlos Rojas', 'el submit del formulario de operadores debe crear el operador con el nombre ingresado, obtuvo: '+JSON.stringify(postOperador));

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

  // Sin bins seleccionados ni responsable -> una sola fila con storage_bin y responsable_id null.
  calls.length = 0;
  await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'Nave Mina', ubicacion:'Interior Nave', storageBins:[], responsableId:'', nota:''});
  const postVacio = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/plan_semanal'));
  const filasVacio = JSON.parse(postVacio.opts.body);
  assert(filasVacio.length===1 && filasVacio[0].storage_bin===null, 'Sin selección debe crear una sola fila con storage_bin null, obtuvo: '+JSON.stringify(filasVacio));
  assert(filasVacio[0].responsable_id===null, 'Sin responsable elegido, responsable_id debe ser null, obtuvo: '+JSON.stringify(filasVacio));

  // ===== SKU sin ubicación (bodega/ubicación en null): deben poder incluirse en el plan =====

  // cargarConteoSinUbicacion: pide el total de SKU activos sin bodega ni ubicación.
  await ctx.cargarConteoSinUbicacion();
  assert(ctx.__appstate.plan.sinUbicacionCount===1, 'cargarConteoSinUbicacion debe guardar el total de SKU sueltos, obtuvo: '+ctx.__appstate.plan.sinUbicacionCount);

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
  const skusCallE1 = calls.find(c=>c.url.includes('/skus?activo=eq.true&select=sku_code') && c.url.includes('storage_bin=eq.A-01'));
  assert(!!skusCallE1, 'cargarPlanSemanal debe consultar /skus (detalle) para cada entrada automáticamente, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(Array.isArray(ctx.__appstate.plan.detalle.e1) && ctx.__appstate.plan.detalle.e1[0].sku_code==='SKU-001', 'debe quedar cargado el detalle real de SKU (código/descripción) para A-01, obtuvo: '+JSON.stringify(ctx.__appstate.plan.detalle.e1));

  const htmlConDetalle = ctx.renderPlanificacion();
  assert(htmlConDetalle.includes('plan-item-detalle') && htmlConDetalle.includes('SKU-001') && htmlConDetalle.includes('Perno M8'), 'con el detalle ya cargado, debe listar SKU y descripción en la tarjeta sin ningún clic, obtuvo: '+htmlConDetalle);
  assert(htmlConDetalle.includes('class="icon-btn plan-sku-quitar" data-plan-id="e1" data-sku-code="SKU-001"'), 'cada SKU listado debe tener un botón para quitarlo de la planificación, obtuvo: '+htmlConDetalle);
  assert(/data-sku-code="SKU-001"[^>]*title="Quitar solo este SKU/.test(htmlConDetalle), 'el botón de quitar un SKU debe tener un title distinto al de eliminar toda la entrada, obtuvo: '+htmlConDetalle);

  // La entrada e2 tiene SKU-002 excluido (skus_excluidos en la vista): tanto el conteo como el detalle
  // deben pedirse con el filtro sku_code=not.in.(...) para no volver a mostrarlo.
  const skusCallE2 = calls.find(c=>c.url.includes('/skus?activo=eq.true&select=sku_code') && c.url.includes('storage_bin=eq.A-02'));
  assert(!!skusCallE2 && skusCallE2.url.includes('sku_code=not.in.(SKU-002)'), 'la consulta de detalle para e2 debe excluir SKU-002, obtuvo: '+JSON.stringify(skusCallE2));
  const universoCallE2 = calls.find(c=>c.url.includes('/skus?activo=eq.true') && !c.url.includes('select=sku_code') && c.url.includes('storage_bin=eq.A-02'));
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
  const proySinSkus = ctx.proyeccionTermino(0, 0, 0);
  assert(proySinSkus.titulo==='—', 'sin SKU cargados no debe intentar proyectar nada, obtuvo: '+JSON.stringify(proySinSkus));

  // proyeccionTermino: inventario ya completo.
  const proyCompleto = ctx.proyeccionTermino(100, 100, 5);
  assert(proyCompleto.titulo==='¡Inventario completo!', 'sin pendientes debe avisar que está completo, obtuvo: '+JSON.stringify(proyCompleto));

  // proyeccionTermino: hay pendientes pero nada contado en la ventana -> no se puede estimar ritmo.
  const proySinRitmo = ctx.proyeccionTermino(100, 50, 0);
  assert(proySinRitmo.titulo==='Sin proyección', 'sin conteos recientes no debe inventarse una fecha, obtuvo: '+JSON.stringify(proySinRitmo));

  // proyeccionTermino: caso normal — 100 pendientes, ritmo de 10 SKU/día (140 contados en la
  // ventana de 14 días = 10/día) -> 100/10 = 10 días más.
  const proyNormal = ctx.proyeccionTermino(200, 100, 140);
  assert(proyNormal.detalle.includes('10 días más') && proyNormal.detalle.includes('100 pendientes'), 'debe calcular los días restantes como pendientes/ritmo, obtuvo: '+JSON.stringify(proyNormal));
  assert(proyNormal.titulo!=='—' && proyNormal.titulo!=='Sin proyección' && proyNormal.titulo!=='¡Inventario completo!', 'el caso normal debe mostrar una fecha proyectada, obtuvo: '+JSON.stringify(proyNormal));

  // cargarDashboard: el ranking por responsable ahora se calcula en SQL (rpc/ranking_responsable,
  // ver ranking_responsable_en_sql), no trayendo filas crudas y agrupando en JS — evita el límite
  // de 5000 filas que tenía el enfoque anterior si un cliente crece mucho en volumen.
  ctx.__appstate.session = { access_token:'x', user:{id:'user-1', email:'a@b.com'} };
  calls.length = 0;
  await ctx.cargarDashboard();
  const rankingCall = calls.find(c=>c.url.includes('/rest/v1/rpc/ranking_responsable'));
  assert(!!rankingCall && rankingCall.opts.method==='POST' && JSON.parse(rankingCall.opts.body).dias===14, 'cargarDashboard debe llamar al RPC ranking_responsable con la ventana de días, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.ranking.length===3 && ctx.__appstate.dash.ranking[0].nombre==='Ana Torres', 'cargarDashboard debe dejar el ranking que devuelve el RPC en state.dash.ranking, obtuvo: '+JSON.stringify(ctx.__appstate.dash.ranking));

  // cargarDashboard: exactitud de unidades/ubicación (vista exactitud_por_bodega) y top
  // materiales con diferencia (reconteo_pendiente ordenado por diferencia_abs desc).
  const exactitudCall = calls.find(c=>c.url.includes('/exactitud_por_bodega'));
  assert(!!exactitudCall, 'cargarDashboard debe pedir /exactitud_por_bodega, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.exactitudBodega.length===2 && ctx.__appstate.dash.exactitudBodega[0].bodega==='Nave Mina', 'cargarDashboard debe dejar la exactitud por bodega en state.dash.exactitudBodega, obtuvo: '+JSON.stringify(ctx.__appstate.dash.exactitudBodega));
  const topDiferenciasCall = calls.find(c=>c.url.includes('/reconteo_pendiente') && c.url.includes('order=diferencia_abs.desc'));
  assert(!!topDiferenciasCall && topDiferenciasCall.url.includes('limit=5'), 'cargarDashboard debe pedir el top de diferencias ordenado por magnitud, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.dash.topDiferencias.length===2 && ctx.__appstate.dash.topDiferencias[0].sku_code==='SKU-TOP-1', 'cargarDashboard debe dejar el top de diferencias en state.dash.topDiferencias, obtuvo: '+JSON.stringify(ctx.__appstate.dash.topDiferencias));

  // renderDashboard: la vista ejecutiva debe mostrar la proyección de término y el ranking por responsable.
  ctx.__appstate.dash = {
    total: [{bodega:'Nave Mina', skus_universo:200, skus_contados:60, porcentaje_avance:30}],
    diario: [], semanal: [], mensual: [],
    ranking: [{nombre:'Ana Torres', cantidad:9}, {nombre:'Beto', cantidad:4}],
  };
  const htmlDashProyeccion = ctx.renderDashboard();
  assert(htmlDashProyeccion.includes('Proyección de término'), 'la vista ejecutiva debe mostrar la sección de proyección, obtuvo: '+htmlDashProyeccion);
  assert(htmlDashProyeccion.includes('Ranking por responsable') && htmlDashProyeccion.includes('Ana Torres') && htmlDashProyeccion.includes('Beto'), 'la vista ejecutiva debe mostrar el ranking por responsable, obtuvo: '+htmlDashProyeccion);

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
    topDiferencias: [
      {sku_code:'SKU-TOP-1', descripcion:'Motor eléctrico', stock_sistema:50, ultima_cantidad_contada:20, ultima_diferencia:-30, causa_probable:'Ubicación distinta y recurrente'},
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
  assert(htmlDashExactitud.includes('Top materiales con diferencia') && htmlDashExactitud.includes('SKU-TOP-1') && htmlDashExactitud.includes('badge-danger">Ubicación distinta y recurrente<'), 'debe mostrar el top de materiales con diferencia y su causa probable, obtuvo: '+htmlDashExactitud);

  // Sin datos de exactitud (empresa recién empezando), no debe mostrarse el ranking ni el top.
  ctx.__appstate.dash = { ...ctx.__appstate.dash, exactitudBodega: [], topDiferencias: [] };
  const htmlDashSinExactitud = ctx.renderDashboard();
  assert(!htmlDashSinExactitud.includes('Ranking por ubicación general') && !htmlDashSinExactitud.includes('Top materiales con diferencia'), 'sin datos de exactitud todavía, no deben mostrarse esas secciones, obtuvo: '+htmlDashSinExactitud);

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
      { dia:'2026-08-18', bodega:'Bodega Central Rajo', skus_contados:'2', con_diferencia:'1', total_unidades_contadas:'30' },
      { dia:'2026-08-18', bodega:'Bodega Planta Chancado', skus_contados:'3', con_diferencia:'1', total_unidades_contadas:'42' },
    ],
    semanal: [], mensual: [], ranking: [],
  };
  const htmlDashStrings = ctx.renderDashboard();
  assert(htmlDashStrings.includes('91.7%'), 'con campos numéricos como string (igual que los devuelve PostgREST), el avance global debe seguir calculándose bien (22/24 = 91.7%), obtuvo: '+htmlDashStrings);
  assert(!htmlDashStrings.includes('01311') && !htmlDashStrings.includes('0139'), 'no debe quedar rastro de concatenación de texto en vez de suma numérica, obtuvo: '+htmlDashStrings);

  const diarioAggStrings = ctx.agregarPorDia(ctx.__appstate.dash.diario, 14);
  assert(diarioAggStrings.length===1 && diarioAggStrings[0].contados===5 && diarioAggStrings[0].diferencias===2, 'agregarPorDia debe sumar numéricamente aunque los campos vengan como string, obtuvo: '+JSON.stringify(diarioAggStrings));

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

  const htmlConfigBasico = ctx.renderConfiguraciones();
  assert(!htmlConfigBasico.includes('Auditoría de cambios'), 'plan básico no debe mostrar la sección de auditoría aunque el usuario sea admin, obtuvo: '+htmlConfigBasico);

  // Plan profesional: sí debe verse todo.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', planes:{nombre:'profesional', etiqueta:'Profesional', max_bodegas:null, max_usuarios:15, offline_habilitado:true, dashboard_ejecutivo_habilitado:true, auditoria_habilitada:true}} };
  const htmlDashPro = ctx.renderDashboard();
  assert(htmlDashPro.includes('data-dash-modo="ejecutivo"'), 'plan profesional debe mostrar el botón del modo Ejecutivo, obtuvo: '+htmlDashPro);
  const htmlConfigPro = ctx.renderConfiguraciones();
  assert(htmlConfigPro.includes('Auditoría de cambios'), 'plan profesional debe mostrar la sección de auditoría para un admin, obtuvo: '+htmlConfigPro);

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

  // Un admin de empresa (no super-admin) sí debe poder invitar gente a SU propia empresa.
  assert(htmlConfigAdmin.includes('id="form-invitar-equipo"'), 'un admin de empresa debe ver el formulario para invitar a su equipo, obtuvo: '+htmlConfigAdmin);
  assert(htmlConfigAdmin.includes('<option value="inventariador">Inventariador</option>') && !htmlConfigAdmin.includes('Supervisor'), 'el rol a elegir debe ser Inventariador/Administrador, sin Supervisor, obtuvo: '+htmlConfigAdmin);

  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'inventariador', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  const htmlConfigInventariador = ctx.renderConfiguraciones();
  assert(!htmlConfigInventariador.includes('id="form-empresa-nombre"'), 'un inventariador (no admin) no debe poder editar el nombre de la empresa, obtuvo: '+htmlConfigInventariador);
  assert(!htmlConfigInventariador.includes('id="form-invitar-equipo"'), 'un inventariador (no admin) no debe poder invitar gente a la empresa, obtuvo: '+htmlConfigInventariador);

  // invitarPersona desde un admin de empresa (no super-admin): debe llamar a invite-user igual, pero
  // sin disparar el resumen del super-admin (no le corresponde a un admin normal).
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'admin', es_super_admin:false, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  calls.length = 0;
  const okInvitacionEquipo = await ctx.invitarPersona({email:'nueva@equipo.cl', nombre:'Diego Soto', empresaId:'emp-1', rol:'inventariador'});
  const invokeEquipoCall = calls.find(c=>c.url.includes('/functions/v1/invite-user'));
  assert(!!invokeEquipoCall, 'invitarPersona debe llamar a invite-user también cuando lo usa un admin de empresa, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(okInvitacionEquipo===true, 'invitarPersona debe devolver true, obtuvo: '+okInvitacionEquipo);
  assert(!calls.some(c=>c.url.includes('/rpc/resumen_empresas_super_admin')), 'un admin normal (no super-admin) no debe disparar el resumen del super-admin, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));

  // Panel de super-admin: solo visible si perfil.es_super_admin.
  ctx.__appstate.perfil = { id:3, nombre:'Vendedor', rol:'admin', es_super_admin:true, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true, plan_id:'plan-pro'}, {id:'emp-2', nombre:'Minera Sur', activo:true, plan_id:'plan-basico'}], resumen:[], leads:[], planes:[{id:'plan-basico', nombre:'basico', etiqueta:'Básico'}, {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'}, {id:'plan-empresa', nombre:'empresa', etiqueta:'Empresa'}], errores:[], invitando:false, cargado:true };
  const htmlConfigSuperAdmin = ctx.renderConfiguraciones();
  assert(htmlConfigSuperAdmin.includes('id="form-crear-empresa-sa"') && htmlConfigSuperAdmin.includes('id="form-invitar-persona-sa"'), 'un super-admin debe ver el panel para crear empresas e invitar personas, obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('Minera Andes') && htmlConfigSuperAdmin.includes('Minera Sur'), 'debe listar las empresas existentes, obtuvo: '+htmlConfigSuperAdmin);
  assert(htmlConfigSuperAdmin.includes('<option value="emp-1">Minera Andes</option>') && htmlConfigSuperAdmin.includes('<option value="emp-2">Minera Sur</option>'), 'el selector de empresa del formulario de invitación debe listar las empresas, obtuvo: '+htmlConfigSuperAdmin);
  assert(!htmlConfigSuperAdmin.includes('Supervisor'), 'ya no debe existir el rol Supervisor en ningún selector, obtuvo: '+htmlConfigSuperAdmin);
  assert(!htmlConfigSuperAdmin.includes('id="form-invitar-equipo"'), 'un super-admin ya tiene su propio panel para invitar; no debe duplicarse con el de "invitar a tu equipo", obtuvo: '+htmlConfigSuperAdmin);

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

  // ===== Monitoreo de errores =====

  // cargarErroresSuperAdmin: pide /errores_cliente y los deja listos para renderSuperAdmin.
  calls.length = 0;
  await ctx.cargarErroresSuperAdmin();
  assert(calls.some(c=>c.url.includes('/errores_cliente?select=')), 'cargarErroresSuperAdmin debe pedir /errores_cliente, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.superadmin.errores.length===1 && ctx.__appstate.superadmin.errores[0].mensaje==='algo falló', 'debe guardar los errores devueltos por el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.superadmin.errores));
  const htmlConErrores = ctx.renderSuperAdmin();
  assert(htmlConErrores.includes('algo falló') && htmlConErrores.includes('Minera Andes'), 'el panel de super-admin debe mostrar el mensaje y la empresa del error, obtuvo: '+htmlConErrores);
  ctx.__appstate.superadmin.errores = [];
  assert(ctx.renderSuperAdmin().includes('Sin errores reportados'), 'sin errores debe mostrar un mensaje vacío, no una lista rota');

  // cargarMasErroresSuperAdmin: mismo patrón de "cargar más" que leads.
  ctx.__appstate.superadmin.errores = Array.from({length:30}, (_,i)=>({id:'seed-err-'+i, mensaje:'e'+i, url:'', empresas:null, creado_en:'2026-08-18T10:00:00Z'}));
  ctx.__appstate.superadmin.erroresHayMas = true;
  calls.length = 0;
  await ctx.cargarMasErroresSuperAdmin();
  const erroresCallMas = calls.find(c=>c.url.includes('/errores_cliente?select='));
  assert(!!erroresCallMas && erroresCallMas.url.includes('offset=30'), 'cargarMasErroresSuperAdmin debe pedir la página siguiente con offset=30, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.superadmin.errores.length===34, 'debe agregar las filas nuevas a las 30 que ya había, obtuvo: '+ctx.__appstate.superadmin.errores.length);
  assert(ctx.__appstate.superadmin.erroresHayMas===false, 'al agotarse los datos (4 < 30), erroresHayMas debe pasar a false');

  // reportarError: hace POST a /errores_cliente con el mensaje, la URL y el user agent.
  calls.length = 0;
  ctx.reportarError('Boom de prueba', 'stack de prueba');
  await new Promise(r => setTimeout(r, 0));
  const postError = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/errores_cliente'));
  assert(!!postError, 'reportarError debe hacer POST a /errores_cliente, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  const bodyError = JSON.parse(postError.opts.body)[0];
  assert(bodyError.mensaje==='Boom de prueba' && bodyError.stack==='stack de prueba', 'el POST debe llevar el mensaje y el stack, obtuvo: '+postError.opts.body);

  // No debe floodear: el mismo mensaje reportado dos veces solo dispara un POST.
  calls.length = 0;
  ctx.reportarError('Repetido', 'x');
  ctx.reportarError('Repetido', 'x');
  await new Promise(r => setTimeout(r, 0));
  const postsRepetidos = calls.filter(c=>c.opts && c.opts.method==='POST' && c.url.includes('/errores_cliente'));
  assert(postsRepetidos.length===1, 'el mismo error reportado dos veces no debe floodear con dos POST, obtuvo: '+postsRepetidos.length);

  // Una empresa inactiva se debe marcar como tal y el selector de invitación no debe ofrecerla.
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true, plan_id:'plan-pro'}, {id:'emp-2', nombre:'Minera Sur', activo:false, plan_id:'plan-basico'}], resumen:[], leads:[], planes:[{id:'plan-basico', nombre:'basico', etiqueta:'Básico'}, {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'}], errores:[], invitando:false, cargado:true, personasEmpresaId:'', personas:[], cargandoPersonas:false };
  const htmlConEmpresaInactiva = ctx.renderConfiguraciones();
  assert(htmlConEmpresaInactiva.includes('Inactiva'), 'una empresa desactivada debe mostrar la etiqueta "Inactiva", obtuvo: '+htmlConEmpresaInactiva);
  assert(!htmlConEmpresaInactiva.includes('<option value="emp-2">Minera Sur</option>'), 'el selector de invitación no debe ofrecer una empresa inactiva, obtuvo: '+htmlConEmpresaInactiva);

  // renderSuperAdmin: cada empresa debe tener un selector de plan con la opción actual
  // preseleccionada, para que el super-admin la pueda cambiar (cobro manual).
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true, plan_id:'plan-pro'}], resumen:[], leads:[], planes:[{id:'plan-basico', nombre:'basico', etiqueta:'Básico'}, {id:'plan-pro', nombre:'profesional', etiqueta:'Profesional'}, {id:'plan-empresa', nombre:'empresa', etiqueta:'Empresa'}], errores:[], invitando:false, cargado:true, personasEmpresaId:'', personas:[], cargandoPersonas:false };
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

  calls.length = 0;
  await ctx.actualizarPersonaEquipo('eq1', {rol:'admin'});
  const patchRolEquipo = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/usuarios?id=eq.eq1'));
  assert(!!patchRolEquipo && JSON.parse(patchRolEquipo.opts.body).rol==='admin', 'actualizarPersonaEquipo debe poder cambiar el rol, obtuvo: '+JSON.stringify(patchRolEquipo));

  // Restaurar el perfil de super-admin para los tests siguientes de este mismo bloque.
  ctx.__appstate.perfil = { id:3, nombre:'Vendedor', rol:'admin', es_super_admin:true, empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };

  // El nombre de la empresa debe mostrarse en la barra superior de la app.
  ctx.__appstate.view = 'dashboard';
  ctx.__appstate.dash = { total: [], diario: [], semanal: [], mensual: [] };
  ctx.__appstate.ultimosConteos = [];
  const shellHtml = ctx.renderShell();
  assert(shellHtml.includes('Minera Andes'), 'la barra superior debe mostrar el nombre de la empresa actual, obtuvo: '+shellHtml.slice(0,600));

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

  // solicitarRecuperacion: dispara el correo vía /auth/v1/recover y vuelve al login.
  calls.length = 0;
  ctx.__appstate.authRecuperar = true;
  await ctx.solicitarRecuperacion('alguien@test.com');
  const recoverCall = calls.find(c=>c.url.includes('/auth/v1/recover'));
  assert(!!recoverCall, 'solicitarRecuperacion debe llamar a /auth/v1/recover, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(recoverCall.opts.body).email==='alguien@test.com', 'debe enviar el correo ingresado, obtuvo: '+recoverCall.opts.body);
  assert(ctx.__appstate.authRecuperar===false, 'tras enviar el link, debe volver a la pantalla de login normal, obtuvo: '+ctx.__appstate.authRecuperar);

  // actualizarNombreEmpresa: PATCH a /empresas y actualización optimista del estado local.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes', codigo_invitacion:'ZZ998877'} };
  calls.length = 0;
  await ctx.actualizarNombreEmpresa('Minera Andes Sur');
  const patchEmpresa = calls.find(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/empresas?id=eq.emp-1'));
  assert(!!patchEmpresa, 'actualizarNombreEmpresa debe hacer PATCH a /empresas?id=eq.<empresa_id>, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(patchEmpresa.opts.body).nombre==='Minera Andes Sur', 'el PATCH debe llevar el nuevo nombre, obtuvo: '+patchEmpresa.opts.body);
  assert(ctx.__appstate.perfil.empresas.nombre==='Minera Andes Sur', 'debe reflejar el nuevo nombre en el estado local tras guardar, obtuvo: '+ctx.__appstate.perfil.empresas.nombre);

  // Las acciones de escritura deben viajar con el empresa_id del perfil actual (aislamiento entre empresas).
  // crearSkuManual debe hacer upsert (on_conflict=empresa_id,sku_code + merge-duplicates), igual que la
  // carga masiva: si el código ya existía para esta empresa, se actualiza en vez de fallar por duplicado.
  calls.length = 0;
  await ctx.crearSkuManual({sku_code:'SKU-999', descripcion:'Perno de prueba', activo:true});
  const postSku = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/skus'));
  assert(!!postSku, 'crearSkuManual debe hacer POST a /skus, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(postSku.url.includes('on_conflict=empresa_id,sku_code'), 'crearSkuManual debe hacer upsert por (empresa_id, sku_code), obtuvo: '+postSku.url);
  assert((postSku.opts.headers.Prefer||'').includes('resolution=merge-duplicates'), 'el upsert debe pedir resolution=merge-duplicates para actualizar en vez de fallar si ya existe, obtuvo: '+postSku.opts.headers.Prefer);
  assert(JSON.parse(postSku.opts.body)[0].empresa_id==='emp-1', 'el POST de crearSkuManual debe incluir el empresa_id del perfil actual, obtuvo: '+postSku.opts.body);
  // crearSkuManual dispara refrescarListaSkus() sin esperarlo (fire-and-forget): hay que dejar
  // que esa cadena de promesas termine aquí, o su llamada a /ultimo_conteo_por_sku se cuela
  // más adelante y contamina el conteo de llamadas del siguiente bloque (perfil no cargado).
  await new Promise(r=>setTimeout(r, 0));

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
    await ctx.crearResponsable('Alguien');
    await ctx.crearPlanEntrada({fecha:'2026-08-12', bodega:'Nave Mina', ubicacion:'Interior Nave', storageBins:[], responsableId:'', nota:''});
    await ctx.confirmarCargaMasiva();

    assert(calls.length===0, 'con el perfil sin cargar, ninguna de estas acciones debe llegar a llamar a la red, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
    const nuevosToastsPerfil = toastRootPerfil.hijos.slice(toastsAntesPerfil);
    assert(nuevosToastsPerfil.length>=5 && nuevosToastsPerfil.every(t=>/no se pudo cargar tu perfil/i.test(t.textContent)), 'cada acción debe avisar con un mensaje claro en vez de crashear, obtuvo: '+JSON.stringify(nuevosToastsPerfil.map(t=>t.textContent)));

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

  // renderTablaSkus: los checkboxes de selección solo deben verse para admin, no para inventariador.
  ctx.__appstate.skusPagina = { rows:[{id:'sku-x', sku_code:'SKU-X', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null}], page:0, total:1 };
  ctx.__appstate.skusSeleccionados = [];
  const htmlTablaAdmin = ctx.renderTablaSkus();
  assert(htmlTablaAdmin.includes('class="chk-sku"') && htmlTablaAdmin.includes('id="chk-skus-todos"'), 'un admin debe ver los checkboxes de selección, obtuvo: '+htmlTablaAdmin);
  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'inventariador', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  const htmlTablaInventariador = ctx.renderTablaSkus();
  assert(!htmlTablaInventariador.includes('class="chk-sku"'), 'un inventariador no debe ver los checkboxes de selección de SKU, obtuvo: '+htmlTablaInventariador);
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };

  // renderTablaSkus: pinta en rojo el SKU cuyo último conteo quedó con diferencia, en verde el
  // que cuadró (aprobado), y sin color el que todavía no se ha contado.
  ctx.__appstate.skusPagina = { rows:[
    {id:'sku-dif', sku_code:'SKU-DIF', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, ultimoEstado:'con_diferencia'},
    {id:'sku-ok', sku_code:'SKU-OK', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, ultimoEstado:'aprobado'},
    {id:'sku-sc', sku_code:'SKU-SC', descripcion:'x', bodega:null, ubicacion:null, storage_bin:null, stock_sistema:null, ultimoEstado:null},
  ], page:0, total:3 };
  const htmlColorFilas = ctx.renderTablaSkus();
  const filaDif = htmlColorFilas.slice(htmlColorFilas.indexOf('SKU-DIF')-200, htmlColorFilas.indexOf('SKU-DIF'));
  const filaOk = htmlColorFilas.slice(htmlColorFilas.indexOf('SKU-OK')-200, htmlColorFilas.indexOf('SKU-OK'));
  const filaSc = htmlColorFilas.slice(htmlColorFilas.indexOf('SKU-SC')-200, htmlColorFilas.indexOf('SKU-SC'));
  assert(filaDif.includes('color-mix') && filaDif.includes('--danger'), 'el SKU con último conteo con diferencia debe pintarse en rojo, obtuvo: '+filaDif);
  assert(filaOk.includes('color-mix') && filaOk.includes('--ok'), 'el SKU con último conteo aprobado (cuadrado) debe pintarse en verde, obtuvo: '+filaOk);
  assert(!filaSc.includes('color-mix'), 'el SKU que aún no se ha contado no debe llevar color de fila, obtuvo: '+filaSc);
  assert(htmlColorFilas.includes('btn-eliminar-skus-sin-contar'), 'la tabla de SKU debe incluir el botón para eliminar todo lo no contado, obtuvo: '+htmlColorFilas);

  // ===== Ciclos de conteo: crear, listar y marcar el actual =====
  calls.length = 0;
  await ctx.cargarCiclos();
  assert(calls.some(c=>c.url.includes('/ciclos_conteo?select=')), 'cargarCiclos debe pedir /ciclos_conteo, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.ciclos.length===2 && ctx.__appstate.ciclos[0].nombre==='T1 2027', 'debe guardar los ciclos devueltos por el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.ciclos));
  const htmlConfigConCiclos = ctx.renderConfiguraciones();
  assert(htmlConfigConCiclos.includes('T1 2027') && htmlConfigConCiclos.includes('T4 2026'), 'Configuraciones debe listar los ciclos existentes, obtuvo: '+htmlConfigConCiclos);
  assert(htmlConfigConCiclos.includes('data-marcar-ciclo-actual="ciclo-2"') && !htmlConfigConCiclos.includes('data-marcar-ciclo-actual="ciclo-1"'), 'solo el ciclo que no es el actual debe ofrecer el botón de "marcar como actual" (ciclo-1 ya lo es), obtuvo: '+htmlConfigConCiclos);

  calls.length = 0;
  await ctx.crearCiclo('T2 2027');
  const postCiclo = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/ciclos_conteo'));
  assert(!!postCiclo && JSON.parse(postCiclo.opts.body)[0].nombre==='T2 2027', 'crearCiclo debe hacer POST a /ciclos_conteo con el nombre, obtuvo: '+JSON.stringify(postCiclo));

  calls.length = 0;
  await ctx.marcarCicloActual('ciclo-2');
  const patchesCiclo = calls.filter(c=>c.opts && c.opts.method==='PATCH' && c.url.includes('/ciclos_conteo'));
  assert(patchesCiclo.length===2, 'marcarCicloActual debe hacer dos PATCH: desmarcar el actual anterior y marcar el nuevo, obtuvo: '+JSON.stringify(patchesCiclo.map(c=>c.url)));
  assert(patchesCiclo[0].url.includes('es_actual=eq.true') && JSON.parse(patchesCiclo[0].opts.body).es_actual===false, 'el primer PATCH debe desmarcar el ciclo actual anterior, obtuvo: '+JSON.stringify(patchesCiclo[0]));
  assert(patchesCiclo[1].url.includes('id=eq.ciclo-2') && JSON.parse(patchesCiclo[1].opts.body).es_actual===true, 'el segundo PATCH debe marcar el ciclo elegido como actual, obtuvo: '+JSON.stringify(patchesCiclo[1]));

  // renderBuscar: el filtro de ciclo solo debe verse si hay ciclos creados, y debe incluir
  // la opción "Sin ciclo asignado" además de cada ciclo real.
  ctx.__appstate.busqueda = { texto:'', bodega:'', estado:'', ciclo:'', soloConFotos:false, resultados:[], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0 };
  const htmlBuscarConCiclos = ctx.renderBuscar();
  assert(htmlBuscarConCiclos.includes('id="b-ciclo"') && htmlBuscarConCiclos.includes('Sin ciclo asignado') && htmlBuscarConCiclos.includes('T1 2027'), 'Buscar debe ofrecer el filtro de ciclo con la opción "Sin ciclo asignado" y los ciclos reales, obtuvo: '+htmlBuscarConCiclos);

  // fueCapturadoOffline: distingue una captura offline (fechas separadas por horas) de una
  // online normal (mismo instante), con un margen de un minuto para no marcar falsos positivos.
  assert(ctx.fueCapturadoOffline('2026-08-10T08:00:00Z', '2026-08-10T20:00:00Z')===true, 'una diferencia de horas debe considerarse captura offline');
  assert(ctx.fueCapturadoOffline('2026-08-10T08:00:00.000Z', '2026-08-10T08:00:00.500Z')===false, 'una diferencia de milisegundos (guardado online normal) no debe marcarse como offline');
  assert(ctx.fueCapturadoOffline(null, '2026-08-10T08:00:00Z')===false, 'sin capturado_en no debe marcarse como offline (dato no disponible, no error)');

  // renderBuscar: debe indicar "Capturado ... sin conexión" solo en la fila que de verdad
  // se capturó offline (fechas separadas), no en un conteo online normal (fechas iguales).
  ctx.__appstate.busqueda = { texto:'', bodega:'', estado:'', soloConFotos:false, buscando:false, yaBuscado:true, resultados: [
    { id:'c1', skus:{sku_code:'SKU-A', descripcion:''}, bodega:'Nave', cantidad_contada:5, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-10T20:00:00Z', capturado_en:'2026-08-10T08:00:00Z', conteo_fotos:[] },
    { id:'c2', skus:{sku_code:'SKU-B', descripcion:''}, bodega:'Nave', cantidad_contada:2, estado:'aprobado', diferencia:0, fecha_conteo:'2026-08-11T09:00:00Z', capturado_en:'2026-08-11T09:00:00Z', conteo_fotos:[] },
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
  calls.length = 0;
  await ctx.guardarConteo({cantidad:7, ubicacion:'Rack A', bodega:'Nave Mina', observacion:'nota'});
  ctx.fetch = fetchOriginalOffline;
  assert(!calls.some(c=>c.url.includes('/storage/v1/object/fotos-inventario/')), 'sin conexión, no debe intentar subir la foto todavía (se sube recién al sincronizar)');
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
  assert(calls.length===0 || !calls.some(c=>c.opts && c.opts.method==='POST' && c.url.includes('resolution=merge-duplicates') && c.url.includes('/skus')), 'no debe haber quedado un POST exitoso a /skus, solo el intento fallido');
  assert(ctx.__appstate.colaOffline.length===1, 'crearSkuManual sin conexión debe agregar el SKU a la cola offline, obtuvo: '+JSON.stringify(ctx.__appstate.colaOffline));
  const itemSkuEncolado = ctx.__appstate.colaOffline[0];
  assert(itemSkuEncolado.tipo==='sku' && itemSkuEncolado.sku_code==='SKU-OFF-1' && itemSkuEncolado.empresa_id==='emp-1', 'el SKU encolado debe tener tipo "sku" y los datos ingresados, obtuvo: '+JSON.stringify(itemSkuEncolado));
  assert(itemSkuEncolado.estado==='pendiente', 'un SKU recién encolado debe quedar "pendiente", obtuvo: '+itemSkuEncolado.estado);

  // El panel de detalle debe distinguir el tipo (SKU vs Conteo) y no pedir fotos para un SKU.
  ctx.__appstate.offlineModal = true;
  const modalConSku = ctx.renderOfflineModal();
  ctx.__appstate.offlineModal = false;
  assert(modalConSku.includes('SKU · SKU-OFF-1') && modalConSku.includes('Perno offline'), 'el panel debe mostrar la etiqueta "SKU" y la descripción ingresada, obtuvo: '+modalConSku);

  // sincronizarColaOffline: con conexión, debe hacer upsert a /skus (mismo on_conflict que crearSkuManual online).
  calls.length = 0;
  await ctx.sincronizarColaOffline();
  const postSkuSincronizado = calls.find(c=>c.opts && c.opts.method==='POST' && c.url.includes('/rest/v1/skus') && c.url.includes('on_conflict=empresa_id,sku_code'));
  assert(!!postSkuSincronizado, 'sincronizarColaOffline debe hacer upsert a /skus para un item tipo "sku", obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(JSON.parse(postSkuSincronizado.opts.body)[0].sku_code==='SKU-OFF-1', 'el upsert debe llevar el código del SKU encolado, obtuvo: '+postSkuSincronizado.opts.body);
  assert(JSON.parse(postSkuSincronizado.opts.body)[0].capturado_en===new Date(itemSkuEncolado.creado_en).toISOString(), 'el upsert de un SKU offline debe llevar capturado_en con la fecha original en que se encoló, obtuvo: '+postSkuSincronizado.opts.body);
  assert(ctx.__appstate.colaOffline.length===0, 'tras sincronizar con éxito, el SKU debe salir de la cola');

  // Limpieza para no afectar pruebas siguientes.
  ctx.guardarColaOffline([]);

  // ===== Auditoría de cambios (quién creó/modificó/eliminó personas, empresas y conteos) =====

  // resumenCambioAuditoria: mensaje legible según la acción.
  assert(ctx.resumenCambioAuditoria({accion:'INSERT'})==='Se creó el registro', 'INSERT debe mostrar "Se creó el registro"');
  assert(ctx.resumenCambioAuditoria({accion:'DELETE'})==='Se eliminó el registro', 'DELETE debe mostrar "Se eliminó el registro"');
  const resumenUpdate = ctx.resumenCambioAuditoria({accion:'UPDATE', tabla:'usuarios', datos_antes:{nombre:'Carlos', rol:'inventariador', activo:true}, datos_despues:{nombre:'Carlos', rol:'admin', activo:true}});
  assert(resumenUpdate==='Rol: inventariador → admin', 'UPDATE debe listar solo los campos que cambiaron, obtuvo: '+resumenUpdate);
  const resumenSinCambios = ctx.resumenCambioAuditoria({accion:'UPDATE', tabla:'usuarios', datos_antes:{nombre:'Carlos'}, datos_despues:{nombre:'Carlos'}});
  assert(resumenSinCambios==='Sin cambios visibles', 'UPDATE sin diferencias en los campos auditados debe decirlo, obtuvo: '+resumenSinCambios);

  // cargarAuditoria: pide /auditoria ordenado por fecha, con filtro opcional de tabla.
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  calls.length = 0;
  await ctx.cargarAuditoria('');
  const auditoriaCallTodas = calls.find(c=>c.url.includes('/auditoria?select='));
  assert(!!auditoriaCallTodas && auditoriaCallTodas.url.includes('order=creado_en.desc'), 'cargarAuditoria debe pedir /auditoria ordenado por fecha descendente, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.auditoria.filas.length===3, 'debe cargar las filas devueltas por el servidor, obtuvo: '+JSON.stringify(ctx.__appstate.auditoria.filas));

  // renderConfiguraciones: la sección de auditoría solo debe verse para admin/super-admin, no para inventariador.
  const htmlConfigAdminAuditoria = ctx.renderConfiguraciones();
  assert(htmlConfigAdminAuditoria.includes('id="auditoria-filtro-tabla"') && htmlConfigAdminAuditoria.includes('Auditoría de cambios'), 'un admin debe ver la sección de auditoría, obtuvo: '+htmlConfigAdminAuditoria);
  assert(htmlConfigAdminAuditoria.includes('Ana Torres') && htmlConfigAdminAuditoria.includes('Rol: inventariador → admin'), 'debe listar la actividad con actor y el resumen del cambio, obtuvo: '+htmlConfigAdminAuditoria);
  assert(htmlConfigAdminAuditoria.includes('Por: Sistema'), 'un actor nulo (alta automática) debe mostrarse como "Sistema", obtuvo: '+htmlConfigAdminAuditoria);

  calls.length = 0;
  await ctx.cargarAuditoria('usuarios');
  const auditoriaCallFiltrada = calls.find(c=>c.url.includes('/auditoria?select='));
  assert(!!auditoriaCallFiltrada && auditoriaCallFiltrada.url.includes('tabla=eq.usuarios'), 'con filtro de tabla, debe pedir /auditoria con tabla=eq.<tabla>, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.auditoria.filas.length===1 && ctx.__appstate.auditoria.filas[0].tabla==='usuarios', 'debe quedar solo la fila de la tabla filtrada, obtuvo: '+JSON.stringify(ctx.__appstate.auditoria.filas));
  assert(ctx.__appstate.auditoria.filtroTabla==='usuarios', 'debe recordar el filtro elegido');

  ctx.__appstate.perfil = { id:2, nombre:'Beto', rol:'inventariador', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };
  const htmlConfigInventariadorAuditoria = ctx.renderConfiguraciones();
  assert(!htmlConfigInventariadorAuditoria.includes('id="auditoria-filtro-tabla"'), 'un inventariador (no admin) no debe ver la sección de auditoría, obtuvo: '+htmlConfigInventariadorAuditoria);

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

  // ===== Dashboard: "Materiales contados" con "Cargar más" =====
  calls.length = 0;
  await ctx.cargarUltimosConteos();
  assert(ctx.__appstate.ultimosConteos.length===30 && ctx.__appstate.ultimosConteosHayMas===true, 'cargarUltimosConteos debe traer la primera página (30) y marcar hayMas, obtuvo: '+ctx.__appstate.ultimosConteos.length);
  calls.length = 0;
  await ctx.cargarMasUltimosConteos();
  const conteosCallMas = calls.find(c=>c.url.includes('/conteos?select='));
  assert(!!conteosCallMas && conteosCallMas.url.includes('offset=30'), 'cargarMasUltimosConteos debe pedir la página siguiente con offset=30, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.ultimosConteos.length===34 && ctx.__appstate.ultimosConteosHayMas===false, 'debe agregar las 4 filas restantes y marcar que ya no hay más, obtuvo: '+ctx.__appstate.ultimosConteos.length);

  // ===== Buscar: "Cargar más" respetando los filtros de texto y fotos (que se aplican en
  // el cliente, no en la consulta) =====
  ctx.__appstate.busqueda = {texto:'', bodega:'', estado:'', soloConFotos:false, resultados:[], buscando:false, yaBuscado:true, hayMas:false, buscandoMas:false, paginaOffset:0};
  calls.length = 0;
  await ctx.buscarConteos();
  assert(ctx.__appstate.busqueda.resultados.length===30 && ctx.__appstate.busqueda.hayMas===true, 'buscarConteos debe traer la primera página (30) y marcar hayMas, obtuvo: '+ctx.__appstate.busqueda.resultados.length);
  assert(ctx.__appstate.busqueda.paginaOffset===30, 'debe recordar cuántas filas crudas ya se pidieron al servidor, obtuvo: '+ctx.__appstate.busqueda.paginaOffset);
  calls.length = 0;
  await ctx.buscarMasConteos();
  const busquedaCallMas = calls.find(c=>c.url.includes('/conteos?select='));
  assert(!!busquedaCallMas && busquedaCallMas.url.includes('offset=30'), 'buscarMasConteos debe pedir la página siguiente con offset=30, obtuvo: '+JSON.stringify(calls.map(c=>c.url)));
  assert(ctx.__appstate.busqueda.resultados.length===34 && ctx.__appstate.busqueda.hayMas===false, 'debe agregar las 4 filas restantes y marcar que ya no hay más, obtuvo: '+ctx.__appstate.busqueda.resultados.length);
  const htmlBusquedaSinMas = ctx.renderBuscar();
  assert(!htmlBusquedaSinMas.includes('id="btn-cargar-mas-busqueda"'), 'sin más páginas, el botón "Cargar más" de Buscar no debe mostrarse, obtuvo: '+htmlBusquedaSinMas);

  // ===== Escáner de códigos: resolución código → SKU y asociación =====
  // (debe ir antes de handleLogout más abajo, que reasigna `state` por completo y deja
  // desactualizada la referencia __appstate capturada al cargar el script — ver nota ahí.)
  ctx.__appstate.perfil = { id:1, nombre:'Ana', rol:'admin', empresa_id:'emp-1', empresas:{nombre:'Minera Andes'} };

  const skusEscaner = [
    { id:'sku-a', sku_code:'SKU-A', descripcion:'Perno M8', bodega:'Nave', codigo_barras:null },
    { id:'sku-b', sku_code:'SKU-B', descripcion:'Tuerca M8', bodega:'Nave', codigo_barras:'7801234567890' },
  ];

  // resolverSkuPorCodigo: primero intenta contra el propio sku_code (stickers genéricos
  // reimpresos con el código del SKU), luego contra codigo_barras (código de fábrica ya asociado).
  assert(ctx.resolverSkuPorCodigo(skusEscaner, 'SKU-A').id==='sku-a', 'debe resolver por coincidencia exacta de sku_code');
  assert(ctx.resolverSkuPorCodigo(skusEscaner, 'sku-a').id==='sku-a', 'la coincidencia de sku_code no debe ser sensible a mayúsculas/minúsculas');
  assert(ctx.resolverSkuPorCodigo(skusEscaner, '7801234567890').id==='sku-b', 'debe resolver por codigo_barras cuando no coincide ningún sku_code');
  assert(ctx.resolverSkuPorCodigo(skusEscaner, 'NO-EXISTE')===null, 'un código que no coincide con nada debe devolver null');
  assert(ctx.resolverSkuPorCodigo(skusEscaner, '')===null, 'un código vacío debe devolver null sin romper');
  assert(ctx.resolverSkuPorCodigo(skusEscaner, '  SKU-A  ').id==='sku-a', 'debe recortar espacios antes de comparar');

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

  // onCodigoEscaneado con destino 'campo-sku' (botón de escanear en "Cargar SKU"): no hay
  // nada que resolver contra el maestro existente, así que llena directo el campo de código
  // del formulario de alta y cierra el modal, sin pasar por la pantalla de asociación.
  ctx.__appstate.escanerModal = { codigo:null, error:null, destino:'campo-sku' };
  await ctx.onCodigoEscaneado('BARCODE-NUEVO-999');
  assert(ctx.__appstate.escanerModal===null, 'al escanear para agregar un SKU, el modal debe cerrarse de inmediato, obtuvo: '+JSON.stringify(ctx.__appstate.escanerModal));
  assert(documentMock.getElementById('s-code').value === 'BARCODE-NUEVO-999', 'debe llenar el campo de código del formulario de alta con el código leído, obtuvo: '+documentMock.getElementById('s-code').value);

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

  if(fallos > 0){
    console.error(`\n${fallos} aserción(es) fallaron.`);
    process.exit(1);
  }
  console.log('TODOS LOS TESTS PASARON');
})().catch(e=>{ console.error('FALLO:', e); process.exit(1); });
