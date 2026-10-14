-- Reconteo es solo lo que se cuenta desde la pantalla Reconteo (Joel, 14/10/2026).
--
-- Hasta hoy, cualquier segundo conteo de un material en el período se llamaba "reconteo": en las
-- fotos ("Reconteo 1"), en la columna "Reconteos" del Panel y en la "R" del Calendario, aunque el
-- conteo anterior estuviera cuadrado y nadie lo hubiera mandado a recontar. La regla nueva:
--
--   * conteos.es_reconteo: la app lo marca al guardar desde el botón Recontar (y la cola sin
--     conexión lo lleva). Todo lo demás es un conteo, aunque sea la 2.ª o 3.ª vez.
--   * Numeración "Conteo N.M": N = cuántas veces se contó el material en el período (los conteos
--     que no son reconteo); M = cuántos reconteos lleva ese conteo N. Conté y cuadró -> 1; lo volví
--     a contar -> 2; salió con diferencia y lo recontaron desde Reconteo -> 2.1, 2.2; otro conteo
--     normal -> 3. Si un período empieza con un reconteo (sin conteo anterior en el período), se
--     muestra como 1.1.
--   * Panel (avance_diario/semanal/mensual): "reconteos" cuenta solo los marcados; columna nueva
--     "repetidos" = conteos que no son reconteo y no son el primero del período.
--   * Calendario: resumen_calendario_dias (nueva, con "repetido"); resumen_calendario_mes queda
--     igual por fuera para las versiones de la app que aún la llamen y lee de la nueva. Además la
--     numeración se hace sobre todo el período, no solo sobre el mes que se mira.
--   * Fotos (skus_busqueda y reconteo_pendiente): cada foto trae "conteo" y "reconteo" además del
--     numero_conteo de siempre (que sigue igual para versiones anteriores de la app).
--
-- Conteos ya guardados: no se sabe desde qué pantalla se hicieron. Se marcan como reconteo los que
-- se guardaron cuando el conteo anterior del mismo material y período tenía una diferencia sin
-- cerrar: justo lo que ofrece la pantalla Reconteo. En Escondida: 37 de los 58 que hoy figuran
-- como reconteo; los otros 21 (el anterior estaba cuadrado) pasan a "repetidos".
--
-- Para marcarlos se apagan, solo dentro de esta transacción, los triggers de conteos:
-- calcular_diferencia_conteo recalcula la diferencia con el stock DE HOY en cualquier UPDATE (sin
-- apagarlo, marcar un conteo viejo le cambiaría la diferencia), y los demás sincronizarían skus,
-- tomarían turnos y escribirían auditoría por un cambio que no toca ningún dato del conteo. Otras
-- sesiones nunca los ven apagados: el ALTER TABLE las hace esperar hasta el COMMIT, y antes del
-- COMMIT vuelven a quedar encendidos.

set local lock_timeout = '5s';

alter table public.conteos add column es_reconteo boolean not null default false;
comment on column public.conteos.es_reconteo is
  'true si se guardó desde Recontar (pantalla Reconteo). Los conteos anteriores al 14/10/2026 se marcaron si el conteo previo del mismo material y período tenía una diferencia sin cerrar.';

alter table public.conteos disable trigger auditoria_conteos;
alter table public.conteos disable trigger trg_calcular_diferencia;
alter table public.conteos disable trigger trg_conteos_turno_sku;
alter table public.conteos disable trigger trg_sincronizar_ultimo_conteo_sku;

with n as (
  select c.id,
         lag(c.id) over w as id_anterior,
         lag(c.diferencia) over w as diferencia_anterior,
         lag(c.reconteo_descartado_en) over w as cerrado_anterior
  from public.conteos c
  window w as (partition by c.sku_id, c.ciclo_id order by c.fecha_conteo, c.id)
)
update public.conteos c
set es_reconteo = true
from n
where n.id = c.id
  and n.id_anterior is not null
  and coalesce(n.diferencia_anterior, 0) <> 0
  and n.cerrado_anterior is null;

