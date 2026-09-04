# Runbook de recuperación — InventIA

> **Qué es este documento:** una fotografía técnica completa del sistema InventIA
> (base de datos, backend, frontend, integraciones y configuración operativa) más
> los pasos para reconstruirlo desde cero si se pierde el acceso a cualquier
> pieza — el repositorio, el proyecto Supabase, el dominio, o todo junto.
>
> **Para quién es:** para un Claude Code (u otra persona técnica) que parte sin
> memoria de este proyecto y necesita restablecer el sistema con el mínimo de
> preguntas posible. Está escrito para ser accionable, no solo descriptivo.
>
> **Cómo mantenerlo al día:** este documento se queda desactualizado apenas
> cambie el esquema de la base de datos, se agregue/quite una Edge Function, o
> cambie una integración externa. No hay automatización que lo actualice solo —
> hay que revisarlo a mano cuando se toque algo de esta lista. La fuente de
> verdad siempre es el sistema vivo (Supabase, GitHub, los dashboards de cada
> integración); este documento es la mejor aproximación al momento de
> escribirlo, no un dump 1:1 garantizado.
>
> **Última actualización:** 4 de septiembre de 2026, a partir del estado real
> del proyecto Supabase `ncvwgsbcvklhbyvurxzz` (169 migraciones aplicadas) y del
> repositorio `jmajmut-arch/inventario` en `main`.

---

## 1. Resumen ejecutivo (una página)

**InventIA** es una app de conteo de inventario físico para minería/industria,
vendida por suscripción (Básico/Profesional/Empresa) a múltiples empresas
clientas (multi-tenant) sobre un solo backend compartido.

**No hay servidor propio.** Todo el "backend" es:

- **Supabase** (proyecto `inventario-toma-fisica`, `ncvwgsbcvklhbyvurxzz`,
  región `sa-east-1`, Postgres 17): base de datos + Auth + Storage + Edge
  Functions (Deno). Aislamiento entre empresas 100% a nivel de RLS
  (`empresa_actual()`), no de esquema ni de proyecto.
- **Dos archivos HTML estáticos** que hablan directo con Supabase desde el
  navegador, usando la llave pública `anon` (protegida por RLS, nunca la
  `service_role`):
  - `app/index.html` (+ su espejo idéntico `app/inventario.html`) — la
    aplicación real que usan los clientes.
  - `index.html` (raíz del repo) — el landing comercial público.
- **GitHub Pages** sirve ambos archivos directo desde el repo, sin build, bajo
  el dominio propio **inventiapp.cl** (vía `CNAME`).
- **Flow.cl** (pasarela de pago chilena) cobra la suscripción recurrente
  mensual vía 6 Edge Functions dedicadas.
- **Brevo** manda los correos de acceso (invitación, recuperar contraseña) vía
  SMTP configurado en Supabase Auth.
- **Sentry** (proyecto `inventia` en sentry.io) captura errores de JS en
  producción.
- **Google Analytics 4 + Google Tag Manager** solo en el landing (marketing).

**Lo único verdaderamente irrecuperable si se pierde sin backup es la base de
datos de Supabase** (los datos de los clientes: SKU, conteos, fotos, usuarios).
Todo lo demás — el código, el esquema, las Edge Functions, el landing — está en
este repo o se puede reconstruir siguiendo este documento.

---

## 2. Dónde vive cada cosa (inventario de servicios)

| Pieza | Dónde | Identificador | Notas |
|---|---|---|---|
| Código fuente | GitHub | `jmajmut-arch/inventario`, rama `main` | Repo público de código; sin backend propio que desplegar. |
| Hosting del sitio | GitHub Pages | Settings → Pages del repo | Sirve el repo completo tal cual (root), sin build step. |
| Dominio | Registrador del dominio (fuera de GitHub/Supabase) | `inventiapp.cl` | DNS apunta a GitHub Pages; `CNAME` en la raíz del repo lo declara. Ver §9. |
| Base de datos + Auth + Storage + Edge Functions | Supabase | proyecto `ncvwgsbcvklhbyvurxzz` (`inventario-toma-fisica`), org `ynliapaucpwyclgmbfdc` | Región `sa-east-1`. Hay un segundo proyecto Supabase en la misma cuenta (`pdakngzwlfdxoqsqmfal`, us-east-2, "jmajmut-arch's Project") que **no se usa** — es el proyecto por defecto de la cuenta, no tocarlo. |
| Pagos recurrentes | Flow.cl | comercio propio, cuenta de Joel | Producción (no sandbox) desde PR #97. Ver §7. |
| Correo saliente (Auth) | Brevo (SMTP) | cuenta de Brevo de Joel | Configurado en Supabase Auth → Settings → SMTP Settings. Ver §8.1. |
| Monitoreo de errores | Sentry | org/proyecto `inventia`, https://inventia.sentry.io | Loader JS: `3a8602b248fccf0a627d6af0f6e5161d`. |
| Analítica del landing | Google Analytics 4 + GTM | GA4: `G-G5WNMGTXSH` · GTM: `GTM-5RH88HLL` | Solo en `index.html` (landing), no en la app. |
| CI | GitHub Actions | `.github/workflows/tests.yml`, `loadtest.yml` | Corre en cada push/PR a `main`. |
| WhatsApp de contacto | — | +56 9 6837 2524 | Botón flotante del landing. |
| Correo de contacto | — | contacto@inventiapp.cl | Vía Brevo. |

### Credenciales y secretos — dónde viven, no qué valen

Este documento **nunca** contiene un secreto real (service role key, claves de
Flow, contraseña SMTP, tokens de Sentry/GitHub). Si se pierde el acceso a
cualquiera de estos, hay que regenerarlo desde el dashboard del servicio
correspondiente — no existe una copia de respaldo de secretos en ningún lado.

| Secreto | Dónde se genera/regenera | Dónde se usa |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API | Env var de las 8 Edge Functions (automática, Supabase la inyecta sola) y secreto de repo `SUPABASE_SERVICE_ROLE_KEY` en GitHub Actions (solo para `loadtest.yml`). |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API | **No es secreta** — está hardcodeada en `app/index.html`, `app/inventario.html` y `loadtest.yml`. Protegida por RLS, no por ocultarla. |
| `FLOW_API_KEY` / `FLOW_SECRET_KEY` | Panel de comercio de Flow.cl | Env vars de las Edge Functions `flow-*` (Supabase Dashboard → Edge Functions → Secrets, o `supabase secrets set`). |
| SMTP de Brevo (usuario/contraseña) | Panel de Brevo → SMTP & API | Supabase Dashboard → Authentication → Settings → SMTP Settings. |
| Sentry (si se necesita un auth token para la API, no el loader público) | sentry.io → Settings → Auth Tokens | Solo si se automatiza algo con la API de Sentry; el loader JS (`3a86...`) no es secreto, es público por diseño. |
| Credenciales de GitHub (para push/PR) | GitHub → Settings → Developer settings | Sesión de Claude Code / `gh` CLI / git remoto. |

---

## 3. Repositorio de código

```
.
├── app/
│   ├── index.html        # LA APP — SPA completa (~7700 líneas), habla directo con Supabase
│   ├── inventario.html   # Espejo BYTE-A-BYTE de index.html (ver nota abajo)
│   ├── manifest.json     # PWA
│   └── sw.js             # Service worker (cache de shell + assets)
├── index.html             # Landing comercial (marketing, no requiere login)
├── privacidad.html, terminos.html, reembolsos.html
├── docs/                  # PDFs de referencia (manuales, ficha de producto) + este runbook
├── icons/                 # Íconos PWA
├── img/                   # Imágenes del landing (screenshots, fotos)
├── supabase/templates/    # HTML de los correos de Supabase Auth (se pegan a mano en el dashboard)
├── loadtest/               # Script k6 de prueba de carga + su workflow dedicado
├── tests/
│   ├── app.test.js        # Tests unitarios/lógica de app/index.html (Node, sin browser)
│   └── e2e.test.js        # Tests end-to-end con Playwright real
├── .github/workflows/
│   ├── tests.yml           # CI: corre en cada push/PR a main
│   └── loadtest.yml        # Prueba de carga k6, manual (workflow_dispatch)
├── CNAME                   # "inventiapp.cl" — dominio custom de GitHub Pages
├── robots.txt, sitemap.xml
└── package.json             # Solo devDependency: playwright. No hay build.
```

**Regla crítica del código:** `app/index.html` y `app/inventario.html` deben
ser **idénticos byte a byte** siempre. Es un espejo manual — cada cambio a uno
se copia al otro antes de commitear (`diff app/index.html app/inventario.html`
debe devolver vacío). Existe por una razón histórica de compatibilidad de URL,
no se sabe de una forma de eliminarlo sin investigar primero por qué se
mantiene.

**Convención de ramas:** todo el desarrollo entra por PR a `main` desde una
rama de trabajo (en las sesiones de Claude Code, típicamente
`claude/inventory-web-app-dashboard-*`), nunca commits directos a `main`. El
CI (`app-tests` + `e2e-tests`) debe estar en verde antes de mergear.

---

## 4. Base de datos — Supabase (`ncvwgsbcvklhbyvurxzz`)

### 4.1 Cómo reconstruir el esquema desde cero

**No hay un único script `schema.sql`** — el esquema es el resultado acumulado
de 169 migraciones (`supabase/migrations`, ver `list_migrations` del proyecto o
`supabase migration list` con la CLI). Para reconstruir el proyecto desde cero,
**no** hay que replayear las 169 migraciones una por una (varias fueron
correcciones o reversiones de otras, p. ej. `denormaliza_ultimo_conteo...` fue
revertida al día siguiente) — lo correcto es:

1. Crear un proyecto Supabase nuevo (Postgres 17, región `sa-east-1` para
   mantener latencia baja con Chile).
2. Usar `pg_dump --schema-only` (o el botón de backup/restore del dashboard de
   Supabase) contra el proyecto vivo **antes** de que se pierda, para tener un
   dump real. Si eso no es posible (el proyecto ya se perdió sin backup), usar
   las secciones 4.2–4.9 de este documento para reconstruir el esquema a mano
   — están completas (tablas, RLS, funciones críticas, triggers, vistas,
   cron), pero no cubren cada vista al 100% carácter por carácter.
3. Restaurar los datos desde el backup más reciente de Supabase (backups
   automáticos diarios, retención según plan — verificar en Dashboard →
   Database → Backups) o desde un `pg_dump` propio si existe uno más nuevo.

### 4.2 Tablas (schema `public`)

Multi-tenant: casi todas cuelgan de `empresa_id → empresas.id`. RLS habilitado
en las 14 tablas.

