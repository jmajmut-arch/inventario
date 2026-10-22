-- La vista materializada de la clasificación ABC de todas las empresas, sin uso desde
-- 20261022_abc_por_empresa.sql (Joel, 22/10/2026).
--
-- La clase vive en skus y la recalcula privado.recalcular_abc_empresa empresa por empresa. Antes de
-- quitarla se revisó en producción: ninguna vista, función, regla ni tarea programada la lee
-- (pg_depend, pg_proc, cron.job), ni la app ni las Edge Functions; y sus contadores de lectura
-- (pg_stat_user_tables) no se movieron después del cambio. Ocupaba 29 MB. Es un cálculo derivado de
-- skus: no se pierde ningún dato.
--
-- Se aplica desde el SQL Editor de Supabase (las herramientas de esta sesión no ejecutan DROP).

set local lock_timeout = '5s';

drop materialized view if exists privado.skus_valor_abc_empresa_mv;