alter table public.conteos enable trigger auditoria_conteos;
alter table public.conteos enable trigger trg_calcular_diferencia;
alter table public.conteos enable trigger trg_conteos_turno_sku;
alter table public.conteos enable trigger trg_sincronizar_ultimo_conteo_sku;

-- ---------------------------------------------------------------------------------------------
-- Panel: "reconteos" solo los marcados; "repetidos" al final (columna nueva).
-- ---------------------------------------------------------------------------------------------
create or replace view public.avance_diario with (security_invoker = true) as
 WITH numerados AS (
         SELECT c_1.id,
            c_1.sku_id,
            c_1.cantidad_contada,
            c_1.estado,
            c_1.fecha_conteo,
            c_1.ciclo_id,
            c_1.es_reconteo,
            sum(CASE WHEN c_1.es_reconteo THEN 0 ELSE 1 END) OVER (PARTITION BY c_1.sku_id, c_1.ciclo_id ORDER BY c_1.fecha_conteo, c_1.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS conteo_n
           FROM conteos c_1
        )
 SELECT (date_trunc('day'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text) AS dia,
    s.bodega,
    count(*) AS skus_contados,
    count(*) FILTER (WHERE c.estado = 'con_diferencia'::text) AS con_diferencia,
    count(*) FILTER (WHERE c.es_reconteo) AS reconteos,
    sum(c.cantidad_contada) AS total_unidades_contadas,
    count(*) FILTER (WHERE NOT c.es_reconteo AND c.conteo_n > 1) AS repetidos
   FROM numerados c
     JOIN skus s ON s.id = c.sku_id
  WHERE c.ciclo_id = (( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual)) IS NULL
  GROUP BY ((date_trunc('day'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text)), s.bodega
  ORDER BY ((date_trunc('day'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text)) DESC;

create or replace view public.avance_semanal with (security_invoker = true) as
 WITH numerados AS (
         SELECT c_1.id,
            c_1.sku_id,
            c_1.cantidad_contada,
            c_1.estado,
            c_1.fecha_conteo,
            c_1.ciclo_id,
            c_1.es_reconteo,
            sum(CASE WHEN c_1.es_reconteo THEN 0 ELSE 1 END) OVER (PARTITION BY c_1.sku_id, c_1.ciclo_id ORDER BY c_1.fecha_conteo, c_1.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS conteo_n
           FROM conteos c_1
        )
 SELECT (date_trunc('week'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text) AS semana,
    s.bodega,
    count(*) AS skus_contados,
    count(*) FILTER (WHERE c.estado = 'con_diferencia'::text) AS con_diferencia,
    count(*) FILTER (WHERE c.es_reconteo) AS reconteos,
    sum(c.cantidad_contada) AS total_unidades_contadas,
    count(*) FILTER (WHERE NOT c.es_reconteo AND c.conteo_n > 1) AS repetidos
   FROM numerados c
     JOIN skus s ON s.id = c.sku_id
  WHERE c.ciclo_id = (( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual)) IS NULL
  GROUP BY ((date_trunc('week'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text)), s.bodega
  ORDER BY ((date_trunc('week'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text)) DESC;

create or replace view public.avance_mensual with (security_invoker = true) as
 WITH numerados AS (
         SELECT c_1.id,
            c_1.sku_id,
            c_1.cantidad_contada,
            c_1.estado,
            c_1.fecha_conteo,
            c_1.ciclo_id,
            c_1.es_reconteo,
            sum(CASE WHEN c_1.es_reconteo THEN 0 ELSE 1 END) OVER (PARTITION BY c_1.sku_id, c_1.ciclo_id ORDER BY c_1.fecha_conteo, c_1.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS conteo_n
           FROM conteos c_1
        )
 SELECT (date_trunc('month'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text) AS mes,
    s.bodega,
    count(*) AS skus_contados,
    count(*) FILTER (WHERE c.estado = 'con_diferencia'::text) AS con_diferencia,
    count(*) FILTER (WHERE c.es_reconteo) AS reconteos,
    sum(c.cantidad_contada) AS total_unidades_contadas,
    count(*) FILTER (WHERE NOT c.es_reconteo AND c.conteo_n > 1) AS repetidos
   FROM numerados c
     JOIN skus s ON s.id = c.sku_id
  WHERE c.ciclo_id = (( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual)) IS NULL
  GROUP BY ((date_trunc('month'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text)), s.bodega
  ORDER BY ((date_trunc('month'::text, (c.fecha_conteo AT TIME ZONE 'America/Santiago'::text)) AT TIME ZONE 'America/Santiago'::text)) DESC;

-- ---------------------------------------------------------------------------------------------
-- Buscar: cada foto trae "conteo" y "reconteo" (Conteo N.M); la fila trae el N.M de su último
-- conteo (ultimo_conteo_n, ultimo_reconteo_n, columnas nuevas al final). numero_conteo sigue igual.
-- ---------------------------------------------------------------------------------------------
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
    fotos.reconteo_n::integer AS ultimo_reconteo_n
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
                    sum(CASE WHEN c.es_reconteo THEN 0 ELSE 1 END) OVER (PARTITION BY c.ciclo_id ORDER BY c.fecha_conteo, c.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS conteo_n
                   FROM conteos c
                  WHERE c.sku_id = s.id
                ), cn AS (
                 SELECT cs.id,
                    cs.fecha_conteo,
                    cs.numero_conteo,
                    GREATEST(cs.conteo_n, 1::bigint) AS conteo_n,
                    sum(CASE WHEN cs.es_reconteo THEN 1 ELSE 0 END) OVER (PARTITION BY cs.ciclo_id, cs.conteo_n ORDER BY cs.fecha_conteo, cs.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS reconteo_n
                   FROM cs
                )
         SELECT ( SELECT jsonb_agg(jsonb_build_object('foto_url', cf.foto_url, 'numero_conteo', cn.numero_conteo, 'fecha_conteo', cn.fecha_conteo, 'conteo', cn.conteo_n, 'reconteo', cn.reconteo_n) ORDER BY cn.fecha_conteo, cf.created_at) AS jsonb_agg
                   FROM cn
                     JOIN conteo_fotos cf ON cf.conteo_id = cn.id) AS items,
            ( SELECT cn.conteo_n FROM cn WHERE cn.id = s.ultimo_conteo_id) AS conteo_n,
            ( SELECT cn.reconteo_n FROM cn WHERE cn.id = s.ultimo_conteo_id) AS reconteo_n) fotos ON true
  WHERE s.activo = true;

-- ---------------------------------------------------------------------------------------------
-- Pantalla Reconteo: cada foto trae "conteo" y "reconteo" (Conteo N.M). Las columnas de la vista
-- no cambian; solo el contenido de "fotos".
-- ---------------------------------------------------------------------------------------------
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
            sum(CASE WHEN c.es_reconteo THEN 0 ELSE 1 END) OVER (PARTITION BY c.sku_id, c.ciclo_id ORDER BY c.fecha_conteo, c.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS conteo_n
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
                    sum(CASE WHEN conteos_sku.es_reconteo THEN 1 ELSE 0 END) OVER (PARTITION BY conteos_sku.sku_id, conteos_sku.ciclo_id, conteos_sku.conteo_n ORDER BY conteos_sku.fecha_conteo, conteos_sku.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS reconteo_n
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
        END AS total_en_proveedor
   FROM ultimo u
     JOIN skus s ON s.id = u.sku_id
     CROSS JOIN LATERAL ( SELECT sum(COALESCE(s2.stock_bloqueado, 0::numeric)) AS total_bloqueado,
            sum(COALESCE(s2.stock_transito_1, 0::numeric)) AS total_transito_1,
            sum(COALESCE(s2.stock_transito_2, 0::numeric)) AS total_transito_2,
            sum(COALESCE(s2.stock_transferencia, 0::numeric)) AS total_transferencia,
            sum(COALESCE(s2.stock_consignado, 0::numeric)) AS total_consignado,
            sum(COALESCE(s2.stock_en_proveedor, 0::numeric)) AS total_en_proveedor
           FROM skus s2
          WHERE s2.empresa_id = s.empresa_id AND s2.sku_code = s.sku_code AND s2.activo) tot
     LEFT JOIN historial_diferencias h ON h.sku_id = u.sku_id
     LEFT JOIN fotos_sku f ON f.sku_id = u.sku_id
     LEFT JOIN reincidencia rc ON rc.sku_id = u.sku_id
  WHERE u.diferencia <> 0::numeric AND s.activo = true AND u.reconteo_descartado_en IS NULL
  ORDER BY u.fecha_conteo DESC;

-- ---------------------------------------------------------------------------------------------
-- Calendario: "recontado" = solo reconteos; "repetido" (nuevo) = conteos que no son reconteo ni el
-- primero del material en el período; "contado" = primer conteo del período. La numeración se hace
-- sobre todo el período (antes se reiniciaba en cada mes mirado). Mismos filtros de siempre: la
-- empresa, el período actual y, para un operador, solo sus propios conteos.
-- ---------------------------------------------------------------------------------------------
create or replace function public.resumen_calendario_dias(p_mes date default current_date)
 returns table(fecha date, planificado integer, contado integer, recontado integer, repetido integer, pendiente integer)
 language sql
 stable
 set search_path to 'public'
as $function$
  with yo as (
    select id, rol, es_super_admin
    from usuarios
    where auth_user_id = auth.uid() and activo = true
  ),
  ve_todo as (
    select coalesce((select rol from yo) = 'admin' or (select es_super_admin from yo), false) as v
  ),
  ciclo as (
    select ciclo_actual() as id
  ),
  dias as (
    select generate_series(
      date_trunc('month', p_mes)::date,
      (date_trunc('month', p_mes) + interval '1 month - 1 day')::date,
      interval '1 day'
    )::date as fecha
  ),
  entradas as (
    select ps.id, ps.fecha, ps.empresa_id, ps.bodega, ps.ubicacion,
           nullif(ps.storage_bin, '') as bin, ps.solo_sin_ubicacion, ps.ubicacion_nula, ps.por_sku
    from plan_semanal ps
    where ps.empresa_id = (select empresa_actual())
      and ps.fecha >= date_trunc('month', p_mes)::date
      and ps.fecha < (date_trunc('month', p_mes) + interval '1 month')::date
      and (
        (select v from ve_todo)
        or ps.responsable_id = (select id from yo)
      )
  ),
  matches as (
    -- caso 0: por código de SKU (lista explícita)
    select e.id as plan_id, e.fecha, s.id as sku_id, s.sku_code
    from entradas e
    join plan_semanal_incluidos i on i.plan_id = e.id
    join skus s on s.id = i.sku_id and s.activo = true
    where e.por_sku
    union all
    -- caso 1a: ubicacion_nula (bodega conocida, sin ubicación específica), con bin
    select e.id as plan_id, e.fecha, s.id as sku_id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.activo = true and s.bodega = e.bodega
               and s.ubicacion is null and s.storage_bin = e.bin
    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and e.ubicacion_nula and e.bin is not null
    union all
    -- caso 1a, sin bin
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.activo = true and s.bodega = e.bodega
               and s.ubicacion is null
    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and e.ubicacion_nula and e.bin is null
    union all
    -- caso 1b: ubicación específica, con bin
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.activo = true and s.bodega = e.bodega
               and s.ubicacion = e.ubicacion and s.storage_bin = e.bin
    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula
      and coalesce(e.ubicacion, '') <> '' and e.bin is not null
    union all
    -- caso 1b, sin bin (toda la ubicación)
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.activo = true and s.bodega = e.bodega
               and s.ubicacion = e.ubicacion
    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula
      and coalesce(e.ubicacion, '') <> '' and e.bin is null
    union all
    -- caso 1c: comodín de ubicación (toda la bodega), con bin
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.activo = true and s.bodega = e.bodega
               and s.storage_bin = e.bin
    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula
      and coalesce(e.ubicacion, '') = '' and e.bin is not null
    union all
    -- caso 1c, sin bin (toda la bodega, escaneo inevitable)
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.activo = true and s.bodega = e.bodega
    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula
      and coalesce(e.ubicacion, '') = '' and e.bin is null
    union all
    -- caso 2: "sin bodega asignada" (bodega='' en el plan -> s.bodega IS NULL)
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.bodega is null and s.activo = true
    where not e.por_sku and not e.solo_sin_ubicacion and e.bodega = ''
      and (coalesce(e.ubicacion, '') = '' or s.ubicacion = e.ubicacion)
      and (e.bin is null or s.storage_bin = e.bin)
    union all
    -- caso 3: solo_sin_ubicacion (SKU "sueltos": sin bodega ni ubicación)
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.bodega is null and s.ubicacion is null and s.activo = true
    where not e.por_sku and e.solo_sin_ubicacion
    union all
    -- caso 4: comodín de bodega (bodega NULL): residual, ningún plan real lo usa hoy
    select e.id, e.fecha, s.id, s.sku_code
    from entradas e
    join skus s on s.empresa_id = e.empresa_id and s.activo = true
    where not e.por_sku and not e.solo_sin_ubicacion and e.bodega is null
      and (coalesce(e.ubicacion, '') = '' or s.ubicacion = e.ubicacion)
      and (e.bin is null or s.storage_bin = e.bin)
  ),
  contados_ciclo as (
    select distinct c.sku_id
    from conteos c
    where c.empresa_id = (select empresa_actual())
      and (c.ciclo_id = (select id from ciclo) or (select id from ciclo) is null)
  ),
  planificados as (
    select m.fecha,
           count(distinct m.sku_id) as n,
           count(distinct m.sku_id) filter (where cc.sku_id is null) as n_pendientes
    from matches m
    left join contados_ciclo cc on cc.sku_id = m.sku_id
    where not exists (
      select 1 from plan_semanal_exclusiones pe where pe.plan_id = m.plan_id and pe.sku_code = m.sku_code
    )
    group by m.fecha
  ),
  -- Numeración sobre todo el período (ver arriba): conteo_n cuenta los conteos que no son reconteo.
  numerados as (
    select c.fecha_conteo, c.usuario_id, c.es_reconteo,
           sum(case when c.es_reconteo then 0 else 1 end) over (
             partition by c.sku_id, c.ciclo_id order by c.fecha_conteo, c.id
             rows between unbounded preceding and current row) as conteo_n
    from conteos c
    where c.empresa_id = (select empresa_actual())
      and (c.ciclo_id = (select id from ciclo) or (select id from ciclo) is null)
  ),
  contados as (
    select
      (date_trunc('day', fecha_conteo at time zone 'America/Santiago') at time zone 'America/Santiago')::date as fecha,
      count(*) filter (where not es_reconteo and conteo_n = 1) as n_contados,
      count(*) filter (where es_reconteo) as n_recontados,
      count(*) filter (where not es_reconteo and conteo_n > 1) as n_repetidos
    from numerados
    where fecha_conteo >= date_trunc('month', p_mes)::date
      and fecha_conteo < (date_trunc('month', p_mes) + interval '1 month')::date
      and ((select v from ve_todo) or usuario_id = (select id from yo))
    group by 1
  )
  select
    d.fecha,
    coalesce(p.n, 0)::int as planificado,
    coalesce(c.n_contados, 0)::int as contado,
    coalesce(c.n_recontados, 0)::int as recontado,
    coalesce(c.n_repetidos, 0)::int as repetido,
    coalesce(p.n_pendientes, 0)::int as pendiente
  from dias d
  left join planificados p on p.fecha = d.fecha
  left join contados c on c.fecha = d.fecha
  order by d.fecha;
$function$;

revoke execute on function public.resumen_calendario_dias(date) from public, anon;
grant execute on function public.resumen_calendario_dias(date) to authenticated;

-- La de siempre, con las mismas columnas, para las versiones de la app que aún la llamen.
create or replace function public.resumen_calendario_mes(p_mes date default current_date)
 returns table(fecha date, planificado integer, contado integer, recontado integer, pendiente integer)
 language sql
 stable
 set search_path to 'public'
as $function$
  select d.fecha, d.planificado, d.contado, d.recontado, d.pendiente
  from resumen_calendario_dias(p_mes) d;
$function$;
