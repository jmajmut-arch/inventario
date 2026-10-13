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

// skus_valor_abc lee solo la clasificación ABC de la empresa del usuario. Antes la vista
// materializada no tenía empresa_id y cada lectura (resumen ABC del Dashboard, pagina_skus)
// recorría las ~182.000 filas de todas las empresas (20261013_abc_por_empresa.sql). Además, la
// vista, el refresco nocturno y refrescar_clasificacion_abc() tienen que usar la misma vista
// materializada: si uno queda apuntando a otra, la clasificación que se ve deja de actualizarse.
test('la clasificación ABC se lee por empresa y se refresca la misma vista materializada que se lee', () => {
  const dirMig = path.join(RAIZ, 'supabase', 'migrations');
  let vista = null, funcion = null, cron = null;
  for (const archivo of fs.readdirSync(dirMig).sort()) {
    const sql = fs.readFileSync(path.join(dirMig, archivo), 'utf8').replace(/--[^\n]*/g, '');
    const v = /create\s+or\s+replace\s+view\s+public\.skus_valor_abc\b[\s\S]*?;/i.exec(sql);
    if (v) vista = { archivo, def: v[0] };
    const f = /create\s+or\s+replace\s+function\s+public\.refrescar_clasificacion_abc\s*\(\)[\s\S]*?\$\$[\s\S]*?\$\$/i.exec(sql);
    if (f) funcion = { archivo, def: f[0] };
    const c = /cron\.schedule\(\s*'refrescar-clasificacion-abc-nocturno'[\s\S]*?\);/i.exec(sql);
    if (c) cron = { archivo, def: c[0] };
  }
  assert.ok(vista && funcion && cron, 'faltan en las migraciones la vista skus_valor_abc, refrescar_clasificacion_abc o el refresco nocturno');
  assert.match(vista.def, /security_invoker\s*=\s*true/i, `${vista.archivo}: skus_valor_abc tiene que ser security_invoker`);
  assert.match(vista.def, /mv\.empresa_id\s*=\s*\(\s*select\s+public\.empresa_actual\(\)\s*\)/i, `${vista.archivo}: skus_valor_abc no filtra la vista materializada por empresa`);
  const mv = /join\s+(privado\.\w+)/i.exec(vista.def)[1];
  assert.match(funcion.def, new RegExp(`refresh\\s+materialized\\s+view\\s+concurrently\\s+${mv.replace('.', '\\.')}\\b`, 'i'), `${funcion.archivo}: refrescar_clasificacion_abc no refresca ${mv}, que es la que lee skus_valor_abc`);
  assert.match(cron.def, new RegExp(`${mv.replace('.', '\\.')}\\b`, 'i'), `${cron.archivo}: el refresco nocturno no refresca ${mv}, que es la que lee skus_valor_abc`);
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
