# Contexto de marketing · InventIA

*Última actualización: 10 de octubre de 2026 · Versión 1.1 (borrador desde el repositorio, con competencia y lenguaje confirmados por Joel)*

Marcas de confianza: 🟢 verificado en el sitio o el producto · 🟡 deducido, conviene confirmar · 🔴 supuesto, falta el dato.

Regla fija: **los datos reales de Escondida no salen de este archivo hacia ningún texto público**. Se puede decir "en uso en una operación minera en Chile" y la cifra que ya publica el sitio (más de 63.000 materiales); nada de nombres de personas ni otras cifras de su operación.

## Product Overview
**One-liner:** 🟢 Control de inventario y bodega desde el celular: el equipo cuenta en terreno, con o sin señal, y las diferencias con el sistema aparecen solas, con foto y responsable.

**What it does:** 🟢 InventIA tiene dos módulos sobre una sola base de datos. **Inventario** planifica y ejecuta el conteo cíclico (por clase ABC, bodega, ubicación y responsable), calcula las diferencias contra el stock del sistema y dirige el reconteo. **Bodega** registra lo que se pide al proveedor, lo que llega, lo que sale y lo que queda, cada movimiento con documento, responsable y respaldo. Es una app web: se abre en el navegador del celular, la tablet o el computador, sin instalar nada.

**Product category:** 🟢 Software de control de inventario y bodega · conteo cíclico · toma de inventario físico.

**Product type:** 🟢 SaaS multiempresa (B2B), app web instalable (PWA) que funciona sin conexión.

**Business model:** 🟢 Suscripción mensual por empresa, en USD, cobrada en CLP con tarjeta (IVA incluido, dólar de referencia $980). Básico y Profesional incluyen un módulo a elección; los dos módulos o más bodegas van en plan Empresa a medida. Demo inmediata con datos de ejemplo y piloto gratuito con el catálogo del cliente.

| Plan | Precio | Incluye |
|---|---|---|
| Básico | US$160/mes (CLP 187.000 con IVA) | 1 bodega, 1 admin + 1 operador, un módulo |
| Profesional | US$300/mes (CLP 350.000 con IVA) | Hasta 2 bodegas, 1 admin + 2 operadores, un módulo, auditoría, soporte prioritario |
| Empresa | A medida | Usuarios ilimitados, multiplanta, uno o los dos módulos, onboarding asistido |

## Target Audience
**Target companies:** 🟡 Empresas en Chile con bodegas de repuestos, insumos o materiales: minería primero (es donde está en uso), luego industria, construcción, energía, mantención y cualquier operación con inventario físico relevante. Desde una bodega con un equipo chico hasta varias plantas. El sitio dice "adaptable a minería, industria y empresas de todo rubro".

**Decision-makers:** 🟡 Jefe de bodega o de inventario (impulsa), gerente de abastecimiento, operaciones o supply chain (decide), control de gestión o finanzas (mira la plata de las diferencias), TI o seguridad en empresas grandes (aprueba).

**Primary use case:** 🟢 Saber cuánto hay de verdad y quién lo contó: conteo cíclico en terreno con diferencias automáticas y respaldo, en vez de planillas.

**Jobs to be done:**
- 🟢 Contar el inventario sin planillas, con avance visible y fecha de término estimada.
- 🟢 Encontrar y explicar las diferencias antes de cerrar, con foto, responsable y hora como respaldo ante auditoría.
- 🟢 Saber quién se llevó qué de la bodega y con qué documento (módulo Bodega).

**Use cases:**
- 🟢 Conteo cíclico planificado por clase ABC en una faena minera, en zonas sin señal.
- 🟢 Reconteo dirigido solo a lo que no cuadró, y cierre contra el ajuste en el ERP.
- 🟢 Bodega que hoy anota ingresos en un cuaderno o un Excel de un solo computador, y salidas en ninguna parte.
- 🟢 Informe por ciclo listo para la reunión.

## Personas

