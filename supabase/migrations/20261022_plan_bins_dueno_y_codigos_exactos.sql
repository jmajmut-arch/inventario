-- Planificar por storage bin y por lista de códigos para cualquier empresa (Joel, 22/10/2026:
-- "que funcione como todo para todo InventIA"). Sobre 20261022_plan_bins_y_lista_codigos.sql:
--
-- 1. Dueño de stock (empresas con usa_duenos_stock, como Agunsa): buscar_bins_plan y
--    revisar_codigos_plan reciben p_dueno con la convención de siempre (null = todos los dueños,
--    '' = solo lo que no tiene dueño, un código = solo lo de ese dueño; skus.dueno es '' sin dueño).
--    Los números de cada bin y las posiciones de cada código son los de ese dueño, igual que las
--    listas del modo por ubicación.
-- 2. Ceros a la izquierda: 000123 calzaba con 000123 y además con 123. En una empresa donde son
--    dos materiales distintos, pegar 000123 traía los dos. Ahora la variante sin ceros solo se usa
--    si el código tal cual no existe.
--
-- Las firmas cambian (p_dueno nuevo). Agregar un parámetro con default crea una segunda función
-- con el mismo nombre y PostgREST no sabría a cuál llamar; las versiones anteriores se renombran
-- (no se borran) y quedan sin permiso de ejecución. La app todavía no las usaba en producción.

set local lock_timeout = '5s';

alter function public.buscar_bins_plan(text, text, text, integer) rename to buscar_bins_plan_v1_obsoleta;
revoke all on function public.buscar_bins_plan_v1_obsoleta(text, text, text, integer) from public, anon, authenticated;
alter function public.revisar_codigos_plan(text[], text, text) rename to revisar_codigos_plan_v1_obsoleta;
revoke all on function public.revisar_codigos_plan_v1_obsoleta(text[], text, text) from public, anon, authenticated;

create function public.buscar_bins_plan(p_texto text, p_bodega text default null, p_ubicacion text default null, p_dueno text default null, p_limite integer default 30)
 returns table(bodega text, ubicacion text, storage_bin text, total integer, por_planificar integer)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
 set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_texto text := btrim(coalesce(p_texto, ''));
  v_bodega text := nullif(btrim(coalesce(p_bodega, '')), '');
  v_ubicacion text := nullif(btrim(coalesce(p_ubicacion, '')), '');
  v_limite integer := greatest(1, least(coalesce(p_limite, 30), 100));
  v_b text[];
  v_u text[];
  v_s text[];
begin
  if v_empresa is null or length(v_texto) < 3 then
    return;
  end if;
  -- Primero los bins (trigramas, con la empresa explícita); después, solo para esos, los conteos.
  select array_agg(x.bodega order by x.storage_bin, x.bodega, x.ubicacion),
         array_agg(x.ubicacion order by x.storage_bin, x.bodega, x.ubicacion),
         array_agg(x.storage_bin order by x.storage_bin, x.bodega, x.ubicacion)
    into v_b, v_u, v_s
  from (
    select distinct s.bodega, s.ubicacion, s.storage_bin
    from public.skus s
    where s.empresa_id = v_empresa
      and s.activo
      and s.storage_bin ilike '%' || v_texto || '%'
      and (v_bodega is null or s.bodega = v_bodega)
      and (v_ubicacion is null or s.ubicacion = v_ubicacion)
      and (p_dueno is null or s.dueno = p_dueno)
    order by 3, 1, 2
    limit v_limite
  ) x;
  if v_s is null then
    return;
  end if;
  return query
  with bins as (
    select * from unnest(v_b, v_u, v_s) with ordinality as b(bodega, ubicacion, storage_bin, n)
  )
  select b.bodega, b.ubicacion, b.storage_bin,
    (select count(*)::integer from public.skus s
      where s.empresa_id = v_empresa and s.activo and s.storage_bin = b.storage_bin
        and s.bodega is not distinct from b.bodega and s.ubicacion is not distinct from b.ubicacion
        and (p_dueno is null or s.dueno = p_dueno)),
    coalesce(p.n, 0)
  from bins b
  left join (
    select d.bodega, d.ubicacion, d.storage_bin, count(*)::integer n
    from public.skus_disponibles_planificar d
    where d.empresa_id = v_empresa and d.storage_bin = any(v_s)
      and (p_dueno is null or d.dueno = p_dueno)
    group by 1, 2, 3
  ) p on p.storage_bin = b.storage_bin and p.bodega is not distinct from b.bodega and p.ubicacion is not distinct from b.ubicacion
  order by b.n;
end;
$function$;

