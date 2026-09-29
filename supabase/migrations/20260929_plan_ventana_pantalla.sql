-- Planificación en un solo viaje al servidor.
--
-- Por qué existe: al entrar a Planificación la app pedía primero las entradas de la ventana
-- (plan_semanal_detalle) y, recién con esa respuesta, sus totales (resumen_entradas_plan en Mes,
-- Año y Período) o su detalle de SKU (universo_entradas_plan_resumen en Día y Semana). Eran dos
-- idas y vueltas seguidas, cada una con su preflight CORS, su verificación de token y su turno en
-- el pool; la segunda no podía partir antes de que volviera la primera. Esta función hace las dos
-- cosas adentro y devuelve un solo JSON:
--   { "entradas": [filas de plan_semanal_detalle],
--     "resumen":  [{plan_id, total, propios}]      -- con p_resumido
--     "universo": {"<plan_id>": [{id, sku_code, descripcion}]}  -- sin p_resumido }
-- Cada parte es exactamente lo que devolvían las consultas originales (mismas funciones, mismas
-- columnas); se verificó con datos reales de Escondida antes de tocar la app.
--
-- La ventana llega igual que antes a la vista: por ciclo (Período) o por rango de fechas (Día,
-- Semana, Mes, Año). Dentro de un mismo día las entradas salen por orden de creación, que antes
-- quedaba al azar del plan de ejecución.
--
-- SECURITY INVOKER (el default): todo lo que lee pasa por RLS igual que las consultas directas.
-- Sin límite de 1.000 filas: es un solo valor jsonb, así que ya no hace falta paginar las entradas
-- de un año o un período largo (restTodo).
create or replace function public.plan_ventana_pantalla(
  p_desde date default null,
  p_hasta date default null,
  p_ciclo_id uuid default null,
  p_resumido boolean default false
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_entradas jsonb;
  v_ids uuid[];
begin
  select coalesce(jsonb_agg(to_jsonb(d) order by d.fecha, d.created_at, d.id), '[]'::jsonb),
         coalesce(array_agg(d.id), '{}'::uuid[])
    into v_entradas, v_ids
  from public.plan_semanal_detalle d
  where (p_ciclo_id is null or d.ciclo_id = p_ciclo_id)
    and (p_desde is null or d.fecha >= p_desde)
    and (p_hasta is null or d.fecha <= p_hasta);

  if p_resumido then
    return jsonb_build_object(
      'entradas', v_entradas,
      'resumen', coalesce((
        select jsonb_agg(jsonb_build_object('plan_id', r.plan_id, 'total', r.total, 'propios', r.propios))
        from public.resumen_entradas_plan(v_ids) r
      ), '[]'::jsonb)
    );
  end if;
  return jsonb_build_object(
    'entradas', v_entradas,
    'universo', public.universo_entradas_plan_resumen(v_ids)
  );
end;
$$;

revoke all on function public.plan_ventana_pantalla(date, date, uuid, boolean) from public, anon;
grant execute on function public.plan_ventana_pantalla(date, date, uuid, boolean) to authenticated;
