-- De dónde vino cada lead (pendiente "Registrar de dónde viene cada lead", pedido de Joel 12/10/2026).
--
-- Hasta hoy un lead guardaba nombre, correo y teléfono, pero no el canal: para saber si llegó por
-- Google Ads o por LinkedIn había que cruzar la hora con Google Analytics, y Analytics no registra
-- a todos (Martin, 02/10, no aparece: bloqueador o navegador con protección de rastreo).
--
-- El formulario del sitio (assets/comun.js) manda un objeto con dos tomas:
--   primero: la primera visita registrada en ese navegador (90 días), p. ej. llegó por LinkedIn;
--   visita:  la visita en que pidió la demo, p. ej. volvió escribiendo la dirección.
-- Cada toma: fuente, medio, campana, contenido, referente, pagina, fecha. Todo opcional.
--
-- Una sola columna jsonb y no siete de texto: el formulario es público (anon) y una columna que
-- falte hace que PostgREST rechace el INSERT entero con un 400 -- un lead perdido. Con jsonb el
-- formato puede crecer sin migraciones. El tope de tamaño evita que alguien la use de basurero.
alter table public.leads_demo
  add column if not exists origen jsonb;

alter table public.leads_demo
  drop constraint if exists leads_demo_origen_tamano;
alter table public.leads_demo
  add constraint leads_demo_origen_tamano
  check (origen is null or (jsonb_typeof(origen) = 'object' and octet_length(origen::text) <= 4000));

comment on column public.leads_demo.origen is
  'De dónde vino el lead, según el sitio: {"primero":{...},"visita":{...}} con fuente, medio, campana, contenido, referente, pagina, fecha. Null en los leads anteriores al 12/10/2026.';
