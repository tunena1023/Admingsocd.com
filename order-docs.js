/* ============================================================
   order-docs.js -- documentos de una orden desde Admin (25/09/2026).
   La logica vive en lib/order-docs.js (misma en los 3 repos). La
   oficina puede subir, ver y borrar cualquier documento.

   action: 'start-upload' { orderId, fileName, size } -> { uploadUrl }
           'finish-upload' { orderId, itemId, fileName, actorName } -> { doc, clientLabel }
           'view'   { orderId, docId } -> { viewUrl, downloadUrl }
           'delete' { orderId, docId }
   email lo pone el router (token de Microsoft verificado).
============================================================ */
const graph = require('./lib/graph');
const orderDocs = require('./lib/order-docs');
const { jsonResponse } = graph;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    const orderId = String(b.orderId || '').trim();
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
    const order = await orderDocs.findOrder(graph, orderId);
    if (!order) return jsonResponse(404, { error: 'Order not found.' });

    if (b.action === 'start-upload') {
      return jsonResponse(200, await orderDocs.startUpload(graph, order, b.fileName, b.size));
    }
    if (b.action === 'finish-upload') {
      const who = String(b.actorName || '').trim() || String(b.email || '').trim() || 'GS Solutions';
      const doc = await orderDocs.finishUpload(graph, order, String(b.itemId || ''), b.fileName, 'Office', who);
      return jsonResponse(200, { doc, clientLabel: [[order.ClientID, order.BusinessName].filter(Boolean).join(' - '), order.UnitNumber ? 'Unit ' + order.UnitNumber : ''].filter(Boolean).join(' · ') });
    }

    const row = await orderDocs.getRow(graph, String(b.docId || ''));
    if (!row || orderDocs.orderIdOf(row) !== orderId) return jsonResponse(404, { error: 'Document not found.' });
    if (b.action === 'view') return jsonResponse(200, await orderDocs.viewUrls(graph, row));
    if (b.action === 'delete') {
      await orderDocs.deleteDoc(graph, row);
      return jsonResponse(200, { success: true });
    }
    return jsonResponse(400, { error: 'Unknown action.' });
  } catch (e) {
    return jsonResponse(e.status || 500, { error: e.message });
  }
};
