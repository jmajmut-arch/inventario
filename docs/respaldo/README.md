# Respaldo de InventIA

La app tiene cuatro piezas y cada una se respalda distinto:

| Pieza | Dónde vive | Cómo se respalda |
|---|---|---|
| Código, manuales, runbook | GitHub, rama `main` | Solo: GitHub guarda todo el historial. Un `git clone` en tu computador es la segunda copia. |
| Base de datos (materiales, conteos, usuarios, empresas, funciones, RLS, tareas) | Supabase | `respaldo.sh` (abajo). Además, en el plan Pro Supabase guarda respaldos diarios (*Database → Backups*); en Free no hay ninguno. |
| Fotos de conteos y guías | Bucket privado `fotos-inventario` | `respaldo.sh` las baja todas. Los respaldos de Supabase **no** las incluyen. |
| Edge Functions (invitaciones, alta autoservicio, cobros) | Supabase, y desde el 13-09-2026 también en `supabase/functions/` del repo | Versionadas en git; `respaldo.sh` las copia al respaldo. |

Cada corrida deja: `base.dump` (la base completa, con permisos y dueños), `esquema-public.sql`
(legible, sin restaurar nada), `roles-y-parametros.sql`, `storage-politicas.txt`, `fotos/`,
`funciones/` y `RESUMEN.txt`.

## Lo que el respaldo NO cubre

Vale la pena saberlo de memoria, porque es la diferencia entre "restauré" y "restauré y funciona":

- **Las claves**: Flow, el SMTP de Brevo, Sentry. No están en ninguna parte del respaldo, a
  propósito. Se recuperan entrando a cada proveedor.
- **La configuración de Auth**: plantillas de correo, OTP, MFA, sesión única, protección de
  contraseñas filtradas. No vive en la base de datos sino en el panel de Supabase; está descrita
  en el [runbook](../RUNBOOK-RECUPERACION.md) §8.2 y hay que volver a ponerla a mano.
- **El dominio**: se recupera desde el registrador.

Lo que **sí** se cubre y es fácil pasar por alto: los `alter role` con el `statement_timeout` y el
`work_mem` de `authenticator` van en `roles-y-parametros.sql`, porque `pg_dump` no los incluye
(son del cluster, no de la base). Sin ellos la base restaurada anda, pero con los límites por
omisión, y las pantallas grandes empiezan a cortarse.

## Correr el respaldo

Una vez, en tu computador (macOS o Linux; en Windows, dentro de WSL):

```sh
# macOS
brew install libpq jq && brew link --force libpq
# Debian/Ubuntu
sudo apt install postgresql-client jq
cp docs/respaldo/.env.ejemplo docs/respaldo/.env   # y completar DB_URL y SERVICE_ROLE_KEY
```

Cada vez (una por semana está bien; después de una carga masiva, también):

```sh
docs/respaldo/respaldo.sh
```

Deja una carpeta con fecha en `~/InventIA-respaldos/` y un `.tar.gz` al lado. **Guarda el
`.tar.gz` fuera del computador** (Google Drive, disco externo): un respaldo que vive en la misma
máquina que se puede perder no es respaldo. Tarda un par de minutos (la base pesa ~130 MB sin
comprimir; las fotos, ~70 MB).

El `.env` tiene la contraseña de la base y la service key: no lo copies a ningún lado y no lo
subas (está en `.gitignore`).

## Restaurar

Sirve para dos cosas distintas:

**Recuperar un dato puntual** (alguien borró materiales, se quiere ver cómo estaba una tabla
hace una semana): restaurar el `.dump` en una base local o en un proyecto Supabase de prueba y
consultar ahí. Nunca sobre producción.

```sh
pg_restore --list base.dump | less                                            # qué trae
pg_restore -d "$DB_LOCAL" --no-owner --no-privileges -n public -t skus base.dump   # una tabla
```

El dump guarda dueños y permisos a propósito; se descartan al restaurar (`--no-owner
--no-privileges`) cuando estorban. Al revés no se puede: lo que no se guardó no aparece después.

**Reconstruir todo en un proyecto Supabase nuevo** (se perdió el proyecto): seguir el
[runbook §10.2](../RUNBOOK-RECUPERACION.md) paso a paso. El `base.dump` es el "backup
reciente" que ese procedimiento da por supuesto; las fotos se vuelven a subir al bucket con
la misma ruta (`<empresa_id>/...`), y las funciones se despliegan desde `supabase/functions/`
(ver su README). Los esquemas `auth` y `storage` de un proyecto nuevo ya existen: de ahí se
restauran solo los datos (`--data-only -n auth -t users -t identities`, `-n storage -t objects`),
no la estructura.

Después de restaurar en un proyecto nuevo, aplicar `roles-y-parametros.sql` como `postgres` y
revisar `storage-politicas.txt` contra las políticas del bucket nuevo.

Antes de dar por buena cualquier restauración: `node tests/app.test.js` y las e2e contra el
proyecto restaurado, y una entrada real a la app con un usuario de cada rol.
