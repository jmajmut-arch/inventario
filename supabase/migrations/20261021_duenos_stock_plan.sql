-- Dueños de stock: planificar por dueño (Joel, 21/10/2026). Sigue a
-- 20261021_duenos_stock_panel_rendimiento.sql.
--
-- Una entrada del plan puede acotarse a un dueño: plan_semanal.dueno (null = todos los dueños, lo
-- de siempre; '' = lo que no tiene dueño; un código = ese dueño). Con dueño, la entrada solo
-- incluye los materiales de ese dueño en el lugar elegido, y así lo ven Contar (también sin
-- señal), el calendario, la marca "fuera de plan" de un conteo, lo que queda por planificar y el
-- avance del plan en el Panel.
--
-- Todas las entradas que existen tienen dueno null: para ellas cada consulta da exactamente lo
-- mismo que antes (ensayado con Escondida comparando el md5 de los resultados).
--
-- Las funciones y vistas que arman el universo de una entrada son largas (diez casos de lugar
-- cada una). En vez de copiarlas enteras, se les aplica un cambio exacto de texto sobre su
-- definición actual: cada cambio exige encontrar el texto esperado tantas veces como se espera y,
-- si no, la migración se detiene sin tocar nada.

set local lock_timeout = '5s';

-- 1. El dueño de la entrada, validado contra la lista de la empresa (la misma función que valida
--    skus.dueno: exige que (empresa_id, dueno) exista en duenos_stock).
alter table public.plan_semanal add column if not exists dueno text;

-- Sin estadísticas de la columna nueva, Postgres supone que casi ninguna entrada tiene dueño null
-- (cuando son todas) y el "dueño null o el mismo" que se agrega abajo le cambia los planes: en el
-- ensayo, el calendario pasó de 0,08 a 1 s y el avance del plan de 0,06 a 2,5 s. Con la tabla
-- analizada sabe que son todas null y elige lo de siempre.
analyze public.plan_semanal;

create trigger trg_plan_semanal_valida_dueno
  before insert or update of dueno on public.plan_semanal
  for each row when (new.dueno is not null and new.dueno <> '')
  execute function public.skus_valida_dueno();

create or replace function pg_temp.parche(t text, a text, b text, n integer)
 returns text language plpgsql as $f$
declare c integer := (length(t) - length(replace(t, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then
    raise exception 'Parche: se esperaban % aparición(es) y hay % de: %', n, c, left(a, 120);
  end if;
  return replace(t, a, b);
end $f$;

do $plan$
declare d text;
begin
  -- 2. plan_semanal_detalle (la lista de entradas que lee la app) expone el dueño, al final.
  d := pg_get_viewdef('public.plan_semanal_detalle'::regclass, true);
  d := pg_temp.parche(d, E'END AS skus_incluidos\n   FROM plan_semanal ps', E'END AS skus_incluidos,\n    ps.dueno\n   FROM plan_semanal ps', 1);
  execute 'create or replace view public.plan_semanal_detalle with (security_invoker = true) as ' || d;

  -- 3. Universo de cada entrada (Contar, resumen de entradas, hoja, sin señal): con dueño, solo
  --    sus materiales. m trae s.* de skus_planificables, que ya expone dueno.
  d := pg_get_functiondef('public.skus_universo_entrada_plan_lote(uuid[])'::regprocedure);
  d := pg_temp.parche(d, E'  from m\n  where not exists (', E'  from m\n  join plan_semanal pd on pd.id = m.plan_id\n  where (pd.dueno is null or m.dueno = pd.dueno)\n    and not exists (', 1);
  execute d;

  -- 4. "Fuera de plan": un conteo está en el plan si alguna entrada del período lo incluye.
  d := pg_get_functiondef('public.sku_en_plan_del_periodo(uuid,uuid)'::regprocedure);
  d := pg_temp.parche(d, E'      and (public.plan_incluye_stock_cero()', E'      and (p.dueno is null or p.dueno = s.dueno)\n      and (public.plan_incluye_stock_cero()', 1);
  execute d;

  -- 5. Calendario: lo planificado de cada día.
  d := pg_get_functiondef('public.resumen_calendario_dias(date)'::regprocedure);
  d := pg_temp.parche(d, 'ps.ubicacion_nula, ps.por_sku' || E'\n    from plan_semanal ps', 'ps.ubicacion_nula, ps.por_sku, ps.dueno' || E'\n    from plan_semanal ps', 1);
  d := pg_temp.parche(d, 'join skus s on ', 'join skus s on (e.dueno is null or s.dueno = e.dueno) and ', 10);
  execute d;

  -- 6. Lo que queda por planificar: un material planificado para un dueño ya no está disponible;
  --    el de otro dueño en el mismo lugar, sí. La vista expone además el dueño, al final.
  d := pg_get_viewdef('public.skus_disponibles_planificar'::regclass, true);
  d := pg_temp.parche(d, E'ps.por_sku\n           FROM plan_semanal ps', E'ps.por_sku,\n            ps.dueno\n           FROM plan_semanal ps', 1);
  d := pg_temp.parche(d, 'JOIN skus_planificables s ON ', 'JOIN skus_planificables s ON (e.dueno IS NULL OR s.dueno = e.dueno) AND ', 9);
  d := pg_temp.parche(d, E'stock_transferencia\n   FROM skus_planificables sp', E'stock_transferencia,\n    dueno\n   FROM skus_planificables sp', 1);
  execute 'create or replace view public.skus_disponibles_planificar with (security_invoker = true) as ' || d;

  -- 7. Avance del plan (Panel de siempre).
  d := pg_get_viewdef('public.avance_plan_por_ciclo'::regclass, true);
  d := pg_temp.parche(d, E'plan_semanal.por_sku\n           FROM plan_semanal', E'plan_semanal.por_sku,\n            plan_semanal.dueno\n           FROM plan_semanal', 1);
  d := pg_temp.parche(d, 's.empresa_id = e.empresa_id AND s.activo', 's.empresa_id = e.empresa_id AND s.activo AND (e.dueno IS NULL OR s.dueno = e.dueno)', 10);
  execute 'create or replace view public.avance_plan_por_ciclo with (security_invoker = true) as ' || d;

  -- 8. Avance del plan (Panel filtrado por dueño).
  d := pg_get_functiondef('privado.dashboard_ejecutivo_calculo_dueno(integer,text,text)'::regprocedure);
  d := pg_temp.parche(d, E'plan_semanal.solo_sin_ubicacion, plan_semanal.ubicacion_nula, plan_semanal.por_sku\n                    from plan_semanal', E'plan_semanal.solo_sin_ubicacion, plan_semanal.ubicacion_nula, plan_semanal.por_sku, plan_semanal.dueno\n                    from plan_semanal', 1);
  d := pg_temp.parche(d, 's.empresa_id = e.empresa_id and s.activo', 's.empresa_id = e.empresa_id and s.activo and (e.dueno is null or s.dueno = e.dueno)', 10);
  execute d;
end $plan$;
