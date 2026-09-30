-- Un solo administrador por empresa en los planes Básico y Profesional (pedido de Joel, 30/09/2026).
--
-- El sitio ya lo promete ("Un administrador + hasta 1 operador" / "+ hasta 2 operadores") pero la
-- base solo limitaba operadores (chequear_limite_usuarios cuenta rol <> 'admin'): un súper admin
-- podía invitar o ascender a un segundo admin sin que nada lo frenara. Igual que max_usuarios, el
-- tope va en `planes` (columna, no un nombre de plan en el código): Básico y Profesional = 1,
-- Empresa = null (sin límite), y una empresa nueva hereda lo de su plan.
--
-- El trigger cubre todos los caminos que crean o vuelven admin a alguien: la invitación (Edge
-- Function invite-user, que hace upsert en usuarios con service role), el cambio de rol desde súper
-- admin, reactivar a un admin inactivo y mover a alguien de empresa. El alta autoservicio crea el
-- primer admin de una empresa nueva (0 activos), así que no lo toca. Un admin existente no se ve
-- afectado: solo se rechaza el que haría pasar el tope.
alter table public.planes add column if not exists max_admins integer;
comment on column public.planes.max_admins is 'Administradores activos permitidos por empresa; null = sin límite (ver chequear_limite_admins).';
update public.planes set max_admins = 1 where nombre in ('basico', 'profesional') and max_admins is null;

create or replace function public.chequear_limite_admins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_max int;
  v_activos int;
begin
  if new.activo and new.rol = 'admin' then
    perform 1 from public.empresas where id = new.empresa_id for update;
    select p.max_admins into v_max
      from public.planes p join public.empresas e on e.plan_id = p.id
     where e.id = new.empresa_id;
    if v_max is not null then
      select count(*) into v_activos from public.usuarios
       where empresa_id = new.empresa_id and activo = true and rol = 'admin'
         and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);
      if v_activos >= v_max then
        if v_max = 1 then
          raise exception 'El plan actual permite un solo administrador por empresa. Actualiza el plan para agregar más.';
        else
          raise exception 'El plan actual permite hasta % administradores activos por empresa. Actualiza el plan para agregar más.', v_max;
        end if;
      end if;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.chequear_limite_admins() from public, anon, authenticated;

drop trigger if exists trg_limite_admins on public.usuarios;
create trigger trg_limite_admins
  before insert or update of activo, empresa_id, rol on public.usuarios
  for each row execute function public.chequear_limite_admins();
