-- Avance de cada grupo de conteo en su ciclo, para la lista de Grupos (pedido de Joel: ver de un
-- vistazo cuál va atrasado sin entrar grupo por grupo).
--
-- Misma regla que el seguimiento que ya muestra la ficha del grupo (cargarSeguimientoGrupo):
--   * miembros: los de skus_grupos_conteo (código + bodega) o, en el grupo automático de Crítico,
--     cada código + bodega distinto de los materiales activos marcados como críticos;
--   * un miembro está "contado en el ciclo" si el conteo más reciente entre todas sus filas activas
--     (ubicación / storage bin / batch) es igual o posterior al inicio del ciclo del grupo;
--   * "nunca contado" si ninguna de sus filas tiene conteo.
-- El inicio del ciclo lo manda la app (p_inicios: {"<grupo_id>": "<instante>"}), calculado igual
-- que en la ficha: medianoche LOCAL de grupos_conteo.fecha_inicio. Así la lista y la ficha dan el
-- mismo número sin que la base tenga que saber la zona horaria. Un grupo sin frecuencia viaja con
-- null y no suma contados del ciclo.
--
-- Una sola llamada para todos los grupos (no una por grupo). Medido el 29/09/2026 en Escondida con
-- sus dos grupos (9 y 741 materiales): ~16 ms. SECURITY INVOKER (el default): lee bajo RLS; el
-- filtro explícito por empresa_actual() va envuelto en (select ...) para evaluarse una vez.
create or replace function public.avance_por_grupo(p_inicios jsonb)
returns table(grupo_id uuid, materiales integer, contados_ciclo integer, nunca_contados integer)
language sql
stable
set search_path = public, pg_temp
as $$
  with g as (
    select g.id, g.automatico_critico, (p_inicios ->> g.id::text)::timestamptz as inicio
    from public.grupos_conteo g
    where g.empresa_id = (select public.empresa_actual()) and p_inicios ? g.id::text
  ),
  miembros as (
    select g.id as grupo_id, m.sku_code, coalesce(m.bodega,'') as bodega, g.inicio
    from g join public.skus_grupos_conteo m on m.grupo_id = g.id
    where not g.automatico_critico
    union
    select g.id, s.sku_code, coalesce(s.bodega,''), g.inicio
    from g join public.skus s on s.empresa_id = (select public.empresa_actual()) and s.activo and s.critico
    where g.automatico_critico
  ),
  ultimo as (
    select mi.grupo_id, mi.inicio,
      (select max(s.ultimo_conteo_fecha) from public.skus s
        where s.empresa_id = (select public.empresa_actual()) and s.activo
          and s.sku_code = mi.sku_code and coalesce(s.bodega,'') = mi.bodega) as ultimo
    from miembros mi
  )
  select g.id, count(u.grupo_id)::int,
    count(*) filter (where u.inicio is not null and u.ultimo >= u.inicio)::int,
    count(*) filter (where u.grupo_id is not null and u.ultimo is null)::int
  from g left join ultimo u on u.grupo_id = g.id
  group by g.id;
$$;

revoke all on function public.avance_por_grupo(jsonb) from public, anon;
grant execute on function public.avance_por_grupo(jsonb) to authenticated;
