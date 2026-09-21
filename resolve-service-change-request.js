/* ============================================================
   resolve-service-change-request.js — Approve/Cancel de UNA
   solicitud de cambio pendiente sobre un servicio, en una orden con
   "Assign by service" (21/09/2026, confirmado con el dueño: nunca
   se agrupan, cada servicio se resuelve por separado). Sin password
   -- mismos 3 casos ya definidos y probados en el mini:

     Add    -- Approve crea el servicio real en OrderServices, cae en
               la cola de Scheduling como cualquier otro.
     Modify -- Approve necesita assignedTo+scheduledDate (el picker de
               Review, mismo componente real que Scheduling) --
               actualiza/crea el renglon de ServiceAssignments.
     Remove -- Approve marca el servicio real como NotCompleted
               (mismo mecanismo ya usado por el Update de Active,
               nunca se borra el renglon).

   Cancel en cualquiera de los 3: no toca nada real, solo deja
   constancia de que se descarto.

   Al final, si a la orden ya no le queda NINGUNA otra solicitud
   pendiente, Status regresa a 'Assigned' (el modelo por-servicio
   sigue vivo, solo que ya no necesita Review); si le quedan otras,
   se queda en 'Change Requested'.
============================================================ */
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, SERVICE_ASSIGNMENTS_LIST,
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

/* Mismo criterio de deteccion que admin.html (pendingServiceChangeRequests)
   -- ultimo estado real de un servicio, recorriendo el historial en
   orden cronologico. Se repite aqui (backend) porque el frontend no
   es quien decide que hay pendiente -- eso se vuelve a confirmar
   contra la fuente real antes de aplicar nada. */
