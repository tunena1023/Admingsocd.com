/* admin-approve-order.js — aprobar o rechazar desde la pestaña Approvals.

   Tres cosas se aprueban aqui:
     1) Orden nueva            (Status = Pending)
     2) Solicitud de cambio    (Status = Updated / Change Requested)
     3) Solicitud de cancelacion (Status = Cancellation Requested)

   APROBAR:
     - Orden nueva  -> Received
     - Cambio       -> regresa al estatus que tenia antes de la solicitud,
                       leido del historial (si no hay, Received)
     - Cancelacion  -> Cancelled
     En los tres casos se genera y guarda el PDF de la orden. Power Automate
     detecta el archivo nuevo en la carpeta y manda el correo al cliente.

   RECHAZAR:
     - Regresa el estatus anterior y RESTAURA los servicios desde el snapshot
       'SERVICES:' del historial (misma logica que undo-request del portal).
     - No genera PDF ni correo.

   Quien aprueba se escribe a mano cada vez y queda en ChangedBy.
   Todo, aprobado o rechazado, queda registrado en OrderHistory.
*/
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  createListItem, updateListItemByItemId, deleteListItem,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { generateAndSaveOrderPdf } = require('./lib/orderpdf');

/* Estatus que representan una solicitud esperando decision.
   'Change Requested' se conserva por las ordenes viejas que ya lo tienen. */
const CHANGE_STATUSES = ['Updated', 'Change Requested'];
const CANCEL_STATUSES = ['Cancellation Requested'];
const NEW_STATUSES    = ['Pending'];

/* Estatus que nunca deben quedar como "estatus anterior" al revertir */
const REQUEST_STATUSES = CHANGE_STATUSES.concat(CANCEL_STATUSES).concat(['Draft']);

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

function sortHistory(rows) {
  return rows
    .filter(r => r.fields)
    .map(r => r.fields)
    .sort((a, b) =>
      new Date(a.ChangeDate || a.createdDateTime || 0)
      - new Date(b.ChangeDate || b.createdDateTime || 0));
}

/* El renglon de la solicitud pendiente mas reciente: de ahi sale
   el estatus anterior y el snapshot de servicios para revertir. */
function lastRequestRow(history) {
  const wanted = ['Change Requested', 'Cancellation Requested',
    'Updated', 'Change Requested by Client', 'Reschedule Requested'];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    const type = String(h.ChangeType || '');
    if (wanted.indexOf(type) !== -1) return h;
  }
  return null;
}

function parseServicesPayload(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const body = raw.indexOf('SERVICES:') === 0 ? raw.slice('SERVICES:'.length) : raw;
  try {
    const obj = JSON.parse(body);
    if (Array.isArray(obj)) return { services: obj };
    if (obj && Array.isArray(obj.services)) return obj;
    return null;
  } catch (e) { return null; }
}

/* Busca hacia atras el ultimo snapshot de servicios previo a la solicitud */
function lastServicesSnapshot(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const payload = parseServicesPayload(history[i].OldValue);
    if (payload) return payload;
  }
  return null;
}

/* Estatus al que hay que volver: el OldValue de la solicitud, siempre que
   sea un estatus real y no otra solicitud. */
function previousStatus(history, fallback) {
  const row = lastRequestRow(history);
  const candidate = String((row && row.OldValue) || '').trim();
  if (candidate && candidate.indexOf('SERVICES:') !== 0
      && REQUEST_STATUSES.indexOf(candidate) === -1) {
    return candidate;
  }
  /* Recorrer el historial buscando el ultimo estatus valido */
  for (let i = history.length - 1; i >= 0; i--) {
    const v = String(history[i].OldValue || '').trim();
    if (v && v.indexOf('SERVICES:') !== 0 && REQUEST_STATUSES.indexOf(v) === -1) return v;
  }
  return fallback;
}

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

/* Fechas que el cliente propuso al pedir el cambio. Se guardaron en el
   historial como JSON, no en la orden: hasta aqui no eran mas que una
   peticion. Aprobar es lo que las vuelve reales. */
function parseDatesPayload(value) {
  const raw = String(value == null ? '' : value).trim();
  if (raw.charAt(0) !== '{') return null;
  try {
    const o = JSON.parse(raw);
    if (o && (o.entryDate || o.dueDate || o.serviceWindow)) return o;
    return null;
  } catch (e) { return null; }
}

