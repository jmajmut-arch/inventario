// Verifica que cada select que la app le pide a Supabase use columnas que existen de verdad.
//
// Por qué existe: PostgREST no ignora una columna desconocida — rechaza la consulta completa con
// un 400. Si el código que recibe ese error lo trata como "no hay datos", un fallo del servidor se
// vuelve indistinguible de un resultado vacío. Pasó de verdad: el buscador de Ingreso empezó a
// pedir `tipo_material` a la vista `skus_lectura`, que no lo exponía, y buscar un material que sí
// existía respondía "Sin resultados" (SKU 11594426 de Minera Test).
//
// El esquema real vive en esquema-supabase.json y se actualiza a mano tras cada migración que
// agregue o quite columnas. Si esta prueba falla, revisa cuál de las dos cosas quedó atrasada: el
// select de la app o la migración de la vista.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const esquema = JSON.parse(fs.readFileSync(path.join(__dirname, 'esquema-supabase.json'), 'utf8')).relaciones;

// Extrae los rest('/relacion?...select=col,col,...') con lista de columnas literal. Los selects
// armados con plantillas (`${...}`) o con relaciones embebidas (`empresas(nombre)`) se omiten:
// no se pueden validar sin ejecutar el código.
function selectsDe(codigo){
  const encontrados = [];
  const re = /rest\(\s*[`'"]\/([a-z_]+)\?([^`'"]*)/g;
  let m;
  while((m = re.exec(codigo)) !== null){
    const relacion = m[1];
    const qs = m[2];
    const sel = /select=([^&`'"]+)/.exec(qs);
    if(!sel) continue;
    const lista = sel[1];
    if(lista.includes('${') || lista.includes('(') || lista.trim() === '*') continue;
    const columnas = lista.split(',').map(c => c.trim()).filter(Boolean);
    if(columnas.length) encontrados.push({relacion, columnas});
  }
  return encontrados;
}

test('cada select de la app pide columnas que existen en Supabase', () => {
  const codigo = fs.readFileSync(path.join(RAIZ, 'app', 'index.html'), 'utf8');
  const usos = selectsDe(codigo);
  assert.ok(usos.length > 10, `se esperaban varios selects que validar, se encontraron ${usos.length}: revisa el extractor`);

  const problemas = [];
  for(const {relacion, columnas} of usos){
    const conocidas = esquema[relacion];
    if(!conocidas){
      problemas.push(`la relación "${relacion}" no está en esquema-supabase.json: agrégala tras la migración que la creó`);
      continue;
    }
    for(const col of columnas){
      if(!conocidas.includes(col)){
        problemas.push(`${relacion}.${col} no existe: PostgREST rechazaría la consulta entera con un 400`);
      }
    }
  }
  assert.deepStrictEqual(problemas, [], 'selects que apuntan a columnas inexistentes:\n  - ' + problemas.join('\n  - '));
});

test('el espejo app/inventario.html es idéntico a app/index.html', () => {
  // Las dos copias se sirven como la misma app; si se separan, la mitad de los usuarios queda con
  // una versión vieja sin que nada falle a la vista.
  const a = fs.readFileSync(path.join(RAIZ, 'app', 'index.html'), 'utf8');
  const b = fs.readFileSync(path.join(RAIZ, 'app', 'inventario.html'), 'utf8');
  assert.strictEqual(a === b, true, 'app/inventario.html quedó desincronizado: copia app/index.html sobre él antes de publicar');
});

// El formulario del sitio (assets/comun.js) inserta en leads_demo como anon. Una columna que no
// exista hace que PostgREST rechace el INSERT entero: el lead se pierde. Cada campo que mandan
// los formularios (cuerpo: function () { return { ... } }) tiene que existir en la tabla.
test('los formularios del sitio mandan a leads_demo solo columnas que existen', () => {
  const codigo = fs.readFileSync(path.join(RAIZ, 'assets', 'comun.js'), 'utf8');
  const bloques = [...codigo.matchAll(/cuerpo:\s*function\s*\(\)\s*\{\s*return\s*\{([\s\S]*?)\};/g)].map(m => m[1]);
  assert.ok(bloques.length >= 2, `se esperaban los formularios de demo y de contacto, se encontraron ${bloques.length}: revisa el extractor`);
  const conocidas = esquema.leads_demo;
  assert.ok(conocidas, 'leads_demo no está en esquema-supabase.json');
  // Además de existir, la columna tiene que tener permiso de INSERT para anon: desde el 12/10/2026
  // el permiso es por columna (supabase/migrations/20261012_leads_columnas_publicas.sql). Se toma
  // el último "grant insert (...) on public.leads_demo" de las migraciones.
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let permitidas = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8');
    for (const g of sql.matchAll(/grant\s+insert\s*\(([^)]*)\)\s*on\s+public\.leads_demo/gi)) permitidas = g[1].split(',').map(c => c.trim());
  }
  assert.ok(permitidas, 'no se encontró el grant insert (...) on public.leads_demo en supabase/migrations');
  const problemas = [];
  for (const bloque of bloques) {
    for (const m of bloque.matchAll(/^\s*([a-z_]+)\s*:/gm)) {
      if (!conocidas.includes(m[1])) problemas.push(`leads_demo.${m[1]} no existe: el INSERT del formulario fallaría con un 400 y se perdería el lead`);
      else if (!permitidas.includes(m[1])) problemas.push(`leads_demo.${m[1]} no tiene permiso de INSERT para el público: el formulario fallaría y se perdería el lead`);
    }
  }
  assert.deepStrictEqual(problemas, [], problemas.join('\n'));
});

// buscar_skus_lectura con un texto raro no puede volver a recorrer el maestro completo. Pasó de
// verdad (prueba de carga del 13/10/2026): con "PERNO", "FILTRO" o "RODAMIENTO", que en Escondida
// casi no aparecen, el planificador elegía el recorrido en orden de código y revisaba los 81.000
// materiales (315-355 ms por búsqueda); el buscador fue el 45% del trabajo de la base y la app se
// saturó con 500 personas. La corrección (20261013_buscar_skus_lectura_texto_raro.sql) mira primero
// una ventana corta en orden de código y, si el texto resulta raro, busca por los índices de
// trigramas (el "offset 0" separa la búsqueda del orden). Se revisa la última migración que
// redefine la función, para que una versión nueva no pierda el arreglo sin darse cuenta.
test('el buscador no recorre el maestro completo con textos que aparecen poco', () => {
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let ultima = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8');
    if (/create\s+or\s+replace\s+function\s+public\.buscar_skus_lectura\s*\(/i.test(sql)) ultima = { archivo, sql };
  }
  assert.ok(ultima, 'no se encontró la migración de buscar_skus_lectura');
  const cuerpo = ultima.sql.replace(/--[^\n]*/g, '');
  assert.match(cuerpo, /length\(v_texto\)\s*>=\s*3/, `${ultima.archivo}: falta el camino para textos de 3 o más caracteres`);
  assert.match(cuerpo, /limit\s+v_ventana/, `${ultima.archivo}: falta el primer paso (ventana corta en orden de código)`);
  assert.match(cuerpo, /offset\s+0\s*\)\s*y\s+order\s+by/, `${ultima.archivo}: falta la búsqueda por trigramas separada del orden (offset 0) para los textos raros`);
  assert.match(cuerpo, /grant\s+execute\s+on\s+function\s+public\.buscar_skus_lectura\([^)]*\)\s+to\s+authenticated/i, `${ultima.archivo}: falta el permiso para authenticated`);
  assert.match(cuerpo, /revoke\s+all\s+on\s+function\s+public\.buscar_skus_lectura\([^)]*\)\s+from\s+public,\s*anon/i, `${ultima.archivo}: falta quitarle el permiso a public y anon (es SECURITY DEFINER)`);
});

// Las políticas de exclusiones e incluidos del plan comparan su propio empresa_id. Antes miraban
// la empresa a través del plan (un EXISTS sobre plan_semanal por cada fila leída) y eso era ~110 de
// los ~150 ms de avance_plan_por_ciclo en el Dashboard de Escondida
// (20261013_plan_hijos_empresa_id.sql). La columna la llena un trigger desde el plan: sin él, un
// insert de la app (que no la manda) fallaría por not null, y se podría escribir en un plan ajeno
// con un empresa_id propio. Se revisa la última definición de cada política y del trigger.
test('exclusiones e incluidos del plan filtran por su propio empresa_id y el trigger lo llena', () => {
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  const ultimas = {};
  let trigger = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/(?:create|alter)\s+policy\s+"?(auth_(?:read|insert|delete)_plan_semanal_(?:exclusiones|incluidos))"?\s+on\s+[^;]*;/gi)) {
      ultimas[m[1]] = { archivo, def: m[0] };
    }
    for (const m of sql.matchAll(/create\s+or\s+replace\s+function\s+public\.plan_hijo_fija_empresa\s*\(\)[\s\S]*?\$\$[\s\S]*?\$\$/gi)) {
      trigger = { archivo, def: m[0] };
    }
  }
  const problemas = [];
  for (const tabla of ['exclusiones', 'incluidos']) {
    for (const accion of ['read', 'insert', 'delete']) {
      const nombre = `auth_${accion}_plan_semanal_${tabla}`;
      const u = ultimas[nombre];
      if (!u) { problemas.push(`no se encontró la política ${nombre}`); continue; }
      if (!/empresa_id\s*=\s*\(\s*select\s+public\.empresa_actual\(\)\s*\)/i.test(u.def)) {
        problemas.push(`${u.archivo}: ${nombre} no compara empresa_id = (select public.empresa_actual())`);
      }
      if (/exists\s*\(/i.test(u.def)) problemas.push(`${u.archivo}: ${nombre} volvió a mirar la empresa a través del plan (EXISTS por fila)`);
    }
    const sqlTodo = fs.readdirSync(dirMig).map(a => fs.readFileSync(path.join(dirMig, a), 'utf8')).join('\n');
    if (!new RegExp(`create\\s+trigger\\s+\\w+\\s+before\\s+insert\\s+or\\s+update\\s+of\\s+plan_id,\\s*empresa_id\\s+on\\s+public\\.plan_semanal_${tabla}[\\s\\S]*?execute\\s+function\\s+public\\.plan_hijo_fija_empresa\\(\\)`, 'i').test(sqlTodo)) {
      problemas.push(`falta el trigger que llena empresa_id en plan_semanal_${tabla}`);
    }
  }
  assert.ok(trigger, 'no se encontró la función plan_hijo_fija_empresa');
  assert.match(trigger.def, /new\.empresa_id[\s\S]*plan_semanal/i, `${trigger.archivo}: plan_hijo_fija_empresa tiene que tomar la empresa del plan`);
  assert.doesNotMatch(trigger.def, /security\s+definer/i, `${trigger.archivo}: plan_hijo_fija_empresa no puede ser SECURITY DEFINER: leería planes ajenos y dejaría escribir en ellos`);
  assert.deepStrictEqual(problemas, [], problemas.join('\n'));
});

// Clasificación ABC por empresa (20261022_abc_por_empresa.sql). Antes refrescar_clasificacion_abc
// (al terminar cada carga de Excel) refrescaba una vista materializada con TODAS las empresas: una
// carga de Agunsa esperaba el recálculo de los ~64.500 materiales de Escondida (5,8 s de promedio, una
// vez más de 20 s y error) y escribía en materiales ajenos. Ahora la clase vive en skus y se recalcula
// solo para la empresa de quien llama. Esta prueba cuida que nadie vuelva a: leer la clasificación sin
// filtrar por empresa, recalcular todas las empresas desde la app, o leer la vista materializada vieja.
test('la clasificación ABC se lee y se recalcula por empresa', () => {
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let vista = null, funcion = null, porEmpresa = null, cron = null;
  const cuerpo = /\$(\w*)\$[\s\S]*?\$\1\$/;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    const v = /create\s+or\s+replace\s+view\s+public\.skus_valor_abc\b[\s\S]*?;/i.exec(sql);
    if (v) vista = { archivo, def: v[0] };
    const f = new RegExp(/create\s+or\s+replace\s+function\s+public\.refrescar_clasificacion_abc\s*\(\)[\s\S]*?/.source + cuerpo.source, 'i').exec(sql);
    if (f) funcion = { archivo, def: f[0] };
    const e = new RegExp(/create\s+or\s+replace\s+function\s+privado\.recalcular_abc_empresa\s*\([\s\S]*?/.source + cuerpo.source, 'i').exec(sql);
    if (e) porEmpresa = { archivo, def: e[0], sql };
    const c = /cron\.schedule\(\s*'refrescar-clasificacion-abc-nocturno'[\s\S]*?\);/i.exec(sql);
    if (c) cron = { archivo, def: c[0] };
  }
  assert.ok(vista && funcion && porEmpresa && cron, 'faltan en las migraciones skus_valor_abc, refrescar_clasificacion_abc, privado.recalcular_abc_empresa o el recálculo nocturno');
  assert.match(vista.def, /security_invoker\s*=\s*true/i, `${vista.archivo}: skus_valor_abc tiene que ser security_invoker`);
  assert.match(vista.def, /empresa_id\s*=\s*\(\s*select\s+(public\.)?empresa_actual\(\)/i, `${vista.archivo}: skus_valor_abc tiene que filtrar por la empresa de quien consulta`);
  assert.doesNotMatch(vista.def, /skus_valor_abc_empresa_mv/i, `${vista.archivo}: skus_valor_abc no puede volver a leer la vista materializada de todas las empresas`);
  assert.doesNotMatch(funcion.def, /refresh\s+materialized\s+view/i, `${funcion.archivo}: refrescar_clasificacion_abc no puede refrescar una vista de todas las empresas`);
  assert.match(funcion.def, /privado\.recalcular_abc_empresa\(\s*\(\s*select\s+empresa_actual\(\)\s*\)\s*\)/i, `${funcion.archivo}: refrescar_clasificacion_abc tiene que recalcular solo la empresa de quien llama`);
  assert.match(porEmpresa.def, /where\s+s\.empresa_id\s*=\s*p_empresa\s+and\s+s\.activo/i, `${porEmpresa.archivo}: recalcular_abc_empresa tiene que calcular solo con los materiales de esa empresa`);
  assert.match(porEmpresa.def, /pg_advisory_xact_lock\(\s*74103/i, `${porEmpresa.archivo}: recalcular_abc_empresa tiene que tomar su turno por empresa (clave 74103)`);
  assert.match(porEmpresa.sql, /revoke\s+all\s+on\s+function\s+privado\.recalcular_abc_empresa\(uuid\)\s+from\s+public,\s*anon,\s*authenticated/i, `${porEmpresa.archivo}: recalcular_abc_empresa no se puede llamar directo (recibe la empresa como parámetro)`);
  assert.match(cron.def, /privado\.recalcular_abc_todas\(\)/i, `${cron.archivo}: el recálculo nocturno tiene que ir empresa por empresa`);
  const posteriores = fs.readdirSync(dirMig).sort().filter(a => a > '20261022_abc_por_empresa.sql');
  for (const archivo of posteriores) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    assert.doesNotMatch(sql, /from\s+privado\.skus_valor_abc_empresa_mv|join\s+privado\.skus_valor_abc_empresa_mv/i, `${archivo}: no volver a leer la vista materializada vieja (sin uso desde 20261022_abc_por_empresa.sql)`);
  }
});

// Protección contra sobrecarga (20261013_proteccion_sobrecarga.sql). En la prueba de carga del
// 13/10/2026 la base se reinició sola con 750 personas: el Dashboard, la consulta más cara, ocupaba
// tantas conexiones como supervisores lo abrieran, y los conteos del mismo material entraban en
// deadlock. public.dashboard_ejecutivo es ahora solo la puerta (máximo 3 calculando y 6 dentro);
// el cálculo vive en privado.dashboard_ejecutivo_calculo. Si una migración nueva vuelve a definir
// public.dashboard_ejecutivo con el cálculo adentro, la protección desaparece sin que nada falle a
// la vista: por eso se revisa la última definición.
test('el Dashboard pasa por turnos y los conteos toman turno por material', () => {
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let puerta = null;
  let trigger = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    const p = /create\s+(?:or\s+replace\s+)?function\s+public\.dashboard_ejecutivo\s*\([\s\S]*?\$\$[\s\S]*?\$\$/i.exec(sql);
    if (p) puerta = { archivo, def: p[0] };
    if (/create\s+trigger\s+trg_conteos_turno_sku\s+before\s+insert\s+or\s+update\s+or\s+delete\s+on\s+public\.conteos/i.test(sql)) trigger = archivo;
  }
  assert.ok(puerta, 'no se encontró la definición de public.dashboard_ejecutivo');
  assert.match(puerta.def, /pg_try_advisory_xact_lock\(\s*74100/, `${puerta.archivo}: public.dashboard_ejecutivo perdió el límite de entrada (6 dentro)`);
  assert.match(puerta.def, /pg_try_advisory_xact_lock\(\s*74101/, `${puerta.archivo}: public.dashboard_ejecutivo perdió el límite de cálculo (3 a la vez)`);
  assert.match(puerta.def, /privado\.dashboard_ejecutivo_calculo\s*\(/, `${puerta.archivo}: public.dashboard_ejecutivo tiene que delegar en privado.dashboard_ejecutivo_calculo`);
  assert.match(puerta.def, /errcode\s*=\s*'53400'/, `${puerta.archivo}: al estar lleno, el Dashboard tiene que fallar con un error visible (53400 -> 503)`);
  assert.ok(trigger, 'falta el trigger trg_conteos_turno_sku: sin él, dos conteos del mismo material pueden entrar en deadlock');
});

test('cada opción de Estado en Buscar la entiende el servidor', () => {
  // Un valor que el servidor no reconoce cae en "estado literal" (s.ultimo_conteo_estado = valor)
  // y devuelve cero filas sin ningún error: el filtro se vería vacío, no roto. Los daños
  // (14/10/2026) entraron así: con_danos, packing_danado y material_danado.
  const html = fs.readFileSync(path.join(RAIZ, 'app', 'index.html'), 'utf8');
  const select = /<select id="b-estado">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, 'no se encontró el <select id="b-estado"> de Buscar');
  const opciones = [...select[1].matchAll(/<option value="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  const ESTADOS_DE_CONTEO = ['aprobado', 'con_diferencia', 'pendiente_revision'];
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  for (const funcion of ['contar_busqueda_skus', 'filas_busqueda_skus']) {
    let def = null, archivoDef = null;
    for (const archivo of fs.readdirSync(dirMig).sort()) {
      const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
      const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${funcion}\\s*\\([\\s\\S]*?\\$function\\$[\\s\\S]*?\\$function\\$`, 'i');
      const m = re.exec(sql);
      if (m) { def = m[0]; archivoDef = archivo; }
    }
    assert.ok(def, `no se encontró la definición de public.${funcion} en las migraciones`);
    const notIn = /not\s+in\s*\(([^)]*)\)\s+and\s+s\.ultimo_conteo_estado\s*=/i.exec(def);
    assert.ok(notIn, `${archivoDef}: ${funcion} perdió la lista de valores especiales de estado`);
    const especiales = [...notIn[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
    for (const valor of opciones) {
      if (ESTADOS_DE_CONTEO.includes(valor)) continue;
      assert.ok(especiales.includes(valor), `${archivoDef}: ${funcion} no reconoce el estado "${valor}" que ofrece Buscar (devolvería cero filas sin error)`);
      assert.match(def, new RegExp(`=\\s*'${valor}'\\s+and`), `${archivoDef}: ${funcion} lista "${valor}" pero no tiene su condición`);
    }
  }
});

test('la auditoría se guarda 45 días (decisión de Joel, 14/10/2026)', () => {
  // Cambiar la retención es una decisión de negocio, no un detalle técnico: si una migración la
  // mueve sin querer (como pasó de 14 a 180 y el nombre del cron quedó diciendo 14), esta prueba lo
  // hace visible. Para cambiarla a propósito, actualizar también esta prueba y el runbook.
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let def = null, archivoDef = null, cronNuevo = null, cronQuitado = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    const m = /create\s+(?:or\s+replace\s+)?function\s+public\.purgar_auditoria_antigua\s*\([\s\S]*?\$function\$[\s\S]*?\$function\$/i.exec(sql);
    if (m) { def = m[0]; archivoDef = archivo; }
    const s = /cron\.schedule\(\s*'(purga-auditoria-[^']+)'/i.exec(sql); if (s) cronNuevo = s[1];
    const u = /cron\.unschedule\(\s*'(purga-auditoria-[^']+)'/i.exec(sql); if (u) cronQuitado = u[1];
  }
  assert.ok(def, 'no se encontró public.purgar_auditoria_antigua en las migraciones');
  assert.match(def, /interval\s+'45 days'/i, `${archivoDef}: la purga de auditoría tiene que conservar 45 días`);
  assert.equal(cronNuevo, 'purga-auditoria-45-dias', 'el proceso nocturno de purga tiene que llamarse por su retención');
  assert.notEqual(cronQuitado, cronNuevo, 'la última migración no puede quitar el proceso de purga vigente');
});

