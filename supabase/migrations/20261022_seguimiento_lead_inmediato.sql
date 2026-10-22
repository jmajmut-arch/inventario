-- El primer correo al lead de demo sale a los 10 minutos, no a las 24 horas (Joel, 22/10/2026).
--
-- Hasta hoy el paso 1 ("Una pregunta sobre tu bodega") salía 24 horas después de pedir la demo:
-- 25,4 h en promedio en los 12 enviados. El mejor momento para preguntarle por su inventario es
-- mientras todavía tiene la demo abierta. A los 10 minutos, no al instante: el correo va firmado por
-- Joel, y en el mismo segundo del formulario se notaría automático.
--
-- Igual que antes, nunca sale de noche: solo entre 08:00 y 20:00 de Chile; quien pide la demo de
-- madrugada lo recibe a las 08:00. El paso 2 sigue a 3 días del paso 1. Para que "10 minutos" sea
-- de verdad, el cron pasa de cada hora a cada 5 minutos (la consulta es sobre leads_demo, unas
-- decenas de filas). La primera frase del correo cambió a "Gracias por pedir acceso a la demo"
-- (supabase/functions/seguimiento-lead).

set local lock_timeout = '5s';

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
      and l.creado_en >= timestamptz '2026-09-30 00:00:00-03' -- desde el 30/09 para incluir el lead del día anterior al estreno (pedido de Joel)
      and (
        (l.seguimiento1_en is null and l.creado_en <= now() - interval '10 minutes' and l.creado_en >= now() - interval '7 days')
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

-- Mismo nombre de tarea: cron.schedule con un nombre existente reemplaza su horario.
select cron.schedule('seguimiento-leads-horario', '*/5 * * * *', $$select public.enviar_seguimientos_leads();$$);
