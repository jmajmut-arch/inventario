-- Funciones de lectura que llamaban a empresa_actual() / ciclo_actual() fila por fila.
--
-- Escrito a secas en un WHERE o en un JOIN (`c.ciclo_id = ciclo_actual()`), Postgres evalúa la
-- función por cada fila que examina: son STABLE, no IMMUTABLE, y no se inlinean (SECURITY
-- DEFINER). Envueltas en `(select ...)` se evalúan una sola vez por consulta (InitPlan). Las
-- vistas y las políticas RLS ya venían así; estas funciones no. Medido el 29/09/2026 con la
-- cuenta de Joel en Escondida: ranking_responsable 185 ms (563 conteos -> 1.126 llamadas a
-- ciclo_actual, cada una con su join usuarios/empresas); explica también las 862.000 lecturas
-- completas de la tabla usuarios en tres semanas de pg_stat_statements.
--
-- Solo cambia dónde se evalúa la función: mismos parámetros, mismo tipo de retorno, mismos
-- resultados (comprobado con md5 de la salida antes y después, con datos reales).

create or replace function public.ranking_responsable(dias integer default 14)
returns table(nombre text, cantidad bigint)
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(u.nombre, 'Sin asignar') as nombre, count(*) as cantidad
  from public.conteos c
  left join public.usuarios u on u.id = c.usuario_id
  where c.fecha_conteo >= (current_date - (dias - 1) * interval '1 day')
    and (c.ciclo_id = (select public.ciclo_actual()) or (select public.ciclo_actual()) is null)
  group by coalesce(u.nombre, 'Sin asignar')
  order by cantidad desc
  limit 20;
$function$;

create or replace function public.contar_criticos_distintos()
returns bigint
language sql
stable
set search_path to 'public'
as $function$
  select count(distinct (sku_code, coalesce(bodega,'')))
  from public.skus
  where activo and critico and empresa_id = (select public.empresa_actual())
$function$;

create or replace function public.resumen_general_skus(p_fecha_desde timestamp with time zone default null, p_fecha_hasta timestamp with time zone default null, p_criticidad text default null)
returns table(total_activo bigint, no_contado bigint, cuadrado bigint, con_diferencia bigint, pendiente bigint)
language plpgsql
stable
set search_path to 'public'
as $function$
begin
  if p_criticidad = 'criticos' then
    return query
      select
        count(*) as total_activo,
        count(*) filter (where ultimo_conteo_id is null) as no_contado,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) = 0 and ultimo_conteo_estado <> 'pendiente_revision') as cuadrado,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) <> 0) as con_diferencia,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) = 0 and ultimo_conteo_estado = 'pendiente_revision') as pendiente
      from public.skus s
      where s.activo = true and s.empresa_id = (select public.empresa_actual()) and s.critico = true;
  elsif p_criticidad = 'no_criticos' then
    return query
      select
        count(*) as total_activo,
        count(*) filter (where ultimo_conteo_id is null) as no_contado,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) = 0 and ultimo_conteo_estado <> 'pendiente_revision') as cuadrado,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) <> 0) as con_diferencia,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) = 0 and ultimo_conteo_estado = 'pendiente_revision') as pendiente
      from public.skus s
      where s.activo = true and s.empresa_id = (select public.empresa_actual()) and s.critico = false;
  else
    return query
      select
        count(*) as total_activo,
        count(*) filter (where ultimo_conteo_id is null) as no_contado,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) = 0 and ultimo_conteo_estado <> 'pendiente_revision') as cuadrado,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) <> 0) as con_diferencia,
        count(*) filter (where ultimo_conteo_id is not null and (p_fecha_desde is null or ultimo_conteo_fecha >= p_fecha_desde) and (p_fecha_hasta is null or ultimo_conteo_fecha < p_fecha_hasta) and coalesce(ultimo_conteo_diferencia,0) = 0 and ultimo_conteo_estado = 'pendiente_revision') as pendiente
      from public.skus s
      where s.activo = true and s.empresa_id = (select public.empresa_actual());
  end if;
end;
$function$;

