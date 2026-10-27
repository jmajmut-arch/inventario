-- Exportar conteos con conteo ciego: sin stock, cantidad, diferencia ni valor (27/10/2026).
--
-- El botón Exportar (Más) lo usa cualquier persona de la empresa. conteos_exportables no tenía
-- ninguna protección de conteo ciego: un operador con conteo ciego bajaba en Excel el stock del
-- sistema, lo contado, la diferencia y su valor de cada conteo, todo lo que Contar, Reconteo y
-- Buscar le esconden. Ahora esas cuatro columnas van en null para ese operador
-- (debe_ocultar_stock_operador), igual que en reconteo_pendiente y skus_busqueda. Pedido de Joel.
--
-- Mismas columnas, tipos y orden; ninguna función ni vista lee conteos_exportables (revisado en
-- pg_proc y pg_depend). Un administrador sigue viendo todo. Al aplicarse, ninguna empresa tenía el
-- conteo ciego prendido.

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
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE s.stock_sistema
        END AS stock_sistema,
    s.costo_unitario,
    c.bodega AS bodega_contada,
    c.ubicacion_contada,
    c.ubicacion_distinta,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE c.cantidad_contada
        END AS cantidad_contada,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE c.diferencia
        END AS diferencia,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE c.diferencia * s.costo_unitario
        END AS valor_diferencia,
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
    c.cantidad_danada,
    s.dueno
   FROM conteos c
     JOIN skus s ON s.id = c.sku_id
     LEFT JOIN usuarios u ON u.id = c.usuario_id
     LEFT JOIN ciclos_conteo cc ON cc.id = c.ciclo_id
  ORDER BY c.fecha_conteo DESC;
