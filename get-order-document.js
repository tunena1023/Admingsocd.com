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

/* Este endpoint se abre DIRECTO en una pestana nueva via window.open()
   -- nunca a traves de un fetch() que interprete la respuesta. Un
   jsonResponse() normal aqui se ve como texto JSON crudo pegado en la
   pantalla ('{"error":"..."}'), sin ningun formato -- confuso, parece
   que la pagina se rompio. htmlErrorResponse() da el mismo status
   code pero como una pagina HTML simple y legible. */
function htmlErrorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: '<!DOCTYPE html><html><head><title>Document unavailable</title>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
      '<body style="font-family:Arial,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#333;text-align:center">' +
      '<p style="font-size:15px;line-height:1.6">' + message.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</p>' +
      '</body></html>'
  };
}

async function findOrder(orderId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  const url = siteListPath(ORDERS_LIST) + `?$expand=fields&$top=5&$filter=${filter}`;
  const data = await graphFetch(url);
  const item = (data.value || []).find(it => it.fields);
  return item ? item.fields : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return htmlErrorResponse(405, 'Method not allowed.');
  }
  const p = event.queryStringParameters || {};
  const orderId = String(p.orderId || '').trim();
  if (!orderId) return htmlErrorResponse(400, 'orderId is required.');

  try {
    const order = await findOrder(orderId);
    if (!order) return htmlErrorResponse(404, 'Order not found.');

    if (p.clientId &&
        String(order.ClientID || '').trim().toLowerCase() !==
        String(p.clientId).trim().toLowerCase()) {
      return htmlErrorResponse(403, 'This order does not belong to you.');
    }

    const found = await latestOrderPdf(Object.assign({}, order, { OrderID: orderId }));
    if (!found) {
      return htmlErrorResponse(404, 'No document available yet. It is created once the order is approved.');
    }

    if (p.meta) {
      return jsonResponse(200, {
        document: { name: found.name, revision: found.revision, webUrl: found.webUrl }
      });
    }

    const buffer = await downloadById(found.id);
    if (!buffer || buffer.length > MAX_BYTES) {
      return htmlErrorResponse(413, 'The document is too large to be served.');
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
    return htmlErrorResponse(500, 'Something went wrong loading this document: ' + err.message);
  }
};