create or replace function public.posiciones_por_grupo(p_grupo_ids uuid[])
returns table(grupo_id uuid, materiales integer, posiciones integer)
language sql
stable
set search_path to 'public'
as $function$
  with g as (
    select id, automatico_critico
    from grupos_conteo
    where id = any(p_grupo_ids) and empresa_id = (select empresa_actual())
  ),
  manual as (
    select g.id as grupo_id,
           count(distinct (m.sku_code, coalesce(m.bodega,''))) as materiales,
           (select count(*) from skus s
             where s.empresa_id = (select empresa_actual()) and s.activo
               and exists (select 1 from skus_grupos_conteo m2
                           where m2.grupo_id = g.id and m2.sku_code = s.sku_code
                             and coalesce(m2.bodega,'') = coalesce(s.bodega,''))) as posiciones
    from g
    left join skus_grupos_conteo m on m.grupo_id = g.id
    where not g.automatico_critico
    group by g.id
  ),
  automatico as (
    select g.id as grupo_id,
           (select count(distinct (s.sku_code, coalesce(s.bodega,''))) from skus s
             where s.empresa_id = (select empresa_actual()) and s.activo and s.critico) as materiales,
           (select count(*) from skus s
             where s.empresa_id = (select empresa_actual()) and s.activo and s.critico) as posiciones
    from g
    where g.automatico_critico
  )
  select grupo_id, materiales::integer, posiciones::integer from manual
  union all
  select grupo_id, materiales::integer, posiciones::integer from automatico;
$function$;

create or replace function public.resumen_plan_grupos(p_grupo_ids uuid[])
returns table(grupo_id uuid, entradas integer, desde date, hasta date, por_venir integer, skus_por_contar integer)
language sql
stable
set search_path to 'public'
as $function$
  with g as (
    select id, nombre from grupos_conteo
    where id = any(p_grupo_ids) and empresa_id = (select empresa_actual())
  ),
  p as materialized (
    select g.id as grupo_id, ps.id, ps.fecha
    from g
    join plan_semanal ps
      on ps.empresa_id = (select empresa_actual())
     and ps.nota = 'Generado automáticamente por el grupo "' || g.nombre || '"'
  ),
  u as materialized (
    select x.plan_id, x.id as sku_id
    from skus_universo_entrada_plan_lote((select array_agg(id) from p)) x
  ),
  s as (
    select p.grupo_id, count(distinct u.sku_id) as skus
    from p join u on u.plan_id = p.id
    group by p.grupo_id
  )
  select g.id as grupo_id,
         count(p.id)::integer as entradas,
         min(p.fecha) as desde,
         max(p.fecha) as hasta,
         count(p.id) filter (where p.fecha >= current_date)::integer as por_venir,
         coalesce(max(s.skus), 0)::integer as skus_por_contar
  from g
  left join p on p.grupo_id = g.id
  left join s on s.grupo_id = g.id
  group by g.id;
$function$;

create or replace function public.resumen_calendario_mes(p_mes date default current_date)
returns table(fecha date, planificado integer, contado integer, recontado integer, pendiente integer)
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
  numerados as (
    select c.sku_id, c.ciclo_id, c.fecha_conteo,
           row_number() over (partition by c.sku_id, c.ciclo_id order by c.fecha_conteo) as numero_conteo
    from conteos c
    where c.empresa_id = (select empresa_actual())
      and (c.ciclo_id = (select id from ciclo) or (select id from ciclo) is null)
      and c.fecha_conteo >= date_trunc('month', p_mes)::date
      and c.fecha_conteo < (date_trunc('month', p_mes) + interval '1 month')::date
      and ((select v from ve_todo) or c.usuario_id = (select id from yo))
  ),
  contados as (
    select
      (date_trunc('day', fecha_conteo at time zone 'America/Santiago') at time zone 'America/Santiago')::date as fecha,
      count(*) filter (where numero_conteo = 1) as n_contados,
      count(*) filter (where numero_conteo > 1) as n_recontados
    from numerados
    group by 1
  )
  select
    d.fecha,
    coalesce(p.n, 0)::int as planificado,
    coalesce(c.n_contados, 0)::int as contado,
    coalesce(c.n_recontados, 0)::int as recontado,
    coalesce(p.n_pendientes, 0)::int as pendiente
  from dias d
  left join planificados p on p.fecha = d.fecha
  left join contados c on c.fecha = d.fecha
  order by d.fecha;
