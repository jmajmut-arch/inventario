import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// La app vive en /app/ (la raíz del dominio es el landing de marketing) — el link del
// correo debe volver ahí para que el SPA procese el token del fragmento (#access_token=...).
const SITE_URL = 'https://inventiapp.cl/app/';

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

const ROLES_VALIDOS = ['admin', 'operador'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Falta autenticación' }, 401);

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: 'Sesión inválida' }, 401);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: perfil, error: perfilError } = await serviceClient
    .from('usuarios')
    .select('es_super_admin, rol, empresa_id, activo')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (perfilError) return json({ error: perfilError.message }, 500);
  if (!perfil || !perfil.activo) return json({ error: 'No autorizado' }, 403);

  const esSuperAdmin = !!perfil.es_super_admin;
  const esAdminDeEmpresa = perfil.rol === 'admin';
  if (!esSuperAdmin && !esAdminDeEmpresa) return json({ error: 'No autorizado' }, 403);

  let body: { email?: string; nombre?: string; empresaId?: string; rol?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Cuerpo inválido' }, 400);
  }
  const email = (body.email || '').trim().toLowerCase();
  const nombre = (body.nombre || '').trim();
  const empresaId = (body.empresaId || '').trim();
  const rol = (body.rol || '').trim();

  if (!email || !nombre || !empresaId) return json({ error: 'Faltan datos: correo, nombre y empresa son obligatorios' }, 400);
  if (!ROLES_VALIDOS.includes(rol)) return json({ error: 'Rol inválido' }, 400);

  // Un admin de empresa (no super-admin) solo puede invitar dentro de su propia empresa,
  // y solo como operador: crear otros administradores es exclusivo del super-admin.
  if (!esSuperAdmin && empresaId !== perfil.empresa_id) return json({ error: 'Solo puedes invitar personas a tu propia empresa' }, 403);
  if (!esSuperAdmin && rol === 'admin') return json({ error: 'Solo un super-admin puede crear cuentas de administrador' }, 403);

  const { data: empresa, error: empresaError } = await serviceClient
    .from('empresas')
    .select('id, nombre, activo')
    .eq('id', empresaId)
    .maybeSingle();
  if (empresaError) return json({ error: empresaError.message }, 500);
  if (!empresa || !empresa.activo) return json({ error: 'Empresa inválida' }, 400);

  // inviteUserByEmail crea la cuenta y manda el correo en un solo paso, usando la plantilla
  // "Invite user" de Supabase (bienvenida) en vez de "Reset Password" — antes se creaba la
  // cuenta con admin.createUser() y se disparaba resetPasswordForEmail() por separado, así que
  // a un operador recién invitado le llegaba un correo que sonaba a "recupera tu contraseña"
  // en vez de un correo de bienvenida.
  const { data: createData, error: createError } = await serviceClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: SITE_URL,
    data: { nombre },
  });
  if (createError || !createData.user) {
    const yaExiste = /already.*registered|already.*exists/i.test(createError?.message || '');
    return json({ error: yaExiste ? 'Ya existe una cuenta con ese correo' : (createError?.message || 'No se pudo crear la cuenta') }, yaExiste ? 409 : 500);
  }

  // No confiamos únicamente en el trigger handle_new_user (auth.users -> public.usuarios):
  // en la práctica, la creación del usuario puede completar sin que el trigger deje lista la
  // fila en public.usuarios a tiempo. La creamos explícitamente acá, que es la fuente de verdad.
  const { error: usuarioError } = await serviceClient
    .from('usuarios')
    .upsert({ auth_user_id: createData.user.id, nombre, rol, empresa_id: empresaId }, { onConflict: 'auth_user_id' });
  if (usuarioError) {
    // No dejamos la cuenta de Auth huérfana (p.ej. cuando el trigger chequear_limite_usuarios
    // rechaza el insert por límite de plan): sin este rollback, ese correo quedaba "quemado" —
    // un reintento posterior (incluso después de subir de plan) chocaba con "ya existe una
    // cuenta con ese correo" aunque esa cuenta nunca haya llegado a funcionar.
    const { error: deleteError } = await serviceClient.auth.admin.deleteUser(createData.user.id);
    if (deleteError) {
      return json({ error: `No se pudo crear la cuenta (${usuarioError.message}), y tampoco se pudo deshacer automáticamente: ${deleteError.message}. Contacta a soporte.` }, 500);
    }
    return json({ error: usuarioError.message }, 400);
  }

  return json({ ok: true, empresa: empresa.nombre });
});
