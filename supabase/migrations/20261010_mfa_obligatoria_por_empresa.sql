-- Verificación en dos pasos de los administradores: interruptor por empresa (decisión de Joel,
-- 10/10/2026).
--
-- Desde el 19/09 la app avisaba a todo admin sin segundo factor y tenía un bloqueo fijo en el
-- código para el 1 de diciembre de 2026. Joel decidió no imponerlo a todas las empresas: cada una
-- lo prende desde Configuraciones si lo quiere. Apagado por defecto, así nadie queda afuera el
-- 1 de diciembre; la MFA sigue disponible para quien la active en su cuenta.
--
-- La columna la cambia el admin de su propia empresa (política update_empresas), igual que
-- foto_obligatoria_conteo. No va en empresas_protege_columnas_de_negocio: es una política de
-- seguridad de la empresa, no algo que administre InventIA.
alter table public.empresas
  add column if not exists mfa_obligatoria_admins boolean not null default false;

comment on column public.empresas.mfa_obligatoria_admins is
  'Con true, un administrador sin verificación en dos pasos no usa la app hasta activarla (ver pantallaBloqueadaPorMfa en la app). Apagado por defecto.';
