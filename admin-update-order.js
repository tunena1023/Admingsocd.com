/* admin-update-order.js — actualizar la orden desde el panel del admin.

   DOS MODOS:

   1) DIRECTO (requestOnly ausente o false) — se aplica de una vez.
      Se usa SOLO desde Approvals, para guardar Supervisor/Service Window/
      Dispatch Date justo antes de la primera aprobacion de una orden nueva
      (todavia no hay nada que "revertir": la orden ni siquiera esta activa).

   2) SOLICITUD (requestOnly: true) — se usa desde Active cuando la oficina
      edita una orden YA aprobada. No se aplica directo: se guarda un
      snapshot de antes/despues en el historial, el Status pasa a
      'Change Requested' y la orden se va a Review. Los cambios de
      verdad SI se escriben ya (igual que las solicitudes del cliente),
      pero si el director rechaza, admin-approve-order.js los revierte
      leyendo este mismo snapshot.

   REGLA DEL PROYECTO: nada se sobreescribe sin quedar registrado.

   PDF: se regenera cuando cambian DATOS DE CONTROL y la orden YA fue
   aprobada antes (ya tiene PDF). En modo requestOnly no se genera PDF
   aqui: se genera cuando el director aprueba el cambio, no antes.
*/
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  createListItem, updateListItemByItemId, deleteListItem,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { generateAndSaveOrderPdf, latestOrderPdf } = require('./lib/orderpdf');

const LIVE_STATUSES = ['Received', 'Assigned', 'Updated'];

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

/* Treat undefined / null / '' as the same "no value", so we never log a
   change that did not actually happen. */
function sameValue(a, b) {
  return String(a == null ? '' : a) === String(b == null ? '' : b);
}

/* Las fechas llegan del <input type="date"> como 'YYYY-MM-DD' y en SharePoint
   estan guardadas como ISO. Se comparan solo por dia para no registrar un
   cambio inexistente por la hora. */