| Persona | Rol | Le importa | Su problema | Lo que le prometemos |
|---|---|---|---|---|
| Operador o inventariador | Usuario | Contar rápido, sin errores, con guantes y sin señal | Planillas en papel, transcribir, zonas sin cobertura | Tres campos: escanear o buscar, cantidad, foto. Funciona sin señal |
| Jefe de bodega o de inventario | Champion | Terminar el ciclo a tiempo y poder defender el resultado | No sabe cuánto avanzó, quién contó qué ni por qué no cuadra | Avance en tiempo real, diferencias solas, trazabilidad por persona |
| Gerente de abastecimiento u operaciones | Decision maker | Confiabilidad del inventario, pérdidas, auditorías | Diferencias sin explicación, cierres tardíos | Exactitud medible e informe por ciclo |
| Control de gestión o finanzas | Financial buyer | Cuánta plata hay en las diferencias | Ajustes en el ERP sin respaldo | Diferencias valorizadas y cierres con referencia del ajuste |
| TI o seguridad | Technical influencer | Datos aislados, accesos, proveedor confiable | Herramientas sin evidencia de seguridad | Aislamiento por empresa, CSA STAR publicado, verificación en dos pasos exigible por empresa |

🟡 Las personas salen del producto y del sitio, no de entrevistas. Falta confirmar con clientes reales.

## Problems & Pain Points
**Core problem:** 🟢 El inventario se cuenta en planillas, se consolida a mano y las diferencias aparecen tarde, sin saber quién contó ni con qué respaldo.

**Why alternatives fall short:**
- 🟢 No existe un software pensado específicamente para la toma de inventario: se hace con lo que hay.
- 🟢 Excel y papel: más pasos, más errores, consolidación manual, sin evidencia.
- 🟡 El ERP (SAP u otro) registra el stock, pero no organiza el conteo en terreno ni guarda la foto y el responsable de cada conteo.
- 🟡 Las apps genéricas de conteo no planifican por clase ABC ni dirigen el reconteo, y suelen necesitar señal.

**What it costs them:** 🟢 El descuadre de inventario no se queda en la bodega: puede afectar la producción y a toda la organización (Joel, 10/10/2026). Si el sistema dice que hay un repuesto y en el estante no está, la falla aparece cuando se necesita, con la operación esperando. 🟡 A eso se suman días consolidando planillas, reconteos completos en vez de dirigidos, ajustes en el ERP sin respaldo y pérdidas que nadie puede explicar.

**Emotional tension:** 🟢 "Bajo control, no bajo sospecha": cuando falta un material, nadie puede afirmar si llegó, si salió o quién lo retiró.

## Competitive Landscape
🟢 **No hay un software específico para la toma de inventario** (Joel, 10/10/2026). Las empresas cuentan con lo que tienen a mano: el ERP para registrar, y Excel o papel para el conteo en terreno. InventIA no le quita mercado a otro producto de conteo: compite contra la costumbre.

| Competitor (alternativa) | Type | Dónde se queda corta |
|---|---|---|
| Excel y papel | Indirect (status quo, el competidor real) | Sin evidencia, consolidación manual, errores de transcripción, avance invisible hasta el final |
| Módulo de inventario físico del ERP (SAP u otro) | Secondary | Registra el stock y el ajuste, pero no organiza el conteo en terreno: no planifica por responsable, no guarda foto ni funciona sin señal |
| WMS completos | Secondary | Caros y largos de implementar, pensados para el flujo logístico, no para el conteo cíclico |
| Apps de conteo genéricas o hechas a medida | Direct (marginal) | Sin planificación ABC, reconteo dirigido ni trabajo sin señal; las hechas a medida dependen de quien las programó |

**Implicancia para el mensaje:** no comparar contra marcas; comparar contra la planilla y contra el costo del descuadre. La categoría ("software para toma de inventario") hay que explicarla, no se puede dar por conocida.

## Differentiation
**Key differentiators:**
- 🟢 Funciona sin señal: el conteo y sus fotos se guardan en el dispositivo y se suben solos.
- 🟢 Diferencias automáticas contra el stock del sistema y reconteo dirigido, con causa probable.
- 🟢 Foto, responsable y hora en cada conteo; nada se borra, anular exige motivo.
- 🟢 Dos módulos sobre una sola base: lo que se recibe y despacha mueve el stock que después se cuenta.
- 🟢 Se implementa el mismo día: se sube el Excel que exporta SAP tal como sale, sin instalar nada.

**How we do it differently:** 🟢 Pensado desde el conteo físico real en minería: celular o tablet, guantes, zonas sin cobertura, varios responsables contando a la vez.

**Why that's better:** 🟡 Menos días de conteo, diferencias explicadas antes del cierre y un resultado que se puede defender en una auditoría.

**Why customers choose us:** 🔴 Sin datos de venta todavía: no hay clientes pagando.

