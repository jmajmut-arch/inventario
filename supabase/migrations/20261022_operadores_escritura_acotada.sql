-- Lo que un operador puede escribir directo en la base, acotado a lo que la app le deja hacer
-- (Joel, 22/10/2026).
--
-- Las reglas de escritura de skus, plan_semanal (y sus tablas hijas), cargas_masivas y
-- responsables_proceso solo pedían ser de la empresa: un operador -- y la cuenta del visitante de la
-- demo pública, que cualquiera puede usar -- podía saltarse la app y, por la API, cambiar stock, costo
-- o desactivar materiales, o crear, editar y borrar el plan de su empresa. Nunca de otra empresa.
--
-- Revisado en la app qué escribe un operador de verdad:
--  * skus: crear un material (pantalla SKU y "sin señal"), asociar un código de barras al escanear, y
--    cambiar la ubicación de un material (botón Ubicación de Bodega: bodega, ubicacion, storage_bin).
--    Además, las funciones de Bodega que usa (registrar_documento_bodega, _transferencia, _apertura)
--    escriben costo, activo y stock con los permisos de quien llama, y el conteo actualiza el último
--    conteo del material desde un trigger SECURITY DEFINER.
--  * plan_semanal y sus hijas, cargas_masivas y responsables_proceso: nunca (Plan, Grupos, Períodos y
--    Carga son pantallas de administrador; responsables_proceso ya no se escribe desde la app).
--
-- Por eso:
--  1. plan_semanal, plan_semanal_exclusiones, plan_semanal_incluidos, plan_semanal_skus,
--     cargas_masivas y responsables_proceso: escribir exige ser administrador de la empresa (o súper admin,
--     igual que la app: VISTAS_SOLO_ADMIN).
--  2. skus: un trigger mira la ruta del pedido que PostgREST deja en request.path. Solo cuando un
--     no-administrador modifica /skus directamente, deja cambiar codigo_barras, bodega, ubicacion y
--     storage_bin, y rechaza el resto con un error claro. Las funciones (/rpc/...), los triggers y
--     los administradores siguen igual. Crear materiales sigue abierto (es una función de terreno).
-- Verificado antes de aplicar, en una transacción revertida, simulando cada caso (ver el PR).

set local lock_timeout = '5s';

-- 1. Escritura solo para administradores -------------------------------------------------------

alter policy auth_write_plan_semanal on public.plan_semanal
  with check ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));
alter policy auth_update_plan_semanal on public.plan_semanal
  using ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())))
  with check ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));
alter policy auth_delete_plan_semanal on public.plan_semanal
  using ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));

alter policy auth_insert_plan_semanal_exclusiones on public.plan_semanal_exclusiones
  with check ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));
alter policy auth_delete_plan_semanal_exclusiones on public.plan_semanal_exclusiones
  using ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));

alter policy auth_insert_plan_semanal_incluidos on public.plan_semanal_incluidos
  with check ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));
alter policy auth_delete_plan_semanal_incluidos on public.plan_semanal_incluidos
  using ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));

alter policy auth_insert on public.plan_semanal_skus
  with check ((exists ( select 1 from public.plan_semanal p
                        where p.id = plan_semanal_skus.plan_id and p.empresa_id = (select public.empresa_actual())))
              and ((select public.es_admin_actual()) or (select public.es_super_admin())));
alter policy auth_delete on public.plan_semanal_skus
  using ((exists ( select 1 from public.plan_semanal p
                   where p.id = plan_semanal_skus.plan_id and p.empresa_id = (select public.empresa_actual())))
         and ((select public.es_admin_actual()) or (select public.es_super_admin())));

-- cargas_masivas tenía una sola regla para todo (ALL): leer y escribir. Solo la usan Carga y
-- Exportar datos, las dos de administrador.
alter policy auth_all_cargas on public.cargas_masivas
  using ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())))
  with check ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));

alter policy auth_insert_responsables_proceso on public.responsables_proceso
  with check ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));
alter policy auth_update_responsables_proceso on public.responsables_proceso
  using ((empresa_id = (select public.empresa_actual())) and ((select public.es_admin_actual()) or (select public.es_super_admin())));

-- 2. skus: lo que un no-administrador puede cambiar directo por la API ---------------------------

create or replace function public.skus_limita_edicion_directa()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cambios text[];
begin
  -- Solo un pedido directo a /skus (PostgREST deja la ruta en request.path; se acepta también con
  -- prefijo, por si llega como /rest/v1/skus). Las funciones (/rpc/...), los triggers que corren
  -- dentro de otro pedido (un conteo actualiza skus desde /conteos) y las tareas de la base no
  -- pasan por acá.
  if coalesce(current_setting('request.path', true), '') !~ '(^|/)skus/?$' then
    return new;
  end if;
  if (select public.es_admin_actual()) or (select public.es_super_admin()) then
    return new;
  end if;
  select array_agg(n.key order by n.key) into v_cambios
  from jsonb_each(to_jsonb(new)) n
  join jsonb_each(to_jsonb(old)) o on o.key = n.key
  where n.value is distinct from o.value
    -- Lo que la app deja hacer a un operador (asociar código de barras, cambiar de ubicación) y lo
    -- que la base calcula sola.
    and n.key not in ('codigo_barras', 'bodega', 'ubicacion', 'storage_bin',
                      'bodega_key', 'ubicacion_key', 'storage_bin_key', 'batch_key', 'updated_at');
  if v_cambios is not null then
    raise exception 'Solo un administrador puede cambiar % de un material', array_to_string(v_cambios, ', ')
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
revoke all on function public.skus_limita_edicion_directa() from public, anon;

create trigger trg_skus_limita_edicion_directa
  before update on public.skus
  for each row execute function public.skus_limita_edicion_directa();
