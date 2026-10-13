-- Daños al contar: packing dañado y material dañado (13/10/2026, pedido de Joel).
--
-- Al contar se puede marcar que el embalaje está dañado (solo la marca: el material se cuenta
-- igual) y que el material está dañado, con cuántas unidades opcionalmente (para saber cuánto
-- podría terminar como merma). Las tres columnas tienen default: los conteos de antes quedan "sin
-- daños" y una app vieja que no las manda sigue guardando igual.
--
-- La regla "unidades dañadas no más que lo contado" la valida la app al guardar y no la base: una
-- corrección posterior (corregir_conteo) puede bajar la cantidad contada y no debe fallar por eso.
-- La base solo exige que las unidades vayan con la marca de material dañado y no sean negativas.
--
-- skus_busqueda (Buscar y su PDF) suma las tres columnas del último conteo, al final, para no
-- mover las que ya existen.

set local lock_timeout = '5s';

alter table public.conteos
  add column if not exists packing_danado boolean not null default false,
  add column if not exists material_danado boolean not null default false,
  add column if not exists cantidad_danada numeric;

alter table public.conteos
  add constraint conteos_cantidad_danada_check
  check (cantidad_danada is null or (material_danado and cantidad_danada >= 0));

create or replace view public.skus_busqueda with (security_invoker = true) as
 SELECT s.id AS sku_id,
    s.sku_code,
    s.descripcion,
    s.bodega,
    s.ubicacion,
    s.storage_bin,
    s.empresa_id,
    s.ultimo_conteo_id AS conteo_id,
    s.ultimo_conteo_cantidad AS cantidad_contada,
    s.ultimo_conteo_estado AS estado,
    s.ultimo_conteo_diferencia AS diferencia,
    s.ultimo_conteo_fecha AS fecha_conteo,
    s.ultimo_conteo_capturado_en AS capturado_en,
    s.ultimo_conteo_fuera_de_plan AS fuera_de_plan,
    s.ultimo_conteo_ciclo_id AS ciclo_id,
    cc.nombre AS ciclo_nombre,
    COALESCE(fotos.items, '[]'::jsonb) AS fotos,
    s.batch,
    u.nombre AS contado_por,
    s.critico,
    s.clase_abc,
    s.pct_acumulado,
    co.observacion,
    s.ultimo_conteo_usuario_id AS contado_por_id,
    ((s.ultimo_conteo_id IS NOT NULL) AND (COALESCE(s.ultimo_conteo_diferencia, (0)::numeric) <> (0)::numeric) AND (co.reconteo_descartado_en IS NULL) AND ((s.ultimo_conteo_ciclo_id = ( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual) IS NULL))) AS reconteo_pendiente,
    co.cantidad_original,
    co.corregido_en,
    co.motivo_correccion,
    co.reconteo_cierre_tipo,
    co.ajuste_erp_referencia,
    co.reconteo_descartado_en AS reconteo_cerrado_en,
    co.packing_danado,
    co.material_danado,
    co.cantidad_danada
   FROM ((((skus s
     LEFT JOIN ciclos_conteo cc ON ((cc.id = s.ultimo_conteo_ciclo_id)))
     LEFT JOIN usuarios u ON ((u.id = s.ultimo_conteo_usuario_id)))
     LEFT JOIN conteos co ON ((co.id = s.ultimo_conteo_id)))
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('foto_url', cf.foto_url, 'numero_conteo', cs.numero_conteo, 'fecha_conteo', cs.fecha_conteo) ORDER BY cs.fecha_conteo, cf.created_at) AS items
           FROM (( SELECT c.id,
                    c.fecha_conteo,
                    row_number() OVER (ORDER BY c.fecha_conteo) AS numero_conteo
                   FROM conteos c
                  WHERE (c.sku_id = s.id)) cs
             JOIN conteo_fotos cf ON ((cf.conteo_id = cs.id)))) fotos ON (true))
  WHERE (s.activo = true);