test('el Estado general de SKU separa merma y excedente, sin mostrar el signo en conteo ciego', () => {
  // Joel, 14/10/2026: la porción "Diferencia" del Panel pasó a Merma y Excedente. La app llama a
  // resumen_general_skus_signos y el Dashboard la lee desde privado.dashboard_ejecutivo_calculo;
  // si alguno de los dos vuelve a la función vieja, el gráfico cae a "Diferencia" sin avisar.
  const html = fs.readFileSync(path.join(RAIZ, 'app', 'index.html'), 'utf8');
  assert.match(html, /rest\('\/rpc\/resumen_general_skus_signos'/, 'la app tiene que pedir el resumen con merma y excedente');
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let signos = null, calculo = null, archivoCalculo = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    const s = /create\s+(?:or\s+replace\s+)?function\s+public\.resumen_general_skus_signos\s*\([\s\S]*?\$\$[\s\S]*?\$\$/i.exec(sql);
    if (s) signos = s[0];
    const c = /create\s+(?:or\s+replace\s+)?function\s+privado\.dashboard_ejecutivo_calculo\s*\([\s\S]*?\$function\$[\s\S]*?\$function\$/i.exec(sql);
    if (c) { calculo = c[0]; archivoCalculo = archivo; }
  }
  assert.ok(signos, 'no se encontró public.resumen_general_skus_signos en las migraciones');
  assert.match(signos, /merma\s+bigint[\s\S]*excedente\s+bigint/i, 'resumen_general_skus_signos tiene que devolver merma y excedente');
  assert.match(signos, /debe_ocultar_stock_operador\(\)/, 'con conteo ciego, un operador no puede recibir el signo de las diferencias');
  assert.ok(calculo, 'no se encontró privado.dashboard_ejecutivo_calculo en las migraciones');
  assert.match(calculo, /'resumenGeneral'[\s\S]*?resumen_general_skus_signos\(\s*p_criticidad\s*\)/, `${archivoCalculo}: el Dashboard tiene que traer el resumen con merma y excedente`);
});

test('las fotos de Buscar numeran sus conteos dentro del período, como el resto de la app', () => {
  // Joel, 14/10/2026: Buscar marcaba como "Reconteo" fotos de un conteo. skus_busqueda numeraba
  // los conteos de cada material sumando todos los períodos, así que el primer conteo de un
  // período salía como "Reconteo 1" si el material ya se había contado en uno anterior (12 fotos en
  // Escondida). Reconteo, el Panel y el Calendario numeran por período (sku + ciclo).
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let def = null, archivoDef = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    const m = /create\s+(?:or\s+replace\s+)?view\s+public\.skus_busqueda\b[\s\S]*?;/i.exec(sql);
    if (m) { def = m[0]; archivoDef = archivo; }
  }
  assert.ok(def, 'no se encontró la definición de public.skus_busqueda en las migraciones');
  assert.match(def, /security_invoker\s*=\s*true/i, `${archivoDef}: skus_busqueda tiene que seguir con security_invoker (RLS de quien consulta)`);
  assert.match(def, /row_number\(\)\s+over\s*\(\s*partition\s+by\s+c\.ciclo_id\s+order\s+by\s+c\.fecha_conteo\s*\)\s+as\s+numero_conteo/i,
    `${archivoDef}: el número de conteo de cada foto tiene que contarse dentro del período (partition by ciclo_id)`);
});

test('reconteo es solo lo hecho desde Reconteo, y los conteos se numeran N.M', () => {
  // Joel, 14/10/2026: un segundo conteo cualquiera ya no se llama "reconteo". conteos.es_reconteo lo
  // marca la app al guardar desde Recontar; el Panel separa reconteos de repetidos, el Calendario
  // también, y las fotos traen "conteo" y "reconteo" para la etiqueta "Conteo 2.1".
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  const ultima = (re) => {
    let def = null, archivo = null;
    for (const a of fs.readdirSync(dirMig).sort()) {
      const sql = fs.readFileSync(path.join(dirMig, a), 'utf8').replace(/--[^\n]*/g, '');
      const m = re.exec(sql);
      if (m) { def = m[0]; archivo = a; }
    }
    return { def, archivo };
  };
  const vista = (nombre) => ultima(new RegExp(`create\\s+(?:or\\s+replace\\s+)?view\\s+public\\.${nombre}\\b[\\s\\S]*?;`, 'i'));
  for (const v of ['avance_diario', 'avance_semanal', 'avance_mensual']) {
    const { def, archivo } = vista(v);
    assert.ok(def, `no se encontró public.${v}`);
    assert.match(def, /security_invoker\s*=\s*true/i, `${archivo}: ${v} tiene que seguir con security_invoker`);
    assert.match(def, /count\(\*\)\s+filter\s*\(\s*where\s+c\.es_reconteo\s*\)\s+as\s+reconteos/i, `${archivo}: en ${v}, "reconteos" cuenta solo los marcados como reconteo`);
    assert.match(def, /as\s+repetidos/i, `${archivo}: ${v} tiene que traer "repetidos"`);
  }
  for (const v of ['skus_busqueda', 'reconteo_pendiente']) {
    const { def, archivo } = vista(v);
    assert.match(def, /security_invoker\s*=\s*true/i, `${archivo}: ${v} tiene que seguir con security_invoker`);
    assert.match(def, /'conteo',[\s\S]*?'reconteo',/, `${archivo}: las fotos de ${v} tienen que traer "conteo" y "reconteo"`);
  }
  const cal = ultima(/create\s+(?:or\s+replace\s+)?function\s+public\.resumen_calendario_dias\s*\([\s\S]*?\$function\$[\s\S]*?\$function\$/i);
  assert.ok(cal.def, 'no se encontró public.resumen_calendario_dias');
  assert.match(cal.def, /filter\s*\(\s*where\s+es_reconteo\s*\)\s+as\s+n_recontados/i, `${cal.archivo}: la R del Calendario cuenta solo reconteos`);
  // El ALTER TABLE que apaga los triggers para marcar el historial tiene que volver a encenderlos.
  for (const a of fs.readdirSync(dirMig)) {
    const sql = fs.readFileSync(path.join(dirMig, a), 'utf8').replace(/--[^\n]*/g, '');
    const apagados = [...sql.matchAll(/alter\s+table\s+public\.conteos\s+disable\s+trigger\s+(\w+)/gi)].map(m => m[1]).sort();
    const encendidos = [...sql.matchAll(/alter\s+table\s+public\.conteos\s+enable\s+trigger\s+(\w+)/gi)].map(m => m[1]).sort();
    assert.deepEqual(encendidos, apagados, `${a}: todo trigger de conteos que se apaga se vuelve a encender en la misma migración`);
  }
  const html = fs.readFileSync(path.join(RAIZ, 'app', 'index.html'), 'utf8');
  assert.match(html, /es_reconteo: esReconteoDelSkuActual\(\)/, 'la app tiene que marcar es_reconteo al guardar desde Recontar');
  assert.match(html, /rest\('\/rpc\/resumen_calendario_dias'/, 'el Calendario tiene que pedir resumen_calendario_dias');
});

test('la diferencia de un conteo es una foto: modificarlo no la recalcula con el stock de hoy', () => {
  // Joel, 14/10/2026: calcular_diferencia_conteo recalculaba en cada UPDATE contra el stock actual,
  // así que cerrar por ERP, descartar o renombrar una ubicación reescribía la merma (en el ensayo,
  // una merma de -1 pasó a -127). Un conteo nuevo se calcula contra el stock actual; un UPDATE sin
  // cambio de cantidad no la toca; una corrección se mide contra el stock del día del conteo.
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let def = null, archivoDef = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    const m = /create\s+(?:or\s+replace\s+)?function\s+public\.calcular_diferencia_conteo\s*\([\s\S]*?\$function\$[\s\S]*?\$function\$/i.exec(sql);
    if (m) { def = m[0]; archivoDef = archivo; }
  }
  assert.ok(def, 'no se encontró public.calcular_diferencia_conteo en las migraciones');
  assert.match(def, /tg_op\s*=\s*'UPDATE'[\s\S]*?new\.cantidad_contada\s+is\s+not\s+distinct\s+from\s+old\.cantidad_contada[\s\S]*?return\s+new/i,
    `${archivoDef}: un UPDATE que no cambia la cantidad tiene que dejar la diferencia como estaba`);
  assert.match(def, /new\.cantidad_contada\s*-\s*\(\s*old\.cantidad_contada\s*-\s*old\.diferencia\s*\)/i,
    `${archivoDef}: corregir la cantidad se mide contra el stock que había al contar (cantidad anterior - diferencia anterior)`);
  assert.doesNotMatch(def, /security\s+definer/i, `${archivoDef}: el trigger no necesita SECURITY DEFINER`);
});

test('un operador no escribe el plan, las cargas ni los responsables, y en skus solo código de barras y ubicación', () => {
  // Joel, 22/10/2026: las reglas solo pedían ser de la empresa, así que un operador -- o el visitante
  // de la demo pública -- podía saltarse la app y cambiar stock, costo o el plan por la API.
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  const archivos = fs.readdirSync(dirMig).sort();
  const sqlDe = a => fs.readFileSync(path.join(dirMig, a), 'utf8').replace(/--[^\n]*/g, '');
  const politicas = [
    ['plan_semanal', 'auth_write_plan_semanal'], ['plan_semanal', 'auth_update_plan_semanal'], ['plan_semanal', 'auth_delete_plan_semanal'],
    ['plan_semanal_exclusiones', 'auth_insert_plan_semanal_exclusiones'], ['plan_semanal_exclusiones', 'auth_delete_plan_semanal_exclusiones'],
    ['plan_semanal_incluidos', 'auth_insert_plan_semanal_incluidos'], ['plan_semanal_incluidos', 'auth_delete_plan_semanal_incluidos'],
    ['plan_semanal_skus', 'auth_insert'], ['plan_semanal_skus', 'auth_delete'],
    ['cargas_masivas', 'auth_all_cargas'],
    ['responsables_proceso', 'auth_insert_responsables_proceso'], ['responsables_proceso', 'auth_update_responsables_proceso'],
  ];
  for (const [tabla, nombre] of politicas) {
    const re = new RegExp(`(?:create|alter)\\s+policy\\s+"?${nombre}"?\\s+on\\s+(?:public\\.)?${tabla}\\b[^;]*;`, 'gi');
    let def = null, archivo = null;
    for (const a of archivos) for (const m of sqlDe(a).matchAll(re)) { def = m[0]; archivo = a; }
    assert.ok(def, `no se encontró la regla ${nombre} de ${tabla}`);
    assert.match(def, /es_admin_actual\(\)[\s\S]*es_super_admin\(\)/i, `${archivo}: ${nombre} (${tabla}) tiene que exigir administrador o súper admin`);
  }
  let fn = null, archivoFn = null;
  for (const a of archivos) {
    const m = /create\s+(?:or\s+replace\s+)?function\s+public\.skus_limita_edicion_directa\s*\([\s\S]*?\$function\$[\s\S]*?\$function\$/i.exec(sqlDe(a));
    if (m) { fn = m[0]; archivoFn = a; }
  }
  assert.ok(fn, 'no se encontró public.skus_limita_edicion_directa');
  assert.match(fn, /request\.path/, `${archivoFn}: solo mira los pedidos directos a /skus`);
  assert.match(fn, /es_admin_actual\(\)[\s\S]*es_super_admin\(\)/i, `${archivoFn}: administradores y súper admin quedan libres`);
  const libres = /n\.key\s+not\s+in\s*\(([^)]*)\)/i.exec(fn);
  assert.ok(libres, `${archivoFn}: falta la lista de columnas que un operador puede cambiar`);
  const columnas = libres[1].match(/'[^']+'/g).map(c => c.slice(1, -1)).sort();
  assert.deepEqual(columnas, ['batch_key', 'bodega', 'bodega_key', 'codigo_barras', 'storage_bin', 'storage_bin_key', 'ubicacion', 'ubicacion_key', 'updated_at'],
    `${archivoFn}: un operador solo puede cambiar código de barras y ubicación (más lo que la base calcula sola)`);
  assert.doesNotMatch(fn, /security\s+definer/i, `${archivoFn}: el trigger no necesita SECURITY DEFINER`);
  const todo = archivos.map(sqlDe).join('\n');
  assert.match(todo, /create\s+trigger\s+trg_skus_limita_edicion_directa\s+before\s+update\s+on\s+public\.skus/i, 'falta el trigger en skus');
  assert.doesNotMatch(todo, /(drop|disable)\s+trigger\s+(if\s+exists\s+)?trg_skus_limita_edicion_directa/i, 'ninguna migración apaga el trigger');
  // Lo que la app le deja hacer a un operador sobre /skus directo: asociar el código de barras y
  // cambiar la ubicación (Bodega > Ubicación). Si aparece otra columna, hay que agregarla arriba.
  const html = fs.readFileSync(path.join(RAIZ, 'app', 'index.html'), 'utf8');
  assert.match(html, /rest\(`\/skus\?id=eq\.\$\{skuId\}`, \{method:'PATCH', body:\{codigo_barras: codigo\}/, 'el escáner asocia solo codigo_barras');
  assert.match(html, /const destino = \{\s*bodega:[^\n]*\n\s*ubicacion:[^\n]*\n\s*storage_bin:[^\n]*\n\s*\};/, 'cambiar de ubicación manda solo bodega, ubicacion y storage_bin');
});

test('la demo pública se restablece con costo en sus materiales y su clase ABC', () => {
  // Joel, 22/10/2026: resetear_demo_inventia cargaba los 24 materiales sin costo, y quien probaba la
  // demo veía el Panel sin valorización ni A/B/C.
  const sql = fs.readFileSync(path.join(RAIZ, 'supabase', 'migrations', '20261022_demo_con_costos.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const codigos = [...sql.matchAll(/\('([A-Z]{3}-\d{4})',\s*(\d+)\)/g)];
  assert.equal(codigos.length, 24, 'los 24 materiales de la demo llevan costo');
  assert.ok(codigos.every(m => Number(m[2]) > 0), 'cada costo es mayor que cero');
  assert.match(sql, /codigo_barras, costo_unitario\) values/, 'el insert de la demo incluye costo_unitario');
  assert.match(sql, /perform privado\.recalcular_abc_empresa\(v_empresa_id\)/, 'el reset recalcula la clase ABC de la demo');
  assert.match(sql, /raise exception/, 'si la función no tiene el texto esperado, la migración falla sin cambiar nada');
});

test('ubicaciones tiene una sola regla de lectura y conteos.corregido_por tiene índice', () => {
  // Advisor de rendimiento, 22/10/2026: admin_write_ubicaciones era FOR ALL y también contaba como
  // lectura (dos reglas por cada SELECT), y la llave foránea conteos.corregido_por no tenía índice.
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  const todo = fs.readdirSync(dirMig).sort().map(a => fs.readFileSync(path.join(dirMig, a), 'utf8').replace(/--[^\n]*/g, '')).join('\n');
  assert.match(todo, /drop\s+policy\s+(if\s+exists\s+)?admin_write_ubicaciones\s+on\s+public\.ubicaciones/i, 'la regla FOR ALL de ubicaciones se reemplaza');
  for (const accion of ['insert', 'update', 'delete']) {
    const re = new RegExp(`create\\s+policy\\s+admin_${accion}_ubicaciones\\s+on\\s+public\\.ubicaciones\\s+for\\s+${accion}\\b[^;]*es_admin_actual\\(\\)`, 'i');
    assert.match(todo, re, `ubicaciones: ${accion} sigue siendo solo de administrador`);
  }
  const ultimaAll = [...todo.matchAll(/create\s+policy\s+"?(\w+)"?\s+on\s+public\.ubicaciones\s+for\s+all\b/gi)].map(m => m[1]);
  const borradas = new Set([...todo.matchAll(/drop\s+policy\s+(?:if\s+exists\s+)?"?(\w+)"?\s+on\s+public\.ubicaciones/gi)].map(m => m[1]));
  assert.deepEqual(ultimaAll.filter(n => !borradas.has(n)), [], 'ninguna regla FOR ALL en ubicaciones (cuenta también como lectura)');
  assert.match(todo, /create\s+index\s+(if\s+not\s+exists\s+)?conteos_corregido_por_idx\s+on\s+public\.conteos\s*\(\s*corregido_por\s*\)/i, 'conteos.corregido_por lleva índice');
});
