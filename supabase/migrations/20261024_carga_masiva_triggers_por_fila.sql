-- Carga masiva: los dos triggers de skus que corrían fila por fila sin necesidad (24/10/2026).
--
-- Una tanda de carga son 2.000 materiales en un upsert (POST /skus con on_conflict). Medida en
-- Escondida como administrador, dentro de una transacción revertida: 933 ms, y el 79% en triggers:
--   trg_skus_limita_edicion_directa  510 ms (2.000 llamadas): preguntaba "¿es administrador o súper
--     admin?" por cada fila, dos funciones SECURITY DEFINER cada vez, aunque la respuesta no cambia
--     dentro de un pedido. Ahora se pregunta una vez por transacción y usuario: la respuesta "sí"
--     queda en un parámetro local de la transacción (inventia.edicion_admin) con el id de la
--     transacción y del usuario. Ni PostgREST ni la app pueden fijar ese parámetro (solo esta
--     función lo escribe), y en otra transacción o con otro usuario no calza. Un operador no se
--     marca nunca: sigue revisándose fila por fila, como antes.
--   trg_limite_bodegas  224 ms (4.000 llamadas: en un upsert corre al proponer la inserción y al
--     convertirla en actualización): bloqueaba la fila de la empresa y leía su plan por cada
--     material. Ahora sale de inmediato si la fila no cambia de bodega o si la empresa ya tiene esa
--     bodega (no suma bodegas). Hoy ningún plan tiene max_bodegas; con uno que lo tenga, la versión
--     anterior además contaba las bodegas de todo el maestro por cada fila (count distinct sobre
--     63.000 materiales x 2.000 filas) y la carga habría superado los 20 s.
--     Diferencia de comportamiento, a propósito: una empresa que ya está sobre su límite (por
--     ejemplo, tras bajar de plan) puede seguir actualizando y agregando materiales en las bodegas
--     que ya tiene; lo que el límite frena es abrir una bodega nueva, y eso sigue igual.
-- Resultado con la misma tanda: 933 -> 454 ms en el ensayo y 337 ms ya aplicada (edición 510 -> 35 ms,
-- bodegas 224 -> 129 ms). Una carga de Escondida (93 tandas) baja de ~2 min a ~30-40 s más la red.
--
-- Probado antes de aplicar, en una transacción revertida, con usuarios reales de Escondida:
--   operador cambia stock -> rechazado (42501); operador cambia ubicación -> permitido;
--   administrador cambia stock -> permitido; operador después del administrador en la misma
--   transacción -> rechazado; con un plan de prueba de 4 bodegas: material en bodega nueva ->
--   rechazado, en bodega existente -> permitido, mover un material a bodega nueva -> rechazado.
-- Mismas firmas, mismos permisos, chequear_limite_bodegas sigue SECURITY DEFINER y
-- skus_limita_edicion_directa sigue sin serlo.

set local lock_timeout = '5s';

create or replace function public.chequear_limite_bodegas()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_max int;
  v_actuales int;
begin
  if new.bodega is null or new.bodega = '' then
    return new;
  end if;
  -- Una fila que no cambia de bodega ni de empresa no suma bodegas (en una carga, cada material
  -- pasa dos veces por acá: al proponer la inserción y al convertirla en actualización).
  if tg_op = 'UPDATE' and new.bodega = old.bodega and new.empresa_id = old.empresa_id then
    return new;
  end if;
  -- Si la empresa ya tiene esa bodega, tampoco suma: no hace falta bloquear ni contar.
  if exists (select 1 from public.skus s where s.bodega = new.bodega and s.empresa_id = new.empresa_id) then
    return new;
  end if;
  perform 1 from public.empresas where id = new.empresa_id for update;
  select p.max_bodegas into v_max from public.planes p join public.empresas e on e.plan_id = p.id where e.id = new.empresa_id;
  if v_max is not null then
    select count(distinct bodega) into v_actuales from public.skus
      where empresa_id = new.empresa_id and bodega is not null and bodega <> '' and bodega <> new.bodega;
    if v_actuales >= v_max then
      raise exception 'El plan actual permite hasta % bodega(s). Actualiza el plan para agregar más.', v_max;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.skus_limita_edicion_directa()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cambios text[];
  v_marca text;
begin
  -- Solo un pedido directo a /skus (PostgREST deja la ruta en request.path; se acepta también con
  -- prefijo, por si llega como /rest/v1/skus). Las funciones (/rpc/...), los triggers que corren
  -- dentro de otro pedido (un conteo actualiza skus desde /conteos) y las tareas de la base no
  -- pasan por acá.
  if coalesce(current_setting('request.path', true), '') !~ '(^|/)skus/?$' then
    return new;
  end if;
  -- Ser administrador no cambia a mitad de un pedido: se pregunta una vez por transacción y
  -- usuario, no por cada fila (una tanda de carga son 2.000 filas: 510 ms solo en esto). La marca
  -- vive en un parámetro local de la transacción, que solo esta función escribe; ni PostgREST ni la
  -- app pueden fijarlo, y lleva el id de la transacción y del usuario, así que no sirve en otra.
  v_marca := txid_current()::text || ':' || coalesce(auth.uid()::text, '');
  if current_setting('inventia.edicion_admin', true) is not distinct from v_marca then
    return new;
  end if;
  if (select public.es_admin_actual()) or (select public.es_super_admin()) then
    perform set_config('inventia.edicion_admin', v_marca, true);
    return new;
  end if;
  select array_agg(n.key order by n.key) into v_cambios
  from jsonb_each(to_jsonb(new)) n
  join jsonb_each(to_jsonb(old)) o on o.key = n.key
  where n.value is distinct from o.value
    -- Lo que la app deja hacer a un operador (asociar código de barras, cambiar de ubicación) y lo
    -- que la base calcula sola.
    and n.key not in ('codigo_barras', 'bodega', 'ubicacion', 'storage_bin',
                      'bodega_key', 'ubicacion_key', 'storage_bin_key', 'batch_key', 'updated_at');
  if v_cambios is not null then
    raise exception 'Solo un administrador puede cambiar % de un material', array_to_string(v_cambios, ', ')
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
