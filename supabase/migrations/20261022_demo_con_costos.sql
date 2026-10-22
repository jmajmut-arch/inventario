-- La demo pública con costo en sus materiales (Joel, 22/10/2026).
--
-- resetear_demo_inventia (cada noche, 08:00 UTC) cargaba los 24 materiales de Demo InventIA sin
-- costo_unitario. Sin costo no hay valor de inventario ni clase ABC: quien probaba la demo veía el
-- Panel sin valorización y sin A/B/C, que es justo lo que más se muestra en una venta.
--
-- Ahora cada material lleva un costo de ejemplo en pesos (precios plausibles de bodega minera, no
-- datos reales), y al final del reset se recalcula la clase ABC de la demo
-- (privado.recalcular_abc_empresa), para que no espere a la tarea nocturna del ABC (07:00 UTC, antes
-- del reset). Solo toca la demo: el resto de la función queda igual, texto por texto.
--
-- Se aplica como reemplazo sobre la definición vigente (que no estaba en el repositorio): si el texto
-- esperado no aparece, falla sin cambiar nada.

set local lock_timeout = '5s';

do $ajuste$
declare
  d text;
  nuevo text;
  c record;
begin
  d := pg_get_functiondef('public.resetear_demo_inventia()'::regprocedure);
  nuevo := d;

  nuevo := replace(nuevo,
    '(sku_code, descripcion, categoria, unidad_medida, bodega, ubicacion, storage_bin, stock_sistema, empresa_id, codigo_barras) values',
    '(sku_code, descripcion, categoria, unidad_medida, bodega, ubicacion, storage_bin, stock_sistema, empresa_id, codigo_barras, costo_unitario) values');

  for c in select * from (values
    ('FIL-1001', 85000), ('FIL-1002', 320000), ('FIL-1003', 65000),
    ('LUB-2001', 48000), ('LUB-2002', 3900), ('LUB-2003', 4500),
    ('PER-3001', 450), ('PER-3002', 180), ('PER-3003', 60),
    ('EPP-4001', 9500), ('EPP-4002', 6800), ('EPP-4003', 3200), ('EPP-4004', 14500),
    ('HER-5001', 890000), ('HER-5002', 145000),
    ('ELE-6001', 210000), ('ELE-6002', 32000),
    ('HID-7001', 18500), ('HID-7002', 24000),
    ('REP-8001', 4800000), ('REP-8002', 78000), ('REP-8003', 2350000),
    ('CON-9001', 1200), ('CON-9002', 5400)
  ) v(codigo, costo) loop
    d := nuevo;
    nuevo := regexp_replace(nuevo,
      '(\(''' || c.codigo || ''',[^\n]*?v_empresa_id, (null|''[0-9]+''))\)',
      '\1, ' || c.costo || ')');
    if nuevo = d then
      raise exception 'resetear_demo_inventia: no se encontró la fila de % (revisar antes de aplicar)', c.codigo;
    end if;
  end loop;

  d := nuevo;
  nuevo := replace(nuevo,
    E'from public.skus s where s.empresa_id = v_empresa_id and s.sku_code = ''LUB-2002'';\nend;',
    E'from public.skus s where s.empresa_id = v_empresa_id and s.sku_code = ''LUB-2002'';\n\n'
    || E'  -- Clase ABC de la demo con los costos de arriba (ver 20261022_demo_con_costos.sql).\n'
    || E'  perform privado.recalcular_abc_empresa(v_empresa_id);\nend;');
  if nuevo = d or position('costo_unitario) values' in nuevo) = 0 then
    raise exception 'resetear_demo_inventia no tiene el texto esperado: revisar antes de aplicar';
  end if;

  execute nuevo;
end;
$ajuste$;
