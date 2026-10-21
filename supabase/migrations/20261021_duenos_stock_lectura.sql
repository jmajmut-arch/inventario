-- Dueños de stock, paso 5: lo que lee materiales sabe del dueño (Joel, 21/10/2026). Sigue a
-- 20261020_duenos_stock_contraer.sql.
--
-- 1. Las vistas que muestran materiales exponen skus.dueno, como última columna (create or
--    replace view solo admite columnas nuevas al final; las funciones que devuelven estas vistas
--    usan l.* / b.* y se ajustan solas). Se repite security_invoker=true: create or replace view
--    sin WITH deja la vista sin sus opciones.
-- 2. Los totales por material (bloqueado, tránsito, transferencia, consignado, en proveedor) que
--    Contar y Reconteo muestran junto a la diferencia sumaban todas las filas del código: con
--    dueños, el tránsito de un cliente aparecía como explicación de la diferencia de otro. Ahora
--    suman por código y dueño (skus_lectura, reconteo_pendiente, universo_entradas_plan_contar).
-- 3. registrar_transferencia_bodega buscaba la fila de destino sin mirar el dueño: con dos
--    clientes en el sitio de destino tomaba cualquiera de las dos, y la fila nueva nacía sin
--    dueño. El stock de un cliente terminaba siendo de otro. Ahora el destino es del mismo dueño.
-- 4. renombrar_ubicacion_general va aparte, en 20261021_duenos_stock_renombrar.sql.
--
-- En una empresa sin dueños todas las filas tienen dueno = '': los totales y la transferencia dan
-- exactamente lo mismo que antes, y universo_entradas_plan_contar devuelve el
-- mismo JSON (la clave dueno solo aparece cuando la fila tiene dueño).
--
-- La planificación (grupos, planes, calendario) sigue por material = código + bodega, igual que
-- hoy con varios bins: el plan dice qué material contar y en terreno se cuenta cada fila, de
-- cada dueño.

set local lock_timeout = '5s';

-- 1 y 2. Vistas
create or replace view public.skus_lectura with (security_invoker = true) as
 SELECT s.id,
    s.sku_code,
    s.descripcion,
    s.categoria,
    s.unidad_medida,
    s.ubicacion,
    s.bodega,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_sistema
        END AS stock_sistema,
    s.activo,
    s.created_at,
    s.updated_at,
    s.storage_bin,
    s.empresa_id,
    s.capturado_en,
    s.codigo_barras,
    s.bodega_key,
    s.costo_unitario,
    s.batch,
    s.batch_key,
    s.critico,
    s.ultimo_conteo_id,
    s.ultimo_conteo_fecha,
    s.ultimo_conteo_estado,
    s.ultimo_conteo_diferencia,
    s.ultimo_conteo_cantidad,
    s.ultimo_conteo_capturado_en,
    s.ultimo_conteo_fuera_de_plan,
    s.ultimo_conteo_ciclo_id,
    s.ultimo_conteo_usuario_id,
    s.clase_abc,
    s.pct_acumulado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_sistema_anterior
        END AS stock_sistema_anterior,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::timestamp with time zone
            ELSE s.stock_sistema_actualizado_en
        END AS stock_sistema_actualizado_en,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_bloqueado
        END AS stock_bloqueado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_transito_1
        END AS stock_transito_1,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_transito_2
        END AS stock_transito_2,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_transferencia
        END AS stock_transferencia,
    s.ubicacion_key,
    s.storage_bin_key,
    s.tipo_material,
    s.stock_minimo,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_bloqueado
        END AS total_bloqueado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_transito_1
        END AS total_transito_1,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_transito_2
        END AS total_transito_2,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_transferencia
        END AS total_transferencia,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_consignado
        END AS stock_consignado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_consignado
        END AS total_consignado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_en_proveedor
        END AS stock_en_proveedor,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_en_proveedor
        END AS total_en_proveedor,
    s.dueno
   FROM skus s
     CROSS JOIN LATERAL ( SELECT sum(COALESCE(s2.stock_bloqueado, 0::numeric)) AS total_bloqueado,
            sum(COALESCE(s2.stock_transito_1, 0::numeric)) AS total_transito_1,
            sum(COALESCE(s2.stock_transito_2, 0::numeric)) AS total_transito_2,
            sum(COALESCE(s2.stock_transferencia, 0::numeric)) AS total_transferencia,
            sum(COALESCE(s2.stock_consignado, 0::numeric)) AS total_consignado,
            sum(COALESCE(s2.stock_en_proveedor, 0::numeric)) AS total_en_proveedor
           FROM skus s2
          WHERE s2.empresa_id = s.empresa_id AND s2.sku_code = s.sku_code AND s2.dueno = s.dueno AND s2.activo) tot;

