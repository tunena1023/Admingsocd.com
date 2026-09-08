/* ============================================================
   get-order-document.js — entrega el PDF YA GUARDADO de una orden.

   REGLA: imprimir NUNCA genera el documento. Este endpoint solo
   descarga el archivo que se guardo al aprobar (o en la ultima
   revision). Si no existe, la orden no ha sido aprobada y se
   responde 404 para que el front deshabilite el boton.

   GET /.netlify/functions/get-order-document?orderId=GS-6062-1010
       &clientId=GS-6062   (opcional; si viene, se valida el dueno)
       &meta=1             (solo datos, sin bajar el archivo)
============================================================ */
const {
  ORDERS_LIST, graphFetch, siteListPath, downloadById, jsonResponse
} = require('./lib/graph');
const { latestOrderPdf } = require('./lib/orderpdf');

const MAX_BYTES = 4.5 * 1024 * 1024;   /* tope de Netlify Functions */

async function findOrder(orderId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  const url = siteListPath(ORDERS_LIST) + `?$expand=fields&$top=5&$filter=${filter}`;
  const data = await graphFetch(url);
  const item = (data.value || []).find(it => it.fields);
  return item ? item.fields : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  const p = event.queryStringParameters || {};
  const orderId = String(p.orderId || '').trim();
  if (!orderId) return jsonResponse(400, { error: 'orderId is required' });

  try {
    const order = await findOrder(orderId);
    if (!order) return jsonResponse(404, { error: 'Order not found.' });

    if (p.clientId &&
        String(order.ClientID || '').trim().toLowerCase() !==
        String(p.clientId).trim().toLowerCase()) {
      return jsonResponse(403, { error: 'This order does not belong to you.' });
    }

    const found = await latestOrderPdf(Object.assign({}, order, { OrderID: orderId }));
    if (!found) {
      return jsonResponse(404, {
        error: 'No document available yet. It is created once the order is approved.'
      });
    }

    if (p.meta) {
      return jsonResponse(200, {
        document: { name: found.name, revision: found.revision, webUrl: found.webUrl }
      });
    }

    const buffer = await downloadById(found.id);
    if (!buffer || buffer.length > MAX_BYTES) {
      return jsonResponse(413, { error: 'The document is too large to be served.' });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="' + found.name + '"',
        'Cache-Control': 'no-store'
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