$function$;

create or replace function public.dashboard_ejecutivo(p_dias integer default 14, p_criticidad text default null)
returns json
language sql
stable
set search_path to 'public'
as $function$
  select json_build_object(
    'total', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from avance_total x),
    'diario', (select coalesce(json_agg(to_json(x) order by x.dia desc), '[]'::json)
                from (select * from avance_diario order by dia desc limit 60) x),
    'semanal', (select coalesce(json_agg(to_json(x) order by x.semana desc), '[]'::json)
                from (select * from avance_semanal order by semana desc limit 8) x),
    'mensual', (select coalesce(json_agg(to_json(x) order by x.mes desc), '[]'::json)
                from (select * from avance_mensual order by mes desc limit 6) x),
    'ranking', (select coalesce(json_agg(to_json(x)), '[]'::json)
                from ranking_responsable(p_dias) x),
    'exactitudBodega', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from exactitud_por_bodega x),
    'exactitudMensual', (select coalesce(json_agg(to_json(x) order by x.mes), '[]'::json)
                from exactitud_mensual x),
    'topDiferenciasPositivas', (select coalesce(json_agg(to_json(x) order by x.valor_diferencia_linea desc), '[]'::json)
                from (select * from reconteo_pendiente
                      where valor_diferencia_linea > 0
                      order by valor_diferencia_linea desc limit 10) x),
    'topDiferenciasNegativas', (select coalesce(json_agg(to_json(x) order by x.valor_diferencia_linea), '[]'::json)
                from (select * from reconteo_pendiente
                      where valor_diferencia_linea < 0
                      order by valor_diferencia_linea limit 10) x),
    'valorizacion', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from valorizacion_diferencias x),
    'avancePlanPorCiclo', (select coalesce(json_agg(to_json(x) order by x.bodega), '[]'::json)
                from avance_plan_por_ciclo x),
    'diferenciasRecientes', (select coalesce(json_agg(to_json(x)), '[]'::json)
                from diferencias_recientes(p_dias) x),
    'resumenAbc', (select coalesce(json_agg(to_json(x) order by x.clase_abc), '[]'::json)
                from skus_resumen_abc x),
    -- El resumen del maestro llega ya filtrado por la criticidad que tenga puesta la pantalla:
    -- sin eso, recargar el panel después de guardar un conteo borraría el filtro sin avisar.
    'resumenGeneral', (select coalesce(json_agg(to_json(x)), '[]'::json)
                from resumen_general_skus(null, null, p_criticidad) x),
    -- Reconteos cerrados con ajuste en el ERP en el ciclo actual (o en total si la empresa no
    -- usa ciclos): cuántos y cuánto valían las diferencias que se ajustaron (abs, en $).
    'cierresAjusteErp', (select json_build_object(
                  'n', count(*),
                  'valor', coalesce(sum(abs(c.diferencia) * coalesce(s.costo_unitario, 0)), 0))
                from conteos c join skus s on s.id = c.sku_id
                where c.reconteo_cierre_tipo = 'ajuste_erp'
                  and c.empresa_id = (select empresa_actual())
                  and (c.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null)),
    'bodega', (case when modulo_bodega_activo() then json_build_object(
        'pendientes', (case when es_admin_actual()
                       then (select coalesce(json_agg(to_json(x) order by x.created_at), '[]'::json)
                             from movimientos_bodega_pendientes x)
                       else '[]'::json end),
        -- json_agg sobre la fila ya recortada (y.fila) para devolver exactamente las columnas que
        -- pedía la app, sin arrastrar created_at solo porque hace falta para ordenar.
        'ultimosMovimientos', (select coalesce(json_agg(y.fila order by y.created_at desc), '[]'::json)
                       from (select x.created_at,
                                    (select to_json(z) from (select x.id, x.numero, x.tipo, x.sku_code, x.cantidad,
                                                                    x.unidad_medida, x.estado, x.fecha, x.usuario_nombre) z) as fila
                             from movimientos_bodega_detalle x
                             order by x.created_at desc limit 6) y),
        'valorizacion', resumen_valorizacion_bodega()
      ) else null end)
  );
$function$;