| Tabla | Filas (§ verif.) | Para qué | Columnas propias notables |
|---|---|---|---|
| `empresas` | tenant raíz | | `codigo_invitacion` (auto), `plan_id → planes`, `flow_customer_id`, `flow_subscription_id`, `flow_subscription_status` (`pendiente_tarjeta`\|`activa`\|`morosa`\|`cancelada`), `conteo_ciego_habilitado` |
| `usuarios` | perfil de cada persona | vinculada 1:1 a `auth.users` por `auth_user_id` | `rol` (`admin`\|`operador`, CHECK), `es_super_admin` (bool, aparte del rol de empresa), `activo` |
| `skus` | maestro de materiales | 65k+ filas en producción | identidad = `(empresa_id, sku_code, bodega, batch, ubicacion, storage_bin)`; columnas `ultimo_conteo_*` denormalizadas para ordenar rápido; `clase_abc`/`pct_acumulado` (materializados por cron); `stock_bloqueado/transito_1/transito_2/transferencia` (contexto SAP opcional); `stock_sistema_anterior` + `stock_sistema_actualizado_en` (huella para Reconteo) |
| `conteos` | cada conteo físico registrado | | `estado` (`pendiente_revision`\|`aprobado`\|`con_diferencia`), `fuera_de_plan`, `ciclo_id`, `idempotency_key` (evita duplicar un guardado reintentado) |
| `conteo_fotos` | fotos de respaldo (N por conteo) | | `foto_url` apunta al bucket privado `fotos-inventario` |
| `cargas_masivas` | historial de cada carga Excel/CSV | | `tipo` (`skus`\|`stock_sistema`\|`otro`), `detalle_errores` (jsonb) |
| `plan_semanal` | planificación de conteo por día/bodega/ubicación/bin | | `responsable_id → usuarios`, `ciclo_id`, `solo_sin_ubicacion` |
| `plan_semanal_skus` | snapshot de qué SKU tenía cada entrada de plan al crearse | usado para detectar SKU "movidos" de bodega/bin después de planificar | `bodega_original`, `ubicacion_original`, `storage_bin_original` |
| `plan_semanal_exclusiones` | SKU excluidos a mano de una entrada de plan | | |
| `responsables_proceso` | "responsables" de planificación, opcionalmente vinculados a una cuenta real | | `usuario_id → usuarios` (nullable) |
| `ciclos_conteo` | períodos de conteo (ej. "T1 2027") | | `es_actual` (bool, atómico vía `marcar_ciclo_actual()`) |
| `planes` | catálogo de planes de suscripción | ver §11 para los valores reales | `flow_plan_id` (referencia al Plan creado en el dashboard de Flow) |
| `flow_eventos` | log crudo de todo lo que pasa con Flow (registro de tarjeta, cobros) | | `tipo` (`registro_tarjeta`\|`cobro_suscripcion`), `payload` jsonb |
| `leads_demo` | leads del formulario del landing ("pedir demo" / "contacto") | | `tipo` (`demo`\|`contacto`) |
| `auditoria` | trazabilidad de cambios (quién cambió qué) | se purga automático a 14 días (cron) | `tabla` (`usuarios`\|`empresas`\|`conteos`\|`skus`), `accion`, `datos_antes`/`datos_despues` jsonb |

### 4.3 Funciones de seguridad (el corazón del multi-tenant)

Todas `STABLE SECURITY DEFINER SET search_path TO 'public'` salvo que se
indique. Son la base de **todas** las políticas RLS de §4.4 — sin estas
funciones, ninguna política tiene sentido.

```sql
-- Empresa del usuario logueado, o NULL si no tiene una empresa activa/al día.
-- Esta función es la que BLOQUEA el acceso de una empresa morosa o
-- pendiente_tarjeta: deja de ver TODO (skus, conteos, etc.) sin necesitar
-- un flag aparte en cada tabla.
CREATE OR REPLACE FUNCTION public.empresa_actual()
 RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select u.empresa_id
  from public.usuarios u
  join public.empresas e on e.id = u.empresa_id
  where u.auth_user_id = auth.uid()
    and u.activo = true
    and e.activo = true
    and e.flow_subscription_status is distinct from 'morosa'
    and e.flow_subscription_status is distinct from 'pendiente_tarjeta'
$function$;

CREATE OR REPLACE FUNCTION public.es_admin_actual()
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce((select rol = 'admin' from public.usuarios where auth_user_id = auth.uid() and activo = true), false)
$function$;

CREATE OR REPLACE FUNCTION public.es_super_admin()
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce((select es_super_admin from public.usuarios where auth_user_id = auth.uid()), false)
$function$;

-- Conteo ciego: true solo si el operador pertenece a una empresa con el
-- interruptor activo. Un admin NUNCA queda oculto, aunque el interruptor
-- esté prendido.
CREATE OR REPLACE FUNCTION public.debe_ocultar_stock_operador()
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select coalesce(
    (select u.rol = 'operador' and e.conteo_ciego_habilitado
     from public.usuarios u
     join public.empresas e on e.id = u.empresa_id
     where u.auth_user_id = auth.uid() and u.activo = true),
    false
  );
$function$;

-- Crea automáticamente la fila en public.usuarios cuando se crea un
-- auth.users -- SOLO si raw_app_meta_data trae empresa_id (lo pone
-- crear-empresa-autoservicio o invite-user al crear la cuenta). Si no,
-- no crea nada -- no hay alta autoservicio "libre" sin empresa.
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_empresa_id uuid := (new.raw_app_meta_data->>'empresa_id')::uuid;
  v_rol text := coalesce(new.raw_app_meta_data->>'rol', 'operador');
  v_nombre text := coalesce(new.raw_user_meta_data->>'nombre', split_part(new.email, '@', 1));
begin
  if v_empresa_id is not null
     and exists (select 1 from public.empresas where id = v_empresa_id and activo = true) then
    insert into public.usuarios (auth_user_id, nombre, rol, empresa_id)
    values (new.id, v_nombre, v_rol, v_empresa_id)
    on conflict do nothing;
  end if;
  return new;
end;
$function$;
-- Trigger: AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Bloqueo real de empresa inactiva/morosa/pendiente_tarjeta/vencida: usada
-- por el frontend para mostrar la pantalla de bloqueo con el motivo exacto.
CREATE OR REPLACE FUNCTION public.mi_estado_bloqueo()
 RETURNS TABLE(bloqueada boolean, motivo text, empresa_nombre text, plan_nombre text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select
    (not e.activo or e.flow_subscription_status in ('morosa','pendiente_tarjeta','vencida')) as bloqueada,
    case
      when not e.activo then 'inactiva'
      when e.flow_subscription_status = 'morosa' then 'morosa'
      when e.flow_subscription_status = 'pendiente_tarjeta' then 'pendiente_tarjeta'
      when e.flow_subscription_status = 'vencida' then 'vencida'
      else null
    end as motivo,
    e.nombre as empresa_nombre,
    p.nombre as plan_nombre
  from public.usuarios u
  join public.empresas e on e.id = u.empresa_id
  left join public.planes p on p.id = e.plan_id
  where u.auth_user_id = auth.uid() and u.activo = true
$function$;

CREATE OR REPLACE FUNCTION public.plan_actual()
 RETURNS TABLE(nombre text, etiqueta text, max_bodegas integer, max_usuarios integer, offline_habilitado boolean, dashboard_ejecutivo_habilitado boolean, auditoria_habilitada boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select p.nombre, p.etiqueta, p.max_bodegas, p.max_usuarios, p.offline_habilitado, p.dashboard_ejecutivo_habilitado, p.auditoria_habilitada
  from public.planes p
  join public.empresas e on e.plan_id = p.id
  where e.id = public.empresa_actual()
$function$;

-- Trigger BEFORE UPDATE ON usuarios: nadie (ni un admin de empresa) puede
-- promoverse a sí mismo o a otro a 'admin' -- solo un super-admin.
CREATE OR REPLACE FUNCTION public.prevenir_escalada_admin()
 RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if new.rol = 'admin' and old.rol is distinct from 'admin' and not es_super_admin() then
    raise exception 'Solo un super-admin puede asignar el rol de administrador';
  end if;
  return new;
end;
$function$;
```

Otras 27 funciones/RPC (no reproducidas aquí carácter por carácter — usar
`pg_get_functiondef` contra el proyecto vivo, o el historial de migraciones,
si se necesita el cuerpo exacto): `asignar_ciclo_conteo`,
`asignar_ciclo_plan_semanal`, `auto_confirmar_email_pruebas`,
`calcular_diferencia_conteo`, `chequear_limite_bodegas`,
`chequear_limite_usuarios`, `ciclo_actual`, `contar_busqueda_skus`,
`diferencias_recientes`, `eliminar_skus_sin_contar`, `id_plan_basico`,
`limitar_leads_demo`, `marcar_ciclo_actual`, `purgar_auditoria_antigua`,
`ranking_responsable`, `refrescar_clasificacion_abc`, `registrar_auditoria`,
`registrar_auditoria_skus_masivo`, `registrar_stock_sistema_anterior`,
`resetear_demo_inventia`, `resumen_empresas_super_admin`,
`resumen_general_skus`, `sincronizar_ultimo_conteo_sku`,
`tengo_otra_sesion_activa`, `veces_contado_periodo`,
`vencer_suscripciones_canceladas`, `verificar_conteo_atipico`.

### 4.4 Políticas RLS (por tabla, resumen del patrón)

El patrón dominante en casi toda tabla operativa (`skus`, `conteos`,
`plan_semanal`, `cargas_masivas`, `ciclos_conteo`, `responsables_proceso`,
`plan_semanal_skus`, `plan_semanal_exclusiones`) es:

```sql
-- SELECT/INSERT/UPDATE para 'authenticated', acotado siempre a empresa_actual()
create policy auth_read_X on public.X for select to authenticated
  using (empresa_id = empresa_actual());
create policy auth_write_X on public.X for insert to authenticated
  with check (empresa_id = empresa_actual());
create policy auth_update_X on public.X for update to authenticated
  using (empresa_id = empresa_actual()) with check (empresa_id = empresa_actual());
```

Excepciones y casos especiales (política exacta):

- **`empresas`**: `read_empresas` = `(id = empresa_actual() OR es_super_admin())`;
  `update_empresas` exige ser admin de esa empresa O super-admin;
  `super_admin_insert_empresas`/`super_admin_delete_empresas` solo
  `es_super_admin()`.
- **`usuarios`**: `read_usuarios` igual que empresas; `update_usuarios` exige
  `(empresa_id=empresa_actual() AND es_admin_actual()) OR es_super_admin()`;
  alta/baja de usuarios (INSERT/DELETE) solo `es_super_admin()` — un admin de
  empresa invita gente vía la Edge Function `invite-user` (`service_role`, no
  RLS directo).
