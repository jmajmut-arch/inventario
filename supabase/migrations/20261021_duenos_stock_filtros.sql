-- Dueños de stock, paso 6: filtrar por dueño en Buscar y en SKU (Joel, 21/10/2026). Sigue a
-- 20261021_duenos_stock_renombrar.sql.
--
-- Buscar (contar_busqueda_skus, filas_busqueda_skus, resumen_busqueda_skus) y la tabla de SKU
-- (pagina_skus) consultan por RPC, así que el filtro necesita un parámetro en la base. Cada una
-- tiene ahora una versión con p_dueno ('' = sin dueño, un código = ese dueño, null = todos), con
-- TODOS sus parámetros obligatorios: PostgREST elige por los nombres que manda la app, y una
-- versión sin valores por defecto no compite con la de siempre cuando la app no manda p_dueno
-- (la app publicada y cualquier versión vieja guardada en un celular siguen llamando a la de
-- siempre). La de siempre pasa a llamar a la nueva con p_dueno null: una sola copia de la lógica.
-- No se borra ninguna función.
--
-- En una empresa sin dueños, la de siempre devuelve exactamente lo mismo que antes (ensayado con
-- los datos de Escondida en una transacción revertida, comparando el md5 de los resultados).

set local lock_timeout = '5s';

-- ===== contar_busqueda_skus =====
create or replace function public.contar_busqueda_skus(p_texto text, p_bodega text, p_estado text, p_ciclo text, p_solo_fuera_de_plan boolean, p_solo_criticos boolean, p_clase_abc text, p_fecha_desde timestamp with time zone, p_fecha_hasta timestamp with time zone, p_usuario_id uuid, p_grupo_id uuid, p_ubicacion text, p_dueno text)
 returns bigint
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
 set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_ciclo uuid := (select public.ciclo_actual());
  v_total bigint;
begin
  if v_empresa is null then
    return 0;
  end if;
  select count(*) into v_total
  from public.skus s
  where s.activo = true
    and s.empresa_id = v_empresa
    and (p_dueno is null or s.dueno = p_dueno)
    and (p_texto is null or p_texto = '' or
         s.sku_code ilike '%'||p_texto||'%' or
         s.descripcion ilike '%'||p_texto||'%' or
         s.batch ilike '%'||p_texto||'%' or
         s.storage_bin ilike '%'||p_texto||'%')
    and (
      p_bodega is null or p_bodega = '' or
      (p_bodega = '__bodega_vacia__' and s.bodega is null) or
      s.bodega = p_bodega
    )
    and (p_ubicacion is null or p_ubicacion = '' or s.ubicacion = p_ubicacion)
    and (
      p_estado is null or p_estado = '' or
      (p_estado = 'no_contado' and s.ultimo_conteo_id is null) or
      (p_estado = 'reconteo_pendiente' and s.ultimo_conteo_id is not null
        and coalesce(s.ultimo_conteo_diferencia, 0) <> 0
        and (s.ultimo_conteo_ciclo_id = v_ciclo or v_ciclo is null)
        and not exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.reconteo_descartado_en is not null)) or
      (p_estado = 'diferencia_positiva' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia > 0) or
      (p_estado = 'diferencia_negativa' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia < 0) or
      (p_estado = 'con_danos' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and (co.packing_danado or co.material_danado))) or
      (p_estado = 'packing_danado' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.packing_danado)) or
      (p_estado = 'material_danado' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.material_danado)) or
      (p_estado not in ('no_contado','reconteo_pendiente','diferencia_positiva','diferencia_negativa','con_danos','packing_danado','material_danado') and s.ultimo_conteo_estado = p_estado)
    )
    and (
      p_ciclo is null or p_ciclo = '' or
      (p_ciclo = '__sin_ciclo__' and s.ultimo_conteo_ciclo_id is null and s.ultimo_conteo_id is not null) or
      (p_ciclo <> '__sin_ciclo__' and s.ultimo_conteo_ciclo_id = p_ciclo::uuid)
    )
    and (not coalesce(p_solo_fuera_de_plan, false) or s.ultimo_conteo_fuera_de_plan = true)
    and (not coalesce(p_solo_criticos, false) or s.critico = true)
    and (
      p_clase_abc is null or p_clase_abc = '' or
      (p_clase_abc = '__sin_clasificar__' and s.clase_abc is null) or
      (p_clase_abc <> '__sin_clasificar__' and s.clase_abc = p_clase_abc)
    )
    and (p_fecha_desde is null or s.ultimo_conteo_fecha >= p_fecha_desde)
    and (p_fecha_hasta is null or s.ultimo_conteo_fecha < p_fecha_hasta)
    and (p_usuario_id is null or s.ultimo_conteo_usuario_id = p_usuario_id)
    and (
      p_grupo_id is null or exists (
        select 1 from public.skus_grupos_conteo sg
        where sg.grupo_id = p_grupo_id
          and sg.empresa_id = s.empresa_id
          and sg.sku_code = s.sku_code
          and coalesce(sg.bodega,'') = coalesce(s.bodega,'')
      )
    );
  return v_total;
