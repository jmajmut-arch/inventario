#!/usr/bin/env bash
# Respaldo completo de InventIA en una carpeta con fecha: base de datos (esquema + datos +
# usuarios de Auth + registro de Storage), las fotos del bucket privado y el código de las Edge
# Functions. Se corre desde tu computador; Supabase no lo hace por ti (los respaldos automáticos
# del plan Pro cubren solo la base, no las fotos, y no se pueden bajar como archivo).
#
# Uso:  docs/respaldo/respaldo.sh [carpeta_destino]
#       (por omisión ~/InventIA-respaldos)
# Necesita: pg_dump y psql (paquete libpq / Postgres.app), curl y jq. Ver README.md al lado.
# Credenciales: en docs/respaldo/.env (copiar de .env.ejemplo). Ese archivo NUNCA va al repo.
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$AQUI/../.." && pwd)"
DESTINO_BASE="${1:-$HOME/InventIA-respaldos}"

# ---- credenciales ----
if [ ! -f "$AQUI/.env" ]; then
  echo "Falta $AQUI/.env — copia .env.ejemplo a .env y completa DB_URL y SERVICE_ROLE_KEY." >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; . "$AQUI/.env"; set +a
: "${DB_URL:?DB_URL no definido en .env}"
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY no definido en .env}"
SUPABASE_URL="${SUPABASE_URL:-https://ncvwgsbcvklhbyvurxzz.supabase.co}"
BUCKET="${BUCKET:-fotos-inventario}"

for herramienta in pg_dump psql curl jq; do
  command -v "$herramienta" >/dev/null 2>&1 || { echo "Falta $herramienta (ver README.md)." >&2; exit 1; }
done

FECHA="$(date +%Y-%m-%d_%H%M)"
DESTINO="$DESTINO_BASE/$FECHA"
mkdir -p "$DESTINO/fotos" "$DESTINO/funciones"
echo "Respaldo en $DESTINO"

# ---- 1. Base de datos ----
# Formato custom (-Fc): comprimido y restaurable por partes con pg_restore. Van todos los esquemas
# que contienen datos de la empresa: public (materiales, conteos, bodega...), auth (las cuentas y
# sus contraseñas cifradas), storage (el registro de qué fotos existen) y cron (las tareas).
# Se dumpea CON permisos y CON dueños a propósito: los GRANT a anon/authenticated y los REVOKE
# a public son parte de la seguridad, no ruido. Lo que sobre se descarta al restaurar
# (pg_restore --no-owner --no-privileges), pero lo que no se dumpea no se recupera nunca.
echo "1/5  base de datos (completa, formato pg_restore)…"
pg_dump "$DB_URL" -Fc \
  -n public -n auth -n storage -n cron -n extensions \
  -f "$DESTINO/base.dump"
# Y el esquema en texto plano, para poder leerlo (funciones, políticas RLS, vistas, triggers,
# grants) sin restaurar nada.
echo "2/5  esquema en texto (para leer)…"
pg_dump "$DB_URL" --schema-only -n public -f "$DESTINO/esquema-public.sql"
pg_restore --list "$DESTINO/base.dump" | grep -c "TABLE DATA" | sed 's/^/     tablas con datos: /'

# ---- 1b. Parámetros de rol y configuración que pg_dump NO incluye ----
# pg_dump nunca dumpea los `alter role ... set ...`: son objetos del cluster, no de la base. Acá
# viven el statement_timeout de 20 s y el work_mem de 16MB de `authenticator`, que es el rol con
# el que se conecta PostgREST (ver CLAUDE.md). Restaurar sin esto deja la base "funcionando" pero
# con los límites por omisión, y las pantallas grandes de Escondida empiezan a cortarse.
echo "3/5  parámetros de rol, buckets y políticas de Storage…"
{
  echo "-- Parámetros por rol al $(date +%Y-%m-%d). Aplicar como postgres después de restaurar."
  echo "-- session_preload_libraries y el search_path de postgres son de Supabase: ya vienen puestos"
  echo "-- en un proyecto nuevo. Los timeouts, el lock_timeout y el work_mem son de este proyecto."
  psql "$DB_URL" -At -c "select format('alter role %I set %s = %L;', r.rolname, split_part(cfg, '=', 1), substr(cfg, strpos(cfg, '=') + 1)) from pg_roles r, unnest(r.rolconfig) as cfg where r.rolname in ('anon','authenticated','authenticator','service_role','postgres') order by r.rolname, cfg"
} > "$DESTINO/roles-y-parametros.sql"
# El bucket y sus políticas: el dump los trae, pero en un proyecto nuevo storage.objects ya existe
# y esa parte del restore se salta. Tenerlas en texto evita reconstruirlas de memoria.
{
  echo "-- Buckets"
  psql "$DB_URL" -c "select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id"
  echo "-- Políticas RLS sobre storage.objects"
  psql "$DB_URL" -c "select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'storage' order by policyname"
} > "$DESTINO/storage-politicas.txt" 2>&1

