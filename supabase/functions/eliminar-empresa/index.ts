import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// Dar de baja una empresa (Joel, 21/10/2026): borra TODO lo suyo — fotos, datos y cuentas de
// acceso — y deja constancia en empresas_eliminadas. Solo un súper admin, solo una empresa ya
// desactivada, con su nombre escrito exacto, y nunca la propia ni una que tenga un súper admin.
//
// Trabaja por tandas y con un tope de tiempo por llamada: devuelve {terminado:false} y la app la
// vuelve a llamar hasta {terminado:true}. Cada llamada sigue donde quedó la anterior (lo ya borrado
// no se encuentra de nuevo), así que si una se corta basta con volver a llamarla. Lo destapó el
// borrado a mano de las empresas de prueba del 21/10/2026: en una sola transacción el SQL Editor
// se desconectó a mitad de camino y no se borró nada.
//
// Sin borrado en cascada desde la base: las claves foráneas a empresas son sin acción, a propósito.
// El orden de abajo va de las tablas hijas a las padres.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'fotos-inventario';

// Tope de tiempo por llamada: holgado bajo el límite de la Edge Function y de cualquier proxy.
const PRESUPUESTO_MS = 20000;
// Filas por tanda. Los id viajan en la URL (in.(...)): 300 uuid son ~11.000 caracteres, bajo el
// límite de ~24.000 medido (CLAUDE.md). Los conteos tienen triggers por fila (último conteo del
// material, auditoría), por eso van en tandas más chicas.
const LOTE = 300;
const LOTE_CONTEOS = 200;

// De hijas a padres. Las tablas sin empresa_id (conteo_fotos, plan_semanal_skus) se van en
// cascada con su padre.
const TABLAS = [
  'movimiento_fotos',
  'movimientos_bodega',
  'documentos_bodega',
  'reservas_lineas',
  'reservas',
  'ordenes_compra_lineas',
  'ordenes_compra',
  'proveedores',
  'personas_retiro',
  'conteos',
  'plan_semanal_exclusiones',
  'plan_semanal_incluidos',
  'plan_semanal',
  'informes_ciclo',
  'historial_ciclos_grupo',
  'skus_grupos_conteo',
  'grupos_conteo',
  'ciclos_conteo',
  'cargas_masivas',
  'responsables_proceso',
  'tickets',
  'ubicaciones_historial',
  'ubicaciones',
  'skus',
  'duenos_stock',
];

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