end;
$function$;

create or replace function public.contar_busqueda_skus(p_texto text DEFAULT NULL::text, p_bodega text DEFAULT NULL::text, p_estado text DEFAULT NULL::text, p_ciclo text DEFAULT NULL::text, p_solo_fuera_de_plan boolean DEFAULT false, p_solo_criticos boolean DEFAULT false, p_clase_abc text DEFAULT NULL::text, p_fecha_desde timestamp with time zone DEFAULT NULL::timestamp with time zone, p_fecha_hasta timestamp with time zone DEFAULT NULL::timestamp with time zone, p_usuario_id uuid DEFAULT NULL::uuid, p_grupo_id uuid DEFAULT NULL::uuid, p_ubicacion text DEFAULT NULL::text)
 returns bigint
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select public.contar_busqueda_skus(p_texto, p_bodega, p_estado, p_ciclo, p_solo_fuera_de_plan, p_solo_criticos,
    p_clase_abc, p_fecha_desde, p_fecha_hasta, p_usuario_id, p_grupo_id, p_ubicacion, null::text);
$function$;

-- ===== filas_busqueda_skus =====
create or replace function public.filas_busqueda_skus(p_texto text, p_bodega text, p_estado text, p_ciclo text, p_solo_fuera_de_plan boolean, p_solo_criticos boolean, p_clase_abc text, p_fecha_desde timestamp with time zone, p_fecha_hasta timestamp with time zone, p_usuario_id uuid, p_grupo_id uuid, p_ubicacion text, p_orden_campo text, p_orden_dir text, p_limite integer, p_offset integer, p_dueno text)
 returns setof skus_busqueda
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_ciclo uuid := (select public.ciclo_actual());
  v_campo text;
  v_dir text := case when lower(coalesce(p_orden_dir, '')) = 'desc' then 'desc' else 'asc' end;
  v_orden text;
  v_limite integer := greatest(0, least(coalesce(p_limite, 30), 1000));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if v_empresa is null then
    return;
  end if;
  -- Mismo orden que armaba la app para PostgREST: la columna elegida (nulls last) con desempate
  -- por código; por defecto fecha del último conteo descendente y código ascendente.
  v_campo := case p_orden_campo
    when 'sku_code' then 's.sku_code'
    when 'batch' then 's.batch'
    when 'descripcion' then 's.descripcion'
    when 'bodega' then 's.bodega'
    when 'storage_bin' then 's.storage_bin'
    when 'cantidad_contada' then 's.ultimo_conteo_cantidad'
    when 'estado' then 's.ultimo_conteo_estado'
    when 'fuera_de_plan' then 's.ultimo_conteo_fuera_de_plan'
    when 'fecha_conteo' then 's.ultimo_conteo_fecha'
    when 'ciclo_nombre' then 'cc.nombre'
    when 'clase_abc' then 's.clase_abc'
    else null end;
  -- s.id al final: desempate estable entre filas del mismo código (varios bins o batches) para que
  -- la paginación no repita ni salte filas entre una tanda y la siguiente.
  if v_campo is null then
    v_orden := 's.ultimo_conteo_fecha desc nulls last, s.sku_code asc, s.id';
  elsif v_campo = 's.sku_code' then
    v_orden := 's.sku_code ' || v_dir || ' nulls last, s.id';
  else
    v_orden := v_campo || ' ' || v_dir || ' nulls last, s.sku_code asc, s.id';
  end if;

  return query execute format($q$
    with pagina as (
      select s.id, row_number() over (order by %1$s) as pos
      from public.skus s
      left join public.ciclos_conteo cc on cc.id = s.ultimo_conteo_ciclo_id
      where s.activo = true
        and s.empresa_id = $1
        and ($17 is null or s.dueno = $17)
        and ($2 is null or $2 = '' or
             s.sku_code ilike '%%'||$2||'%%' or
             s.descripcion ilike '%%'||$2||'%%' or
             s.batch ilike '%%'||$2||'%%' or
             s.storage_bin ilike '%%'||$2||'%%')
        and (
          $3 is null or $3 = '' or
          ($3 = '__bodega_vacia__' and s.bodega is null) or
          s.bodega = $3
        )
        and ($4 is null or $4 = '' or s.ubicacion = $4)
        and (
          $5 is null or $5 = '' or
          ($5 = 'no_contado' and s.ultimo_conteo_id is null) or
          ($5 = 'reconteo_pendiente' and s.ultimo_conteo_id is not null
            and coalesce(s.ultimo_conteo_diferencia, 0) <> 0
            and (s.ultimo_conteo_ciclo_id = $14 or $14 is null)
            and not exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.reconteo_descartado_en is not null)) or
          ($5 = 'diferencia_positiva' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia > 0) or
          ($5 = 'diferencia_negativa' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia < 0) or
          ($5 = 'con_danos' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and (co.packing_danado or co.material_danado))) or
          ($5 = 'packing_danado' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.packing_danado)) or
          ($5 = 'material_danado' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.material_danado)) or
          ($5 not in ('no_contado','reconteo_pendiente','diferencia_positiva','diferencia_negativa','con_danos','packing_danado','material_danado') and s.ultimo_conteo_estado = $5)
        )
        and (
          $6 is null or $6 = '' or
          ($6 = '__sin_ciclo__' and s.ultimo_conteo_ciclo_id is null and s.ultimo_conteo_id is not null) or
          ($6 <> '__sin_ciclo__' and s.ultimo_conteo_ciclo_id = $6::uuid)
        )
        and (not $7 or s.ultimo_conteo_fuera_de_plan = true)
        and (not $8 or s.critico = true)
        and (
          $9 is null or $9 = '' or
          ($9 = '__sin_clasificar__' and s.clase_abc is null) or
          ($9 <> '__sin_clasificar__' and s.clase_abc = $9)
        )
        and ($10 is null or s.ultimo_conteo_fecha >= $10)
        and ($11 is null or s.ultimo_conteo_fecha < $11)
        and ($12 is null or s.ultimo_conteo_usuario_id = $12)
        and (
          $13 is null or exists (
            select 1 from public.skus_grupos_conteo sg
            where sg.grupo_id = $13
              and sg.empresa_id = s.empresa_id
              and sg.sku_code = s.sku_code
              and coalesce(sg.bodega,'') = coalesce(s.bodega,'')
          )
        )
      order by %1$s
      limit $15 offset $16
    )
    select b.*
    from public.skus_busqueda b
    join pagina p on p.id = b.sku_id
    where b.empresa_id = $1
    order by p.pos
  $q$, v_orden)
  using v_empresa, p_texto, p_bodega, p_ubicacion, p_estado, p_ciclo,
        coalesce(p_solo_fuera_de_plan, false), coalesce(p_solo_criticos, false), p_clase_abc,
        p_fecha_desde, p_fecha_hasta, p_usuario_id, p_grupo_id, v_ciclo, v_limite, v_offset, p_dueno;
