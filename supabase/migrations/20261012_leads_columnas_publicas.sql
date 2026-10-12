-- El formulario público solo puede escribir los datos del lead (hallazgo del 12/10/2026).
--
-- anon y authenticated tenían INSERT sobre la tabla completa, así que un INSERT hecho a mano con
-- el anon key (que es público, está en el sitio) podía traer notificado_en, seguimiento1_en,
-- seguimiento2_en o seguimiento_detenido_en ya llenos: el lead entraba sin aviso por correo y sin
-- seguimiento automático, como si ya se hubiera atendido. No exponía datos de nadie, pero dejaba
-- que un tercero se saltara los avisos. Esas columnas las escriben solo el trigger, las funciones
-- con service role y el súper admin (UPDATE, que ya está restringido por RLS a es_super_admin()).
--
-- Se pasa a permisos por columna: el INSERT puede traer solo lo que mandan los formularios del
-- sitio (assets/comun.js; tests/esquema.test.js comprueba que no manden otra cosa). id y
-- creado_en salen de sus valores por omisión. SELECT, UPDATE y DELETE no cambian.
revoke insert on public.leads_demo from anon, authenticated;
grant insert (nombre, email, telefono, empresa, tipo, mensaje, origen) on public.leads_demo to anon, authenticated;
