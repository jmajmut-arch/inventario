-- Grupos: el plan generado puede repartirse entre responsables (Joel, 22/10/2026).
--
-- En Escondida, de 314 entradas generadas por el grupo "Criticos" con fecha ya pasada, 291 no tenían
-- responsable, y de sus 3.007 materiales se contó el 3%; las entradas hechas a mano, todas con
-- responsable, se cuentan en un 78%. Contar le muestra a cada persona lo asignado a ella, y lo sin
-- asignar se pierde entre todos.
--
-- crear_plan_grupo acepta "responsable_id" en cada entrada; sin él, la entrada queda sin responsable
-- como siempre. Que el responsable sea de la misma empresa ya lo exige el trigger
-- trg_validar_responsable_misma_empresa (probado: un usuario de otra empresa se rechaza y no se crea
-- nada). Único cambio respecto de 20261022_duenos_stock_grupos_pegar.sql: el segundo null del insert.
--
-- En producción se aplicó con un bloque DO que reemplaza ese texto en pg_get_functiondef (el
-- conector no ejecuta textos con borrados); el resultado es esta misma definición.

set local lock_timeout = '5s';

create or replace function public.crear_plan_grupo(p_nota text, p_reemplazar boolean, p_entradas jsonb, p_limite_exclusiones integer DEFAULT 3000)
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
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
  v_dueno text;
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
    -- null = todos los dueños (lo de siempre); '' = lo que no tiene dueño; un código = ese dueño.
    v_dueno := e->>'dueno';
    v_codigos := coalesce(array(select jsonb_array_elements_text(e->'sku_codes')), '{}'::text[]);

    -- Códigos del universo de la zona que NO son del grupo: son la exclusión de esta entrada.
    select coalesce(array_agg(distinct s.sku_code), '{}'::text[]) into v_excluidos
    from public.skus_planificables s
    where s.empresa_id = v_empresa
      and s.activo
      and (v_dueno is null or s.dueno = v_dueno)
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
       ciclo_id, responsable_id, nota, usuario_id, empresa_id, dueno)
    values
      (v_fecha, v_bodega, v_ubicacion, v_bin, v_sin_ubic, v_ubic_nula, false,
       null, nullif(e->>'responsable_id', '')::uuid, p_nota, v_usuario, v_empresa, v_dueno)
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
          and (v_dueno is null or s.dueno = v_dueno)
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
$function$;
