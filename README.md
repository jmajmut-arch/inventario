# InventIA — Conteo cíclico de inventario para minería

Aplicación web multiempresa (SaaS) para planificar y ejecutar conteos cíclicos de materiales en bodegas y patios, con respaldo fotográfico, modo offline y dashboard ejecutivo. Publicada en [inventiapp.cl](https://inventiapp.cl) (landing) y [inventiapp.cl/app/](https://inventiapp.cl/app/) (aplicación).

## Estructura del repositorio

| Ruta | Qué es |
|---|---|
| `index.html` | Landing comercial (planes, demo, formulario de contacto, FAQ). |
| `app/index.html` | La aplicación completa en un solo archivo HTML. |
| `app/inventario.html` | Espejo byte a byte de `app/index.html` (URL histórica). Se mantiene con `cp` y se verifica con `diff`. |
| `terminos.html`, `privacidad.html`, `reembolsos.html` | Términos y condiciones, política de privacidad y política de reembolsos. |
| `manifest.webmanifest`, `icons/` | PWA instalable en el celular. |
| `tests/app.test.js` | Suite de tests unitarios de la app (Node, sin dependencias). |
| `tests/e2e.test.js` | Tests end-to-end con Playwright (navegador real). |
| `.github/workflows/tests.yml` | CI: corre ambas suites en cada PR. |

No hay backend propio que desplegar: toda la lógica de servidor vive en Supabase.

## Funcionalidades principales

- **Multiempresa**: cada empresa ve solo sus datos (Row Level Security por `empresa_id` en todas las tablas y vistas). Planes Básico, Profesional y Empresa con límites y funciones por plan.
- **Maestro de materiales** cargado desde el export de SAP (CSV) o a mano; bodegas, ubicaciones, storage bins, batches, clase ABC y criticidad.
- **Planificación**: entradas por fecha, bodega, ubicación y bin, o por código de SKU (lista exacta de materiales); grupos de conteo con frecuencia propia y generación automática de plan; vistas Día, Semana, Mes, Año y Período; calendario; hoja de conteo en PDF.
- **Contar**: plan del día por responsable, escáner de códigos con la cámara, conteo ciego opcional, fotos de respaldo, guardado optimista y cola offline cuando no hay señal.
- **Reconteo** de diferencias con gráfico por semana y descarte justificado.
- **Dashboard** por ciclo de conteo: avance, exactitud en unidades y ubicación, proyección de término, ranking por responsable e informe de ciclo en PDF.
- **Auditoría** de cambios y monitoreo de errores con Sentry.
- **Cuentas**: acceso por invitación (correo), roles `admin` e `inventariador` por empresa, súper administrador de InventIA, MFA opcional (TOTP), una sesión activa por usuario, recuperación de contraseña.
- **Suscripciones** con Flow.cl (tarjeta con cargo automático) para los planes autoservicio.

## Base de datos (Supabase)

Proyecto `inventario-toma-fisica`, región `sa-east-1`, Postgres 17.

- Tablas: `empresas`, `planes`, `usuarios`, `skus`, `conteos`, `conteo_fotos`, `plan_semanal` (y `plan_semanal_skus`, `plan_semanal_exclusiones`, `plan_semanal_incluidos`), `grupos_conteo`, `skus_grupos_conteo`, `historial_ciclos_grupo`, `ciclos_conteo`, `informes_ciclo`, `responsables_proceso`, `cargas_masivas`, `auditoria`, `flow_eventos`, `leads_demo`.
- Las vistas y funciones RPC que usa la app filtran siempre por `empresa_actual()`. Las funciones son ejecutables solo por usuarios autenticados; las de mantenimiento (cron) solo por el servicio.
- Fotos en el bucket privado `fotos-inventario`, con rutas por empresa y URLs firmadas.
- Edge Functions: `invite-user`, `crear-empresa-autoservicio`, `flow-iniciar-suscripcion`, `flow-registro-callback`, `flow-webhook-cobro`, `flow-sincronizar-suscripcion`, `flow-cambiar-plan`, `flow-cancelar-suscripcion`.
- Tareas programadas (pg_cron, diarias): activación de períodos programados, cierre de ciclos de grupo vencidos, refresco nocturno de la clasificación ABC, purga de auditoría antigua, vencimiento de suscripciones canceladas y reset de la cuenta demo.

## Desarrollo

```bash
node tests/app.test.js        # tests unitarios, debe terminar en "TODOS LOS TESTS PASARON"
npm run test:e2e              # tests end-to-end (requiere Chromium de Playwright; en CI se instala solo)
cp app/index.html app/inventario.html && diff app/index.html app/inventario.html
```

Flujo de trabajo: los cambios se desarrollan en una rama, pasan por CI en un pull request y se fusionan a `main`. GitHub Pages publica `main` automáticamente en inventiapp.cl.

## Publicación

GitHub Pages sirve el repositorio completo desde la raíz de `main`, con el dominio `inventiapp.cl` configurado en Settings → Pages. Cualquier hosting estático funcionaría igual: no requiere build.
