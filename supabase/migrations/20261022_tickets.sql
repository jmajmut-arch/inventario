-- Reportar un problema desde la app (Joel, 21/10/2026). Sigue a 20261022_baja_empresa.sql.
--
-- Cualquier persona con sesión puede reportar un problema (texto, foto opcional y, si viene desde
-- un mensaje de error, el error exacto y la pantalla). Quién ve qué:
--   · quien lo reportó: los suyos;
--   · el administrador de la empresa: todos los de su empresa;
--   · el súper admin: los de todas las empresas, para atenderlos. Es la tercera relación en que ve
--     filas de otras empresas (junto con usuarios y flow_eventos), decidido por Joel el 21/10/2026;
--     sigue sin ver sus materiales, conteos ni nada más.
-- Solo el súper admin cambia el estado y escribe la respuesta. Nadie los borra desde la app (no hay
-- política para eso); se van solo con la baja de la empresa (Edge Function eliminar-empresa).
--
-- Cada reporte nuevo avisa por correo a contacto@inventiapp.cl (Edge Function notificar-ticket,
-- llamada por pg_net, igual que notificar-lead). Nunca se copian a GitHub: el repo es público y
-- un reporte puede traer datos del cliente.

set local lock_timeout = '5s';

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  numero bigint generated always as identity,
  empresa_id uuid not null references public.empresas(id),
  creado_por uuid not null,               -- auth.uid() de quien reporta
  usuario_id uuid,                        -- usuarios.id (sin FK: el nombre queda copiado abajo)
  creado_por_nombre text,
  creado_por_rol text,
  descripcion text not null check (length(btrim(descripcion)) between 1 and 4000),
  error_mensaje text check (error_mensaje is null or length(error_mensaje) <= 2000),
  pantalla text check (pantalla is null or length(pantalla) <= 100),
  contexto jsonb,
  foto_ruta text check (foto_ruta is null or length(foto_ruta) <= 300),
  estado text not null default 'abierto' check (estado in ('abierto', 'en_revision', 'resuelto')),
  respuesta text check (respuesta is null or length(respuesta) <= 4000),
  respondido_por_nombre text,
  respondido_en timestamptz,
  notificado_en timestamptz,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
comment on table public.tickets is 'Problemas reportados desde la app. Ver supabase/migrations/20261022_tickets.sql.';

create index if not exists tickets_empresa_creado_idx on public.tickets (empresa_id, creado_en desc);
create index if not exists tickets_creado_por_idx on public.tickets (creado_por, creado_en desc);
create index if not exists tickets_estado_idx on public.tickets (estado, creado_en desc);

alter table public.tickets enable row level security;
revoke all on public.tickets from anon;

create policy tickets_insert on public.tickets
  for insert to authenticated
  with check (empresa_id = (select public.empresa_actual()) and creado_por = (select auth.uid()));

create policy tickets_select on public.tickets
  for select to authenticated
  using (
    creado_por = (select auth.uid())
    or (empresa_id = (select public.empresa_actual()) and (select public.es_admin_actual()))
    or (select public.es_super_admin())
  );

create policy tickets_update_super_admin on public.tickets
  for update to authenticated
  using ((select public.es_super_admin()))
  with check ((select public.es_super_admin()));

-- Al crear: la empresa, el autor y el estado los pone la base, no el navegador. Tope de 10
-- reportes por persona por hora, para que un botón apretado en bucle no llene la casilla.
create or replace function public.tickets_antes_insertar()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_usuario record;
  v_recientes int;
begin
  new.empresa_id := (select public.empresa_actual());
  if new.empresa_id is null then
    raise exception 'No se pudo identificar tu empresa para enviar el reporte' using errcode = '42501';
  end if;
  select u.id, u.nombre, u.rol into v_usuario
    from public.usuarios u where u.auth_user_id = (select auth.uid());
  select count(*) into v_recientes from public.tickets t
    where t.creado_por = (select auth.uid()) and t.creado_en > now() - interval '1 hour';
  if v_recientes >= 10 then
    raise exception 'Ya enviaste 10 reportes en la última hora. Espera un rato o escríbenos a contacto@inventiapp.cl' using errcode = 'P0001';
  end if;
  new.creado_por := (select auth.uid());
  new.usuario_id := v_usuario.id;
  new.creado_por_nombre := v_usuario.nombre;
  new.creado_por_rol := v_usuario.rol;
  new.descripcion := btrim(new.descripcion);
  new.estado := 'abierto';
  new.respuesta := null;
  new.respondido_por_nombre := null;
  new.respondido_en := null;
  new.notificado_en := null;
  new.creado_en := now();
  new.actualizado_en := now();
  return new;
