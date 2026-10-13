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
