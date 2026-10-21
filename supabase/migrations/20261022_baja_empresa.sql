-- Dar de baja una empresa: base de apoyo (Joel, 21/10/2026). Sigue a
-- 20261022_duenos_stock_informe_cierre.sql.
--
-- El borrado en sí lo hace la Edge Function eliminar-empresa (supabase/functions/eliminar-empresa),
-- por tandas y con el rol de servicio: las fotos y las cuentas de acceso solo se pueden quitar con
-- las API de Storage y de Auth, y por tandas ninguna llamada pasa el statement_timeout. Esto deja:
--
-- 1. empresas_eliminadas: el registro de cada baja (qué empresa, cuándo, quién y cuánto tenía). Solo
--    lo lee un súper admin; lo escribe la Edge Function (rol de servicio).
-- 2. resumen_datos_empresa(empresa): cuántas filas y fotos tiene, para mostrarlo antes de confirmar.
--    Solo un súper admin. Son conteos, no datos: no abre la regla de que el súper admin no ve lo de
--    otras empresas (CLAUDE.md, "Qué ve un súper admin").
-- 3. fotos_empresa(empresa, límite): las rutas de sus archivos en Storage, para que la Edge Function
--    los quite. Solo el rol de servicio.

set local lock_timeout = '5s';

create table if not exists public.empresas_eliminadas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  nombre text not null,
  eliminada_en timestamptz not null default now(),
  eliminada_por uuid,
  eliminada_por_nombre text,
  resumen jsonb
);
alter table public.empresas_eliminadas enable row level security;
create policy empresas_eliminadas_super_admin on public.empresas_eliminadas
  for select using ((select public.es_super_admin()));
revoke all on public.empresas_eliminadas from anon;

create or replace function public.resumen_datos_empresa(p_empresa uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r jsonb := '{}'::jsonb;
  t text;
  n bigint;
begin
  if not public.es_super_admin() then
    raise exception 'Solo un súper admin puede ver el resumen de otra empresa' using errcode = '42501';
  end if;
  foreach t in array array['usuarios', 'skus', 'conteos', 'plan_semanal', 'ciclos_conteo', 'informes_ciclo',
    'grupos_conteo', 'skus_grupos_conteo', 'historial_ciclos_grupo', 'ubicaciones', 'ubicaciones_historial',
    'duenos_stock', 'documentos_bodega', 'movimientos_bodega', 'movimiento_fotos', 'ordenes_compra',
    'ordenes_compra_lineas', 'reservas', 'reservas_lineas', 'proveedores', 'personas_retiro',
    'cargas_masivas', 'responsables_proceso', 'auditoria', 'flow_eventos'] loop
    execute format('select count(*) from public.%I where empresa_id = $1', t) into n using p_empresa;
    r := r || jsonb_build_object(t, n);
  end loop;
  select r || jsonb_build_object(
           'fotos_archivos', count(*),
           'fotos_mb', round(coalesce(sum((o.metadata->>'size')::bigint), 0) / 1048576.0, 1))
    into r
  from storage.objects o
  where o.bucket_id = 'fotos-inventario' and o.name like p_empresa::text || '/%';
  return r;
end;
$function$;
revoke execute on function public.resumen_datos_empresa(uuid) from public, anon;
grant execute on function public.resumen_datos_empresa(uuid) to authenticated;

create or replace function public.fotos_empresa(p_empresa uuid, p_limite integer default 1000)
 returns setof text
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select o.name from storage.objects o
  where o.bucket_id = 'fotos-inventario' and o.name like p_empresa::text || '/%'
  order by o.name
  limit greatest(1, least(coalesce(p_limite, 1000), 1000));
$function$;
revoke execute on function public.fotos_empresa(uuid, integer) from public, anon, authenticated;
grant execute on function public.fotos_empresa(uuid, integer) to service_role;
