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

// urlCallback configurado a nivel de Plan en Flow: se dispara en cada intento de cobro de
// una suscripción a ese plan. El spec de Flow no documenta el shape exacto de este POST,
// así que primero guardamos SIEMPRE el payload crudo (para no perder el dato real) y después
// resolvemos el subscriptionId (directo, o vía invoiceId -> invoice/get) para preguntarle a
// Flow el estado real de la suscripción. Usamos subscription.morose (no cada intento fallido
// individual) porque es la señal de Flow de que ya agotó sus propios reintentos
// (charges_retries_number, 3 por omisión) y sigue impaga — esa es la política acordada:
// bloquear recién cuando Flow se da por vencido, no ante el primer intento fallido.
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
