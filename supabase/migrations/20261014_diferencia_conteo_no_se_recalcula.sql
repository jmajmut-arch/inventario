-- La diferencia de un conteo es una foto del momento en que se contó (Joel, 14/10/2026).
--
-- calcular_diferencia_conteo corría en cada INSERT y en cada UPDATE de conteos, y siempre
-- calculaba "cantidad contada - stock de sistema DE HOY". En un UPDATE eso reescribía la historia:
--   * "Ajustado en ERP" y "Descartar" (marcan el cierre del reconteo): si entre el conteo y el
--     cierre se había cargado un Excel con el stock ya ajustado, la merma pasaba a 0 y el conteo a
--     "cuadrado", y desaparecía de la valorización y del informe del período.
--   * Renombrar una ubicación general (cambia la bodega de todos sus conteos): recalculaba de una
--     vez todos los conteos de esa bodega contra el stock de hoy.
--   * Corregir un conteo (error de tipeo): comparaba la cantidad corregida con el stock de hoy y no
--     con el que había cuando se contó.
-- En Escondida no hubo daño todavía (5 cierres, los 5 conservan su diferencia), pero es lo normal
-- en cuanto se cierre por ERP después de cargar el Excel.
--
-- Ahora:
--   * INSERT (conteo nuevo): igual que siempre, contra el stock actual del material.
--   * UPDATE que no cambia ni la cantidad ni el material (cerrar, descartar, renombrar, marcar):
--     la diferencia y el estado quedan como estaban.
--   * UPDATE que corrige la cantidad del mismo material: contra el stock que había al contarlo,
--     que se deduce de lo guardado (cantidad anterior - diferencia anterior: contaste 8 con merma
--     de 2 -> el sistema decía 10).
--   * UPDATE que cambia de material (no lo hace la app hoy): contra el stock actual del nuevo.

set local lock_timeout = '5s';

create or replace function public.calcular_diferencia_conteo()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if tg_op = 'UPDATE' and new.sku_id is not distinct from old.sku_id then
    if new.cantidad_contada is not distinct from old.cantidad_contada then
      return new;
    end if;
    if old.diferencia is not null and old.cantidad_contada is not null then
      new.diferencia := new.cantidad_contada - (old.cantidad_contada - old.diferencia);
    else
      new.diferencia := new.cantidad_contada - coalesce((select stock_sistema from skus where id = new.sku_id), 0);
    end if;
  else
    new.diferencia := new.cantidad_contada - coalesce((select stock_sistema from skus where id = new.sku_id), 0);
  end if;
  if new.diferencia <> 0 then
    new.estado := 'con_diferencia';
  else
    new.estado := 'aprobado';
  end if;
  return new;
end;
$function$;
