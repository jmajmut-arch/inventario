-- Dueños de stock: el Panel (Ejecutivo y Operativo) filtrado por dueño (Joel, 21/10/2026). Sigue
-- a 20261021_duenos_stock_resumen.sql.
--
-- El Panel de siempre no cambia: public.dashboard_ejecutivo(p_dias, p_criticidad) y
-- privado.dashboard_ejecutivo_calculo quedan como estaban. Se agregan:
-- 1. privado.dashboard_ejecutivo_calculo_dueno(p_dias, p_criticidad, p_dueno): las mismas
--    secciones, con las mismas consultas que las vistas y funciones que usa el de siempre
--    (avance_*, ranking_responsable, exactitud_*, reconteo_pendiente, valorizacion_diferencias,
--    avance_plan_por_ciclo, diferencias_recientes, skus_resumen_abc, resumen_general_skus_signos,
--    cierres con ajuste ERP y bodega), cada una acotada a los materiales del dueño
--    (s.dueno = p_dueno; '' = sin dueño). Verificación: en una empresa sin dueños, con p_dueno = ''
--    devuelve el mismo JSON que el de siempre (Escondida: todas las secciones iguales; Diario con
--    las mismas filas, en otro orden entre bodegas de un mismo día, que tampoco estaba fijado).
--    Medido como usuario de Escondida: un dueño con parte del stock, ~0,25 s; el peor caso (un
--    dueño con los 64.000 materiales) ~2 s, contra 0,65 s del Panel completo. El resumen ABC lee la
--    vista materializada directo y el avance del plan separa universo y contados (materialized):
--    con la vista y un semijoin, el peor caso tomaba 3,7 s.
-- 2. public.dashboard_ejecutivo(p_dias, p_criticidad, p_dueno): la misma puerta contra
--    sobrecarga (mismas claves 74100/74101: compite por los mismos lugares que el Panel de
--    siempre, es la misma carga), con TODOS sus parámetros obligatorios para que PostgREST no la
--    confunda con la de siempre cuando la app no manda p_dueno.

set local lock_timeout = '5s';

create or replace function privado.dashboard_ejecutivo_calculo_dueno(p_dias integer, p_criticidad text, p_dueno text)
 returns json
 language sql
 stable
 set search_path to 'public'
