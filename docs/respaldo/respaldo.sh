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
echo "1/4  base de datos (completa, formato pg_restore)…"
pg_dump "$DB_URL" -Fc --no-owner --no-privileges \
  -n public -n auth -n storage -n cron -n extensions \
  -f "$DESTINO/base.dump"
# Y el esquema en texto plano, para poder leerlo (funciones, políticas RLS, vistas, triggers)
# sin restaurar nada.
echo "2/4  esquema en texto (para leer)…"
pg_dump "$DB_URL" --schema-only --no-owner --no-privileges -n public -f "$DESTINO/esquema-public.sql"
pg_restore --list "$DESTINO/base.dump" | grep -c "TABLE DATA" | sed 's/^/     tablas con datos: /'

# ---- 2. Fotos ----
# La lista sale de la base (storage.objects), que es la fuente de verdad; cada archivo se baja
# con la service key, que ve todo el bucket sin pasar por RLS.
echo "3/4  fotos del bucket $BUCKET…"
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
echo "4/4  edge functions…"
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
  echo "commit del repo: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')"
} | tee "$DESTINO/RESUMEN.txt"

tar -czf "$DESTINO_BASE/inventia-$FECHA.tar.gz" -C "$DESTINO_BASE" "$FECHA"
echo "Listo: $DESTINO_BASE/inventia-$FECHA.tar.gz — guárdalo fuera de este computador (Drive, disco externo)."
