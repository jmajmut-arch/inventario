-- Dueños de stock: los números de las listas de lugares al planificar, por dueño (Joel, 21/10/2026).
-- Sigue a 20261022_duenos_stock_grupos_pegar.sql.
--
-- "Agregar a la planificación" muestra en cada lugar "por planificar / total SKU" (ubicaciones_
-- generales, ubicaciones_especificas, ubicaciones_bins). Con un dueño elegido, esos números deben
-- ser los de ese dueño. Las vistas de siempre no se tocan (las usan también la ficha de SKU y otras
-- pantallas, y sumar el dueño a su agrupación cambiaría lo que devuelven): estas tres son las mismas
-- consultas agrupadas además por dueño, y la app las pide solo con un dueño elegido, filtrando
-- dueno=eq.X (el filtro sobre una columna de la agrupación se aplica antes de agrupar).

set local lock_timeout = '5s';

create view public.ubicaciones_generales_dueno with (security_invoker = true) as
 SELECT s.bodega,
    s.dueno,
    count(DISTINCT s.id) FILTER (WHERE sdp.id IS NOT NULL) AS cantidad_pendiente,
    count(DISTINCT s.id) AS cantidad_skus
   FROM skus s
     LEFT JOIN skus_disponibles_planificar sdp ON sdp.id = s.id
  WHERE s.activo = true AND NOT (s.bodega IS NULL AND s.ubicacion IS NULL)
  GROUP BY s.bodega, s.dueno
  ORDER BY s.bodega;

create view public.ubicaciones_especificas_dueno with (security_invoker = true) as
 SELECT s.bodega,
    s.ubicacion,
    s.dueno,
    count(DISTINCT s.id) FILTER (WHERE sdp.id IS NOT NULL) AS cantidad_pendiente,
    count(DISTINCT s.id) AS cantidad_skus
   FROM skus s
     LEFT JOIN skus_disponibles_planificar sdp ON sdp.id = s.id
  WHERE s.activo = true AND s.ubicacion IS NOT NULL
  GROUP BY s.bodega, s.ubicacion, s.dueno
  ORDER BY s.bodega, s.ubicacion;

create view public.ubicaciones_bins_dueno with (security_invoker = true) as
 SELECT bodega,
    ubicacion,
    storage_bin,
    dueno,
    count(*) AS cantidad_skus
   FROM skus_disponibles_planificar
  WHERE storage_bin IS NOT NULL
  GROUP BY bodega, ubicacion, storage_bin, dueno
  ORDER BY bodega, ubicacion, storage_bin;

grant select on public.ubicaciones_generales_dueno, public.ubicaciones_especificas_dueno, public.ubicaciones_bins_dueno to authenticated;
revoke all on public.ubicaciones_generales_dueno, public.ubicaciones_especificas_dueno, public.ubicaciones_bins_dueno from anon;