end;
$function$;

create trigger trg_tickets_antes_insertar
  before insert on public.tickets
  for each row execute function public.tickets_antes_insertar();

-- Al actualizar: lo que la persona reportó no se toca; solo cambian el estado, la respuesta (con
-- quién y cuándo) y la marca del correo de aviso.
create or replace function public.tickets_antes_actualizar()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  new.id := old.id;
  new.empresa_id := old.empresa_id;
  new.creado_por := old.creado_por;
  new.usuario_id := old.usuario_id;
  new.creado_por_nombre := old.creado_por_nombre;
  new.creado_por_rol := old.creado_por_rol;
  new.descripcion := old.descripcion;
  new.error_mensaje := old.error_mensaje;
  new.pantalla := old.pantalla;
  new.contexto := old.contexto;
  new.foto_ruta := old.foto_ruta;
  new.creado_en := old.creado_en;
  if new.respuesta is distinct from old.respuesta then
    new.respuesta := nullif(btrim(new.respuesta), '');
    new.respondido_en := case when new.respuesta is null then null else now() end;
    new.respondido_por_nombre := case when new.respuesta is null then null
      else (select u.nombre from public.usuarios u where u.auth_user_id = (select auth.uid())) end;
  else
    new.respondido_en := old.respondido_en;
    new.respondido_por_nombre := old.respondido_por_nombre;
  end if;
  new.actualizado_en := now();
  return new;
end;
$function$;

create trigger trg_tickets_antes_actualizar
  before update on public.tickets
  for each row execute function public.tickets_antes_actualizar();

-- Aviso por correo: AFTER INSERT encola la llamada (pg_net, asíncrona: no frena ni puede hacer
-- fallar el reporte). Solo viaja el id; la función lee la fila con el service role y manda un
-- único correo por reporte (notificado_en). El anon key es público y solo pasa verify_jwt.
create or replace function public.notificar_ticket()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  perform net.http_post(
    url := 'https://ncvwgsbcvklhbyvurxzz.supabase.co/functions/v1/notificar-ticket',
    body := jsonb_build_object('id', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jdndnc2JjdmtsaGJ5dnVyeHp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTcwMDAsImV4cCI6MjEwMjA3MzAwMH0.ElSrlTk0Mheb9P37BCGOLHqgGIxMVmoRLdpnlDSZYbE',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jdndnc2JjdmtsaGJ5dnVyeHp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTcwMDAsImV4cCI6MjEwMjA3MzAwMH0.ElSrlTk0Mheb9P37BCGOLHqgGIxMVmoRLdpnlDSZYbE'
    ),
    timeout_milliseconds := 10000
  );
  return new;
end;
$function$;
revoke all on function public.notificar_ticket() from public, anon, authenticated;
revoke all on function public.tickets_antes_insertar() from public, anon;
revoke all on function public.tickets_antes_actualizar() from public, anon;

create trigger trg_notificar_ticket
  after insert on public.tickets
  for each row execute function public.notificar_ticket();

-- La foto del reporte va en el bucket de siempre, bajo <empresa>/tickets/. La empresa ya la lee
-- con auth_read_fotos; el súper admin necesita leer esa carpeta, y solo esa, de otras empresas.
create policy super_admin_lee_fotos_tickets on storage.objects
  for select to authenticated
  using (
    bucket_id = 'fotos-inventario'
    and (storage.foldername(name))[2] = 'tickets'
    and (select public.es_super_admin())
  );

-- El resumen previo a una baja también cuenta los reportes.
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
    'cargas_masivas', 'responsables_proceso', 'tickets', 'auditoria', 'flow_eventos'] loop
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
