/* admin-approve-order.js — decisiones desde las pestañas Approvals y Review.

   ESTATUS REALES QUE SE GUARDAN EN SHAREPOINT (todos ya existían antes,
   no se inventa ningun valor nuevo para la columna Status):
     Received              -> orden nueva, esperando primera aprobacion
     Assigned              -> orden aprobada, activa (nunca se escribe "Working":
                               eso es solo un calculo visual del admin segun
                               DispatchDate, aqui nunca se toca)
     Updated               -> orden activa que ya tuvo un cambio aprobado
     Change Requested      -> esperando decision sobre un cambio (cliente u
                               oficina; el origen queda en el historial, no
                               en el Status)
     Cancellation Requested-> esperando decision sobre una cancelacion
     Cancelled             -> cancelada. Si Archived=false todavia se ve en
                               Review con botones Archive / Mark as Active.
                               Solo con Archived=true pasa a History.
     Completed             -> terminada, solo se pone desde el boton directo
                               en Active, nunca por aqui.

   ACCIONES que maneja este archivo (campo "decision"):
     approve         -> aprobar lo que esta esperando (Received, Change
                        Requested o Cancellation Requested)
     reject          -> rechazar un Change Requested o Cancellation Requested
                        (ya NO aplica a Received: una orden nueva no se
                        rechaza aqui, se le pide su cancelacion)
     request-cancel  -> crea una Cancellation Requested a partir de una orden
                        activa (Received/Assigned/Updated). Lo usa tanto
                        "Reject" en Approvals como "Cancel" en Active.
     archive         -> Cancelled + Archived=false -> Archived=true
     reactivate      -> "Mark as Active": deshace una cancelacion ya
                        aprobada (Cancelled, Archived=false) y regresa al
                        estatus que tenia antes

   El password del director (si aplica) se valida en el FRONTEND antes de
   llamar esta funcion; aqui solo se recibe el nombre ya resuelto en
   "approvedBy" (el del staff logueado, o "Daniel Aguilar (Operations
   Director)" si se valido el password).

   PDF: se genera al aprobar una orden nueva (Received->Assigned) y al
   aprobar un Change Requested. Nunca al rechazar, cancelar, archivar
   ni reactivar.
*/
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  createListItem, updateListItemByItemId, deleteListItem,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { generateAndSaveOrderPdf } = require('./lib/orderpdf');

