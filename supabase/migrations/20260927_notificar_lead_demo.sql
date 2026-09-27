-- Aviso por correo de cada lead del sitio (ver supabase/functions/notificar-lead).
-- Aplicada el 27/09/2026 por MCP como "notificar_lead_demo". Se guarda acá para que el
-- trigger se pueda reconstruir sin depender del proyecto (RUNBOOK §5).

alter table public.leads_demo add column if not exists notificado_en timestamptz;
comment on column public.leads_demo.notificado_en is 'Cuándo salió el correo de aviso (lo pone la función notificar-lead). Null = todavía no avisado.';

-- Trigger AFTER INSERT: encola una llamada HTTP (pg_net, asíncrona: no frena ni puede hacer
-- fallar el INSERT del formulario) a la Edge Function con el id de la fila. Solo viaja el id: la
-- función lee la fila con el service role y manda un único correo por lead.
-- El anon key es público (está en el sitio); solo sirve para pasar verify_jwt de la función.
create or replace function public.notificar_lead_demo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://ncvwgsbcvklhbyvurxzz.supabase.co/functions/v1/notificar-lead',
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
$$;

-- SECURITY DEFINER porque el INSERT lo hace anon y net.http_post no es suyo. Devuelve trigger,
-- así que PostgREST no la expone; igual se le quita EXECUTE a todos (Postgres solo lo exige al
-- crear el trigger, no al dispararlo).
revoke all on function public.notificar_lead_demo() from public, anon, authenticated;

drop trigger if exists trg_notificar_lead_demo on public.leads_demo;
create trigger trg_notificar_lead_demo
  after insert on public.leads_demo
  for each row execute function public.notificar_lead_demo();
