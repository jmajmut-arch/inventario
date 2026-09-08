# Módulo de Bodega — diseño (v1)

Documento de diseño previo a escribir código. Recoge lo conversado con Joel el 8 de septiembre
de 2026. Cuando algo cambie durante la implementación, se actualiza acá primero.

## 1. Para qué y para quién

InventIA hoy tiene un **módulo de inventario**: planificar, contar, recontar y medir la exactitud
del stock de una empresa contra el stock que viene de su ERP por Excel.

El **módulo de bodega** es para empresas **sin ERP ni sistema de control**. InventIA pasa a
llevar el stock (SOH, *stock on hand*): registra ingresos y salidas, mantiene el saldo por SKU y
alimenta al módulo de inventario con ese saldo. El módulo de inventario se convierte en el
auditor del módulo de bodega: cuenta contra el SOH que la propia app lleva y mide qué tan bien
se está llevando.

Se activa **por empresa desde súper admin**. Una empresa con ERP no lo ve y sigue igual que hoy.

## 2. Decisiones ya tomadas

| Tema | Decisión |
|---|---|
| Quién retira en una salida | Lista de nombres predeterminados, mantenida por el admin (no texto libre) |
| Proveedores | Lista mantenida por el admin |
| Ajustes de stock por conteo | Requieren aprobación de un admin |
| Bodegas | Una sola bodega por empresa en la v1 (sin traslados) |
| Salida sin stock disponible | Se bloquea; los casos se detallan en la sección 5 |
| Sin conexión | Sí, con mala señal: ingresos y salidas se encolan como hoy los conteos |
| Activación | Interruptor por empresa en el panel de súper admin |

Supuesto mientras no se decida lo contrario: la **valorización** (valor del stock y del consumo
con `costo_unitario`) queda para la fase 3. La base ya tiene el costo por SKU, así que agregarla
después no cambia el modelo.

## 3. Alcance de la v1 y lo que queda fuera

Dentro:

- Ingreso con OC, guía de despacho, proveedor, foto de la guía y foto del material.
- Salida con quién despacha, quién retira y para qué se consume.
- SOH por fila de SKU (código + batch + storage bin) mantenido por la base.
- Ajustes de stock desde un conteo con diferencia confirmada, con aprobación.
- Anulación de movimientos con motivo (nada se borra).
- Kardex por SKU: movimientos y conteos en una sola línea de tiempo.
- Listado de movimientos con filtros y exportación a Excel.
- Comprobante PDF de ingreso y de salida.
- Reporte de consumo por persona y por período; ingresos por proveedor.
- Modo sin conexión para ingresos y salidas.

Fuera de la v1 (se anotan para no perderlos):

- Órdenes de compra como documento propio (con líneas, pendientes de recibir).
- Traslados entre bodegas (una sola bodega en v1).
- Stock mínimo y alertas de reposición.
- Picking, reservas, pedidos internos.
- Firma del que retira en pantalla.

## 4. Modelo de datos

Todo con `empresa_id`, RLS por empresa con el patrón `(select empresa_actual())`, auditoría con
el trigger existente, y `security_invoker` en las vistas, igual que el resto de la base.

### 4.1 Activación

- `empresas.modulo_bodega_habilitado boolean default false`.
- La app lee este campo con el perfil (misma consulta `usuarios → empresas` de hoy) y muestra u
  oculta la pestaña Bodega. El servidor lo revisa también: los RPC del módulo rechazan la llamada
  si la empresa no lo tiene activo.

### 4.2 Listas del administrador

- `proveedores (id, empresa_id, nombre, rut, activo, created_at)`.
- `personas_retiro (id, empresa_id, nombre, area, activo, created_at)`: los nombres
  predeterminados de quien retira. `area` es opcional y sirve para agrupar el consumo
  (por ejemplo "Mantención", "Obra Norte").

Se administran en Configuraciones, en dos tarjetas nuevas, con la misma mecánica que hoy tiene
el equipo (crear, editar, desactivar). Desactivar no borra: los movimientos históricos siguen
apuntando al nombre.

### 4.3 Movimientos

Una sola tabla `movimientos_bodega`. Un movimiento es **una línea**: un SKU, una cantidad. Un
ingreso de 8 materiales de la misma guía son 8 movimientos que comparten `numero_guia` y
`documento_id` (ver 4.4).