function dayOf(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10);
}

/* SharePoint guarda fecha y hora; se fija medio dia UTC para que la fecha
   no se mueva un dia por la zona horaria. */
function toIsoDate(v) {
  const day = dayOf(v);
  return day ? day + 'T12:00:00Z' : '';
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const { orderId, decision, approvedBy, notes } = JSON.parse(event.body || '{}');
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
    if (decision !== 'approve' && decision !== 'reject') {
      return jsonResponse(400, { error: "decision must be 'approve' or 'reject'" });
    }
    const actor = String(approvedBy || '').trim();
    if (!actor) {
      return jsonResponse(400, { error: 'Please type the name of the person approving.' });
    }

    const [orderRows, svcRows, histRows] = await Promise.all([
      fetchByOrderId(ORDERS_LIST, orderId),
      fetchByOrderId(ORDER_SERVICES_LIST, orderId),
      fetchByOrderId(ORDER_HISTORY_LIST, orderId)
    ]);

    const item = orderRows.find(it => it.fields);
    if (!item) return jsonResponse(404, { error: 'Order not found.' });

    const f = item.fields;
    const current = String(f.Status || '');
    const history = sortHistory(histRows);

    const isNew    = NEW_STATUSES.indexOf(current) !== -1;
    const isChange = CHANGE_STATUSES.indexOf(current) !== -1;
    const isCancel = CANCEL_STATUSES.indexOf(current) !== -1;

    if (!isNew && !isChange && !isCancel) {
      return jsonResponse(400, {
        error: 'This order has nothing waiting for approval (status: ' + current + ').'
      });
    }

    /* Etiqueta propia para los renglones que escribe el admin */
    const admPrefix = orderId + '-adm';
    let admCount = histRows.filter(it =>
      String(it.fields?.Title || '').indexOf(admPrefix) === 0
    ).length;
    const nextAdminLabel = () => admPrefix + (++admCount);

    const historyBase = () => ({
      OrderID:    orderId,
      ChangedBy:  actor,
      ChangeDate: new Date().toISOString()
    });

    let newStatus = current;
    let changeType = '';
    let restored = 0;

    if (decision === 'approve') {
      if (isNew)         { newStatus = 'Received';  changeType = 'Order Approved'; }
      else if (isCancel) { newStatus = 'Cancelled'; changeType = 'Cancellation Approved'; }
      else               { newStatus = previousStatus(history, 'Received');
                           changeType = 'Change Approved'; }
    } else {
      /* Rechazo: volver al estatus previo. Una orden nueva rechazada se cancela. */
      if (isNew)         { newStatus = 'Cancelled'; changeType = 'Order Rejected'; }
      else if (isCancel) { newStatus = previousStatus(history, 'Received');
                           changeType = 'Cancellation Rejected'; }
      else               { newStatus = previousStatus(history, 'Received');
                           changeType = 'Change Rejected'; }
    }

    /* --- Rechazo de un cambio: restaurar los servicios del snapshot --- */
    if (decision === 'reject' && isChange) {
      const snapshot = lastServicesSnapshot(history);
      if (snapshot && snapshot.services && snapshot.services.length) {
        const division = f.Division || '';
        if (svcRows.length) {
          await Promise.all(svcRows.map(r => deleteListItem(ORDER_SERVICES_LIST, r.id)));
        }
        await Promise.all(snapshot.services.map(s =>
          createListItem(ORDER_SERVICES_LIST, {
            Title:              s.ServiceName || s.service || '',
            OrderID:            orderId,
            Category:           s.Category    || s.category || '',
            ServiceName:        s.ServiceName || s.service  || '',
            SubOption:          s.SubOption   || s.subOption || '',
            Division:           s.Division    || division,
            NotCompleted:       truthy(s.NotCompleted),
            NotCompletedReason: truthy(s.NotCompleted) ? (s.NotCompletedReason || '') : ''
          })
        ));
        restored = snapshot.services.length;
      }
      if (snapshot && snapshot.dirtLevel) {
        await updateListItemByItemId(ORDERS_LIST, item.id, { DirtLevel: snapshot.dirtLevel });
      }
      /* Fechas propuestas por el cliente que no se aprobaron: dejar constancia */
      const req = lastRequestRow(history);
      if (req && String(req.FieldChanged || '') === 'Requested Dates') {
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   'Requested Dates Rejected',
          FieldChanged: 'Requested Dates',
          Notes:        'The dates requested by the client were not approved.',
          OldValue:     String(req.NewValue || ''),
          NewValue:     ''
        }));
      }
    }

    /* --- Aprobar un cambio con fechas: aqui se confirman --- */
    const datePatch = {};
    const dateLogs = [];
    if (decision === 'approve' && isChange) {
      const req = lastRequestRow(history);
      const asked = parseDatesPayload(req && req.NewValue);
      if (asked) {
        if (asked.entryDate && dayOf(asked.entryDate) !== dayOf(f.EntryDate)) {
          datePatch.EntryDate = toIsoDate(asked.entryDate);
          dateLogs.push(['Entry Date', dayOf(f.EntryDate), dayOf(asked.entryDate)]);
        }
        if (asked.dueDate && dayOf(asked.dueDate) !== dayOf(f.DueDate)) {
          datePatch.DueDate = toIsoDate(asked.dueDate);
          dateLogs.push(['Due Date', dayOf(f.DueDate), dayOf(asked.dueDate)]);
        }
        if (asked.serviceWindow && asked.serviceWindow !== (f.ServiceWindow || '')) {
          datePatch.ServiceWindow = asked.serviceWindow;
          dateLogs.push(['Service Window', f.ServiceWindow || '', asked.serviceWindow]);
        }
      }
    }

    /* --- Guardar el estatus (y las fechas confirmadas, si hubo) --- */
    const patch = Object.assign({ Status: newStatus }, datePatch);
    await updateListItemByItemId(ORDERS_LIST, item.id, patch);

    /* Un renglon por cada fecha confirmada: el correo del cliente sale del
       PDF, y el PDF ya lleva estas fechas. */
    for (const [field, oldVal, newVal] of dateLogs) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Dates Confirmed',
        FieldChanged: field,
        Notes:        'Confirmed by ' + actor + ' when approving the client request.',
        OldValue:     oldVal,
        NewValue:     newVal
      }));
    }

    /* --- Registro de la decision (siempre, aprobada o rechazada) --- */
    const decisionNote = (notes && String(notes).trim())
      || (decision === 'approve'
        ? 'Approved by ' + actor + '.'
        : 'Rejected by ' + actor + '.'
          + (restored ? ' Previous services were restored.' : ''));

    await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
      Title:        nextAdminLabel(),
      ChangeType:   changeType,
      FieldChanged: 'Status',
      Notes:        decisionNote,
      OldValue:     current,
      NewValue:     newStatus
    }));

    /* --- PDF: solo al aprobar --- */
    let pdf = null;
    if (decision === 'approve') {
      const merged = Object.assign({}, f, patch, { OrderID: orderId });
      const [freshSvc, freshHist] = await Promise.all([
      fetchByOrderId(ORDER_SERVICES_LIST, orderId),
      fetchByOrderId(ORDER_HISTORY_LIST, orderId)
    ]);




      pdf = await generateAndSaveOrderPdf({
        order: merged,
        services: freshSvc.filter(r => r.fields).map(r => r.fields),
        history: sortHistory(freshHist)
      });
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   pdf.ok ? 'Document Generated' : 'Document Failed',
        FieldChanged: 'Document',
        Notes:        pdf.ok
          ? 'Order document saved. The client will receive it by email.'
          : ('The order document could not be generated: ' + pdf.error
             + ' The approval was saved; the document must be generated again.'),
        OldValue:     '',
        NewValue:     pdf.ok ? pdf.fileName : ''
      }));
    }

    return jsonResponse(200, {
      success: true,
      status: newStatus,
      decision: decision,
      servicesRestored: restored,
      datesConfirmed: dateLogs.map(r => ({ field: r[0], from: r[1], to: r[2] })),
      document: pdf && pdf.ok ? { name: pdf.fileName, revision: pdf.revision } : null,
      documentError: pdf && !pdf.ok ? pdf.error : null
    });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
