-- Dueños de stock: grupos de conteo por dueño (Joel, 21/10/2026). Sigue a
-- 20261021_duenos_stock_plan.sql. La otra mitad (crear_plan_grupo, el cierre nocturno de ciclos y
-- el índice del grupo automático de críticos) va en 20261022_duenos_stock_grupos_pegar.sql, que se
-- aplica desde el SQL Editor porque esas funciones borran filas (ver el comentario de ese archivo).
--
-- Un grupo puede acotarse a un dueño: grupos_conteo.dueno (null = todos, lo de siempre; '' = lo que
-- no tiene dueño; un código = ese dueño). La pertenencia sigue siendo por código + bodega; con dueño,
-- de cada miembro solo cuentan las filas de ese dueño (un mismo código puede ser de dos clientes en
-- la misma bodega). El grupo automático de críticos con dueño son los críticos de ese dueño.
--
-- Todos los grupos que existen tienen dueno null: para ellos cada función da lo mismo que antes
-- (ensayado con Escondida comparando el md5 de los resultados).

set local lock_timeout = '5s';

alter table public.grupos_conteo add column if not exists dueno text;

-- Igual que en plan_semanal: sin estadísticas, Postgres supone que casi ningún grupo tiene dueño
-- null y puede cambiar de plan por el "dueño null o el mismo" de abajo.
analyze public.grupos_conteo;

create trigger trg_grupos_conteo_valida_dueno
  before insert or update of dueno on public.grupos_conteo
  for each row when (new.dueno is not null and new.dueno <> '')
  execute function public.skus_valida_dueno();

-- Avance de cada grupo en su ciclo (lista de Grupos).
create or replace function public.avance_por_grupo(p_inicios jsonb)
 returns table(grupo_id uuid, materiales integer, contados_ciclo integer, nunca_contados integer)
 language sql
 stable
 set search_path to 'public', 'pg_temp'
as $function$
  with g as (
    select g.id, g.automatico_critico, g.dueno, (p_inicios ->> g.id::text)::timestamptz as inicio
    from public.grupos_conteo g
    where g.empresa_id = (select public.empresa_actual()) and p_inicios ? g.id::text
  ),
  miembros as (
    select g.id as grupo_id, m.sku_code, coalesce(m.bodega,'') as bodega, g.inicio, g.dueno
    from g join public.skus_grupos_conteo m on m.grupo_id = g.id
    where not g.automatico_critico
    union
    select g.id, s.sku_code, coalesce(s.bodega,''), g.inicio, g.dueno
    from g join public.skus s on s.empresa_id = (select public.empresa_actual()) and s.activo and s.critico
      and (g.dueno is null or s.dueno = g.dueno)
    where g.automatico_critico
  ),
  ultimo as (
    select mi.grupo_id, mi.inicio,
      (select max(s.ultimo_conteo_fecha) from public.skus s
        where s.empresa_id = (select public.empresa_actual()) and s.activo
          and s.sku_code = mi.sku_code and coalesce(s.bodega,'') = mi.bodega
          and (mi.dueno is null or s.dueno = mi.dueno)) as ultimo
    from miembros mi
  )
  select g.id, count(u.grupo_id)::int,
    count(*) filter (where u.inicio is not null and u.ultimo >= u.inicio)::int,
    count(*) filter (where u.grupo_id is not null and u.ultimo is null)::int
  from g left join ultimo u on u.grupo_id = g.id
  group by g.id;
$function$;

-- "3 materiales · 8 posiciones" de cada grupo.
create or replace function public.posiciones_por_grupo(p_grupo_ids uuid[])
 returns table(grupo_id uuid, materiales integer, posiciones integer)
 language sql
 stable
 set search_path to 'public'
