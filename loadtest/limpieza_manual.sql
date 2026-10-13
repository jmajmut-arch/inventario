-- Limpieza de la prueba de carga (inventia-loadtest.js).
--
-- La prueba trabaja sobre empresas creadas solo para ella, con nombre __CARGA_1__ .. __CARGA_5__
-- (materiales, plan y conteos inventados). Al terminar, k6 borra las fotos que subió; este script
-- borra todo lo demás: conteos, plan, materiales, usuarios de prueba y las empresas.
--
-- Pegar completo en Supabase -> SQL Editor -> Run. Todo va en una transacción: si algo falla, no
-- se borra nada. Antes de correrlo, el bloque de verificación de abajo debe mostrar SOLO las
-- empresas __CARGA_n__.
--
-- El "_" es comodín en LIKE: por eso el patrón va con escape (\_), para no tocar nada que solo
-- se parezca.

-- Verificación previa (correr sola primero):
-- select id, nombre from public.empresas where nombre like '\_\_CARGA\_%\_\_' escape '\';

begin;

create temp table _e on commit drop as
  select id from public.empresas where nombre like '\_\_CARGA\_%\_\_' escape '\';
create temp table _u on commit drop as
  select auth_user_id as id from public.usuarios where empresa_id in (select id from _e);

delete from public.conteo_fotos where conteo_id in (select id from public.conteos where empresa_id in (select id from _e));
delete from public.informes_ciclo        where empresa_id in (select id from _e);
delete from public.plan_semanal          where empresa_id in (select id from _e);
update public.skus set ultimo_conteo_id = null where empresa_id in (select id from _e) and ultimo_conteo_id is not null;
delete from public.conteos               where empresa_id in (select id from _e);
delete from public.ubicaciones_historial where empresa_id in (select id from _e);
delete from public.skus_grupos_conteo    where empresa_id in (select id from _e);
delete from public.historial_ciclos_grupo where empresa_id in (select id from _e);
delete from public.grupos_conteo         where empresa_id in (select id from _e);
delete from public.skus                  where empresa_id in (select id from _e);
delete from public.ubicaciones           where empresa_id in (select id from _e);
delete from public.cargas_masivas        where empresa_id in (select id from _e);
delete from public.responsables_proceso  where empresa_id in (select id from _e);
delete from public.ciclos_conteo         where empresa_id in (select id from _e);
delete from public.usuarios              where empresa_id in (select id from _e);
delete from public.empresas              where id in (select id from _e);
delete from public.auditoria             where empresa_id in (select id from _e);
delete from auth.users where id in (select id from _u) and email like '%@inventia-test.local';

commit;

-- Debe mostrar todo en 0.
select (select count(*) from public.empresas where nombre like '\_\_CARGA\_%\_\_' escape '\') as empresas,
       (select count(*) from auth.users where email like 'carga-%@inventia-test.local') as usuarios,
       (select count(*) from storage.objects where name like '%/\_\_carga\_\_/%' escape '\') as fotos_pendientes;
