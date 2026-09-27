import { createClient } from 'jsr:@supabase/supabase-js@2';

// Avisa por correo cada vez que alguien envía el formulario de demo o de contacto del sitio.
// Pasó de verdad: el 26/09/2026 llegó un lead de la campaña de Ads y nadie lo supo hasta el día
// siguiente, porque el formulario solo guardaba la fila en leads_demo. La llama un trigger de la
// base (ver notificar_lead_demo en supabase/migrations) con el id de la fila recién insertada.
//
// El correo sale por Brevo (la misma cuenta que ya manda las invitaciones de Supabase Auth), con
// remitente contacto@inventiapp.cl, que es del dominio autenticado. Secreto necesario en
// Edge Functions → Secrets: BREVO_API_KEY. Opcional: NOTIFICAR_LEADS_A (destino; por omisión
// contacto@inventiapp.cl, que Cloudflare reenvía al Gmail de Joel).
//
// Seguridad: verify_jwt está activo (basta el anon key, que es público), así que cualquiera
// podría llamarla. Por eso NO se confía en el cuerpo: solo se recibe un id, la fila se lee con
// el service role, y se manda un único correo por lead (notificado_en). Lo peor que puede hacer
// un tercero es pedir el aviso de un lead que ya se avisó, y ese no se repite.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') || '';
const DESTINO = Deno.env.get('NOTIFICAR_LEADS_A') || 'contacto@inventiapp.cl';
const REMITENTE = { name: 'InventIA', email: 'contacto@inventiapp.cl' };

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
  const { data: lead, error } = await db
    .from('leads_demo')
    .select('id, nombre, email, telefono, empresa, tipo, mensaje, creado_en, notificado_en')
    .eq('id', id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!lead) return json({ error: 'Lead no encontrado' }, 404);
  if (lead.notificado_en) return json({ ok: true, repetido: true });

  const esContacto = lead.tipo === 'contacto';
  const asunto = esContacto
    ? `Nuevo mensaje de contacto: ${lead.nombre || 'sin nombre'}${lead.empresa ? ` (${lead.empresa})` : ''}`
    : `Nuevo lead de demo: ${lead.nombre || 'sin nombre'}${lead.empresa ? ` (${lead.empresa})` : ''}`;
  const telefonoDigitos = String(lead.telefono || '').replace(/\D/g, '');
  const filas: [string, string][] = [
    ['Nombre', esc(lead.nombre)],
    ['Empresa', esc(lead.empresa || '—')],
    ['Correo', `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>`],
    ['Teléfono', telefonoDigitos.length >= 8 ? `<a href="https://wa.me/${esc(telefonoDigitos)}">${esc(lead.telefono)}</a>` : esc(lead.telefono || '—')],
    ['Enviado', esc(horaChile(lead.creado_en))],
  ];
  if (esContacto) filas.push(['Mensaje', esc(lead.mensaje || '—').replace(/\n/g, '<br>')]);
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#241a10">
    <p style="margin:0 0 14px"><b>${esc(asunto)}</b></p>
    <table style="border-collapse:collapse">${filas.map(([k, v]) => `<tr><td style="padding:4px 14px 4px 0;color:#5f5142">${k}</td><td style="padding:4px 0">${v}</td></tr>`).join('')}</table>
    <p style="margin:18px 0 0;color:#5f5142;font-size:13px">${esContacto ? 'Respóndele desde este correo.' : 'La persona ya vio las credenciales de la demo. Lo ideal es escribirle el mismo día.'}</p>
  </div>`;
  const texto = filas.map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '')}`).join('\n');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: REMITENTE,
      to: [{ email: DESTINO }],
      replyTo: lead.email ? { email: lead.email, name: lead.nombre || undefined } : undefined,
      subject: asunto,
      htmlContent: html,
      textContent: texto,
      tags: ['lead', lead.tipo || 'demo'],
    }),
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    return json({ error: `Brevo respondió ${res.status}: ${detalle.slice(0, 300)}` }, 502);
  }

  await db.from('leads_demo').update({ notificado_en: new Date().toISOString() }).eq('id', id);
  return json({ ok: true });
});
