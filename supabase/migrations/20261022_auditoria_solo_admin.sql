-- Auditoría: solo la leen administradores de la empresa (Joel, 22/10/2026).
--
-- auditoria_select dejaba leer la auditoría de la empresa a cualquier persona con sesión, también a
-- los operadores: 15.299 filas en Escondida, con lo que cambió en usuarios, materiales y la empresa.
-- Y la cuenta del visitante de la demo pública (cualquiera desde internet) leía las 11.503 de la Demo.
-- La app ya la muestra solo a administradores y súper admin (Configuraciones -> Auditoría); ahora la
-- base dice lo mismo. Sigue acotada a la propia empresa (el súper admin ve solo la suya, ver CLAUDE.md).
-- Los triggers que la escriben y la purga nocturna son SECURITY DEFINER: no cambian.
-- Verificado antes de aplicar, en una transacción revertida: admin y súper admin de Escondida 15.299
-- filas antes y después, admin de Agunsa 17 y 17; operador de Escondida 15.299 -> 0; visitante de la
-- demo 11.503 -> 0.

set local lock_timeout = '5s';

alter policy auditoria_select on public.auditoria
  using ((empresa_id = ( select public.empresa_actual() as empresa_actual))
         and (( select public.es_admin_actual() as es_admin_actual) or ( select public.es_super_admin() as es_super_admin)));
