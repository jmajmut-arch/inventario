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
