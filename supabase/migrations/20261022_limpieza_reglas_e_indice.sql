-- Limpieza de la base que pidió el advisor de rendimiento (Joel, 22/10/2026).
--
-- 1. ubicaciones tenía dos reglas de lectura para la misma persona: auth_read_ubicaciones (SELECT,
--    la empresa) y admin_write_ubicaciones, que era FOR ALL y por eso también contaba para SELECT.
--    Postgres evalúa las dos en cada lectura. Se reemplaza la de administrador por tres (INSERT,
--    UPDATE y DELETE) con las mismas condiciones: quién lee y quién escribe queda exactamente igual
--    (la lectura de admin_write ya era un caso particular de auth_read).
-- 2. conteos.corregido_por (quién corrigió un conteo) es una llave foránea a usuarios sin índice:
--    cada vez que se borra o cambia un usuario, Postgres revisa conteos completo. Se agrega el
--    índice; casi todas las filas tienen corregido_por vacío, así que pesa poco.
--
-- No se tocan los 27 índices que el advisor marca "sin uso" (664 kB en total): 20 cubren llaves
-- foráneas y casi todos son del módulo de Bodega, que hoy solo usa la demo. Quitarlos ahorraría casi
-- nada y los necesitará la primera empresa que lo active.

set local lock_timeout = '5s';

create policy admin_insert_ubicaciones on public.ubicaciones for insert to authenticated
  with check ((empresa_id = (select public.empresa_actual())) and (select public.es_admin_actual()));
create policy admin_update_ubicaciones on public.ubicaciones for update to authenticated
  using ((empresa_id = (select public.empresa_actual())) and (select public.es_admin_actual()))
  with check ((empresa_id = (select public.empresa_actual())) and (select public.es_admin_actual()));
create policy admin_delete_ubicaciones on public.ubicaciones for delete to authenticated
  using ((empresa_id = (select public.empresa_actual())) and (select public.es_admin_actual()));
drop policy admin_write_ubicaciones on public.ubicaciones;

create index if not exists conteos_corregido_por_idx on public.conteos (corregido_por);
