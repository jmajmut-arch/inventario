-- Buscador por código o descripción que sí usa los índices de trigramas.
--
-- Por qué existe: Postgres no considera "leakproof" al operador ILIKE, así que bajo RLS está
-- obligado a aplicar primero la política (empresa_id = empresa_actual()) y recién después el texto.
-- Resultado: recorre los 60.000 materiales de Escondida uno por uno y nunca toca
-- skus_sku_code_trgm_idx ni skus_descripcion_trgm_idx. Medido el 29/09/2026 con la cuenta de Joel:
-- "FILTRO" 290 ms, "O-RING" 260 ms, "10371" 255 ms por tecleo. Sin la política, las mismas
-- búsquedas tardan 3 ms. (La medición "355 -> 4 ms" que quedó documentada se hizo sin RLS.)
--
-- Esta función es SECURITY DEFINER a propósito: sin política que ordene el plan, el planificador
-- elige el índice de trigramas para los textos raros y el recorrido ordenado por sku_code para los
-- textos frecuentes. La empresa la filtra la propia función con empresa_actual(), el mismo valor
-- que usa la política auth_read_skus; y el conteo ciego lo siguen aplicando las vistas
-- (debe_ocultar_stock_operador() lee el JWT, que sigue presente dentro de la función).
--
-- Devuelve filas de skus_lectura (o de skus_planificables con p_planificables) para que la app pida
-- las mismas columnas de siempre con ?select=. El orden y el límite van adentro: si los aplicara
-- PostgREST, se calcularían primero todas las coincidencias (con la suma lateral por sku_code de
-- skus_lectura, fila por fila) y recién después se recortarían. Por eso la búsqueda se hace en dos
-- pasos: primero los id (solo código y texto, ordenados y recortados) y luego las columnas
-- completas solo para esos.
--
-- plan_cache_mode = force_custom_plan: el plan se arma con el texto real de cada llamada, que es
-- lo que permite elegir entre trigramas y recorrido ordenado según cuántas filas se esperan.
-- El patrón se arma igual que PostgREST con ilike.*texto* ('%' || texto || '%', sin escapar), para
-- que encuentre exactamente lo mismo que encontraba la consulta directa.
create or replace function public.buscar_skus_lectura(
  p_texto text,
  p_limite integer default 8,
  p_bodega text default null,
  p_planificables boolean default false
)
returns setof public.skus_lectura
language plpgsql
stable
security definer
set search_path = public, pg_temp
set plan_cache_mode = force_custom_plan
as $$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_texto text := btrim(coalesce(p_texto, ''));
  v_patron text := '%' || btrim(coalesce(p_texto, '')) || '%';
  v_bodega text := nullif(btrim(coalesce(p_bodega, '')), '');
  v_patron_bodega text := '%' || nullif(btrim(coalesce(p_bodega, '')), '') || '%';
  v_limite integer := greatest(1, least(coalesce(p_limite, 8), 500));
begin
  if v_empresa is null then
    return;
  end if;
  if p_planificables then
    return query
      with c as materialized (
        select l.id
        from public.skus_planificables l
        where l.empresa_id = v_empresa
          and l.activo
          and (v_texto = '' or l.sku_code ilike v_patron or l.descripcion ilike v_patron)
          and (v_bodega is null or l.bodega ilike v_patron_bodega)
        order by l.sku_code
        limit v_limite
      )
      select l.*
      from public.skus_lectura l
      where l.empresa_id = v_empresa and l.id in (select c.id from c)
      order by l.sku_code;
  else
    return query
      with c as materialized (
        select s.id
        from public.skus s
        where s.empresa_id = v_empresa
          and s.activo
          and (v_texto = '' or s.sku_code ilike v_patron or s.descripcion ilike v_patron)
          and (v_bodega is null or s.bodega ilike v_patron_bodega)
        order by s.sku_code
        limit v_limite
      )
      select l.*
      from public.skus_lectura l
      where l.empresa_id = v_empresa and l.id in (select c.id from c)
      order by l.sku_code;
  end if;
end;
$$;

revoke all on function public.buscar_skus_lectura(text, integer, text, boolean) from public, anon;
grant execute on function public.buscar_skus_lectura(text, integer, text, boolean) to authenticated;
