# Inventario — Toma Física con Respaldo Fotográfico

Aplicación web (una sola página, `app/index.html` / `app/inventario.html`) conectada a una base de datos [Supabase](https://supabase.com) real, con el landing comercial en `index.html` (raíz). Permite:

- **Cargar SKU** uno por uno o de forma masiva (CSV exportado de SAP).
- **Carga masiva de respaldo** (nuevo corte de stock del sistema) para comparar contra el conteo físico.
- **Tomar inventario** en terreno: buscar SKU, ingresar cantidad contada, ubicación, observación y **foto de respaldo** (cámara del celular o archivo).
- **Dashboard** de avance global, por bodega, y por período (diario, semanal, mensual), con detalle de diferencias.
- Múltiples usuarios simultáneos vía login (correo/contraseña), cada uno con su rol (`admin`, `supervisor`, `contador`).

No requiere instalar nada ni levantar un servidor propio: es un archivo HTML estático que habla directo con Supabase (Auth + Postgres REST + Storage) usando la llave pública `anon` (protegida por Row Level Security).

## Uso

1. Abre `app/index.html` en un navegador (celular o computador), o publica todo el repo en cualquier hosting estático (ver abajo) — quedará en `/app/`.
2. La primera vez, crea tu cuenta con "Regístrate" (nombre, correo, contraseña). Tu perfil se crea automáticamente en la base de datos.
3. Pestaña **SKUs**: agrega materiales manualmente.
4. Pestaña **Carga**: sube un CSV masivo de SKU o de respaldo de stock.
5. Pestaña **Contar**: busca el SKU, ingresa la cantidad contada y adjunta una foto.
6. Pestaña **Dashboard**: revisa el avance global, por bodega y por período.

### Formato del CSV de carga masiva

Acepta directamente el maestro de materiales exportado de SAP, con columnas:

`Material, Material Description, Plant Name, Storage Location, Description of Storage Location, Unrestricted Stock`

También acepta el formato simple: `sku_code, descripcion, categoria, unidad_medida, ubicacion, bodega, stock_sistema`.

- **Carga de SKU**: crea o actualiza (upsert) el material completo.
- **Carga de respaldo**: solo actualiza `stock_sistema` de los SKU existentes (para comparar contra el conteo físico), sin tocar descripción/ubicación.

Cada carga queda registrada en `cargas_masivas` (archivo, filas totales/ok/error, detalle de errores) para trazabilidad.

## Base de datos (Supabase)

Proyecto: `inventario-toma-fisica` (región `sa-east-1`).

Tablas principales:

- `usuarios` — perfil de cada usuario (vinculado a `auth.users`), con rol.
- `skus` — maestro de materiales.
- `conteos` — cada conteo físico registrado (cantidad, ubicación, bodega, foto, observación, diferencia vs. stock sistema, estado).
- `cargas_masivas` — historial de cargas CSV.

Vistas para el dashboard: `avance_total`, `avance_diario`, `avance_semanal`, `avance_mensual`.

Fotos de respaldo: bucket de Storage `fotos-inventario` (lectura pública, escritura solo para usuarios autenticados).

Seguridad: Row Level Security habilitado en todas las tablas — solo usuarios autenticados pueden leer/escribir datos operativos; cada usuario solo puede modificar su propio perfil.

## Publicar la app en la web

Como es un archivo estático, puedes publicarlo en minutos con cualquiera de estas opciones:

- **GitHub Pages**: Settings → Pages → Deploy from branch → selecciona la rama y `/ (root)`. El landing queda en `https://<usuario>.github.io/inventario/` y la app en `.../app/`.
- **Netlify / Vercel**: arrastra la carpeta o conecta el repo; no requiere build.
- Cualquier hosting estático (S3, Cloudflare Pages, etc.).

No hay backend propio que desplegar: toda la lógica de servidor vive en Supabase.