# ---- 2. Fotos ----
# La lista sale de la base (storage.objects), que es la fuente de verdad; cada archivo se baja
# con la service key, que ve todo el bucket sin pasar por RLS.
echo "4/5  fotos del bucket $BUCKET…"
psql "$DB_URL" -At -c "select name from storage.objects where bucket_id = '$BUCKET' order by name" > "$DESTINO/fotos/_lista.txt"
TOTAL=$(wc -l < "$DESTINO/fotos/_lista.txt" | tr -d ' ')
N=0; FALLIDAS=0
while IFS= read -r ruta; do
  [ -z "$ruta" ] && continue
  N=$((N+1))
  mkdir -p "$DESTINO/fotos/$(dirname "$ruta")"
  if ! curl -fsS --retry 3 -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "apikey: $SERVICE_ROLE_KEY" \
       -o "$DESTINO/fotos/$ruta" "$SUPABASE_URL/storage/v1/object/$BUCKET/$ruta"; then
    FALLIDAS=$((FALLIDAS+1)); echo "     no se pudo bajar: $ruta" >&2
  fi
  if [ $((N % 25)) -eq 0 ]; then echo "     $N de $TOTAL"; fi
done < "$DESTINO/fotos/_lista.txt"
echo "     $N fotos, $FALLIDAS fallidas"

# ---- 3. Edge Functions ----
# La copia versionada vive en el repo (supabase/functions); se incluye para que el respaldo sea
# autocontenido. Si tienes la CLI y sesión, se bajan además las desplegadas de verdad.
echo "5/5  edge functions…"
cp -R "$REPO/supabase/functions/." "$DESTINO/funciones/"
# `supabase functions download` escribe en ./supabase/functions/ del directorio actual: se corre
# dentro de una carpeta del respaldo para que nunca pise la copia versionada del repo.
if command -v supabase >/dev/null 2>&1; then
  mkdir -p "$DESTINO/funciones-desplegadas"
  for f in "$REPO"/supabase/functions/*/; do
    slug="$(basename "$f")"
    (cd "$DESTINO/funciones-desplegadas" && supabase functions download "$slug" \
       --project-ref "${PROJECT_REF:-ncvwgsbcvklhbyvurxzz}" >/dev/null 2>&1) \
      && echo "     $slug (desplegada) bajada" || true
  done
fi

# ---- 4. Resumen ----
{
  echo "InventIA — respaldo $FECHA"
  echo "base.dump: $(du -h "$DESTINO/base.dump" | cut -f1)"
  echo "fotos: $N ($FALLIDAS fallidas), $(du -sh "$DESTINO/fotos" | cut -f1)"
  echo "funciones: $(ls "$DESTINO/funciones" | wc -l | tr -d ' ')"
  echo "parámetros de rol: $(grep -c '^alter role' "$DESTINO/roles-y-parametros.sql" || true) sentencias"
  echo "commit del repo: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo
  echo "NO incluido (no vive en la base): claves de Flow, SMTP de Brevo, plantillas de correo,"
  echo "OTP/MFA y demás configuración de Auth. Ver docs/RUNBOOK-RECUPERACION.md §8.2."
} | tee "$DESTINO/RESUMEN.txt"

tar -czf "$DESTINO_BASE/inventia-$FECHA.tar.gz" -C "$DESTINO_BASE" "$FECHA"
echo "Listo: $DESTINO_BASE/inventia-$FECHA.tar.gz — guárdalo fuera de este computador (Drive, disco externo)."
