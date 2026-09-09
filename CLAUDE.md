# InventIA — reglas del proyecto

App web multiempresa (SaaS) de conteo cíclico de inventario y bodega, en producción en
[inventiapp.cl](https://inventiapp.cl). La usan empresas reales con datos reales.

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

## Base de datos

- **Un select que pide una columna inexistente no falla suave**: PostgREST rechaza la consulta
  entera con un 400. Si el código trata ese error como "sin datos", un fallo del servidor se
  vuelve indistinguible de un resultado vacío. Pasó de verdad: el buscador de Ingreso pidió
  `tipo_material` a `skus_lectura`, que no lo exponía, y un material existente aparecía como
  inexistente. Por eso existe `tests/esquema.test.js`; **tras cada migración que agregue o quite
  columnas hay que actualizar `tests/esquema-supabase.json`**.
- **Agregar una columna a una tabla no la agrega a las vistas que la leen.** Revisar
  `skus_lectura`, `stock_actual`, `movimientos_bodega_detalle` y las que correspondan.
- **El costo suele ser la cantidad de idas y vueltas, no la consulta.** El Dashboard tardaba con
  14 consultas de 2 a 73 ms cada una: lo caro era que fueran 14 (cada una con su preflight CORS,
  su verificación de token y su turno en el pool) y que la pantalla no mostrara nada hasta la
  última. Antes de optimizar una consulta, contar cuántas llamadas hace la pantalla. Cuando se
  junten varias en una función, verificar que el JSON nuevo sea idéntico al que armaban las
  consultas originales, con datos reales, antes de tocar la app.
- **Medir con datos reales, no con la demo.** Escondida tiene más de 63.000 materiales; lo que
  funciona con 9 filas puede superar el `statement_timeout` de 8 s del rol `authenticated`. Toda
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

## Datos y ambientes

- Empresas en producción: **Escondida** (63.000 materiales), **Minera Test** y **Demo InventIA**
  (pública, se restablece cada noche con `resetear_demo_inventia`).
- **No crear cuentas de administrador ni empresas nuevas** sin pedirlo.
- El módulo de bodega se activa por empresa desde súper admin. Diseño en
  `docs/DISENO-MODULO-BODEGA.md`.

## Documentación

Los manuales se editan en `docs/src-manuales/*.html` y se regeneran con `render.py`
(`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). Verificar que ninguna página
desborde antes de regenerar los PDF.