function dayOf(value) {
  if (!value) return '';
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function toIsoDate(value) {
  const day = dayOf(value);
  return day ? day + 'T12:00:00Z' : null;
}

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

/* Comparison key must match the customer portal (Category|ServiceName) so both
   sides report identical change detail. El valor incluye tambien el estado
   "no completado" para que marcarlo tambien quede en el historial. */
function serviceMap(list) {
  const m = {};
  (list || []).forEach(s => {
    m[(s.Category || '') + '|' + (s.ServiceName || '')] = JSON.stringify({
      o: s.SubOption || '',
      n: truthy(s.NotCompleted),
      r: s.NotCompletedReason || ''
    });
  });
  return m;
}

function servicesDiffer(oldList, newList) {
  const a = serviceMap(oldList);
  const b = serviceMap(newList);
  const keys = Object.keys(a).concat(Object.keys(b));
  for (const k of keys) {
    if (!(k in a) || !(k in b) || a[k] !== b[k]) return true;
  }
  return false;
}

function snapshotServices(svcRows, division) {
  return svcRows.filter(it => it.fields).map(it => ({
    Category:           it.fields.Category    || '',
    ServiceName:        it.fields.ServiceName || '',
    SubOption:          it.fields.SubOption   || '',
    Division:           it.fields.Division    || division,
    NotCompleted:       truthy(it.fields.NotCompleted),
    NotCompletedReason: it.fields.NotCompletedReason || ''
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      orderId, status, supervisor, notes, services, changedBy, requestOnly, requestReason,
      entryDate, dueDate, serviceWindow, dispatchDate, inspectionDate,
      delayReasonType, delayReasonNotes
    } = body;
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });

    const actor = (changedBy && String(changedBy).trim()) || 'Admin';

    const [orderRows, svcRows] = await Promise.all([
      fetchByOrderId(ORDERS_LIST, orderId),
      fetchByOrderId(ORDER_SERVICES_LIST, orderId)
    ]);

    const item = orderRows.find(it => it.fields);
    if (!item) return jsonResponse(404, { error: 'Order not found.' });

    const f = item.fields;

    /* ================================================================
       MODO SOLICITUD — la oficina edita una orden activa. Se aplica ya
       (igual que un cambio del cliente), pero el Status pasa a
       'Change Requested' y queda esperando al director en Review.
    ================================================================ */
    if (requestOnly) {
      if (LIVE_STATUSES.indexOf(f.Status || '') === -1) {
        return jsonResponse(400, {
          error: 'This order is not in a state that can be edited right now (status: ' + (f.Status || '') + ').'
        });
      }

      const division = f.Division || '';
      const oldFieldsSnap = {
        supervisor: f.Supervisor || '', notes: f.Notes || '',
        entryDate: dayOf(f.EntryDate), dueDate: dayOf(f.DueDate),
        serviceWindow: f.ServiceWindow || '',
        dispatchDate: dayOf(f.DispatchDate), inspectionDate: dayOf(f.InspectionDate),
        delayReasonType: f.DelayReasonType || '', delayReasonNotes: f.DelayReasonNotes || ''
      };
      const newFieldsSnap = {
        supervisor:       supervisor       !== undefined ? supervisor       : oldFieldsSnap.supervisor,
        notes:            notes            !== undefined ? notes            : oldFieldsSnap.notes,
        entryDate:        entryDate        !== undefined ? dayOf(entryDate) : oldFieldsSnap.entryDate,
        dueDate:          dueDate          !== undefined ? dayOf(dueDate)   : oldFieldsSnap.dueDate,
        serviceWindow:    serviceWindow    !== undefined ? serviceWindow    : oldFieldsSnap.serviceWindow,
        dispatchDate:     dispatchDate     !== undefined ? dayOf(dispatchDate) : oldFieldsSnap.dispatchDate,
        inspectionDate:   inspectionDate   !== undefined ? dayOf(inspectionDate) : oldFieldsSnap.inspectionDate,
        delayReasonType:  delayReasonType  !== undefined ? delayReasonType  : oldFieldsSnap.delayReasonType,
        delayReasonNotes: delayReasonNotes !== undefined ? delayReasonNotes : oldFieldsSnap.delayReasonNotes
      };

      const oldServices = snapshotServices(svcRows, division);
      const newServices = (services && services.length) ? services : oldServices;

      /* Aplicar de una vez los campos de control propuestos */
      await updateListItemByItemId(ORDERS_LIST, item.id, {
        Status:           'Change Requested',
        Supervisor:       newFieldsSnap.supervisor,
        Notes:            newFieldsSnap.notes,
        EntryDate:        newFieldsSnap.entryDate ? toIsoDate(newFieldsSnap.entryDate) : null,
        DueDate:          newFieldsSnap.dueDate ? toIsoDate(newFieldsSnap.dueDate) : null,
        ServiceWindow:    newFieldsSnap.serviceWindow,
        DispatchDate:     newFieldsSnap.dispatchDate ? toIsoDate(newFieldsSnap.dispatchDate) : null,
        InspectionDate:   newFieldsSnap.inspectionDate ? toIsoDate(newFieldsSnap.inspectionDate) : null,
        DelayReasonType:  newFieldsSnap.delayReasonType,
        DelayReasonNotes: newFieldsSnap.delayReasonNotes
      });

      /* Aplicar de una vez los servicios propuestos, si vinieron */
      if (services && services.length) {
        if (svcRows.length) {
          await Promise.all(svcRows.map(row => deleteListItem(ORDER_SERVICES_LIST, row.id)));
        }
        await Promise.all(newServices.map(s =>
          createListItem(ORDER_SERVICES_LIST, {
            Title:              s.ServiceName || '',
            OrderID:            orderId,
            Category:           s.Category    || '',
            ServiceName:        s.ServiceName || '',
            SubOption:          s.SubOption   || '',
            Division:           s.Division    || division,
            NotCompleted:       truthy(s.NotCompleted),
            NotCompletedReason: truthy(s.NotCompleted) ? (s.NotCompletedReason || '') : ''
          })
        ));
      }

      const histRows = await fetchByOrderId(ORDER_HISTORY_LIST, orderId);
      const admPrefix = orderId + '-adm';
      let admCount = histRows.filter(it =>
        String(it.fields?.Title || '').indexOf(admPrefix) === 0
      ).length;

      await createListItem(ORDER_HISTORY_LIST, {
        OrderID:      orderId,
        ChangedBy:    actor,
        ChangeDate:   new Date().toISOString(),
        Title:        admPrefix + (++admCount),
        ChangeType:   'Change Requested',
        FieldChanged: 'Office Change',
        Notes:        (requestReason && String(requestReason).trim()) || ('Change requested by ' + actor + '.'),
        OldValue:     'SERVICES:' + JSON.stringify({ services: oldServices, dirtLevel: f.DirtLevel || '', fields: oldFieldsSnap }),
        NewValue:     'SERVICES:' + JSON.stringify({ services: newServices, dirtLevel: f.DirtLevel || '', fields: newFieldsSnap })
      });

      return jsonResponse(200, { success: true, status: 'Change Requested' });
    }

    /* ================================================================
       MODO DIRECTO — se aplica de una vez (uso: guardar datos de
       control desde Approvals antes de la primera aprobacion).
    ================================================================ */
    const oldStatus = f.Status || '';

    /* Cada entrada: [clave en SharePoint, valor nuevo, etiqueta, tipo] */
    const scalarFields = [
      { key: 'Supervisor',       incoming: supervisor,       label: 'Supervisor',        type: 'text' },
      { key: 'Notes',           incoming: notes,            label: 'Notes',             type: 'text' },
      { key: 'EntryDate',       incoming: entryDate,        label: 'Entry Date',        type: 'date' },
      { key: 'DueDate',         incoming: dueDate,          label: 'Due Date',          type: 'date' },
      { key: 'ServiceWindow',   incoming: serviceWindow,    label: 'Service Window',    type: 'text' },
      { key: 'DispatchDate',    incoming: dispatchDate,     label: 'Dispatch Date',     type: 'date' },
      { key: 'InspectionDate',  incoming: inspectionDate,   label: 'Inspection Date',   type: 'date' },
      { key: 'DelayReasonType', incoming: delayReasonType,  label: 'Delay Reason',      type: 'text' },
      { key: 'DelayReasonNotes', incoming: delayReasonNotes, label: 'Delay Reason Notes', type: 'text' }
    ];

    const patch = {};
    const changes = [];   /* lo que hay que registrar en el historial */

    if (status) patch.Status = status;

    for (const fld of scalarFields) {
      if (fld.incoming === undefined) continue;
      const oldRaw = f[fld.key] == null ? '' : f[fld.key];
      if (fld.type === 'date') {
        const oldDay = dayOf(oldRaw);
        const newDay = dayOf(fld.incoming);
        if (oldDay === newDay) continue;
        patch[fld.key] = newDay ? toIsoDate(newDay) : null;
        changes.push({ label: fld.label, old: oldDay, next: newDay, control: true });
      } else {
        const next = fld.incoming == null ? '' : String(fld.incoming);
        if (sameValue(oldRaw, next)) continue;
        patch[fld.key] = next;
        changes.push({
          label: fld.label, old: String(oldRaw), next: next,
          control: (fld.key === 'ServiceWindow' || fld.key === 'DelayReasonType'
            || fld.key === 'DelayReasonNotes')
        });
      }
    }

    await updateListItemByItemId(ORDERS_LIST, item.id, patch);

    const statusChanged = !!status && status !== oldStatus;

    /* ------------------------------------------------------------------
       Revision labels for admin-written history rows.

       The customer portal numbers revisions by counting rows whose
       ChangeType is 'Change Requested' / 'Cancellation Requested'. Admin rows
       never carry those types, so that counter never advances and every admin
       row used to end up with the SAME label. We leave the customer numbering
       untouched and give admin rows their own '<orderId>-admN' sequence.
    ------------------------------------------------------------------ */
    const histRows = await fetchByOrderId(ORDER_HISTORY_LIST, orderId);
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

    /* Control fields are overwritten on the order itself, so the previous value
       only survives if we record it here. Un renglon por campo. */
    for (const ch of changes) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   ch.label + ' Changed',
        FieldChanged: ch.label,
        Notes:        '',
        OldValue:     ch.old,
        NewValue:     ch.next
      }));
    }

    let servicesChanged = false;

    /* Si vienen servicios, refrescar OrderServices */
    if (services && services.length) {
      const division = f.Division || '';

      /* Snapshot antes de borrar */
      const oldServices = snapshotServices(svcRows, division);

      /* Borrar viejos */
      if (svcRows.length) {
        await Promise.all(svcRows.map(row => deleteListItem(ORDER_SERVICES_LIST, row.id)));
      }

      /* Crear nuevos */
      await Promise.all(services.map(s =>
        createListItem(ORDER_SERVICES_LIST, {
          Title:              s.ServiceName || '',
          OrderID:            orderId,
          Category:           s.Category    || '',
          ServiceName:        s.ServiceName || '',
          SubOption:          s.SubOption   || '',
          Division:           s.Division    || division,
          NotCompleted:       truthy(s.NotCompleted),
          NotCompletedReason: truthy(s.NotCompleted) ? (s.NotCompletedReason || '') : ''
        })
      ));

      if (servicesDiffer(oldServices, services)) {
        servicesChanged = true;
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   statusChanged ? status : 'Services Updated',
          FieldChanged: 'Services',
          Notes:        notes || '',
          OldValue:     'SERVICES:' + JSON.stringify({ services: oldServices, dirtLevel: f.DirtLevel || '' }),
          NewValue:     'SERVICES:' + JSON.stringify({ services: services, dirtLevel: f.DirtLevel || '' })
        }));
      } else if (statusChanged) {
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   status,
          FieldChanged: 'Status',
          Notes:        notes || '',
          OldValue:     oldStatus,
          NewValue:     status
        }));
      }
    } else if (statusChanged) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   status,
        FieldChanged: 'Status',
        Notes:        notes || '',
        OldValue:     oldStatus,
        NewValue:     status
      }));
    }

    /* ------------------------------------------------------------------
       PDF: solo si cambiaron datos de control Y la orden ya fue aprobada
       (ya existe al menos un PDF). Imprimir nunca genera; el boton Print
       descarga el PDF guardado.
    ------------------------------------------------------------------ */
    const controlChanged = servicesChanged || changes.some(c => c.control);
    let pdf = null;
    if (controlChanged) {
      const merged = Object.assign({}, f, patch, { OrderID: orderId });
      const previous = await latestOrderPdf(merged);
      if (previous) {
        const freshSvc = await fetchByOrderId(ORDER_SERVICES_LIST, orderId);
        const freshHist = await fetchByOrderId(ORDER_HISTORY_LIST, orderId);
        pdf = await generateAndSaveOrderPdf({
          order: merged,
          services: freshSvc.filter(r => r.fields).map(r => r.fields),
          history: freshHist.filter(r => r.fields).map(r => r.fields)
            .sort((a, b) => new Date(a.ChangeDate || 0) - new Date(b.ChangeDate || 0))
        });
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   pdf.ok ? 'Document Generated' : 'Document Failed',
          FieldChanged: 'Document',
          Notes:        pdf.ok
            ? 'New order document saved after a control data change.'
            : ('The order document could not be generated: ' + pdf.error),
          OldValue:     previous.name || '',
          NewValue:     pdf.ok ? pdf.fileName : ''
        }));
      }
    }

    return jsonResponse(200, {
      success: true,
      changesLogged: changes.length + (servicesChanged ? 1 : 0),
      document: pdf && pdf.ok ? { name: pdf.fileName, revision: pdf.revision } : null
    });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
