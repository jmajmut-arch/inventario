-- Estado general de SKU (Panel): la porción "Diferencia" se separa en Merma (contado menos de lo
-- que dice el sistema, diferencia < 0) y Excedente (contado más, diferencia > 0), a pedido de Joel
-- el 14/10/2026. Merma + Excedente = con_diferencia, siempre.
--
-- Función nueva y no un cambio a resumen_general_skus: cambiar las columnas que devuelve obligaría a
-- borrarla y recrearla, y una app abierta con la versión anterior (o guardada por el service worker)
-- la seguiría llamando con la forma de hoy. Esa queda intacta.
--
-- Igual que en Buscar, un operador con conteo ciego no ve el signo de las diferencias: para él
-- merma y excedente vuelven null y la app muestra "Diferencia" como antes. Hoy el Panel es solo
-- para administradores; esto es por si alguien llama al RPC directo.
--
-- empresa_actual() envuelta en (select ...): se evalúa una vez, no por fila (ver CLAUDE.md).

set local lock_timeout = '5s';

-- Tres ramas con el filtro de criticidad escrito literal, igual que resumen_general_skus: con un
-- solo select y el parámetro en el WHERE, "Solo críticos" dejaba de usar el índice y pasaba de 3 a
-- 45 ms en Escondida (ensayo del 14/10/2026).
create or replace function public.resumen_general_skus_signos(p_criticidad text default null)
returns table(total_activo bigint, no_contado bigint, cuadrado bigint, con_diferencia bigint,
              merma bigint, excedente bigint, pendiente bigint)
language plpgsql
stable
set search_path = public
as $$
declare
  v_ocultar boolean := public.debe_ocultar_stock_operador();
begin
  if p_criticidad = 'criticos' then
    return query
      select
        count(*),
        count(*) filter (where s.ultimo_conteo_id is null),
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                           and s.ultimo_conteo_estado <> 'pendiente_revision'),
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) <> 0),
        case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia < 0) end,
        case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia > 0) end,
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                           and s.ultimo_conteo_estado = 'pendiente_revision')
      from public.skus s
      where s.activo = true and s.empresa_id = (select public.empresa_actual()) and s.critico = true;
  elsif p_criticidad = 'no_criticos' then
    return query
      select
        count(*),
        count(*) filter (where s.ultimo_conteo_id is null),
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                           and s.ultimo_conteo_estado <> 'pendiente_revision'),
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) <> 0),
        case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia < 0) end,
        case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia > 0) end,
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                           and s.ultimo_conteo_estado = 'pendiente_revision')
      from public.skus s
      where s.activo = true and s.empresa_id = (select public.empresa_actual()) and s.critico = false;
  else
    return query
      select
        count(*),
        count(*) filter (where s.ultimo_conteo_id is null),
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                           and s.ultimo_conteo_estado <> 'pendiente_revision'),
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) <> 0),
        case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia < 0) end,
        case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia > 0) end,
        count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                           and s.ultimo_conteo_estado = 'pendiente_revision')
      from public.skus s
      where s.activo = true and s.empresa_id = (select public.empresa_actual());
  end if;
end;
$$;

revoke execute on function public.resumen_general_skus_signos(text) from public, anon;
grant execute on function public.resumen_general_skus_signos(text) to authenticated;

-- El Panel lee el resumen desde el cálculo del Dashboard (la puerta public.dashboard_ejecutivo no
-- se toca). Solo cambia la clave resumenGeneral: mismas claves de antes más merma y excedente.
create or replace function privado.dashboard_ejecutivo_calculo(p_dias integer default 14, p_criticidad text default null::text)
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
    -- Trae merma y excedente además de con_diferencia (20261014_resumen_general_merma_excedente).
    'resumenGeneral', (select coalesce(json_agg(to_json(x)), '[]'::json)
                from resumen_general_skus_signos(p_criticidad) x),
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
