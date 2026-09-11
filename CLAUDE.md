# InventIA — reglas del proyecto

App web multiempresa (SaaS) de conteo cíclico de inventario y bodega, desplegada en
[inventiapp.cl](https://inventiapp.cl) y en uso real, con datos reales, aunque todavía sin
clientes pagando. Se va a empezar a vender a empresas distintas, de rubros y datos distintos.

## Regla que manda sobre todas

**Ningún cambio puede degradar el funcionamiento, el rendimiento ni la seguridad de lo que ya
está en producción.** Una funcionalidad nueva que rompe una existente es una pérdida neta, no un
avance. Ante la duda entre entregar rápido y no romper nada, no romper nada gana.

Esto no es una aspiración: es el criterio con el que se acepta o se rechaza un cambio.

## Antes de publicar cualquier cambio

1. **Pruebas**: `node tests/app.test.js`, `node --test tests/esquema.test.js` y las e2e
   (`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node tests/e2e.test.js`).
   Todo en verde, sin excepciones. Cada corrección de un error real lleva su prueba de regresión.
2. **Espejo**: `app/index.html` y `app/inventario.html` son la misma app servida en dos rutas.
   Copiar una sobre la otra (`cp app/index.html app/inventario.html`) y verificar con `diff`.
3. **Revisión visual** a 420 px de ancho: la mitad del uso es en celular, en terreno.
4. **Advisor de seguridad de Supabase** después de cada migración (`get_advisors`), comparando
   contra los hallazgos ya conocidos e intencionales.
5. **`select * from gucs_invalidos_en_funciones();`** después de cada migración que toque
   funciones. Debe devolver cero filas.

## Base de datos

- **Un select que pide una columna inexistente no falla suave**: PostgREST rechaza la consulta
  entera con un 400. Si el código trata ese error como "sin datos", un fallo del servidor se
  vuelve indistinguible de un resultado vacío. Pasó de verdad: el buscador de Ingreso pidió
  `tipo_material` a `skus_lectura`, que no lo exponía, y un material existente aparecía como
  inexistente. Por eso existe `tests/esquema.test.js`; **tras cada migración que agregue o quite
  columnas hay que actualizar `tests/esquema-supabase.json`**.
- **El rol que manda es `authenticator`, no `authenticated`.** PostgREST se conecta como
  `authenticator` (confirmado en `pg_stat_activity`: `application_name = 'PostgREST 14.5'`) y recién
  ahí hace `SET ROLE authenticated` por request. Postgres carga el `rolconfig` **al conectarse**, y
  un `SET ROLE` posterior **no** recarga el del rol destino: comprobado, después de
  `set role authenticated` el `work_mem` sigue siendo el de la sesión (5MB) y no los 16MB puestos en
  ese rol. Todo lo que se configure en `authenticated` o en `anon` es decorativo. Ya pasó: subir el
  `statement_timeout` de `authenticated` no arregló nada y hubo que rehacerlo sobre `authenticator`.
- **Un `set` de parámetro dentro del cuerpo de una función no se valida al crearla.** Postgres sí
  rechaza el valor malo en `alter role`, en `alter database` y en la cláusula `SET` de una función,
  pero dentro del cuerpo es texto que recién interpreta al ejecutarlo: la función se crea sin
  chistar y falla en **cada** llamada. Pasó de verdad: `set local work_mem = '16mb'` (las unidades
  distinguen mayúsculas, va `16MB`) devolvió 400 a un usuario en terreno durante 4 minutos, y no lo
  detectó ninguna migración ni advisor — se supo por Sentry (JAVASCRIPT-7). Por eso existe
  `gucs_invalidos_en_funciones()`, que prueba cada valor de verdad y devuelve los que Postgres
  rechazaría.
- **Agregar una columna a una tabla no la agrega a las vistas que la leen.** Revisar
  `skus_lectura`, `stock_actual`, `movimientos_bodega_detalle` y las que correspondan.
- **El costo suele ser la cantidad de idas y vueltas, no la consulta.** El Dashboard tardaba con
  14 consultas de 2 a 73 ms cada una: lo caro era que fueran 14 (cada una con su preflight CORS,
  su verificación de token y su turno en el pool) y que la pantalla no mostrara nada hasta la
  última. Antes de optimizar una consulta, contar cuántas llamadas hace la pantalla. Cuando se
  junten varias en una función, verificar que el JSON nuevo sea idéntico al que armaban las
  consultas originales, con datos reales, antes de tocar la app.
- **Medir con datos reales, no con la demo.** Escondida tiene más de 63.000 materiales; lo que
  funciona con 9 filas puede superar el `statement_timeout` de 20 s del rol `authenticator`. Toda
  operación masiva va por lotes, con avance visible. Medir con `EXPLAIN (ANALYZE)` o cronometrando
  dentro de una transacción que se revierte.
- **RLS siempre**: cada empresa ve solo lo suyo. Las vistas nuevas llevan `security_invoker=true`;
  las funciones nuevas evitan `SECURITY DEFINER` salvo que haya una razón explícita, y en ese caso
  se les revoca `EXECUTE` a `public` y `anon` y se les fija `search_path`.
- **Nunca borrar ni purgar datos sin preguntar antes.**

## Manejo de errores en la app

Un error del servidor debe verse como un error, con su mensaje. Nunca disfrazarlo de estado vacío
ni tragárselo en un `catch` silencioso: eso convierte un problema visible en uno que el usuario
interpreta mal y sobre el que actúa equivocado.

## Escribir en un campo mientras la pantalla se repinta

`render()` rehace el DOM entero. Conservar el foco no basta: si el `<input>` se **reemplaza**, iOS
enfoca un elemento nuevo y **reinicia el teclado a la disposición de letras**. Tecleando un código
como 10371892 eso obliga a apretar "123" en cada dígito. Pasó de verdad en Crear orden de compra:
medido, al teclear 8 caracteres el input se reemplazaba las 8 veces.

Por eso un buscador que se dispara mientras se escribe **no llama a `render()`**: repinta solo su
contenedor de resultados y vuelve a atar sus botones
(`actualizarResultadosBuscadorLibreEnPantalla` en Inventario, `actualizarResultadosSkuBodega` en
Bodega). Lo que la persona haya tecleado en otros campos se guarda al estado antes de repintar.

## Datos y ambientes

- **Escondida** (63.000 materiales) es uso real: es donde trabaja Joel y la usan todos los días,
  pero no es un cliente. **Minera Test** y **Demo InventIA** son demos; la segunda es pública y se
  restablece cada noche con `resetear_demo_inventia`.
- Que no haya clientes pagando **no** relaja la regla de no romper nada: los datos de Escondida son
  reales y el trabajo de terreno depende de ellos.
- **Lo que se construye es el sistema, no la empresa.** Nada puede depender del nombre de una
  empresa ni de la forma de sus datos. Lo que varíe entre empresas va en la base (columna de
  `empresas`, interruptor, catálogo), con un default que preserve el comportamiento de hoy. Las
  listas que ofrece la app (tipos de material, unidades) son sugerencias: si una empresa trae las
  suyas en su Excel, hay que conservarlas y mostrarlas. Pendientes abiertos de esta clase: #428
  (IVA fijo en 19%) y #429 (tipos de material propios).
- **No crear cuentas de administrador ni empresas nuevas** sin pedirlo.
- El módulo de bodega se activa por empresa desde súper admin. Diseño en
  `docs/DISENO-MODULO-BODEGA.md`.

## Documentación

Los manuales se editan en `docs/src-manuales/*.html` y se regeneran con `render.py`
(`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). Verificar que ninguna página
desborde antes de regenerar los PDF.
