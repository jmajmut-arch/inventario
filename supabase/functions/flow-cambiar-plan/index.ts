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
  if (!res.ok) {
    console.error('flow error', { path, status: res.status, body: text.slice(0, 500), paramsEnviados: Object.keys(params) });
    throw new Error(data.message || `Error Flow (${path}): ${res.status}`);
  }
  return data;
}

const PLANES_AUTOSERVICIO = ['basico', 'profesional'];

// Cambia de plan (Básico <-> Profesional) estando ya suscrito y con tarjeta ya registrada en
// Flow (customerId conocido) — a diferencia de flow-iniciar-suscripcion, acá NO se redirige a
// la página de Flow a registrar tarjeta de nuevo: se cancela la suscripción vieja de inmediato
// (at_period_end=0, porque se está reemplazando ahora, no dejando que corra) y se crea la nueva
// sobre el mismo customerId. Reusa solo endpoints de Flow ya probados en este proyecto
// (subscription/cancel y subscription/create) en vez de un endpoint de "editar" no verificado.
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