as $function$
  with numerados as (
    select c.id, c.sku_id, c.cantidad_contada, c.estado, c.fecha_conteo, c.ciclo_id, c.es_reconteo,
           sum(case when c.es_reconteo then 0 else 1 end)
             over (partition by c.sku_id, c.ciclo_id order by c.fecha_conteo, c.id
                   rows between unbounded preceding and current row) as conteo_n
    from conteos c
    join skus s on s.id = c.sku_id and s.dueno = p_dueno
  ),
  del_ciclo as (
    select c.*, s.bodega
    from numerados c
    join skus s on s.id = c.sku_id
    where c.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null
  ),
  ultimo_ciclo as (
    select distinct on (c.sku_id) c.sku_id, c.diferencia, c.ubicacion_distinta, c.bodega, c.fecha_conteo, c.cantidad_contada
    from conteos c
    join skus s on s.id = c.sku_id and s.dueno = p_dueno
    where c.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null
    order by c.sku_id, c.fecha_conteo desc
  )
  select json_build_object(
    'total', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from (
                  with contados as (
                    select distinct conteos.sku_id from conteos
                    where conteos.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null
                  )
                  select s.bodega, count(*) as skus_universo, count(c.sku_id) as skus_contados,
                         round(100.0 * count(c.sku_id)::numeric / nullif(count(*), 0)::numeric, 1) as porcentaje_avance
                  from skus s left join contados c on c.sku_id = s.id
                  where s.activo = true and s.dueno = p_dueno
                  group by s.bodega
                ) x),
    'diario', (select coalesce(json_agg(to_json(x) order by x.dia desc), '[]'::json)
                from (
                  select (date_trunc('day', (c.fecha_conteo at time zone 'America/Santiago')) at time zone 'America/Santiago') as dia,
                         c.bodega, count(*) as skus_contados,
                         count(*) filter (where c.estado = 'con_diferencia') as con_diferencia,
                         count(*) filter (where c.es_reconteo) as reconteos,
                         sum(c.cantidad_contada) as total_unidades_contadas,
                         count(*) filter (where not c.es_reconteo and c.conteo_n > 1) as repetidos
                  from del_ciclo c
                  group by 1, c.bodega
                  order by 1 desc limit 60
                ) x),
    'semanal', (select coalesce(json_agg(to_json(x) order by x.semana desc), '[]'::json)
                from (
                  select (date_trunc('week', (c.fecha_conteo at time zone 'America/Santiago')) at time zone 'America/Santiago') as semana,
                         c.bodega, count(*) as skus_contados,
                         count(*) filter (where c.estado = 'con_diferencia') as con_diferencia,
                         count(*) filter (where c.es_reconteo) as reconteos,
                         sum(c.cantidad_contada) as total_unidades_contadas,
                         count(*) filter (where not c.es_reconteo and c.conteo_n > 1) as repetidos
                  from del_ciclo c
                  group by 1, c.bodega
                  order by 1 desc limit 8
                ) x),
    'mensual', (select coalesce(json_agg(to_json(x) order by x.mes desc), '[]'::json)
                from (
                  select (date_trunc('month', (c.fecha_conteo at time zone 'America/Santiago')) at time zone 'America/Santiago') as mes,
                         c.bodega, count(*) as skus_contados,
                         count(*) filter (where c.estado = 'con_diferencia') as con_diferencia,
                         count(*) filter (where c.es_reconteo) as reconteos,
                         sum(c.cantidad_contada) as total_unidades_contadas,
                         count(*) filter (where not c.es_reconteo and c.conteo_n > 1) as repetidos
                  from del_ciclo c
                  group by 1, c.bodega
                  order by 1 desc limit 6
                ) x),
    'ranking', (select coalesce(json_agg(to_json(x)), '[]'::json)
                from (
                  select coalesce(u.nombre, 'Sin asignar') as nombre, count(*) as cantidad
                  from conteos c
                  join skus s on s.id = c.sku_id and s.dueno = p_dueno
                  left join usuarios u on u.id = c.usuario_id
                  where c.fecha_conteo >= (current_date - (p_dias - 1) * interval '1 day')
                    and (c.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null)
                  group by coalesce(u.nombre, 'Sin asignar')
                  order by cantidad desc
                  limit 20
                ) x),
    'exactitudBodega', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from (
                  select s.bodega, count(*) as skus_contados,
                         count(*) filter (where u.diferencia = 0) as sin_diferencia,
                         count(*) filter (where u.diferencia <> 0) as con_diferencia,
                         count(*) filter (where not u.ubicacion_distinta) as ubicacion_correcta
                  from ultimo_ciclo u join skus s on s.id = u.sku_id
                  where s.activo = true
                  group by s.bodega
                ) x),
    'exactitudMensual', (select coalesce(json_agg(to_json(x) order by x.mes), '[]'::json)
                from (
                  with ultimo as (
                    select distinct on (c.sku_id, (date_trunc('month', (c.fecha_conteo at time zone 'America/Santiago')) at time zone 'America/Santiago'))
                           c.sku_id,
                           (date_trunc('month', (c.fecha_conteo at time zone 'America/Santiago')) at time zone 'America/Santiago') as mes,
                           c.diferencia, c.ubicacion_distinta
                    from conteos c
                    join skus s on s.id = c.sku_id and s.dueno = p_dueno
                    order by c.sku_id, (date_trunc('month', (c.fecha_conteo at time zone 'America/Santiago')) at time zone 'America/Santiago'), c.fecha_conteo desc
                  )
                  select u.mes, s.bodega, count(*) as skus_contados,
                         count(*) filter (where u.diferencia = 0) as sin_diferencia,
                         count(*) filter (where u.diferencia <> 0) as con_diferencia,
                         count(*) filter (where not u.ubicacion_distinta) as ubicacion_correcta
                  from ultimo u join skus s on s.id = u.sku_id
                  where s.activo = true
                  group by u.mes, s.bodega
                ) x),
    'topDiferenciasPositivas', (select coalesce(json_agg(to_json(x) order by x.valor_diferencia_linea desc), '[]'::json)
                from (select * from reconteo_pendiente
                      where valor_diferencia_linea > 0 and dueno = p_dueno
                      order by valor_diferencia_linea desc limit 10) x),
    'topDiferenciasNegativas', (select coalesce(json_agg(to_json(x) order by x.valor_diferencia_linea), '[]'::json)
                from (select * from reconteo_pendiente
                      where valor_diferencia_linea < 0 and dueno = p_dueno
                      order by valor_diferencia_linea limit 10) x),
    'valorizacion', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from (
                  select s.bodega,
                         coalesce(sum(s.stock_sistema * s.costo_unitario), 0) as valor_contado,
                         coalesce(sum(u.diferencia * s.costo_unitario) filter (where u.diferencia < 0), 0) as valor_perdidas,
                         coalesce(sum(u.diferencia * s.costo_unitario) filter (where u.diferencia > 0), 0) as valor_excedentes
                  from ultimo_ciclo u join skus s on s.id = u.sku_id
                  where s.activo = true and s.costo_unitario is not null
                  group by s.bodega
                ) x),
    'avancePlanPorCiclo', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from (
                  with e as (
                    select plan_semanal.id, plan_semanal.empresa_id, plan_semanal.ciclo_id, plan_semanal.bodega,
                           nullif(plan_semanal.ubicacion, '') as ubicacion, nullif(plan_semanal.storage_bin, '') as bin,
                           plan_semanal.solo_sin_ubicacion, plan_semanal.ubicacion_nula, plan_semanal.por_sku
                    from plan_semanal
                  ), universo as (
                    select e.ciclo_id, s.id as sku_id, s.bodega, e.id as plan_id, s.sku_code
                    from e join plan_semanal_incluidos i on i.plan_id = e.id
                           join skus s on s.id = i.sku_id and s.empresa_id = e.empresa_id and s.activo
                    where e.por_sku
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega = e.bodega and s.ubicacion is null and s.storage_bin = e.bin
                    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and e.ubicacion_nula and e.bin is not null
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega = e.bodega and s.ubicacion is null
                    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and e.ubicacion_nula and e.bin is null
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega = e.bodega and s.ubicacion = e.ubicacion and s.storage_bin = e.bin
                    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula and e.ubicacion is not null and e.bin is not null
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega = e.bodega and s.ubicacion = e.ubicacion
                    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula and e.ubicacion is not null and e.bin is null
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega = e.bodega and s.storage_bin = e.bin
                    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula and e.ubicacion is null and e.bin is not null
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega = e.bodega
                    where not e.por_sku and not e.solo_sin_ubicacion and coalesce(e.bodega, '') <> '' and not e.ubicacion_nula and e.ubicacion is null and e.bin is null
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega is null
                           and (e.ubicacion_nula and s.ubicacion is null or not e.ubicacion_nula and (e.ubicacion is null or s.ubicacion = e.ubicacion))
                           and (e.bin is null or s.storage_bin = e.bin)
                    where not e.por_sku and not e.solo_sin_ubicacion and e.bodega = ''
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo and s.bodega is null and s.ubicacion is null
                    where not e.por_sku and e.solo_sin_ubicacion
                    union all
                    select e.ciclo_id, s.id, s.bodega, e.id, s.sku_code
                    from e join skus s on s.empresa_id = e.empresa_id and s.activo
                           and (e.ubicacion_nula and s.ubicacion is null or not e.ubicacion_nula and (e.ubicacion is null or s.ubicacion = e.ubicacion))
                           and (e.bin is null or s.storage_bin = e.bin)
                    where not e.por_sku and not e.solo_sin_ubicacion and e.bodega is null
                  ), u as materialized (
                    select distinct m.ciclo_id, m.sku_id, m.bodega
                    from universo m
                    where not exists (select 1 from plan_semanal_exclusiones x where x.plan_id = m.plan_id and x.sku_code = m.sku_code)
                      and exists (select 1 from skus s where s.id = m.sku_id and s.dueno = p_dueno)
                  ), contados as materialized (
                    select distinct c.ciclo_id, c.sku_id from conteos c where c.empresa_id = (select empresa_actual())
                  )
                  select u.ciclo_id, u.bodega, count(*) as total_planificados, count(c.sku_id) as contados
                  from u left join contados c on c.sku_id = u.sku_id and not c.ciclo_id is distinct from u.ciclo_id
                  group by u.ciclo_id, u.bodega
                ) x),
    'diferenciasRecientes', (select coalesce(json_agg(to_json(x)), '[]'::json)
                from (
                  select count(*) filter (where u.diferencia = 0) as sin_diferencia,
                         count(*) filter (where u.diferencia <> 0) as con_diferencia
                  from ultimo_ciclo u join skus s on s.id = u.sku_id
                  where s.activo = true
                    and u.fecha_conteo >= now() - (p_dias || ' days')::interval
                ) x),
    'resumenAbc', (select coalesce(json_agg(to_json(x) order by x.clase_abc), '[]'::json)
                from (
                  with v as (
                    select s.id as sku_id, mv.valor_total, mv.pct_acumulado, mv.clase_abc from skus s join privado.skus_valor_abc_empresa_mv mv on mv.sku_id = s.id where s.activo = true and mv.empresa_id = (select empresa_actual()) and s.dueno = p_dueno
                  ), agg as (
                    select coalesce(v.clase_abc, 'Sin clasificar') as clase_abc, count(*) as cantidad_sku, sum(v.valor_total) as valor_total
                    from v group by 1
                  ), contados as (
                    select coalesce(v.clase_abc, 'Sin clasificar') as clase_abc, count(distinct c.sku_id) as skus_contados
                    from v join conteos c on c.sku_id = v.sku_id and (c.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null)
                    group by 1
                  )
                  select a.clase_abc, a.cantidad_sku,
                         round(100.0 * a.cantidad_sku::numeric / sum(a.cantidad_sku) over (), 1) as pct_sku,
                         round(a.valor_total) as valor_total,
                         round(100.0 * a.valor_total / nullif(sum(a.valor_total) over (), 0), 1) as pct_valor,
                         coalesce(ct.skus_contados, 0) as skus_contados,
                         round(100.0 * coalesce(ct.skus_contados, 0)::numeric / nullif(a.cantidad_sku, 0)::numeric, 1) as pct_avance
                  from agg a left join contados ct on ct.clase_abc = a.clase_abc
                ) x),
    'resumenGeneral', (select coalesce(json_agg(to_json(x)), '[]'::json)
                from (
                  select
                    count(*) as total_activo,
                    count(*) filter (where s.ultimo_conteo_id is null) as no_contado,
                    count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                                       and s.ultimo_conteo_estado <> 'pendiente_revision') as cuadrado,
                    count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) <> 0) as con_diferencia,
                    case when (select debe_ocultar_stock_operador()) then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia < 0) end as merma,
                    case when (select debe_ocultar_stock_operador()) then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia > 0) end as excedente,
                    count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                                       and s.ultimo_conteo_estado = 'pendiente_revision') as pendiente
                  from skus s
                  where s.activo = true and s.empresa_id = (select empresa_actual()) and s.dueno = p_dueno
                    and (p_criticidad is distinct from 'criticos' or s.critico = true)
                    and (p_criticidad is distinct from 'no_criticos' or s.critico = false)
                ) x),
    'cierresAjusteErp', (select json_build_object(
                  'n', count(*),
                  'valor', coalesce(sum(abs(c.diferencia) * coalesce(s.costo_unitario, 0)), 0))
                from conteos c join skus s on s.id = c.sku_id
                where c.reconteo_cierre_tipo = 'ajuste_erp'
                  and c.empresa_id = (select empresa_actual())
                  and s.dueno = p_dueno
                  and (c.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null)),
    'bodega', (case when modulo_bodega_activo() then json_build_object(
        'pendientes', (case when es_admin_actual()
                       then (select coalesce(json_agg(to_json(x) order by x.created_at), '[]'::json)
                             from movimientos_bodega_pendientes x
                             where exists (select 1 from skus s where s.id = x.sku_id and s.dueno = p_dueno))
                       else '[]'::json end),
        'ultimosMovimientos', (select coalesce(json_agg(y.fila order by y.created_at desc), '[]'::json)
                       from (select x.created_at,
                                    (select to_json(z) from (select x.id, x.numero, x.tipo, x.sku_code, x.cantidad,
                                                                    x.unidad_medida, x.estado, x.fecha, x.usuario_nombre) z) as fila
                             from movimientos_bodega_detalle x
                             where x.dueno = p_dueno
                             order by x.created_at desc limit 6) y),
        'valorizacion', (select jsonb_build_object(
                  'valor_total', coalesce(sum(case when costo_unitario is not null then stock * costo_unitario end), 0),
                  'skus_con_costo', count(*) filter (where costo_unitario is not null and stock > 0),
                  'skus_sin_costo', count(*) filter (where costo_unitario is null and stock > 0),
                  'skus_con_stock', count(*) filter (where stock > 0),
                  'bajo_minimo', count(*) filter (where bajo_minimo),
                  'sin_apertura', count(*) filter (where stock > 0 and not exists (
                    select 1 from movimientos_bodega m where m.sku_id = stock_actual.sku_id)))
                from stock_actual where stock_actual.dueno = p_dueno)
      ) else null end)
  );
