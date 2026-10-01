-- Seguimiento automático por correo a quien pidió la demo (pedido de Joel, 01/10/2026).
--
-- Dos correos cortos, escritos para abrir conversación y entender la necesidad, no para
-- insistir con la demo (textos en supabase/functions/seguimiento-lead):
--   paso 1: 24 horas después de pedir la demo ("Una pregunta sobre tu bodega");
--   paso 2: 3 días después del paso 1, si nadie detuvo el seguimiento ("¿Pudiste ver la demo?").
-- Solo leads de demo (tipo 'demo' o null): quien escribe por Contacto espera la respuesta de Joel,
-- no un automático. Solo leads creados desde que existe esta función: a los antiguos no se les
-- escribe de golpe. Se salta las filas de prueba (empresa Escondida) y los correos inválidos.
-- Nunca sale de noche: el cron corre cada hora, pero la función solo manda entre 08:00 y 20:00
-- hora de Chile; lo que venció de madrugada sale a las 08:00.
--
-- Joel detiene el seguimiento de un lead desde su panel (seguimiento_detenido_en): cuando ya
-- habló con la persona o cuando esta pidió no recibir más correos. Un correo por paso, nunca
-- dos: la Edge Function marca seguimientoN_en al confirmar Brevo y vuelve a verificar todo.
--
-- Igual que notificar_lead_demo: la llamada va por pg_net (asíncrona) con el anon key, que es
-- público y solo sirve para pasar verify_jwt; la función lee la fila con el service role.
alter table public.leads_demo add column if not exists seguimiento1_en timestamptz;
alter table public.leads_demo add column if not exists seguimiento2_en timestamptz;
alter table public.leads_demo add column if not exists seguimiento_detenido_en timestamptz;
comment on column public.leads_demo.seguimiento1_en is 'Cuándo salió el primer correo de seguimiento (24 h después de pedir la demo). Lo pone seguimiento-lead.';
comment on column public.leads_demo.seguimiento2_en is 'Cuándo salió el segundo y último correo de seguimiento (3 días después del primero).';
comment on column public.leads_demo.seguimiento_detenido_en is 'Joel detuvo el seguimiento (ya habló con la persona o esta pidió no recibir más correos). Null = sigue activo.';

-- El súper admin marca/desmarca "detener seguimiento" desde su panel de Leads.
drop policy if exists "solo super-admin edita los leads" on public.leads_demo;
create policy "solo super-admin edita los leads" on public.leads_demo
  for update to authenticated
  using ((select public.es_super_admin()))
  with check ((select public.es_super_admin()));

create or replace function public.enviar_seguimientos_leads()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hora int := extract(hour from (now() at time zone 'America/Santiago'));
  r record;
  v_encolados int := 0;
  v_anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jdndnc2JjdmtsaGJ5dnVyeHp6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTcwMDAsImV4cCI6MjEwMjA3MzAwMH0.ElSrlTk0Mheb9P37BCGOLHqgGIxMVmoRLdpnlDSZYbE';
begin
  if v_hora < 8 or v_hora >= 20 then
    return 0;
  end if;
  for r in
    select l.id,
      case when l.seguimiento1_en is null then 1 else 2 end as paso
    from public.leads_demo l
    where coalesce(l.tipo, 'demo') = 'demo'
      and l.seguimiento_detenido_en is null
      and l.email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
      and coalesce(l.empresa, '') !~* '^escondida'
      and l.creado_en >= timestamptz '2026-10-01 00:00:00-03'
      and (
        (l.seguimiento1_en is null and l.creado_en <= now() - interval '24 hours' and l.creado_en >= now() - interval '7 days')
        or (l.seguimiento1_en is not null and l.seguimiento2_en is null
            and l.seguimiento1_en <= now() - interval '72 hours' and l.seguimiento1_en >= now() - interval '7 days')
      )
    order by l.creado_en
    limit 20
  loop
    perform net.http_post(
      url := 'https://ncvwgsbcvklhbyvurxzz.supabase.co/functions/v1/seguimiento-lead',
      body := jsonb_build_object('id', r.id, 'paso', r.paso),
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_anon, 'Authorization', 'Bearer ' || v_anon),
      timeout_milliseconds := 10000
    );
    v_encolados := v_encolados + 1;
  end loop;
  return v_encolados;
end;
$$;

revoke all on function public.enviar_seguimientos_leads() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'seguimiento-leads-horario';
select cron.schedule('seguimiento-leads-horario', '7 * * * *', $$select public.enviar_seguimientos_leads();$$);
