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
- **En una función, `empresa_actual()` o `ciclo_actual()` a secas se evalúan fila por fila.** Son
  STABLE y SECURITY DEFINER (no se inlinean): escritas en un WHERE o un JOIN como
  `c.ciclo_id = ciclo_actual()`, Postgres las llama por cada fila que examina. Envueltas en
  `(select ciclo_actual())` se evalúan una vez por consulta. Las vistas y las políticas ya venían
  así; el 29/09/2026 se corrigieron siete funciones de lectura (ranking_responsable pasó de 185 a
  ~5 ms; el Dashboard de 0,56 a 0,41 s; resumen_plan_grupos de 224 a 121 ms). Toda función nueva
  que las use en un filtro va con `(select ...)`.
- **Una función `LANGUAGE sql` con `SET search_path` se planifica a ciegas.** No se inlinea, y su
  cuerpo se planifica sin conocer los parámetros: con una lista (`id = any(p_ids)`) Postgres elige un
  plan pensado para cualquier lista. Pasó de verdad: `skus_universo_entrada_plan_lote` tardaba 2,7-3 s
  con las ~300-400 entradas de un período de Escondida, y la misma consulta con la lista conocida,
  130 ms; Grupos esperaba 2,9 s en cada visita. Se arregló el 22/10/2026 pasándola a plpgsql con
  `RETURN QUERY EXECUTE ... USING`, que planifica cada llamada con la lista real. Para medir una
  función así, compararla contra una copia en `pg_temp` dentro de una transacción que se revierte,
  no contra su cuerpo pegado a mano (ese sí conoce los valores y engaña).
- **Un `NOT EXISTS` contra una vista con `DISTINCT ON` puede reordenarla por cada fila.**
  `skus_planificables` sacaba los ya contados preguntando a `ultimo_conteo_por_sku`; cuando
  Postgres creía que una rama traía pocas filas elegía un nested loop y reordenaba los ~2.300 conteos
  del período por cada material. Pasó de verdad: con un plan que abarca ubicaciones o bodegas
  completas, `skus_disponibles_planificar` y las listas de ubicaciones tardaban 32 s (picos de 8-10 s
  en producción desde el 13/10, cuando el plan de Escondida tuvo más de mil entradas). Preguntado
  directo a `conteos` (índice por `sku_id`) bajó a 0,7-0,9 s (`20261024_planificables_sin_reordenar_conteos.sql`).
  Para saber si algo existe, se pregunta a la tabla con índice, no a una vista que ordena. Y una
  vista que hoy va rápido puede no ir con el plan de mañana: medirla con un plan grande simulado
  dentro de una transacción que se revierte.
- **Un trigger por fila paga cada llamada, y en un upsert corre dos veces.** Una tanda de carga
  (2.000 materiales, `POST /skus` con `on_conflict`) tardaba 933 ms y el 79% eran triggers:
  `trg_skus_limita_edicion_directa` preguntaba "¿es administrador?" por cada fila (510 ms) y
  `trg_limite_bodegas` bloqueaba la empresa y leía su plan 4.000 veces (al proponer la inserción y al
  convertirla en actualización). Desde `20261024_carga_masiva_triggers_por_fila.sql` el primero
  recuerda la respuesta por transacción y usuario y el segundo sale si la bodega no cambia o ya
  existe: 337 ms. Un trigger nuevo por fila sobre `skus` o `conteos` se mide con una tanda real
  (EXPLAIN ANALYZE muestra el tiempo de cada trigger) y lo que no cambia por fila se pregunta una vez.
- **Dos llaves entre las mismas tablas hacen ambiguo el embebido.** `conteos.sku_id` apunta a
  `skus` y `skus.ultimo_conteo_id` apunta a `conteos`: `conteos?select=...,skus(...)` responde 300
  (PGRST201) en vez de los datos. Pasó de verdad: "Cerrados sin recontar" y el aviso de
  "Reemplazar completo" nunca funcionaron en producción, y las pruebas con red simulada no lo
  veían. Se escribe `skus!conteos_sku_id_fkey(...)`; `tests/esquema.test.js` lo revisa. Una llave
  foránea nueva entre dos tablas que ya se embeben obliga a revisar los embebidos de ambas.