$function$;

create or replace function public.dashboard_ejecutivo(p_dias integer, p_criticidad text, p_dueno text)
 returns json
 language plpgsql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_inicio timestamptz := clock_timestamp();
  v_dentro boolean := false;
begin
  -- La misma puerta que el Panel de siempre (ver 20261013_proteccion_sobrecarga.sql), con las
  -- mismas claves: el Panel filtrado por dueño compite por los mismos lugares.
  for v_slot in 1..6 loop
    if pg_try_advisory_xact_lock(74100, v_slot) then
      v_dentro := true;
      exit;
    end if;
  end loop;
  if not v_dentro then
    raise exception 'Hay muchos paneles calculándose a la vez. Reintenta en unos segundos.'
      using errcode = '53400';
  end if;

  loop
    for v_slot in 1..3 loop
      if pg_try_advisory_xact_lock(74101, v_slot) then
        return privado.dashboard_ejecutivo_calculo_dueno(p_dias, p_criticidad, p_dueno);
      end if;
    end loop;
    if clock_timestamp() - v_inicio > interval '8 seconds' then
      raise exception 'Hay muchos paneles calculándose a la vez. Reintenta en unos segundos.'
        using errcode = '53400';
    end if;
    perform pg_sleep(0.1);
  end loop;
end;
$function$;

revoke all on function privado.dashboard_ejecutivo_calculo_dueno(integer, text, text) from public, anon;
grant execute on function privado.dashboard_ejecutivo_calculo_dueno(integer, text, text) to authenticated;
revoke all on function public.dashboard_ejecutivo(integer, text, text) from public, anon;
grant execute on function public.dashboard_ejecutivo(integer, text, text) to authenticated;
