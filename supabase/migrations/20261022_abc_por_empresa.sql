-- Clasificación ABC por empresa, no de todas a la vez (Joel, 22/10/2026).
--
-- refrescar_clasificacion_abc (la app la llama al terminar cada carga de Excel) hacía
-- `refresh materialized view concurrently privado.skus_valor_abc_empresa_mv` -- la vista de TODAS las
-- empresas -- y después actualizaba skus de todas. Una carga de 229 materiales de Agunsa esperaba el
-- recálculo de los ~64.500 de Escondida, y escribía en materiales de otra empresa. Promedio medido
-- en pg_stat_statements: 5,8 s por llamada; una vez superó los 20 s y falló (21/10/2026, 10:26),
-- y mientras corría las listas de ubicaciones de Plan y Contar llegaron a 3,5-4,7 s.
--
-- Ahora:
--  * privado.recalcular_abc_empresa(empresa) calcula la clase de UNA empresa directo desde skus, con
--    la misma fórmula y el mismo orden que la vista materializada, y actualiza solo las filas cuya
--    clase cambió (igual que antes: pct_acumulado se escribe junto con la clase; actualizar el
--    porcentaje de todas las filas costaba 3,8 s y ninguna pantalla lo muestra).
--    Medido en Escondida: 0,44 s el cálculo, idéntico a la vista materializada (0 diferencias de
--    clase y de porcentaje en 64.565 materiales).
--  * Un turno por empresa (advisory lock 74103 + empresa): dos cargas seguidas de la misma empresa
--    no recalculan en paralelo. Claves en uso: 74100, 74101, 74102 y ahora 74103.
--  * refrescar_clasificacion_abc recalcula solo la empresa de quien llama.
--  * La tarea nocturna recalcula empresa por empresa (privado.recalcular_abc_todas).
--  * skus_valor_abc y el Panel por dueño leen la clase de skus y el valor en vivo (costo x stock),
--    en vez de la vista materializada. La vista materializada queda sin uso; se puede borrar después
--    (ver el final).
-- Verificado antes de aplicar, dentro de una transacción revertida: la salida del Panel (completo y
-- por dueño), skus_resumen_abc y pagina_skus es idéntica antes y después.

set local lock_timeout = '5s';

create or replace function privado.recalcular_abc_empresa(p_empresa uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_cambiadas integer := 0;
  v_limpiadas integer := 0;
begin
  if p_empresa is null then
    return 0;
  end if;
  -- Un recálculo a la vez por empresa (ver arriba).
  perform pg_advisory_xact_lock(74103, hashtext(p_empresa::text));

  with valorizado as (
    select s.id, s.costo_unitario,
           coalesce(s.costo_unitario, 0) * coalesce(s.stock_sistema, 0) as valor_total
    from public.skus s
    where s.empresa_id = p_empresa and s.activo = true
  ), acumulado as (
    select v.*,
           sum(v.valor_total) over (order by v.valor_total desc, v.id) as valor_acumulado,
           sum(v.valor_total) over () as valor_total_empresa
    from valorizado v
  ), clasificado as (
    select a.id,
           case when a.costo_unitario is null then null::numeric
                else round(100.0 * a.valor_acumulado / nullif(a.valor_total_empresa, 0), 1) end as pct_acumulado,
           case when a.costo_unitario is null or coalesce(a.valor_total_empresa, 0) = 0 then null::text
                when a.valor_acumulado / nullif(a.valor_total_empresa, 0) <= 0.80 then 'A'
                when a.valor_acumulado / nullif(a.valor_total_empresa, 0) <= 0.95 then 'B'
                else 'C' end as clase_abc
    from acumulado a
  )
  update public.skus s
  set clase_abc = c.clase_abc, pct_acumulado = c.pct_acumulado
  from clasificado c
  where c.id = s.id
    and s.clase_abc is distinct from c.clase_abc;
  get diagnostics v_cambiadas = row_count;

  -- Los materiales inactivos no tienen clase (antes: los que no estaban en la vista materializada,
  -- que solo tenía activos).
  update public.skus s
  set clase_abc = null, pct_acumulado = null
  where s.empresa_id = p_empresa and s.activo = false and s.clase_abc is not null;
  get diagnostics v_limpiadas = row_count;

  return v_cambiadas + v_limpiadas;
end;
$function$;
revoke all on function privado.recalcular_abc_empresa(uuid) from public, anon, authenticated;

create or replace function privado.recalcular_abc_todas()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  e record;
  v_total integer := 0;
begin
  for e in select id from public.empresas where activo order by id loop
    v_total := v_total + privado.recalcular_abc_empresa(e.id);
  end loop;
  return v_total;
end;
$function$;
revoke all on function privado.recalcular_abc_todas() from public, anon, authenticated;

create or replace function public.refrescar_clasificacion_abc()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not (es_admin_actual() or es_super_admin()) then
    raise exception 'Solo un administrador puede refrescar la clasificación ABC';
  end if;
  -- Solo la empresa de quien llama (ver privado.recalcular_abc_empresa).
  perform privado.recalcular_abc_empresa((select empresa_actual()));
end;
$function$;

-- Misma forma que antes (sku_id, valor_total, pct_acumulado, clase_abc), desde skus: la clase la
-- mantiene recalcular_abc_empresa y el valor se calcula en vivo.
create or replace view public.skus_valor_abc with (security_invoker = true) as
 SELECT s.id AS sku_id,
    (COALESCE(s.costo_unitario, (0)::numeric) * COALESCE(s.stock_sistema, (0)::numeric)) AS valor_total,
    s.pct_acumulado,
    s.clase_abc
   FROM skus s
  WHERE ((s.activo = true) AND (s.empresa_id = ( SELECT empresa_actual() AS empresa_actual)));

-- El Panel por dueño leía la vista materializada directo: mismo cambio que skus_valor_abc.
do $ajuste$
declare
  d text;
  viejo constant text := 'select s.id as sku_id, mv.valor_total, mv.pct_acumulado, mv.clase_abc from skus s join privado.skus_valor_abc_empresa_mv mv on mv.sku_id = s.id where s.activo = true and mv.empresa_id = (select empresa_actual()) and s.dueno = p_dueno';
  nuevo constant text := 'select s.id as sku_id, coalesce(s.costo_unitario, 0) * coalesce(s.stock_sistema, 0) as valor_total, s.pct_acumulado, s.clase_abc from skus s where s.activo = true and s.empresa_id = (select empresa_actual()) and s.dueno = p_dueno';
begin
  d := pg_get_functiondef('privado.dashboard_ejecutivo_calculo_dueno(integer,text,text)'::regprocedure);
  if position(viejo in d) = 0 then
    raise exception 'dashboard_ejecutivo_calculo_dueno no tiene el texto esperado: revisar antes de aplicar';
  end if;
  execute replace(d, viejo, nuevo);
end;
$ajuste$;

-- La tarea nocturna, empresa por empresa (cron.schedule con el mismo nombre reemplaza el comando).
select cron.schedule('refrescar-clasificacion-abc-nocturno', '0 7 * * *', $cron$select privado.recalcular_abc_todas()$cron$);

comment on materialized view privado.skus_valor_abc_empresa_mv is
  'Sin uso desde 20261022_abc_por_empresa.sql (la clase vive en skus y se recalcula por empresa). Se puede borrar.';
