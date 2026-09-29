-- Buscar: las filas y el total por función, para que la búsqueda por texto use los índices de
-- trigramas (misma causa que buscar_skus_lectura: Postgres no considera "leakproof" a ILIKE y
-- bajo RLS recorre todo el maestro de la empresa antes de aplicar el texto). Medido el
-- 29/09/2026 con la cuenta de Joel: una búsqueda por texto en Buscar tardaba 0,5 s en las filas
-- y otro tanto en el total.
--
-- filas_busqueda_skus reemplaza a la consulta directa a skus_busqueda que armaba la app con
-- filtros de PostgREST (construirPathBusqueda). Recibe exactamente los mismos parámetros que
-- contar_busqueda_skus (el RPC del total, que la app ya usaba) más orden, límite y desplazamiento,
-- y aplica el MISMO where: así las filas y el total salen del mismo criterio, cosa que antes
-- dependía de que dos construcciones distintas (la URL y el RPC) se mantuvieran a la par.
--
-- Cómo trabaja: primero elige los id de la página sobre skus (filtros, orden y recorte sobre las
-- columnas base, con ciclos_conteo solo para ordenar por nombre de ciclo) y recién después arma
-- las filas completas de skus_busqueda para esos id, en el mismo orden. Las fotos (lateral por
-- SKU) y los joins de la vista se calculan solo para la página, no para todas las coincidencias.
--
-- Ambas son SECURITY DEFINER a propósito, con filtro explícito por empresa_actual() (el mismo
-- valor que usa la política auth_read_skus) y, en las tablas relacionadas, el mismo empresa_id.
-- EXECUTE solo para authenticated.

create or replace function public.contar_busqueda_skus(
  p_texto text default null,
  p_bodega text default null,
  p_estado text default null,
  p_ciclo text default null,
  p_solo_fuera_de_plan boolean default false,
  p_solo_criticos boolean default false,
  p_clase_abc text default null,
  p_fecha_desde timestamp with time zone default null,
  p_fecha_hasta timestamp with time zone default null,
  p_usuario_id uuid default null,
  p_grupo_id uuid default null,
  p_ubicacion text default null
)
returns bigint
language plpgsql
stable
security definer
set search_path = public, pg_temp
-- plpgsql + plan por llamada: una función SQL (no se inlinea al ser SECURITY DEFINER) planifica
-- sin ver el valor de sus parámetros y con '%'||p_texto||'%' nunca elegía los trigramas
-- (medido: 406 ms con texto). En plpgsql con force_custom_plan el plan se arma con el texto
-- real: ~20 ms.
set plan_cache_mode = force_custom_plan
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
      -- Pendiente de reconteo: mismo criterio que la columna reconteo_pendiente de skus_busqueda.
      (p_estado = 'reconteo_pendiente' and s.ultimo_conteo_id is not null
        and coalesce(s.ultimo_conteo_diferencia, 0) <> 0
        and (s.ultimo_conteo_ciclo_id = v_ciclo or v_ciclo is null)
        and not exists (select 1 from public.conteos co where co.id = s.ultimo_conteo_id and co.reconteo_descartado_en is not null)) or
      -- Las dos mitades de "Con diferencia", por signo: mismo criterio que el gráfico "Resumen por
      -- estado" en la app (estado con_diferencia Y signo), así positiva + negativa = con_diferencia.
      (p_estado = 'diferencia_positiva' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia > 0) or
      (p_estado = 'diferencia_negativa' and s.ultimo_conteo_estado = 'con_diferencia' and s.ultimo_conteo_diferencia < 0) or
      (p_estado not in ('no_contado','reconteo_pendiente','diferencia_positiva','diferencia_negativa') and s.ultimo_conteo_estado = p_estado)
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

revoke all on function public.contar_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamp with time zone, timestamp with time zone, uuid, uuid, text) from public, anon;
grant execute on function public.contar_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamp with time zone, timestamp with time zone, uuid, uuid, text) to authenticated;

create or replace function public.filas_busqueda_skus(
  p_texto text default null,
  p_bodega text default null,
  p_estado text default null,
  p_ciclo text default null,
  p_solo_fuera_de_plan boolean default false,
  p_solo_criticos boolean default false,
  p_clase_abc text default null,
  p_fecha_desde timestamp with time zone default null,
  p_fecha_hasta timestamp with time zone default null,
  p_usuario_id uuid default null,
  p_grupo_id uuid default null,
  p_ubicacion text default null,
  p_orden_campo text default null,
  p_orden_dir text default null,
  p_limite integer default 30,
  p_offset integer default 0
)
returns setof public.skus_busqueda
language plpgsql
stable
security definer
set search_path = public, pg_temp
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
          ($5 not in ('no_contado','reconteo_pendiente','diferencia_positiva','diferencia_negativa') and s.ultimo_conteo_estado = $5)
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
        p_fecha_desde, p_fecha_hasta, p_usuario_id, p_grupo_id, v_ciclo, v_limite, v_offset;
end;
$function$;

revoke all on function public.filas_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamp with time zone, timestamp with time zone, uuid, uuid, text, text, text, integer, integer) from public, anon;
grant execute on function public.filas_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamp with time zone, timestamp with time zone, uuid, uuid, text, text, text, integer, integer) to authenticated;
