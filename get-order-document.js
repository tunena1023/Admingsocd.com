/* ============================================================
   get-order-document.js — genera y entrega SIEMPRE la version mas
   reciente del PDF de una orden.

   A peticion del dueño (19/09/2026: "si el PDF que existe es
   igualito, se toma el existente -- pero si hay una sola linea de
   informacion que el PDF que existe NO tenga, se hace uno nuevo").
   Se intento primero comparar por fecha (lastModifiedDateTime de la
   orden contra la fecha de creacion del PDF guardado), pero eso solo
   detecta si la ORDEN cambio -- no detecta cuando el FORMATO del
   documento cambia (ej. un dia como hoy, con un monton de cambios al
   PDF mientras ninguna orden en si se toco): el PDF viejo se seguia
   sirviendo, incompleto, sin que nada lo detectara.

   Por eso este endpoint ya NO intenta detectar "cambio o no cambio"
   -- siempre pide los datos frescos y genera un documento nuevo (lo
   guarda con la revision que le toque, igual que siempre) en cada
   peticion. Es la unica forma de garantizar, sin excepcion, que nunca
   se sirva algo incompleto o desactualizado -- el costo es que cada
   clic en Print crea una revision nueva en SharePoint, aunque el
   contenido resulte identico al anterior.

   Con ?kind=completion genera ese documento en su lugar (mismo
   mecanismo, distinto patron de archivo); ?kind=request nunca se
   genera aqui -- Review genera ese siempre fresco por su cuenta
   (print-request-document.js).

   GET /.netlify/functions/get-order-document?orderId=GS-6062-1010
   GET /.netlify/functions/get-order-document?orderId=GS-6062-1010&kind=completion
============================================================ */
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const {
  generateAndSaveOrderPdf, generateAndSaveCompletionPdf,
  fetchOrderPhotoBuffers
} = require('./lib/orderpdf');

const ALLOWED_KINDS = ['completion', 'request'];

async function findOrder(orderId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  const url = siteListPath(ORDERS_LIST) + `?$expand=fields&$top=5&$filter=${filter}`;
  const data = await graphFetch(url);
  const item = (data.value || []).find(it => it.fields);
  return item ? item.fields : null;
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

    /* BUG REAL corregido (19/09/2026, reportado por el dueño): la
       version anterior de esto comparaba lastModifiedDateTime del
       renglon de la orden contra la fecha de creacion del PDF
       guardado -- pero eso solo detecta si la ORDEN cambio, no si el
       FORMATO del documento cambio (como hoy, con un monton de
       cambios al PDF mientras la orden en si no se toco -- el PDF
       viejo se quedaba sirviendo, incompleto, sin que nada lo
       detectara). El dueño lo dijo claro: "si el PDF que existe es
       igualito, se toma el existente -- pero si hay una sola linea de
       informacion que el PDF que existe NO tenga, se hace uno nuevo".
       Comparar el CONTENIDO de verdad (no una fecha) para decidir
       "es igualito" es mucho mas complicado -- necesitaria guardar
       una huella del contenido en alguna parte para comparar despues.
       Por ahora, mientras se decide si vale la pena esa complejidad:
       SIEMPRE se regenera -- la unica forma de garantizar, sin
       excepcion, que nunca se sirva algo incompleto o desactualizado.
       El costo: cada clic en Print crea una revision nueva en
       SharePoint, aunque el contenido resulte identico al anterior. */
    if (kind === 'request') {
      return jsonResponse(400, { error: 'kind=request is not generated here.' });
    }

    let result;
    if (kind === 'completion') {
      const [freshSvc, freshHist, photos] = await Promise.all([
        fetchByField(ORDER_SERVICES_LIST, 'OrderID', orderId),
        fetchByField(ORDER_HISTORY_LIST, 'OrderID', orderId),
        fetchOrderPhotoBuffers(merged)
      ]);
      result = await generateAndSaveCompletionPdf({
        order: merged,
        services: freshSvc,
        history: freshHist.sort((a, b) => new Date(a.ChangeDate || 0) - new Date(b.ChangeDate || 0)),
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
