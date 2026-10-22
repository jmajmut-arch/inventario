-- Ubicaciones (generales/específicas, y sus variantes por dueño) sin count(DISTINCT) (Joel, 22/10/2026).
--
-- Contaban con count(DISTINCT s.id) un LEFT JOIN 1 a 1 (cada material aparece una vez en skus y,
-- como mucho, una vez en skus_disponibles_planificar), así que el DISTINCT no quitaba nada pero
-- obligaba a ordenar los ~64.500 materiales de Escondida en cada consulta. count(*) y count(sdp.id)
-- dan lo mismo sin ese orden. Son las listas de Plan y de Contar (y el catálogo de la pantalla SKU).
-- Verificado con datos reales antes de aplicar, comparando la salida completa (md5) de la vista
-- actual y la nueva, como admin de Escondida y de Agunsa (dueños): idénticas en las cuatro.
--   Escondida: generales 426 -> 268 ms, específicas 530 -> 280, generales_dueno 521 -> 307,
--   específicas_dueno 649 -> 301. Agunsa: ~10 ms antes y después.
-- Mismas columnas, mismo orden y security_invoker como antes.

set local lock_timeout = '5s';

create or replace view public.ubicaciones_generales with (security_invoker = true) as
 SELECT s.bodega,
    count(sdp.id) AS cantidad_pendiente,
    count(*) AS cantidad_skus
   FROM (skus s
     LEFT JOIN skus_disponibles_planificar sdp ON ((sdp.id = s.id)))
  WHERE ((s.activo = true) AND (NOT ((s.bodega IS NULL) AND (s.ubicacion IS NULL))))
  GROUP BY s.bodega
  ORDER BY s.bodega;

create or replace view public.ubicaciones_especificas with (security_invoker = true) as
 SELECT s.bodega,
    s.ubicacion,
    count(sdp.id) AS cantidad_pendiente,
    count(*) AS cantidad_skus
   FROM (skus s
     LEFT JOIN skus_disponibles_planificar sdp ON ((sdp.id = s.id)))
  WHERE ((s.activo = true) AND (s.ubicacion IS NOT NULL))
  GROUP BY s.bodega, s.ubicacion
  ORDER BY s.bodega, s.ubicacion;

create or replace view public.ubicaciones_generales_dueno with (security_invoker = true) as
 SELECT s.bodega,
    s.dueno,
    count(sdp.id) AS cantidad_pendiente,
    count(*) AS cantidad_skus
   FROM (skus s
     LEFT JOIN skus_disponibles_planificar sdp ON ((sdp.id = s.id)))
  WHERE ((s.activo = true) AND (NOT ((s.bodega IS NULL) AND (s.ubicacion IS NULL))))
  GROUP BY s.bodega, s.dueno
  ORDER BY s.bodega;

create or replace view public.ubicaciones_especificas_dueno with (security_invoker = true) as
 SELECT s.bodega,
    s.ubicacion,
    s.dueno,
    count(sdp.id) AS cantidad_pendiente,
    count(*) AS cantidad_skus
   FROM (skus s
     LEFT JOIN skus_disponibles_planificar sdp ON ((sdp.id = s.id)))
  WHERE ((s.activo = true) AND (s.ubicacion IS NOT NULL))
  GROUP BY s.bodega, s.ubicacion, s.dueno
  ORDER BY s.bodega, s.ubicacion;
