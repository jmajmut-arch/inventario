-- El proceso nocturno de purga de auditoría se llamaba "purga-auditoria-14-dias", pero desde
-- 20260919 (auditoria_retencion_180_dias) purgar_auditoria_antigua() conserva 180 días: el nombre
-- engañaba a quien lo leyera (revisión del 14/10/2026). Mismo horario, mismo comando, mismo dueño
-- (postgres); solo cambia el nombre. Primero se crea el nuevo y después se quita el viejo, para que
-- nunca quede la noche sin purga.

select cron.schedule('purga-auditoria-180-dias', '0 6 * * *', 'select public.purgar_auditoria_antigua();');
select cron.unschedule('purga-auditoria-14-dias');