create or replace view public.stock_actual with (security_invoker = true) as
 SELECT s.id AS sku_id,
    s.sku_code,
    s.descripcion,
    s.batch,
    s.storage_bin,
    s.bodega,
    s.ubicacion,
    s.unidad_medida,
    COALESCE(s.stock_sistema, 0::numeric) AS stock,
    s.costo_unitario,
    COALESCE(s.stock_sistema, 0::numeric) * COALESCE(s.costo_unitario, 0::numeric) AS valor,
    s.critico,
    s.clase_abc,
    s.empresa_id,
    s.stock_minimo,
    s.stock_minimo IS NOT NULL AND COALESCE(s.stock_sistema, 0::numeric) < s.stock_minimo AS bajo_minimo,
        CASE
            WHEN s.stock_minimo IS NOT NULL AND COALESCE(s.stock_sistema, 0::numeric) < s.stock_minimo THEN s.stock_minimo - COALESCE(s.stock_sistema, 0::numeric)
            ELSE NULL::numeric
        END AS falta_para_minimo,
    s.tipo_material,
    COALESCE(rs.reservado, 0::numeric) AS reservado,
    COALESCE(s.stock_sistema, 0::numeric) - COALESCE(rs.reservado, 0::numeric) AS disponible,
    s.dueno
   FROM skus s
     LEFT JOIN reservado_por_sku rs ON rs.sku_id = s.id
  WHERE s.activo = true;

create or replace view public.skus_planificables with (security_invoker = true) as
 SELECT id,
    sku_code,
    descripcion,
    categoria,
    unidad_medida,
    ubicacion,
    bodega,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_sistema
        END AS stock_sistema,
    activo,
    created_at,
    updated_at,
    storage_bin,
    empresa_id,
    capturado_en,
    codigo_barras,
    bodega_key,
    costo_unitario,
    batch,
    batch_key,
    critico,
    clase_abc,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_bloqueado
        END AS stock_bloqueado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_transito_1
        END AS stock_transito_1,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_transito_2
        END AS stock_transito_2,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_transferencia
        END AS stock_transferencia,
    dueno
   FROM skus s
  WHERE activo = true AND NOT (EXISTS ( SELECT 1
           FROM ultimo_conteo_por_sku u
          WHERE u.sku_id = s.id)) AND (( SELECT plan_incluye_stock_cero() AS plan_incluye_stock_cero) OR COALESCE(stock_sistema, 0::numeric) <> 0::numeric);