as $function$
  with g as (
    select id, automatico_critico, dueno
    from grupos_conteo
    where id = any(p_grupo_ids) and empresa_id = (select empresa_actual())
  ),
  manual as (
    select g.id as grupo_id,
           count(distinct (m.sku_code, coalesce(m.bodega,''))) as materiales,
           (select count(*) from skus s
             where s.empresa_id = (select empresa_actual()) and s.activo
               and (g.dueno is null or s.dueno = g.dueno)
               and exists (select 1 from skus_grupos_conteo m2
                           where m2.grupo_id = g.id and m2.sku_code = s.sku_code
                             and coalesce(m2.bodega,'') = coalesce(s.bodega,''))) as posiciones
    from g
    left join skus_grupos_conteo m on m.grupo_id = g.id
    where not g.automatico_critico
    group by g.id, g.dueno
  ),
  automatico as (
    select g.id as grupo_id,
           (select count(distinct (s.sku_code, coalesce(s.bodega,''))) from skus s
             where s.empresa_id = (select empresa_actual()) and s.activo and s.critico
               and (g.dueno is null or s.dueno = g.dueno)) as materiales,
           (select count(*) from skus s
             where s.empresa_id = (select empresa_actual()) and s.activo and s.critico
               and (g.dueno is null or s.dueno = g.dueno)) as posiciones
    from g
    where g.automatico_critico
  )
  select grupo_id, materiales::integer, posiciones::integer from manual
  union all
  select grupo_id, materiales::integer, posiciones::integer from automatico;
$function$;

-- Buscar filtrado por un grupo: con dueño, solo las filas de ese dueño. Se cambia la versión con
-- p_dueno de cada función (las de siempre la llaman con null, ver 20261021_duenos_stock_filtros.sql).
-- Unir grupos_conteo dentro del "exists", que corre por cada fila, llevó en el ensayo con Escondida
-- Buscar por grupo de ~60 a ~450 ms. En contar y resumen (plpgsql con plan a medida) el dueño del
-- grupo se lee una vez en una variable: con un grupo sin dueño la condición desaparece del plan y el
-- tiempo es el de siempre. filas_busqueda_skus arma su consulta como texto y la ejecuta con USING
-- ($13 es el grupo): ahí va una subconsulta sin correlación, que Postgres calcula una vez.
create or replace function pg_temp.parche(t text, a text, b text, n integer)
 returns text language plpgsql as $f$
declare c integer := (length(t) - length(replace(t, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then
    raise exception 'Parche: se esperaban % aparición(es) y hay % de: %', n, c, left(a, 120);
  end if;
  return replace(t, a, b);
end $f$;

do $grupos$
declare d text; f text;
begin
  foreach f in array array[
    'public.contar_busqueda_skus(text,text,text,text,boolean,boolean,text,timestamp with time zone,timestamp with time zone,uuid,uuid,text,text)',
    'public.resumen_busqueda_skus(text,text,text,text,boolean,boolean,text,timestamp with time zone,timestamp with time zone,uuid,uuid,text,boolean,text)'
  ] loop
    d := pg_get_functiondef(f::regprocedure);
    d := pg_temp.parche(d, E'declare\n', E'declare\n  v_dueno_grupo text := (select g.dueno from public.grupos_conteo g where g.id = p_grupo_id);\n', 1);
    d := pg_temp.parche(d, 'p_grupo_id is null or exists (',
      'p_grupo_id is null or (v_dueno_grupo is null or s.dueno = v_dueno_grupo) and exists (', 1);
    execute d;
  end loop;

  d := pg_get_functiondef('public.filas_busqueda_skus(text,text,text,text,boolean,boolean,text,timestamp with time zone,timestamp with time zone,uuid,uuid,text,text,text,integer,integer,text)'::regprocedure);
  d := pg_temp.parche(d, '$13 is null or exists (',
    '$13 is null or ((select gd.dueno from public.grupos_conteo gd where gd.id = $13) is null'
      || ' or s.dueno = (select gd.dueno from public.grupos_conteo gd where gd.id = $13)) and exists (', 1);
  execute d;
end $grupos$;
