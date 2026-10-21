-- Dueños de stock, paso 7: resumen por dueño para el Dashboard y su informe (Joel, 21/10/2026).
-- Sigue a 20261021_duenos_stock_filtros.sql.
--
-- Una fila por dueño (y una con dueno = '' para lo que no tiene): materiales activos, cuántos
-- se han contado, cuadrados, con diferencia, faltantes y sobrantes, pendientes, y el valor de las
-- diferencias. Mismos criterios que resumen_general_skus_signos (el "Estado general" del
-- Dashboard), sobre el último conteo de cada material; el valor es diferencia × costo unitario.
-- Para un operador al que se le oculta el stock, los faltantes, sobrantes y valores van en null,
-- como en el resto del Dashboard.
--
-- Es una función aparte: el Dashboard de siempre (privado.dashboard_ejecutivo_calculo, detrás de
-- la puerta de public.dashboard_ejecutivo) no cambia, y la app solo la llama en una empresa con
-- dueños de stock.

set local lock_timeout = '5s';

create or replace function public.resumen_por_dueno()
 returns table(dueno text, total_activo bigint, contados bigint, cuadrado bigint, con_diferencia bigint,
               merma bigint, excedente bigint, pendiente bigint, valor_perdidas numeric, valor_excedentes numeric)
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_ocultar boolean := (select public.debe_ocultar_stock_operador());
begin
  return query
    select
      s.dueno,
      count(*),
      count(*) filter (where s.ultimo_conteo_id is not null),
      count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                         and s.ultimo_conteo_estado <> 'pendiente_revision'),
      count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) <> 0),
      case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia < 0) end,
      case when v_ocultar then null else count(*) filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia > 0) end,
      count(*) filter (where s.ultimo_conteo_id is not null and coalesce(s.ultimo_conteo_diferencia,0) = 0
                         and s.ultimo_conteo_estado = 'pendiente_revision'),
      case when v_ocultar then null else coalesce(sum(s.ultimo_conteo_diferencia * s.costo_unitario)
        filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia < 0), 0) end,
      case when v_ocultar then null else coalesce(sum(s.ultimo_conteo_diferencia * s.costo_unitario)
        filter (where s.ultimo_conteo_id is not null and s.ultimo_conteo_diferencia > 0), 0) end
    from public.skus s
    where s.activo = true and s.empresa_id = (select public.empresa_actual())
    group by s.dueno
    order by s.dueno;
end;
$function$;

revoke all on function public.resumen_por_dueno() from public, anon;
grant execute on function public.resumen_por_dueno() to authenticated;
