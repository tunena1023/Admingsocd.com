/* ============================================================
   cron-recurring-orders.js -- lo llama Vercel Cron una vez al dia
   (ver vercel.json). Dos pasos, en orden:
     1. promoteDueRecurringOrders(): asciende a 'Received' las que
        ya les toca (esto primero, para que una visita de HOY no se
        cuente como "ya cubierta" del lado equivocado antes de
        generarse la siguiente).
     2. ensureRecurringOrders(): rellena el colchon de 30 dias por
        cada contrato activo.

   Seguridad: Vercel manda "Authorization: Bearer <CRON_SECRET>" en
   cada llamada real de un Cron Job -- se verifica esa cabecera para
   que nadie mas pueda disparar esto solo conociendo la URL. Requiere
   la variable de entorno CRON_SECRET en Vercel (mismo valor que se le
   da de alta al proyecto).
============================================================ */
const { jsonResponse } = require('./lib/graph');
const { ensureRecurringOrders, promoteDueRecurringOrders } = require('./lib/recurring-orders');

exports.handler = async (event) => {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const expected = 'Bearer ' + (process.env.CRON_SECRET || '');
  if (!process.env.CRON_SECRET || auth !== expected) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  try {
    const promoted = await promoteDueRecurringOrders();
    const generated = await ensureRecurringOrders();
    return jsonResponse(200, { success: true, promoted, generated });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