end;
$function$;

create or replace function public.filas_busqueda_skus(p_texto text DEFAULT NULL::text, p_bodega text DEFAULT NULL::text, p_estado text DEFAULT NULL::text, p_ciclo text DEFAULT NULL::text, p_solo_fuera_de_plan boolean DEFAULT false, p_solo_criticos boolean DEFAULT false, p_clase_abc text DEFAULT NULL::text, p_fecha_desde timestamp with time zone DEFAULT NULL::timestamp with time zone, p_fecha_hasta timestamp with time zone DEFAULT NULL::timestamp with time zone, p_usuario_id uuid DEFAULT NULL::uuid, p_grupo_id uuid DEFAULT NULL::uuid, p_ubicacion text DEFAULT NULL::text, p_orden_campo text DEFAULT NULL::text, p_orden_dir text DEFAULT NULL::text, p_limite integer DEFAULT 30, p_offset integer DEFAULT 0)
 returns setof skus_busqueda
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select * from public.filas_busqueda_skus(p_texto, p_bodega, p_estado, p_ciclo, p_solo_fuera_de_plan, p_solo_criticos,
    p_clase_abc, p_fecha_desde, p_fecha_hasta, p_usuario_id, p_grupo_id, p_ubicacion, p_orden_campo, p_orden_dir,
    p_limite, p_offset, null::text);
$function$;

