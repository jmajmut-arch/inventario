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
  // pocos minutos. Solo cuenta empresas "pendiente_tarjeta" (las de este mismo flujo), así
  // que no afecta a las que provisiona el super-admin a mano.
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