- **`skus`**: DELETE solo si `es_admin_actual()` (un operador nunca borra
  maestro).
- **`planes`**: lectura abierta a cualquier `authenticated`; escritura solo
  `es_super_admin()`.
- **`leads_demo`**: INSERT abierto a `anon` Y `authenticated` (el formulario
  del landing no requiere login); lectura solo `es_super_admin()`.
- **`flow_eventos`**: lectura solo `es_super_admin()` (nadie más debe ver el
  log crudo de pagos).
- **`auditoria`**: lectura si `es_super_admin() OR empresa_id=empresa_actual()`
  (el frontend igual la esconde detrás del flag de plan `auditoria_habilitada`).
- **`conteo_fotos`**: no tiene `empresa_id` propio — la política hace `EXISTS`
  contra `conteos` para heredar el aislamiento.
- **`plan_semanal_skus` / `plan_semanal_exclusiones`**: igual, heredan el
  aislamiento vía `EXISTS` contra `plan_semanal`.

El texto SQL exacto y completo de las ~35 políticas está en §4.4-anexo más
abajo si se necesita reconstruir letra por letra sin volver a consultar el
proyecto vivo.

<details>
<summary>§4.4-anexo — políticas RLS completas (SQL literal)</summary>

```sql
-- auditoria
create policy auditoria_select on public.auditoria for select
  using (es_super_admin() OR (empresa_id = empresa_actual()));

-- cargas_masivas
create policy auth_all_cargas on public.cargas_masivas for all to authenticated
  using (empresa_id = empresa_actual()) with check (empresa_id = empresa_actual());

-- ciclos_conteo
create policy admin_update_ciclos_conteo on public.ciclos_conteo for update
  using ((empresa_id = empresa_actual()) AND es_admin_actual())
  with check ((empresa_id = empresa_actual()) AND es_admin_actual());
create policy admin_write_ciclos_conteo on public.ciclos_conteo for insert
  with check ((empresa_id = empresa_actual()) AND es_admin_actual());
create policy auth_read_ciclos_conteo on public.ciclos_conteo for select
  using (empresa_id = empresa_actual());

-- conteo_fotos
create policy auth_read_conteo_fotos on public.conteo_fotos for select to authenticated
  using (EXISTS (SELECT 1 FROM conteos c WHERE c.id = conteo_fotos.conteo_id AND c.empresa_id = empresa_actual()));
create policy auth_write_conteo_fotos on public.conteo_fotos for insert to authenticated
  with check (EXISTS (SELECT 1 FROM conteos c WHERE c.id = conteo_fotos.conteo_id AND c.empresa_id = empresa_actual()));

-- conteos
create policy auth_read_conteos on public.conteos for select to authenticated
  using (empresa_id = empresa_actual());
create policy auth_update_conteos on public.conteos for update to authenticated
  using (empresa_id = empresa_actual());
create policy auth_write_conteos on public.conteos for insert to authenticated
  with check (empresa_id = empresa_actual());

-- empresas
create policy read_empresas on public.empresas for select to authenticated
  using ((id = empresa_actual()) OR es_super_admin());
create policy super_admin_delete_empresas on public.empresas for delete to authenticated
  using (es_super_admin());
create policy super_admin_insert_empresas on public.empresas for insert to authenticated
  with check (es_super_admin());
create policy update_empresas on public.empresas for update to authenticated
  using (((id = empresa_actual()) AND (EXISTS (SELECT 1 FROM usuarios WHERE usuarios.auth_user_id = auth.uid() AND usuarios.rol = 'admin'))) OR es_super_admin())
  with check ((id = empresa_actual()) OR es_super_admin());

-- flow_eventos
create policy "solo super-admin lee los eventos de flow" on public.flow_eventos for select
  using (es_super_admin());

-- leads_demo
create policy "cualquiera puede dejar un lead" on public.leads_demo for insert to anon, authenticated
  with check (true);
create policy "solo super-admin lee los leads" on public.leads_demo for select to authenticated
  using (es_super_admin());

-- plan_semanal
create policy auth_delete_plan_semanal on public.plan_semanal for delete to authenticated
  using (empresa_id = empresa_actual());
create policy auth_read_plan_semanal on public.plan_semanal for select to authenticated
  using (empresa_id = empresa_actual());
create policy auth_update_plan_semanal on public.plan_semanal for update to authenticated
  using (empresa_id = empresa_actual()) with check (empresa_id = empresa_actual());
create policy auth_write_plan_semanal on public.plan_semanal for insert to authenticated
  with check (empresa_id = empresa_actual());

-- plan_semanal_exclusiones
create policy auth_delete_plan_semanal_exclusiones on public.plan_semanal_exclusiones for delete to authenticated
  using (EXISTS (SELECT 1 FROM plan_semanal p WHERE p.id = plan_semanal_exclusiones.plan_id AND p.empresa_id = empresa_actual()));
create policy auth_insert_plan_semanal_exclusiones on public.plan_semanal_exclusiones for insert to authenticated
  with check (EXISTS (SELECT 1 FROM plan_semanal p WHERE p.id = plan_semanal_exclusiones.plan_id AND p.empresa_id = empresa_actual()));
create policy auth_read_plan_semanal_exclusiones on public.plan_semanal_exclusiones for select to authenticated
  using (EXISTS (SELECT 1 FROM plan_semanal p WHERE p.id = plan_semanal_exclusiones.plan_id AND p.empresa_id = empresa_actual()));

-- plan_semanal_skus
create policy auth_delete on public.plan_semanal_skus for delete to authenticated
  using (EXISTS (SELECT 1 FROM plan_semanal p WHERE p.id = plan_semanal_skus.plan_id AND p.empresa_id = empresa_actual()));
create policy auth_insert on public.plan_semanal_skus for insert to authenticated
  with check (EXISTS (SELECT 1 FROM plan_semanal p WHERE p.id = plan_semanal_skus.plan_id AND p.empresa_id = empresa_actual()));
create policy auth_read on public.plan_semanal_skus for select to authenticated
  using (EXISTS (SELECT 1 FROM plan_semanal p WHERE p.id = plan_semanal_skus.plan_id AND p.empresa_id = empresa_actual()));

-- planes
create policy super_admin_delete_planes on public.planes for delete to authenticated using (es_super_admin());
create policy super_admin_insert_planes on public.planes for insert to authenticated with check (es_super_admin());
create policy super_admin_update_planes on public.planes for update to authenticated using (es_super_admin()) with check (es_super_admin());
create policy "usuarios autenticados leen los planes" on public.planes for select to authenticated using (true);

-- responsables_proceso
create policy auth_insert_responsables_proceso on public.responsables_proceso for insert to authenticated
  with check (empresa_id = empresa_actual());
create policy auth_read_responsables_proceso on public.responsables_proceso for select to authenticated
  using (empresa_id = empresa_actual());
create policy auth_update_responsables_proceso on public.responsables_proceso for update to authenticated
  using (empresa_id = empresa_actual());

-- skus
create policy admin_delete_skus on public.skus for delete
  using ((empresa_id = empresa_actual()) AND es_admin_actual());
create policy auth_read_skus on public.skus for select to authenticated
  using (empresa_id = empresa_actual());
create policy auth_update_skus on public.skus for update to authenticated
  using (empresa_id = empresa_actual()) with check (empresa_id = empresa_actual());
create policy auth_write_skus on public.skus for insert to authenticated
  with check (empresa_id = empresa_actual());

-- usuarios
create policy read_usuarios on public.usuarios for select to authenticated
  using ((empresa_id = empresa_actual()) OR es_super_admin());
create policy super_admin_delete_usuarios on public.usuarios for delete to authenticated
  using (es_super_admin());
create policy super_admin_insert_usuarios on public.usuarios for insert to authenticated
  with check (es_super_admin());
create policy update_usuarios on public.usuarios for update
  using (((empresa_id = empresa_actual()) AND es_admin_actual()) OR es_super_admin())
  with check (((empresa_id = empresa_actual()) AND es_admin_actual()) OR es_super_admin());
```

</details>

### 4.5 Vistas (24)

Usadas por el frontend para lecturas ya armadas (evita lógica de negocio
duplicada en JS y aprovecha índices). La mayoría son `security_invoker` (así
respetan RLS del usuario que consulta, no del dueño de la vista):

`avance_diario`, `avance_mensual`, `avance_plan_por_ciclo`, `avance_semanal`,
`avance_total`, `batches_sku`, `categorias_sku`, `conteos_exportables`,
`exactitud_mensual`, `exactitud_por_bodega`, `plan_semanal_detalle`,
`reconteo_pendiente`, `skus_busqueda`, `skus_disponibles_planificar`,
`skus_lectura`, `skus_planificables`, `skus_resumen_abc`, `skus_valor_abc`,
`ubicaciones_bins`, `ubicaciones_especificas`, `ubicaciones_generales`,
`ultimo_conteo_por_sku`, `unidades_medida_sku`, `valorizacion_diferencias`.

Si se necesita el `CREATE VIEW` exacto de alguna, se reconstruye desde el
historial de migraciones (nombradas descriptivamente, ej.
`crear_vista_avance_plan_por_ciclo`) o consultando
`information_schema.views` / `pg_get_viewdef()` contra el proyecto vivo.

### 4.6 Triggers

| Trigger | Tabla | Qué hace |
|---|---|---|
| `auditoria_conteos`, `auditoria_empresas`, `auditoria_usuarios` | `conteos`, `empresas`, `usuarios` | Llama `registrar_auditoria()` por fila |
| `auditoria_skus_insert`/`update`/`delete` | `skus` | Llama `registrar_auditoria_skus_masivo()` **por sentencia**, no por fila (evita explotar en cargas masivas de miles de filas) |
| `trg_asignar_ciclo_conteo` | `conteos` | Etiqueta el conteo con `ciclo_actual()` al insertar |
| `trg_asignar_ciclo_plan_semanal` | `plan_semanal` | Ídem, para el plan |
| `trg_calcular_diferencia` | `conteos` | Calcula `diferencia` = cantidad contada − stock sistema |
| `trg_limitar_leads_demo` | `leads_demo` | Anti-spam (rate limit) |
| `trg_limite_bodegas` / `trg_limite_usuarios` | `skus` / `usuarios` | Enforcement de plan a nivel de BD (no solo UI) — un `INSERT` que excede el límite del plan falla con excepción |
| `trg_prevenir_escalada_admin` | `usuarios` | Ver `prevenir_escalada_admin()` arriba |
| `trg_registrar_stock_sistema_anterior` | `skus` | Guarda la huella "antes → ahora" cuando cambia `stock_sistema` (para Reconteo) |
| `trg_sincronizar_ultimo_conteo_sku` | `conteos` | Denormaliza `ultimo_conteo_*` en `skus` para ordenar rápido sin JOIN |

