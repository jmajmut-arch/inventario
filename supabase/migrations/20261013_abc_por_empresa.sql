-- Clasificación ABC: la vista materializada guarda la empresa y skus_valor_abc lee solo la suya
-- (13/10/2026).
--
-- privado.skus_valor_abc_mv no tenía empresa_id: skus_valor_abc (y con ella skus_resumen_abc, el
-- resumen ABC del Dashboard, y pagina_skus) recorría las ~182.000 filas de todas las empresas y
-- las cruzaba con los materiales de la propia. Ahora una vista materializada nueva,
-- privado.skus_valor_abc_empresa_mv, tiene el mismo cálculo (mismas particiones por empresa, mismos
-- redondeos y cortes 80/95) más la columna empresa_id con su índice, y skus_valor_abc filtra por
-- empresa_actual() antes de cruzar.
--
-- Se crea una nueva en vez de rehacer la anterior para no tener que borrar skus_valor_abc ni
-- skus_resumen_abc (que dependen de ella): create or replace view cambia la vista en su lugar, con
-- las mismas columnas. La anterior queda sin uso y sin refresco; se puede borrar más adelante.
-- El refresco nocturno (pg_cron, 07:00 UTC) y refrescar_clasificacion_abc() pasan a la nueva.
--
-- Comparado antes y después en una transacción revertida (con la anterior recién refrescada),
-- como Escondida, Joel (súper admin), __CARGA_1__ y __CARGA_2__: dashboard_ejecutivo,
-- skus_resumen_abc, pagina_skus (primera página y la 40.000) y los totales de skus_valor_abc,
-- idénticos. Escondida: dashboard_ejecutivo 463 -> 386 ms, skus_resumen_abc 132 -> 107 ms,
-- pagina_skus(40000, 200) 1.012 -> 623 ms.
--
-- skus_valor_abc sin usuario (empresa_actual() null, p. ej. con service_role) ahora devuelve cero
-- filas en vez de todas: nadie la usa así (la usan dashboard_ejecutivo y pagina_skus, siempre
-- como el usuario), y es lo que corresponde a una vista por empresa.

set local lock_timeout = '5s';

create materialized view privado.skus_valor_abc_empresa_mv as
  with valorizado as (
    select s.id as sku_id,
           s.empresa_id,
           s.costo_unitario,
           coalesce(s.costo_unitario, 0::numeric) * coalesce(s.stock_sistema, 0::numeric) as valor_total
    from public.skus s
    where s.activo = true
  ), acumulado as (
    select v.sku_id,
           v.empresa_id,
           v.costo_unitario,
           v.valor_total,
           sum(v.valor_total) over (partition by v.empresa_id order by v.valor_total desc, v.sku_id) as valor_acumulado,
           sum(v.valor_total) over (partition by v.empresa_id) as valor_total_empresa
    from valorizado v
  )
  select sku_id,
         empresa_id,
         valor_total,
         case
           when costo_unitario is null then null::numeric
           else round(100.0 * valor_acumulado / nullif(valor_total_empresa, 0::numeric), 1)
         end as pct_acumulado,
         case
           when costo_unitario is null or coalesce(valor_total_empresa, 0::numeric) = 0::numeric then null::text
           when valor_acumulado / nullif(valor_total_empresa, 0::numeric) <= 0.80 then 'A'::text
           when valor_acumulado / nullif(valor_total_empresa, 0::numeric) <= 0.95 then 'B'::text
           else 'C'::text
         end as clase_abc
  from acumulado;

-- El índice único es el que permite refresh ... concurrently.
create unique index skus_valor_abc_empresa_mv_sku_id_idx on privado.skus_valor_abc_empresa_mv (sku_id);
create index skus_valor_abc_empresa_mv_empresa_idx on privado.skus_valor_abc_empresa_mv (empresa_id);
grant select on privado.skus_valor_abc_empresa_mv to authenticated;
analyze privado.skus_valor_abc_empresa_mv;

create or replace view public.skus_valor_abc with (security_invoker = true) as
  select s.id as sku_id,
         mv.valor_total,
         mv.pct_acumulado,
         mv.clase_abc
  from public.skus s
  join privado.skus_valor_abc_empresa_mv mv on mv.sku_id = s.id
  where s.activo = true
    and mv.empresa_id = (select public.empresa_actual());

create or replace function public.refrescar_clasificacion_abc()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (es_admin_actual() or es_super_admin()) then
    raise exception 'Solo un administrador puede refrescar la clasificación ABC';
  end if;
  refresh materialized view concurrently privado.skus_valor_abc_empresa_mv;
  update public.skus s
  set clase_abc = mv.clase_abc, pct_acumulado = mv.pct_acumulado
  from privado.skus_valor_abc_empresa_mv mv
  where mv.sku_id = s.id
    and s.clase_abc is distinct from mv.clase_abc;
  update public.skus s
  set clase_abc = null, pct_acumulado = null
  where s.clase_abc is not null
    and not exists (select 1 from privado.skus_valor_abc_empresa_mv mv where mv.sku_id = s.id);
end;
$$;
revoke all on function public.refrescar_clasificacion_abc() from public, anon;
grant execute on function public.refrescar_clasificacion_abc() to authenticated;

-- cron.schedule con un nombre que ya existe reemplaza el comando de ese trabajo.
select cron.schedule('refrescar-clasificacion-abc-nocturno', '0 7 * * *',
  'refresh materialized view concurrently privado.skus_valor_abc_empresa_mv');
