-- Dueños de stock: grupos de conteo por dueño, segunda mitad (Joel, 21/10/2026). Sigue a
-- 20261022_duenos_stock_grupos.sql.
--
-- Va en su propio archivo porque la herramienta con que se aplican las migraciones pide una
-- confirmación que no llega cuando el texto trae un borrado: crear_plan_grupo borra el plan anterior
-- del grupo al regenerarlo, el cierre nocturno reemplaza el historial del ciclo que cierra y el
-- índice del grupo automático se cambia por otro. Se aplica desde el SQL Editor.
--
-- 1. crear_plan_grupo: cada entrada puede traer "dueno"; sin él, la fila y sus exclusiones y foto son
--    las de siempre. Con él, la entrada queda con ese dueño (plan_semanal.dueno) y la exclusión y la
--    foto miran solo los materiales de ese dueño.
-- 2. cerrar_ciclos_grupo_vencidos: con dueño, el historial del ciclo cuenta solo los conteos de las
--    filas de ese dueño (y el grupo automático, solo sus críticos).
-- 3. Grupo automático de críticos: hasta hoy, uno activo por empresa. Ahora uno por empresa y dueño
--    (el de todos los dueños sigue siendo uno solo: nulls not distinct).

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
       null, null, p_nota, v_usuario, v_empresa, v_dueno)
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

create or replace function public.cerrar_ciclos_grupo_vencidos()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  g record;
  v_ventana_fin date;
begin
  for g in
    select id, empresa_id, nombre, frecuencia_dias, automatico_critico, fecha_inicio, dueno
    from grupos_conteo
    where activo and frecuencia_dias is not null and fecha_inicio is not null
      and fecha_inicio + (frecuencia_dias - 1) < current_date
  loop
    -- El ciclo cerrado llega hasta ayer: todo conteo anterior al día del cierre le pertenece.
    v_ventana_fin := current_date - 1;

    delete from historial_ciclos_grupo
    where grupo_id = g.id and fecha_inicio = g.fecha_inicio;

    -- Con dueño, solo cuentan las filas de ese dueño (g.dueno null = todos, lo de siempre).
    if g.automatico_critico then
      insert into historial_ciclos_grupo
        (empresa_id, grupo_id, grupo_nombre, fecha_inicio, fecha_termino, sku_code, bodega, contado, fecha_conteo)
      with miembros as (
        select distinct sku_code, bodega from skus
        where empresa_id = g.empresa_id and activo and critico
          and (g.dueno is null or dueno = g.dueno)
      ),
      conteos_ventana as (
        select s2.sku_code, s2.bodega, max(c.fecha_conteo) as fecha_conteo
        from conteos c join skus s2 on s2.id = c.sku_id
        where s2.empresa_id = g.empresa_id
          and (g.dueno is null or s2.dueno = g.dueno)
          and c.fecha_conteo::date between g.fecha_inicio and v_ventana_fin
        group by s2.sku_code, s2.bodega
      )
      select g.empresa_id, g.id, g.nombre, g.fecha_inicio, v_ventana_fin,
             m.sku_code, m.bodega, cv.fecha_conteo is not null, cv.fecha_conteo
      from miembros m
      left join conteos_ventana cv on cv.sku_code = m.sku_code and coalesce(cv.bodega,'') = coalesce(m.bodega,'');
    else
      insert into historial_ciclos_grupo
        (empresa_id, grupo_id, grupo_nombre, fecha_inicio, fecha_termino, sku_code, bodega, contado, fecha_conteo)
      with conteos_ventana as (
        select s2.sku_code, s2.bodega, max(c.fecha_conteo) as fecha_conteo
        from conteos c join skus s2 on s2.id = c.sku_id
        where s2.empresa_id = g.empresa_id
          and (g.dueno is null or s2.dueno = g.dueno)
          and c.fecha_conteo::date between g.fecha_inicio and v_ventana_fin
        group by s2.sku_code, s2.bodega
      )
      select g.empresa_id, g.id, g.nombre, g.fecha_inicio, v_ventana_fin,
             sg.sku_code, sg.bodega, cv.fecha_conteo is not null, cv.fecha_conteo
      from skus_grupos_conteo sg
      left join conteos_ventana cv on cv.sku_code = sg.sku_code and coalesce(cv.bodega,'') = coalesce(sg.bodega,'')
      where sg.grupo_id = g.id;
    end if;

    -- El ciclo nuevo parte hoy, con todos los materiales pendientes.
    update grupos_conteo set fecha_inicio = current_date where id = g.id;
  end loop;
end;
$function$;

-- El nuevo se crea antes de borrar el viejo: nunca queda un momento sin la restricción.
create unique index if not exists idx_grupos_conteo_automatico_critico_dueno
  on public.grupos_conteo (empresa_id, dueno) nulls not distinct
  where (automatico_critico and activo);
drop index if exists public.idx_grupos_conteo_automatico_critico_unico;

-- Comprobación: debe devolver una fila con 'ok'.
select case when exists (select 1 from pg_indexes where indexname = 'idx_grupos_conteo_automatico_critico_dueno')
             and not exists (select 1 from pg_indexes where indexname = 'idx_grupos_conteo_automatico_critico_unico')
             and pg_get_functiondef('public.crear_plan_grupo'::regproc) like '%v_dueno%'
             and pg_get_functiondef('public.cerrar_ciclos_grupo_vencidos'::regproc) like '%g.dueno%'
        then 'ok' else 'revisar' end as resultado;