## Objections

| Objection | Response |
|---|---|
| "¿Se integra con SAP?" | 🟢 No hay conexión automática por API: se carga el Excel o CSV que exporta SAP, tal como sale. Una integración directa se evalúa según la operación. No prometer más que eso |
| "¿Funciona sin señal en la mina?" | 🟢 Sí. Conteos y fotos quedan en el dispositivo y se suben solos al volver la señal |
| "¿Nuestros datos quedan mezclados con los de otros?" | 🟢 No: cada empresa está aislada. El cuestionario CAIQ está publicado en el registro CSA STAR |
| "Mi equipo no es técnico" | 🟢 La pantalla de conteo tiene tres campos y se aprende en minutos |
| "Es un proveedor chico" | 🟡 Demo y piloto gratis antes de pagar, mes a mes sin permanencia, datos exportables a Excel en todo momento, seguridad publicada |
| "El precio está en dólares" | 🟢 Se cobra en pesos chilenos con IVA incluido |

**Anti-persona (NOT a good fit):** 🟡 Quien necesita un WMS con picking por olas o radiofrecuencia; un punto de venta o facturación; integración en tiempo real con el ERP por API como requisito de entrada; un negocio con pocos materiales donde una planilla basta.

## Switching Dynamics
**Push (away from current):** 🟡 Planillas que no cuadran, auditorías sin respaldo, cierres que se atrasan, materiales que desaparecen sin explicación.

**Pull (toward us):** 🟢 Demo inmediata, sin instalar nada, funciona sin señal, piloto gratis con su propio catálogo.

**Habit (keeping them stuck):** 🟡 "Siempre lo hemos hecho en Excel"; el ERP como fuente de verdad; equipos acostumbrados al papel.

**Anxiety (about switching):** 🟡 Cargar el maestro (decenas de miles de materiales), que el equipo en terreno lo adopte, seguridad de los datos, depender de un proveedor nuevo.

## Customer Language
**How they describe the problem (verbatim):**
- 🟢 "Descuadre de inventario puede afectar la producción y a toda la organización." (Joel, con experiencia en terreno minero)
- 🟡 Las frases del sitio son nuestras: "¿Cuánto hay de verdad, y quién lo contó?", "¿Quién se llevó qué, y con qué respaldo?". Faltan frases de clientes externos.
- 🟢 Pregunta del correo de seguimiento a leads: "¿qué es lo que hoy más te cuesta con el inventario? ¿Las diferencias entre lo contado y el sistema, el tiempo que se va en contar, o saber qué se contó y qué no?". Las respuestas a ese correo son la mejor fuente de lenguaje real.

**How they describe us:**
- 🔴 Sin testimonios todavía.

**Words to use:** 🟢 descuadre, cuadrar, bodega, conteo, conteo cíclico, toma de inventario, diferencias, faltante, sobrante, cuadrado, reconteo, respaldo, trazabilidad, en terreno, sin señal, storage bin, SKU, maestro de materiales, ubicación, responsable, piloto.

**Words to avoid:** 🟢 "inteligencia artificial" como promesa (el nombre lleva "IA", pero el producto no usa modelos de IA: la causa probable son reglas simples), "integración con SAP" (no hay API), "revolucionario", "automatiza todo", "en tiempo real con tu ERP".

| Término | Significado |
|---|---|
| Período o ciclo | Ventana de conteo (por ejemplo "T1 2027"); el panel y los informes se acotan a él |
| Plan del día | Lo que le toca contar a cada persona hoy |
| Reconteo dirigido | Volver a contar solo lo que no cuadró |
| Fuera de plan | Conteo de un material que no estaba planificado |
| Conteo ciego | Los operadores no ven el stock del sistema mientras cuentan |
| Ajustado en ERP | Cierre de una diferencia con la referencia del ajuste hecho en el ERP |
| Storage bin | Posición física exacta del material dentro de la ubicación |

## Brand Voice
**Tone:** 🟢 Profesional y directo, de terreno. Seguro sin exagerar.

**Style:** 🟢 Frases cortas, preguntas que nombran el dolor ("¿Quién se llevó qué?"), beneficios concretos con detalle verificable.

**Personality:** 🟢 Confiable, práctico, honesto, de terreno, ordenado.

