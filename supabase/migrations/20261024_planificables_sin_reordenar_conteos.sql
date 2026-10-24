-- skus_planificables: "ya contado en el período" se pregunta directo a conteos (24/10/2026).
--
-- La vista sacaba los materiales ya contados con NOT EXISTS sobre ultimo_conteo_por_sku, que es un
-- DISTINCT ON (sku_id) ordenado de todos los conteos del período. Cuando el planificador cree que
-- una rama trae pocas filas, elige un nested loop y ese DISTINCT ON se vuelve a ordenar por CADA
-- material: medido en Escondida, con un plan de 24 entradas por ubicación o bodega (~125.000
-- coincidencias), skus_disponibles_planificar contó 31,8 s (2.300 conteos reordenados 63.961 veces,
-- 123 millones de comparaciones), por encima de los 20 s del rol authenticator. Es lo que explica
-- los picos de 8-10 s que registró pg_stat_statements desde el 13/10, cuando el plan de Escondida
-- llegó a tener más de mil entradas (hoy tiene 31 por bin y la misma consulta tarda 31 ms).
--
-- Que exista una fila en ultimo_conteo_por_sku para un material es lo mismo que exista un conteo de
-- ese material en el período (misma condición de ciclo, misma RLS de conteos: security_invoker en
-- las dos). Preguntado así, Postgres usa idx_conteos_sku: una búsqueda por índice por material.
-- Mismo plan simulado, dentro de una transacción revertida: 31,8 s -> 0,69 s. Verificado antes de
-- aplicar que la vista nueva devuelve exactamente las mismas filas (id y stock) que la anterior:
-- Escondida 63.479 = 63.479 y Agunsa 228 = 228, cero diferencias en ambos sentidos.
--
-- Arrastraba también a las listas de Plan, Contar y SKU: ubicaciones_generales/_especificas/_bins y
-- catalogos_pantalla_skus cruzan con skus_disponibles_planificar. Con el mismo plan grande,
-- ubicaciones_generales tardaba 32,1 s y ahora 0,9 s (catálogos 1,0 s, específicas y bins 0,8 s);
-- con el plan de hoy, 40-390 ms. Salida idéntica (md5) a la de la vista anterior.
--
-- Mismas columnas, mismo orden y security_invoker: las vistas y funciones que la leen
-- (skus_disponibles_planificar, skus_universo_entrada_plan_lote, revisar_codigos_plan,
-- crear_plan_grupo, buscar_skus_lectura) no cambian. ultimo_conteo_por_sku queda igual.

set local lock_timeout = '5s';

create or replace view public.skus_planificables with (security_invoker = true) as
 SELECT id,
    sku_code,
    descripcion,
    categoria,
    unidad_medida,
    ubicacion,
    bodega,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_sistema
        END AS stock_sistema,
    activo,
    created_at,
    updated_at,
    storage_bin,
    empresa_id,
    capturado_en,
    codigo_barras,
    bodega_key,
    costo_unitario,
    batch,
    batch_key,
    critico,
    clase_abc,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_bloqueado
        END AS stock_bloqueado,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_transito_1
        END AS stock_transito_1,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_transito_2
        END AS stock_transito_2,
        CASE
            WHEN ( SELECT debe_ocultar_stock_operador() AS debe_ocultar_stock_operador) THEN NULL::numeric
            ELSE stock_transferencia
        END AS stock_transferencia,
    dueno
   FROM skus s
  WHERE activo = true AND NOT (EXISTS ( SELECT 1
           FROM conteos u
          WHERE u.sku_id = s.id
            AND (u.ciclo_id = (( SELECT ciclo_actual() AS ciclo_actual)) OR (( SELECT ciclo_actual() AS ciclo_actual)) IS NULL))) AND (( SELECT plan_incluye_stock_cero() AS plan_incluye_stock_cero) OR COALESCE(stock_sistema, 0::numeric) <> 0::numeric);
