-- Dueños de stock, paso 5 (aparte): renombrar una bodega no ve choque entre dos dueños
-- (Joel, 21/10/2026). Sigue a 20261021_duenos_stock_lectura.sql.
--
-- renombrar_ubicacion_general se niega a juntar dos bodegas si un material quedaría repetido en
-- el mismo sitio. Comparaba sin el dueño: dos clientes con el mismo material en el mismo sitio
-- contaban como choque, y ya no lo son (la identidad del material incluye al dueño desde
-- 20261020_duenos_stock.sql). Sin dueños, todas las filas tienen dueno = '' y da lo mismo que
-- antes. El único cambio es la línea "and b.dueno = a.dueno".
--
-- Va en su propio archivo porque la herramienta con que se aplican las migraciones pide una
-- confirmación que no llega cuando el texto trae un borrado (la función borra filas repetidas
-- del catálogo de ubicaciones al fundir dos bodegas): se aplica desde el SQL Editor.

set local lock_timeout = '5s';

create or replace function public.renombrar_ubicacion_general(p_desde text, p_hasta text, p_limite integer DEFAULT 2000)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_emp uuid := public.empresa_actual();
  v_desde text := btrim(coalesce(p_desde, ''));
  v_hasta text := btrim(coalesce(p_hasta, ''));
  v_n int := 0;
  v_restantes int;
  v_choques int;
  v_ejemplo text;
begin
  if v_emp is null then raise exception 'Sesión sin empresa'; end if;
  if not public.es_admin_actual() then
    raise exception 'Solo un administrador puede renombrar una ubicación';
  end if;
  if v_desde = '' or v_hasta = '' then
    raise exception 'Indica el nombre actual y el nuevo';
  end if;
  if v_desde = v_hasta then
    return jsonb_build_object('actualizados', 0, 'restantes', 0, 'terminado', true);
  end if;

  -- Renombrar a un nombre que ya existe es fusionar dos bodegas, y eso puede chocar con la
  -- identidad de un material (empresa + código + bodega + batch + ubicación + bin + dueño). Si hay
  -- choques no se toca nada: fusionar a la fuerza dejaría dos fichas del mismo material peleando
  -- por el mismo sitio, o perdería una.
  select count(*), min(a.sku_code) into v_choques, v_ejemplo
  from public.skus a
  join public.skus b
    on b.empresa_id = a.empresa_id
   and b.sku_code = a.sku_code
   and b.dueno = a.dueno
   and coalesce(b.batch, '') = coalesce(a.batch, '')
   and coalesce(b.ubicacion, '') = coalesce(a.ubicacion, '')
   and coalesce(b.storage_bin, '') = coalesce(a.storage_bin, '')
  where a.empresa_id = v_emp and a.bodega = v_desde and b.bodega = v_hasta;

  if v_choques > 0 then
    raise exception 'No se puede juntar % con %: % material(es) quedarían repetidos en el mismo sitio (por ejemplo %). Mueve o junta esos materiales primero.',
      v_desde, v_hasta, v_choques, v_ejemplo;
  end if;

  -- Un lote de materiales.
  update public.skus set bodega = v_hasta
  where id in (
    select id from public.skus
    where empresa_id = v_emp and bodega = v_desde
    limit greatest(coalesce(p_limite, 2000), 1)
  );
  get diagnostics v_n = row_count;

  select count(*) into v_restantes
  from public.skus where empresa_id = v_emp and bodega = v_desde;

  if v_restantes > 0 then
    return jsonb_build_object('actualizados', v_n, 'restantes', v_restantes, 'terminado', false);
  end if;

  -- Ya no quedan materiales en el nombre viejo: se arrastra el resto, que son tablas chicas
  -- (cientos de filas). Los conteos y el historial también se renombran: es el mismo sitio con
  -- otro nombre, y dejarlos atrás partiría en dos la historia del Dashboard.
  update public.conteos set bodega = v_hasta where empresa_id = v_emp and bodega = v_desde;
  update public.plan_semanal set bodega = v_hasta where empresa_id = v_emp and bodega = v_desde;
  update public.plan_semanal_skus set bodega_original = v_hasta
    where bodega_original = v_desde
      and plan_id in (select id from public.plan_semanal where empresa_id = v_emp);
  update public.skus_grupos_conteo set bodega = v_hasta where empresa_id = v_emp and bodega = v_desde;
  update public.historial_ciclos_grupo set bodega = v_hasta where empresa_id = v_emp and bodega = v_desde;

  -- El catálogo: si el nombre nuevo ya estaba, las dos listas se funden y se borran los sobrantes.
  delete from public.ubicaciones vieja
  where vieja.empresa_id = v_emp and vieja.bodega = v_desde
    and exists (
      select 1 from public.ubicaciones nueva
      where nueva.empresa_id = v_emp and nueva.bodega = v_hasta
        and coalesce(nueva.ubicacion, '') = coalesce(vieja.ubicacion, '')
    );
  update public.ubicaciones set bodega = v_hasta where empresa_id = v_emp and bodega = v_desde;

  return jsonb_build_object('actualizados', v_n, 'restantes', 0, 'terminado', true);
end;
$function$;
