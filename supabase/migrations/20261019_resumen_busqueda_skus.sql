-- Buscar: los gráficos con el total real (Joel, 19/10/2026: "me sale primeros 1.000, eso no sirve,
-- deben ser los datos reales"). La app trae las filas de a tandas y armaba "Resumen por estado" y
-- "Quién contó" solo con lo cargado: con 1.218 resultados, los gráficos contaban 1.000.
--
-- resumen_busqueda_skus devuelve esos dos resúmenes calculados en la base, sobre TODO lo que calza
-- con los filtros. Los filtros son exactamente los de contar_busqueda_skus (el total que ya muestra
-- Buscar), copiados tal cual, más "Solo con fotografías", que en la app se filtra sobre lo cargado
-- y acá se resuelve con la misma regla que skus_busqueda.fotos (alguna foto de algún conteo del
-- material). Los grupos replican grupoEstadoBusqueda de la app:
--   no_contado: sin último conteo
--   negativa / positiva: último conteo con diferencia distinta de 0, según el signo
--   pendiente: sin diferencia y en pendiente_revision
--   cuadrado: el resto de lo contado
-- y las personas, resumenQuienConto: por nombre de quien hizo el último conteo ('Sin asignar' si
-- no tiene), solo sobre lo contado.
--
-- Igual que contar_busqueda_skus: SECURITY DEFINER con filtro explícito por empresa_actual() (para
-- usar los índices de trigramas, que bajo RLS no se usan), search_path fijo, EXECUTE solo para
-- authenticated.

set local lock_timeout = '5s';

create or replace function public.resumen_busqueda_skus(
  p_texto text default null::text, p_bodega text default null::text, p_estado text default null::text,
  p_ciclo text default null::text, p_solo_fuera_de_plan boolean default false, p_solo_criticos boolean default false,
  p_clase_abc text default null::text, p_fecha_desde timestamp with time zone default null::timestamp with time zone,
  p_fecha_hasta timestamp with time zone default null::timestamp with time zone, p_usuario_id uuid default null::uuid,
  p_grupo_id uuid default null::uuid, p_ubicacion text default null::text, p_solo_con_fotos boolean default false)
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

revoke all on function public.resumen_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamp with time zone, timestamp with time zone, uuid, uuid, text, boolean) from public, anon;
grant execute on function public.resumen_busqueda_skus(text, text, text, text, boolean, boolean, text, timestamp with time zone, timestamp with time zone, uuid, uuid, text, boolean) to authenticated;
