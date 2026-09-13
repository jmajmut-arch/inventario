import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLOW_API_KEY = Deno.env.get('FLOW_API_KEY')!;
const FLOW_SECRET_KEY = Deno.env.get('FLOW_SECRET_KEY')!;
const FLOW_ENV = (Deno.env.get('FLOW_ENV') || 'sandbox').toLowerCase();
const FLOW_BASE_URL = FLOW_ENV === 'production' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';
// La app vive en /app/ (la raíz del dominio es el landing de marketing) — hay que volver ahí,
// no a la raíz, para que procesarRetornoFlow() (app/index.html) vea el ?flow=ok/error.
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

// Flow llega acá SIN JWT de Supabase (es un servidor externo, no un usuario logueado en la
// app) — por eso esta función se despliega con verify_jwt: false. La seguridad no viene de
// confiar en este POST, sino de que volvemos a preguntarle a Flow (firmado con secretKey) qué
// pasó realmente con el token que nos mandó, antes de activar nada.
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
