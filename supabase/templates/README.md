# Plantillas de correo (Supabase Auth)

InventIA usa Supabase Auth para enviar dos correos de acceso, cada uno con su
propia plantilla:

- **Invitar a un usuario nuevo** (`invite.html`): la Edge Function
  `invite-user` crea la cuenta con `admin.inviteUserByEmail()`, que dispara
  el correo de tipo **Invite user** de Supabase. El texto le da la bienvenida
  ("Te invitaron a InventIA") en vez de sonar a recuperación de contraseña.
- **Olvidé mi contraseña** (`recovery.html`): el botón del login llama a
  `resetPasswordForEmail()`, que dispara el correo de tipo **Reset Password**.

Antes ambos flujos compartían la plantilla de recuperación con un texto
neutro; ahora cada uno tiene su propio mensaje.

## Cómo aplicarlas

No existe una API/CLI conectada a este proyecto para subir las plantillas
automáticamente: hay que pegarlas a mano en el panel de Supabase.

1. Entra al [Dashboard del proyecto](https://supabase.com/dashboard/project/ncvwgsbcvklhbyvurxzz/auth/templates).
2. Abre la pestaña **Invite user**.
   - En **Subject heading** escribe: `Te invitaron a InventIA`.
   - Copia el contenido de `invite.html` y pégalo en el editor de **Message body (HTML)**.
3. Abre la pestaña **Reset Password**.
   - En **Subject heading** escribe: `Accede a tu cuenta de InventIA`.
   - Copia el contenido de `recovery.html` y pégalo en el editor de **Message body (HTML)**.
4. Guarda los cambios en cada pestaña y usa el botón "Send test email" para revisarlas.

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