function findPendingRequest(history, category, serviceName) {
  const targetKey = (category || '') + '|' + (serviceName || '');
  let found = null;
  (history || []).forEach(h => {
    const type = String(h.fields ? h.fields.ChangeType : h.ChangeType || '');
    if (type !== 'Service Change Requested' && type !== 'Service Change Resolved') return;
    const f = h.fields || h;
    let payload = null;
    try { payload = JSON.parse(f.NewValue || 'null'); } catch (e) {}
    if (!payload || !payload.serviceName) return;
    const k = (payload.category || '') + '|' + payload.serviceName;
    if (k !== targetKey) return;
    if (type === 'Service Change Requested') {
      found = { subType: f.FieldChanged, detail: payload.detail, resolved: false };
    } else if (found) {
      found.resolved = true;
    }
  });
  return (found && !found.resolved) ? found : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    const required = ['orderId', 'category', 'serviceName', 'decision', 'changedBy'];
    for (const k of required) if (!b[k]) return jsonResponse(400, { error: k + ' is required' });
    if (b.decision !== 'approve' && b.decision !== 'cancel') return jsonResponse(400, { error: 'decision must be approve or cancel' });

    const [orderRows, svcRows, histRows] = await Promise.all([
      fetchByOrderId(ORDERS_LIST, b.orderId),
      fetchByOrderId(ORDER_SERVICES_LIST, b.orderId),
      fetchByOrderId(ORDER_HISTORY_LIST, b.orderId)
    ]);
    const orderItem = orderRows.find(it => it.fields && (it.fields.OrderID || it.fields.Title) === b.orderId);
    if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });

    const pending = findPendingRequest(histRows, b.category, b.serviceName);
    if (!pending) return jsonResponse(400, { error: 'No pending request found for this service — it may have already been resolved.' });

    const nowIso = new Date().toISOString();

    if (b.decision === 'approve') {
      if (pending.subType === 'Add') {
        const s = pending.detail || {};
        await createListItem(ORDER_SERVICES_LIST, {
          Title: b.serviceName, OrderID: b.orderId, Category: b.category, ServiceName: b.serviceName,
          SubOption: s.SubOption || '', Division: s.Division || orderItem.fields.Division || '',
          Level: s.Level || '', Quantity: s.Quantity || null
        });
        await createListItem(ORDER_HISTORY_LIST, {
          Title: b.orderId + '-svc-added-' + Date.now(), OrderID: b.orderId, ChangeType: 'Service Added',
          ChangedBy: b.changedBy, ChangeDate: nowIso, Notes: '',
          NewValue: JSON.stringify({ serviceName: b.serviceName })
        });
      } else if (pending.subType === 'Remove') {
        const row = svcRows.find(it => it.fields && (it.fields.Category || '') === b.category && (it.fields.ServiceName || '') === b.serviceName);
        if (row) await updateListItemByItemId(ORDER_SERVICES_LIST, row.id, { NotCompleted: true });
        await createListItem(ORDER_HISTORY_LIST, {
          Title: b.orderId + '-svc-removed-' + Date.now(), OrderID: b.orderId, ChangeType: 'Service Removed',
          ChangedBy: b.changedBy, ChangeDate: nowIso, Notes: '',
          NewValue: JSON.stringify({ serviceName: b.serviceName })
        });
      } else if (pending.subType === 'Modify') {
        if (!b.assignedTo || !b.scheduledDate) return jsonResponse(400, { error: 'assignedTo and scheduledDate are required to approve a Modify request.' });
        const assignmentRows = await fetchByOrderId(SERVICE_ASSIGNMENTS_LIST, b.orderId, true);
        const match = assignmentRows.find(it => it.fields && (it.fields.Category || '') === b.category && (it.fields.ServiceName || '') === b.serviceName);
        const fields = {
          Title: b.serviceName, OrderID: b.orderId, Category: b.category, ServiceName: b.serviceName,
          Sequence: match ? match.fields.Sequence : (assignmentRows.length + 1),
          AssignedTo: b.assignedTo, ScheduledDate: b.scheduledDate,
          WorkStatus: (match && match.fields.WorkStatus) || 'Not Started'
        };
        if (match) await updateListItemByItemId(SERVICE_ASSIGNMENTS_LIST, match.id, fields);
        else await createListItem(SERVICE_ASSIGNMENTS_LIST, fields);
        await createListItem(ORDER_HISTORY_LIST, {
          Title: b.orderId + '-svc-scheduled-' + Date.now(), OrderID: b.orderId, ChangeType: 'Service Scheduled',
          ChangedBy: b.changedBy, ChangeDate: nowIso, Notes: '',
          NewValue: JSON.stringify({ serviceName: b.serviceName, assigned: b.assignedTo, date: b.scheduledDate })
        });
      }
    }

    await createListItem(ORDER_HISTORY_LIST, {
      Title: b.orderId + '-svc-change-resolved-' + Date.now(), OrderID: b.orderId, ChangeType: 'Service Change Resolved',
      ChangedBy: b.changedBy, ChangeDate: nowIso, Notes: '',
      NewValue: JSON.stringify({ category: b.category, serviceName: b.serviceName })
    });

    /* Si ya no queda NINGUNA otra solicitud pendiente en esta orden,
       Status regresa a 'Assigned' -- el modelo por-servicio sigue
       vivo (Scheduling/Active conviven normal), nomas ya no necesita
       Review. Se revisa el historial completo + este renglon que se
       acaba de resolver, sin volver a pedirlo al servidor. */
    const historyWithThisResolution = histRows.map(it => it.fields).concat([{
      ChangeType: 'Service Change Resolved', NewValue: JSON.stringify({ category: b.category, serviceName: b.serviceName })
    }]);
    const stillPendingKeys = {};
    historyWithThisResolution.forEach(f => {
      const type = String(f.ChangeType || '');
      if (type !== 'Service Change Requested' && type !== 'Service Change Resolved') return;
      let payload = null;
      try { payload = JSON.parse(f.NewValue || 'null'); } catch (e) {}
      if (!payload || !payload.serviceName) return;
      const k = (payload.category || '') + '|' + payload.serviceName;
      stillPendingKeys[k] = type === 'Service Change Requested';
    });
    const anyStillPending = Object.values(stillPendingKeys).some(Boolean);
    if (!anyStillPending) {
      await updateListItemByItemId(ORDERS_LIST, orderItem.id, { Status: 'Assigned' });
    }

    return jsonResponse(200, { success: true, orderId: b.orderId, anyStillPending });
  } catch (err) {
    console.error('resolve-service-change-request.js error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