### 4.7 Extensiones

`pg_cron 1.6.4`, `pg_stat_statements 1.11`, `pgcrypto 1.3`,
`supabase_vault 0.3.1`, `uuid-ossp 1.1`, `pg_net 0.20.4`.

> ⚠️ `pg_net` está instalado en el schema `public` (debería estar en su propio
> schema — advertencia de seguridad conocida y aceptada, ver migración
> `instalar_pg_net_temporal_para_llamar_flow_test`; no se ha limpiado porque no
> representa un riesgo real distinto al de tenerlo en cualquier otro schema).

### 4.8 Cron jobs (`pg_cron`)

| Job | Horario (UTC) | Qué hace |
|---|---|---|
| `reset-demo-inventia-nocturno` | `0 8 * * *` | `select resetear_demo_inventia();` — resetea la empresa demo pública cada noche |
| `vencer-suscripciones-canceladas` | `0 7 * * *` | `select vencer_suscripciones_canceladas();` — pasados 31 días desde el último cobro confirmado, marca `vencida` y bloquea acceso igual que `morosa` |
| `refrescar-clasificacion-abc-nocturno` | `0 7 * * *` | `refresh materialized view concurrently privado.skus_valor_abc_mv` |
| `purga-auditoria-14-dias` | `0 6 * * *` | `select purgar_auditoria_antigua();` — borra auditoría de más de 14 días (evita bloat) |

### 4.9 Storage

Un solo bucket: **`fotos-inventario`** — `public: false`, límite `20 MB` por
archivo, MIME permitidos: `image/jpeg`, `image/png`, `image/webp`,
`image/heic`, `image/heif`. Acceso vía URLs firmadas y temporales (nunca URL
pública fija), RLS de Storage acotada por `empresa_id` en el path del archivo.

---

## 5. Edge Functions (Deno, `supabase/functions/`)

No hay carpeta local `supabase/functions/` en el repo — el código de las Edge
Functions vive **solo en Supabase** (se editó/desplegó directo vía MCP/CLI en
esta sesión, nunca se versionó en git). Si se pierde el proyecto Supabase, el
código de abajo es la única copia. **Recomendación de mantenimiento:** bajar
estas 8 funciones a `supabase/functions/` en el repo la próxima vez que se
toque cualquiera, para que queden versionadas de verdad.

Todas comparten patrón: CORS abierto (`Access-Control-Allow-Origin: *`),
`createClient` de `jsr:@supabase/supabase-js@2`, y separan un "cliente anon"
(solo para validar el JWT del usuario que llama) de un "cliente
`service_role`" (para las escrituras reales, bypaseando RLS a propósito bajo
sus propios chequeos de autorización en código).

| Función | `verify_jwt` | Quién la llama | Para qué |
|---|---|---|---|
| `invite-user` | true | Frontend (admin o super-admin logueado) | Invita a alguien nuevo por correo (`admin.inviteUserByEmail`), crea su fila en `usuarios`. Valida: admin de empresa solo invita a su propia empresa y solo como `operador`; crear otro `admin` requiere super-admin. Hace rollback de la cuenta Auth si falla el insert en `usuarios` (evita cuentas huérfanas). |
| `crear-empresa-autoservicio` | **false** | Landing (público, sin login) | Alta autoservicio: crea `empresas` (`pendiente_tarjeta`) + el usuario admin, en una secuencia con rollback si falla cualquier paso. Rate-limit: máx. 8 empresas `pendiente_tarjeta` creadas en los últimos 10 min. |
| `flow-iniciar-suscripcion` | true | Frontend (admin logueado) | Crea/reusa el `customerId` de Flow para la empresa, pide la URL de registro de tarjeta, guarda un evento pendiente en `flow_eventos` con el plan elegido. |
| `flow-registro-callback` | **false** | Flow.cl (servidor a servidor) | **Nunca confía en su propio POST** — vuelve a preguntarle a Flow (firmado) el estado real del registro de tarjeta antes de activar nada. Crea la suscripción y activa la empresa. |
| `flow-webhook-cobro` | **false** | Flow.cl (servidor a servidor, en cada intento de cobro) | Guarda el payload crudo primero (nunca se pierde el dato), resuelve `subscriptionId` (directo o vía `invoiceId`), y marca `morosa` solo cuando Flow reporta `subscription.morose=1` (ya agotó sus propios reintentos), no en el primer fallo. |
| `flow-cancelar-suscripcion` | true | Frontend (admin logueado) | Cancela `at_period_end=1` (sigue con acceso hasta que termine lo pagado). |
| `flow-cambiar-plan` | true | Frontend (admin logueado, con suscripción `activa`) | Cambia Básico↔Profesional sin volver a registrar tarjeta: cancela la suscripción vieja `at_period_end=0` y crea la nueva sobre el mismo `customerId`. |
| `flow-test-registro-500` | true | — | **Función de prueba/debug, no forma parte del flujo real.** Segura de borrar si se quiere limpiar el proyecto; no reproducirla al restaurar desde cero. |

**Variables de entorno que cada función necesita** (Supabase las inyecta solas
para `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY`; las de
Flow hay que configurarlas a mano):

```
FLOW_API_KEY, FLOW_SECRET_KEY, FLOW_ENV=production
```

(las 6 funciones `flow-*` las necesitan; `invite-user` y
`crear-empresa-autoservicio` no).

<details>
<summary>Código completo de cada función (TypeScript/Deno)</summary>

#### `invite-user`

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// La app vive en /app/ (la raíz del dominio es el landing de marketing) — el link del
// correo debe volver ahí para que el SPA procese el token del fragmento (#access_token=...).
const SITE_URL = 'https://inventiapp.cl/app/';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const ROLES_VALIDOS = ['admin', 'operador'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Falta autenticación' }, 401);

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: 'Sesión inválida' }, 401);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: perfil, error: perfilError } = await serviceClient
    .from('usuarios')
    .select('es_super_admin, rol, empresa_id, activo')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (perfilError) return json({ error: perfilError.message }, 500);
  if (!perfil || !perfil.activo) return json({ error: 'No autorizado' }, 403);

  const esSuperAdmin = !!perfil.es_super_admin;
  const esAdminDeEmpresa = perfil.rol === 'admin';
  if (!esSuperAdmin && !esAdminDeEmpresa) return json({ error: 'No autorizado' }, 403);

  let body: { email?: string; nombre?: string; empresaId?: string; rol?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Cuerpo inválido' }, 400);
  }
  const email = (body.email || '').trim().toLowerCase();
  const nombre = (body.nombre || '').trim();
  const empresaId = (body.empresaId || '').trim();
  const rol = (body.rol || '').trim();

  if (!email || !nombre || !empresaId) return json({ error: 'Faltan datos: correo, nombre y empresa son obligatorios' }, 400);
  if (!ROLES_VALIDOS.includes(rol)) return json({ error: 'Rol inválido' }, 400);

  // Un admin de empresa (no super-admin) solo puede invitar dentro de su propia empresa,
  // y solo como operador: crear otros administradores es exclusivo del super-admin.
  if (!esSuperAdmin && empresaId !== perfil.empresa_id) return json({ error: 'Solo puedes invitar personas a tu propia empresa' }, 403);
  if (!esSuperAdmin && rol === 'admin') return json({ error: 'Solo un super-admin puede crear cuentas de administrador' }, 403);

  const { data: empresa, error: empresaError } = await serviceClient
    .from('empresas')
    .select('id, nombre, activo')
    .eq('id', empresaId)
    .maybeSingle();
  if (empresaError) return json({ error: empresaError.message }, 500);
  if (!empresa || !empresa.activo) return json({ error: 'Empresa inválida' }, 400);

  // inviteUserByEmail crea la cuenta y manda el correo en un solo paso, usando la plantilla
  // "Invite user" de Supabase (bienvenida) en vez de "Reset Password".
  const { data: createData, error: createError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: SITE_URL,
    data: { nombre },
  });
  if (createError || !createData.user) {
    const yaExiste = /already.*registered|already.*exists/i.test(createError?.message || '');
    return json({ error: yaExiste ? 'Ya existe una cuenta con ese correo' : (createError?.message || 'No se pudo crear la cuenta') }, yaExiste ? 409 : 500);
  }

  // No confiamos únicamente en el trigger handle_new_user: la creación del usuario puede
  // completar sin que el trigger deje lista la fila en public.usuarios a tiempo. La creamos
  // explícitamente acá, que es la fuente de verdad.
  const { error: usuarioError } = await serviceClient
    .from('usuarios')
    .upsert({ auth_user_id: createData.user.id, nombre, rol, empresa_id: empresaId }, { onConflict: 'auth_user_id' });
  if (usuarioError) {
    // No dejamos la cuenta de Auth huérfana (p.ej. si trg_limite_usuarios rechaza el insert
    // por límite de plan).
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(createData.user.id);
    if (deleteError) {
      return json({ error: `No se pudo crear la cuenta (${usuarioError.message}), y tampoco se pudo deshacer automáticamente: ${deleteError.message}. Contacta a soporte.` }, 500);
    }
    return json({ error: usuarioError.message }, 400);
  }

  return json({ ok: true, empresa: empresa.nombre });
});
```

#### `crear-empresa-autoservicio`

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const PLANES_AUTOSERVICIO = ['basico', 'profesional'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  let body: { nombreEmpresa?: string; nombreAdmin?: string; email?: string; password?: string; planNombre?: string };
  try { body = await req.json(); } catch { return json({ error: 'Cuerpo inválido' }, 400); }

  const nombreEmpresa = (body.nombreEmpresa || '').trim().slice(0, 120);
  const nombreAdmin = (body.nombreAdmin || '').trim().slice(0, 120);
  const email = (body.email || '').trim().toLowerCase().slice(0, 200);
  const password = body.password || '';
  const planNombre = (body.planNombre || '').trim();

  if (!nombreEmpresa || !nombreAdmin) return json({ error: 'Falta el nombre de la empresa o tu nombre' }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: 'Correo inválido' }, 400);
  if (password.length < 10) return json({ error: 'La contraseña debe tener al menos 10 caracteres' }, 400);
  if (!PLANES_AUTOSERVICIO.includes(planNombre)) return json({ error: 'Plan inválido' }, 400);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: plan, error: planError } = await serviceClient
    .from('planes')
    .select('id, flow_plan_id')
    .eq('nombre', planNombre)
    .maybeSingle();
  if (planError) return json({ error: planError.message }, 500);
  if (!plan || !plan.flow_plan_id) return json({ error: 'Este plan todavía no está disponible para alta autoservicio' }, 400);

  // Freno anti-abuso: nadie legítimo crea más de un puñado de empresas nuevas sin pagar en
  // pocos minutos. Solo cuenta empresas "pendiente_tarjeta".
  const { count: recientes, error: recientesError } = await serviceClient
    .from('empresas')
    .select('id', { count: 'exact', head: true })
    .eq('flow_subscription_status', 'pendiente_tarjeta')
    .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());
  if (recientesError) return json({ error: recientesError.message }, 500);
  if ((recientes || 0) >= 8) return json({ error: 'Demasiadas cuentas nuevas en poco tiempo. Intenta de nuevo en unos minutos.' }, 429);

  const { data: empresa, error: empresaError } = await serviceClient
    .from('empresas')
    .insert({ nombre: nombreEmpresa, plan_id: plan.id, flow_subscription_status: 'pendiente_tarjeta' })
    .select('id, nombre')
    .single();
  if (empresaError) return json({ error: empresaError.message }, 500);

  const { data: createData, error: createError } = await serviceClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nombre: nombreAdmin },
    app_metadata: { empresa_id: empresa.id, rol: 'admin' },
  });
  if (createError || !createData.user) {
    await serviceClient.from('empresas').delete().eq('id', empresa.id);
    const yaExiste = /already.*registered|already.*exists/i.test(createError?.message || '');
    return json({ error: yaExiste ? 'Ya existe una cuenta con ese correo' : (createError?.message || 'No se pudo crear la cuenta') }, yaExiste ? 409 : 500);
  }

  const { error: usuarioError } = await serviceClient
    .from('usuarios')
    .insert({ auth_user_id: createData.user.id, nombre: nombreAdmin, rol: 'admin', empresa_id: empresa.id });
  if (usuarioError) {
    await serviceClient.auth.admin.deleteUser(createData.user.id);
    await serviceClient.from('empresas').delete().eq('id', empresa.id);
    return json({ error: usuarioError.message }, 500);
  }

  return json({ ok: true, empresaId: empresa.id, empresaNombre: empresa.nombre });
});
```

