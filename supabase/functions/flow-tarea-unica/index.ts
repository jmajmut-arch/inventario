// Tarea de un solo uso, ya cumplida e inerte. El 05/10/2026 (pedido de Joel) canceló de
// inmediato la suscripción de prueba de $500 de Minera Test (sus_hc87191242, Flow la dejó en
// status 4 a las 09:16) y leyó de Flow el cobro del 03/10, lo que mostró que el pago de una
// suscripción trae la suscripción en commerceOrder ("sus_xxx_<invoiceId>_<fecha>"); con eso se
// arregló flow-webhook-cobro. Queda desplegada así porque el MCP de Supabase no borra funciones:
// bórrala desde el dashboard (Edge Functions → flow-tarea-unica → Delete) cuando quieras.
Deno.serve(() => new Response(JSON.stringify({ error: 'Tarea ya cumplida (05/10/2026)' }), {
  status: 410,
  headers: { 'Content-Type': 'application/json' },
}));