-- ===== resumen_busqueda_skus =====
create or replace function public.resumen_busqueda_skus(p_texto text, p_bodega text, p_estado text, p_ciclo text, p_solo_fuera_de_plan boolean, p_solo_criticos boolean, p_clase_abc text, p_fecha_desde timestamp with time zone, p_fecha_hasta timestamp with time zone, p_usuario_id uuid, p_grupo_id uuid, p_ubicacion text, p_solo_con_fotos boolean, p_dueno text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
 set plan_cache_mode to 'force_custom_plan'
as $function$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_ciclo uuid := (select public.ciclo_actual());
  v_resultado jsonb;
begin
  if v_empresa is null then
    return jsonb_build_object('total', 0, 'estados', '{}'::jsonb, 'personas', '[]'::jsonb);
  end if;
  with filtrados as (
    select s.ultimo_conteo_id, s.ultimo_conteo_diferencia, s.ultimo_conteo_estado, s.ultimo_conteo_usuario_id
    from public.skus s
    where s.activo = true
      and s.empresa_id = v_empresa
      and (p_dueno is null or s.dueno = p_dueno)
      and (p_texto is null or p_texto = '' or
           s.sku_code ilike '%'||p_texto||'%' or
           s.descripcion ilike '%'||p_texto||'%' or
           s.batch ilike '%'||p_texto||'%' or
           s.storage_bin ilike '%'||p_texto||'%')
      and (
        p_bodega is null or p_bodega = '' or
        (p_bodega = '__bodega_vacia__' and s.bodega is null) or
        s.bodega = p_bodega
      )
      and (p_ubicacion is null or p_ubicacion = '' or s.ubicacion = p_ubicacion)
      and (
        p_estado is null or p_estado = '' or
        (p_estado = 'no_contado' and s.ultimo_conteo_id is null) or
        (p_estado = 'reconteo_pendiente' and s.ultimo_conteo_id is not null
          and coalesce(s.ultimo_conteo_diferencia, 0) <> 0
          and (s.ultimo_conteo_ciclo_id = v_ciclo or v_ciclo is null)
          and not exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.reconteo_descartado_en is not null)) or
        (p_estado = 'diferencia_positiva' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia > 0) or
        (p_estado = 'diferencia_negativa' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia < 0) or
        (p_estado = 'con_danos' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and (co.packing_danado or co.material_danado))) or
        (p_estado = 'packing_danado' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.packing_danado)) or
        (p_estado = 'material_danado' and exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.material_danado)) or
        (p_estado not in ('no_contado','reconteo_pendiente','diferencia_positiva','diferencia_negativa','con_danos','packing_danado','material_danado') and s.ultimo_conteo_estado = p_estado)
      )
      and (
        p_ciclo is null or p_ciclo = '' or
        (p_ciclo = '__sin_ciclo__' and s.ultimo_conteo_ciclo_id is null and s.ultimo_conteo_id is not null) or
        (p_ciclo <> '__sin_ciclo__' and s.ultimo_conteo_ciclo_id = p_ciclo::uuid)
      )
      and (not coalesce(p_solo_fuera_de_plan, false) or s.ultimo_conteo_fuera_de_plan = true)
      and (not coalesce(p_solo_criticos, false) or s.critico = true)
      and (
        p_clase_abc is null or p_clase_abc = '' or
        (p_clase_abc = '__sin_clasificar__' and s.clase_abc is null) or
        (p_clase_abc <> '__sin_clasificar__' and s.clase_abc = p_clase_abc)
      )
      and (p_fecha_desde is null or s.ultimo_conteo_fecha >= p_fecha_desde)
      and (p_fecha_hasta is null or s.ultimo_conteo_fecha < p_fecha_hasta)
      and (p_usuario_id is null or s.ultimo_conteo_usuario_id = p_usuario_id)
      and (
        p_grupo_id is null or exists (
          select 1 from public.skus_grupos_conteo sg
          where sg.grupo_id = p_grupo_id
            and sg.empresa_id = s.empresa_id
            and sg.sku_code = s.sku_code
            and coalesce(sg.bodega,'') = coalesce(s.bodega,'')
        )
      )
      and (not coalesce(p_solo_con_fotos, false) or exists (
        select 1 from public.conteos c join public.conteo_fotos cf on cf.conteo_id = c.id
        where c.sku_id = s.id
      ))
  ),
  personas as (
    select coalesce(u.nombre, 'Sin asignar') as nombre, count(*) as n
    from filtrados f
    left join public.usuarios u on u.id = f.ultimo_conteo_usuario_id
    where f.ultimo_conteo_id is not null
    group by 1
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'estados', (select jsonb_build_object(
      'no_contado', count(*) filter (where ultimo_conteo_id is null),
      'negativa', count(*) filter (where ultimo_conteo_id is not null and coalesce(ultimo_conteo_diferencia, 0) < 0),
      'positiva', count(*) filter (where ultimo_conteo_id is not null and coalesce(ultimo_conteo_diferencia, 0) > 0),
      'pendiente', count(*) filter (where ultimo_conteo_id is not null and coalesce(ultimo_conteo_diferencia, 0) = 0 and ultimo_conteo_estado = 'pendiente_revision'),
      'cuadrado', count(*) filter (where ultimo_conteo_id is not null and coalesce(ultimo_conteo_diferencia, 0) = 0 and ultimo_conteo_estado is distinct from 'pendiente_revision'))
      from filtrados),
    'personas', coalesce((select jsonb_agg(jsonb_build_object('nombre', nombre, 'n', n) order by n desc, nombre) from personas), '[]'::jsonb)
  ) into v_resultado;
  return v_resultado;