- **Agregar un parámetro a una función no la reemplaza: crea otra con el mismo nombre.**
  `create or replace` con un parámetro más (aunque tenga default) deja las dos, y PostgREST no sabe
  a cuál llamar si los argumentos que manda la app calzan con ambas. La versión anterior se renombra
  (`alter function ... rename to ..._obsoleta`) y se le revoca `EXECUTE`, como en
  `20261022_plan_bins_dueno_y_codigos_exactos.sql`. **La otra salida, igual de válida:** que la
  nueva tenga todos sus parámetros obligatorios y la de siempre quede como envoltorio que la llama.
  Así están `contar_busqueda_skus`, `filas_busqueda_skus` y `resumen_busqueda_skus`
  (`20261021_duenos_stock_filtros.sql`): sin filtro de dueño la app manda los parámetros de siempre
  y entra por el envoltorio. **Esos envoltorios no se borran ni se les quita el permiso**: Buscar
  dejaría de funcionar en todas las empresas, incluso en celulares con una versión vieja guardada.
- **Una llave `ON DELETE SET NULL` actúa antes que los triggers AFTER de la tabla borrada.**
  `skus.ultimo_conteo_id` apunta a `conteos` con `SET NULL`: al borrar el único conteo de un
  material, la llave ya lo dejó en null cuando corre `trg_sincronizar_ultimo_conteo_sku`, y la
  limpieza que exigía `ultimo_conteo_id is not null` no hacía nada. Pasó de verdad: el 26/10/2026
  Joel borró una prueba y el material siguió "contado: 48, aprobado" (había otro igual desde el
  03/09). Desde `20261026_ultimo_conteo_se_limpia_al_borrar.sql` la limpieza mira también la fecha.
  Un trigger que repare columnas copiadas no puede confiar en la llave que la base ya tocó.
- **Agregar una columna a una tabla no la agrega a las vistas que la leen.** Revisar
  `skus_lectura`, `stock_actual`, `movimientos_bodega_detalle` y las que correspondan.
- **El costo suele ser la cantidad de idas y vueltas, no la consulta.** El Dashboard tardaba con
  14 consultas de 2 a 73 ms cada una: lo caro era que fueran 14 (cada una con su preflight CORS,
  su verificación de token y su turno en el pool) y que la pantalla no mostrara nada hasta la
  última. Lo mismo en SKU: nueve llamadas, dos de ellas a `ubicaciones_generales` (400 ms cada
  una en Escondida); quedaron en dos (`pagina_skus` por página, `catalogos_pantalla_skus` una vez
  por sesión). Antes de optimizar una consulta, contar cuántas llamadas hace la pantalla. Cuando se
  junten varias en una función, verificar que el JSON nuevo sea idéntico al que armaban las
  consultas originales, con datos reales, antes de tocar la app.
- **Medir con datos reales, no con la demo.** Escondida tiene más de 63.000 materiales; lo que
  funciona con 9 filas puede superar el `statement_timeout` de 20 s del rol `authenticator`. Toda
  operación masiva va por lotes, con avance visible. Medir con `EXPLAIN (ANALYZE)` o cronometrando
  dentro de una transacción que se revierte.
- **Una prueba de carga no termina cuando termina k6: revisar la base después.** El 13/10/2026,
  al saturarse el nivel de 500 personas, inserciones de conteos de `__CARGA_1__` y `__CARGA_2__`
  sobre el mismo material entraron en deadlock (en `sincronizar_ultimo_conteo_sku`, al actualizar
  `skus`). Las mismas 15 conexiones de PostgREST siguieron repitiéndolas, sin ninguna petición
  nueva, durante 87 minutos (12:40 a 14:07 UTC): dos deadlocks por segundo, 15 de las 16
  conexiones del pool ocupadas, y las migraciones de ese rato no conseguían su bloqueo. Se cortó
  con `pg_terminate_backend` sobre esas conexiones (inserciones que nunca se confirmaron; no se
  perdió nada). Tras cada prueba: `pg_stat_activity` sin transacciones activas viejas y
  `postgres_logs` sin "deadlock detected". Las migraciones llevan `set local lock_timeout`, para
  fallar en segundos en vez de quedar esperando detrás de algo así.
- **Protección contra sobrecarga.** La segunda prueba de carga del 13/10/2026 botó la base
  (Small: 2 GB) con 750 personas: ≈1,5 min sin servicio para todas las empresas. Desde
  `20261013_proteccion_sobrecarga.sql`:
  - `public.dashboard_ejecutivo` es solo una puerta: máximo 3 Dashboards calculando, 6 dentro
    contando a los que esperan (hasta 8 s). Con más, falla al instante con un error visible (503).
    **El cálculo vive en `privado.dashboard_ejecutivo_calculo`: los cambios al Dashboard van
    ahí**, no en la puerta.
  - Cada conteo toma un turno por material (`trg_conteos_turno_sku`, advisory lock) antes de tocar
    `skus`, para que dos conteos del mismo material no entren en deadlock.
  - Claves de advisory locks en uso: 74100, 74101, 74102 y 74103 (recálculo ABC por empresa,
    `privado.recalcular_abc_empresa`). Una función nueva que use advisory locks elige otra.
  - **Lo que la protección no resuelve:** la tercera prueba del 13/10/2026, ya con la
    protección, no tuvo deadlocks (antes 211 y 116) y el Dashboard quedó limitado, pero la base
    igual se cayó con 500 personas (≈2 min). El techo lo pone el tamaño del servidor, no el
    código: en el plan Small se promete con holgura 300 personas contando a la vez (≈40
    empresas). Joel decidió subir el plan cuando haya más clientes. **Hasta entonces, ninguna
    prueba de carga en producción sobre 400 personas:** cada caída deja sin servicio a todas
    las empresas. Resultados de las tres pruebas en `docs/pruebas-carga/`.
