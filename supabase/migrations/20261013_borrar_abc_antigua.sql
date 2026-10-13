-- Borra la vista materializada ABC anterior (13/10/2026), por decisión de Joel.
--
-- Desde 20261013_abc_por_empresa.sql nada la usa: skus_valor_abc, refrescar_clasificacion_abc()
-- y el refresco nocturno leen y refrescan privado.skus_valor_abc_empresa_mv. Sin cascade a
-- propósito: si algo dependiera de ella, la migración falla en vez de llevárselo por delante.
-- Es un cálculo derivado de skus, no datos: no se pierde nada.

set local lock_timeout = '5s';

drop materialized view privado.skus_valor_abc_mv;
