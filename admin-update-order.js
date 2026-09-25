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
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, SERVICES_CATALOG_LIST, SERVICE_ASSIGNMENTS_LIST,
  createListItem, updateListItemByItemId, deleteListItem,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { recordPackageSnapshots, expandPackages } = require('./lib/package-contents');
const { generateAndSaveOrderPdf, generateAndSaveCompletionPdf, latestOrderPdf, fmtDateTime } = require('./lib/orderpdf');
const { pushOrderDiff, schedulingPayrolls, serviceAssignees } = require('./lib/push');
/* Correos al cliente (lib/notify.js, copia de gsocd-shared, 25/09/2026).
   Nunca truena: si el correo falla, la orden ya quedo guardada igual. */
const graph = require('./lib/graph');
const { notifyClient, fmtDay, serviceLine } = require('./lib/notify');
/* gsocd-shared v1.34.0+ -- primera pieza de BACKEND (Node) de ese
   repo, instalada como dependencia real de git (ver package.json),
   no cargada con <script> como el resto de gsocd-shared. Detecta si
   los servicios que se van a guardar pertenecen a otra division de
   la que ya tiene la orden (por SKU contra el catalogo real, nunca
   confiando en el campo Division que ya venga en cada renglon) y, si
   aplica, la orden pasa a 'Mixed' de una vez, sin preguntar, con
   constancia en el historial. Confirmado con el dueño, 20/09/2026. */
const { resolveOrderDivision, divisionChangeHistoryPayload } = require('./lib/division-rules');

/* 'Inspected' (25/09/2026): la oficina puede mandarle al cliente los
   cambios que propuso el supervisor en la inspeccion (Send to client). */
const LIVE_STATUSES = ['Received', 'Assigned', 'Inspected'];

/* Catalogo completo de servicios, solo SKU+Division -- lo minimo que
   necesita resolveOrderDivision() para verificar la division real de
   cada servicio que se va a guardar. Separado de fetchByOrderId
   porque aqui no se filtra por orden, se trae la lista completa. */
/* BUG REAL encontrado y arreglado (20/09/2026, ver el comentario
   completo en admin-approve-order.js, misma revision): Quantity en
   OrderServices paso de Texto a Numero -- '' ya no es un respaldo
   valido para "sin cantidad", ahora hace falta null. */
function numOrNull(v) {
  const n = parseInt(v, 10);
  return (n && n > 0) ? n : null;
}

async function fetchServicesCatalogForDivisionCheck() {
  let url = siteListPath(SERVICES_CATALOG_LIST) + '?$expand=fields($select=SKU,Division)&$top=500';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.filter(it => it.fields).map(it => ({ sku: it.fields.SKU || '', division: it.fields.Division || '' }));
}

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
/* BUG REAL encontrado y arreglado (20/09/2026, reportado por el
   dueño con una orden real): esta comparacion nunca incluia
   Quantity -- cambiar SOLO la cantidad de un servicio ya existente
   (misma Category/ServiceName/SubOption/Level, ej. de 4 puertas a 6)
   producia el mismo hash antes y despues, asi que servicesDiffer()
   regresaba false y NUNCA se creaba el renglon de historial
   "Services Updated" -- el cambio SI se guardaba de verdad (el
   borrar-y-crear de mas abajo no depende de esto), solo quedaba sin
   registrar, invisible en Orders y en el propio historial de Admin. */
