-- Dueños de stock: el informe de cierre de período, por dueño (Joel, 21/10/2026). Sigue a
-- 20261022_duenos_stock_listas_plan.sql.
--
-- El período sigue siendo uno para toda la empresa. Al cerrarlo (marcar_ciclo_actual), una empresa
-- con dueños activados (empresas.usa_duenos_stock) guarda además, en datos.por_dueno, los mismos
-- números del informe separados por dueño: { "<código>": {avance_total, exactitud_por_bodega,
-- diferencias_recientes, ranking_responsable, valorizacion_diferencias, reconteos_sin_resolver} },
-- con '' para lo que no tiene dueño. Cada sección tiene la misma forma que la de toda la empresa,
-- así la app la muestra con el mismo código.
--
-- Una empresa sin dueños guarda exactamente lo mismo que antes (el bloque nuevo no corre). Los
-- informes ya cerrados no cambian: se congelaron al cerrar y no hay cómo recalcularlos.
--
-- Cada sección se calcula UNA vez para todos los dueños (agrupando también por dueño), no una
-- vez por dueño: con muchos clientes, repetir el cálculo por cada uno podía pasar el
-- statement_timeout de 20 s y hacer fallar el cierre entero.

set local lock_timeout = '5s';

-- Error encontrado al ensayar esto (previo a este cambio): cerrar un período que ya se había
-- cerrado antes y se volvió a marcar como actual hace un upsert sobre su informe (on conflict do
-- update), y informes_ciclo no tenía política de UPDATE: la base lo rechazaba ("new row violates
-- row-level security policy") y el cambio de período fallaba entero. Pasaba en Escondida: su
-- período actual (Q1-MEL2) ya tiene informe de un cierre anterior. Se permite actualizar el informe
-- de la propia empresa con la misma condición que ya tenía crearlo (un administrador).
create policy admin_update_informes_ciclo on public.informes_ciclo
  for update
  using ((empresa_id = (select empresa_actual())) and (select es_admin_actual()))
  with check ((empresa_id = (select empresa_actual())) and (select es_admin_actual()));

create or replace function public.marcar_ciclo_actual(ciclo_id uuid)
 returns void
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_empresa_id uuid;
  v_saliente_id uuid;
  v_saliente_nombre text;
  v_saliente_fecha_inicio date;
  v_dias_ciclo int;
  v_datos jsonb;
  v_usuario_id uuid;
begin
  select empresa_id into v_empresa_id from ciclos_conteo where id = ciclo_id;
  if v_empresa_id is null then
    raise exception 'Ciclo no encontrado';
  end if;

  select id, nombre, fecha_inicio into v_saliente_id, v_saliente_nombre, v_saliente_fecha_inicio
  from ciclos_conteo
  where empresa_id = v_empresa_id and es_actual = true and id <> ciclo_id;

  if v_saliente_id is not null then
    v_dias_ciclo := greatest(1, (current_date - v_saliente_fecha_inicio) + 1);
    select id into v_usuario_id from usuarios where auth_user_id = auth.uid() and activo = true;

    select jsonb_build_object(
      'avance_total', coalesce((select jsonb_agg(to_jsonb(a)) from avance_total a), '[]'::jsonb),
      'exactitud_por_bodega', coalesce((select jsonb_agg(to_jsonb(e)) from exactitud_por_bodega e), '[]'::jsonb),
      'diferencias_recientes', coalesce((select to_jsonb(d) from diferencias_recientes(v_dias_ciclo) d), 'null'::jsonb),
      'ranking_responsable', coalesce((select jsonb_agg(to_jsonb(r)) from (select * from ranking_responsable(v_dias_ciclo) limit 8) r), '[]'::jsonb),
      'valorizacion_diferencias', coalesce((select jsonb_agg(to_jsonb(v)) from valorizacion_diferencias v), '[]'::jsonb),
      'reconteos_sin_resolver', coalesce((
        select jsonb_agg(jsonb_build_object(
          'sku_code', rp.sku_code, 'descripcion', rp.descripcion, 'ultima_diferencia', rp.ultima_diferencia,
          'causa_probable', rp.causa_probable, 'ultimo_conteo_fecha', rp.ultimo_conteo_fecha
        ))
        from reconteo_pendiente rp join skus s on s.id = rp.id
        where s.empresa_id = v_empresa_id
      ), '[]'::jsonb)
    ) into v_datos;

    -- Lo mismo, por dueño (solo empresas con dueños). Mismas reglas que las vistas de arriba: el
    -- período es el que se cierra (todavía es el actual) y cuenta el último conteo de cada SKU.
    if exists (select 1 from empresas e where e.id = v_empresa_id and e.usa_duenos_stock) then
      with duenos as (
        select distinct s.dueno from skus s where s.empresa_id = v_empresa_id and s.activo
      ),
      contados as (
        select distinct c.sku_id from conteos c where c.ciclo_id = v_saliente_id
      ),
      ultimo as (
        select distinct on (c.sku_id) c.sku_id, c.diferencia, c.ubicacion_distinta, c.fecha_conteo
        from conteos c
        where c.ciclo_id = v_saliente_id
        order by c.sku_id, c.fecha_conteo desc
      ),
      avance as (
        select s.dueno, s.bodega, count(*) as skus_universo, count(c.sku_id) as skus_contados,
               round(100.0 * count(c.sku_id)::numeric / nullif(count(*), 0)::numeric, 1) as porcentaje_avance
        from skus s left join contados c on c.sku_id = s.id
        where s.empresa_id = v_empresa_id and s.activo
        group by s.dueno, s.bodega
      ),
      exactitud as (
        select s.dueno, s.bodega, count(*) as skus_contados,
               count(*) filter (where u.diferencia = 0) as sin_diferencia,
               count(*) filter (where u.diferencia <> 0) as con_diferencia,
               count(*) filter (where not u.ubicacion_distinta) as ubicacion_correcta
        from ultimo u join skus s on s.id = u.sku_id
        where s.empresa_id = v_empresa_id and s.activo
        group by s.dueno, s.bodega
      ),
      recientes as (
        select s.dueno,
               count(*) filter (where u.diferencia = 0) as sin_diferencia,
               count(*) filter (where u.diferencia <> 0) as con_diferencia
        from ultimo u join skus s on s.id = u.sku_id
        where s.empresa_id = v_empresa_id and s.activo
          and u.fecha_conteo >= now() - (v_dias_ciclo || ' days')::interval
        group by s.dueno
      ),
      ranking as (
        select x.dueno, x.nombre, x.cantidad,
               row_number() over (partition by x.dueno order by x.cantidad desc, x.nombre) as n
        from (
          select s.dueno, coalesce(u.nombre, 'Sin asignar') as nombre, count(*) as cantidad
          from conteos c
          join skus s on s.id = c.sku_id
          left join usuarios u on u.id = c.usuario_id
          where s.empresa_id = v_empresa_id
            and c.ciclo_id = v_saliente_id
            and c.fecha_conteo >= (current_date - (v_dias_ciclo - 1) * interval '1 day')
          group by s.dueno, coalesce(u.nombre, 'Sin asignar')
        ) x
      ),
      valorizacion as (
        select s.dueno, s.bodega,
               coalesce(sum(s.stock_sistema * s.costo_unitario), 0) as valor_contado,
               coalesce(sum(u.diferencia * s.costo_unitario) filter (where u.diferencia < 0), 0) as valor_perdidas,
               coalesce(sum(u.diferencia * s.costo_unitario) filter (where u.diferencia > 0), 0) as valor_excedentes
        from ultimo u join skus s on s.id = u.sku_id
        where s.empresa_id = v_empresa_id and s.activo and s.costo_unitario is not null
        group by s.dueno, s.bodega
      ),
      reconteos as (
        select s.dueno, jsonb_agg(jsonb_build_object(
          'sku_code', rp.sku_code, 'descripcion', rp.descripcion, 'ultima_diferencia', rp.ultima_diferencia,
          'causa_probable', rp.causa_probable, 'ultimo_conteo_fecha', rp.ultimo_conteo_fecha
        )) as lista
        from reconteo_pendiente rp join skus s on s.id = rp.id
        where s.empresa_id = v_empresa_id
        group by s.dueno
      )
      select v_datos || jsonb_build_object('por_dueno', coalesce(jsonb_object_agg(d.dueno, jsonb_build_object(
        'avance_total', coalesce((select jsonb_agg(jsonb_build_object('bodega', a.bodega, 'skus_universo', a.skus_universo, 'skus_contados', a.skus_contados, 'porcentaje_avance', a.porcentaje_avance)) from avance a where a.dueno = d.dueno), '[]'::jsonb),
        'exactitud_por_bodega', coalesce((select jsonb_agg(jsonb_build_object('bodega', e.bodega, 'skus_contados', e.skus_contados, 'sin_diferencia', e.sin_diferencia, 'con_diferencia', e.con_diferencia, 'ubicacion_correcta', e.ubicacion_correcta) order by e.bodega) from exactitud e where e.dueno = d.dueno), '[]'::jsonb),
        'diferencias_recientes', coalesce((select jsonb_build_object('sin_diferencia', r.sin_diferencia, 'con_diferencia', r.con_diferencia) from recientes r where r.dueno = d.dueno), jsonb_build_object('sin_diferencia', 0, 'con_diferencia', 0)),
        'ranking_responsable', coalesce((select jsonb_agg(jsonb_build_object('nombre', k.nombre, 'cantidad', k.cantidad) order by k.n) from ranking k where k.dueno = d.dueno and k.n <= 8), '[]'::jsonb),
        'valorizacion_diferencias', coalesce((select jsonb_agg(jsonb_build_object('bodega', v.bodega, 'valor_contado', v.valor_contado, 'valor_perdidas', v.valor_perdidas, 'valor_excedentes', v.valor_excedentes) order by v.bodega) from valorizacion v where v.dueno = d.dueno), '[]'::jsonb),
        'reconteos_sin_resolver', coalesce((select x.lista from reconteos x where x.dueno = d.dueno), '[]'::jsonb)
      )), '{}'::jsonb))
      into v_datos
      from duenos d;
    end if;

    insert into informes_ciclo (empresa_id, ciclo_id, ciclo_nombre, fecha_inicio, fecha_cierre, generado_por, datos)
    values (v_empresa_id, v_saliente_id, v_saliente_nombre, v_saliente_fecha_inicio, now(), v_usuario_id, v_datos)
    on conflict on constraint informes_ciclo_ciclo_id_key do update set
      ciclo_nombre = excluded.ciclo_nombre,
      fecha_inicio = excluded.fecha_inicio,
      fecha_cierre = excluded.fecha_cierre,
      generado_por = excluded.generado_por,
      datos = excluded.datos;
  end if;

  update ciclos_conteo set es_actual = false
  where empresa_id = v_empresa_id and es_actual = true and id <> ciclo_id;

  update ciclos_conteo set es_actual = true
  where id = ciclo_id;
end;
$function$;
