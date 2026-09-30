-- "Confirmar y crear plan" (Grupos) se hace en el servidor, en una sola transacción.
--
-- Hasta ahora la app creaba el plan de un grupo entrada por entrada desde el navegador: por cada
-- storage bin pedía el universo, insertaba la fila de plan_semanal, después sus exclusiones y
-- después la foto de SKU. Con datos reales (Escondida, grupo "Criticos", 819 materiales) eran
-- unos 10 minutos y cientos de viajes, y pasaron dos cosas el 29/09/2026:
--   * el iPad suspendió la página a los 6 minutos y el plan quedó a medias (156 entradas de
--     unas 250; faltaron 327 materiales, ubicaciones 0103 a 0105 y toda B521), sin aviso;
--   * en 3 entradas falló el POST de exclusiones después de crear la fila, y la fila quedó viva
--     cubriendo el bin completo (N1E-340-A1: 1 crítico, 60 SKU en la entrada).
-- Acá todo entra o no entra nada: si falla un paso, la transacción se revierte y la app muestra
-- el error. Medido el 30/09/2026 con el plan real de Criticos (304 entradas, en una transacción
-- revertida, como authenticated): 3,4 s, y con el mismo resultado que armaba la app (272 de 304
-- entradas idénticas en exclusiones y foto; las 32 restantes eran fragmentos de un bin partido
-- entre dos días -- artefacto de la prueba -- y las 3 entradas que la app había dejado sin
-- exclusiones, que acá sí las tienen). El statement_timeout del rol es 20 s: alcanza para
-- planes de hasta ~1.500 entradas; uno mayor falla completo y la app muestra el error.
--
-- La app manda la vista previa YA repartida (un elemento por entrada: fecha, zona y los códigos
-- del grupo que cubre), con la misma forma que antes armaba crearPlanEntrada:
--   {fecha, bodega, ubicacion, storage_bin, ubicacion_nula, solo_sin_ubicacion, sku_codes:[...]}
-- Por cada entrada, el universo se toma de skus_planificables con los MISMOS filtros que usaba
-- skusDeUbicacion (bodega '' = sin bodega asignada; ubicacion_nula = bodega conocida sin
-- ubicación específica; solo_sin_ubicacion = sin bodega ni ubicación; con bin = ese bin; sin bin
-- = toda la bodega+ubicación), y se excluye todo lo que no sea del grupo. Si la exclusión pasaría
-- de p_limite_exclusiones códigos (3.000 en la app), esa entrada se omite y sus materiales se
-- cuentan en omitidos_materiales, igual que antes (una lista mayor no se puede leer de vuelta:
-- 431 Request Header Fields Too Large). La foto (plan_semanal_skus) se guarda solo para entradas
-- con bin, una fila por código, como hacía la app.
--
-- SECURITY INVOKER: corre bajo RLS del usuario; el filtro explícito por empresa_actual() se
-- evalúa una vez. p_reemplazar borra antes las entradas de una generación anterior del mismo
-- grupo (misma nota), en la misma transacción, después de que la app lo confirmó con la persona.
create or replace function public.crear_plan_grupo(
  p_nota text,
  p_reemplazar boolean,
  p_entradas jsonb,
  p_limite_exclusiones integer default 3000
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_usuario uuid;
  e jsonb;
  v_id uuid;
  v_fecha date;
  v_bodega text;
  v_ubicacion text;
  v_bin text;
  v_ubic_nula boolean;
  v_sin_ubic boolean;
  v_codigos text[];
  v_excluidos text[];
  v_creadas integer := 0;
  v_omitidas integer := 0;
  v_omitidos integer := 0;
  v_eliminadas integer := 0;
begin
  if v_empresa is null then
    raise exception 'No hay una empresa activa para este usuario';
  end if;
  if p_nota is null or p_nota = '' then
    raise exception 'Falta la nota que identifica al grupo';
  end if;
  select u.id into v_usuario from public.usuarios u
   where u.auth_user_id = auth.uid() and u.empresa_id = v_empresa and u.activo limit 1;

  if coalesce(p_reemplazar, false) then
    delete from public.plan_semanal where empresa_id = v_empresa and nota = p_nota;
    get diagnostics v_eliminadas = row_count;
  end if;

  for e in select x from jsonb_array_elements(coalesce(p_entradas, '[]'::jsonb)) x loop
    v_fecha := (e->>'fecha')::date;
    if v_fecha is null then raise exception 'Entrada sin fecha'; end if;
    v_sin_ubic := coalesce((e->>'solo_sin_ubicacion')::boolean, false);
    v_ubic_nula := coalesce((e->>'ubicacion_nula')::boolean, false);
    v_bodega := case when v_sin_ubic then null else e->>'bodega' end;
    v_ubicacion := case when v_sin_ubic or v_ubic_nula then null else nullif(e->>'ubicacion', '') end;
    v_bin := case when v_sin_ubic or v_ubic_nula then null else nullif(e->>'storage_bin', '') end;
    v_codigos := coalesce(array(select jsonb_array_elements_text(e->'sku_codes')), '{}'::text[]);

    -- Códigos del universo de la zona que NO son del grupo: son la exclusión de esta entrada.
    select coalesce(array_agg(distinct s.sku_code), '{}'::text[]) into v_excluidos
    from public.skus_planificables s
    where s.empresa_id = v_empresa
      and s.activo
      and (
        (v_sin_ubic and s.bodega is null and s.ubicacion is null)
        or (not v_sin_ubic
            and ((v_bodega = '' and s.bodega is null) or (v_bodega <> '' and s.bodega = v_bodega) or v_bodega is null)
            and ((v_ubic_nula and s.ubicacion is null) or (not v_ubic_nula and (v_ubicacion is null or s.ubicacion = v_ubicacion)))
            and (v_bin is null or s.storage_bin = v_bin))
      )
      and not (s.sku_code = any(v_codigos));

    if cardinality(v_excluidos) > coalesce(p_limite_exclusiones, 3000) then
      v_omitidas := v_omitidas + 1;
      v_omitidos := v_omitidos + cardinality(v_codigos);
      continue;
    end if;

    insert into public.plan_semanal
      (fecha, bodega, ubicacion, storage_bin, solo_sin_ubicacion, ubicacion_nula, por_sku,
       ciclo_id, responsable_id, nota, usuario_id, empresa_id)
    values
      (v_fecha, v_bodega, v_ubicacion, v_bin, v_sin_ubic, v_ubic_nula, false,
       null, null, p_nota, v_usuario, v_empresa)
    returning id into v_id;
    v_creadas := v_creadas + 1;

    if cardinality(v_excluidos) > 0 then
      insert into public.plan_semanal_exclusiones (plan_id, sku_code)
      select v_id, c from unnest(v_excluidos) c;
    end if;

    -- Foto del universo del bin (una fila por código; un código con dos batch va una vez, con el
    -- primer id), para detectar después si una carga lo movió de bin -- ver skusMovidosDeEntradas.
    if v_bin is not null then
      insert into public.plan_semanal_skus (plan_id, sku_code, sku_id, storage_bin_original, bodega_original, ubicacion_original)
      select v_id, s.sku_code, s.id, v_bin, v_bodega, v_ubicacion
      from (
        select distinct on (s.sku_code) s.sku_code, s.id
        from public.skus_planificables s
        where s.empresa_id = v_empresa and s.activo
          and ((v_bodega = '' and s.bodega is null) or (v_bodega <> '' and s.bodega = v_bodega) or v_bodega is null)
          and (v_ubicacion is null or s.ubicacion = v_ubicacion)
          and s.storage_bin = v_bin
        order by s.sku_code, s.id
      ) s;
    end if;
  end loop;

  return jsonb_build_object(
    'creadas', v_creadas,
    'omitidas', v_omitidas,
    'omitidos_materiales', v_omitidos,
    'eliminadas', v_eliminadas
  );
end;
$$;

revoke all on function public.crear_plan_grupo(text, boolean, jsonb, integer) from public, anon;
grant execute on function public.crear_plan_grupo(text, boolean, jsonb, integer) to authenticated;
