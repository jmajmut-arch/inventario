-- Carga masiva: la fila vieja "sin ubicación ni bin" de un material que ahora viene con bin se
-- desactiva (Joel, 19/10/2026: "en SAP no hay en tránsito").
--
-- SAP exporta, además de la línea de cada bin, una línea del material a nivel de bodega (sin
-- ubicación, sin bin, stock 0, con su tránsito). Desde el 27/09 (#502) la carga la omite si el
-- material ya viene con bin y le pasa su tránsito a la fila del bin. Pero si el material llegó
-- antes SOLO con esa línea, se cargó como un SKU propio (era su único registro), y cuando después
-- apareció en un bin la fila vieja quedó en la base para siempre: la carga en modo "actualizar" no
-- toca lo que no viene en el archivo. Su tránsito se congeló y se seguía sumando al del material.
-- Medido en Escondida el 19/10/2026: 824 filas así, 789 con tránsito viejo (29.463 unidades).
--
-- desactivar_filas_sin_sitio_de_carga la llama la app al terminar una carga que trae ubicación o
-- bin, con el sello de esa carga (p_marca, el updated_at que escribió en cada fila). Desactiva
-- una fila de la empresa si:
--   - está activa, sin ubicación, sin bin y con stock 0 (stock en blanco es desconocido: no);
--   - esta carga no la tocó (updated_at anterior al sello);
--   - el mismo material (código + bodega) tiene una fila con ubicación o bin que esta carga sí
--     tocó: el archivo trae el material con sitio, así que la fila sin sitio ya no corresponde;
--   - nunca se contó ni se usó en bodega (conteos, movimientos, reservas, órdenes de compra): esas
--     se quedan como están, porque desactivarlas escondería un hallazgo o un registro real.
-- Desactivar no borra nada; la auditoría guarda cada cambio. SECURITY INVOKER: corre con la RLS
-- de quien carga (auth_update_skus), y el filtro por empresa_actual() va explícito además.

set local lock_timeout = '5s';

create or replace function public.desactivar_filas_sin_sitio_de_carga(p_marca timestamptz)
 returns integer
 language plpgsql
 security invoker
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

revoke all on function public.desactivar_filas_sin_sitio_de_carga(timestamptz) from public, anon;
grant execute on function public.desactivar_filas_sin_sitio_de_carga(timestamptz) to authenticated;