const NEW_STATUSES    = ['Received'];
const CHANGE_STATUSES = ['Change Requested'];
const CANCEL_STATUSES = ['Cancellation Requested'];
const LIVE_STATUSES   = ['Received', 'Assigned', 'Updated'];

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

    const validDecisions = ['approve', 'reject', 'request-cancel', 'archive', 'reactivate'];
    if (validDecisions.indexOf(decision) === -1) {
      return jsonResponse(400, { error: "decision must be one of: " + validDecisions.join(', ') });
    }
    const actor = String(approvedBy || '').trim();
    if (!actor) {
      return jsonResponse(400, { error: 'Missing the name of the person making this decision.' });
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
    const archived = truthy(f.Archived);

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

    /* ================================================================
       ARCHIVE / REACTIVATE — solo aplican a una orden ya Cancelled que
       sigue esperando en Review (Archived=false).
    ================================================================ */
    if (decision === 'archive' || decision === 'reactivate') {
      if (current !== 'Cancelled' || archived) {
        return jsonResponse(400, { error: 'This order is not a pending cancellation waiting to be archived.' });
      }
      if (decision === 'archive') {
        await updateListItemByItemId(ORDERS_LIST, item.id, { Archived: true });
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title: nextAdminLabel(), ChangeType: 'Archived', FieldChanged: 'Archived',
          Notes: notes || '', OldValue: 'false', NewValue: 'true'
        }));
        return jsonResponse(200, { success: true, status: current, archived: true });
      }
      /* reactivate: regresa al estatus que tenia antes de la cancelacion */
      const restoredStatus = previousStatus(history, 'Assigned');
      await updateListItemByItemId(ORDERS_LIST, item.id, { Status: restoredStatus, Archived: false });
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title: nextAdminLabel(), ChangeType: 'Cancellation Reversed', FieldChanged: 'Status',
        Notes: notes || ('Reactivated by ' + actor + '.'), OldValue: 'Cancelled', NewValue: restoredStatus
      }));
      return jsonResponse(200, { success: true, status: restoredStatus, archived: false });
    }

    /* ================================================================
       REQUEST-CANCEL — la oficina pide cancelar una orden viva
       (nueva sin aprobar todavia, o ya activa). No aplica si la orden
       ya esta esperando otra decision, o ya termino.
    ================================================================ */
    if (decision === 'request-cancel') {
      if (LIVE_STATUSES.indexOf(current) === -1) {
        return jsonResponse(400, {
          error: 'This order cannot be cancelled from its current status (' + current + ').'
        });
      }
      await updateListItemByItemId(ORDERS_LIST, item.id, { Status: 'Cancellation Requested' });
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title: nextAdminLabel(), ChangeType: 'Cancellation Requested', FieldChanged: 'Status',
        Notes: (notes && String(notes).trim()) || ('Cancellation requested by ' + actor + '.'),
        OldValue: current, NewValue: 'Cancellation Requested'
      }));
      return jsonResponse(200, { success: true, status: 'Cancellation Requested' });
    }

    /* ================================================================
       APPROVE / REJECT — decision sobre lo que esta esperando.
    ================================================================ */
    const isNew    = NEW_STATUSES.indexOf(current) !== -1;
    const isChange = CHANGE_STATUSES.indexOf(current) !== -1;
    const isCancel = CANCEL_STATUSES.indexOf(current) !== -1;

    if (!isNew && !isChange && !isCancel) {
      return jsonResponse(400, {
        error: 'This order has nothing waiting for a decision (status: ' + current + ').'
      });
    }
    if (decision === 'reject' && isNew) {
      return jsonResponse(400, {
        error: "A new order can't be rejected directly — request its cancellation instead."
      });
    }
    if (decision === 'reject' && isCancel && !String(notes || '').trim()) {
      return jsonResponse(400, { error: 'Please explain why the cancellation is not approved.' });
    }

    let newStatus = current;
    let changeType = '';
    let restored = 0;

    if (decision === 'approve') {
      if (isNew)         { newStatus = 'Assigned'; changeType = 'Order Approved'; }
      else if (isCancel) { newStatus = 'Cancelled'; changeType = 'Cancellation Approved'; }
      else               { newStatus = previousStatus(history, 'Assigned');
                           changeType = 'Change Approved'; }
    } else {
      /* Rechazo: siempre vuelve al estatus que tenia antes de la solicitud */
      if (isCancel) { newStatus = previousStatus(history, 'Assigned');
                      changeType = 'Cancellation Rejected'; }
      else          { newStatus = previousStatus(history, 'Assigned');
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
      /* Si el snapshot trae campos de control (solicitudes de la oficina),
         restaurarlos tambien, no solo los servicios. */
      if (snapshot && snapshot.fields) {
        const flds = snapshot.fields;
        const fieldPatch = {};
        if (flds.supervisor !== undefined) fieldPatch.Supervisor = flds.supervisor;
        if (flds.notes !== undefined) fieldPatch.Notes = flds.notes;
        if (flds.entryDate !== undefined) fieldPatch.EntryDate = flds.entryDate ? toIsoDate(flds.entryDate) : null;
        if (flds.dueDate !== undefined) fieldPatch.DueDate = flds.dueDate ? toIsoDate(flds.dueDate) : null;
        if (flds.serviceWindow !== undefined) fieldPatch.ServiceWindow = flds.serviceWindow;
        if (flds.delayReasonType !== undefined) fieldPatch.DelayReasonType = flds.delayReasonType;
        if (flds.delayReasonNotes !== undefined) fieldPatch.DelayReasonNotes = flds.delayReasonNotes;
        if (Object.keys(fieldPatch).length) {
          await updateListItemByItemId(ORDERS_LIST, item.id, fieldPatch);
        }
      }
      /* Fechas propuestas que no se aprobaron: dejar constancia */
      const req = lastRequestRow(history);
      if (req && String(req.FieldChanged || '') === 'Requested Dates') {
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   'Requested Dates Rejected',
          FieldChanged: 'Requested Dates',
          Notes:        'The dates requested were not approved.',
          OldValue:     String(req.NewValue || ''),
          NewValue:     ''
        }));
      }
    }

    /* --- Aprobar un cambio con fechas propuestas: aqui se confirman --- */
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
    if (decision === 'approve' && isCancel) patch.Archived = false;
    await updateListItemByItemId(ORDERS_LIST, item.id, patch);

    for (const [field, oldVal, newVal] of dateLogs) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Dates Confirmed',
        FieldChanged: field,
        Notes:        'Confirmed by ' + actor + ' when approving the request.',
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

    /* --- PDF: solo al aprobar (orden nueva o cambio). Nunca en cancelacion --- */
    let pdf = null;
    if (decision === 'approve' && !isCancel) {
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
