-- Stock en poder del proveedor (SAP "Special Stock Type" = O) por material, y desglose por fila
-- del consignado en Contar desde el plan. Aplicada el 27/09/2026 por MCP como "stock_en_proveedor".
--
-- Las líneas O no tienen bin porque el material está fuera de la bodega, en poder del proveedor
-- (en Escondida, 935 líneas con 4.207 unidades). Se cargaban como SKU "sin ubicación" con stock
-- positivo y aparecían en Plan como si hubiera que contarlas. Ahora la carga no las convierte en
-- fila contable: su cantidad queda en stock_en_proveedor de una fila del mismo material (o en una
-- fila propia con stock 0 si el material no viene de otra forma) y se muestra consolidada por
-- código como "En prov." en la tarjeta, igual que el tránsito y el consignado.
--
-- universo_entradas_plan_contar además trae stock_consignado y stock_en_proveedor de la propia
-- fila (enmascarados para conteo ciego), para que la tarjeta de Contar desde el plan pueda
-- mostrar "SOH x + SOH consignado y". Se toman con un lateral por id, sin cambiar la firma de
-- skus_universo_entrada_plan_lote.

alter table public.skus add column if not exists stock_en_proveedor numeric;
comment on column public.skus.stock_en_proveedor is 'Unidades del material en poder del proveedor (SAP tipo especial O). Informativo: no están en la bodega y no entran en stock_sistema.';

create or replace view public.skus_lectura with (security_invoker = true) as
 SELECT s.id, s.sku_code, s.descripcion, s.categoria, s.unidad_medida, s.ubicacion, s.bodega,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_sistema END AS stock_sistema,
    s.activo, s.created_at, s.updated_at, s.storage_bin, s.empresa_id, s.capturado_en, s.codigo_barras, s.bodega_key, s.costo_unitario, s.batch, s.batch_key, s.critico,
    s.ultimo_conteo_id, s.ultimo_conteo_fecha, s.ultimo_conteo_estado, s.ultimo_conteo_diferencia, s.ultimo_conteo_cantidad, s.ultimo_conteo_capturado_en, s.ultimo_conteo_fuera_de_plan, s.ultimo_conteo_ciclo_id, s.ultimo_conteo_usuario_id,
    s.clase_abc, s.pct_acumulado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_sistema_anterior END AS stock_sistema_anterior,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::timestamp with time zone ELSE s.stock_sistema_actualizado_en END AS stock_sistema_actualizado_en,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_bloqueado END AS stock_bloqueado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_transito_1 END AS stock_transito_1,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_transito_2 END AS stock_transito_2,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_transferencia END AS stock_transferencia,
    s.ubicacion_key, s.storage_bin_key, s.tipo_material, s.stock_minimo,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_bloqueado END AS total_bloqueado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_transito_1 END AS total_transito_1,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_transito_2 END AS total_transito_2,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_transferencia END AS total_transferencia,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_consignado END AS stock_consignado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_consignado END AS total_consignado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_en_proveedor END AS stock_en_proveedor,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_en_proveedor END AS total_en_proveedor
   FROM skus s
   CROSS JOIN LATERAL (
     SELECT sum(COALESCE(s2.stock_bloqueado, 0::numeric)) AS total_bloqueado,
            sum(COALESCE(s2.stock_transito_1, 0::numeric)) AS total_transito_1,
            sum(COALESCE(s2.stock_transito_2, 0::numeric)) AS total_transito_2,
            sum(COALESCE(s2.stock_transferencia, 0::numeric)) AS total_transferencia,
            sum(COALESCE(s2.stock_consignado, 0::numeric)) AS total_consignado,
            sum(COALESCE(s2.stock_en_proveedor, 0::numeric)) AS total_en_proveedor
       FROM skus s2
      WHERE s2.empresa_id = s.empresa_id AND s2.sku_code = s.sku_code AND s2.activo) tot;

