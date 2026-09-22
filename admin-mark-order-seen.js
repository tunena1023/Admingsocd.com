/* ============================================================
   admin-mark-order-seen.js — registra que ESTE usuario (viewerId, su
   email de Admin) acaba de abrir esta orden. Se llama al abrir la
   tarjeta (toggleOrder/toggleApprCard/etc.), no antes.

   Ver gsocd-shared/lib/seen-tracking.js para el criterio completo de
   "sin ver" (compara esto contra lastModifiedDateTime de la orden).

   OrderSeenBy no esta indexada por columna (lista nueva) -- se
   consulta con el header que el propio Graph pide para columnas sin
   indexar (mismo criterio ya usado en get-order-detail.js para
   ServiceAssignments).
============================================================ */

const {
  ORDER_SEEN_BY_LIST,
  siteListPath, graphFetch, createListItem, updateListItemByItemId, jsonResponse
} = require('./lib/graph');

async function findExisting(orderId, viewerId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}' and fields/ViewerId eq '${viewerId}'`);
  const url = siteListPath(ORDER_SEEN_BY_LIST) + `?$expand=fields&$top=1&$filter=${filter}`;
  const data = await graphFetch(url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
  return (data.value || [])[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    const orderId = String(b.orderId || '').trim();
    const viewerId = String(b.viewerId || '').trim();
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
    if (!viewerId) return jsonResponse(400, { error: 'viewerId is required' });

    const now = new Date().toISOString();
    const existing = await findExisting(orderId, viewerId);
    if (existing) {
      await updateListItemByItemId(ORDER_SEEN_BY_LIST, existing.id, { SeenAt: now });
    } else {
      await createListItem(ORDER_SEEN_BY_LIST, {
        Title: orderId + ' — ' + viewerId,
        OrderID: orderId,
        ViewerId: viewerId,
        SeenAt: now
      });
    }
    return jsonResponse(200, { success: true, seenAt: now });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
