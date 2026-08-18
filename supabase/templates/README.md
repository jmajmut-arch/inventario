# Plantillas de correo (Supabase Auth)

InventIA usa Supabase Auth para enviar correos de acceso. Hoy el único correo
que la app dispara es el de **"Reset your password"** (`recovery.html`):

- La Edge Function `invite-user` crea la cuenta y llama a
  `resetPasswordForEmail()` para que la persona invitada defina su contraseña.
- El botón "Olvidé mi contraseña" del login llama a la misma función.

Ambos flujos usan la plantilla de recuperación de Supabase, así que
`recovery.html` cubre los dos casos con un texto neutro ("crea o restablece
tu contraseña").

## Cómo aplicarla

No existe una API/CLI conectada a este proyecto para subir la plantilla
automáticamente: hay que pegarla a mano en el panel de Supabase.

1. Entra al [Dashboard del proyecto](https://supabase.com/dashboard/project/ncvwgsbcvklhbyvurxzz/auth/templates).
2. Abre la pestaña **Reset Password**.
3. En **Subject heading** escribe: `Accede a tu cuenta de InventIA`.
4. Copia el contenido de `recovery.html` y pégalo en el editor de **Message body (HTML)**.
5. Guarda los cambios y usa el botón "Send test email" para revisarla.

## Nombre del remitente ("de InventIA")

El HTML ya trae el logo y el nombre "InventIA", pero el remitente del correo
(el "From") lo define el servidor SMTP, no la plantilla. Con el SMTP gratuito
que trae Supabase por defecto:

- Solo entrega correos a direcciones del equipo del proyecto (Team de la
  organización) — no sirve para usuarios reales.
- El nombre del remitente no se puede personalizar de forma confiable.

Para que los correos lleguen a cualquier usuario y digan "InventIA" como
remitente, hay que configurar un **SMTP propio** en
`Authentication → Settings → SMTP Settings`, con un proveedor como Resend,
Brevo o Postmark (todos tienen plan gratuito para este volumen), y poner
`Sender name: InventIA`. Este paso requiere crear una cuenta en el proveedor
elegido, así que queda a criterio del usuario del proyecto.
