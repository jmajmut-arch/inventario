-- Hoja de conteo del Plan (Exportar PDF) con el lote (Joel, 21/10/2026). Un mismo código en dos
-- lotes del mismo storage bin salía en dos filas idénticas: en terreno no había cómo saber en cuál
-- anotar cada lote. Pasa en Agunsa (39 código+bin con más de un lote) y en Escondida (661). La app
-- muestra la columna Batch solo si algún material de la tabla lo tiene (ver tablaSkusEntradaPlan).
-- El "Plan del día" de Contar usa universo_entradas_plan_contar, que ya traía el batch.
--
-- Se agrega una clave al JSON (la app que no la conoce la ignora) y, dentro de un mismo código y
-- bin, las filas van ordenadas por lote. Misma firma y mismos permisos (create or replace los
-- conserva).

set local lock_timeout = '5s';

create or replace function public.universo_entradas_plan_hoja(p_plan_ids uuid[])
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(jsonb_object_agg(t.plan_id, t.skus), '{}'::jsonb)
  from (
    select u.plan_id,
           jsonb_agg(jsonb_build_object('sku_code', u.sku_code, 'descripcion', u.descripcion,
                                        'storage_bin', u.storage_bin, 'batch', u.batch,
                                        'unidad_medida', u.unidad_medida,
                                        'clase_abc', u.clase_abc, 'critico', u.critico)
                     order by u.storage_bin, u.sku_code, u.batch, u.id) as skus
    from skus_universo_entrada_plan_lote(p_plan_ids) u
    group by u.plan_id
  ) t;
$function$;
