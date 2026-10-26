-- Al borrar el único conteo de un material, su "último conteo" se limpia completo (26/10/2026).
--
-- skus guarda una copia del último conteo de cada material (ultimo_conteo_id, _fecha, _estado,
-- _cantidad...), que mantiene el trigger trg_sincronizar_ultimo_conteo_sku. Cuando se borra el
-- único conteo de un material, la limpieza preguntaba "and s.ultimo_conteo_id is not null"; pero la
-- llave skus_ultimo_conteo_id_fkey (ON DELETE SET NULL) ya lo había dejado en null antes de que
-- corriera el trigger, así que la limpieza no encontraba la fila y quedaban fecha, estado y cantidad
-- del conteo borrado. Pasó de verdad: Joel borró una prueba (11111221, 26/10) y el material seguía
-- "contado: 48, aprobado"; había otro igual desde el 03/09 (50CL CU CA ESOX, "1, con diferencia").
-- Ahora la limpieza mira también la fecha. El costo no cambia: sigue preguntando por el material
-- (idx_conteos_sku) solo si tiene algo que limpiar.
--
-- Mismo nombre, sin argumentos, SECURITY DEFINER y search_path de siempre: el trigger no cambia.
-- Al final se limpian los materiales que ya quedaron así (2 en Escondida al 26/10/2026): solo las
-- columnas ultimo_conteo_* de materiales SIN ningún conteo. No se borra ninguna fila.

set local lock_timeout = '5s';

create or replace function public.sincronizar_ultimo_conteo_sku()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sku_ids uuid[];
begin
  if tg_op = 'DELETE' then
    v_sku_ids := array[old.sku_id];
  elsif tg_op = 'UPDATE' and old.sku_id is distinct from new.sku_id then
    v_sku_ids := array[old.sku_id, new.sku_id];
  else
    v_sku_ids := array[new.sku_id];
  end if;

  update public.skus s
  set ultimo_conteo_id = uc.id,
      ultimo_conteo_fecha = uc.fecha_conteo,
      ultimo_conteo_estado = uc.estado,
      ultimo_conteo_diferencia = uc.diferencia,
      ultimo_conteo_cantidad = uc.cantidad_contada,
      ultimo_conteo_capturado_en = uc.capturado_en,
      ultimo_conteo_fuera_de_plan = uc.fuera_de_plan,
      ultimo_conteo_ciclo_id = uc.ciclo_id,
      ultimo_conteo_usuario_id = uc.usuario_id
  from (
    select distinct on (c.sku_id) c.sku_id, c.id, c.fecha_conteo, c.estado, c.diferencia,
           c.cantidad_contada, c.capturado_en, c.fuera_de_plan, c.ciclo_id, c.usuario_id
    from public.conteos c
    where c.sku_id = any(v_sku_ids)
    order by c.sku_id, c.fecha_conteo desc
  ) uc
  where s.id = uc.sku_id;

  -- Si el SKU se quedó sin ningún conteo (se borró el único que tenía), no aparece en `uc` --
  -- se limpia aparte. Ojo: ultimo_conteo_id ya puede venir en null (la llave lo deja así al borrar
  -- el conteo, antes de este trigger): por eso se mira también la fecha.
  update public.skus s
  set ultimo_conteo_id = null, ultimo_conteo_fecha = null, ultimo_conteo_estado = null,
      ultimo_conteo_diferencia = null, ultimo_conteo_cantidad = null,
      ultimo_conteo_capturado_en = null, ultimo_conteo_fuera_de_plan = null,
      ultimo_conteo_ciclo_id = null, ultimo_conteo_usuario_id = null
  where s.id = any(v_sku_ids)
    and (s.ultimo_conteo_id is not null or s.ultimo_conteo_fecha is not null)
    and not exists (select 1 from public.conteos c where c.sku_id = s.id);

  return coalesce(new, old);
end;
$function$;

update public.skus s
set ultimo_conteo_id = null, ultimo_conteo_fecha = null, ultimo_conteo_estado = null,
    ultimo_conteo_diferencia = null, ultimo_conteo_cantidad = null,
    ultimo_conteo_capturado_en = null, ultimo_conteo_fuera_de_plan = null,
    ultimo_conteo_ciclo_id = null, ultimo_conteo_usuario_id = null
where s.ultimo_conteo_id is null
  and (s.ultimo_conteo_fecha is not null or s.ultimo_conteo_estado is not null or s.ultimo_conteo_cantidad is not null)
  and not exists (select 1 from public.conteos c where c.sku_id = s.id);