**Voice DO's:** 🟢 Tutear; hablar de la bodega y la faena reales; decir lo que el producto no hace (como la integración con SAP); dar el precio claro en USD y CLP; cerrar con una acción concreta (probar la demo, pedir el piloto).

**Voice DON'T's:** 🟢 Prometer funciones que no existen; jerga de software ("webhook", "sincronización bidireccional"); superlativos vacíos; mencionar datos de clientes sin permiso.

## Style Guide
**Grammar:** 🟢 Español de Chile, tuteo. Una idea por frase.

**Capitalization:** 🟢 "InventIA" con "IA" destacada. Títulos del sitio en mayúsculas por diseño, no en el texto. Nombres de pantallas con mayúscula inicial: Panel, Plan, Contar, Reconteo, Buscar.

**Formatting:** 🟢 Precios como "US$160/mes" y "CLP 187.000 con IVA". Fechas "18 de octubre". Números con punto de miles.

**Preferred terms:** 🟢 "Probar la demo gratis" (no "Ver en acción"), "Solicitar piloto con mis datos", "bodega" (no "almacén"), "material" o "SKU" (no "producto"), "operador" (no "usuario final").

## Proof Points
**Metrics:**
- 🟢 Más de 63.000 materiales en uso diario en una operación minera en Chile (ya publicado en la página de Ads).
- 🟢 0 instalaciones: abre en el navegador de cualquier celular, tablet o computador.
- 🟢 Cuestionario de seguridad CAIQ publicado en el registro CSA STAR.

**Customers:** 🟡 "En uso en minería", sin nombre de empresa. 🔴 Sin logos autorizados.

**Testimonials:** 🔴 Ninguno todavía. Prioridad: conseguir el primero tras un piloto.

| Tema | Respaldo |
|---|---|
| Funciona en terreno | Modo sin señal, uso diario en minería |
| Respaldo ante auditoría | Foto, responsable y hora por conteo; auditoría de cambios |
| Seguridad | Aislamiento por empresa, CSA STAR, verificación en dos pasos |
| Rápido de implementar | Carga del Excel de SAP el mismo día, sin instalar nada |

## Content & SEO Context
**Target keywords:** 🟡 deducidas de los títulos y descripciones del sitio; faltan volúmenes de búsqueda.

| Cluster | Palabra clave principal | Secundarias | Intención |
|---|---|---|---|
| Software de inventario | software de control de inventario | software inventario bodega, sistema de inventario para empresas | Comercial |
| Conteo cíclico | conteo cíclico de inventario | inventario cíclico ABC, toma de inventario físico | Informativa y comercial |
| Bodega | control de bodega | software de bodega, entradas y salidas de bodega, kardex | Comercial |
| Minería | inventario en minería | control de repuestos minería, bodega faena | Comercial |
| Sin señal | inventario sin internet | app de inventario offline | Comercial |

**Internal links map:**

| Página | URL | Para | Texto del enlace |
|---|---|---|---|
| Portada | https://inventiapp.cl/ | Visión de los dos módulos y planes | "InventIA: inventario y bodega" |
| Inventario | https://inventiapp.cl/inventario.html | Conteo cíclico | "conteo cíclico en terreno" |
| Bodega | https://inventiapp.cl/bodega.html | Entradas y salidas | "control de bodega" |
| Planes | https://inventiapp.cl/#planes | Precios | "ver planes y precios" |
| Página de Ads | https://inventiapp.cl/software-inventario.html | Solo tráfico pagado (noindex) | No enlazar desde el sitio |

**Writing examples:**
- 🟢 Portada: "Tu bodega bajo control. No bajo sospecha." y "¿Por dónde parte tu problema?".
- 🟢 Bodega: "El cuaderno de la bodega, pero que no se pierde".
- 🟢 Preguntas frecuentes sobre SAP: honestas sobre lo que no hay.

## Goals
**Business goal:** 🟢 Conseguir los primeros clientes pagando, empezando por minería e industria en Chile.

**Conversion action:** 🟢 Pedir la demo (formulario con nombre, correo y teléfono). Después: llamada de 15 minutos, piloto gratuito con su catálogo y suscripción.

**Current metrics:** 🟡 Octubre, primeros 9 días: unas 12 sesiones al día, más de la mitad desde Google Ads; unos 4,6 eventos clave por cada 100 sesiones; LinkedIn trae más visitas que la búsqueda orgánica. Leads: unos 8 en tres semanas, la mitad sin empresa. Los leads todavía no registran de dónde vienen.