| Columna | Uso |
|---|---|
| `id`, `empresa_id`, `created_at` | como en todas las tablas |
| `tipo` | `apertura`, `ingreso`, `salida`, `ajuste` |
| `numero` | correlativo por empresa y tipo: ING-000001, SAL-000001, AJU-000001 |
| `sku_id` | fila de `skus` (código + batch + bin). Un ingreso a un bin o batch nuevo crea la fila de SKU primero, como hoy lo hace la carga masiva |
| `cantidad` | positiva en ingreso y salida; con signo en ajuste |
| `fecha` | fecha del movimiento; `capturado_en` guarda la hora real si se registró sin conexión |
| `usuario_id` | quién lo registró |
| `estado` | `aprobado`, `pendiente_aprobacion`, `pendiente_revision`, `anulado` |
| `proveedor_id`, `numero_oc`, `numero_guia` | solo ingreso. Guía obligatoria; OC opcional pero recomendada |
| `despachado_por_id` (usuario), `retirado_por_id` (persona de la lista), `destino` (texto corto: para qué) | solo salida |
| `motivo` | ajuste y anulación |
| `conteo_id` | ajuste generado desde un conteo |
| `aprobado_por_id`, `aprobado_en` | ajustes |
| `anulado_por_id`, `anulado_en`, `anulado_motivo` | anulación |
| `idempotency_key` | para la cola sin conexión, igual que en `conteos` |

Fotos en `movimiento_fotos (id, movimiento_id, tipo: guia|material, foto_url)`, en el mismo
bucket privado `fotos-inventario`, misma carpeta por empresa, misma compresión en el
dispositivo que ya tienen los conteos.

### 4.4 Documento

`documentos_bodega (id, empresa_id, tipo ingreso|salida, numero, fecha, usuario_id, proveedor_id,
numero_oc, numero_guia, retirado_por_id, despachado_por_id, destino, observacion)`.

Agrupa las líneas de un mismo ingreso o salida. El comprobante PDF y la anulación completa
trabajan sobre el documento; el SOH y el kardex trabajan sobre las líneas. Las columnas
repetidas (proveedor, guía, retirado por) viven en el documento y se copian a la línea para que
las consultas del kardex no tengan que unir tablas.

### 4.5 SOH

**No hay tabla de saldos.** El saldo vive donde siempre: `skus.stock_sistema`. Un trigger sobre
`movimientos_bodega` lo mantiene:

- Ingreso aprobado: `+cantidad`. Salida aprobada: `−cantidad`. Ajuste aprobado: `±cantidad`.
- Anular un movimiento aprobado revierte su efecto.
- Los estados `pendiente_aprobacion` y `pendiente_revision` no tocan el saldo.

Ventaja decisiva: **todo lo que ya existe sigue funcionando sin cambios**. Contar compara
contra `stock_sistema`, Reconteo calcula la diferencia contra `stock_sistema`, el Dashboard
valoriza con `stock_sistema × costo_unitario`, la clasificación ABC se refresca igual. El módulo
de bodega solo cambia quién escribe ese número: antes el Excel, ahora los movimientos.

### 4.6 Carga masiva con el módulo activo

- La **primera** carga de Excel después de activar el módulo es la **apertura**: por cada fila
  con stock se crea un movimiento `apertura` y el saldo queda en `stock_sistema`.
- Las cargas **siguientes** actualizan solo datos maestros (descripción, ubicación, bin, costo,
  criticidad) y **no tocan el stock**. La pantalla de Carga lo dice en un aviso antes de
  procesar. Si una empresa necesita corregir saldos en bloque, se hace con ajustes aprobados,
  que quedan en el kardex con motivo. Así nunca hay dos fuentes de verdad.

### 4.7 Vistas

- `kardex_sku`: unión de movimientos aprobados y conteos del SKU, ordenada por fecha, con saldo
  acumulado por movimiento. Se muestra en la ficha del SKU en Buscar.
- `stock_actual`: SOH por SKU, batch y bin, con valorización cuando se active.
- `consumo_por_persona`: salidas por persona, área y mes.
- `ingresos_por_proveedor`: ingresos por proveedor y mes.
- `movimientos_pendientes`: lo que espera aprobación o revisión, para la tarjeta del admin.

## 5. Reglas de negocio

### 5.1 Ingreso

1. SKU (buscador o escáner, los mismos de Contar). Si el material no existe en el maestro, se
   ofrece crearlo ahí mismo con la pantalla de alta manual que ya existe.
2. Cantidad, en la unidad de medida del SKU.
3. Bin de destino: viene el del SKU; si se elige otro, se crea la fila de SKU en ese bin.
4. Proveedor (lista), número de guía (obligatorio), número de OC (opcional).
5. Foto de la guía (obligatoria) y foto del material (opcional). Ambas comprimidas en el
   dispositivo.
6. Varios SKU de la misma guía se agregan como líneas del mismo documento antes de guardar.
7. Al guardar: el documento y sus líneas quedan `aprobado`, el saldo sube, se ofrece el
   comprobante PDF.