#### `flow-iniciar-suscripcion`

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLOW_API_KEY = Deno.env.get('FLOW_API_KEY') || '';
const FLOW_SECRET_KEY = Deno.env.get('FLOW_SECRET_KEY') || '';
const FLOW_ENV = (Deno.env.get('FLOW_ENV') || 'sandbox').toLowerCase();
const FLOW_BASE_URL = FLOW_ENV === 'production' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// Firma de Flow: parámetros ordenados alfabéticamente, concatenados como nombre+valor
// (sin separadores), firmados con HMAC-SHA256 usando el secretKey del comercio.
async function firmarFlow(params: Record<string, string>): Promise<string> {
  const paraFirmar = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(FLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, encoder.encode(paraFirmar));
  return [...new Uint8Array(firma)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function flowRequest(method: 'GET' | 'POST', path: string, params: Record<string, string>) {
  const conApiKey = { apiKey: FLOW_API_KEY, ...params };
  const s = await firmarFlow(conApiKey);
  const todos = { ...conApiKey, s };
  const res = method === 'GET'
    ? await fetch(`${FLOW_BASE_URL}${path}?${new URLSearchParams(todos)}`)
    : await fetch(`${FLOW_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(todos).toString(),
      });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* respuesta no-JSON */ }
  if (!res.ok) throw new Error(data.message || `Error Flow (${path}): ${res.status}`);
  return data;
}

const PLANES_AUTOSERVICIO = ['basico', 'profesional'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
    return json({ error: 'Faltan credenciales de Flow configuradas en el servidor' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Falta autenticación' }, 401);

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: 'Sesión inválida' }, 401);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: perfil, error: perfilError } = await serviceClient
    .from('usuarios')
    .select('rol, empresa_id, activo')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (perfilError) return json({ error: perfilError.message }, 500);
  if (!perfil || !perfil.activo) return json({ error: 'No autorizado' }, 403);
  if (perfil.rol !== 'admin') return json({ error: 'Solo un administrador de la empresa puede gestionar la suscripción' }, 403);

  let body: { planNombre?: string };
  try { body = await req.json(); } catch { return json({ error: 'Cuerpo inválido' }, 400); }
  const planNombre = (body.planNombre || '').trim();
  if (!PLANES_AUTOSERVICIO.includes(planNombre)) return json({ error: 'Plan inválido' }, 400);

  const { data: plan, error: planError } = await serviceClient
    .from('planes')
    .select('id, flow_plan_id')
    .eq('nombre', planNombre)
    .maybeSingle();
  if (planError) return json({ error: planError.message }, 500);
  if (!plan || !plan.flow_plan_id) return json({ error: 'Este plan todavía no está disponible para suscripción automática' }, 400);

  const { data: empresa, error: empresaError } = await serviceClient
    .from('empresas')
    .select('id, nombre, flow_customer_id')
    .eq('id', perfil.empresa_id)
    .maybeSingle();
  if (empresaError) return json({ error: empresaError.message }, 500);
  if (!empresa) return json({ error: 'Empresa no encontrada' }, 404);

  try {
    let customerId = empresa.flow_customer_id;
    if (!customerId) {
      const emailParaFlow = authData.user.email || '';
      const cliente = await flowRequest('POST', '/customer/create', {
        name: empresa.nombre,
        email: emailParaFlow,
        externalId: empresa.id,
      });
      customerId = cliente.customerId;
      const { error: updError } = await serviceClient.from('empresas').update({ flow_customer_id: customerId }).eq('id', empresa.id);
      if (updError) return json({ error: updError.message }, 500);
    }

    const registro = await flowRequest('POST', '/customer/register', {
      customerId,
      url_return: `${SUPABASE_URL}/functions/v1/flow-registro-callback`,
    });

    // Guardamos qué plan quería esta empresa: el callback de Flow solo trae de vuelta el
    // token, así que lo dejamos acá para retomarlo cuando Flow confirme el registro de tarjeta.
    const { error: eventoError } = await serviceClient.from('flow_eventos').insert({
      empresa_id: empresa.id,
      tipo: 'registro_tarjeta',
      payload: { token: registro.token, plan_id: plan.id, flow_plan_id: plan.flow_plan_id },
    });
    if (eventoError) return json({ error: eventoError.message }, 500);

    return json({ url: `${registro.url}?token=${registro.token}` });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'No se pudo iniciar la suscripción con Flow' }, 502);
  }
});
```

#### `flow-registro-callback`

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLOW_API_KEY = Deno.env.get('FLOW_API_KEY')!;
const FLOW_SECRET_KEY = Deno.env.get('FLOW_SECRET_KEY')!;
const FLOW_ENV = (Deno.env.get('FLOW_ENV') || 'sandbox').toLowerCase();
const FLOW_BASE_URL = FLOW_ENV === 'production' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';
// La app vive en /app/ — hay que volver ahí, no a la raíz, para que procesarRetornoFlow()
// (app/index.html) vea el ?flow=ok/error.
const SITE_URL = 'https://inventiapp.cl/app/';

async function firmarFlow(params: Record<string, string>): Promise<string> {
  const paraFirmar = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(FLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, encoder.encode(paraFirmar));
  return [...new Uint8Array(firma)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function flowRequest(method: 'GET' | 'POST', path: string, params: Record<string, string>) {
  const conApiKey = { apiKey: FLOW_API_KEY, ...params };
  const s = await firmarFlow(conApiKey);
  const todos = { ...conApiKey, s };
  const res = method === 'GET'
    ? await fetch(`${FLOW_BASE_URL}${path}?${new URLSearchParams(todos)}`)
    : await fetch(`${FLOW_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(todos).toString(),
      });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Error Flow (${path}): ${res.status}`);
  return data;
}

// Flow llega acá SIN JWT de Supabase (es un servidor externo) — por eso verify_jwt: false.
// La seguridad no viene de confiar en este POST, sino de que volvemos a preguntarle a Flow
// (firmado con secretKey) qué pasó realmente con el token, antes de activar nada.
Deno.serve(async (req: Request) => {
  let token = '';
  try {
    if (req.method === 'POST') {
      const form = await req.formData();
      token = String(form.get('token') || '');
    } else {
      token = new URL(req.url).searchParams.get('token') || '';
    }
  } catch { /* cuerpo vacío o no parseable */ }

  if (!token) return Response.redirect(`${SITE_URL}?flow=error`, 302);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    const { data: pendiente } = await serviceClient
      .from('flow_eventos')
      .select('empresa_id, payload')
      .eq('tipo', 'registro_tarjeta')
      .filter('payload->>token', 'eq', token)
      .order('creado_en', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!pendiente) return Response.redirect(`${SITE_URL}?flow=error`, 302);

    const estado = await flowRequest('GET', '/customer/getRegisterStatus', { token });
    // RegisterResult.status: "1" registrado, "0" no registrado (confirmado en el spec de Flow).
    if (estado.status !== '1' || !estado.customerId) {
      await serviceClient.from('flow_eventos').insert({
        empresa_id: pendiente.empresa_id,
        tipo: 'registro_tarjeta',
        payload: { resultado: 'no_registrada', estado },
      });
      return Response.redirect(`${SITE_URL}?flow=error`, 302);
    }

    const payload = pendiente.payload as { plan_id?: string; flow_plan_id?: string };
    const suscripcion = await flowRequest('POST', '/subscription/create', {
      planId: payload.flow_plan_id || '',
      customerId: estado.customerId,
    });

    const { error: updError } = await serviceClient.from('empresas').update({
      flow_subscription_id: suscripcion.subscriptionId,
      flow_subscription_status: 'activa',
      plan_id: payload.plan_id,
    }).eq('id', pendiente.empresa_id);

    await serviceClient.from('flow_eventos').insert({
      empresa_id: pendiente.empresa_id,
      tipo: 'cobro_suscripcion',
      payload: { evento: 'suscripcion_creada', subscriptionId: suscripcion.subscriptionId },
    });

    if (updError) return Response.redirect(`${SITE_URL}?flow=error`, 302);
    return Response.redirect(`${SITE_URL}?flow=ok`, 302);
  } catch (e) {
    await serviceClient.from('flow_eventos').insert({
      empresa_id: null,
      tipo: 'registro_tarjeta',
      payload: { error: e instanceof Error ? e.message : String(e), token },
    });
    return Response.redirect(`${SITE_URL}?flow=error`, 302);
  }
});
```

#### `flow-webhook-cobro`

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLOW_API_KEY = Deno.env.get('FLOW_API_KEY') || '';
const FLOW_SECRET_KEY = Deno.env.get('FLOW_SECRET_KEY') || '';
const FLOW_ENV = (Deno.env.get('FLOW_ENV') || 'sandbox').toLowerCase();
const FLOW_BASE_URL = FLOW_ENV === 'production' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';

async function firmarFlow(params: Record<string, string>): Promise<string> {
  const paraFirmar = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(FLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, encoder.encode(paraFirmar));
  return [...new Uint8Array(firma)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function flowRequest(method: 'GET' | 'POST', path: string, params: Record<string, string>) {
  const conApiKey = { apiKey: FLOW_API_KEY, ...params };
  const s = await firmarFlow(conApiKey);
  const todos = { ...conApiKey, s };
  const res = method === 'GET'
    ? await fetch(`${FLOW_BASE_URL}${path}?${new URLSearchParams(todos)}`)
    : await fetch(`${FLOW_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(todos).toString(),
      });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* respuesta no-JSON */ }
  if (!res.ok) throw new Error(data.message || `Error Flow (${path}): ${res.status}`);
  return data;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// urlCallback configurado a nivel de Plan en Flow: se dispara en cada intento de cobro.
// Guardamos SIEMPRE el payload crudo primero (no perder el dato) y después resolvemos el
// subscriptionId para preguntarle a Flow el estado real. Usamos subscription.morose (no cada
// intento fallido individual) porque es la señal de que Flow ya agotó sus reintentos (3 por
// omisión) y sigue impaga — bloquear recién cuando Flow se da por vencido.
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let raw: Record<string, string> = {};
  try {
    const form = await req.formData();
    raw = Object.fromEntries(form.entries()) as Record<string, string>;
  } catch { /* cuerpo vacío o no parseable */ }

  await serviceClient.from('flow_eventos').insert({
    empresa_id: null,
    tipo: 'cobro_suscripcion',
    payload: { crudo: raw },
  });

  try {
    let subscriptionId = raw.subscriptionId || '';
    if (!subscriptionId && raw.invoiceId) {
      const invoice = await flowRequest('GET', '/invoice/get', { invoiceId: raw.invoiceId });
      subscriptionId = invoice.subscriptionId || '';
    }

    if (!subscriptionId) {
      await serviceClient.from('flow_eventos').insert({
        empresa_id: null,
        tipo: 'cobro_suscripcion',
        payload: { aviso: 'no se pudo resolver subscriptionId desde este callback (revisar payload crudo)', raw },
      });
      return json({ ok: true });
    }

    const { data: empresa } = await serviceClient
      .from('empresas')
      .select('id')
      .eq('flow_subscription_id', subscriptionId)
      .maybeSingle();

    if (!empresa) {
      await serviceClient.from('flow_eventos').insert({
        empresa_id: null,
        tipo: 'cobro_suscripcion',
        payload: { aviso: 'subscriptionId no coincide con ninguna empresa', subscriptionId },
      });
      return json({ ok: true });
    }

    const suscripcion = await flowRequest('GET', '/subscription/get', { subscriptionId });
    const nuevoEstado = Number(suscripcion.morose) === 1 ? 'morosa' : 'activa';

    await serviceClient.from('empresas').update({ flow_subscription_status: nuevoEstado }).eq('id', empresa.id);
    await serviceClient.from('flow_eventos').insert({
      empresa_id: empresa.id,
      tipo: 'cobro_suscripcion',
      payload: { subscriptionId, morose: suscripcion.morose, status: suscripcion.status, nuevoEstado },
    });
  } catch (e) {
    await serviceClient.from('flow_eventos').insert({
      empresa_id: null,
      tipo: 'cobro_suscripcion',
      payload: { error: e instanceof Error ? e.message : String(e), raw },
    });
  }

  return json({ ok: true });
});
```

#### `flow-cancelar-suscripcion`

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLOW_API_KEY = Deno.env.get('FLOW_API_KEY') || '';
const FLOW_SECRET_KEY = Deno.env.get('FLOW_SECRET_KEY') || '';
const FLOW_ENV = (Deno.env.get('FLOW_ENV') || 'sandbox').toLowerCase();
const FLOW_BASE_URL = FLOW_ENV === 'production' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function firmarFlow(params: Record<string, string>): Promise<string> {
  const paraFirmar = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(FLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, encoder.encode(paraFirmar));
  return [...new Uint8Array(firma)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function flowRequest(method: 'GET' | 'POST', path: string, params: Record<string, string>) {
  const conApiKey = { apiKey: FLOW_API_KEY, ...params };
  const s = await firmarFlow(conApiKey);
  const todos = { ...conApiKey, s };
  const res = method === 'GET'
    ? await fetch(`${FLOW_BASE_URL}${path}?${new URLSearchParams(todos)}`)
    : await fetch(`${FLOW_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(todos).toString(),
      });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* respuesta no-JSON */ }
  if (!res.ok) throw new Error(data.message || `Error Flow (${path}): ${res.status}`);
  return data;
}

