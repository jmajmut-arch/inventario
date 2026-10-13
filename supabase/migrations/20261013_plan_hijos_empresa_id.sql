-- Exclusiones e incluidos del plan: empresa_id propio y RLS directa (13/10/2026).
--
-- Las políticas de plan_semanal_exclusiones y plan_semanal_incluidos miraban la empresa a través
-- del plan: EXISTS (select 1 from plan_semanal p where p.id = plan_id and p.empresa_id = ...).
-- Postgres evalúa ese EXISTS por cada fila que lee. avance_plan_por_ciclo (el Dashboard) cruza los
-- materiales con las exclusiones y, en Escondida, eso eran ~17.000 búsquedas en el índice y 12.600
-- ejecuciones del subplan de la política: ~110 de los ~150 ms de la vista.
--
-- Ahora cada fila lleva su empresa_id y la política lo compara directo. La columna la llena un
-- trigger desde el plan, siempre (la app no la envía, y si alguien la envía se ignora): el trigger
-- corre con los permisos de quien inserta, así que en un plan ajeno no ve el plan, deja
-- empresa_id en null y el insert falla por not null. Las políticas se modifican en su lugar
-- (alter policy): mismos nombres, mismos comandos, mismo rol.
--
-- Comparado antes y después dentro de una transacción revertida, como Escondida, Joel (súper
-- admin), __CARGA_1__ y __CARGA_2__: Dashboard, avance_plan_por_ciclo, plan_semanal_detalle,
-- plan_ventana_pantalla, resumen_calendario_mes, skus_disponibles_planificar y filas visibles,
-- idénticos. Lo único que cambia es el orden interno de skus_excluidos en plan_semanal_detalle
-- (array_agg sin order by: sigue el orden físico de las filas, que el update reescribe); la app lo
-- usa como conjunto. Escritura: en un plan propio inserta con la empresa correcta; en uno ajeno,
-- con o sin empresa_id inventado, falla.
-- Escondida: avance_plan_por_ciclo 146 -> 61 ms, resumen_calendario_mes 133 -> 55 ms,
-- dashboard_ejecutivo 522 -> 445 ms.

set local lock_timeout = '5s';

alter table public.plan_semanal_exclusiones add column if not exists empresa_id uuid;
alter table public.plan_semanal_incluidos add column if not exists empresa_id uuid;

update public.plan_semanal_exclusiones x set empresa_id = p.empresa_id
  from public.plan_semanal p where p.id = x.plan_id and x.empresa_id is distinct from p.empresa_id;
update public.plan_semanal_incluidos i set empresa_id = p.empresa_id
  from public.plan_semanal p where p.id = i.plan_id and i.empresa_id is distinct from p.empresa_id;

-- Sin SECURITY DEFINER a propósito: lee el plan con los permisos de quien inserta.
create or replace function public.plan_hijo_fija_empresa()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  select p.empresa_id into new.empresa_id from public.plan_semanal p where p.id = new.plan_id;
  return new;
end;
$$;
revoke all on function public.plan_hijo_fija_empresa() from public, anon, authenticated;

create trigger trg_plan_semanal_exclusiones_empresa
  before insert or update of plan_id, empresa_id on public.plan_semanal_exclusiones
  for each row execute function public.plan_hijo_fija_empresa();
create trigger trg_plan_semanal_incluidos_empresa
  before insert or update of plan_id, empresa_id on public.plan_semanal_incluidos
  for each row execute function public.plan_hijo_fija_empresa();

alter table public.plan_semanal_exclusiones alter column empresa_id set not null;
alter table public.plan_semanal_incluidos alter column empresa_id set not null;
alter table public.plan_semanal_exclusiones
  add constraint plan_semanal_exclusiones_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);
alter table public.plan_semanal_incluidos
  add constraint plan_semanal_incluidos_empresa_id_fkey foreign key (empresa_id) references public.empresas(id);

create index if not exists plan_semanal_exclusiones_plan_sku_empresa_idx
  on public.plan_semanal_exclusiones (plan_id, sku_code, empresa_id);
create index if not exists plan_semanal_exclusiones_empresa_idx
  on public.plan_semanal_exclusiones (empresa_id);
create index if not exists plan_semanal_incluidos_empresa_idx
  on public.plan_semanal_incluidos (empresa_id);

alter policy auth_read_plan_semanal_exclusiones on public.plan_semanal_exclusiones
  using (empresa_id = (select public.empresa_actual()));
alter policy auth_insert_plan_semanal_exclusiones on public.plan_semanal_exclusiones
  with check (empresa_id = (select public.empresa_actual()));
alter policy auth_delete_plan_semanal_exclusiones on public.plan_semanal_exclusiones
  using (empresa_id = (select public.empresa_actual()));
alter policy auth_read_plan_semanal_incluidos on public.plan_semanal_incluidos
  using (empresa_id = (select public.empresa_actual()));
alter policy auth_insert_plan_semanal_incluidos on public.plan_semanal_incluidos
  with check (empresa_id = (select public.empresa_actual()));
alter policy auth_delete_plan_semanal_incluidos on public.plan_semanal_incluidos
  using (empresa_id = (select public.empresa_actual()));

analyze public.plan_semanal_exclusiones;
analyze public.plan_semanal_incluidos;
