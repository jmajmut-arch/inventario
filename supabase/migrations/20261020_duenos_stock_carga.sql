-- Dueños de stock, paso 4: la carga de Excel con dueño (Joel, 20/10/2026). Sigue a
-- 20261020_duenos_stock.sql.
--
-- 1. cargas_masivas.duenos: los dueños que trajo cada carga (null = la carga no trajo columna de
--    dueño, lo de siempre). Un operador logístico puede cargar un archivo por cliente: sin esto,
--    "Revisar sobrantes" mostraba el stock de los OTROS clientes como lo que el archivo ya no
--    trae, y ofrecía desactivarlo.
-- 2. resumen_skus_no_traidos y desactivar_skus_no_traidos: con dueños anotados, miran solo los
--    materiales de esos dueños (también el tope de seguridad de "la mitad de los activos", que se
--    compara contra los activos de esos dueños). Sin dueños anotados, igual que antes.
-- 3. desactivar_filas_sin_sitio_de_carga: la fila sin sitio de un cliente se desactiva solo si
--    el material del MISMO dueño vino con bin; el bin de otro cliente no dice nada de ella.
--
-- El índice único de siempre se borra aparte, en 20261020_duenos_stock_contraer.sql.

set local lock_timeout = '5s';

-- 1. Dueños que trajo cada carga
alter table public.cargas_masivas add column if not exists duenos text[];

-- 2. Sobrantes, acotados a los dueños de la carga
create or replace function public.resumen_skus_no_traidos(p_carga_id uuid)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare v_marca timestamptz; v_duenos text[]; v_activas integer; v_j jsonb;
begin
  select marca_tiempo, duenos into v_marca, v_duenos from cargas_masivas where id = p_carga_id;  -- RLS acota a la empresa
  if v_marca is null then
    return jsonb_build_object('total', 0, 'sin_referencia', true);
  end if;
  select count(*) into v_activas from skus s where s.activo and (v_duenos is null or s.dueno = any(v_duenos));
  select jsonb_build_object(
    'total',         count(*),
    'con_stock',     count(*) filter (where coalesce(stock_sistema,0) > 0),
    'sin_ubicacion', count(*) filter (where ubicacion is null and storage_bin is null),
    'contados',      count(*) filter (where exists (select 1 from conteos c where c.sku_id = s.id)),
    'activas',       v_activas)
    into v_j
  from skus s where s.activo and s.updated_at < v_marca and (v_duenos is null or s.dueno = any(v_duenos));
  return v_j;
end;
$function$;

create or replace function public.desactivar_skus_no_traidos(p_carga_id uuid, p_limite integer default 2000)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare v_marca timestamptz; v_duenos text[]; v_desactivados integer; v_restantes integer; v_activas integer; v_objetivo integer;
begin
  if not (select es_admin_actual()) then
    raise exception 'Solo un administrador puede desactivar materiales en lote';
  end if;
  if p_limite is null or p_limite < 1 or p_limite > 5000 then
    raise exception 'El lote debe estar entre 1 y 5000 filas';
  end if;

  select marca_tiempo, duenos into v_marca, v_duenos from cargas_masivas where id = p_carga_id;
  if v_marca is null then
    raise exception 'Esa carga no tiene marca de tiempo: no se puede saber qué filas no trajo';
  end if;

  -- Un material ya contado NO se desactiva: bajaría el avance de un ciclo abierto y borraría
  -- trabajo hecho en terreno. Con dueños anotados, solo se miran los materiales de esos dueños.
  select count(*) into v_objetivo from skus s
   where s.activo and s.updated_at < v_marca
     and (v_duenos is null or s.dueno = any(v_duenos))
     and not exists (select 1 from conteos c where c.sku_id = s.id);
  select count(*) into v_activas from skus s where s.activo and (v_duenos is null or s.dueno = any(v_duenos));

  -- Tope de seguridad: esto limpia sobrantes, no reemplaza el catálogo. Si la selección abarca la
  -- mitad o más de los materiales activos, algo está mal con la referencia y se aborta antes de
  -- tocar nada. Para reemplazar el maestro completo está el modo "Reemplazar completo".
  if v_activas > 0 and v_objetivo * 2 >= v_activas then
    raise exception 'La limpieza abarcaría % de % materiales activos. Eso no es un sobrante: revisa la carga de referencia o usa Reemplazar completo.', v_objetivo, v_activas;
  end if;

  with objetivo as (
    select s.id from skus s
     where s.activo and s.updated_at < v_marca
       and (v_duenos is null or s.dueno = any(v_duenos))
       and not exists (select 1 from conteos c where c.sku_id = s.id)
     order by s.id limit p_limite
  )
  update skus set activo = false, updated_at = now()
   where id in (select id from objetivo);
  get diagnostics v_desactivados = row_count;

  select count(*) into v_restantes from skus s
   where s.activo and s.updated_at < v_marca
     and (v_duenos is null or s.dueno = any(v_duenos))
     and not exists (select 1 from conteos c where c.sku_id = s.id);

  return jsonb_build_object('desactivados', v_desactivados, 'restantes', v_restantes,
                            'terminado', v_restantes = 0);
end;
$function$;

-- 3. Filas sin sitio: el material con bin tiene que ser del mismo dueño
create or replace function public.desactivar_filas_sin_sitio_de_carga(p_marca timestamptz)
 returns integer
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_empresa uuid := (select public.empresa_actual());
  v_n integer;
begin
  if v_empresa is null or p_marca is null then
    return 0;
  end if;
  update public.skus s
     set activo = false
   where s.empresa_id = v_empresa
     and s.activo
     and s.ubicacion is null
     and s.storage_bin is null
     and s.stock_sistema = 0
     and s.updated_at < p_marca
     and s.ultimo_conteo_id is null
     and exists (
       select 1 from public.skus o
        where o.empresa_id = s.empresa_id
          and o.sku_code = s.sku_code
          and o.bodega_key = s.bodega_key
          and o.dueno = s.dueno
          and o.activo
          and (o.ubicacion is not null or o.storage_bin is not null)
          and o.updated_at >= p_marca)
     and not exists (select 1 from public.conteos c where c.sku_id = s.id)
     and not exists (select 1 from public.movimientos_bodega m where m.sku_id = s.id)
     and not exists (select 1 from public.reservas_lineas r where r.sku_id = s.id)
     and not exists (select 1 from public.ordenes_compra_lineas l where l.sku_id = s.id);
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
