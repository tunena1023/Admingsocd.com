/* ============================================================
   get-order-document.js — entrega la version MAS RECIENTE del PDF
   de una orden.

   A peticion del dueño (19/09/2026: "el boton de Print debe imprimir
   la version mas reciente de la orden -- si la orden cambio desde
   que se genero el primer documento, se genera uno nuevo, y esas son
   las revisiones") -- este endpoint regenera sobre la marcha (lo
   guarda igual que siempre, con la revision que le toque, y lo sirve
   de inmediato) en 2 casos:
     1. No existe ningun documento guardado todavia (se borro del
        drive, o nunca se genero).
     2. Si existe uno, pero la orden se modifico DESPUES de que ese
        archivo se creo (compara lastModifiedDateTime del renglon de
        la orden contra la fecha de creacion del PDF) -- ese PDF ya
        quedo desactualizado.
   Fuera de esos 2 casos, sirve el archivo ya guardado tal cual, sin
   generar nada de mas.

   Con ?kind=completion aplica lo mismo para ese documento en su
   lugar (mismo mecanismo, distinto patron de archivo); ?kind=request
   solo sirve lo ya guardado, nunca regenera aqui -- Review genera ese
   siempre fresco por su cuenta (print-request-document.js).

   GET /.netlify/functions/get-order-document?orderId=GS-6062-1010
   GET /.netlify/functions/get-order-document?orderId=GS-6062-1010&kind=completion
============================================================ */
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  graphFetch, siteListPath, downloadById, jsonResponse
} = require('./lib/graph');
const {
  latestOrderPdf, generateAndSaveOrderPdf, generateAndSaveCompletionPdf,
  fetchOrderPhotoBuffers
} = require('./lib/orderpdf');

const MAX_BYTES = 4.5 * 1024 * 1024;   /* tope de Netlify Functions */
const ALLOWED_KINDS = ['completion', 'request'];

async function findOrder(orderId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  const url = siteListPath(ORDERS_LIST) + `?$expand=fields&$top=5&$filter=${filter}`;
  const data = await graphFetch(url);
  const item = (data.value || []).find(it => it.fields);
  if (!item) return null;
  /* lastModifiedDateTime vive en el renglon mismo (fuera de fields) --
     se necesita para saber si la orden cambio desde que se genero el
     ultimo PDF guardado. */
  return Object.assign({}, item.fields, { _lastModified: item.lastModifiedDateTime || '' });
}

async function fetchByField(listName, fieldName, value) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
  let url = siteListPath(listName) + `?$expand=fields&$top=500&$filter=${filter}`;
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []).filter(it => it.fields).map(it => it.fields));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  const p = event.queryStringParameters || {};
  const orderId = String(p.orderId || '').trim();
  const kindParam = String(p.kind || '').trim();
  const kind = ALLOWED_KINDS.includes(kindParam) ? kindParam : undefined;
  if (!orderId) return jsonResponse(400, { error: 'orderId is required' });

  try {
    const order = await findOrder(orderId);
    if (!order) return jsonResponse(404, { error: 'Order not found.' });

    const merged = Object.assign({}, order, { OrderID: orderId });
    let found = await latestOrderPdf(merged, kind);

    /* A peticion del dueño (19/09/2026): "el boton de Print debe
       imprimir la version mas reciente de la orden -- si la orden
       cambio desde que se genero el ultimo documento, se genera uno
       nuevo, y esas son las revisiones". Se compara cuando se
       modifico la orden por ultima vez (lastModifiedDateTime del
       renglon) contra cuando se creo el archivo PDF guardado -- si la
       orden es mas nueva, ese PDF ya quedo desactualizado, se trata
       como si no existiera y se regenera mas abajo. No aplica a
       'request' -- Review ya genera ese siempre fresco por su cuenta. */
    if (found && kind !== 'request' && order._lastModified && found.createdDateTime) {
      const orderModified = new Date(order._lastModified).getTime();
      const pdfCreated = new Date(found.createdDateTime).getTime();
      if (!isNaN(orderModified) && !isNaN(pdfCreated) && orderModified > pdfCreated) {
        found = null;
      }
    }

    if (found) {
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
    }

    /* Nada guardado -- generar sobre la marcha (excepto 'request',
       que Review siempre genera fresco por su cuenta). */
    if (kind === 'request') {
      return jsonResponse(404, { error: 'No document available yet.' });
    }

    let result;
    if (kind === 'completion') {
      const [freshSvc, photos] = await Promise.all([
        fetchByField(ORDER_SERVICES_LIST, 'OrderID', orderId),
        fetchOrderPhotoBuffers(merged)
      ]);
      result = await generateAndSaveCompletionPdf({
        order: merged,
        services: freshSvc,
        photos: photos,
        completedBy: order.Technician || order.Supervisor || '',
        completedAt: order.CompletedDate || new Date().toISOString()
      });
    } else {
      const [freshSvc, freshHist] = await Promise.all([
        fetchByField(ORDER_SERVICES_LIST, 'OrderID', orderId),
        fetchByField(ORDER_HISTORY_LIST, 'OrderID', orderId)
      ]);
      result = await generateAndSaveOrderPdf({
        order: merged,
        services: freshSvc,
        history: freshHist.sort((a, b) =>
          new Date(a.ChangeDate || 0) - new Date(b.ChangeDate || 0))
      });
    }

    if (!result.ok) {
      return jsonResponse(500, { error: 'Could not generate the document: ' + result.error });
    }
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
