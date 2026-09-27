-- Cerrar o quitar varios reconteos de una vez (pedido de Joel, 27/09/2026). Aplicada por MCP como
-- "reconteo_cierre_lote". Cada material sigue cerrándose con la MISMA función de siempre
-- (cerrar_reconteo_ajuste_erp / descartar_reconteo), con sus mismas reglas y su mismo registro;
-- estas dos solo recorren la lista y devuelven cuántos se cerraron y cuáles quedaron afuera y por
-- qué (ej. una merma contada una sola vez). Un material que falla no frena a los demás: cada uno
-- va en su propio bloque de excepción (subtransacción).
--
-- SECURITY INVOKER a propósito: corren como la persona; las funciones internas ya son SECURITY
-- DEFINER y validan admin y empresa. Tope de 200 por llamada para no acercarse al statement_timeout.

create or replace function public.cerrar_reconteos_ajuste_erp_lote(p_conteo_ids uuid[], p_referencia text, p_motivo text default null)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_cerrados integer := 0;
  v_omitidos jsonb := '[]'::jsonb;
  v_sku text;
begin
  if not es_admin_actual() then
    raise exception 'Solo un administrador puede cerrar un reconteo con ajuste en el ERP';
  end if;
  if p_referencia is null or length(trim(p_referencia)) = 0 then
    raise exception 'Indica la referencia del ajuste en el ERP (folio o documento)';
  end if;
  if p_conteo_ids is null or coalesce(array_length(p_conteo_ids, 1), 0) = 0 then
    raise exception 'No hay reconteos seleccionados';
  end if;
  if array_length(p_conteo_ids, 1) > 200 then
    raise exception 'Cierra hasta 200 reconteos por vez';
  end if;
  foreach v_id in array p_conteo_ids loop
    begin
      perform cerrar_reconteo_ajuste_erp(v_id, p_referencia, p_motivo);
      v_cerrados := v_cerrados + 1;
    exception when others then
      select s.sku_code into v_sku from conteos c join skus s on s.id = c.sku_id where c.id = v_id;
      v_omitidos := v_omitidos || jsonb_build_object('conteo_id', v_id, 'sku_code', v_sku, 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('cerrados', v_cerrados, 'omitidos', v_omitidos);
end;
$$;
revoke all on function public.cerrar_reconteos_ajuste_erp_lote(uuid[], text, text) from public, anon;
grant execute on function public.cerrar_reconteos_ajuste_erp_lote(uuid[], text, text) to authenticated;

create or replace function public.descartar_reconteos_lote(p_conteo_ids uuid[], p_motivo text)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_cerrados integer := 0;
  v_omitidos jsonb := '[]'::jsonb;
  v_sku text;
begin
  if not es_admin_actual() then
    raise exception 'Solo un administrador puede descartar un reconteo pendiente';
  end if;
  if p_motivo is null or length(trim(p_motivo)) = 0 then
    raise exception 'Debes indicar un motivo';
  end if;
  if p_conteo_ids is null or coalesce(array_length(p_conteo_ids, 1), 0) = 0 then
    raise exception 'No hay reconteos seleccionados';
  end if;
  if array_length(p_conteo_ids, 1) > 200 then
    raise exception 'Quita hasta 200 reconteos por vez';
  end if;
  foreach v_id in array p_conteo_ids loop
    begin
      perform descartar_reconteo(v_id, p_motivo);
      v_cerrados := v_cerrados + 1;
    exception when others then
      select s.sku_code into v_sku from conteos c join skus s on s.id = c.sku_id where c.id = v_id;
      v_omitidos := v_omitidos || jsonb_build_object('conteo_id', v_id, 'sku_code', v_sku, 'motivo', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('cerrados', v_cerrados, 'omitidos', v_omitidos);
end;
$$;
revoke all on function public.descartar_reconteos_lote(uuid[], text) from public, anon;
grant execute on function public.descartar_reconteos_lote(uuid[], text) to authenticated;
