-- Dueños de stock: contraer la identidad del material (Joel, 20/10/2026). Sigue a
-- 20261020_duenos_stock.sql y 20261020_duenos_stock_carga.sql.
--
-- Se borra el índice único de siempre (empresa_id, sku_code, bodega_key, batch_key,
-- ubicacion_key, storage_bin_key). Desde 20261020_duenos_stock.sql convivía con
-- skus_identidad_con_dueno_key, que tiene las mismas columnas más el dueño y cubre las mismas
-- búsquedas. Mientras existía, dos dueños no podían tener el mismo material en el mismo sitio.
-- La app publicada ya hace upsert con dueño (#597); una versión vieja guardada en un navegador
-- que cargue un Excel recibe un error visible y se actualiza.

set local lock_timeout = '5s';

drop index if exists public.skus_empresa_id_sku_code_bodega_batch_ubicacion_bin_key;
