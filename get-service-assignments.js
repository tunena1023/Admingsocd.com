/* ============================================================
   get-service-assignments.js — trae los renglones de
   ServiceAssignments de una orden (21/09/2026, "Assign by service").
   Uno por servicio que ya tiene su propia asignacion -- un servicio
   sin renglon aqui todavia no se ha programado.
============================================================ */
const { SERVICE_ASSIGNMENTS_LIST, graphFetch, siteListPath, jsonResponse } = require('./lib/graph');

/* BUG REAL encontrado en produccion (21/09/2026, con captura real del
   dueño): Graph API rechaza filtrar por OrderID en ServiceAssignments
   -- 'Field OrderID cannot be referenced in filter... as it is not
   indexed'. Las listas viejas (OrderServices/OrderHistory/Orders) ya
   tenian su columna OrderID indexada de antes; esta lista es nueva y
   nunca se indexo. Arreglo INMEDIATO aqui (el header que el mismo
   error de Graph sugiere, HonorNonIndexedQueriesWarningMayFailRandomly)
   para no depender de que alguien entre a SharePoint ahorita mismo --
   el arreglo de FONDO sigue siendo indexar la columna OrderID en
   ServiceAssignments (List Settings > Indexed columns), que el dueño
   ya sabe que hace falta. Sin indice, Graph mismo avisa que estas
   consultas pueden fallar si la lista crece mucho -- aceptable por
   ahora, no para siempre. */
async function fetchByOrderId(listName, orderId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  let url = siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const out = [];
  while (url) {
    const data = await graphFetch(url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
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

    const rows = await fetchByOrderId(SERVICE_ASSIGNMENTS_LIST, b.orderId);
    const assignments = rows.map(it => ({
      itemId: it.id,
      Category: it.fields.Category || '',
      ServiceName: it.fields.ServiceName || '',
      Sequence: it.fields.Sequence != null ? Number(it.fields.Sequence) : null,
      AssignedTo: it.fields.AssignedTo || '',
      ScheduledDate: it.fields.ScheduledDate || '',
      WorkStatus: it.fields.WorkStatus || 'Not Started',
      CompletedDate: it.fields.CompletedDate || ''
    })).sort((a, b2) => (a.Sequence || 0) - (b2.Sequence || 0));

    return jsonResponse(200, { success: true, assignments });
  } catch (err) {
    console.error('get-service-assignments.js error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
