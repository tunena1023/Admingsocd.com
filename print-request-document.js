/* ============================================================
   print-request-document.js — botón "Print" de Review.

   A diferencia de get-order-document.js (que NUNCA genera, solo
   descarga lo ya guardado), aquí SÍ se genera cada vez que se hace
   clic: es la constancia de "esto se pidió", y el historial del que
   sale es inmutable, así que dos clics producen el mismo contenido
   (solo cambia la fecha de "Issued"). Se guarda en la MISMA carpeta
   que el resto de los PDF de la orden, patrón
   "<OrderID>-request-rN.pdf", nunca se sobreescribe.

   GET /.netlify/functions/print-request-document?orderId=GS-6062-1010
============================================================ */
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { generateAndSaveRequestPdf } = require('./lib/orderpdf');

/* Mismo listado que REQUEST_TYPES en admin.html -- si un tipo nuevo se
   agrega ahi, hay que agregarlo aqui tambien para que este endpoint
   encuentre la misma fila de "lo que se pidio". */
const REQUEST_TYPES = ['Change Requested', 'Cancellation Requested',
  'Reschedule Requested', 'Change Requested by Client', 'Reactivation Requested',
  'Services Change Requested'];

async function fetchByField(listName, fieldName, value) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
  const data = await graphFetch(siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`);
  return data.value || [];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  const p = event.queryStringParameters || {};
  const orderId = String(p.orderId || '').trim();
  if (!orderId) return jsonResponse(400, { error: 'orderId is required' });

  try {
    const [orderRows, histRows, svcRows] = await Promise.all([
      fetchByField(ORDERS_LIST, 'OrderID', orderId),
      fetchByField(ORDER_HISTORY_LIST, 'OrderID', orderId),
      fetchByField(ORDER_SERVICES_LIST, 'OrderID', orderId)
    ]);
    const orderItem = orderRows.find(it => it.fields);
    if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });
    const order = Object.assign({}, orderItem.fields, { OrderID: orderId });
    const services = svcRows.filter(it => it.fields).map(it => it.fields);

    const history = histRows.filter(it => it.fields).map(it => it.fields)
      .sort((a, b) => String(a.ChangeDate || '').localeCompare(String(b.ChangeDate || '')));

    /* Misma logica que approvalDetailHtml() en admin.html: la ultima
       fila del historial que sea un tipo de solicitud, una
       cancelacion, o (para una orden nueva desde oficina) 'Created'. */
    let req = null;
    for (let i = history.length - 1; i >= 0; i--) {
      const t = String(history[i].ChangeType || '');
      if (REQUEST_TYPES.includes(t) || t === 'Cancellation Requested' || t === 'Created') {
        req = history[i];
        break;
      }
    }
    if (!req) {
      return jsonResponse(404, { error: 'No pending request found in this order\'s history.' });
    }

    const result = await generateAndSaveRequestPdf({ order, request: req, history, services });
    if (!result.ok) return jsonResponse(500, { error: result.error });

    /* Sirve el PDF recien generado directo (ya lo tenemos en memoria,
       generateAndSaveRequestPdf lo regresa junto con el resultado),
       para que window.open() lo muestre de inmediato. */
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="' + result.fileName + '"',
        'Cache-Control': 'no-store'
      },
      body: result.buffer.toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
