/* ============================================================
   toggle-assign-by-service.js — prende/apaga "Assign by service" en
   una orden (columna AssignByService en Orders, 21/09/2026).

   Una vez prendido, el dueño confirmó que NO se debe poder apagar
   otra vez hasta que el primer servicio quede completado (mismo
   candado ya aprobado en el mini) -- ese candado se aplica del lado
   del CLIENTE (el boton mismo se deshabilita, ver admin.html), pero
   se revisa TAMBIEN aqui del lado del servidor, para que nadie lo
   rodee llamando este endpoint directo. Prender no tiene ninguna
   restriccion.
============================================================ */
const {
  ORDERS_LIST, SERVICE_ASSIGNMENTS_LIST,
  graphFetch, siteListPath, updateListItemByItemId, jsonResponse
} = require('./lib/graph');

async function fetchByOrderId(listName, orderId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  let url = siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.orderId) return jsonResponse(400, { error: 'orderId is required' });
    if (typeof b.on !== 'boolean') return jsonResponse(400, { error: 'on must be true or false' });

    const orderRows = await fetchByOrderId(ORDERS_LIST, b.orderId);
    const orderItem = orderRows.find(it => it.fields && (it.fields.OrderID || it.fields.Title) === b.orderId);
    if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });

    if (b.on === false) {
      const already = orderItem.fields.AssignByService === true || orderItem.fields.AssignByService === 'true';
      if (already) {
        const assignmentRows = await fetchByOrderId(SERVICE_ASSIGNMENTS_LIST, b.orderId);
        const anyCompleted = assignmentRows.some(it => it.fields && it.fields.WorkStatus === 'Completed');
        if (anyCompleted) {
          return jsonResponse(400, { error: 'Cannot turn off Assign by service once a service has been completed on this order.' });
        }
      }
    }

    await updateListItemByItemId(ORDERS_LIST, orderItem.id, { AssignByService: b.on });
    return jsonResponse(200, { success: true, orderId: b.orderId, on: b.on });
  } catch (err) {
    console.error('toggle-assign-by-service.js error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
