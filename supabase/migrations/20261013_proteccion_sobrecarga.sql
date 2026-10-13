-- Protección contra sobrecarga de la base (13/10/2026).
--
-- En la prueba de carga del 13/10/2026 la base (Small: 2 GB de RAM, 2 núcleos) se reinició sola
-- con 750 personas: se cortó a las 16:22:34 UTC sin mensaje de cierre y volvió en recuperación a
-- las 16:23:52. Antes de eso, dos síntomas: el Dashboard (la consulta más cara, 0,4-0,8 s) se
-- cortaba a los 20 s por decenas, con hasta un Dashboard por conexión del pool de PostgREST
-- calculando a la vez, y las inserciones de conteos sobre un mismo material entraban en deadlock
-- (116 en esa prueba; en la de la mañana PostgREST se quedó 87 minutos repitiéndolas).
--
-- 1. Turnos para el Dashboard. dashboard_ejecutivo pasa a ser una puerta: como mucho 3
--    Dashboards calculan a la vez y 3 más esperan turno (hasta 8 s). Si ya hay 6 dentro, la
--    llamada falla al instante con un mensaje claro (SQLSTATE 53400, que PostgREST devuelve como
--    503) en vez de quedarse ocupando una conexión. Así, por muchos supervisores que lo abran,
--    el Dashboard nunca ocupa más de 6 conexiones del pool y el resto sigue libre para guardar
--    conteos. El cálculo no cambia: es la misma función, movida a privado (fuera de la API, para
--    que no se pueda llamar saltándose la puerta). Turnos con advisory locks de transacción: se
--    sueltan solos al terminar, también si hay error. Con uso normal (Escondida hoy) nunca se
--    llega al límite: un Dashboard tarda ~0,4 s.
--
-- 2. Un turno por material al guardar conteos. Antes de insertar, corregir o borrar un conteo se
--    toma un advisory lock por SKU, así que dos conteos del mismo material ya no se cruzan al
--    actualizar skus (sincronizar_ultimo_conteo_sku): el segundo espera a que termine el primero
--    (milisegundos) en vez de entrar en deadlock. Conteos de materiales distintos no se esperan.
--
-- Claves de advisory locks (nadie más los usa): 74100 entrada al Dashboard, 74101 cálculo del
-- Dashboard, 74102 conteos por SKU.

set local lock_timeout = '5s';

-- 1. Dashboard ------------------------------------------------------------------------------

alter function public.dashboard_ejecutivo(integer, text) rename to dashboard_ejecutivo_calculo;
alter function public.dashboard_ejecutivo_calculo(integer, text) set schema privado;

create function public.dashboard_ejecutivo(p_dias integer default 14, p_criticidad text default null::text)
returns json
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_inicio timestamptz := clock_timestamp();
  v_dentro boolean := false;
begin
  -- Entrada: 6 lugares entre los que calculan y los que esperan.
  for v_slot in 1..6 loop
    if pg_try_advisory_xact_lock(74100, v_slot) then
      v_dentro := true;
      exit;
    end if;
  end loop;
  if not v_dentro then
    raise exception 'Hay muchos paneles calculándose a la vez. Reintenta en unos segundos.'
      using errcode = '53400';
  end if;

  -- Cálculo: 3 a la vez.
  loop
    for v_slot in 1..3 loop
      if pg_try_advisory_xact_lock(74101, v_slot) then
        return privado.dashboard_ejecutivo_calculo(p_dias, p_criticidad);
      end if;
    end loop;
    if clock_timestamp() - v_inicio > interval '8 seconds' then
      raise exception 'Hay muchos paneles calculándose a la vez. Reintenta en unos segundos.'
        using errcode = '53400';
    end if;
    perform pg_sleep(0.1);
  end loop;
end;
$$;

revoke all on function public.dashboard_ejecutivo(integer, text) from public, anon;
grant execute on function public.dashboard_ejecutivo(integer, text) to authenticated, service_role;

-- 2. Conteos: un turno por material ------------------------------------------------------------

create or replace function public.conteo_turno_por_sku()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_a uuid;
  v_b uuid;
begin
  if tg_op = 'DELETE' then
    v_a := old.sku_id;
  elsif tg_op = 'UPDATE' then
    v_a := old.sku_id;
    v_b := nullif(new.sku_id, old.sku_id);
  else
    v_a := new.sku_id;
  end if;
  -- Si una corrección mueve el conteo de material, los dos turnos se toman siempre en el mismo
  -- orden, para que dos correcciones cruzadas no se esperen entre sí.
  if v_b is not null and v_b::text < v_a::text then
    select v_b, v_a into v_a, v_b;
  end if;
  if v_a is not null then
    perform pg_advisory_xact_lock(74102, hashtext(v_a::text));
  end if;
  if v_b is not null then
    perform pg_advisory_xact_lock(74102, hashtext(v_b::text));
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
revoke all on function public.conteo_turno_por_sku() from public, anon, authenticated;

create trigger trg_conteos_turno_sku
  before insert or update or delete on public.conteos
  for each row execute function public.conteo_turno_por_sku();