revoke all on function public.buscar_bins_plan(text, text, text, text, integer) from public, anon;
grant execute on function public.buscar_bins_plan(text, text, text, text, integer) to authenticated;

create function public.revisar_codigos_plan(p_codigos text[], p_bodega text default null, p_ubicacion text default null, p_dueno text default null)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public', 'pg_temp'
 set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_ciclo uuid := (select public.ciclo_actual());
  v_bodega text := nullif(btrim(coalesce(p_bodega, '')), '');
  v_ubicacion text := nullif(btrim(coalesce(p_ubicacion, '')), '');
  v_resultado jsonb;
begin
  if v_empresa is null then
    raise exception 'No hay una empresa activa para este usuario';
  end if;
  if coalesce(cardinality(p_codigos), 0) > 5000 then
    raise exception 'Son % códigos: el máximo es 5.000 por vez', cardinality(p_codigos);
  end if;

  with codigos as (
    select distinct btrim(c) as codigo from unnest(coalesce(p_codigos, '{}'::text[])) c where btrim(c) <> ''
  ), exactos as (
    select c.codigo, s.id, s.sku_code, s.descripcion, s.bodega, s.ubicacion, s.storage_bin, s.dueno
    from codigos c
    join public.skus s on s.sku_code = c.codigo and s.empresa_id = v_empresa and s.activo
  ), sin_ceros as (
    -- Relleno de ceros (SAP los completa a 18): solo si el código tal cual no existe, para no
    -- mezclar 000123 con 123 en una empresa donde son materiales distintos.
    select c.codigo, s.id, s.sku_code, s.descripcion, s.bodega, s.ubicacion, s.storage_bin, s.dueno
    from codigos c
    join public.skus s on s.sku_code = regexp_replace(c.codigo, '^0+(?=[0-9])', '') and s.empresa_id = v_empresa and s.activo
    where c.codigo ~ '^0+[0-9]+$'
      and not exists (select 1 from exactos e where e.codigo = c.codigo)
  ), existentes as (
    select * from exactos union all select * from sin_ceros
  ), en_filtro as (
    select * from existentes e
    where (v_bodega is null or e.bodega = v_bodega)
      and (v_ubicacion is null or e.ubicacion = v_ubicacion)
      and (p_dueno is null or e.dueno = p_dueno)
  ), listos as (
    -- Un material una sola vez aunque lo nombren dos códigos pegados (10475828 y 000000000010475828).
    select distinct on (f.id) f.* from en_filtro f
    where exists (select 1 from public.skus_planificables p where p.id = f.id)
    order by f.id, f.codigo
  ), disponibles as (
    select d.id from public.skus_disponibles_planificar d
    where d.id = any(array(select l.id from listos l))
  ), por_codigo as (
    select c.codigo,
      case
        when exists (select 1 from en_filtro f where f.codigo = c.codigo and exists (select 1 from listos l where l.id = f.id)) then 'listo'
        when exists (select 1 from en_filtro f where f.codigo = c.codigo and exists (
               select 1 from public.conteos k where k.sku_id = f.id and (v_ciclo is null or k.ciclo_id = v_ciclo))) then 'contado'
        when exists (select 1 from en_filtro f where f.codigo = c.codigo) then 'sin_stock'
        when exists (select 1 from existentes e where e.codigo = c.codigo) then 'fuera_filtro'
        else 'no_existe'
      end as estado
    from codigos c
  )
  select jsonb_build_object(
    'posiciones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'sku_code', l.sku_code, 'descripcion', l.descripcion, 'bodega', l.bodega,
        'ubicacion', l.ubicacion, 'storage_bin', l.storage_bin, 'codigo', l.codigo,
        'en_plan', not exists (select 1 from disponibles d where d.id = l.id))
        order by l.sku_code, l.bodega, l.ubicacion, l.storage_bin)
      from listos l), '[]'::jsonb),
    'contados', coalesce((select jsonb_agg(codigo order by codigo) from por_codigo where estado = 'contado'), '[]'::jsonb),
    'sin_stock', coalesce((select jsonb_agg(codigo order by codigo) from por_codigo where estado = 'sin_stock'), '[]'::jsonb),
    'fuera_filtro', coalesce((select jsonb_agg(codigo order by codigo) from por_codigo where estado = 'fuera_filtro'), '[]'::jsonb),
    'no_existen', coalesce((select jsonb_agg(codigo order by codigo) from por_codigo where estado = 'no_existe'), '[]'::jsonb),
    'codigos', (select count(*) from codigos)
  ) into v_resultado;
  return v_resultado;
end;
$function$;

revoke all on function public.revisar_codigos_plan(text[], text, text, text) from public, anon;
grant execute on function public.revisar_codigos_plan(text[], text, text, text) to authenticated;
