-- Reconteo con conteo ciego: el operador tampoco ve lo contado antes (27/10/2026).
--
-- Con conteo ciego (empresas.conteo_ciego_habilitado), reconteo_pendiente ya le mandaba en null al
-- operador el stock del sistema, la diferencia, su valor y "ya calza". Pero ultima_cantidad_contada
-- (lo que se contó la vez anterior) y cantidad_original (lo contado antes de una corrección) seguían
-- llegando, y la tabla de Reconteo los mostraba: un operador que ve "12" tiende a recontar 12. El
-- aviso del formulario de reconteo ya omitía esa cantidad por la misma razón; ahora la vista
-- tampoco la manda. Pedido de Joel.
--
-- Solo cambian esas dos expresiones (mismo nombre, tipo y orden de columnas); el resto es la
-- definición de 20261022_reconteo_valor_y_stock_calza.sql. Ninguna función lee esas dos columnas
-- (revisado en pg_proc: descartar_reconteo, marcar_ciclo_actual, los buscadores y el Dashboard
-- leen la vista sin ellas). Un administrador sigue viendo todo. Al aplicarse, ninguna empresa tenía
-- el conteo ciego prendido.

set local lock_timeout = '5s';

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
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE u.cantidad_contada
        END AS ultima_cantidad_contada,
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
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE u.cantidad_original
        END AS cantidad_original,
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
    s.dueno,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE abs(u.diferencia * s.costo_unitario)
        END AS valor_diferencia_abs,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::boolean
            ELSE COALESCE(s.stock_sistema_actualizado_en > u.fecha_conteo AND s.stock_sistema = u.cantidad_contada, false)
        END AS stock_ya_calza
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