function serviceMap(list) {
  const m = {};
  (list || []).forEach(s => {
    m[(s.Category || '') + '|' + (s.ServiceName || '')] = JSON.stringify({
      o: s.SubOption || '',
      l: s.Level || '',
      q: s.Quantity || '',
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

/* Lo que cambio, en palabras del cliente, para el correo. Solo lo que
   el cliente ve (mismo criterio que isClientVisible mas abajo):
   servicios, fechas y ventana. Supervisor/inspeccion nunca salen. */
function clientDiffRows(oldF, newF, oldServices, newServices, servicesChanged) {
  const rows = [];
  if (servicesChanged) {
    rows.push({ label: 'Services', old: (oldServices || []).map(serviceLine).join('\n'), next: (newServices || []).map(serviceLine).join('\n') });
  }
  [['dispatchDate', 'Date', true], ['serviceWindow', 'Arrival window', false],
   ['entryDate', 'Entry date', true], ['dueDate', 'Due date', true]].forEach(([k, label, isDate]) => {
    const o = oldF[k] || '';
    const n = newF[k] || '';
    if (o === n) return;
    rows.push({ label, old: isDate ? fmtDay(o) : o, next: isDate ? fmtDay(n) : n });
  });
  return rows;
}

function snapshotServices(svcRows, division) {
  return svcRows.filter(it => it.fields).map(it => ({
    Category:           it.fields.Category    || '',
    ServiceName:        it.fields.ServiceName || '',
    SubOption:          it.fields.SubOption   || '',
    Division:           it.fields.Division    || division,
    Level:              it.fields.Level       || '',
    /* Paso 5 del pedido del dueno (18/09/2026): puertas, ventanas,
       persianas, etc. -- mismo criterio que Level. */
    Quantity:           it.fields.Quantity    || '',
    NotCompleted:       truthy(it.fields.NotCompleted),
    NotCompletedReason: it.fields.NotCompletedReason || ''
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const {
      orderId, status, supervisor, notes, services: servicesRaw, changedBy, requestOnly, requestReason, sendToClient,
      entryDate, dueDate, serviceWindow, dispatchDate, inspectionDate,
      /* Inspeccion (25/09/2026): el supervisor que va a ver, su horario,
         cuando se termino y lo que encontro. NUNCA se guarda en
         Supervisor: ese campo es el de quien hace el trabajo, y llenarlo
         dispararia el correo "Scheduled" al cliente. */
      inspectionBy, inspectionWindow, inspectionDoneAt, inspectionNotes,
      delayReasonType, delayReasonNotes, technician, completedDate,
      /* BUG REAL de perdida de datos encontrado y arreglado (18/09/2026,
         confirmado con captura real del dueño): cuando solo cambiaban
         servicios (sin tocar Notes para el cliente), el frontend
         mandaba el resumen auto-generado ("Added: X. Removed: Y.")
         como "notes" -- pensado SOLO para el renglon Notes del evento
         "Services Updated" en el historial. Pero el backend trata
         CUALQUIER "notes" como una peticion de actualizar el campo
         Notes REAL de la orden (esta en scalarFields) -- sin querer,
         cada vez que se guardaban servicios, el campo Notes real de
         la orden se SOBRESCRIBIA en silencio con ese resumen
         auto-generado, borrando cualquier nota real que hubiera.
         svcChangeSummary es un parametro APARTE, exclusivo para el
         texto del evento de historial -- nunca entra a scalarFields/
         patch, nunca toca el campo Notes real. */
      svcChangeSummary
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
    /* Paquetes -> sus servicios (24/09/2026, el dueño: el paquete es solo un
       nombre para agrupar; la orden guarda cada servicio y QuickBooks recibe
       cada uno en su linea). servicesRaw (con el paquete) solo se usa para
       registrar que paquete se escogio (Orders.PackageContents). */
    const services = (servicesRaw && servicesRaw.length) ? await expandPackages(servicesRaw, f.ClientID, body.PackageLevels) : servicesRaw;

    /* ================================================================
       MODO SOLICITUD — la oficina edita una orden activa. Se aplica ya
       (igual que un cambio del cliente), pero el Status pasa a
       'Change Requested' y queda esperando al director en Review.
    ================================================================ */
    if (requestOnly) {
      /* Una visita recurrente todavia no vivida (Status 'Recurring
         Scheduled', antes de su dia) tambien se puede editar por esta
         via -- aclarado con el dueno, 19/09/2026: sin cambios pasa
         directo a Active; con un cambio de servicios (o de quien la
         va a hacer), se manda a Review igual que cualquier otra
         solicitud. */
      const isRecurring = !!f.RecurringServiceID;
      if (LIVE_STATUSES.indexOf(f.Status || '') === -1 && !(isRecurring && f.Status === 'Recurring Scheduled')) {
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
      /* Supervisor/ServiceWindow/DispatchDate/InspectionDate NUNCA se
         aceptan aqui para una orden normal, sin importar lo que
         llegue en el body -- esos 4 campos son exclusivos de
         Scheduling, punto. Un Change Request es para lo que el
         cliente ve (fechas visibles, notas, servicios), no para quien
         va a hacer el trabajo. Antes, si este campo llegaba vacio (el
         input quedaba en blanco al editar), se guardaba vacio de
         inmediato -- borrando al supervisor real sin que nadie lo
         pidiera.
         EXCEPCION a proposito para recurrentes (19/09/2026): esas
         nunca pasan por Scheduling, asi que "quien la va a hacer" SI
         se puede proponer aqui como parte del cambio -- es la unica
         via que tienen para eso. */
      const newFieldsSnap = {
        supervisor:       (isRecurring && supervisor !== undefined && String(supervisor).trim())
                            ? String(supervisor).trim() : oldFieldsSnap.supervisor,
        notes:            notes            !== undefined ? notes            : oldFieldsSnap.notes,
        entryDate:        entryDate        !== undefined ? dayOf(entryDate) : oldFieldsSnap.entryDate,
        dueDate:          dueDate          !== undefined ? dayOf(dueDate)   : oldFieldsSnap.dueDate,
        serviceWindow:    oldFieldsSnap.serviceWindow,
        dispatchDate:     oldFieldsSnap.dispatchDate,
        inspectionDate:   oldFieldsSnap.inspectionDate,
        delayReasonType:  delayReasonType  !== undefined ? delayReasonType  : oldFieldsSnap.delayReasonType,
        delayReasonNotes: delayReasonNotes !== undefined ? delayReasonNotes : oldFieldsSnap.delayReasonNotes
      };

      const oldServices = snapshotServices(svcRows, division);
      const newServices = (services && services.length) ? services : oldServices;

      /* CAMBIO DE DISENO (confirmado con el usuario): un cambio pedido
         ya NO se aplica a la orden real hasta que se apruebe -- antes
         se sobreescribian Supervisor/fechas/ventana/servicios de una
         vez, y si el director rechazaba, se revertian leyendo este
         mismo snapshot. Ahora solo se cambia el Status (para que la
         orden se vea "pendiente" y se vaya a Review) y se apaga
         TechMarkedComplete -- nada mas del lado real se toca. Los
         campos/servicios propuestos viven UNICAMENTE en el snapshot
         de este renglon de historial (mas abajo) hasta que Reassign o
         Reschedule los aplique de verdad. */
      const requestPatch = { Status: 'Change Requested', TechMarkedComplete: false };
      try {
        await updateListItemByItemId(ORDERS_LIST, item.id, requestPatch);
      } catch (patchErr) {
        await updateListItemByItemId(ORDERS_LIST, item.id, { Status: 'Change Requested' });
      }

      const histRows = await fetchByOrderId(ORDER_HISTORY_LIST, orderId);
      const admPrefix = orderId + '-adm';
      let admCount = histRows.filter(it =>
        String(it.fields?.Title || '').indexOf(admPrefix) === 0
      ).length;

      /* El cliente solo debe ver esto si de verdad afecta el servicio real:
         cambian los servicios, la fecha de despacho, la fecha limite o la
         ventana. Un cambio de Supervisor o de fecha de inspeccion es
         puramente interno y nunca debe llegarle al cliente. */
      const servicesChangedNow = !!(services && services.length && servicesDiffer(oldServices, services));
      const clientVisibleFieldChanged =
        oldFieldsSnap.dispatchDate !== newFieldsSnap.dispatchDate ||
        oldFieldsSnap.dueDate !== newFieldsSnap.dueDate ||
        oldFieldsSnap.serviceWindow !== newFieldsSnap.serviceWindow;
      const isClientVisible = servicesChangedNow || clientVisibleFieldChanged;

      await createListItem(ORDER_HISTORY_LIST, {
        OrderID:      orderId,
        ChangedBy:    actor,
        ChangeDate:   new Date().toISOString(),
        Title:        admPrefix + (++admCount),
        ChangeType:   'Change Requested',
        FieldChanged: sendToClient ? 'Client Confirmation'
          : (isClientVisible ? 'Office Change' : 'Office Change (Internal)'),
        Notes:        (requestReason && String(requestReason).trim()) || ('Change requested by ' + actor + '.'),
        OldValue:     'SERVICES:' + JSON.stringify({ services: oldServices, dirtLevel: f.DirtLevel || '', fields: oldFieldsSnap, status: f.Status || '' }),
        NewValue:     'SERVICES:' + JSON.stringify({ services: newServices, dirtLevel: f.DirtLevel || '', fields: newFieldsSnap })
      });

      /* "Send to client" = el cliente tiene que confirmar: ese correo
         sale SIEMPRE, aunque tenga las notificaciones apagadas. Un
         cambio de oficina sin sendToClient no manda nada todavia: el
         cliente se entera cuando el director lo aprueba
         (admin-approve-order.js). */
      if (sendToClient) {
        await notifyClient(graph, {
          event: 'confirm',
          order: Object.assign({}, f, requestPatch, { OrderID: orderId }),
          reason: requestReason && String(requestReason).trim(),
          diff: clientDiffRows(oldFieldsSnap, newFieldsSnap, oldServices, newServices,
            servicesDiffer(oldServices, newServices))
        });
      }

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
      { key: 'InspectionBy',    incoming: inspectionBy,     label: 'Inspection By',     type: 'text' },
      { key: 'InspectionWindow', incoming: inspectionWindow, label: 'Inspection Window', type: 'text' },
      { key: 'InspectionDoneAt', incoming: inspectionDoneAt, label: 'Inspection Done',   type: 'datetime' },
      { key: 'InspectionNotes', incoming: inspectionNotes,  label: 'Inspection Notes',  type: 'text' },
      { key: 'DelayReasonType', incoming: delayReasonType,  label: 'Delay Reason',      type: 'text' },
      { key: 'DelayReasonNotes', incoming: delayReasonNotes, label: 'Delay Reason Notes', type: 'text' },
      { key: 'Technician',      incoming: technician,       label: 'Technician',        type: 'text' },
      /* BUG REAL encontrado y arreglado (20/09/2026, reportado por el
         dueño): CompletedDate era type:'date' -- ese tipo trunca a
         solo el dia y lo vuelve a armar con toIsoDate() a las
         T12:00:00Z FIJAS (mediodia UTC), sin importar la hora real en
         que se dio clic en "Completed". Si se completaba a las 6pm,
         el PDF y el historial igual decian una hora fija generica (7am
         hora local, por la conversion de UTC), nunca la hora real.
         Ahora es su propio tipo 'datetime' -- ver el manejo especial
         mas abajo -- que guarda el ISO completo tal cual llega (ya
         armado con la hora real de "ahora" del lado del cliente, ver
         markCompleted() en admin.html), sin truncar ni reemplazar la
         hora. */
      { key: 'CompletedDate',   incoming: completedDate,    label: 'Completed Date',    type: 'datetime' }
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
      } else if (fld.type === 'datetime') {
        /* A diferencia de 'date', aqui SI importa la hora -- se guarda
           el ISO tal cual llega, nunca se re-arma a una hora fija.
           old/next en 'changes' (lo que se ve en el historial) se
           formatean con fecha+hora real para que se lea bien, aunque
           lo que se guarda en SharePoint sea el ISO completo. */
        const next = fld.incoming || null;
        if (sameValue(oldRaw, next)) continue;
        patch[fld.key] = next;
        changes.push({
          label: fld.label,
          old: oldRaw ? fmtDateTime(oldRaw) : '',
          next: next ? fmtDateTime(next) : '',
          control: true
        });
      } else {
        const next = fld.incoming == null ? '' : String(fld.incoming);
        if (sameValue(oldRaw, next)) continue;
        patch[fld.key] = next;
        changes.push({
          label: fld.label, old: String(oldRaw), next: next,
          control: (fld.key === 'ServiceWindow' || fld.key === 'DelayReasonType'
            || fld.key === 'DelayReasonNotes' || fld.key === 'Supervisor')
          /* Supervisor agregado aqui -- antes cambiar solo el supervisor
             (sin tocar fecha/ventana al mismo tiempo) nunca regeneraba
             el PDF, dejandolo con el nombre viejo para siempre. */
        });
      }
    }

    /* ================================================================
       ITEM 18 -- "Unidad no lista". Admin puede marcar el delay reason
       'Site not ready' y editar fechas en el mismo Edit de siempre. Si
       la fecha REAL cambio (Due o Dispatch), la asignacion vieja ya no
       aplica -- la orden vuelve a Scheduling limpia (Supervisor/
       ServiceWindow/DispatchDate en blanco) en vez de quedarse
       "Assigned" con datos que ya no corresponden. Si solo cambio la
       ventana de servicio (misma fecha, otra hora), no hace falta
       re-agendar -- se queda asignada tal cual, con la ventana nueva.
       En los 2 casos se resetean Materials Ready/Expected Ready Date/
       Entry Time/Unit Occupied, porque ya no aplican a la situacion
       vieja. Mismo criterio aplica cuando esto llega via Change
       Request aprobado (ver admin-approve-order.js). */
    const isNotReadyReport = delayReasonType === 'Site not ready' && patch.DelayReasonType !== undefined;
    const realDateChanged = changes.some(c => c.control && (c.label === 'Due Date' || c.label === 'Dispatch Date'));
    if (isNotReadyReport) {
      if (realDateChanged) {
        patch.Supervisor = '';
        patch.ServiceWindow = '';
        patch.DispatchDate = null;
        changes.push({ label: 'Scheduling', old: 'Assigned', next: 'Sent back to Scheduling — site was not ready and the date changed', control: true });
      }
      patch.MaterialsReady = false;
      patch.ExpectedReadyDate = null;
      patch.EntryTime = '';
      patch.UnitOccupied = false;
    }

    try {
      await updateListItemByItemId(ORDERS_LIST, item.id, patch);
    } catch (patchErr) {
      /* Graph rechaza el PATCH completo si alguna columna del body no
         existe todavia en la lista (por ejemplo Technician/CompletedDate,
         que se agregan a mano en SharePoint aparte). Sin esto, marcar
         Completed dejaria de funcionar por completo hasta que esas
         columnas existan, en vez de solo esos 2 datos puntuales. */
      if (('Technician' in patch) || ('CompletedDate' in patch)) {
        const fallbackPatch = Object.assign({}, patch);
        delete fallbackPatch.Technician;
        delete fallbackPatch.CompletedDate;
        await updateListItemByItemId(ORDERS_LIST, item.id, fallbackPatch);
        changes.splice(0, changes.length, ...changes.filter(c =>
          c.label !== 'Technician' && c.label !== 'Completed Date'));
      } else {
        throw patchErr;
      }
    }

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

    /* Primera vez que se asigna (Supervisor + Service Window + Dispatch
       Date pasan de vacio a tener valor) -- a diferencia de 'Order
       Details Set' (que se crea SIEMPRE y esta oculto del cliente,
       incluyendo reasignaciones), esto crea un evento aparte que SI ve
       el cliente, una sola vez. Una reasignacion despues (cambiar de
       supervisor) actualiza los mismos campos otra vez, pero como ya
       no estaban vacios, esta condicion no se vuelve a cumplir -- no
       se crea un segundo evento, el cliente nunca ve el cambio interno.

       Se calcula AQUI (antes de armar 'Order Details Set', no despues
       como antes) porque hace falta para el BUG REAL de abajo. */
    const wasUnassigned = !String(f.Supervisor || '').trim()
      && !String(f.ServiceWindow || '').trim() && !String(f.DispatchDate || '').trim();
    const nowAssigned = String(patch.Supervisor !== undefined ? patch.Supervisor : f.Supervisor || '').trim()
      && String(patch.ServiceWindow !== undefined ? patch.ServiceWindow : f.ServiceWindow || '').trim()
      && String(patch.DispatchDate !== undefined ? patch.DispatchDate : f.DispatchDate || '').trim();

    /* Control fields are overwritten on the order itself, so the previous value
       only survives if we record it here. Un renglon por campo.

       BUG REAL encontrado y arreglado (20/09/2026, reportado por el
       dueño con captura real): en la primera asignacion (wasUnassigned
       && nowAssigned), 'Order Details Set' y 'Assigned' (el evento de
       abajo) mostraban EXACTAMENTE la misma informacion -- Supervisor/
       Service Window/Dispatch Date -- una encima de la otra, sin
       aportar nada distinto. Ahora, solo en ese caso puntual, esos 3
       campos se quitan de 'Order Details Set' antes de armarlo (se
       quedan documentados en 'Assigned', que ya los muestra en su
       propio detalle). Si en la MISMA orden tambien cambio algo mas
       (Notes, Delay Reason, etc.), eso si se sigue viendo aqui -- solo
       se quita lo que ya es puro duplicado. En cualquier otro caso
       (reasignacion, edicion normal) esto no aplica -- se sigue
       viendo tal cual, como siempre. */
    /* Inspeccion (25/09/2026): sus campos NO van en 'Order Details Set'
       (salian como texto plano "Inspection By: ... · Inspection Window:
       ..."); van en el renglon del estatus como JSON, que el historial
       (gsocd-shared/order-history) pinta con icono y etiqueta. */
    const isInspField = c => /^Inspection /.test(c.label);
    const inspChanged = changes.some(isInspField);
    const detailsChanges = ((wasUnassigned && nowAssigned)
      ? changes.filter(c => c.label !== 'Supervisor' && c.label !== 'Service Window' && c.label !== 'Dispatch Date')
      : changes).filter(c => !isInspField(c));
    const merged = Object.assign({}, f, patch);
    const inspStatusMove = statusChanged && (status === 'Inspection' || status === 'Inspected' ||
      oldStatus === 'Inspection' || oldStatus === 'Inspected');
    const inspRowOrNull = (inspStatusMove || inspChanged) ? {
      json: JSON.stringify({
        inspectionBy: merged.InspectionBy || '', inspectionDate: merged.InspectionDate || '',
        inspectionWindow: merged.InspectionWindow || '', inspectionDoneAt: merged.InspectionDoneAt || ''
      }),
      note: status === 'Inspected' ? (merged.InspectionNotes || '')
        : (oldStatus === 'Inspection' && status === 'Received') ? 'Inspection cancelled.'
        : (oldStatus === 'Inspected' && status === 'Received') ? 'Inspection reviewed, moving on to scheduling.' : ''
    } : null;
    if (detailsChanges.length) {
      const summary = detailsChanges.map(ch => ch.label + ': ' + (ch.next || '(empty)')).join('  ·  ');
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Order Details Set',
        FieldChanged: '',
        Notes:        summary,
        OldValue:     '',
        NewValue:     ''
      }));
    }

    if (wasUnassigned && nowAssigned) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Order Assigned',
        FieldChanged: '',
        Notes:        '',
        OldValue:     '',
        NewValue:     JSON.stringify({
          supervisor: patch.Supervisor !== undefined ? patch.Supervisor : f.Supervisor,
          serviceWindow: patch.ServiceWindow !== undefined ? patch.ServiceWindow : f.ServiceWindow,
          dispatchDate: patch.DispatchDate !== undefined ? patch.DispatchDate : f.DispatchDate
        })
      }));
      /* Mismo momento que ve el cliente como "Scheduled": primera
         asignacion, o de nuevo despues de un Reschedule (que deja los 3
         campos en blanco). */
      await notifyClient(graph, { event: 'scheduled', order: Object.assign({}, f, patch, { OrderID: orderId }) });
    }

    let servicesChanged = false;

    /* Si vienen servicios, refrescar OrderServices */
    if (services && services.length) {
      const division = f.Division || '';

      /* Mixed automatico (gsocd-shared v1.34.0+, confirmado con el
         dueño 20/09/2026): si alguno de los servicios que se van a
         guardar pertenece, segun el catalogo real (por SKU, nunca por
         el campo Division que ya venga en cada renglon), a una
         division distinta a la que ya tiene la orden, la orden pasa a
         Mixed de una vez -- sin preguntar, con constancia en el
         historial de que division venia y que servicios lo causaron.
         Sin efecto si la orden ya es Mixed (resolveOrderDivision
         regresa null en ese caso). */
      const divisionCatalog = await fetchServicesCatalogForDivisionCheck();
      const divisionResult = resolveOrderDivision(division, services, divisionCatalog);
      if (divisionResult) {
        await updateListItemByItemId(ORDERS_LIST, item.id, { Division: divisionResult.newDivision });
        /* BUG REAL arreglado (20/09/2026, reportado por el dueño con
           captura real): antes Notes traia una frase completa en
           prosa, que se veia repetida/de mas junto al detalle
           "Division: X -> Y". Ahora Notes se manda vacio y el/los
           servicios que causaron el cambio van en NewValue, como
           payload estructurado -- order-history.js v1.35.0+ ya lo
           sabe dibujar en el mismo detalle, con el mismo formato de
           "servicio agregado" que usa el resto del historial. */
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   'Division Changed',
          FieldChanged: 'Division',
          Notes:        '',
          OldValue:     divisionResult.previousDivision,
          NewValue:     JSON.stringify(divisionChangeHistoryPayload(divisionResult))
        }));
      }

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
          Level:              s.Level       || '',
          Quantity:           numOrNull(s.Quantity),
          NotCompleted:       truthy(s.NotCompleted),
          NotCompletedReason: truthy(s.NotCompleted) ? (s.NotCompletedReason || '') : ''
        })
      ));

      if (servicesDiffer(oldServices, services)) {
        servicesChanged = true;
        /* Paquete agregado en esta edicion: se congela lo que incluye
           HOY; los que la orden ya tenia congelados no se tocan
           (lib/package-contents.js). */
        try {
          await recordPackageSnapshots(orderId, servicesRaw, actor);
        } catch (e) { console.error('Package snapshot on edit:', e.message); }
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   statusChanged ? status : 'Services Updated',
          FieldChanged: 'Services',
          Notes:        svcChangeSummary || notes || '',
          OldValue:     'SERVICES:' + JSON.stringify({ services: oldServices, dirtLevel: f.DirtLevel || '' }),
          NewValue:     'SERVICES:' + JSON.stringify({ services: services, dirtLevel: f.DirtLevel || '' }),
          /* BUG REAL encontrado y arreglado (20/09/2026, reportado por
             el dueño con una orden real): esto ponia ChangeDate con
             toIsoDate(completedDate), que trunca a mediodia UTC FIJO
             -- exactamente el mismo bug que ya se habia arreglado para
             el campo CompletedDate de la orden (ver admin-update-
             order.js mas arriba), pero se quedo sin arreglar aqui, en
             el renglon de historial 'Completed' que alimenta el
             Order Tracker del cliente -- por eso ese punto seguia
             saliendo con una hora fija rara. completedDate ya llega
             como ISO completo con la hora real (markCompleted() en
             admin.html manda new Date().toISOString()) -- se usa tal
             cual, sin volver a truncarlo. El tracker del cliente
             muestra la fecha de ESTE evento -- se deja explicito en
             vez de la default de historyBase() (tambien "ahora") por
             si en el futuro se vuelve a permitir capturar una fecha
             de completado distinta a "ahora" (el tecnico termino un
             dia y se captura despues en el sistema). */
          ...(status === 'Completed' && completedDate ? { ChangeDate: completedDate } : {})
        }));
      } else if (statusChanged) {
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   status,
          FieldChanged: inspRowOrNull ? 'Inspection' : 'Status',
          Notes:        svcChangeSummary || notes || (inspRowOrNull ? inspRowOrNull.note : ''),
          OldValue:     oldStatus,
          NewValue:     inspRowOrNull ? inspRowOrNull.json : status,
          ...(status === 'Completed' && completedDate ? { ChangeDate: completedDate } : {})
        }));
      }
    } else if (statusChanged) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   status,
        FieldChanged: inspRowOrNull ? 'Inspection' : 'Status',
        Notes:        svcChangeSummary || notes || (inspRowOrNull ? inspRowOrNull.note : ''),
        OldValue:     oldStatus,
        NewValue:     inspRowOrNull ? inspRowOrNull.json : status,
        ...(status === 'Completed' && completedDate ? { ChangeDate: completedDate } : {})
      }));
    }

    /* Cambio de fecha/supervisor/horario de una inspeccion ya programada
       (sin cambio de estatus): su propio renglon, no se pierde. */
    if (!statusChanged && inspChanged && inspRowOrNull) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Inspection',
        FieldChanged: 'Inspection',
        Notes:        'Inspection details updated.',
        OldValue:     '',
        NewValue:     inspRowOrNull.json
      }));
    }

    let completionDoc = null;
    if (statusChanged && status === 'Completed') {
      /* Cerrar la orden cierra tambien lo que le quedaba a cada quien
         (24/09/2026): en Active el Completed siempre esta, aunque nadie
         haya marcado nada todavia -- cada servicio que faltaba queda
         Completed y confirmado para todos sus nombres. Nunca tumba el
         cierre de la orden. */
      try {
        const saFilter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
        let saUrl = siteListPath(SERVICE_ASSIGNMENTS_LIST) + `?$expand=fields&$top=200&$filter=${saFilter}`;
        const saRows = [];
        while (saUrl) {
          const d = await graphFetch(saUrl, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
          saRows.push(...(d.value || []));
          saUrl = d['@odata.nextLink'] || null;
        }
        const closeIso = completedDate || new Date().toISOString();
        const pending = saRows.filter(it => it.fields && it.fields.WorkStatus !== 'Completed');
        /* Historial (24/09/2026, pedido del dueño): cada persona que
           todavia tenia algo pendiente queda registrada como que termino,
           con la LISTA de todo lo suyo (lugar + servicio + nivel) --
           mismo evento 'Work Completed' que el boton por persona. Quien
           ya se habia cerrado con su boton no se repite. */
        const nm = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
        const confirmedFor = (it, n) => nm(it.fields.ConfirmedFor).some(x => x.toLowerCase() === n.toLowerCase());
        const people = [];
        pending.forEach(it => nm(it.fields.AssignedTo).forEach(n => {
          if (!confirmedFor(it, n) && !people.some(x => x.toLowerCase() === n.toLowerCase())) people.push(n);
        }));
        if (people.length) {
          let levelOf = {};
          try {
            (await fetchByOrderId(ORDER_SERVICES_LIST, orderId)).forEach(it => { if (it.fields) levelOf[(it.fields.Category || '') + '|' + (it.fields.ServiceName || '')] = it.fields.Level || ''; });
          } catch (e) { levelOf = {}; }
          /* UN solo evento con todas las personas, cada una por separado
             (el dueño: "en un mismo evento, pero si por separado"). */
          await createListItem(ORDER_HISTORY_LIST, {
            Title: orderId + '-work-completed-' + Date.now(),
            OrderID: orderId,
            ChangeType: 'Work Completed',
            ChangedBy: actor,
            ChangeDate: closeIso,
            Notes: '',
            NewValue: JSON.stringify({
              finishedText: closeIso, confirmedNote: 'Closed with the whole order',
              people: people.map(person => ({
                person,
                items: saRows.filter(it => it.fields && nm(it.fields.AssignedTo).some(x => x.toLowerCase() === person.toLowerCase()))
                  .map(it => ({ place: it.fields.Category || '', service: it.fields.ServiceName || '', level: levelOf[(it.fields.Category || '') + '|' + (it.fields.ServiceName || '')] || '' }))
              }))
            })
          });
        }
        await Promise.all(pending.map(it =>
          updateListItemByItemId(SERVICE_ASSIGNMENTS_LIST, it.id, {
            WorkStatus: 'Completed', CompletedDate: closeIso, ConfirmedFor: it.fields.AssignedTo || ''
          })));
      } catch (e) { console.error('Closing service assignments for ' + orderId + ':', e.message); }

      /* Documento de Completacion (con las fotos que se hayan tomado
         en la orden) -- distinto del PDF oficial de arriba, misma
         carpeta, nunca se sobreescribe. A peticion del dueno,
         19/09/2026. Nunca debe tumbar el resto de la operacion: la
         orden ya quedo guardada como Completed, eso es lo que importa. */
      try {
        const merged = Object.assign({}, f, patch, { OrderID: orderId });
        const [freshSvc, freshHist] = await Promise.all([
          fetchByOrderId(ORDER_SERVICES_LIST, orderId),
          fetchByOrderId(ORDER_HISTORY_LIST, orderId)
        ]);
        const completion = completionDoc = await generateAndSaveCompletionPdf({
          order: merged,
          services: freshSvc.filter(r => r.fields).map(r => r.fields),
          history: freshHist.filter(r => r.fields).map(r => r.fields)
            .sort((a, b) => new Date(a.ChangeDate || 0) - new Date(b.ChangeDate || 0)),
          completedBy: (technician && String(technician).trim()) || actor,
          /* BUG REAL (20/09/2026, ver el comentario junto al campo
             CompletedDate mas arriba): toIsoDate() truncaba esto a
             mediodia UTC fijo, perdiendo la hora real en que se dio
             clic en "Completed". completedDate ya llega como ISO
             completo (ver markCompleted() en admin.html) -- se usa
             tal cual. */
          completedAt: completedDate || new Date().toISOString()
        });
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   completion.ok ? 'Document Generated' : 'Document Failed',
          FieldChanged: 'Completion Document',
          Notes:        completion.ok
            ? ('Completion document saved with ' + (completion.photoCount || 0) + ' photo(s).')
            : ('The completion document could not be generated: ' + completion.error)
        }));
      } catch (e) { /* nunca tumbar el guardado de la orden por esto */ }
    }

    /* Correo "Completed" al cliente, con el documento de completacion
       adjunto si se genero (si pesa demasiado, sale sin adjunto y con
       el enlace a sus fotos). Solo cuando la OFICINA la cierra -- que
       el tecnico la marque como hecha solo avisa a la oficina (dueño,
       25/09/2026). */
    if (statusChanged && status === 'Completed') {
      await notifyClient(graph, {
        event: 'completed',
        order: Object.assign({}, f, patch, { OrderID: orderId }),
        completedAt: completedDate || new Date().toISOString(),
        attachment: completionDoc && completionDoc.ok && completionDoc.buffer
          ? { name: completionDoc.fileName, buffer: completionDoc.buffer } : null
      });
    } else if (!wasUnassigned) {
      /* Una orden YA asignada a la que se le mueve la fecha o la
         ventana de forma directa (Scheduling, o "Site not ready" que la
         regresa a Scheduling): el cliente se entera. Cambios de
         Supervisor/inspeccion/notas internas no mandan nada. */
      const clientLabels = { 'Dispatch Date': 'Date', 'Service Window': 'Arrival window', 'Due Date': 'Due date' };
      const diff = changes.filter(c => clientLabels[c.label]).map(c => ({
        label: clientLabels[c.label],
        old: c.label === 'Service Window' ? c.old : fmtDay(c.old),
        next: c.label === 'Service Window' ? c.next : fmtDay(c.next)
      }));
      if (diff.length) {
        await notifyClient(graph, {
          event: 'changed',
          order: Object.assign({}, f, patch, { OrderID: orderId }),
          diff,
          backToScheduling: isNotReadyReport && realDateChanged
        });
      }
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

    /* Push a los tecnicos (lib/push.js): a quien le asignaron, a quien
       le cambio algo, a quien se lo quitaron. Con await: sin el, Vercel
       apaga la funcion antes de que salga. Nunca truena. */
    if (!(statusChanged && status === 'Completed')) {
      const saNames = ((f.AssignByService === true || f.AssignByService === 'true') && servicesChanged)
        ? await serviceAssignees(orderId) : [];
      await pushOrderDiff(Object.assign({}, f, { OrderID: orderId }), Object.assign({}, f, patch, { OrderID: orderId }), {
        servicesChanged, saBefore: saNames, saAfter: saNames,
        schedulingPayrolls: (wasUnassigned && nowAssigned) ? await schedulingPayrolls(orderId) : []
      });
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
