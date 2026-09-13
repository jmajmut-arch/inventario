import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FLOW_API_KEY = Deno.env.get('FLOW_API_KEY') || '';
const FLOW_SECRET_KEY = Deno.env.get('FLOW_SECRET_KEY') || '';
const FLOW_ENV = (Deno.env.get('FLOW_ENV') || 'sandbox').toLowerCase();
const FLOW_BASE_URL = FLOW_ENV === 'production' ? 'https://www.flow.cl/api' : 'https://sandbox.flow.cl/api';

// Mínimo entre dos consultas reales a Flow para la misma empresa. La app llama a esta función
// al iniciar sesión (con su propio umbral de 6 h en localStorage); este umbral del servidor
// protege a Flow de una app abierta en muchos dispositivos a la vez.
const MIN_INTERVALO_MS = 10 * 60 * 1000;

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

async function flowGet(path: string, params: Record<string, string>) {
  const conApiKey = { apiKey: FLOW_API_KEY, ...params };
  const s = await firmarFlow(conApiKey);
  const res = await fetch(`${FLOW_BASE_URL}${path}?${new URLSearchParams({ ...conApiKey, s })}`);
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* respuesta no-JSON */ }
  if (!res.ok) {
    const err = new Error(data.message || `Error Flow (${path}): ${res.status}`);
    (err as any).flowCode = data.code;
    throw err;
  }
  return data;
}

// Estado de InventIA a partir de lo que dice Flow. La única señal que bloquea el acceso es
// 'morosa' (morose=1: Flow agotó sus reintentos y sigue impaga). status 1 = activa; con
// cancel_at_period_end=1 sigue con acceso hasta el fin del período ('cancelada'). Cualquier
// otro status (4 = cancelada de verdad, período ya terminado) es 'vencida'.
function estadoDesdeFlow(s: any): string {
  if (Number(s.morose) === 1) return 'morosa';
  if (Number(s.status) === 1) return Number(s.cancel_at_period_end) === 1 ? 'cancelada' : 'activa';
  return 'vencida';
}

// Reconciliación del estado de la suscripción contra Flow, sin depender del webhook (#94: el
// urlCallback del plan no se invocó en el primer cobro real). Cualquier usuario activo de la
// empresa puede pedirla (solo lee y refleja el estado real; no cambia nada en Flow).
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  if (!FLOW_API_KEY || !FLOW_SECRET_KEY) return json({ error: 'Faltan credenciales de Flow configuradas en el servidor' }, 500);

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Falta autenticación' }, 401);
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: 'Sesión inválida' }, 401);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: perfil, error: perfilError } = await serviceClient
    .from('usuarios')
    .select('empresa_id, activo')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (perfilError) return json({ error: perfilError.message }, 500);
  if (!perfil || !perfil.activo) return json({ error: 'No autorizado' }, 403);

  const { data: empresa, error: empresaError } = await serviceClient
    .from('empresas')
    .select('id, flow_subscription_id, flow_subscription_status, flow_sync_en')
    .eq('id', perfil.empresa_id)
    .maybeSingle();
  if (empresaError) return json({ error: empresaError.message }, 500);
  if (!empresa) return json({ error: 'Empresa no encontrada' }, 404);
  if (!empresa.flow_subscription_id) return json({ ok: true, sincronizada: false, estado: empresa.flow_subscription_status });

  const ultima = empresa.flow_sync_en ? new Date(empresa.flow_sync_en).getTime() : 0;
  if (Date.now() - ultima < MIN_INTERVALO_MS) {
    return json({ ok: true, sincronizada: false, estado: empresa.flow_subscription_status, cambio: false });
  }

  let suscripcion: any;
  try {
    suscripcion = await flowGet('/subscription/get', { subscriptionId: empresa.flow_subscription_id });
  } catch (e) {
    // Suscripción que Flow no conoce (p. ej. creada en sandbox): no se toca el estado, solo se
    // anota la hora para no volver a preguntar a cada rato.
    await serviceClient.from('empresas').update({ flow_sync_en: new Date().toISOString() }).eq('id', empresa.id);
    return json({ ok: true, sincronizada: false, estado: empresa.flow_subscription_status, cambio: false, aviso: e instanceof Error ? e.message : String(e) });
  }

  const nuevoEstado = estadoDesdeFlow(suscripcion);
  const cambio = nuevoEstado !== empresa.flow_subscription_status;
  const { error: updError } = await serviceClient
    .from('empresas')
    .update({ flow_subscription_status: nuevoEstado, flow_sync_en: new Date().toISOString() })
    .eq('id', empresa.id);
  if (updError) return json({ error: updError.message }, 500);

  if (cambio) {
    await serviceClient.from('flow_eventos').insert({
      empresa_id: empresa.id,
      tipo: 'cobro_suscripcion',
      payload: {
        evento: 'sincronizacion',
        subscriptionId: empresa.flow_subscription_id,
        de: empresa.flow_subscription_status,
        a: nuevoEstado,
        morose: suscripcion.morose,
        status: suscripcion.status,
        next_invoice_date: suscripcion.next_invoice_date,
      },
    });
  }

  return json({ ok: true, sincronizada: true, estado: nuevoEstado, cambio });
});