create or replace view public.skus_busqueda with (security_invoker = true) as
 SELECT s.id AS sku_id,
    s.sku_code,
    s.descripcion,
    s.bodega,
    s.ubicacion,
    s.storage_bin,
    s.empresa_id,
    s.ultimo_conteo_id AS conteo_id,
    s.ultimo_conteo_cantidad AS cantidad_contada,
    s.ultimo_conteo_estado AS estado,
    s.ultimo_conteo_diferencia AS diferencia,
    s.ultimo_conteo_fecha AS fecha_conteo,
    s.ultimo_conteo_capturado_en AS capturado_en,
    s.ultimo_conteo_fuera_de_plan AS fuera_de_plan,
    s.ultimo_conteo_ciclo_id AS ciclo_id,
    cc.nombre AS ciclo_nombre,
    COALESCE(fotos.items, '[]'::jsonb) AS fotos,
    s.batch,
    u.nombre AS contado_por,
    s.critico,
    s.clase_abc,
    s.pct_acumulado,
    co.observacion,
    s.ultimo_conteo_usuario_id AS contado_por_id,
    s.ultimo_conteo_id IS NOT NULL AND COALESCE(s.ultimo_conteo_diferencia, 0::numeric) <> 0::numeric AND co.reconteo_descartado_en IS NULL AND (s.ultimo_conteo_ciclo_id = (( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual)) IS NULL) AS reconteo_pendiente,
    co.cantidad_original,
    co.corregido_en,
    co.motivo_correccion,
    co.reconteo_cierre_tipo,
    co.ajuste_erp_referencia,
    co.reconteo_descartado_en AS reconteo_cerrado_en,
    co.packing_danado,
    co.material_danado,
    co.cantidad_danada,
    fotos.conteo_n::integer AS ultimo_conteo_n,
    fotos.reconteo_n::integer AS ultimo_reconteo_n,
    s.dueno
   FROM skus s
     LEFT JOIN ciclos_conteo cc ON cc.id = s.ultimo_conteo_ciclo_id
     LEFT JOIN usuarios u ON u.id = s.ultimo_conteo_usuario_id
     LEFT JOIN conteos co ON co.id = s.ultimo_conteo_id
     LEFT JOIN LATERAL ( WITH cs AS (
                 SELECT c.id,
                    c.fecha_conteo,
                    c.ciclo_id,
                    c.es_reconteo,
                    row_number() OVER (PARTITION BY c.ciclo_id ORDER BY c.fecha_conteo) AS numero_conteo,
                    sum(
                        CASE
                            WHEN c.es_reconteo THEN 0
                            ELSE 1
                        END) OVER (PARTITION BY c.ciclo_id ORDER BY c.fecha_conteo, c.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS conteo_n
                   FROM conteos c
                  WHERE c.sku_id = s.id
                ), cn AS (
                 SELECT cs.id,
                    cs.fecha_conteo,
                    cs.ciclo_id,
                    cs.numero_conteo,
                    GREATEST(cs.conteo_n, 1::bigint) AS conteo_n,
                    sum(
                        CASE
                            WHEN cs.es_reconteo THEN 1
                            ELSE 0
                        END) OVER (PARTITION BY cs.ciclo_id, cs.conteo_n ORDER BY cs.fecha_conteo, cs.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS reconteo_n
                   FROM cs
                )
         SELECT ( SELECT jsonb_agg(jsonb_build_object('foto_url', cf.foto_url, 'numero_conteo', cn.numero_conteo, 'fecha_conteo', cn.fecha_conteo, 'conteo', cn.conteo_n, 'reconteo', cn.reconteo_n, 'conteo_id', cn.id, 'ciclo_id', cn.ciclo_id, 'ciclo_nombre', fc.nombre) ORDER BY cn.fecha_conteo, cf.created_at) AS jsonb_agg
                   FROM cn
                     JOIN conteo_fotos cf ON cf.conteo_id = cn.id
                     LEFT JOIN ciclos_conteo fc ON fc.id = cn.ciclo_id) AS items,
            ( SELECT cn.conteo_n
                   FROM cn
                  WHERE cn.id = s.ultimo_conteo_id) AS conteo_n,
            ( SELECT cn.reconteo_n
                   FROM cn
                  WHERE cn.id = s.ultimo_conteo_id) AS reconteo_n) fotos ON true
  WHERE s.activo = true;

create or replace view public.conteos_exportables with (security_invoker = true) as
 SELECT c.id AS conteo_id,
    s.sku_code,
    s.descripcion,
    s.categoria,
    s.unidad_medida,
    s.codigo_barras,
    s.bodega AS bodega_maestro,
    s.ubicacion AS ubicacion_maestro,
    s.storage_bin,
    s.stock_sistema,
    s.costo_unitario,
    c.bodega AS bodega_contada,
    c.ubicacion_contada,
    c.ubicacion_distinta,
    c.cantidad_contada,
    c.diferencia,
    c.diferencia * s.costo_unitario AS valor_diferencia,
    c.estado,
    c.fuera_de_plan,
    c.observacion,
    c.fecha_conteo,
    c.capturado_en,
    u.nombre AS responsable,
    cc.nombre AS ciclo_nombre,
    s.batch,
    c.packing_danado,
    c.material_danado,
    c.cantidad_danada,
    s.dueno
   FROM conteos c
     JOIN skus s ON s.id = c.sku_id
     LEFT JOIN usuarios u ON u.id = c.usuario_id
     LEFT JOIN ciclos_conteo cc ON cc.id = c.ciclo_id
  ORDER BY c.fecha_conteo DESC;

create or replace view public.movimientos_bodega_detalle with (security_invoker = true) as
 SELECT m.id,
    m.empresa_id,
    m.documento_id,
    m.tipo,
    m.numero,
    m.sku_id,
    m.cantidad,
    m.fecha,
    m.capturado_en,
    m.usuario_id,
    m.estado,
    m.proveedor_id,
    m.numero_oc,
    m.numero_guia,
    m.despachado_por_id,
    m.retirado_por_id,
    m.destino,
    m.motivo,
    m.conteo_id,
    m.saldo_local,
    m.aprobado_por_id,
    m.aprobado_en,
    m.anulado_por_id,
    m.anulado_en,
    m.anulado_motivo,
    m.created_at,
    s.sku_code,
    s.descripcion,
    s.batch,
    s.storage_bin,
    s.bodega,
    s.ubicacion,
    s.unidad_medida,
    p.nombre AS proveedor_nombre,
    pr.nombre AS retirado_por_nombre,
    pr.area AS retirado_por_area,
    u.nombre AS usuario_nombre,
    ud.nombre AS despachado_por_nombre,
    d.observacion AS documento_observacion,
    d.anulado_en AS documento_anulado_en,
    m.costo_unitario,
    COALESCE(m.costo_unitario, s.costo_unitario) AS costo_aplicado,
    s.tipo_material,
    s.dueno
   FROM movimientos_bodega m
     JOIN skus s ON s.id = m.sku_id
     LEFT JOIN proveedores p ON p.id = m.proveedor_id
     LEFT JOIN personas_retiro pr ON pr.id = m.retirado_por_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     LEFT JOIN usuarios ud ON ud.id = m.despachado_por_id
     LEFT JOIN documentos_bodega d ON d.id = m.documento_id;

create or replace view public.ordenes_compra_lineas_detalle with (security_invoker = true) as
 SELECT l.id,
    l.empresa_id,
    l.orden_compra_id,
    l.sku_id,
    l.cantidad,
    l.costo_unitario,
    l.observacion,
    l.created_at,
    s.sku_code,
    s.descripcion,
    s.unidad_medida,
    s.bodega,
    s.ubicacion,
    s.storage_bin,
    s.batch,
    COALESCE(r.recibido, 0::numeric) AS recibido,
    GREATEST(l.cantidad - COALESCE(r.recibido, 0::numeric), 0::numeric) AS pendiente,
    GREATEST(COALESCE(r.recibido, 0::numeric) - l.cantidad, 0::numeric) AS exceso,
    round(l.cantidad * COALESCE(l.costo_unitario, 0::numeric)) AS total_linea,
    s.dueno
   FROM ordenes_compra_lineas l
     JOIN skus s ON s.id = l.sku_id
     LEFT JOIN LATERAL ( SELECT sum(m.cantidad) AS recibido
           FROM movimientos_bodega m
             JOIN documentos_bodega d ON d.id = m.documento_id
          WHERE d.orden_compra_id = l.orden_compra_id AND d.anulado_en IS NULL AND m.sku_id = l.sku_id AND m.tipo = 'ingreso'::text AND m.estado = 'aprobado'::text AND m.anulado_en IS NULL) r ON true;

create or replace view public.reservas_lineas_detalle with (security_invoker = true) as
 SELECT p.id,
    p.empresa_id,
    p.reserva_id,
    p.sku_id,
    p.cantidad,
    p.observacion,
    p.created_at,
    p.entregado,
    p.pendiente,
    s.sku_code,
    s.descripcion,
    s.unidad_medida,
    s.batch,
    s.bodega,
    s.ubicacion,
    s.storage_bin,
    COALESCE(s.stock_sistema, 0::numeric) AS stock,
    COALESCE(rs.reservado, 0::numeric) AS reservado_total,
    GREATEST(COALESCE(rs.reservado, 0::numeric) - COALESCE(s.stock_sistema, 0::numeric), 0::numeric) AS faltante,
    s.dueno
   FROM reservas_pendientes p
     JOIN skus s ON s.id = p.sku_id
     LEFT JOIN reservado_por_sku rs ON rs.sku_id = p.sku_id;

create or replace view public.reconteo_pendiente with (security_invoker = true) as
 WITH conteos_sku AS MATERIALIZED (
         SELECT c.id,
            c.sku_id,
            c.usuario_id,
            c.cantidad_contada,
            c.ubicacion_contada,
            c.bodega,
            c.foto_url,
            c.observacion,
            c.estado,
            c.diferencia,
            c.fecha_conteo,
            c.empresa_id,
            c.capturado_en,
            c.ciclo_id,
            c.fuera_de_plan,
            c.ubicacion_distinta,
            c.reconteo_descartado_en,
            c.cantidad_original,
            c.corregido_en,
            c.motivo_correccion,
            row_number() OVER (PARTITION BY c.sku_id ORDER BY c.fecha_conteo) AS numero_conteo,
            c.es_reconteo,
            sum(
                CASE
                    WHEN c.es_reconteo THEN 0
                    ELSE 1
                END) OVER (PARTITION BY c.sku_id, c.ciclo_id ORDER BY c.fecha_conteo, c.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS conteo_n
           FROM conteos c
          WHERE c.ciclo_id = (( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual)) IS NULL
        ), ultimo AS MATERIALIZED (
         SELECT DISTINCT ON (conteos_sku.sku_id) conteos_sku.id,
            conteos_sku.sku_id,
            conteos_sku.usuario_id,
            conteos_sku.cantidad_contada,
            conteos_sku.ubicacion_contada,
            conteos_sku.bodega,
            conteos_sku.foto_url,
            conteos_sku.observacion,
            conteos_sku.estado,
            conteos_sku.diferencia,
            conteos_sku.fecha_conteo,
            conteos_sku.empresa_id,
            conteos_sku.capturado_en,
            conteos_sku.ciclo_id,
            conteos_sku.fuera_de_plan,
            conteos_sku.ubicacion_distinta,
            conteos_sku.reconteo_descartado_en,
            conteos_sku.cantidad_original,
            conteos_sku.corregido_en,
            conteos_sku.motivo_correccion,
            conteos_sku.numero_conteo
           FROM conteos_sku
          ORDER BY conteos_sku.sku_id, conteos_sku.fecha_conteo DESC
        ), historial_diferencias AS MATERIALIZED (
         SELECT conteos_sku.sku_id,
            count(*) AS veces_con_diferencia
           FROM conteos_sku
          WHERE conteos_sku.diferencia <> 0::numeric
          GROUP BY conteos_sku.sku_id
        ), fotos_sku AS MATERIALIZED (
         SELECT cs.sku_id,
            jsonb_agg(jsonb_build_object('foto_url', cf.foto_url, 'numero_conteo', cs.numero_conteo, 'fecha_conteo', cs.fecha_conteo, 'conteo', GREATEST(cs.conteo_n, 1::bigint), 'reconteo', cs.reconteo_n) ORDER BY cs.fecha_conteo, cf.created_at) AS fotos
           FROM ( SELECT conteos_sku.id,
                    conteos_sku.sku_id,
                    conteos_sku.fecha_conteo,
                    conteos_sku.numero_conteo,
                    conteos_sku.conteo_n,
                    sum(
                        CASE
                            WHEN conteos_sku.es_reconteo THEN 1
                            ELSE 0
                        END) OVER (PARTITION BY conteos_sku.sku_id, conteos_sku.ciclo_id, conteos_sku.conteo_n ORDER BY conteos_sku.fecha_conteo, conteos_sku.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS reconteo_n
                   FROM conteos_sku) cs
             JOIN conteo_fotos cf ON cf.conteo_id = cs.id
          GROUP BY cs.sku_id
        ), reincidencia AS MATERIALIZED (
         SELECT ult_por_ciclo.sku_id,
            count(*) AS ciclos_previos_con_diferencia
           FROM ( SELECT DISTINCT ON (c.sku_id, c.ciclo_id) c.sku_id,
                    c.ciclo_id,
                    c.diferencia
                   FROM conteos c
                  WHERE (c.sku_id IN ( SELECT ultimo.sku_id
                           FROM ultimo)) AND (( SELECT ciclo_actual() AS ciclo_actual)) IS NOT NULL AND c.ciclo_id IS NOT NULL AND c.ciclo_id <> (( SELECT ciclo_actual() AS ciclo_actual)) AND c.reconteo_descartado_en IS NULL
                  ORDER BY c.sku_id, c.ciclo_id, c.fecha_conteo DESC) ult_por_ciclo
          WHERE ult_por_ciclo.diferencia <> 0::numeric
          GROUP BY ult_por_ciclo.sku_id
        )
 SELECT s.id,
    s.sku_code,
    s.descripcion,
    s.categoria,
    s.unidad_medida,
    s.ubicacion,
    s.bodega,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_sistema
        END AS stock_sistema,
    u.cantidad_contada AS ultima_cantidad_contada,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE u.diferencia
        END AS ultima_diferencia,
    u.fecha_conteo AS ultimo_conteo_fecha,
    COALESCE(f.fotos, '[]'::jsonb) AS fotos,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE abs(u.diferencia)
        END AS diferencia_abs,
    u.ubicacion_contada,
    u.bodega AS bodega_contada,
    u.ubicacion_distinta,
    COALESCE(h.veces_con_diferencia, 0::bigint) > 1 AS diferencia_recurrente,
    COALESCE(h.veces_con_diferencia, 0::bigint) AS veces_con_diferencia,
        CASE
            WHEN u.ubicacion_distinta AND COALESCE(h.veces_con_diferencia, 0::bigint) > 1 THEN 'Ubicación distinta y recurrente'::text
            WHEN u.ubicacion_distinta THEN 'Ubicación distinta'::text
            WHEN COALESCE(h.veces_con_diferencia, 0::bigint) > 1 THEN 'Diferencia recurrente'::text
            ELSE 'Sin patrón detectado'::text
        END AS causa_probable,
    s.costo_unitario,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE u.diferencia * s.costo_unitario
        END AS valor_diferencia_linea,
    s.storage_bin,
    s.batch,
    s.critico,
    s.clase_abc,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_sistema_anterior
        END AS stock_sistema_anterior,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::timestamp with time zone
            ELSE s.stock_sistema_actualizado_en
        END AS stock_sistema_actualizado_en,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_bloqueado
        END AS stock_bloqueado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_transito_1
        END AS stock_transito_1,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_transito_2
        END AS stock_transito_2,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_transferencia
        END AS stock_transferencia,
    u.id AS conteo_id,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_bloqueado
        END AS total_bloqueado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_transito_1
        END AS total_transito_1,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_transito_2
        END AS total_transito_2,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_transferencia
        END AS total_transferencia,
    (COALESCE(rc.ciclos_previos_con_diferencia, 0::bigint) + 1)::integer AS ciclos_con_diferencia,
    COALESCE(rc.ciclos_previos_con_diferencia, 0::bigint) >= 1 AS reincidente,
    u.usuario_id AS contado_por_id,
    u.capturado_en,
    u.observacion,
    u.cantidad_original,
    u.corregido_en,
    u.motivo_correccion,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_consignado
        END AS stock_consignado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_consignado
        END AS total_consignado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_en_proveedor
        END AS stock_en_proveedor,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE tot.total_en_proveedor
        END AS total_en_proveedor,
    s.dueno
   FROM ultimo u
     JOIN skus s ON s.id = u.sku_id
     CROSS JOIN LATERAL ( SELECT sum(COALESCE(s2.stock_bloqueado, 0::numeric)) AS total_bloqueado,
            sum(COALESCE(s2.stock_transito_1, 0::numeric)) AS total_transito_1,
            sum(COALESCE(s2.stock_transito_2, 0::numeric)) AS total_transito_2,
            sum(COALESCE(s2.stock_transferencia, 0::numeric)) AS total_transferencia,
            sum(COALESCE(s2.stock_consignado, 0::numeric)) AS total_consignado,
            sum(COALESCE(s2.stock_en_proveedor, 0::numeric)) AS total_en_proveedor
           FROM skus s2
          WHERE s2.empresa_id = s.empresa_id AND s2.sku_code = s.sku_code AND s2.dueno = s.dueno AND s2.activo) tot
     LEFT JOIN historial_diferencias h ON h.sku_id = u.sku_id
     LEFT JOIN fotos_sku f ON f.sku_id = u.sku_id
     LEFT JOIN reincidencia rc ON rc.sku_id = u.sku_id
  WHERE u.diferencia <> 0::numeric AND s.activo = true AND u.reconteo_descartado_en IS NULL
  ORDER BY u.fecha_conteo DESC;

-- 2. Totales de Contar por código y dueño; la clave dueno solo cuando la fila tiene dueño
create or replace function public.universo_entradas_plan_contar(p_plan_ids uuid[])
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(jsonb_object_agg(t.plan_id, t.skus), '{}'::jsonb)
  from (
    select u.plan_id,
           jsonb_agg(jsonb_build_object(
             'id', u.id, 'sku_code', u.sku_code, 'descripcion', u.descripcion,
             'bodega', u.bodega, 'ubicacion', u.ubicacion, 'storage_bin', u.storage_bin,
             'batch', u.batch, 'unidad_medida', u.unidad_medida, 'stock_sistema', u.stock_sistema,
             'critico', u.critico, 'clase_abc', u.clase_abc, 'stock_bloqueado', u.stock_bloqueado,
             'stock_transito_1', u.stock_transito_1, 'stock_transito_2', u.stock_transito_2,
             'stock_transferencia', u.stock_transferencia,
             'stock_consignado', fila.stock_consignado, 'stock_en_proveedor', fila.stock_en_proveedor,
             'total_bloqueado', tot.total_bloqueado, 'total_transito_1', tot.total_transito_1,
             'total_transito_2', tot.total_transito_2, 'total_transferencia', tot.total_transferencia,
             'total_consignado', tot.total_consignado, 'total_en_proveedor', tot.total_en_proveedor)
             || case when fila.dueno <> '' then jsonb_build_object('dueno', fila.dueno) else '{}'::jsonb end
             order by u.storage_bin, u.sku_code, u.id) as skus
    from skus_universo_entrada_plan_lote(p_plan_ids) u
    cross join lateral (
      select case when (select debe_ocultar_stock_operador()) then null else s1.stock_consignado end   as stock_consignado,
             case when (select debe_ocultar_stock_operador()) then null else s1.stock_en_proveedor end as stock_en_proveedor,
             s1.dueno
      from skus s1 where s1.id = u.id
    ) fila
    cross join lateral (
      select sum(coalesce(s2.stock_bloqueado, 0))     as total_bloqueado,
             sum(coalesce(s2.stock_transito_1, 0))    as total_transito_1,
             sum(coalesce(s2.stock_transito_2, 0))    as total_transito_2,
             sum(coalesce(s2.stock_transferencia, 0)) as total_transferencia,
             sum(coalesce(s2.stock_consignado, 0))    as total_consignado,
             sum(coalesce(s2.stock_en_proveedor, 0))  as total_en_proveedor
      from skus s2
      where s2.empresa_id = (select empresa_actual()) and s2.sku_code = u.sku_code
        and s2.dueno = fila.dueno and s2.activo
    ) tot
    group by u.plan_id
  ) t;
$function$;

-- 3. Transferencia: el destino es del mismo dueño
create or replace function public.registrar_transferencia_bodega(p_lineas jsonb, p_bodega_destino text, p_ubicacion_destino text DEFAULT NULL::text, p_bin_destino text DEFAULT NULL::text, p_observacion text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_emp uuid := public.empresa_actual(); v_usuario uuid; v_doc public.documentos_bodega;
  v_linea jsonb; v_num text; v_mov public.movimientos_bodega; v_movs jsonb := '[]'::jsonb;
  v_origen public.skus; v_destino_id uuid; v_cant numeric;
  v_bod text := nullif(trim(coalesce(p_bodega_destino,'')), '');
  v_ubi text := nullif(trim(coalesce(p_ubicacion_destino,'')), '');
  v_bin text := nullif(trim(coalesce(p_bin_destino,'')), '');
begin
  perform public.exigir_funcion_bodega('transferencias', 'Los traslados entre bodegas');
  if jsonb_typeof(p_lineas) <> 'array' or jsonb_array_length(p_lineas) = 0 then
    raise exception 'La transferencia no tiene líneas';
  end if;
  if v_bod is null then raise exception 'Indica la bodega de destino'; end if;

  if p_idempotency_key is not null then
    select * into v_doc from documentos_bodega where idempotency_key = p_idempotency_key;
    if found then
      select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) into v_movs
        from movimientos_bodega m where m.documento_id = v_doc.id;
      return jsonb_build_object('documento', to_jsonb(v_doc), 'movimientos', v_movs, 'repetido', true);
    end if;
  end if;

  select u.id into v_usuario from usuarios u where u.auth_user_id = auth.uid() limit 1;
  v_num := public.siguiente_numero_bodega('transferencia');

  insert into documentos_bodega (empresa_id, tipo, numero, fecha, usuario_id, despachado_por_id,
                                 destino, observacion, idempotency_key)
  values (v_emp, 'transferencia', v_num, current_date, v_usuario, v_usuario,
          concat_ws(' · ', v_bod, v_ubi, v_bin), p_observacion, p_idempotency_key)
  returning * into v_doc;

  for v_linea in select * from jsonb_array_elements(p_lineas) loop
    v_cant := (v_linea->>'cantidad')::numeric;
    if v_cant is null or v_cant <= 0 then raise exception 'Cantidad inválida en la transferencia'; end if;

    select * into v_origen from skus where id = (v_linea->>'sku_id')::uuid and empresa_id = v_emp;
    if not found then raise exception 'Material no encontrado en esta empresa'; end if;

    if coalesce(v_origen.bodega,'') = coalesce(v_bod,'')
       and coalesce(v_origen.ubicacion,'') = coalesce(v_ubi,'')
       and coalesce(v_origen.storage_bin,'') = coalesce(v_bin,'') then
      raise exception 'El material % ya está en ese sitio', v_origen.sku_code;
    end if;

    -- El material llega al destino como del mismo dueño: el de otro cliente en ese sitio es otra
    -- fila, y la fila nueva nace con el dueño del origen.
    select id into v_destino_id from skus
     where empresa_id = v_emp and sku_code = v_origen.sku_code
       and dueno = v_origen.dueno
       and coalesce(batch,'') = coalesce(v_origen.batch,'')
       and coalesce(bodega,'') = coalesce(v_bod,'')
       and coalesce(ubicacion,'') = coalesce(v_ubi,'')
       and coalesce(storage_bin,'') = coalesce(v_bin,'');

    if v_destino_id is null then
      insert into skus (empresa_id, sku_code, descripcion, categoria, unidad_medida, batch,
                        bodega, ubicacion, storage_bin, stock_sistema, costo_unitario,
                        tipo_material, critico, activo, capturado_en, dueno)
      values (v_emp, v_origen.sku_code, v_origen.descripcion, v_origen.categoria,
              v_origen.unidad_medida, v_origen.batch, v_bod, v_ubi, v_bin, 0,
              v_origen.costo_unitario, v_origen.tipo_material, v_origen.critico, true, now(),
              v_origen.dueno)
      returning id into v_destino_id;
    elsif v_destino_id = v_origen.id then
      raise exception 'El material % ya está en ese sitio', v_origen.sku_code;
    else
      -- Una ficha desactivada en el destino vuelve a la vida: el material está llegando ahí.
      update skus set activo = true where id = v_destino_id and not activo;
    end if;

    insert into movimientos_bodega (empresa_id, documento_id, tipo, numero, sku_id, cantidad,
                                    fecha, usuario_id, costo_unitario, destino, motivo)
    values (v_emp, v_doc.id, 'transferencia_salida', v_num, v_origen.id, v_cant, current_date,
            v_usuario, v_origen.costo_unitario, concat_ws(' · ', v_bod, v_ubi, v_bin),
            'Traslado a ' || concat_ws(' · ', v_bod, v_ubi, v_bin))
    returning * into v_mov;
    v_movs := v_movs || to_jsonb(v_mov);

    insert into movimientos_bodega (empresa_id, documento_id, tipo, numero, sku_id, cantidad,
                                    fecha, usuario_id, costo_unitario, destino, motivo)
    values (v_emp, v_doc.id, 'transferencia_entrada', v_num, v_destino_id, v_cant, current_date,
            v_usuario, v_origen.costo_unitario,
            concat_ws(' · ', v_origen.bodega, v_origen.ubicacion, v_origen.storage_bin),
            'Traslado desde ' || concat_ws(' · ', v_origen.bodega, v_origen.ubicacion, v_origen.storage_bin))
    returning * into v_mov;
    v_movs := v_movs || to_jsonb(v_mov);
  end loop;

  return jsonb_build_object('documento', to_jsonb(v_doc), 'movimientos', v_movs, 'repetido', false);
end $function$;
