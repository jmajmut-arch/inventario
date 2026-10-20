-- Dueños de stock dentro de una empresa (Joel, 20/10/2026). Pasos 2 y 3 de "varias empresas en
-- una empresa": un operador logístico guarda mercadería de varios clientes en sus bodegas, y cada
-- fila de stock es de uno de ellos (en su WMS, la columna SUPERFAMILIA). El mismo código de dos
-- clientes en el mismo bin son dos materiales, cada uno con su cantidad.
--
-- 1. empresas.usa_duenos_stock: interruptor por empresa, apagado. Lo cambia solo un súper admin,
--    igual que el módulo de bodega (empresas_protege_columnas_de_negocio).
-- 2. duenos_stock: la lista de dueños de cada empresa (código, nombre, activo). La lee cualquiera
--    de la empresa; la edita un administrador. No se borra: se desactiva (sin grant de delete).
-- 3. skus.dueno: el código del dueño de la fila; '' es "sin dueño", lo de siempre. Con default
--    constante, Postgres agrega la columna sin reescribir la tabla (203.336 filas, 229 MB el
--    20/10/2026; una columna generada como bodega_key la habría reescrito con sus índices de
--    trigramas, con skus bloqueada). Un trigger exige que el dueño exista en la lista de la
--    empresa, y solo corre cuando la fila trae dueño.
-- 4. La identidad del material pasa a incluir al dueño: índice único (empresa_id, sku_code,
--    bodega_key, batch_key, ubicacion_key, storage_bin_key, dueno). Medido sobre una copia de las
--    203.336 filas: 200 ms. Se crea al lado del índice actual, que se queda por ahora: con los
--    dos, la app publicada (on_conflict sin dueño) y la nueva (con dueño) funcionan las dos
--    durante el despliegue, y como todas las filas tienen dueño '', el índice actual no restringe
--    nada que el nuevo no restrinja. El índice actual se borra recién en el paso 4, cuando la
--    primera empresa cargue materiales con dueño (antes no estorba): para entonces la app ya se
--    habrá actualizado en todos los celulares, y una versión vieja guardada no se queda sin
--    carga (expandir ahora, contraer después).

set local lock_timeout = '5s';

-- 1. Interruptor por empresa
alter table public.empresas add column if not exists usa_duenos_stock boolean not null default false;

create or replace function public.empresas_protege_columnas_de_negocio()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- Sin usuario autenticado es el service role (Edge Functions de Flow, reset de la demo): pasa.
  if auth.uid() is null then return new; end if;
  if public.es_super_admin() then return new; end if;
  if new.plan_id is distinct from old.plan_id
     or new.modulo_bodega_habilitado is distinct from old.modulo_bodega_habilitado
     or new.bodega_funciones is distinct from old.bodega_funciones
     or new.usa_duenos_stock is distinct from old.usa_duenos_stock
     or new.codigo_invitacion is distinct from old.codigo_invitacion
     or new.activo is distinct from old.activo
     or new.flow_customer_id is distinct from old.flow_customer_id
     or new.flow_subscription_id is distinct from old.flow_subscription_id
     or new.flow_subscription_status is distinct from old.flow_subscription_status
     or new.flow_sync_en is distinct from old.flow_sync_en then
    raise exception 'El plan, el módulo de bodega, los dueños de stock y la suscripción los administra InventIA, no la empresa';
  end if;
  return new;
end $function$;

-- 2. Lista de dueños
create table if not exists public.duenos_stock (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  codigo text not null check (codigo <> '' and codigo = btrim(codigo)),
  nombre text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  unique (empresa_id, codigo)
);

alter table public.duenos_stock enable row level security;

create policy auth_read_duenos_stock on public.duenos_stock
  for select to authenticated
  using (empresa_id = (select public.empresa_actual()));
create policy admin_write_duenos_stock on public.duenos_stock
  for insert to authenticated
  with check (empresa_id = (select public.empresa_actual()) and (select public.es_admin_actual()));
create policy admin_update_duenos_stock on public.duenos_stock
  for update to authenticated
  using (empresa_id = (select public.empresa_actual()) and (select public.es_admin_actual()))
  with check (empresa_id = (select public.empresa_actual()) and (select public.es_admin_actual()));

revoke all on public.duenos_stock from public, anon, authenticated;
grant select, insert, update (nombre, activo) on public.duenos_stock to authenticated;

-- La auditoría acepta una lista cerrada de tablas (auditoria_tabla_check, creada fuera de las
-- migraciones del repo): sin 'duenos_stock', el primer dueño creado fallaba (lo destapó el ensayo
-- de esta migración). Reemplazarla y revisar las 75.394 filas tomó 68 ms el 20/10/2026, con la
-- auditoría bloqueada ese rato: cabe en esta misma migración.
alter table public.auditoria drop constraint if exists auditoria_tabla_check;
alter table public.auditoria add constraint auditoria_tabla_check check (tabla = any (array[
  'usuarios', 'empresas', 'conteos', 'skus', 'documentos_bodega', 'movimientos_bodega',
  'proveedores', 'personas_retiro', 'ubicaciones', 'duenos_stock'])) not valid;
alter table public.auditoria validate constraint auditoria_tabla_check;

create trigger auditoria_duenos_stock
  after insert or delete or update on public.duenos_stock
  for each row execute function public.registrar_auditoria();

-- 3. Dueño en cada fila de stock
alter table public.skus add column if not exists dueno text not null default '';

create or replace function public.skus_valida_dueno()
 returns trigger
 language plpgsql
 security invoker
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not exists (select 1 from public.duenos_stock d where d.empresa_id = new.empresa_id and d.codigo = new.dueno) then
    raise exception 'El dueño "%" no está en la lista de dueños de stock de la empresa', new.dueno
      using errcode = '23503';
  end if;
  return new;
end $function$;

revoke all on function public.skus_valida_dueno() from public, anon;

create trigger trg_skus_valida_dueno
  before insert or update of dueno on public.skus
  for each row when (new.dueno <> '')
  execute function public.skus_valida_dueno();

-- 4. Identidad con dueño (el índice actual se queda hasta que la app nueva esté publicada)
create unique index if not exists skus_identidad_con_dueno_key
  on public.skus (empresa_id, sku_code, bodega_key, batch_key, ubicacion_key, storage_bin_key, dueno);
