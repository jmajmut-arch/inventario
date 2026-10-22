-- Planificar por storage bin y pegando una lista de códigos (Joel, 22/10/2026).
--
-- Escondida tiene 15.362 storage bins distintos: elegirlos bajando por bodega y ubicación no sirve
-- cuando se sabe el bin. Y planificar por código se hacía de a uno. Tres funciones:
--
-- 1. buscar_bins_plan(texto, bodega, ubicacion): bins que contienen el texto (mínimo 3 caracteres),
--    con cuántos SKU tiene cada uno y cuántos quedan por planificar en el período (misma regla que
--    ubicaciones_bins: pendientes y no cubiertos por otra entrada). SECURITY DEFINER con filtro
--    explícito por empresa_actual(): bajo RLS el ilike no usa el índice de trigramas de storage_bin
--    (medido: 470 ms la consulta directa contra la vista, 1,6 ms un texto que no existe aquí).
--    Con 30 bins encontrados tarda ~250 ms en Escondida, casi todo en contar los pendientes.
-- 2. revisar_codigos_plan(codigos[], bodega, ubicacion): clasifica cada código pegado en listos
--    (con sus posiciones y si ya están en otra entrada), ya contados, sin stock, fuera del filtro y
--    no existen. Un número con ceros a la izquierda (SAP los rellena a 18) también calza sin ellos.
--    SECURITY INVOKER: la búsqueda es por igualdad de código (índice), no por texto. 500 códigos:
--    ~80 ms; 2.000: ~200 ms. La lista va en el cuerpo, nunca en la URL.
-- 3. crear_plan_por_codigos(fecha, responsable, nota, sku_ids[]): crea en una transacción una
--    entrada por bodega + ubicación con su lista exacta (por_sku, plan_semanal_incluidos), igual
--    que el modo "Por código de SKU" hacía entrada por entrada desde la app. Todo o nada.
--    SECURITY INVOKER: un operador no escribe el plan (20261022_operadores_escritura_acotada.sql) y
--    el responsable de otra empresa lo rechaza trg_validar_responsable_misma_empresa.

set local lock_timeout = '5s';

create or replace function public.buscar_bins_plan(p_texto text, p_bodega text default null, p_ubicacion text default null, p_limite integer default 30)
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
        and s.bodega is not distinct from b.bodega and s.ubicacion is not distinct from b.ubicacion),
    coalesce(p.n, 0)
  from bins b
  left join (
    select d.bodega, d.ubicacion, d.storage_bin, count(*)::integer n
    from public.skus_disponibles_planificar d
    where d.empresa_id = v_empresa and d.storage_bin = any(v_s)
    group by 1, 2, 3
  ) p on p.storage_bin = b.storage_bin and p.bodega is not distinct from b.bodega and p.ubicacion is not distinct from b.ubicacion
  order by b.n;
end;
$function$;

revoke all on function public.buscar_bins_plan(text, text, text, integer) from public, anon;
grant execute on function public.buscar_bins_plan(text, text, text, integer) to authenticated;

create or replace function public.revisar_codigos_plan(p_codigos text[], p_bodega text default null, p_ubicacion text default null)
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
  ), variantes as (
    select codigo, codigo as variante from codigos
    union
    select codigo, regexp_replace(codigo, '^0+(?=[0-9])', '') from codigos where codigo ~ '^0+[0-9]+$'
  ), existentes as (
    select v.codigo, s.id, s.sku_code, s.descripcion, s.bodega, s.ubicacion, s.storage_bin
    from variantes v
    join public.skus s on s.sku_code = v.variante and s.empresa_id = v_empresa and s.activo
  ), en_filtro as (
    select * from existentes e
    where (v_bodega is null or e.bodega = v_bodega)
      and (v_ubicacion is null or e.ubicacion = v_ubicacion)
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

revoke all on function public.revisar_codigos_plan(text[], text, text) from public, anon;
grant execute on function public.revisar_codigos_plan(text[], text, text) to authenticated;

create or replace function public.crear_plan_por_codigos(p_fecha date, p_responsable_id uuid, p_nota text, p_sku_ids uuid[])
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_usuario uuid;
  v_id uuid;
  g record;
  v_sin_ubic boolean;
  v_ubic_nula boolean;
  v_creadas integer := 0;
  v_materiales integer := 0;
begin
  if v_empresa is null then
    raise exception 'No hay una empresa activa para este usuario';
  end if;
  if p_fecha is null then
    raise exception 'Falta la fecha';
  end if;
  if coalesce(cardinality(p_sku_ids), 0) = 0 then
    raise exception 'No hay materiales para planificar';
  end if;
  if cardinality(p_sku_ids) > 10000 then
    raise exception 'Son % materiales: el máximo es 10.000 por vez', cardinality(p_sku_ids);
  end if;
  select u.id into v_usuario from public.usuarios u
   where u.auth_user_id = auth.uid() and u.empresa_id = v_empresa and u.activo limit 1;

  for g in
    select s.bodega, s.ubicacion, array_agg(s.id order by s.sku_code, s.id) as ids, array_agg(s.sku_code order by s.sku_code, s.id) as codigos
    from public.skus s
    where s.empresa_id = v_empresa and s.activo and s.id = any(p_sku_ids)
    group by s.bodega, s.ubicacion
    order by s.bodega nulls first, s.ubicacion nulls first
  loop
    -- La misma traducción de zona que el formulario: sin bodega ni ubicación = "SKU sin ubicación";
    -- bodega sin ubicación = "sin ubicación específica"; ubicación sin bodega = bodega ''.
    v_sin_ubic := g.bodega is null and g.ubicacion is null;
    v_ubic_nula := g.bodega is not null and g.ubicacion is null;
    insert into public.plan_semanal
      (fecha, bodega, ubicacion, storage_bin, solo_sin_ubicacion, ubicacion_nula, por_sku,
       ciclo_id, responsable_id, nota, usuario_id, empresa_id)
    values
      (p_fecha, case when v_sin_ubic then null else coalesce(g.bodega, '') end,
       case when v_sin_ubic or v_ubic_nula then null else g.ubicacion end, null, v_sin_ubic, v_ubic_nula, true,
       null, p_responsable_id, nullif(btrim(coalesce(p_nota, '')), ''), v_usuario, v_empresa)
    returning id into v_id;
    insert into public.plan_semanal_incluidos (plan_id, sku_id, sku_code, empresa_id)
    select v_id, x.id, x.codigo, v_empresa from unnest(g.ids, g.codigos) as x(id, codigo);
    v_creadas := v_creadas + 1;
    v_materiales := v_materiales + cardinality(g.ids);
  end loop;

  return jsonb_build_object('creadas', v_creadas, 'materiales', v_materiales);
end;
$function$;

revoke all on function public.crear_plan_por_codigos(date, uuid, text, uuid[]) from public, anon;
grant execute on function public.crear_plan_por_codigos(date, uuid, text, uuid[]) to authenticated;
