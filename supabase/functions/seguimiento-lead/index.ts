import { createClient } from 'jsr:@supabase/supabase-js@2';

// Correo de seguimiento a quien pidió la demo del sitio (pedido de Joel, 01/10/2026): escrito
// para abrir conversación y entender su necesidad, no para insistir con la demo. Dos pasos:
//   1: 24 horas después de pedir la demo — una sola pregunta sobre su bodega.
//   2: 3 días después del paso 1 — ofrece 15 minutos para ver su caso, última vez.
// El paso 1 dice "pediste acceso", no "entraste": no sabemos si entró, y de noche no sale nada,
// así que puede llegar dos días después (03/10/2026). El paso 2 ofrece solo la llamada de 15
// minutos, no cargar su catálogo (decisión de Joel, 03/10/2026).
// La llama el cron de la base (enviar_seguimientos_leads, ver supabase/migrations) con el id y
// el paso. Igual que notificar-lead: verify_jwt con el anon key (público), así que NO se confía
// en el cuerpo: la fila se lee con el service role y acá se vuelve a verificar todo (tipo demo,
// seguimiento no detenido, paso todavía no enviado, correo válido, no es fila de prueba). Un
// correo por paso: se marca seguimientoN_en solo cuando Brevo confirma. Lo peor que puede hacer
// un tercero con el anon key es adelantar un paso que igual iba a salir.
//
// Remitente contacto@inventiapp.cl (dominio autenticado en Brevo), respuestas al mismo buzón, que
// Cloudflare reenvía al Gmail de Joel, y copia oculta a ese mismo buzón para que Joel vea cada
// correo que salió. Secreto: BREVO_API_KEY (el mismo de notificar-lead).

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BREVO_API_KEY = Deno.env.get('BREVO_API_KEY') || '';
const REMITENTE = { name: 'Joel Majmut · InventIA', email: 'contacto@inventiapp.cl' };
const WHATSAPP = '+56 9 6837 2524';
// En el celular abre WhatsApp directo, con el mensaje ya escrito.
const WHATSAPP_URL = 'https://wa.me/56968372524?text=' + encodeURIComponent('Hola Joel, te escribo por InventIA');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// "FERNANDO FEDERICOPERALTA ALATA" -> "Fernando"; sin nombre -> "Hola," a secas.
function primerNombre(nombre: unknown) {
  const p = String(nombre ?? '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

function correo(paso: number, nombre: string) {
  const saludo = nombre ? `Hola ${nombre},` : 'Hola,';
  if (paso === 1) {
    return {
      asunto: 'Una pregunta sobre tu bodega',
      parrafos: [
        `${saludo} soy Joel, de InventIA. Vi que pediste acceso a la demo.`,
        'Antes de contarte nada más, me interesa entender tu caso: ¿qué es lo que hoy más te cuesta con el inventario? ¿Las diferencias entre lo contado y el sistema, el tiempo que se va en contar, o saber qué se contó y qué no?',
        'Con una línea de respuesta me basta para decirte si InventIA te sirve o no.',
      ],
      conWhatsapp: false,
    };
  }
  return {
    asunto: '¿15 minutos para ver tu caso?',
    parrafos: [
      `${saludo} soy Joel, de InventIA. ¿Te parece si agendamos 15 minutos? Me cuentas cómo hacen hoy el inventario y te muestro cómo quedaría en InventIA con tu operación.`,
      'Si no es el momento, no hay problema.',
    ],
    conWhatsapp: true,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  if (!BREVO_API_KEY) return json({ error: 'Falta el secreto BREVO_API_KEY' }, 500);

  let body: { id?: string; paso?: number };
  try { body = await req.json(); } catch { return json({ error: 'Cuerpo inválido' }, 400); }
  const id = String(body.id || '');
  const paso = Number(body.paso);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: 'id inválido' }, 400);
  if (paso !== 1 && paso !== 2) return json({ error: 'paso inválido' }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: lead, error } = await db
    .from('leads_demo')
    .select('id, nombre, email, empresa, tipo, creado_en, seguimiento1_en, seguimiento2_en, seguimiento_detenido_en')
    .eq('id', id)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!lead) return json({ error: 'Lead no encontrado' }, 404);

  // Mismas condiciones que el cron, por si alguien llama con el anon key por su cuenta.
  const email = String(lead.email || '').trim();
  if ((lead.tipo || 'demo') !== 'demo') return json({ ok: false, motivo: 'no es lead de demo' });
  if (lead.seguimiento_detenido_en) return json({ ok: false, motivo: 'seguimiento detenido' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, motivo: 'correo inválido' });
  if (/^escondida/i.test(String(lead.empresa || ''))) return json({ ok: false, motivo: 'fila de prueba' });
  if (paso === 1 && lead.seguimiento1_en) return json({ ok: true, repetido: true });
  if (paso === 2 && (!lead.seguimiento1_en || lead.seguimiento2_en)) return json({ ok: paso === 2 && !!lead.seguimiento2_en, repetido: !!lead.seguimiento2_en, motivo: lead.seguimiento1_en ? undefined : 'falta el paso 1' });

  const { asunto, parrafos, conWhatsapp } = correo(paso, primerNombre(lead.nombre));
  const firma = ['Joel Majmut', 'InventIA · inventiapp.cl'];
  const enlaceWa = `<a href="${esc(WHATSAPP_URL)}" style="color:#9a6a00">WhatsApp ${esc(WHATSAPP)}</a>`;
  const bajaTexto = 'Si prefieres no recibir más correos de InventIA, responde con "no" y listo.';
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#241a10;max-width:560px">
    ${parrafos.map((p) => `<p style="margin:0 0 14px">${esc(p)}</p>`).join('')}
    ${conWhatsapp ? `<p style="margin:0 0 14px">Te leo acá o por ${enlaceWa}.</p>` : ''}
    <p style="margin:22px 0 0">${firma.map(esc).join('<br>')}${conWhatsapp ? '' : `<br>${enlaceWa}`}</p>
    <p style="margin:26px 0 0;font-size:12px;color:#8a7b6a">${esc(bajaTexto)}</p>
  </div>`;
  const texto = [
    ...parrafos,
    ...(conWhatsapp ? [`Te leo acá o por WhatsApp: ${WHATSAPP_URL}`] : []),
    '', ...firma, ...(conWhatsapp ? [] : [`WhatsApp ${WHATSAPP}: ${WHATSAPP_URL}`]), '', bajaTexto,
  ].join('\n');

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      sender: REMITENTE,
      to: [{ email, name: lead.nombre || undefined }],
      // Copia oculta al buzón de contacto: así Joel ve en su Gmail cada correo que salió y cuándo.
      bcc: [{ email: 'contacto@inventiapp.cl', name: 'InventIA (copia)' }],
      replyTo: { email: 'contacto@inventiapp.cl', name: 'Joel Majmut' },
      subject: asunto,
      htmlContent: html,
      textContent: texto,
      tags: ['seguimiento', `paso${paso}`],
    }),
  });
  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    return json({ error: `Brevo respondió ${res.status}: ${detalle.slice(0, 300)}` }, 502);
  }

  const marca = paso === 1 ? { seguimiento1_en: new Date().toISOString() } : { seguimiento2_en: new Date().toISOString() };
  const { error: errorMarca } = await db.from('leads_demo').update(marca).eq('id', id);
  if (errorMarca) return json({ error: `Correo enviado pero no se pudo marcar: ${errorMarca.message}` }, 500);
  return json({ ok: true, paso });
});
