-- "Ya contado": además de cuántas veces, cuándo fue el último conteo y quién lo hizo (pedido de
-- Joel, 28/09/2026: "cuando voy a contar y ya fue contado, que diga cuándo y a qué hora").
-- Aplicada por MCP como "contado_periodo". Reemplaza en la app a veces_contado_periodo, que se
-- conserva por compatibilidad. SECURITY INVOKER: respeta el RLS de conteos y usuarios.
create or replace function public.contado_periodo(p_sku_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  with del_periodo as (
    select c.fecha_conteo, c.cantidad_contada, c.usuario_id
    from conteos c
    where c.sku_id = p_sku_id
      and (c.ciclo_id = (select ciclo_actual()) or (select ciclo_actual()) is null)
  ),
  ultimo as (
    select d.fecha_conteo, d.cantidad_contada, u.nombre as usuario
    from del_periodo d
    left join usuarios u on u.id = d.usuario_id
    order by d.fecha_conteo desc
    limit 1
  )
  select jsonb_build_object(
    'veces', (select count(*) from del_periodo),
    'ultima_fecha', (select fecha_conteo from ultimo),
    'ultima_cantidad', (select cantidad_contada from ultimo),
    'ultimo_por', (select usuario from ultimo)
  );
$$;
revoke all on function public.contado_periodo(uuid) from public, anon;
grant execute on function public.contado_periodo(uuid) to authenticated;