### 5.2 Salida

1. SKU, cantidad, bin de origen.
2. Quién despacha: el usuario conectado, editable a otro usuario de la empresa.
3. Quién retira: persona de la lista. Destino o uso: texto corto.
4. Foto opcional del material entregado.
5. Validación: `cantidad ≤ SOH disponible` en esa fila de SKU. La validación definitiva es del
   servidor, con bloqueo de fila, para que dos personas despachando a la vez no dejen el saldo
   negativo.

### 5.3 Salida sin stock disponible: los casos

La regla base es **bloquear**. Estos son los casos que se exploraron y qué hace la app en cada
uno.

| Caso | Qué pasa | Qué hace la app |
|---|---|---|
| A. El sistema dice 3, en el estante hay 5 y quieren sacar 5 | El SOH está mal; el material sí existe | Bloquea la salida y ofrece **"Contar ahora"**: abre Contar con ese SKU, el conteo queda con diferencia +2, se genera un ajuste `pendiente_aprobacion`. Cuando un admin lo aprueba, la salida se puede registrar. Si el admin está presente, aprueba en el momento desde la misma pantalla |
| B. El sistema dice 3, en el estante hay 3 y quieren sacar 5 | Pedido mayor al stock real | Bloquea. Se registra la salida por 3 y el resto queda como observación en el documento ("solicitado 5, entregado 3"). El faltante se ve en el reporte de consumo |
| C. Sin conexión, el saldo local dice 3 pero alguien más ya sacó 2 | Saldo desactualizado en el dispositivo | La salida se guarda en la cola con el saldo local como referencia. Al sincronizar, el servidor revalida: si el saldo real no alcanza, el movimiento queda `pendiente_revision`, **no se pierde y no se aplica**, y el admin lo ve en su tarjeta de pendientes con las dos cifras. Decide: registrar un ajuste y aprobar, o anular con motivo |
| D. Devolución: sale material y vuelve al día siguiente | Material que regresa | Es un **ingreso** con proveedor vacío y motivo "devolución", enlazado a la salida original. No se anula la salida, porque sí ocurrió |
| E. Merma, daño o vencimiento | Material que ya no sirve | **Ajuste negativo** con motivo, requiere aprobación. No es una salida porque nadie lo retira |
| F. Se registró una salida por error | Error de digitación | **Anulación** por un admin con motivo. Revierte el saldo y queda en el kardex como anulada |
| G. Dos personas despachan el mismo SKU al mismo tiempo | Concurrencia | El servidor bloquea la fila del SKU al validar; la segunda salida ve el saldo ya descontado y, si no alcanza, se rechaza con el saldo real |

### 5.4 Ajustes y aprobación

- Un conteo con diferencia que se **confirma** en Reconteo (o se marca como definitivo) ofrece
  al admin el botón **"Ajustar stock"**: crea un ajuste por la diferencia, aprobado por quien
  aprieta el botón, con `conteo_id` como respaldo. Un operador no puede ajustar.
- Un ajuste manual (sin conteo) lo puede proponer un operador con motivo; queda
  `pendiente_aprobacion` hasta que un admin lo apruebe o rechace.
- La aprobación y el rechazo quedan en Auditoría con quién y cuándo.

### 5.5 Anulación

- Solo admin, con motivo obligatorio. Anula el documento completo o una línea.
- Revierte el efecto en el saldo. Si la reversión dejaría el saldo negativo (se anula un ingreso
  cuyo material ya salió), la app avisa y pide registrar antes un ajuste o anular también las
  salidas asociadas.

### 5.6 Sin conexión

- Ingresos y salidas se encolan con `idempotency_key` y `capturado_en`, con la misma cola y el
  mismo panel de estado que hoy usan los conteos. Las fotos se encolan igual.
- El dispositivo guarda una copia del SOH de los SKU que se usan (misma caché local que ya
  existe para Contar) para validar salidas de forma provisional.
- Al sincronizar, el servidor es quien decide: aplica lo que cabe, y lo que no queda en
  `pendiente_revision` (caso C).

### 5.7 Permisos

| Acción | Operador | Admin | Súper admin |
|---|---|---|---|
| Registrar ingreso y salida | sí | sí | |
| Proponer ajuste con motivo | sí | sí | |
| Aprobar o rechazar ajustes | | sí | |
| Anular movimientos | | sí | |
| Mantener proveedores y personas de retiro | | sí | |
| Ver kardex, stock actual y reportes | sí | sí | |
| Activar el módulo a una empresa | | | sí |

Con conteo ciego activo, el operador no ve el SOH en Contar, pero sí lo ve en Bodega al
registrar una salida (necesita saber si alcanza). Es una excepción consciente y se documenta.

