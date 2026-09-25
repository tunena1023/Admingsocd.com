/* ============================================================
   quickbooks-delete-doc.js — boton "Delete from QuickBooks" del tab Sent
   (25/09/2026, pedido del dueño: "un boton de delete que me pida el
   mismo pass de cuando borro todas las pruebas").

   POST { orderId, password }
   - Revisa el password de borrar (lib/wipe-password, el mismo de Wipe
     Test Data) aqui en el servidor.
   - Borra el Estimate / Invoice en QuickBooks. Si ya lo habian borrado
     alla a mano, no es error.
   - Quita la marca de "ya se mando" para que la orden regrese a Orders
     y deja la nota en el historial de la orden.
   Si QuickBooks no deja borrarlo (p. ej. un invoice con pago), no se
   toca nada y se regresa su mensaje.
============================================================ */
const { ORDER_HISTORY_LIST, createListItem, jsonResponse } = require('./lib/graph');
const { isWipePassword } = require('./lib/wipe-password');
const qb = require('./lib/quickbooks');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const orderId = String(body.orderId || '');
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
    const release = body.action === 'release';
    /* release = "Move back to Orders" cuando ya no existe en QuickBooks:
       no borra nada, asi que no pide password; el servidor confirma que
       de verdad ya no existe. */
    if (!release && !isWipePassword(body.password)) return jsonResponse(403, { error: 'Incorrect password. Nothing was deleted.', code: 'BAD_PASSWORD' });
    if (!(await qb.isConnected())) return jsonResponse(409, { error: 'QuickBooks is not connected yet.' });

    const imported = await qb.getImportedOrders();
    const entry = imported[orderId];
    if (!entry) return jsonResponse(404, { error: 'This order is not marked as sent to QuickBooks.' });
    const type = entry.type === 'invoice' ? 'invoice' : 'estimate';
    const label = (type === 'invoice' ? 'Invoice' : 'Estimate') + ' ' + (entry.docNumber || ('#' + entry.estimateId));
    if (release && entry.estimateId) {
      const found = await qb.existingDocIds(type, [entry.estimateId]);
      if (found.has(String(entry.estimateId))) return jsonResponse(409, { error: label + ' still exists in QuickBooks. Use Delete from QuickBooks instead.' });
    }

    const how = release || !entry.estimateId ? 'gone' : await qb.deleteSalesDoc(type, entry.estimateId);
    await qb.unmarkOrderImported(orderId);
    const who = (event.headers || {})['x-gs-user-email'] || 'Admin';
    await createListItem(ORDER_HISTORY_LIST, {
      Title: orderId + '-qbdelete', OrderID: orderId,
      ChangeType: 'QuickBooks ' + (type === 'invoice' ? 'Invoice' : 'Estimate') + ' Deleted',
      ChangedBy: who, ChangeDate: new Date().toISOString(),
      Notes: how === 'deleted' ? label + ' deleted in QuickBooks from Admin.' : label + ' was already gone in QuickBooks; the order can be sent again.'
    }).catch(() => {});
    return jsonResponse(200, { success: true, how, label });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