// Una tanda de una tabla: lee hasta `lote` id de la empresa y los quita. Devuelve cuántos quitó.
async function tanda(db: SupabaseClient, tabla: string, empresaId: string, lote: number): Promise<number> {
  const { data, error } = await db.from(tabla).select('id').eq('empresa_id', empresaId).limit(lote);
  if (error) throw new Error(`${tabla}: ${error.message}`);
  const ids = (data || []).map((f: { id: string }) => f.id);
  if (!ids.length) return 0;
  const { error: errorBorrar } = await db.from(tabla).delete().in('id', ids);
  if (errorBorrar) throw new Error(`${tabla}: ${errorBorrar.message}`);
  return ids.length;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  const inicio = Date.now();
  const queda = () => PRESUPUESTO_MS - (Date.now() - inicio);

  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Falta autenticación' }, 401);
  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data: authData, error: authError } = await anonClient.auth.getUser(jwt);
  if (authError || !authData.user) return json({ error: 'Sesión inválida' }, 401);

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: perfil, error: perfilError } = await db
    .from('usuarios')
    .select('id, nombre, es_super_admin, empresa_id, activo')
    .eq('auth_user_id', authData.user.id)
    .maybeSingle();
  if (perfilError) return json({ error: perfilError.message }, 500);
  if (!perfil || !perfil.activo || !perfil.es_super_admin) return json({ error: 'Solo un súper admin puede dar de baja una empresa' }, 403);

  let body: { empresaId?: string; nombre?: string; resumen?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'Cuerpo inválido' }, 400); }
  const empresaId = (body.empresaId || '').trim();
  const nombre = (body.nombre || '').trim();
  if (!empresaId || !nombre) return json({ error: 'Faltan la empresa y su nombre' }, 400);
  if (empresaId === perfil.empresa_id) return json({ error: 'No puedes dar de baja tu propia empresa' }, 400);

  const { data: empresa, error: empresaError } = await db
    .from('empresas').select('id, nombre, activo').eq('id', empresaId).maybeSingle();
  if (empresaError) return json({ error: empresaError.message }, 500);
  if (!empresa) {
    // Ya no existe. Si la dio de baja una llamada anterior (queda su constancia), puede faltar
    // terminar su auditoría: se sigue con eso. Si no hay constancia, el id no es de una empresa.
    const { count: constancias, error: errorConstancia } = await db
      .from('empresas_eliminadas').select('id', { count: 'exact', head: true }).eq('empresa_id', empresaId);
    if (errorConstancia) return json({ error: errorConstancia.message }, 500);
    if (!constancias) return json({ error: 'La empresa no existe' }, 404);
    const borradasAuditoria: Record<string, number> = {};
    try {
      while (true) {
        if (queda() <= 0) return json({ terminado: false, fase: 'auditoria', borradas: borradasAuditoria });
        const n = await tanda(db, 'auditoria', empresaId, LOTE);
        if (n) borradasAuditoria.auditoria = (borradasAuditoria.auditoria || 0) + n;
        if (n < LOTE) break;
      }
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
    return json({ terminado: true, yaEliminada: true, borradas: borradasAuditoria });
  }
  if (empresa.nombre.trim() !== nombre) return json({ error: 'El nombre escrito no coincide con el de la empresa' }, 400);
  if (empresa.activo) return json({ error: 'Primero desactiva la empresa: solo se puede dar de baja una empresa inactiva' }, 400);

  const { count: superAdmins, error: saError } = await db
    .from('usuarios').select('id', { count: 'exact', head: true }).eq('empresa_id', empresaId).eq('es_super_admin', true);
  if (saError) return json({ error: saError.message }, 500);
  if (superAdmins) return json({ error: 'Esta empresa tiene un súper admin: no se puede dar de baja' }, 400);

  const borradas: Record<string, number> = {};
  const sumar = (clave: string, n: number) => { if (n) borradas[clave] = (borradas[clave] || 0) + n; };
  const pausa = (fase: string) => json({ terminado: false, fase, borradas });

  try {
    // 1. Fotos: con la API de Storage (la base no deja quitarlas con SQL).
    while (queda() > 0) {
      const { data: rutas, error } = await db.rpc('fotos_empresa', { p_empresa: empresaId, p_limite: 1000 });
      if (error) throw new Error(`fotos: ${error.message}`);
      const lista = (rutas || []) as string[];
      if (!lista.length) break;
      for (let i = 0; i < lista.length && queda() > 0; i += 100) {
        const parte = lista.slice(i, i + 100);
        const { data: quitadas, error: errorFotos } = await db.storage.from(BUCKET).remove(parte);
        if (errorFotos) throw new Error(`fotos: ${errorFotos.message}`);
        // Si Storage no quitó ninguna, la próxima vuelta las volvería a encontrar: se corta acá en
        // vez de dar vueltas sin avanzar.
        if (!quitadas || !quitadas.length) throw new Error('fotos: Storage no quitó ninguna de la tanda');
        sumar('fotos', quitadas.length);
      }
    }
    if (queda() <= 0) return pausa('fotos');

    // 2. Documentos de bodega que apuntan a otro documento (una devolución a su despacho): se
    //    sueltan primero, si no el documento de origen no se puede quitar antes que el que lo cita.
    const { error: errorOrigen } = await db.from('documentos_bodega')
      .update({ documento_origen_id: null }).eq('empresa_id', empresaId).not('documento_origen_id', 'is', null);
    if (errorOrigen) throw new Error(`documentos_bodega: ${errorOrigen.message}`);

    // 3. Datos, de hijas a padres.
    for (const tabla of TABLAS) {
      const lote = tabla === 'conteos' ? LOTE_CONTEOS : LOTE;
      while (true) {
        if (queda() <= 0) return pausa(tabla);
        const n = await tanda(db, tabla, empresaId, lote);
        sumar(tabla, n);
        if (n < lote) break;
      }
    }

    // 4. Cuentas de acceso (Auth) y sus usuarios. Borrar la cuenta deja usuarios.auth_user_id en
    //    null (la clave foránea lo hace sola); después se quitan los usuarios.
    const { data: cuentas, error: errorCuentas } = await db
      .from('usuarios').select('auth_user_id').eq('empresa_id', empresaId).not('auth_user_id', 'is', null);
    if (errorCuentas) throw new Error(`usuarios: ${errorCuentas.message}`);
    for (const c of cuentas || []) {
      if (queda() <= 0) return pausa('cuentas');
      const { error } = await db.auth.admin.deleteUser(c.auth_user_id);
      if (error && !/not.?found/i.test(error.message)) throw new Error(`cuenta: ${error.message}`);
      sumar('cuentas', 1);
    }
    while (true) {
      if (queda() <= 0) return pausa('usuarios');
      const n = await tanda(db, 'usuarios', empresaId, LOTE);
      sumar('usuarios', n);
      if (n < LOTE) break;
    }

    // 5. Los cobros de Flow se conservan (son registros contables): quedan sin empresa.
    const { error: errorFlow } = await db.from('flow_eventos').update({ empresa_id: null }).eq('empresa_id', empresaId);
    if (errorFlow) throw new Error(`flow_eventos: ${errorFlow.message}`);

    // 6. La constancia de la baja, y recién después la empresa y su auditoría (los borrados de
    //    arriba también dejaron auditoría con esta empresa).
    const { error: errorRegistro } = await db.from('empresas_eliminadas').insert({
      empresa_id: empresaId, nombre: empresa.nombre, eliminada_por: perfil.id,
      eliminada_por_nombre: perfil.nombre, resumen: body.resumen ?? null,
    });
    if (errorRegistro) throw new Error(`empresas_eliminadas: ${errorRegistro.message}`);
    const { error: errorEmpresa } = await db.from('empresas').delete().eq('id', empresaId);
    if (errorEmpresa) throw new Error(`empresas: ${errorEmpresa.message}`);
    while (true) {
      // La empresa ya no está; la próxima llamada sigue con su auditoría (ver arriba, !empresa).
      if (queda() <= 0) return pausa('auditoria');
      const n = await tanda(db, 'auditoria', empresaId, LOTE);
      sumar('auditoria', n);
      if (n < LOTE) break;
    }
    return json({ terminado: true, borradas });
  } catch (e) {
    return json({ error: (e as Error).message, borradas }, 500);
  }
});
