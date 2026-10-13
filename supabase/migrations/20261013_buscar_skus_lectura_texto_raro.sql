-- Buscador: un texto que aparece poco ya no recorre el maestro completo (13/10/2026).
--
-- Lo encontró la prueba de carga del 13/10/2026. Medido en Escondida (81.000 materiales) con la
-- función anterior: "PERNO" 355 ms, "SELLO" 323 ms, "RODAMIENTO" 317 ms, "FILTRO" 315 ms, contra
-- 6-20 ms de "GUANTE" o "O-RING". Con plan_cache_mode = force_custom_plan el planificador elige
-- según cuántas coincidencias espera: si cree que el texto es frecuente, recorre el maestro en
-- orden de código y para al juntar las 8 primeras. Cuando se equivoca (Escondida tiene 5 PERNO,
-- 4 FILTRO y ningún RODAMIENTO, pero las estadísticas de trigramas los dan por comunes) no para
-- nunca: revisa los 81.000 materiales uno por uno. En 20 búsquedas típicas, 8 caían en ese caso.
-- Es lo que más pesó en la prueba de carga: el buscador fue el 45% del trabajo de la base.
--
-- Ahora, con 3 caracteres o más, la búsqueda del maestro (Contar, Bodega, Mover) va en dos pasos:
--   1. Mira los primeros materiales en orden de código (1.000, o 10 veces el límite si es mayor).
--      Si ahí ya están todas las coincidencias pedidas, son las primeras del maestro completo en
--      ese mismo orden y no hace falta seguir: es el caso del texto frecuente, que antes ya era
--      rápido y sigue siéndolo.
--   2. Si no alcanzaron pero aparecieron varias, el texto es medianamente frecuente (pasa con el
--      filtro de bodega o al pedir 200 filas): se sigue en orden de código como antes, porque al
--      ritmo visto junta lo pedido antes de 20.000 materiales.
--   3. Si aparecieron menos de 3, el texto es raro: busca todas sus coincidencias (el
--      "offset 0" impide que el planificador mezcle el orden con la búsqueda, así que usa los
--      índices de trigramas) y se queda con las primeras en orden de código.
-- Con menos de 3 caracteres no hay trigramas que usar, y el texto vacío trae todo: esos casos
-- siguen exactamente como antes.
--
-- La búsqueda de Planificación (p_planificables) queda igual: ahí el primer paso costaba más de lo
-- que ahorraba.
--
-- Mismos resultados que antes, comparados búsqueda por búsqueda en Escondida y dos empresas de
-- prueba: 342 combinaciones (19 textos; 8, 20 y 200 filas; con y sin filtro de bodega). Lo único
-- que cambia es el desempate entre materiales con el mismo código (distinta bodega o batch):
-- antes salían en cualquier orden y ahora por id, siempre igual.
-- Medido en Escondida: promedio de 129 a 35 ms; la peor búsqueda de 373 a 253 ms. Ese peor caso
-- es el único que empeora: un texto muy frecuente ("CAT") con un filtro de bodega que no existe,
-- de ~180 a ~245 ms, porque el primer paso no encuentra nada y el texto pasa por raro.
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
  v_ventana integer;
  v_ids uuid[];
  v_n integer;
begin
  if v_empresa is null then
    return;
  end if;
  v_ventana := greatest(1000, v_limite * 10);

  if p_planificables then
    -- Planificación sigue como antes: ahí el primer paso costaría más de lo que ahorra (la vista
    -- skus_planificables descarta lo ya contado fila por fila), medido el 13/10/2026: de 92 a 113 ms.
    select array_agg(x.id order by x.sku_code, x.id) into v_ids
    from (
      select l.id, l.sku_code
      from public.skus_planificables l
      where l.empresa_id = v_empresa
        and l.activo
        and (v_texto = '' or l.sku_code ilike v_patron or l.descripcion ilike v_patron)
        and (v_bodega is null or l.bodega ilike v_patron_bodega)
      order by l.sku_code
      limit v_limite
    ) x;
  else
    if length(v_texto) >= 3 then
      select array_agg(x.id order by x.sku_code, x.id), count(*) into v_ids, v_n
      from (
        select w.id, w.sku_code
        from (
          select s.id, s.sku_code, s.descripcion, s.bodega
          from public.skus s
          where s.empresa_id = v_empresa and s.activo
          order by s.sku_code, s.id
          limit v_ventana
        ) w
        where (w.sku_code ilike v_patron or w.descripcion ilike v_patron)
          and (v_bodega is null or w.bodega ilike v_patron_bodega)
        order by w.sku_code, w.id
        limit v_limite
      ) x;
      if coalesce(v_n, 0) < v_limite and v_n >= 3 and v_limite::numeric * v_ventana / v_n <= 20000 then
        -- Frecuente pero no tanto (p. ej. con filtro de bodega o 200 filas): al ritmo visto en el
        -- primer paso, el recorrido ordenado junta lo pedido antes de 20.000 materiales.
        select array_agg(x.id order by x.sku_code, x.id) into v_ids
        from (
          select s.id, s.sku_code
          from public.skus s
          where s.empresa_id = v_empresa
            and s.activo
            and (s.sku_code ilike v_patron or s.descripcion ilike v_patron)
            and (v_bodega is null or s.bodega ilike v_patron_bodega)
          order by s.sku_code, s.id
          limit v_limite
        ) x;
      elsif coalesce(v_n, 0) < v_limite then
        select array_agg(x.id order by x.sku_code, x.id) into v_ids
        from (
          select y.id, y.sku_code
          from (
            select s.id, s.sku_code
            from public.skus s
            where s.empresa_id = v_empresa
              and s.activo
              and (s.sku_code ilike v_patron or s.descripcion ilike v_patron)
              and (v_bodega is null or s.bodega ilike v_patron_bodega)
            offset 0
          ) y
          order by y.sku_code, y.id
          limit v_limite
        ) x;
      end if;
    else
      select array_agg(x.id order by x.sku_code, x.id) into v_ids
      from (
        select s.id, s.sku_code
        from public.skus s
        where s.empresa_id = v_empresa
          and s.activo
          and (v_texto = '' or s.sku_code ilike v_patron or s.descripcion ilike v_patron)
          and (v_bodega is null or s.bodega ilike v_patron_bodega)
        order by s.sku_code, s.id
        limit v_limite
      ) x;
    end if;
  end if;

  return query
    select l.*
    from public.skus_lectura l
    where l.empresa_id = v_empresa and l.id = any(v_ids)
    order by l.sku_code, l.id;
end;
$$;

revoke all on function public.buscar_skus_lectura(text, integer, text, boolean) from public, anon;
grant execute on function public.buscar_skus_lectura(text, integer, text, boolean) to authenticated;