end;
$function$;

create or replace function public.resumen_busqueda_skus(p_texto text DEFAULT NULL::text, p_bodega text DEFAULT NULL::text, p_estado text DEFAULT NULL::text, p_ciclo text DEFAULT NULL::text, p_solo_fuera_de_plan boolean DEFAULT false, p_solo_criticos boolean DEFAULT false, p_clase_abc text DEFAULT NULL::text, p_fecha_desde timestamp with time zone DEFAULT NULL::timestamp with time zone, p_fecha_hasta timestamp with time zone DEFAULT NULL::timestamp with time zone, p_usuario_id uuid DEFAULT NULL::uuid, p_grupo_id uuid DEFAULT NULL::uuid, p_ubicacion text DEFAULT NULL::text, p_solo_con_fotos boolean DEFAULT false)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select public.resumen_busqueda_skus(p_texto, p_bodega, p_estado, p_ciclo, p_solo_fuera_de_plan, p_solo_criticos,
    p_clase_abc, p_fecha_desde, p_fecha_hasta, p_usuario_id, p_grupo_id, p_ubicacion, p_solo_con_fotos, null::text);
$function$;

-- ===== pagina_skus (tabla de SKU) =====
create or replace function public.pagina_skus(p_desde integer, p_limite integer, p_dueno text)
 returns json
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  with pagina as (
    select s.*
    from public.skus_lectura s
    where s.activo
      and (p_dueno is null or s.dueno = p_dueno)
    order by s.sku_code, s.id
    offset greatest(coalesce(p_desde, 0), 0)
    limit greatest(1, least(coalesce(p_limite, 50), 200))
  )
  select json_build_object(
    'total', (select count(*) from public.skus_lectura where activo and (p_dueno is null or dueno = p_dueno)),
    'rows', (
      select coalesce(json_agg(
        (to_jsonb(p) || jsonb_build_object(
          'ultimoEstado', u.estado,
          'ultimaDiferencia', u.diferencia,
          'clase_abc', v.clase_abc
        ))::json
        order by p.sku_code, p.id), '[]'::json)
      from pagina p
      left join public.ultimo_conteo_por_sku u on u.sku_id = p.id
      left join public.skus_valor_abc v on v.sku_id = p.id
    )
  );
$function$;

create or replace function public.pagina_skus(p_desde integer DEFAULT 0, p_limite integer DEFAULT 50)
 returns json
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  select public.pagina_skus(p_desde, p_limite, null::text);
$function$;

-- Permisos de las versiones nuevas: las mismas que las de siempre (solo usuarios con sesión).
revoke all on function public.contar_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamptz, timestamptz, uuid, uuid, text, text) from public, anon;
revoke all on function public.filas_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamptz, timestamptz, uuid, uuid, text, text, text, integer, integer, text) from public, anon;
revoke all on function public.resumen_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamptz, timestamptz, uuid, uuid, text, boolean, text) from public, anon;
revoke all on function public.pagina_skus(integer, integer, text) from public, anon;
grant execute on function public.contar_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamptz, timestamptz, uuid, uuid, text, text) to authenticated;
grant execute on function public.filas_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamptz, timestamptz, uuid, uuid, text, text, text, integer, integer, text) to authenticated;
grant execute on function public.resumen_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamptz, timestamptz, uuid, uuid, text, boolean, text) to authenticated;
grant execute on function public.pagina_skus(integer, integer, text) to authenticated;
