/* admin-update-order.js — actualizar la orden desde el panel del admin.

   REGLA DEL PROYECTO: nada se sobreescribe sin quedar registrado.
   Cada campo de control que cambia genera su propio renglon en OrderHistory
   con FieldChanged, OldValue y NewValue.

   Campos que acepta:
     orderId (requerido), changedBy (quien hace el cambio),
     status, supervisor, notes,
     entryDate, dueDate, serviceWindow,
     delayReasonType, delayReasonNotes,
     services[] (con Category, ServiceName, SubOption, NotCompleted,
                 NotCompletedReason)

   PDF: se regenera cuando cambian DATOS DE CONTROL (fechas, ventana,
   servicios, motivo de retraso) y la orden YA fue aprobada (ya tiene PDF).
   Un cambio de solo estatus, supervisor o notas NO genera PDF.
*/
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  createListItem, updateListItemByItemId, deleteListItem,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { generateAndSaveOrderPdf, latestOrderPdf } = require('./lib/orderpdf');

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      orderId, status, supervisor, notes, services, changedBy,
      entryDate, dueDate, serviceWindow, delayReasonType, delayReasonNotes
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
    const oldStatus = f.Status || '';

    /* Cada entrada: [clave en SharePoint, valor nuevo, etiqueta, tipo] */
    const scalarFields = [
      { key: 'Supervisor',       incoming: supervisor,       label: 'Supervisor',        type: 'text' },
      { key: 'Notes',           incoming: notes,            label: 'Notes',             type: 'text' },
      { key: 'EntryDate',       incoming: entryDate,        label: 'Entry Date',        type: 'date' },
      { key: 'DueDate',         incoming: dueDate,          label: 'Due Date',          type: 'date' },
      { key: 'ServiceWindow',   incoming: serviceWindow,    label: 'Service Window',    type: 'text' },
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
      const oldServices = svcRows.filter(it => it.fields).map(it => ({
        Category:          it.fields.Category    || '',
        ServiceName:       it.fields.ServiceName || '',
        SubOption:         it.fields.SubOption   || '',
        Division:          it.fields.Division    || division,
        NotCompleted:      truthy(it.fields.NotCompleted),
        NotCompletedReason: it.fields.NotCompletedReason || ''
      }));

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

      /* Registrar evento en historial con comparación.

         FALLA #3: esto estaba dentro de `if (status !== oldStatus)`, así que un
         cambio de servicios sin cambio de estatus borraba y recreaba las filas
         SIN dejar registro — pérdida silenciosa, y Undo se quedaba sin nada que
         leer. Ahora se registra siempre que los servicios cambien de verdad. */
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
        /* Los servicios llegaron pero son idénticos: solo cambió el estatus */
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
      /* Solo cambio de estatus sin servicios */
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
        /* Que quede registro tanto del exito como del fallo */
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