// Cancela al término del período vigente (at_period_end=1), no de inmediato: la empresa ya
// pagó ese ciclo, sigue con acceso normal hasta que termine. Flow simplemente no vuelve a
// cobrar después. flow_subscription_status='cancelada' es solo informativo — no bloquea.
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
    return json({ error: 'Faltan credenciales de Flow configuradas en el servidor' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Falta autenticación' }, 401);

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: 'Sesión inválida' }, 401);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: perfil, error: perfilError } = await serviceClient
    .from('usuarios')
    .select('rol, empresa_id, activo')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (perfilError) return json({ error: perfilError.message }, 500);
  if (!perfil || !perfil.activo) return json({ error: 'No autorizado' }, 403);
  if (perfil.rol !== 'admin') return json({ error: 'Solo un administrador de la empresa puede cancelar la suscripción' }, 403);

  const { data: empresa, error: empresaError } = await serviceClient
    .from('empresas')
    .select('id, flow_subscription_id, flow_subscription_status')
    .eq('id', perfil.empresa_id)
    .maybeSingle();
  if (empresaError) return json({ error: empresaError.message }, 500);
  if (!empresa) return json({ error: 'Empresa no encontrada' }, 404);
  if (!empresa.flow_subscription_id) return json({ error: 'No tienes una suscripción activa para cancelar' }, 400);
  if (empresa.flow_subscription_status === 'cancelada') return json({ error: 'La suscripción ya estaba cancelada' }, 400);

  try {
    await flowRequest('POST', '/subscription/cancel', {
      subscriptionId: empresa.flow_subscription_id,
      at_period_end: '1',
    });

    const { error: updError } = await serviceClient.from('empresas')
      .update({ flow_subscription_status: 'cancelada' })
      .eq('id', empresa.id);
    if (updError) return json({ error: updError.message }, 500);

    await serviceClient.from('flow_eventos').insert({
      empresa_id: empresa.id,
      tipo: 'cobro_suscripcion',
      payload: { evento: 'suscripcion_cancelada', subscriptionId: empresa.flow_subscription_id },
    });

    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'No se pudo cancelar la suscripción' }, 502);
  }
});
```

#### `flow-cambiar-plan`

```ts
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLOW_API_KEY = Deno.env.get('FLOW_API_KEY') || '';
const FLOW_SECRET_KEY = Deno.env.get('FLOW_SECRET_KEY') || '';
const FLOW_ENV = (Deno.env.get('FLOW_ENV') || 'sandbox').toLowerCase();
const FLOW_BASE_URL = FLOW_ENV === 'production' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function firmarFlow(params: Record<string, string>): Promise<string> {
  const paraFirmar = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(FLOW_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const firma = await crypto.subtle.sign('HMAC', key, encoder.encode(paraFirmar));
  return [...new Uint8Array(firma)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function flowRequest(method: 'GET' | 'POST', path: string, params: Record<string, string>) {
  const conApiKey = { apiKey: FLOW_API_KEY, ...params };
  const s = await firmarFlow(conApiKey);
  const todos = { ...conApiKey, s };
  const res = method === 'GET'
    ? await fetch(`${FLOW_BASE_URL}${path}?${new URLSearchParams(todos)}`)
    : await fetch(`${FLOW_BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(todos).toString(),
      });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* respuesta no-JSON */ }
  if (!res.ok) throw new Error(data.message || `Error Flow (${path}): ${res.status}`);
  return data;
}

const PLANES_AUTOSERVICIO = ['basico', 'profesional'];

// Cambia de plan (Básico <-> Profesional) estando ya suscrito y con tarjeta ya registrada en
// Flow (customerId conocido) — NO redirige a Flow a registrar tarjeta de nuevo: cancela la
// suscripción vieja de inmediato (at_period_end=0, se está reemplazando ahora) y crea la
// nueva sobre el mismo customerId.
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) {
    return json({ error: 'Faltan credenciales de Flow configuradas en el servidor' }, 500);
  }

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Falta autenticación' }, 401);

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: 'Sesión inválida' }, 401);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: perfil, error: perfilError } = await serviceClient
    .from('usuarios')
    .select('rol, empresa_id, activo')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (perfilError) return json({ error: perfilError.message }, 500);
  if (!perfil || !perfil.activo) return json({ error: 'No autorizado' }, 403);
  if (perfil.rol !== 'admin') return json({ error: 'Solo un administrador de la empresa puede cambiar el plan' }, 403);

  let body: { planNombre?: string };
  try { body = await req.json(); } catch { return json({ error: 'Cuerpo inválido' }, 400); }
  const planNombre = (body.planNombre || '').trim();
  if (!PLANES_AUTOSERVICIO.includes(planNombre)) return json({ error: 'Plan inválido' }, 400);

  const { data: nuevoPlan, error: planError } = await serviceClient
    .from('planes')
    .select('id, nombre, flow_plan_id')
    .eq('nombre', planNombre)
    .maybeSingle();
  if (planError) return json({ error: planError.message }, 500);
  if (!nuevoPlan || !nuevoPlan.flow_plan_id) return json({ error: 'Este plan todavía no está disponible para suscripción automática' }, 400);

  const { data: empresa, error: empresaError } = await serviceClient
    .from('empresas')
    .select('id, flow_customer_id, flow_subscription_id, flow_subscription_status, plan_id, planes(nombre)')
    .eq('id', perfil.empresa_id)
    .maybeSingle();
  if (empresaError) return json({ error: empresaError.message }, 500);
  if (!empresa) return json({ error: 'Empresa no encontrada' }, 404);

  if (empresa.flow_subscription_status !== 'activa' || !empresa.flow_customer_id || !empresa.flow_subscription_id) {
    return json({ error: 'Solo puedes cambiar de plan con una suscripción activa. Usa "Suscribirme" si no tienes una.' }, 400);
  }
  const planActualNombre = (empresa.planes as unknown as { nombre?: string } | null)?.nombre;
  if (planActualNombre === planNombre) {
    return json({ error: 'Ya estás en ese plan' }, 400);
  }

  try {
    // 1) Cancela la suscripción vieja de inmediato (no at_period_end): se está reemplazando ahora.
    await flowRequest('POST', '/subscription/cancel', {
      subscriptionId: empresa.flow_subscription_id,
      at_period_end: '0',
    });

    // 2) Crea la nueva suscripción sobre el mismo cliente/tarjeta ya registrados en Flow.
    const suscripcion = await flowRequest('POST', '/subscription/create', {
      planId: nuevoPlan.flow_plan_id,
      customerId: empresa.flow_customer_id,
    });

    const { error: updError } = await serviceClient.from('empresas').update({
      flow_subscription_id: suscripcion.subscriptionId,
      flow_subscription_status: 'activa',
      plan_id: nuevoPlan.id,
    }).eq('id', empresa.id);
    if (updError) return json({ error: updError.message }, 500);

    await serviceClient.from('flow_eventos').insert({
      empresa_id: empresa.id,
      tipo: 'cobro_suscripcion',
      payload: {
        evento: 'plan_cambiado',
        planAnterior: planActualNombre,
        planNuevo: planNombre,
        subscriptionIdAnterior: empresa.flow_subscription_id,
        subscriptionIdNuevo: suscripcion.subscriptionId,
      },
    });

    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'No se pudo cambiar de plan' }, 502);
  }
});
```

</details>

---

## 6. Frontend

### 6.1 `app/index.html` — la aplicación

SPA de ~7700 líneas, un solo archivo (HTML + CSS + JS inline, sin framework,
sin build). Se conecta directo a Supabase vía `fetch()` con la `anon` key.
Piezas clave:

- `SUPABASE_URL` / `SUPABASE_ANON_KEY` hardcodeados cerca del top del archivo
  (línea ~338).
- `rest(path, opts)` — wrapper de `fetch` contra PostgREST (`/rest/v1/...`),
  con reintento de refresh de sesión en 401, `timeoutMs` opcional, y
  traducción de fallos de red reales a un `TypeError` reconocible
  (`MENSAJE_SIN_CONEXION`) para poder encolar offline.
- `authRequest`/`authFetch` — igual pero contra `/auth/v1/...` (login, MFA,
  recuperar contraseña).
- Estado offline: cola en `localStorage`, fotos pendientes en IndexedDB.
- Roles en el cliente: `admin` / `operador` / `es_super_admin` (aparte del
  rol) — todo enforcement real vive en RLS, el frontend solo oculta UI.
- MFA/TOTP: implementado a mano sobre la API REST de GoTrue (no usa
  `supabase-js`), ver `decodeJwtAal`, `continuarSiHaceFaltaMfa`,
  `renderSeccionMfa`.
- Vistas admin-only reciben `class="ancho"` (max-width 1180px) — ver
  `VISTAS_ANCHAS`.

**`app/inventario.html` debe ser una copia exacta** — verificar siempre con
`diff app/index.html app/inventario.html` antes de comitear cualquier cambio a
la app.

### 6.2 `index.html` — landing comercial

Marketing público, sin login. Seguimiento vía GA4 (`G-G5WNMGTXSH`) + GTM
(`GTM-5RH88HLL`), Sentry con el mismo loader que la app
(`3a8602b248fccf0a627d6af0f6e5161d`). Formularios de "pedir demo"/"contacto"
insertan en `leads_demo` (RLS abierta a `anon` para INSERT).

Botones "Suscribirme" de los planes Básico/Profesional están **deshabilitados
a propósito** desde PR #204 (`disabled`, con tooltip "Muy pronto..."),
pendiente de decisión conjunta con Joel sobre cuándo activarlos — el flujo de
autoservicio (`crear-empresa-autoservicio` + Flow) ya está construido y
probado, solo el botón está apagado.

### 6.3 PWA

`app/manifest.json` + `app/sw.js` (service worker: cachea shell + assets
estáticos) + `icons/*.png` (incluye `apple-touch-icon.png`,
`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`).

---

## 7. Flow.cl (pagos)

**Modo actual: producción** (no sandbox) desde PR #97 — `FLOW_ENV=production`
en las Edge Functions.

- **Planes en Flow** (creados a mano en el dashboard de Flow, referenciados
  por `planes.flow_plan_id`): `inventia-basico`, `inventia-profesional`. Si se
  pierde el comercio de Flow, hay que recrear estos dos planes con esos
  mismos IDs (o actualizar `planes.flow_plan_id` si Flow asigna otros).
- **Webhook de cobro**: configurado en el dashboard de Flow, a nivel de cada
  Plan, apuntando a
  `https://ncvwgsbcvklhbyvurxzz.supabase.co/functions/v1/flow-webhook-cobro`.
- **`url_return` del registro de tarjeta**: apunta a
  `https://ncvwgsbcvklhbyvurxzz.supabase.co/functions/v1/flow-registro-callback`
  (se pasa dinámicamente desde `flow-iniciar-suscripcion`, no hace falta
  configurarlo en el dashboard de Flow).
- **Estados de `empresas.flow_subscription_status`**: `pendiente_tarjeta` (recién
  creada, sin tarjeta aún) → `activa` → `morosa` (Flow agotó sus reintentos) o
  `cancelada` (el admin canceló, sigue con acceso hasta fin de período) →
  `vencida` (cron diario, 31 días sin cobro confirmado tras cancelar).
  `morosa`/`pendiente_tarjeta`/`vencida` bloquean el acceso vía
  `empresa_actual()`.
- **Política acordada sobre reintentos**: se bloquea a `morosa` solo cuando
  Flow reporta `subscription.morose=1` (después de sus propios 3 reintentos
  por omisión), nunca en el primer fallo de cobro individual.

---

## 8. Otras integraciones

### 8.1 Correo (Brevo + plantillas)

Supabase Auth manda 2 tipos de correo, cada uno con su propia plantilla HTML
guardada en el repo (`supabase/templates/`) pero **aplicada a mano en el
dashboard** (no hay CLI/API conectada a este proyecto para subirlas sola):

1. **Invite user** (`supabase/templates/invite.html`) — dispara al invitar a
   alguien (`invite-user` Edge Function → `admin.inviteUserByEmail`). Asunto:
   `Te invitaron a InventIA`.
2. **Reset Password** (`supabase/templates/recovery.html`) — dispara con
   `resetPasswordForEmail()` (botón "olvidé mi contraseña" del login).
   Asunto: `Accede a tu cuenta de InventIA`.

Para que estos correos lleguen a cualquier usuario real (no solo al equipo del
proyecto) y digan "InventIA" como remitente, hace falta un **SMTP propio**
configurado en Supabase Dashboard → Authentication → Settings → SMTP
Settings, actualmente con **Brevo** (`Sender name: InventIA`). Si se pierde
esa configuración, hay que recrearla con las credenciales SMTP de la cuenta de
Brevo de Joel (no están en este repo).

**Pasos para reconstruir de cero** (dashboard de Supabase):
1. Authentication → Settings → SMTP Settings → configurar host/puerto/usuario/
   contraseña de Brevo, `Sender name: InventIA`.
2. Authentication → Templates → pestaña **Invite user**: pegar
   `supabase/templates/invite.html`, asunto `Te invitaron a InventIA`.
3. Authentication → Templates → pestaña **Reset Password**: pegar
   `supabase/templates/recovery.html`, asunto `Accede a tu cuenta de InventIA`.

### 8.2 Autenticación — configuración manual del dashboard

Estos ajustes **no viven en el esquema SQL** — son configuración de Supabase
Auth (GoTrue) en el dashboard del proyecto, y hay que volver a activarlos a
mano si se recrea el proyecto:

- **Login con código OTP de 6 dígitos** como alternativa al link del correo
  (Magic Link / OTP habilitado).
- **MFA/TOTP opcional** para cuentas `admin`/`es_super_admin` — implementado
  en el frontend contra la API REST de GoTrue (`/auth/v1/factors`), no
  requiere config especial más allá de que MFA esté habilitado a nivel de
  proyecto (por default lo está en Supabase).
- **"Single session per user"** activado (Authentication → Settings) — cierra
  la sesión anterior si alguien inicia sesión en otro dispositivo; el
  frontend avisa de esto al usuario (`tengo_otra_sesion_activa()`).
- **Protección de contraseñas filtradas** activada (verifica contraseñas
  nuevas contra bases de datos de contraseñas comprometidas conocidas).
- **Rate limiting de login** — configuración estándar de Supabase Auth, sin
  ajuste especial documentado más allá de lo por-defecto.

### 8.3 Sentry

Proyecto `inventia` en `https://inventia.sentry.io`. Integración vía el
**Sentry Loader** (script público, no requiere DSN expuesto por separado):

```html
<script src="https://js.sentry-cdn.com/3a8602b248fccf0a627d6af0f6e5161d.min.js" crossorigin="anonymous"></script>
```

Presente tanto en `app/index.html`/`app/inventario.html` como en `index.html`
(landing). Captura errores de JS y promesas rechazadas sin capturar
automáticamente vía sus propios listeners globales (además de la red de
seguridad propia de la app, ver `mensajeParaRechazoNoCapturado` en
`app/index.html`). Si se pierde el proyecto de Sentry, hay que crear uno
nuevo, tomar su nuevo loader script ID y reemplazar el `src` en ambos
archivos.

**Alertas de Sentry → GitHub**: configurado (Sentry → Alerts → "Notify via
GitHub") para crear un issue automático en `jmajmut-arch/inventario` por cada
error nuevo — así es como llegan los issues con label `sentry` (o body que
menciona `sentry.io`/`View on Sentry`) que se revisan en el chequeo periódico.

### 8.4 Google Analytics / GTM (solo landing)

- **GTM**: `GTM-5RH88HLL`
- **GA4**: `G-G5WNMGTXSH`
- Eventos de conversión trackeados manualmente (`gtag('event', ...)`) en
  puntos clave del landing (ver funciones que llaman `trackEvent`/`gtag` en
  `index.html`).

### 8.5 Dominio y hosting

- **Dominio**: `inventiapp.cl`, comprado y administrado fuera de GitHub (en el
  registrador que Joel eligió — no documentado en este repo qué registrador
  es). DNS apunta a GitHub Pages (típicamente `A` records a las IPs de GitHub
  Pages, o `CNAME` a `<usuario>.github.io` si es un subdominio).
- **`CNAME`** en la raíz del repo declara `inventiapp.cl` — GitHub Pages lo
  lee automático.
- **GitHub Pages**: Settings → Pages del repo → "Deploy from branch" → `main`
  → `/ (root)`. Sirve todo el repo tal cual, sin build. El landing queda en
  `https://inventiapp.cl/` y la app en `https://inventiapp.cl/app/`.
- Si se pierde el dominio: reconstruir el sitio en cualquier hosting estático
  (GitHub Pages con el dominio por defecto `*.github.io`, Netlify, Vercel,
  Cloudflare Pages) — no hay dependencia de servidor propio, cualquier hosting
  estático sirve. Actualizar `CNAME` y, si cambia el dominio de verdad, avisar
  a Flow.cl (`url_return`/webhook siguen apuntando a Supabase, no al dominio,
  así que no hay que tocar Flow) y revisar cualquier URL hardcodeada a
  `inventiapp.cl` en las Edge Functions (`invite-user`, `flow-registro-callback`
  usan `SITE_URL = 'https://inventiapp.cl/app/'` — **hay que actualizar esta
  constante en ambas si cambia el dominio**).

---

## 9. Datos de negocio (planes vigentes)

| Plan | Etiqueta | Bodegas máx. | Usuarios máx. | Offline | Dashboard Ejecutivo | Auditoría | `flow_plan_id` |
|---|---|---|---|---|---|---|---|
| `basico` | Básico | 1 | 1 | No | No | No | `inventia-basico` |
| `profesional` | Profesional | 2 | 2 | Sí | Sí | Sí | `inventia-profesional` |
| `empresa` | Empresa | Ilimitadas | Ilimitados | Sí | Sí | Sí | *(null — se coordina a medida, sin autoservicio)* |

Precios actuales (de `index.html`, sección `#planes` — pueden cambiar sin
tocar el esquema, verificar el landing vivo para el precio real): Básico USD
150/mes, Profesional USD 250/mes, Empresa a medida.

`max_bodegas`/`max_usuarios` se aplican vía triggers de Postgres
(`trg_limite_bodegas`, `trg_limite_usuarios`) — no se pueden sortear llamando
a la API directamente, es enforcement real de base de datos, no solo de UI.

---

## 10. Runbook — escenarios de recuperación

### 10.1 Se perdió el repositorio de GitHub (pero Supabase sigue vivo)

1. Crear un repo nuevo (o restaurar desde un fork/clon local si existe).
2. Reconstruir `app/index.html`, `app/inventario.html`, `index.html` y el
   resto de páginas estáticas — si no hay copia local, no hay forma de
   recuperar el código exacto sin un backup; este documento no contiene el
   código completo de la app (7700 líneas), solo su arquitectura.
3. Recrear `.github/workflows/tests.yml` y `loadtest.yml` (contenido completo
   en §3 / repo original si se tiene acceso a algún clon).
4. Volver a apuntar GitHub Pages + `CNAME` (§8.5).
5. Los datos y el backend en Supabase no se ven afectados — la app apenas
   vuelva a existir como archivo estático, sigue funcionando igual (las
   credenciales `SUPABASE_URL`/`SUPABASE_ANON_KEY` están hardcodeadas en el
   propio HTML).

### 10.2 Se perdió el proyecto Supabase completo (o hay que migrar a uno nuevo)

Esto es lo más costoso — implica reconstruir la base de datos, Auth, Storage y
las 8 Edge Functions.

1. **Crear el proyecto** — Postgres 17, región `sa-east-1` (o la más cercana a
   los clientes reales).
2. **Restaurar datos** si existe un backup/`pg_dump` reciente. Si no existe
   ninguno, los datos de los clientes (SKU, conteos, fotos, usuarios) están
   perdidos sin remedio — este documento no sustituye un backup real.
3. **Reconstruir el esquema** siguiendo §4 completo, en este orden:
   a. Extensiones (§4.7).
   b. Tablas (§4.2) — respetar el orden de dependencias: `empresas` y
      `planes` primero (se referencian mutuamente, crear sin FK y agregarla
      después, o crear `planes` sin `flow_plan_id` poblado y `empresas` sin
      `plan_id` NOT NULL hasta que ambas existan), luego `usuarios`, luego el
      resto.
   c. Funciones de seguridad (§4.3) — **antes** de las políticas RLS, que
      dependen de ellas.
   d. Habilitar RLS en las 14 tablas y crear las políticas (§4.4-anexo).
   e. Triggers (§4.6).
   f. Vistas (§4.5) — reconstruir desde el nombre de la migración
      correspondiente si se tiene acceso al historial, o pedir ayuda para
      derivarlas de cómo las consume `app/index.html` (cada vista se usa en
      un `fetch('/rest/v1/<vista>?...')` puntual, buscable en el código).
   g. Cron jobs (§4.8).
   h. Bucket de Storage `fotos-inventario` con sus límites (§4.9) y las
      políticas de Storage RLS acotadas por `empresa_id` (no reproducidas
      literalmente en este documento — patrón: el path del archivo empieza
      con `<empresa_id>/...`, y la policy compara ese segmento contra
      `empresa_actual()`).
4. **Sembrar datos base**: al menos una fila en `planes` por cada plan (§9),
   y (opcional) una empresa + usuario admin de arranque —
   **nunca crear una cuenta admin o una empresa sin que el usuario lo pida
   explícitamente** (política del proyecto).
5. **Recrear las 8 Edge Functions** (código completo en §5) con sus variables
   de entorno (`FLOW_API_KEY`, `FLOW_SECRET_KEY`, `FLOW_ENV=production`).
6. **Reconfigurar Auth** (§8.2): SMTP de Brevo, plantillas de correo, OTP,
   MFA, single-session, protección de contraseñas filtradas.
7. **Actualizar `SUPABASE_URL`/`SUPABASE_ANON_KEY`** en `app/index.html`,
   `app/inventario.html` y `.github/workflows/loadtest.yml` con los del
   proyecto nuevo (la URL del proyecto cambia si es un proyecto nuevo; la
   `anon` key también).
8. **Actualizar el webhook de Flow.cl** (dashboard de Flow) para que apunte a
   la nueva URL de `flow-webhook-cobro`.
9. Correr `get_advisors` (seguridad y performance) contra el proyecto nuevo y
   comparar contra §4 de este documento — cualquier política o función
   faltante debería aparecer como advertencia.
10. Correr `node tests/app.test.js` y `npm run test:e2e` contra el proyecto
    nuevo antes de dar por buena la migración.

### 10.3 Se perdió el dominio `inventiapp.cl`

Ver §8.5 — publicar en cualquier hosting estático con el dominio que se
tenga disponible, actualizar `CNAME`, y actualizar la constante `SITE_URL`
hardcodeada en las Edge Functions `invite-user` y `flow-registro-callback` si
el dominio nuevo es distinto (§5).

### 10.4 Se perdió el acceso a Flow.cl

La app sigue funcionando para empresas ya suscritas hasta que Flow deje de
poder cobrar (quedarán `morosa` después de que Flow agote sus reintentos). El
alta autoservicio (`crear-empresa-autoservicio`, hoy con el botón
deshabilitado igual) y los cambios de plan/cancelación dejan de funcionar
hasta reconectar Flow. Reconectar: crear comercio nuevo en Flow, recrear los 2
planes (`inventia-basico`, `inventia-profesional`), actualizar
`FLOW_API_KEY`/`FLOW_SECRET_KEY` en las Edge Functions, y el webhook de cobro
en el dashboard de Flow.

### 10.5 Se perdió el acceso a Sentry

No afecta la operación de la app — solo se deja de recibir alertas de errores
de producción. Reconectar: crear proyecto nuevo en sentry.io, tomar el nuevo
loader script ID, reemplazar el `src` del script en `app/index.html`,
`app/inventario.html` e `index.html`, y volver a configurar la integración
"Notify via GitHub" si se quiere seguir recibiendo issues automáticos.

---

## 11. Checklist de verificación post-restauración

- [ ] `node tests/app.test.js` pasa completo.
- [ ] `npm run test:e2e` pasa completo (Playwright).
- [ ] Login con correo/contraseña funciona (cuenta de prueba real).
- [ ] Login con código OTP de 6 dígitos funciona.
- [ ] MFA: activar, desafiar en login, desactivar — ciclo completo con una
      cuenta admin.
- [ ] Carga de SKU manual y masiva (Excel/CSV) funciona.
- [ ] Contar → guardar un conteo con foto funciona (online y, si se puede
      probar, offline con reconexión).
- [ ] Dashboard Ejecutivo y Operativo cargan sin error para una empresa con
      datos.
- [ ] Buscar, filtros y exportar a Excel/PDF funcionan.
- [ ] `get_advisors` (seguridad) no muestra nada nuevo fuera de lo ya
      documentado como aceptado en §4.
- [ ] Un usuario de la empresa A no puede ver datos de la empresa B (probar
      con dos cuentas reales, no solo confiar en la RLS en papel).
- [ ] Invitar a alguien nuevo dispara el correo correcto (revisar bandeja real).
- [ ] "Olvidé mi contraseña" dispara el correo correcto.
- [ ] Flow: registrar tarjeta de una empresa de prueba en sandbox (si se
      volvió a `FLOW_ENV=sandbox` para probar) o con muchísimo cuidado en
      producción con una tarjeta real de prueba — de punta a punta,
      incluyendo el webhook de cobro.
- [ ] Landing carga, GA4/GTM disparan eventos, Sentry captura un error de
      prueba forzado.
- [ ] El sitio responde en `https://inventiapp.cl/` y
      `https://inventiapp.cl/app/`.

---

## 12. Límites conocidos de este documento

- No incluye ningún secreto real (service role key, claves de Flow, SMTP,
  tokens) — por diseño. Sin acceso a los dashboards originales (Supabase,
  Flow, Brevo, Sentry, el registrador del dominio), varias piezas no se
  pueden restaurar solo con este documento.
- No reproduce el `CREATE VIEW` literal de las 24 vistas ni el cuerpo
  completo de las ~27 funciones no listadas en §4.3 — están nombradas y
  ubicables (por nombre de migración o consultando el proyecto vivo), pero no
  transcritas carácter por carácter aquí, para mantener el documento legible.
  Si se necesitan textualmente, extraerlas del proyecto Supabase vivo con
  `pg_get_functiondef`/`pg_get_viewdef` **antes** de que se pierda el acceso,
  o desde el historial de migraciones si sigue disponible.
- No incluye el código completo de `app/index.html` (7700 líneas) ni de
  `index.html` (landing) — viven en el repo, no se duplican aquí. Si el repo
  se pierde sin ningún clon local en ningún lado, ese código no es
  recuperable desde este documento.
- Las políticas de Storage (bucket `fotos-inventario`) están descritas por
  patrón, no transcritas literalmente.
- No es un backup de datos. Los datos reales de clientes (SKU, conteos,
  fotos, usuarios) solo se recuperan desde los backups automáticos de
  Supabase o un `pg_dump` propio — este documento no los contiene ni puede
  sustituirlos.
