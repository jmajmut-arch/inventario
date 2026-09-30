-- "Fuera de plan" lo decide la base, no la pantalla desde la que se contó.
--
-- Hasta ahora la app marcaba fuera_de_plan = true si el conteo no se hizo desde "Mi plan del día"
-- de Contar. Eso dejaba fuera de plan todo lo que contaba un admin (nunca es responsable) y todo lo
-- que se contaba buscando el código aunque estuviera planificado. Medido el 30/09/2026 en Escondida
-- (período Q1-MEL1, 580 conteos): 95 conteos de materiales planificados estaban marcados "fuera de
-- plan" (y 11 al revés). Con esta regla, el indicador refleja si el material estaba en el plan.
--
-- sku_en_plan_del_periodo: el material está en alguna entrada del período con las MISMAS reglas que
-- usa skus_universo_entrada_plan_lote para saber qué SKU cubre cada entrada (por código, bodega /
-- ubicación / storage bin, "sin ubicación específica", "SKU sin ubicación", "sin bodega asignada",
-- exclusiones y materiales en stock 0 según plan_incluye_stock_cero). Verificado con datos reales:
-- reconoce los 5.130 SKU pendientes del plan del período sin excepción. No mira la fecha de la
-- entrada: contar antes o después del día planificado sigue siendo dentro del plan.
--
-- El trigger corre BEFORE INSERT, después de trg_asignar_ciclo_conteo (orden alfabético), así que
-- el conteo ya trae su período. ~3,6 ms por conteo medido. Si algo fallara al calcularlo, el conteo
-- se guarda igual con lo que mandó la app y queda un WARNING en el log: perder un conteo de terreno
-- sería peor que un indicador impreciso. Solo en INSERT: no reescribe conteos ya guardados.
create or replace function public.sku_en_plan_del_periodo(p_sku_id uuid, p_ciclo_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.skus s
    join public.plan_semanal p on p.empresa_id = s.empresa_id and p.ciclo_id = p_ciclo_id
    where s.id = p_sku_id
      and (public.plan_incluye_stock_cero() or coalesce(s.stock_sistema,0) <> 0)
      and not exists (select 1 from public.plan_semanal_exclusiones e where e.plan_id = p.id and e.sku_code = s.sku_code)
      and (
        (p.por_sku and exists (select 1 from public.plan_semanal_incluidos i where i.plan_id = p.id and i.sku_id = s.id))
        or (not p.por_sku and p.solo_sin_ubicacion and s.bodega is null and s.ubicacion is null)
        or (not p.por_sku and not p.solo_sin_ubicacion
            and ((coalesce(p.bodega,'') <> '' and p.bodega = s.bodega)
                 or (p.bodega = '' and s.bodega is null)
                 or p.bodega is null)
            and ((p.ubicacion_nula and s.ubicacion is null)
                 or (not p.ubicacion_nula and (coalesce(p.ubicacion,'') = '' or s.ubicacion = p.ubicacion)))
            and (coalesce(p.storage_bin,'') = '' or s.storage_bin = p.storage_bin))
      )
  );
$$;

revoke all on function public.sku_en_plan_del_periodo(uuid, uuid) from public, anon;
grant execute on function public.sku_en_plan_del_periodo(uuid, uuid) to authenticated;

create or replace function public.marcar_fuera_de_plan()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.ciclo_id is not null and new.sku_id is not null then
    begin
      new.fuera_de_plan := not public.sku_en_plan_del_periodo(new.sku_id, new.ciclo_id);
    exception when others then
      raise warning 'marcar_fuera_de_plan: se conserva el valor de la app (%): %', new.fuera_de_plan, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.marcar_fuera_de_plan() from public, anon;

drop trigger if exists trg_marcar_fuera_de_plan on public.conteos;
create trigger trg_marcar_fuera_de_plan
  before insert on public.conteos
  for each row execute function public.marcar_fuera_de_plan();