- **Los buscadores comparan con `ilike`, no con `position()` ni `lower() like`.** `skus` tiene
  índices GIN de trigramas en `sku_code`, `descripcion`, `batch` y `storage_bin` (extensión
  `pg_trgm`, esquema `extensions`), y solo `ilike` los usa: `position()` obliga a leer el maestro
  completo. Dos cosas más que hay que saber: con **menos de 3 caracteres** no hay trigrama y
  Postgres recorre la tabla igual (la app exige 2, así que ese caso sigue costando lo de antes, no
  más); y si un `or=(...)` incluye una columna **sin** índice de trigramas, Postgres descarta el
  plan por índice y recorre la tabla completa igual — por eso están las cuatro columnas y no solo
  dos. El costo está del lado de la escritura: insertar materiales es un 41% más lento (una carga
  de 63.000 tarda unos 4 s más); actualizar stock no cambia, porque el índice no se toca si el
  texto no cambia.
- **Bajo RLS, `ilike` no usa el índice de trigramas aunque exista.** Postgres no considera
  *leakproof* a `ILIKE`, así que con una política activa aplica primero la política (empresa) y
  recién después el texto: recorre todo el maestro de la empresa. Medido el 29/09/2026 en Escondida
  por `pg_stat_statements`: 2.282 búsquedas de Contar a 177 ms de promedio y hasta 3 s, con
  `skus_descripcion_trgm_idx` usado 28 veces en tres semanas. La medición "355 -> 4 ms" que había
  acá se hizo sin RLS y no valía en producción. Por eso los buscadores por texto (Contar, Bodega,
  Mover, Planificación por código, candidatos de grupo) van por `buscar_skus_lectura`, SECURITY
  DEFINER con filtro explícito por `empresa_actual()`, que sí usa los trigramas: ~20 ms por
  búsqueda. Una consulta directa a `skus_lectura` con `or=(sku_code.ilike...)` vuelve al recorrido
  completo, aunque la prueba unitaria pase.
- **Un texto que aparece poco engaña al planificador.** Aun dentro de `buscar_skus_lectura`, con
  `order by sku_code limit 8` Postgres elegía recorrer el maestro en orden de código cuando creía
  que el texto era común, y si no lo era ("PERNO": 5 de 81.000 en Escondida) revisaba todo:
  315-355 ms por búsqueda. Lo destapó la prueba de carga del 13/10/2026 (el buscador fue el 45% del
  trabajo de la base). Desde `20261013_buscar_skus_lectura_texto_raro.sql` mira primero 1.000
  materiales en orden y, si el texto resulta raro, busca por trigramas con `offset 0` para separar
  la búsqueda del orden: promedio de 129 a 35 ms en Escondida. Un buscador nuevo con
  `order by ... limit` sobre un `ilike` tiene el mismo riesgo: medirlo con textos que no existen.
- **Una URL de más de ~24.000 caracteres no llega a la base.** Medido el 13/10/2026 contra el
  proyecto real (pg_net, URLs crecientes): hasta ~24.000 pasa; desde ~25.000 la puerta de Supabase
  responde 400 "Bad Request" sin cabeceras CORS, el navegador lo ve como "sin conexión" y no queda
  nada en los logs de la API. Pasó de verdad: Contar pedía los 723 SKU de la foto del plan de un
  día con sus id en un `in.(...)` (~27.000 caracteres) y la lista quedó en "Cargando…". Toda lista
  que vaya a un `in.(...)` y pueda crecer con los datos va por tandas (`restEnTandas`, de a 100 id o
  de a 500 códigos; `escribirPlanEnTandas` para escrituras del plan). Listas grandes que no son
  filtros (exclusiones, códigos de un plan) van en el cuerpo de un RPC, nunca en la URL.
