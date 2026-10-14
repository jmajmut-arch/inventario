-- Retención de la auditoría: 45 días (decisión de Joel, 14/10/2026). Antes, 180 días
-- (20260919_auditoria_retencion_180_dias) y en el origen 14. La revisión de seguridad del 19/09
-- anotaba que una certificación suele pedir entre 90 días y un año: queda registrado ahí que esta
-- retención más corta es una decisión explícita.
--
-- Al aplicarla no se borra nada: el registro más antiguo es del 04/09/2026 (40 días). La primera
-- purga real ocurre la noche del 20/10. Mismo cuerpo que antes salvo el intervalo: de a 5.000 filas,
-- SECURITY DEFINER con search_path fijo; create or replace conserva los permisos (solo postgres y
-- service_role pueden ejecutarla).
--
-- El proceso nocturno se renombra a "purga-auditoria-45-dias" (mismo horario, comando y dueño):
-- primero se crea el nuevo y después se quita el anterior.

set local lock_timeout = '5s';

create or replace function public.purgar_auditoria_antigua()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_borradas integer;
begin
  loop
    delete from public.auditoria where id in (
      select id from public.auditoria where creado_en < now() - interval '45 days' limit 5000
    );
    get diagnostics v_borradas = row_count;
    exit when v_borradas = 0;
  end loop;
end;
$function$;

select cron.schedule('purga-auditoria-45-dias', '0 6 * * *', 'select public.purgar_auditoria_antigua();');
select cron.unschedule('purga-auditoria-180-dias');
