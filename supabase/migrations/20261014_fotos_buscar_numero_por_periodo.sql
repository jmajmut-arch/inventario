-- Buscar marcaba como "Reconteo" fotos de un conteo (Joel, 14/10/2026). La vista skus_busqueda
-- numeraba los conteos de cada material sumando TODOS los períodos: un material contado en un
-- período anterior y contado de nuevo en el actual mostraba la foto del conteo nuevo como
-- "Reconteo 1". En Escondida eran 12 fotos de 11 materiales.
--
-- El resto de la app numera dentro del período (row_number por sku y ciclo): reconteo_pendiente
-- (pantalla Reconteo), avance_diario/semanal/mensual (columna "Reconteos" del Panel) y
-- resumen_calendario_mes (la "R" del Calendario). Acá se hace igual: solo cambia el PARTITION BY
-- del número de cada foto. Mismas columnas, mismas fotos, mismo orden; las demás columnas no se
-- tocan. Sigue siendo security_invoker (RLS de quien consulta) y CREATE OR REPLACE conserva los
-- permisos.

set local lock_timeout = '5s';

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
    s.ultimo_conteo_id IS NOT NULL AND COALESCE(s.ultimo_conteo_diferencia, 0::numeric) <> 0::numeric AND co.reconteo_descartado_en IS NULL AND (s.ultimo_conteo_ciclo_id = (( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual)) IS NULL) AS reconteo_pendiente,
    co.cantidad_original,
    co.corregido_en,
    co.motivo_correccion,
    co.reconteo_cierre_tipo,
    co.ajuste_erp_referencia,
    co.reconteo_descartado_en AS reconteo_cerrado_en,
    co.packing_danado,
    co.material_danado,
    co.cantidad_danada
   FROM skus s
     LEFT JOIN ciclos_conteo cc ON cc.id = s.ultimo_conteo_ciclo_id
     LEFT JOIN usuarios u ON u.id = s.ultimo_conteo_usuario_id
     LEFT JOIN conteos co ON co.id = s.ultimo_conteo_id
     LEFT JOIN LATERAL ( SELECT jsonb_agg(jsonb_build_object('foto_url', cf.foto_url, 'numero_conteo', cs.numero_conteo, 'fecha_conteo', cs.fecha_conteo) ORDER BY cs.fecha_conteo, cf.created_at) AS items
           FROM ( SELECT c.id,
                    c.fecha_conteo,
                    -- Por período, como el resto de la app (ver arriba). Sin períodos, ciclo_id
                    -- es null para todos y queda igual que antes.
                    row_number() OVER (PARTITION BY c.ciclo_id ORDER BY c.fecha_conteo) AS numero_conteo
                   FROM conteos c
                  WHERE c.sku_id = s.id) cs
             JOIN conteo_fotos cf ON cf.conteo_id = cs.id) fotos ON true
  WHERE s.activo = true;
