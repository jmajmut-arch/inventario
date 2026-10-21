-- Dueños de stock: ajuste de rendimiento del Panel por dueño (Joel, 21/10/2026). Sigue a
-- 20261021_duenos_stock_panel.sql, que en el repositorio ya trae la versión ajustada.
--
-- En la base se aplicó primero la versión sin ajustar. Este paso la lleva a la del archivo:
-- el resumen ABC lee privado.skus_valor_abc_empresa_mv directo (antes cruzaba la vista
-- skus_valor_abc con skus otra vez) y el avance del plan materializa el universo y los contados.
-- Medido como usuario de Escondida con un dueño que tiene todo: de 3,7 s a 2,0 s, mismo JSON.
-- Idempotente: si la función ya está ajustada (base creada desde cero con el archivo
-- anterior), no hace nada.

set local lock_timeout = '5s';

do $ajuste$
declare d text;
begin
  d := pg_get_functiondef('privado.dashboard_ejecutivo_calculo_dueno(integer,text,text)'::regprocedure);
  if position('skus_valor_abc_empresa_mv' in d) > 0 then
    return;
  end if;
  d := replace(d, 'select v.* from skus_valor_abc v join skus s on s.id = v.sku_id where s.dueno = p_dueno',
                  'select s.id as sku_id, mv.valor_total, mv.pct_acumulado, mv.clase_abc from skus s join privado.skus_valor_abc_empresa_mv mv on mv.sku_id = s.id where s.activo = true and mv.empresa_id = (select empresa_actual()) and s.dueno = p_dueno');
  d := replace(d, '), u as (', '), u as materialized (');
  d := replace(d, E'), contados as (\n                    select distinct c.ciclo_id, c.sku_id from conteos c',
                  E'), contados as materialized (\n                    select distinct c.ciclo_id, c.sku_id from conteos c');
  if position('skus_valor_abc_empresa_mv' in d) = 0 or position('u as materialized' in d) = 0
     or position('contados as materialized' in d) = 0 then
    raise exception 'El ajuste no encontró el texto esperado en dashboard_ejecutivo_calculo_dueno';
  end if;
  execute d;
end $ajuste$;
