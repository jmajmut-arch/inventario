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

const calls = [];
const fakeFetchImpl = async (url, opts) => {
  calls.push({url, opts});
  const u = new URL(url);
  const path = u.pathname + u.search;
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
  if(path.startsWith('/rest/v1/auditoria')){
    const todas = [
      {id:'a1', tabla:'usuarios', accion:'UPDATE', actor_nombre:'Ana Torres', datos_antes:{nombre:'Carlos', rol:'inventariador', activo:true}, datos_despues:{nombre:'Carlos', rol:'admin', activo:true}, creado_en:'2026-08-15T10:00:00Z'},
      {id:'a2', tabla:'conteos', accion:'INSERT', actor_nombre:'Beto', datos_antes:null, datos_despues:{cantidad_contada:5, estado:'pendiente_revision'}, creado_en:'2026-08-14T09:00:00Z'},
      {id:'a3', tabla:'empresas', accion:'DELETE', actor_nombre:null, datos_antes:{nombre:'Minera Vieja'}, datos_despues:null, creado_en:'2026-08-13T08:00:00Z'},
    ];
    const filas = path.includes('tabla=eq.usuarios') ? todas.filter(f=>f.tabla==='usuarios') : todas;
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
  window: { print: () => { printCalled++; } },
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
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true}, {id:'emp-2', nombre:'Minera Sur', activo:true}], resumen:[], invitando:false, cargado:true };
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

  // Una empresa inactiva se debe marcar como tal y el selector de invitación no debe ofrecerla.
  ctx.__appstate.superadmin = { empresas:[{id:'emp-1', nombre:'Minera Andes', activo:true}, {id:'emp-2', nombre:'Minera Sur', activo:false}], resumen:[], invitando:false, cargado:true, personasEmpresaId:'', personas:[], cargandoPersonas:false };
  const htmlConEmpresaInactiva = ctx.renderConfiguraciones();
  assert(htmlConEmpresaInactiva.includes('Inactiva'), 'una empresa desactivada debe mostrar la etiqueta "Inactiva", obtuvo: '+htmlConEmpresaInactiva);
  assert(!htmlConEmpresaInactiva.includes('<option value="emp-2">Minera Sur</option>'), 'el selector de invitación no debe ofrecer una empresa inactiva, obtuvo: '+htmlConEmpresaInactiva);

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