create or replace view public.reconteo_pendiente with (security_invoker = true) as
 WITH conteos_sku AS MATERIALIZED (
   SELECT c.id, c.sku_id, c.usuario_id, c.cantidad_contada, c.ubicacion_contada, c.bodega, c.foto_url, c.observacion, c.estado, c.diferencia, c.fecha_conteo, c.empresa_id, c.capturado_en, c.ciclo_id, c.fuera_de_plan, c.ubicacion_distinta, c.reconteo_descartado_en, c.cantidad_original, c.corregido_en, c.motivo_correccion,
          row_number() OVER (PARTITION BY c.sku_id ORDER BY c.fecha_conteo) AS numero_conteo
     FROM conteos c
    WHERE c.ciclo_id = (SELECT ciclo_actual()) OR (SELECT ciclo_actual()) IS NULL
 ), ultimo AS MATERIALIZED (
   SELECT DISTINCT ON (conteos_sku.sku_id) conteos_sku.id, conteos_sku.sku_id, conteos_sku.usuario_id, conteos_sku.cantidad_contada, conteos_sku.ubicacion_contada, conteos_sku.bodega, conteos_sku.foto_url, conteos_sku.observacion, conteos_sku.estado, conteos_sku.diferencia, conteos_sku.fecha_conteo, conteos_sku.empresa_id, conteos_sku.capturado_en, conteos_sku.ciclo_id, conteos_sku.fuera_de_plan, conteos_sku.ubicacion_distinta, conteos_sku.reconteo_descartado_en, conteos_sku.cantidad_original, conteos_sku.corregido_en, conteos_sku.motivo_correccion, conteos_sku.numero_conteo
     FROM conteos_sku
    ORDER BY conteos_sku.sku_id, conteos_sku.fecha_conteo DESC
 ), historial_diferencias AS MATERIALIZED (
   SELECT conteos_sku.sku_id, count(*) AS veces_con_diferencia FROM conteos_sku WHERE conteos_sku.diferencia <> 0::numeric GROUP BY conteos_sku.sku_id
 ), fotos_sku AS MATERIALIZED (
   SELECT cs.sku_id, jsonb_agg(jsonb_build_object('foto_url', cf.foto_url, 'numero_conteo', cs.numero_conteo, 'fecha_conteo', cs.fecha_conteo) ORDER BY cs.fecha_conteo, cf.created_at) AS fotos
     FROM conteos_sku cs JOIN conteo_fotos cf ON cf.conteo_id = cs.id GROUP BY cs.sku_id
 ), reincidencia AS MATERIALIZED (
   SELECT ult_por_ciclo.sku_id, count(*) AS ciclos_previos_con_diferencia
     FROM (SELECT DISTINCT ON (c.sku_id, c.ciclo_id) c.sku_id, c.ciclo_id, c.diferencia
             FROM conteos c
            WHERE (c.sku_id IN (SELECT ultimo.sku_id FROM ultimo)) AND (SELECT ciclo_actual()) IS NOT NULL AND c.ciclo_id IS NOT NULL AND c.ciclo_id <> (SELECT ciclo_actual()) AND c.reconteo_descartado_en IS NULL
            ORDER BY c.sku_id, c.ciclo_id, c.fecha_conteo DESC) ult_por_ciclo
    WHERE ult_por_ciclo.diferencia <> 0::numeric GROUP BY ult_por_ciclo.sku_id
 )
 SELECT s.id, s.sku_code, s.descripcion, s.categoria, s.unidad_medida, s.ubicacion, s.bodega,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_sistema END AS stock_sistema,
    u.cantidad_contada AS ultima_cantidad_contada,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE u.diferencia END AS ultima_diferencia,
    u.fecha_conteo AS ultimo_conteo_fecha,
    COALESCE(f.fotos, '[]'::jsonb) AS fotos,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE abs(u.diferencia) END AS diferencia_abs,
    u.ubicacion_contada, u.bodega AS bodega_contada, u.ubicacion_distinta,
    COALESCE(h.veces_con_diferencia, 0::bigint) > 1 AS diferencia_recurrente,
    COALESCE(h.veces_con_diferencia, 0::bigint) AS veces_con_diferencia,
    CASE WHEN u.ubicacion_distinta AND COALESCE(h.veces_con_diferencia, 0::bigint) > 1 THEN 'Ubicación distinta y recurrente'::text
         WHEN u.ubicacion_distinta THEN 'Ubicación distinta'::text
         WHEN COALESCE(h.veces_con_diferencia, 0::bigint) > 1 THEN 'Diferencia recurrente'::text
         ELSE 'Sin patrón detectado'::text END AS causa_probable,
    s.costo_unitario,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE u.diferencia * s.costo_unitario END AS valor_diferencia_linea,
    s.storage_bin, s.batch, s.critico, s.clase_abc,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_sistema_anterior END AS stock_sistema_anterior,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::timestamp with time zone ELSE s.stock_sistema_actualizado_en END AS stock_sistema_actualizado_en,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_bloqueado END AS stock_bloqueado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_transito_1 END AS stock_transito_1,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_transito_2 END AS stock_transito_2,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_transferencia END AS stock_transferencia,
    u.id AS conteo_id,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_bloqueado END AS total_bloqueado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_transito_1 END AS total_transito_1,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_transito_2 END AS total_transito_2,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_transferencia END AS total_transferencia,
    (COALESCE(rc.ciclos_previos_con_diferencia, 0::bigint) + 1)::integer AS ciclos_con_diferencia,
    COALESCE(rc.ciclos_previos_con_diferencia, 0::bigint) >= 1 AS reincidente,
    u.usuario_id AS contado_por_id, u.capturado_en, u.observacion, u.cantidad_original, u.corregido_en, u.motivo_correccion,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_consignado END AS stock_consignado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_consignado END AS total_consignado,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE s.stock_en_proveedor END AS stock_en_proveedor,
    CASE WHEN (SELECT debe_ocultar_stock_operador()) THEN NULL::numeric ELSE tot.total_en_proveedor END AS total_en_proveedor
   FROM ultimo u
   JOIN skus s ON s.id = u.sku_id
   CROSS JOIN LATERAL (
     SELECT sum(COALESCE(s2.stock_bloqueado, 0::numeric)) AS total_bloqueado,
            sum(COALESCE(s2.stock_transito_1, 0::numeric)) AS total_transito_1,
            sum(COALESCE(s2.stock_transito_2, 0::numeric)) AS total_transito_2,
            sum(COALESCE(s2.stock_transferencia, 0::numeric)) AS total_transferencia,
            sum(COALESCE(s2.stock_consignado, 0::numeric)) AS total_consignado,
            sum(COALESCE(s2.stock_en_proveedor, 0::numeric)) AS total_en_proveedor
       FROM skus s2 WHERE s2.empresa_id = s.empresa_id AND s2.sku_code = s.sku_code AND s2.activo) tot
   LEFT JOIN historial_diferencias h ON h.sku_id = u.sku_id
   LEFT JOIN fotos_sku f ON f.sku_id = u.sku_id
   LEFT JOIN reincidencia rc ON rc.sku_id = u.sku_id
  WHERE u.diferencia <> 0::numeric AND s.activo = true AND u.reconteo_descartado_en IS NULL
  ORDER BY u.fecha_conteo DESC;

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
             order by u.storage_bin, u.sku_code, u.id) as skus
    from skus_universo_entrada_plan_lote(p_plan_ids) u
    cross join lateral (
      select case when (select debe_ocultar_stock_operador()) then null else s1.stock_consignado end   as stock_consignado,
             case when (select debe_ocultar_stock_operador()) then null else s1.stock_en_proveedor end as stock_en_proveedor
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
      where s2.empresa_id = (select empresa_actual()) and s2.sku_code = u.sku_code and s2.activo
    ) tot
    group by u.plan_id
  ) t;
$function$;
