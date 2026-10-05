# Edge Functions (Deno) — la copia versionada

Desde el 13-09-2026 el código de las Edge Functions vive **acá**, en el repo, y no solo en
Supabase. Antes se editaba y desplegaba directo por MCP/CLI y la única copia era la del
proyecto: si se perdía el proyecto, se perdían las funciones (lo advertía el
[runbook](../../docs/RUNBOOK-RECUPERACION.md), §5).

**Regla desde ahora:** cualquier cambio a una función se hace en este directorio y se
despliega desde acá. Si se edita en el dashboard de Supabase, hay que traer el cambio al
repo en el mismo momento (`get_edge_function` por MCP, o *Edge Functions → la función →
Code* en el dashboard).

## Las funciones

| Función | `verify_jwt` | Quién la llama | Variables de entorno propias |
|---|---|---|---|
| `invite-user` | sí | Frontend (admin o súper admin) | — |
| `crear-empresa-autoservicio` | **no** | Landing (público, sin login) | — |
| `flow-iniciar-suscripcion` | sí | Frontend (admin) | `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV` |
| `flow-registro-callback` | **no** | Flow.cl (servidor a servidor) | `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV` |
| `flow-webhook-cobro` | **no** | Flow.cl (cada intento de cobro). Flow manda solo `{token}`: la suscripción sale de `payment/getStatus` → `commerceOrder` (`sus_xxx_<factura>_<fecha>`), medido en el cobro real del 03-10-2026 | `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV` |
| `flow-cancelar-suscripcion` | sí | Frontend (admin) | `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV` |
| `flow-cambiar-plan` | sí | Frontend (admin con suscripción activa) | `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV` |
| `flow-sincronizar-suscripcion` | sí | Frontend (cualquier usuario activo, al iniciar sesión) | `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV` |
| `notificar-lead` | sí (basta el anon key) | Trigger `trg_notificar_lead_demo` de la base, por pg_net, al insertarse un lead del sitio | `BREVO_API_KEY`; opcional `NOTIFICAR_LEADS_A` (destino, por omisión contacto@inventiapp.cl) |
| `flow-tarea-unica` | sí | Nadie: **inerte** (responde 410). Se usó una vez el 05-10-2026 para cancelar la suscripción de prueba de $500 de Minera Test y leer la forma real del cobro de Flow. Se puede borrar desde el dashboard | `FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV` |
| `seguimiento-lead` | sí (basta el anon key) | Cron `seguimiento-leads-horario` de la base (`enviar_seguimientos_leads`, por pg_net): correo de seguimiento al lead de demo a las 24 h (paso 1) y 3 días después (paso 2), con copia oculta a contacto@inventiapp.cl | `BREVO_API_KEY` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` las inyecta Supabase sola.
`BREVO_API_KEY` es una API key de la misma cuenta de Brevo que manda las invitaciones de Auth
(Brevo → SMTP & API → API keys); `notificar-lead` manda el aviso de cada lead desde
`contacto@inventiapp.cl` con la API transaccional de Brevo. El trigger que la llama está en
`supabase/migrations/20260927_notificar_lead_demo.sql`.
Las de Flow se ponen una vez en *Edge Functions → Secrets* (o `supabase secrets set`), con
`FLOW_ENV=production`; **nunca en el repo**.

Versiones desplegadas al momento de copiar: `invite-user` v23, `flow-iniciar-suscripcion`
v16, `flow-registro-callback` v15, `flow-webhook-cobro` v15, `flow-cancelar-suscripcion` v8,
`crear-empresa-autoservicio` v8, `flow-cambiar-plan` v4, `flow-sincronizar-suscripcion` v1.
Copiadas byte por byte desde el proyecto `ncvwgsbcvklhbyvurxzz` (`get_edge_function`).

## Desplegar

Con la CLI de Supabase (`npm i -g supabase` o `brew install supabase/tap/supabase`) y
`supabase login` hecho:

```sh
# Las que validan el JWT (por omisión):
supabase functions deploy invite-user --project-ref ncvwgsbcvklhbyvurxzz
supabase functions deploy notificar-lead --project-ref ncvwgsbcvklhbyvurxzz
supabase functions deploy seguimiento-lead --project-ref ncvwgsbcvklhbyvurxzz
# Las tres que reciben llamadas sin sesión (landing y Flow) van sin verificación:
supabase functions deploy crear-empresa-autoservicio --project-ref ncvwgsbcvklhbyvurxzz --no-verify-jwt
supabase functions deploy flow-registro-callback    --project-ref ncvwgsbcvklhbyvurxzz --no-verify-jwt
supabase functions deploy flow-webhook-cobro        --project-ref ncvwgsbcvklhbyvurxzz --no-verify-jwt
```

`--no-verify-jwt` importa: `flow-registro-callback` y `flow-webhook-cobro` los llama Flow.cl
sin ninguna sesión de Supabase, y `crear-empresa-autoservicio` la llama el landing antes de
que exista la cuenta. Desplegadas con verificación, dejan de funcionar sin avisar en el
dashboard (Flow recibe un 401 y la suscripción nunca se activa).

## Cómo se prueban

No hay pruebas automáticas de las funciones (corren en Deno, fuera del harness de la app).
Lo que sí prueba `tests/app.test.js` es cómo la app las llama y qué hace con cada respuesta
(`invitarPersona`, `iniciarSuscripcionFlow`, `sincronizarSuscripcionFlow`, etc.). Un cambio
de contrato —un campo nuevo en la respuesta, un código de error distinto— se prueba ahí.