## 6. Pantallas

Acordado con Joel: en vez de una pestaña más en la barra, una **pantalla de inicio** después del
login, solo para empresas con el módulo de bodega activo. Las empresas que solo cuentan entran
como hoy, sin un toque extra.

- **Inicio** con cuatro opciones grandes: **Ingreso**, **Salida**, **Inventario** y
  **Dashboard**. Los operadores ven las tres primeras; Dashboard según plan y rol, como hoy el
  Ejecutivo. Buscar y Configuraciones siguen arriba a la derecha en todas las pantallas.
- **Ingreso**: directo al formulario de documento con líneas, escáner, fotos, proveedor, guía,
  OC. Ícono de Inicio arriba para volver.
- **Salida**: directo al formulario con líneas, quién despacha, quién retira, destino.
- **Inventario**: abre lo que existe hoy tal cual, con su barra de abajo (Carga, Períodos,
  Grupos, Plan, Contar, Reconteo) e ícono de Inicio para volver.
- **Dashboard**: pasa a ser de la empresa completa. Arriba, sección **Bodega**: ingresos y
  salidas del período, stock valorizado, pendientes de aprobación con acceso a
  **Movimientos** (lista con filtros, aprobar, rechazar, anular, comprobante PDF, exportar
  Excel) y a **Stock** (SOH por SKU, batch y bin). Abajo, la sección de Inventario que ya
  existe (avance, exactitud, valorización de diferencias).
- **Buscar**: en la ficha del SKU, la pestaña **Kardex**.
- **Reconteo**: botón **Ajustar stock** (admin) en cada material con diferencia confirmada.
- **Carga**: aviso de apertura en la primera carga y de "solo maestros" en las siguientes.
- **Configuraciones**: tarjetas **Proveedores** y **Personas que retiran**.
- **Súper admin**: interruptor **Módulo de bodega** en la ficha de cada empresa.

## 7. Conexión con el módulo de inventario

- Contar, Reconteo, Dashboard y los informes de cierre leen `stock_sistema`, que ahora lo
  escriben los movimientos. No cambia ninguna consulta existente.
- El kardex muestra los conteos junto a los movimientos, así se ve de una vez "entró 10, salió
  4, se contó 5, se ajustó +1".
- La exactitud que mide el módulo de inventario pasa a ser la exactitud con que la empresa lleva
  su bodega en InventIA. Es el argumento de venta del combo.

## 8. Fases y estimación

| Fase | Contenido | Tiempo |
|---|---|---|
| 1 | Migración (tablas, trigger de saldo, RLS, vistas), interruptor en súper admin, listas en Configuraciones, Ingreso, Salida, Movimientos con anulación, apertura por carga masiva, cola sin conexión, tests | 1,5 semanas |
| 2 | Ajustar stock desde Reconteo con aprobación, propuesta de ajuste manual, tarjeta de pendientes, kardex en Buscar, comprobantes PDF, exportar Excel, manuales | 1 semana |
| 3 | Reportes de consumo por persona y área e ingresos por proveedor, tarjeta en Dashboard, valorización, stock mínimo con alertas (opcional) | 0,5 a 1 semana |

Cada fase se publica por separado y se puede usar desde la primera. Antes de cada una, se mide
con datos reales que ninguna pantalla existente se haga más lenta.

## 9. Preguntas abiertas y decisiones

Decisiones tomadas el 8 de septiembre de 2026:

1. **Unidades con decimales**: `cantidad` y `stock_sistema` son `numeric` y los campos de
   cantidad en Ingreso y Salida aceptan decimales (litros, metros). Confirmado.
2. **SKU nuevo desde el ingreso**: lo puede crear cualquier rol, igual que la alta manual de
   hoy. En la fase 2 se agrega el acceso directo desde Ingreso cuando el código no existe.
3. **Empresa demo**: el módulo queda activo en la demo pública. El reset nocturno
   (`resetear_demo_inventia`) limpia movimientos, documentos, proveedores y personas de
   retiro, y vuelve a sembrar la apertura, un ingreso y una salida de ejemplo. Como corre
   desde pg_cron sin sesión de usuario, el trigger de validación deja pasar esas filas solo
   cuando no hay `auth.uid()` y la propia función marcó la transacción con `app.reset_demo`.

Siguen abiertas:

4. **Valorización**: confirmar que queda para la fase 3.
5. **Nombre en la app**: "Bodega" para el módulo nuevo e "Inventario" para lo existente, como
   propuso Joel. Revisar que no choque con "Ubicación general" (que hoy se llama bodega en la
   base) en los textos de pantalla.
