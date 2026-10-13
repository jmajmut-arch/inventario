-- Excel de conteos con los daños (13/10/2026, pedido de Joel).
--
-- conteos_exportables (Más -> Exportar conteos) suma packing_danado, material_danado y
-- cantidad_danada (ver 20261013_conteos_danos.sql), al final para no mover las columnas que ya
-- existen. La app las escribe como "Packing dañado", "Material dañado" y "Unidades dañadas".

set local lock_timeout = '5s';

create or replace view public.conteos_exportables with (security_invoker = true) as
 SELECT c.id AS conteo_id,
    s.sku_code,
    s.descripcion,
    s.categoria,
    s.unidad_medida,
    s.codigo_barras,
    s.bodega AS bodega_maestro,
    s.ubicacion AS ubicacion_maestro,
    s.storage_bin,
    s.stock_sistema,
    s.costo_unitario,
    c.bodega AS bodega_contada,
    c.ubicacion_contada,
    c.ubicacion_distinta,
    c.cantidad_contada,
    c.diferencia,
    (c.diferencia * s.costo_unitario) AS valor_diferencia,
    c.estado,
    c.fuera_de_plan,
    c.observacion,
    c.fecha_conteo,
    c.capturado_en,
    u.nombre AS responsable,
    cc.nombre AS ciclo_nombre,
    s.batch,
    c.packing_danado,
    c.material_danado,
    c.cantidad_danada
   FROM (((conteos c
     JOIN skus s ON ((s.id = c.sku_id)))
     LEFT JOIN usuarios u ON ((u.id = c.usuario_id)))
     LEFT JOIN ciclos_conteo cc ON ((cc.id = c.ciclo_id)))
  ORDER BY c.fecha_conteo DESC;