- **RLS siempre**: cada empresa ve solo lo suyo. Las vistas nuevas llevan `security_invoker=true`;
  las funciones nuevas evitan `SECURITY DEFINER` salvo que haya una razón explícita, y en ese caso
  se les revoca `EXECUTE` a `public` y `anon` y se les fija `search_path`.
- **Qué ve un súper admin, exactamente.** Ve filas de **otras** empresas en tres relaciones, y solo
  tres: `usuarios` y `flow_eventos`, que necesita para administrar cuentas y cobros, y `tickets`
  (los problemas reportados desde la app, para responderlos; Joel lo decidió el 21/10/2026), más las
  fotos de esos reportes en `<empresa>/tickets/`. En todas las demás (materiales, conteos,
  movimientos, órdenes, reservas, planes, stock y auditoría) ve únicamente lo de su propia empresa,
  igual que cualquiera. Hasta el 23/09/2026 también leía la
  `auditoria` de todos los clientes (4.090 filas ajenas medidas ese día); Joel decidió cerrarlo y
  la política `auditoria_select` quedó solo por `empresa_actual()`. Si alguna vez hace falta ver la
  auditoría de un cliente para soporte, se hace con su permiso y desde su propia cuenta, no
  abriendo la política. Un usuario normal no ve nada ajeno en ninguna relación.
- **Qué escribe un operador, exactamente** (desde `20261022_operadores_escritura_acotada.sql`; el
  visitante de la demo pública es operador). Plan y sus tablas hijas, `cargas_masivas` y
  `responsables_proceso` solo los escribe un administrador o súper admin. En `skus`, un pedido
  directo a `/skus` de un operador solo puede cambiar `codigo_barras`, `bodega`, `ubicacion` y
  `storage_bin` (trigger `trg_skus_limita_edicion_directa`, que mira `request.path`); crear materiales
  sigue abierto, y las funciones (`/rpc/...`) y los triggers de otros pedidos no pasan por esa
  revisión. **Si una pantalla nueva deja a un operador cambiar otra columna de `skus` directo, hay
  que agregarla al trigger** (y a la prueba de `tests/esquema.test.js`), o hacerlo por una función.
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
- **Las Edge Functions viven en `supabase/functions/`** y se despliegan desde ahí (su README dice
  cómo y cuáles van con `--no-verify-jwt`). Un cambio hecho en el dashboard que no vuelva al repo
  se pierde en la siguiente restauración. El respaldo de datos y fotos es `docs/respaldo/respaldo.sh`.

## Impresión y PDF

- **Todo lo impreso va en papel carta** (`@page{size:letter;margin:12mm}`): es lo que se usa en
  Chile y lo que imprime el iPad.
- **Un documento con maqueta fija (N por hoja) no se hace con `window.print()`.** Medido en tres
  PDF reales del iPad de Joel: iOS imprime con sus propios márgenes y su pie (deja ~240 mm útiles
  en carta), maqueta la página al ancho de su ventana y la **escala** para llenar el papel (fichas
  de 74 mm salieron de 86-90), y sus `vw` son los de la ventana, no los del papel. Ninguna medida
  en mm, px ni vw sobrevive a eso. Las fichas de Buscar las arma la app con pdf-lib
  (`app/lib/pdf-lib.min.js`, MIT, cargado recién al exportar y guardado en el shell del service
  worker): `generarPdfFichasBusqueda` escribe cada página punto por punto y sale igual en cualquier
  dispositivo. Lo que sí se imprime desde HTML (comprobantes, orden de compra, hoja de conteo,
  informes) es contenido que fluye; no depende de cuántos entran por hoja.
- **pdf-lib**: las fuentes estándar solo saben WinAnsi (`textoPdf` reemplaza lo demás por "?"); un
  PNG malformado lo deja en un bucle infinito, por eso el logo pasa siempre por un canvas antes de
  incrustarse; se guarda con `useObjectStreams:false` para que cualquier visor lo lea.
- Al imprimir, el body no puede conservar `min-height:100vh` (Safari lo toma como el papel
  completo y sale una hoja en blanco al final): en `@media print` mide lo que mide el documento.

## Cómo presentar mejoras

Cada mejora, hallazgo u oportunidad que se le presente a Joel lleva su **ámbito** por delante:
seguridad, rendimiento, experiencia, datos, producto, costo u operación. Sirve para decidir rápido
qué se atiende y qué se posterga, y para que una lista de diez no mezcle un riesgo de pérdida de
datos con un texto cortado. Si una mejora toca más de un ámbito, se nombra el principal primero.

## Documentación

Los manuales se editan en `docs/src-manuales/*.html` y se regeneran con `render.py`
(`CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). Verificar que ninguna página
desborde antes de regenerar los PDF.
