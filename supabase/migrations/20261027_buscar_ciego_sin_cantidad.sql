-- Buscar con conteo ciego: el operador tampoco ve lo contado (27/10/2026).
--
-- Mismo criterio que 20261027_reconteo_ciego_sin_cantidad_anterior.sql para Reconteo: con conteo
-- ciego, ver lo que se contó la vez anterior ancla el próximo conteo. skus_busqueda (la fila de
-- Buscar, sus fichas PDF y su Excel, vía filas_busqueda_skus) manda ahora en null al operador
-- cantidad_contada y cantidad_original. Pedido de Joel.
--
-- Solo cambian esas dos expresiones (mismo nombre, tipo y orden de columnas: filas_busqueda_skus
-- devuelve SETOF skus_busqueda); el resto es la definición de 20261021_duenos_stock_lectura.sql.
-- "Contado" en Buscar se decide por conteo_id, no por la cantidad: un material contado sigue
-- apareciendo como contado. Un administrador sigue viendo todo. Al aplicarse, ninguna empresa
-- tenía el conteo ciego prendido.

set local lock_timeout = '5s';

create or replace view public.skus_busqueda with (security_invoker = true) as
 SELECT s.id AS sku_id,
    s.sku_code,
    s.descripcion,
    s.bodega,
    s.ubicacion,
    s.storage_bin,
    s.empresa_id,
    s.ultimo_conteo_id AS conteo_id,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.ultimo_conteo_cantidad
        END AS cantidad_contada,
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
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE co.cantidad_original
        END AS cantidad_original,
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
