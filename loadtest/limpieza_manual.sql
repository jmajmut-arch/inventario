-- Limpieza de respaldo para la prueba de carga (inventia-loadtest.js).
--
-- El script k6 se limpia solo al terminar (borra los conteos que generó y los usuarios
-- de prueba que creó). Usa este script SOLO si una corrida se cortó a medio camino
-- (Ctrl+C, corte de luz, etc.) y quedaron usuarios de prueba o conteos sin borrar.
--
-- Corre esto en el SQL Editor de Supabase, o pídemelo y lo hago yo por acá.

-- 1) Borrar conteos de las empresas de prueba (deja las empresas y sus 300 SKU para reusar
--    en la próxima corrida — no hace falta recrearlas cada vez).
delete from conteos where empresa_id in (select id from empresas where nombre like '__LOADTEST_%');

-- 2) Borrar los usuarios de auth que haya dejado un run interrumpido (el patrón de correo
--    que usa el script siempre empieza con "loadtest-").
delete from auth.users where email like 'loadtest-%@inventia-test.local';

-- 3) Si además quieres borrar TODO (empresas + SKU de prueba, para no dejar nada):
-- delete from skus where empresa_id in (select id from empresas where nombre like '__LOADTEST_%');
-- delete from empresas where nombre like '__LOADTEST_%';

-- Verificación:
select
  (select count(*) from empresas where nombre like '__LOADTEST_%') as empresas_prueba,
  (select count(*) from conteos where empresa_id in (select id from empresas where nombre like '__LOADTEST_%')) as conteos_prueba,
  (select count(*) from auth.users where email like 'loadtest-%@inventia-test.local') as usuarios_prueba;
