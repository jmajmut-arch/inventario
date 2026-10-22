-- El universo de una lista de entradas del plan, planificado con la lista real (Joel, 22/10/2026).
--
-- skus_universo_entrada_plan_lote era LANGUAGE sql con SET search_path: Postgres no la inlinea y
-- planifica su cuerpo una vez, sin conocer p_plan_ids. Ese plan "a ciegas" tardaba 2,7-3 s con las
-- ~300-400 entradas de un período o del grupo Críticos de Escondida, cuando la misma consulta con la
-- lista conocida tarda ~130 ms. La usan seis funciones (resumen_entradas_plan, universo_entradas_
-- plan_resumen, _contar, _hoja, skus_universo_entrada_plan y resumen_plan_grupos), así que pegaba
-- en Plan (Mes/Año/Período), Grupos (resumen_plan_grupos: 2,9 s en cada visita), la hoja PDF y
-- Contar. Medido en producción con pg_stat/edge logs del 21/10/2026.
--
-- Ahora es plpgsql con RETURN QUERY EXECUTE: cada llamada se planifica con la lista real (~5 ms de
-- planificación). El cuerpo es el mismo, texto por texto; solo p_plan_ids pasa a $1. Verificado con
-- datos reales antes de aplicar, comparando fila por fila (md5) la versión anterior y esta, como
-- admin de Escondida, operador de Escondida, admin de Agunsa (dueños) y operador de la Demo:
--   grupo Críticos (314 entradas): 2.763 -> 122 ms; período (388): 2.985 -> 139 ms;
--   un día (16): 455 -> 32 ms; una entrada: 28 -> 25 ms. Resultados idénticos en todos.
-- Sigue STABLE y SECURITY INVOKER (RLS de quien llama). Misma firma y mismos permisos.

set local lock_timeout = '5s';

create or replace function public.skus_universo_entrada_plan_lote(p_plan_ids uuid[])
 returns table(plan_id uuid, id uuid, sku_code text, descripcion text, bodega text, ubicacion text, storage_bin text, batch text, unidad_medida text, stock_sistema numeric, critico boolean, clase_abc text, stock_bloqueado numeric, stock_transito_1 numeric, stock_transito_2 numeric, stock_transferencia numeric)
 language plpgsql
 stable
 set search_path to 'public'
as $function$
begin
  -- EXECUTE planifica con la lista real en cada llamada (ver arriba). Los nombres de columna de
  -- RETURNS TABLE no chocan con los de la consulta: el texto no lo interpreta plpgsql.
  return query execute $consulta$
  with p as (
    select * from plan_semanal where id = any($1) and not por_sku
  ),
  pi as (
    select * from plan_semanal where id = any($1) and por_sku
  ),
  m as (
    -- I: por código de SKU (lista explícita en plan_semanal_incluidos)
    select pi.id as plan_id, s.* from pi
    join plan_semanal_incluidos i on i.plan_id = pi.id
    join skus_planificables s on s.id = i.sku_id
    union all
    -- A: ubicación específica, con storage bin
    select p.id as plan_id, s.* from p
    join skus_planificables s on s.bodega = p.bodega and s.ubicacion = p.ubicacion and s.storage_bin = p.storage_bin
    where not p.solo_sin_ubicacion and coalesce(p.bodega,'') <> '' and not p.ubicacion_nula
      and coalesce(p.ubicacion,'') <> '' and coalesce(p.storage_bin,'') <> ''
    union all
    -- B: ubicación específica, sin storage bin (toda la ubicación)
    select p.id, s.* from p
    join skus_planificables s on s.bodega = p.bodega and s.ubicacion = p.ubicacion
    where not p.solo_sin_ubicacion and coalesce(p.bodega,'') <> '' and not p.ubicacion_nula
      and coalesce(p.ubicacion,'') <> '' and coalesce(p.storage_bin,'') = ''
    union all
    -- D: comodín de ubicación, con storage bin (ese bin en cualquier ubicación de la bodega)
    select p.id, s.* from p
    join skus_planificables s on s.bodega = p.bodega and s.storage_bin = p.storage_bin
    where not p.solo_sin_ubicacion and coalesce(p.bodega,'') <> '' and not p.ubicacion_nula
      and coalesce(p.ubicacion,'') = '' and coalesce(p.storage_bin,'') <> ''
    union all
    -- E: comodín de ubicación, sin storage bin (toda la bodega)
    select p.id, s.* from p
    join skus_planificables s on s.bodega = p.bodega
    where not p.solo_sin_ubicacion and coalesce(p.bodega,'') <> '' and not p.ubicacion_nula
      and coalesce(p.ubicacion,'') = '' and coalesce(p.storage_bin,'') = ''
    union all
    -- F: bodega conocida, "sin ubicación específica" (ubicacion_nula): solo SKU con ubicación NULL
    select p.id, s.* from p
    join skus_planificables s on s.bodega = p.bodega and s.ubicacion is null
    where not p.solo_sin_ubicacion and coalesce(p.bodega,'') <> '' and p.ubicacion_nula
      and (coalesce(p.storage_bin,'') = '' or s.storage_bin = p.storage_bin)
    union all
    -- G: SKU sueltos (sin bodega ni ubicación)
    select p.id, s.* from p
    join skus_planificables s on s.bodega is null and s.ubicacion is null
    where p.solo_sin_ubicacion
    union all
    -- H: "sin bodega asignada" (bodega '' en el plan -> skus.bodega IS NULL)
    select p.id, s.* from p
    join skus_planificables s on s.bodega is null
    where not p.solo_sin_ubicacion and p.bodega = ''
      and ((p.ubicacion_nula and s.ubicacion is null)
           or (not p.ubicacion_nula and (coalesce(p.ubicacion,'') = '' or s.ubicacion = p.ubicacion)))
      and (coalesce(p.storage_bin,'') = '' or s.storage_bin = p.storage_bin)
    union all
    -- C: comodín total de bodega (bodega NULL): residual, ningún plan real lo usa hoy
    select p.id, s.* from p
    join skus_planificables s on true
    where not p.solo_sin_ubicacion and p.bodega is null
      and ((p.ubicacion_nula and s.ubicacion is null)
           or (not p.ubicacion_nula and (coalesce(p.ubicacion,'') = '' or s.ubicacion = p.ubicacion)))
      and (coalesce(p.storage_bin,'') = '' or s.storage_bin = p.storage_bin)
  )
  select m.plan_id, m.id, m.sku_code, m.descripcion, m.bodega, m.ubicacion, m.storage_bin,
         m.batch, m.unidad_medida, m.stock_sistema, m.critico, m.clase_abc,
         m.stock_bloqueado, m.stock_transito_1, m.stock_transito_2, m.stock_transferencia
  from m
  join plan_semanal pd on pd.id = m.plan_id
  where (pd.dueno is null or m.dueno = pd.dueno)
    and not exists (
    select 1 from plan_semanal_exclusiones e
    where e.plan_id = m.plan_id and e.sku_code = m.sku_code
  )
  order by m.plan_id, m.storage_bin, m.sku_code, m.id
  $consulta$ using p_plan_ids;
end;
$function$;
