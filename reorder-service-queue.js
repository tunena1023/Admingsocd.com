/* ============================================================
   reorder-service-queue.js — guarda el orden nuevo de los servicios
   de una orden en modo "Assign by service" (21/09/2026, aprobado
   desde el mini interactivo -- arrastrar en desktop, subir/bajar en
   mobile).

   Sequence vive en ServiceAssignments -- un servicio que TODAVIA no
   se ha programado no tiene renglon ahi todavia, asi que se le crea
   uno "en blanco" (solo Category/ServiceName/Sequence, sin
   AssignedTo/ScheduledDate) nomas para poder guardar su lugar en la
   cola. save-service-assignment.js ya sabe encontrar y ACTUALIZAR
   ese mismo renglon (no crea uno duplicado) en cuanto ese servicio
   de verdad se programe.

   Mismo criterio del mini: reordenar mientras NADIE tiene gente
   asignada todavia es solo acomodar la cola -- no deja rastro en el
   historial. En cuanto AL MENOS uno ya tiene gente, si se registra
   (ya afecta trabajo de verdad).
============================================================ */
const {
  SERVICE_ASSIGNMENTS_LIST, ORDER_HISTORY_LIST,
  graphFetch, siteListPath, createListItem, updateListItemByItemId, jsonResponse
} = require('./lib/graph');

async function fetchByOrderId(listName, orderId, honorNonIndexed) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  let url = siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const out = [];
  const opts = honorNonIndexed ? { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } } : {};
  while (url) {
    const data = await graphFetch(url, opts);
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
    if (!Array.isArray(b.order) || !b.order.length) return jsonResponse(400, { error: 'order (array) is required' });
    if (!b.changedBy) return jsonResponse(400, { error: 'changedBy is required' });

    const assignmentRows = await fetchByOrderId(SERVICE_ASSIGNMENTS_LIST, b.orderId, true);
    const byKey = {};
    assignmentRows.forEach(it => {
      if (!it.fields) return;
      byKey[(it.fields.Category || '') + '|' + (it.fields.ServiceName || '')] = it;
    });

    await Promise.all(b.order.map((s, i) => {
      const k = (s.category || '') + '|' + (s.serviceName || '');
      const match = byKey[k];
      if (match) {
        return updateListItemByItemId(SERVICE_ASSIGNMENTS_LIST, match.id, { Sequence: i + 1 });
      }
      return createListItem(SERVICE_ASSIGNMENTS_LIST, {
        Title: s.serviceName || '', OrderID: b.orderId, Category: s.category || '', ServiceName: s.serviceName || '',
        Sequence: i + 1, AssignedTo: '', WorkStatus: 'Not Started'
      });
    }));

    const anyAssigned = assignmentRows.some(it => it.fields && it.fields.AssignedTo);
    if (anyAssigned) {
      await createListItem(ORDER_HISTORY_LIST, {
        Title: b.orderId + '-svc-reorder-' + Date.now(), OrderID: b.orderId, ChangeType: 'Service Order Changed',
        ChangedBy: b.changedBy, ChangeDate: new Date().toISOString(), Notes: '',
        NewValue: JSON.stringify({ order: b.order.map(s => s.serviceName) })
      });
    }

    return jsonResponse(200, { success: true, orderId: b.orderId });
  } catch (err) {
    console.error('reorder-service-queue.js error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
