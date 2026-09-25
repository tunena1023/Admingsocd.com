/* ============================================================
   save-service-assignment.js — guarda persona(s)+fecha de UN
   servicio dentro de una orden en modo "Assign by service"
   (21/09/2026). Aplica DIRECTO, sin Approve -- confirmado con el
   dueño: el paso de Review/Approve es solo para CAMBIOS sobre algo
   ya asignado (ver review-service-change.js), nunca para la
   asignacion normal de un servicio, igual que "Assign" de toda-la-
   orden tampoco lo pide para el acto de asignar en si.

   Si es el PRIMER servicio de la orden en tener asignacion real,
   manda la orden a Status 'Assigned' (mismo valor que ya usa el
   modelo de toda-la-orden para "esta en Active" -- ACTIVE_STATUSES
   en admin.html) y deja un evento 'Order Moved To Active' (oculto
   del cliente, ver order-history.js v1.44.0).
============================================================ */
const {
  ORDERS_LIST, SERVICE_ASSIGNMENTS_LIST, ORDER_HISTORY_LIST,
  graphFetch, siteListPath, createListItem, updateListItemByItemId, jsonResponse
} = require('./lib/graph');
/* Push al tecnico (lib/push.js, 25/09/2026). */
const { pushOrderDiff } = require('./lib/push');

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
    const required = ['orderId', 'category', 'serviceName', 'assignedTo', 'scheduledDate', 'changedBy'];
    for (const k of required) if (!b[k]) return jsonResponse(400, { error: k + ' is required' });

    const [existingAssignments, orderRows] = await Promise.all([
      fetchByOrderId(SERVICE_ASSIGNMENTS_LIST, b.orderId),
      fetchByOrderId(ORDERS_LIST, b.orderId)
    ]);

    const orderItem = orderRows.find(it => it.fields && (it.fields.OrderID || it.fields.Title) === b.orderId);
    if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });

    const match = existingAssignments.find(it =>
      it.fields.Category === b.category && it.fields.ServiceName === b.serviceName
    );

    const wasFirstEverScheduled = !existingAssignments.some(it =>
      it.fields.AssignedTo && it.fields.ScheduledDate && it.id !== (match && match.id)
    );

    const fields = {
      Title: b.serviceName,
      OrderID: b.orderId,
      Category: b.category,
      ServiceName: b.serviceName,
      Sequence: b.sequence != null ? Number(b.sequence) : (match ? match.fields.Sequence : existingAssignments.length + 1),
      AssignedTo: b.assignedTo,
      ScheduledDate: b.scheduledDate,
      WorkStatus: (match && match.fields.WorkStatus) || 'Not Started'
    };

    let itemId;
    if (match) {
      await updateListItemByItemId(SERVICE_ASSIGNMENTS_LIST, match.id, fields);
      itemId = match.id;
    } else {
      const created = await createListItem(SERVICE_ASSIGNMENTS_LIST, fields);
      itemId = created.id;
    }

    await createListItem(ORDER_HISTORY_LIST, {
      Title: b.orderId + '-svc-scheduled-' + Date.now(),
      OrderID: b.orderId,
      ChangeType: 'Service Scheduled',
      ChangedBy: b.changedBy,
      ChangeDate: new Date().toISOString(),
      Notes: '',
      NewValue: JSON.stringify({ serviceName: b.serviceName, assigned: b.assignedTo, date: b.scheduledDate })
    });

    if (wasFirstEverScheduled) {
      await updateListItemByItemId(ORDERS_LIST, orderItem.id, { Status: 'Assigned' });
      await createListItem(ORDER_HISTORY_LIST, {
        Title: b.orderId + '-moved-active-' + Date.now(),
        OrderID: b.orderId,
        ChangeType: 'Order Moved To Active',
        ChangedBy: b.changedBy,
        ChangeDate: new Date().toISOString(),
        Notes: ''
      });
    }

    /* Push: a quien se le asigno este servicio, a quien se le quito o
       a quien se le cambio el dia. Se reusa pushOrderDiff poniendo las
       personas/fecha de ESTE servicio en Supervisor/DispatchDate (solo
       para comparar; no se guarda nada). Varios servicios seguidos a la
       misma persona se juntan en el telefono (mismo tag por orden). */
    const of = Object.assign({}, orderItem.fields, { OrderID: b.orderId, ServiceWindow: '' });
    await pushOrderDiff(
      Object.assign({}, of, { Supervisor: match ? (match.fields.AssignedTo || '') : '', DispatchDate: match ? (match.fields.ScheduledDate || '') : '' }),
      Object.assign({}, of, { Supervisor: b.assignedTo, DispatchDate: b.scheduledDate }));

    return jsonResponse(200, { success: true, itemId, wasFirstEverScheduled });
  } catch (err) {
    console.error('save-service-assignment.js error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
