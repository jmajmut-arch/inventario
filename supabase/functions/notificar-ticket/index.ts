import { createClient } from 'jsr:@supabase/supabase-js@2';

// Avisa por correo cada problema reportado desde la app ("Reportar un problema", tabla tickets).
// La llama el trigger trg_notificar_ticket (supabase/migrations/20261022_tickets.sql) con el id de
// la fila recién insertada. Mismo esquema que notificar-lead: correo por Brevo desde
// contacto@inventiapp.cl. Secreto: BREVO_API_KEY. Opcional: NOTIFICAR_TICKETS_A (destino; por
// omisión contacto@inventiapp.cl).
//
// Seguridad: verify_jwt activo (basta el anon key, que es público), así que cualquiera podría
// llamarla. Por eso NO se confía en el cuerpo: solo se recibe un id, la fila se lee con el service
// role y se manda un único correo por reporte (notificado_en). El correo lleva lo que la persona
// escribió y el error, nunca otros datos de la empresa.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') || '';
const DESTINO = Deno.env.get('NOTIFICAR_TICKETS_A') || 'contacto@inventiapp.cl';
const REMITENTE = { name: 'InventIA', email: 'contacto@inventiapp.cl' };
const BUCKET = 'fotos-inventario';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function horaChile(iso: string) {
  return new Date(iso).toLocaleString('es-CL', { timeZone: 'America/Santiago', dateStyle: 'medium', timeStyle: 'short' });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  if (!BREVO_API_KEY) return json({ error: 'Falta el secreto BREVO_API_KEY' }, 500);

  let body: { id?: string };
  try { body = await req.json(); } catch { return json({ error: 'Cuerpo inválido' }, 400); }
  const id = String(body.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'id inválido' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: t, error } = await db
    .from('tickets')
    .select('id, numero, empresa_id, creado_por, creado_por_nombre, creado_por_rol, descripcion, error_mensaje, pantalla, contexto, foto_ruta, creado_en, notificado_en')
    .eq('id', id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!t) return json({ error: 'Reporte no encontrado' }, 404);
  if (t.notificado_en) return json({ ok: true, repetido: true });

  const { data: empresa } = await db.from('empresas').select('nombre').eq('id', t.empresa_id).maybeSingle();
  // El correo de quien reporta, para responderle directo. Si no se puede leer, el aviso sale igual.
  let correo = '';
  try {
    const { data } = await db.auth.admin.getUserById(t.creado_por);
    correo = data?.user?.email || '';
  } catch { correo = ''; }
  // La foto, con un enlace firmado por 7 días (el bucket es privado).
  let fotoUrl = '';
  if (t.foto_ruta) {
    const { data } = await db.storage.from(BUCKET).createSignedUrl(t.foto_ruta, 7 * 24 * 3600);
    fotoUrl = data?.signedUrl || '';
  }

  const ctx = (t.contexto && typeof t.contexto === 'object') ? t.contexto as Record<string, unknown> : {};
  const sentry = typeof ctx.sentry_evento === 'string' && /^[0-9a-f]{32}$/i.test(ctx.sentry_evento) ? ctx.sentry_evento : '';
  const nombreEmpresa = empresa?.nombre || 'empresa desconocida';
  const asunto = `Reporte #${t.numero} · ${nombreEmpresa} · ${t.creado_por_nombre || 'sin nombre'}`;
  const filas: [string, string][] = [
    ['Empresa', esc(nombreEmpresa)],
    ['Persona', `${esc(t.creado_por_nombre || '—')}${t.creado_por_rol ? ` (${esc(t.creado_por_rol)})` : ''}${correo ? ` · <a href="mailto:${esc(correo)}">${esc(correo)}</a>` : ''}`],
    ['Enviado', esc(horaChile(t.creado_en))],
    ['Pantalla', esc(t.pantalla || '—')],
    ['Qué pasó', esc(t.descripcion).replace(/\n/g, '<br>')],
  ];
  if (t.error_mensaje) filas.push(['Error', `<code>${esc(t.error_mensaje)}</code>`]);
  if (ctx.dispositivo) filas.push(['Equipo', esc(ctx.dispositivo)]);
  if (ctx.pantalla_px) filas.push(['Tamaño', esc(ctx.pantalla_px)]);
  if (ctx.version) filas.push(['Versión', esc(ctx.version)]);
  if (ctx.en_linea === false) filas.push(['Conexión', 'Sin conexión al reportar']);
  if (sentry) filas.push(['Sentry', `<a href="https://inventia.sentry.io/issues/?query=${esc(sentry)}">${esc(sentry)}</a>`]);
  if (fotoUrl) filas.push(['Foto', `<a href="${esc(fotoUrl)}">Ver foto</a> (el enlace dura 7 días)`]);

  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#241a10">
    <p style="margin:0 0 14px"><b>${esc(asunto)}</b></p>
    <table style="border-collapse:collapse">${filas.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#5f5142;vertical-align:top">${k}</td><td style="padding:4px 0">${v}</td></tr>`).join('')}</table>
    <p style="margin:18px 0 0;color:#5f5142;font-size:13px">Respóndelo en la app: Súper admin → Reportes. La persona ve tu respuesta en "Reportar un problema".</p>
  </div>`;
  const texto = filas.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '')}`).join('\n');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: REMITENTE,
      to: [{ email: DESTINO }],
      replyTo: correo ? { email: correo, name: t.creado_por_nombre || undefined } : undefined,
      subject: asunto,
      htmlContent: html,
      textContent: texto,
      tags: ['ticket'],
    }),
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    return json({ error: `Brevo respondió ${res.status}: ${detalle.slice(0, 300)}` }, 502);
  }

  await db.from('tickets').update({ notificado_en: new Date().toISOString() }).eq('id', id);
  return json({ ok: true });
});
