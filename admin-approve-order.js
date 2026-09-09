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
const LIVE_STATUSES   = ['Received', 'Assigned'];

/* Estatus que nunca deben quedar como "estatus anterior" al revertir */
const REQUEST_STATUSES = CHANGE_STATUSES.concat(CANCEL_STATUSES).concat(['Draft']);

/* Un OldValue nunca es un estatus real si es un snapshot de servicios.
   Las solicitudes viejas del portal cliente guardan ese snapshot como
   JSON crudo SIN el prefijo "SERVICES:" (solo "[...]"), mientras que las
   solicitudes nuevas de la oficina si llevan el prefijo. Cualquiera de
   los dos formatos debe descartarse aqui, o su texto completo terminaria
   escribiendose como si fuera el valor de Status. */
function looksLikeServiceSnapshot(v) {
  const s = String(v || '').trim();
  return s.indexOf('SERVICES:') === 0 || s.charAt(0) === '[' || s.charAt(0) === '{';
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
    'Updated', 'Change Requested by Client', 'Reschedule Requested', 'Reactivation Requested'];
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

/* Lo que se propuso (NewValue) en la ULTIMA solicitud pendiente --
   se usa para Reassign/Reschedule: ahora que un cambio pedido ya NO
   se aplica a los servicios reales hasta que se apruebe, este es el
   unico lugar donde vive la propuesta hasta ese momento. */
function lastRequestedSnapshot(history) {
  const row = lastRequestRow(history);
  return row ? parseServicesPayload(row.NewValue) : null;
}

/* Estatus al que hay que volver: el OldValue de la solicitud, siempre que
   sea un estatus real y no otra solicitud ni un snapshot de servicios
   (con o sin el prefijo "SERVICES:"). */
function previousStatus(history, fallback) {
  const row = lastRequestRow(history);
  /* Arreglo real: si el renglon de la solicitud trae un snapshot con
     el estatus real embebido (status), usar ese directo -- sin esto,
     una orden que ya estaba Assigned y tuvo un Change Requested
     terminaba regresando hasta el "Received" original al aprobar o
     rechazar, porque el OldValue de ESE renglon es puro snapshot de
     servicios, nunca el estatus, y la busqueda de mas abajo se iba
     demasiado atras en el historial. */
  const snap = row ? parseServicesPayload(row.OldValue) : null;
  if (snap && snap.status && REQUEST_STATUSES.indexOf(snap.status) === -1) {
    return snap.status;
  }
  const candidate = String((row && row.OldValue) || '').trim();
  if (candidate && !looksLikeServiceSnapshot(candidate)
      && REQUEST_STATUSES.indexOf(candidate) === -1) {
    return candidate;
  }
  /* Recorrer el historial buscando el ultimo estatus valido.
     BUG FIX: antes se aceptaba el OldValue de CUALQUIER renglon, sin
     importar de que campo era -- un renglon 'Archived' (OldValue:
     'false'/'true', nada que ver con el Status de la orden) se colaba
     como si 'false' fuera un estatus real. Nunca se habia manifestado
     porque el 'reactivate' instantaneo solo aplica a ordenes SIN
     archivar (nunca hay un renglon 'Archived' de por medio); con
     'reactivate-confirm' (ordenes YA archivadas) si aparece, y sin este
     filtro el estatus restaurado hubiera quedado mal.

     Se excluye especificamente 'Archived' (el unico FieldChanged que
     guarda algo que NO es un estatus real, ademas de los ya excluidos
     por looksLikeServiceSnapshot/REQUEST_STATUSES) -- NO se exige
     FieldChanged==='Status' a secas, porque 'Office Change (Internal)'
     tambien guarda el estatus real valido en su OldValue y se
     romperia ese caso legitimo. */
  for (let i = history.length - 1; i >= 0; i--) {
    if (String(history[i].FieldChanged || '') === 'Archived') continue;
    const v = String(history[i].OldValue || '').trim();
    if (v && !looksLikeServiceSnapshot(v) && REQUEST_STATUSES.indexOf(v) === -1) return v;
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

    const validDecisions = ['approve', 'reject', 'request-cancel', 'archive', 'reactivate', 'cancel-update', 'reassign', 'reschedule', 'request-reactivate', 'reactivate-confirm'];
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
       REQUEST-REACTIVATE — la oficina pide reactivar una orden ya
       Cancelled Y archivada (boton "Reactivate" en History). A
       diferencia de 'reactivate' (arriba), que es instantaneo para
       una cancelacion fresca sin archivar, esta abre un camino DOBLE:
       el Status pasa a 'Change Requested', lo que automaticamente hace
       que la orden aparezca tanto en Review (para el director) como en
       Active Orders del cliente (para que el mismo la confirme) -- sin
       necesitar codigo nuevo para "que aparezca ahi", ya que ambos ya
       filtran por ese Status. El que decida primero gana: en cuanto
       cualquiera de los 2 caminos cambia el Status, la orden deja de
       cumplir la condicion "pendiente" del otro camino.

       OldValue: JSON.stringify({ reactivation: true, restoreTo: <estatus> }) --
       el estatus al que hay que regresar se calcula AQUI, una sola vez,
       con el historial mas completo y claro que se va a tener (justo
       antes de que empiece la carrera). Se guarda explicito para que
       reactivate-confirm Y el endpoint del lado cliente lo LEAN
       directo, en vez de cada uno adivinarlo por su cuenta con su
       propia busqueda hacia atras en el historial.

       BUG FIX: la primera version de esto hacia que cada camino
       (director aqui, cliente en confirm-reactivation.js) recalculara
       el estatus previo por separado, buscando hacia atras en un
       historial que para entonces ya podia traer mucho ruido de otras
       pruebas -- y SharePoint no valida que el texto que se guarda en
       Status sea un valor real, asi que un calculo equivocado se
       guardaba sin ningun error, dejando la orden atorada. Calcularlo
       una sola vez aqui y compartirlo elimina esa ambiguedad por
       completo: los 2 caminos ya no tienen que "adivinar" nada.
    ================================================================ */
    if (decision === 'request-reactivate') {
      if (current !== 'Cancelled' || !archived) {
        return jsonResponse(400, { error: 'This order is not an archived, cancelled order that can be reactivated.' });
      }
      const restoreTo = previousStatus(history, 'Assigned');
      await updateListItemByItemId(ORDERS_LIST, item.id, { Status: 'Change Requested' });
      /* ChangeType propio ('Reactivation Requested'), en vez de reusar
         'Change Requested' -- confirmado con el usuario que una
         reactivacion debe verse distinta a un cambio de servicios
         normal en el historial, no disfrazada de lo mismo. */
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Reactivation Requested',
        FieldChanged: 'Reactivation Pending',
        Notes:        (notes && String(notes).trim()) || ('Reactivation requested by ' + actor + '.'),
        OldValue:     JSON.stringify({ reactivation: true, restoreTo: restoreTo }),
        NewValue:     'Change Requested'
      }));
      return jsonResponse(200, { success: true, status: 'Change Requested' });
    }

    /* ================================================================
       REACTIVATE-CONFIRM — el director aprueba la reactivacion (boton
       "Approve Reactivation" en Review). Lee el estatus destino
       directo del marcador 'Reactivation Pending' (calculado una sola
       vez en request-reactivate) -- no vuelve a adivinarlo.

       Si el cliente confirma primero desde su portal (via el endpoint
       equivalente del lado cliente), el Status ya no sera 'Change
       Requested' para cuando el director intente aprobar aqui -- este
       chequeo lo bloquea con un mensaje claro, sin necesitar ninguna
       logica extra de "cancelar la otra opcion".
    ================================================================ */
    if (decision === 'reactivate-confirm') {
      if (current !== 'Change Requested') {
        return jsonResponse(400, { error: 'This order has no pending reactivation to confirm — it may have already been resolved.' });
      }
      const lastReq = lastRequestRow(history);
      const isReactivation = lastReq && String(lastReq.FieldChanged || '') === 'Reactivation Pending';
      if (!isReactivation) {
        return jsonResponse(400, { error: 'This order does not have a pending reactivation request.' });
      }
      let restoredStatus = 'Assigned';
      try {
        const payload = JSON.parse(lastReq.OldValue || '{}');
        if (payload && payload.restoreTo) restoredStatus = payload.restoreTo;
      } catch (e) { /* deja el fallback 'Assigned' */ }
      await updateListItemByItemId(ORDERS_LIST, item.id, { Status: restoredStatus, Archived: false });
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Order Reactivated',
        FieldChanged: 'Status',
        Notes:        (notes && String(notes).trim()) || ('Reactivated by ' + actor + '.'),
        OldValue:     'Change Requested',
        NewValue:     restoredStatus
      }));
      return jsonResponse(200, { success: true, status: restoredStatus });
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
       CANCEL-UPDATE — "Cancel Change Request" en Review: deshace la
       solicitud pendiente de un Change Requested (sea de la oficina,
       del cliente, o del supervisor en sitio -- ANTES solo aplicaba
       a un cambio que la propia oficina origino, restriccion que se
       quito: el ejemplo real es el cliente pidiendo un cambio y
       luego llamando a decir que ya no, sin que nadie de oficina
       sepa que tenia antes -- este boton regresa la orden exacto a
       como estaba, sin importar quien pidio el cambio). Nunca aplica
       a una Cancellation Requested (esa sigue su propio camino, con
       password, en 'reject'/'approve'). Sin password: es deshacer
       una solicitud que ya nadie quiere, no una decision que
       necesite al director. Y a diferencia de reject, no deja NINGUN
       renglon en el historial -- ni para el cliente ni para el staff
       viendo admin.html. El Update queda como si nunca hubiera
       pasado.
    ================================================================ */
    if (decision === 'cancel-update') {
      if (CHANGE_STATUSES.indexOf(current) === -1) {
        return jsonResponse(400, { error: 'This order has no pending update to cancel.' });
      }

      /* Ya no hay nada que restaurar -- el cambio pedido nunca se
         aplico a los servicios/campos reales, asi que cancelarlo es
         tan simple como regresar el Status. */
      const restoredStatus = previousStatus(history, 'Assigned');
      await updateListItemByItemId(ORDERS_LIST, item.id, { Status: restoredStatus });

      /* Confirmado con el usuario: el historial debe tener TODO lo que
         paso -- antes este camino no dejaba ningun rastro, la orden
         quedaba como si el cambio nunca hubiera existido. Ahora si
         queda registrado, sin exponer los datos crudos del snapshot
         (ese detalle ya no importa, se descarto). */
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title: nextAdminLabel(), ChangeType: 'Change Request Cancelled', FieldChanged: 'Status',
        Notes: notes || ('Change request withdrawn by ' + actor + '.'), OldValue: current, NewValue: restoredStatus
      }));

      return jsonResponse(200, { success: true, status: restoredStatus });
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
    /* REGLA DEL PROYECTO: toda orden pasa por sus estatus en orden --
       una orden nueva nunca llega a Assigned sin supervisor, ventana
       de servicio y fecha de despacho. Esto se valida aqui, en el
       backend, para que ningun camino del frontend (boton individual,
       "Approve All" del batch, o cualquier otro que se agregue despues)
       se lo pueda saltar por accidente -- antes solo se checaba que
       hubiera Supervisor en el frontend, dejando pasar ordenes sin
       ventana ni fecha. */
    if (isNew && decision === 'approve') {
      const missing = [];
      if (!String(f.Supervisor || '').trim()) missing.push('a supervisor');
      if (!String(f.ServiceWindow || '').trim()) missing.push('a service window');
      if (!String(f.DispatchDate || '').trim()) missing.push('a service date');
      if (missing.length) {
        return jsonResponse(400, {
          error: 'This order needs ' + missing.join(', ') + ' before it can be approved.'
        });
      }
    }
    if (decision === 'reject' && isNew) {
      return jsonResponse(400, {
        error: "A new order can't be rejected directly — request its cancellation instead."
      });
    }
    if ((decision === 'reassign' || decision === 'reschedule') && !isChange) {
      return jsonResponse(400, { error: 'Reassign/Reschedule only apply to a pending change request.' });
    }
    if (decision === 'approve' && isChange) {
      return jsonResponse(400, { error: 'A pending change is resolved with Reassign or Reschedule, not Approve.' });
    }
    if (decision === 'reject' && isCancel && !String(notes || '').trim()) {
      return jsonResponse(400, { error: 'Please explain why the cancellation is not approved.' });
    }
    if (decision === 'reject' && isChange && !String(notes || '').trim()) {
      return jsonResponse(400, { error: 'Please explain why the requested change is not approved.' });
    }

    let newStatus = current;
    let changeType = '';
    let restored = 0;

    /* Los servicios propuestos (si los hubo) se aplican de verdad AQUI,
       en Reassign y Reschedule -- ya no se aplican al pedirse el
       cambio (confirmado con el usuario: nada del lado izquierdo debe
       moverse hasta que se apruebe). Notas/nivel de suciedad tambien
       se aplican en los dos. Reassign IGNORA fechas/ventana a
       proposito (para eso esta Reschedule); Reschedule las confirma
       aparte, mas abajo. */
    if ((decision === 'reassign' || decision === 'reschedule') && isChange) {
      const proposed = lastRequestedSnapshot(history);
      if (proposed && proposed.services && proposed.services.length) {
        const division = f.Division || '';
        if (svcRows.length) {
          await Promise.all(svcRows.map(r => deleteListItem(ORDER_SERVICES_LIST, r.id)));
        }
        await Promise.all(proposed.services.map(s =>
          createListItem(ORDER_SERVICES_LIST, {
            Title:              s.ServiceName || s.service || '',
            OrderID:            orderId,
            Category:           s.Category    || s.category || '',
            ServiceName:        s.ServiceName || s.service  || '',
            SubOption:          s.SubOption   || s.subOption || '',
            Division:           s.Division    || division,
            Level:              s.Level       || s.level || '',
            NotCompleted:       truthy(s.NotCompleted),
            NotCompletedReason: truthy(s.NotCompleted) ? (s.NotCompletedReason || '') : ''
          })
        ));
        restored = proposed.services.length;
      }
      if (proposed && proposed.dirtLevel) {
        await updateListItemByItemId(ORDERS_LIST, item.id, { DirtLevel: proposed.dirtLevel });
      }
      if (proposed && proposed.fields && proposed.fields.notes !== undefined) {
        await updateListItemByItemId(ORDERS_LIST, item.id, { Notes: proposed.fields.notes });
      }
    }

    if (decision === 'approve') {
      if (isNew)         { newStatus = 'Assigned'; changeType = 'Order Approved'; }
      else if (isCancel) { newStatus = 'Cancelled'; changeType = 'Cancellation Approved'; }
      /* isChange ya no llega aqui -- ver 'reassign'/'reschedule' abajo */
    } else if (decision === 'reassign') {
      /* La oficina confirmo con el tecnico que si puede -- mismo dia,
         misma hora, mismo tecnico de antes. Cualquier fecha/hora nueva
         que se haya pedido junto con el cambio se IGNORA a proposito
         -- Reassign nunca aplica una fecha nueva, para eso esta
         Reschedule. */
      newStatus = previousStatus(history, 'Assigned');
      changeType = 'Change Reassigned';
    } else if (decision === 'reschedule') {
      /* No se puede con el mismo tecnico/dia/hora -- la orden vuelve
         a Scheduling limpia. Aqui ademas se confirman las fechas
         pedidas (si las hubo) en los campos de cara al cliente, y se
         borra la asignacion vieja (Supervisor/Ventana/Fecha de
         despacho) para que Scheduling la vuelva a programar desde
         cero. */
      newStatus = 'Received';
      changeType = 'Sent to Scheduling';
    } else {
      /* Rechazo: siempre vuelve al estatus que tenia antes de la solicitud.
         Ya no hay nada que restaurar -- el cambio pedido nunca se aplico
         a los servicios/campos reales, asi que descartarlo es tan
         simple como regresar el Status. */
      if (isCancel) { newStatus = previousStatus(history, 'Assigned');
                      changeType = 'Cancellation Rejected'; }
      else          { newStatus = previousStatus(history, 'Assigned');
                      changeType = 'Change Rejected'; }
    }

    /* --- Rechazo de un cambio: nada que restaurar, solo dejar constancia
       si habia fechas propuestas que no se aprobaron --- */
    if (decision === 'reject' && isChange) {
      const req = lastRequestRow(history);
      if (req && String(req.FieldChanged || '') === 'Requested Dates') {
        await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
          Title:        nextAdminLabel(),
          ChangeType:   'Requested Dates Rejected',
          FieldChanged: 'Requested Dates',
          Notes:        String(notes).trim(),
          OldValue:     String(req.NewValue || ''),
          NewValue:     ''
        }));
      }
    }

    /* --- Reschedule: aqui se confirman las fechas pedidas, si las hubo.
       Reassign las ignora a proposito -- se queda con lo que ya habia. --- */
    const datePatch = {};
    const dateLogs = [];
    if (decision === 'reschedule') {
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

    /* ================================================================
       RESCHEDULE -- la orden vuelve a Scheduling limpia: se borra la
       asignacion vieja (Supervisor/Ventana/Fecha de despacho) y el
       Status ya se puso en 'Received' arriba, para que fluya de
       nuevo por Approvals/Active exactamente igual que una orden
       nueva (isFullyScheduled la manda a Active con Mark as Seen en
       cuanto alguien la vuelva a asignar). Generaliza lo que antes
       solo pasaba para el caso especial 'Site not ready' -- ahora es
       la regla para CUALQUIER Reschedule, sin importar el motivo.
    ================================================================ */
    let sentBackToScheduling = false;
    if (decision === 'reschedule') {
      patch.Supervisor = '';
      patch.ServiceWindow = '';
      patch.DispatchDate = null;
      patch.MaterialsReady = false;
      patch.ExpectedReadyDate = null;
      patch.EntryTime = '';
      patch.UnitOccupied = false;
      sentBackToScheduling = true;
    }

    await updateListItemByItemId(ORDERS_LIST, item.id, patch);

    if (sentBackToScheduling) {
      await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
        Title:        nextAdminLabel(),
        ChangeType:   'Scheduling',
        FieldChanged: 'Scheduling',
        Notes:        (notes && String(notes).trim()) || ('Sent back to Scheduling by ' + actor + '.'),
        OldValue:     '',
        NewValue:     ''
      }));
    }

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

    /* --- Registro de la decision (siempre) --- */
    const defaultNoteByDecision = {
      approve:    'Approved by ' + actor + '.',
      reject:     'Rejected by ' + actor + '.' + (restored ? ' Previous services were restored.' : ''),
      reassign:   'Reassigned by ' + actor + ' — same tech, day, and time.',
      reschedule: 'Sent back to Scheduling by ' + actor + '.'
    };
    const decisionNote = (notes && String(notes).trim())
      || defaultNoteByDecision[decision] || (actor + ' updated this order.');

    /* Si la solicitud que se esta decidiendo era un cambio interno de la
       oficina (Supervisor, Inspection Date), la decision tambien debe
       quedar oculta para el cliente: el no vio la solicitud, tampoco
       debe ver que se aprobo o rechazo algo que no sabe que existio. */
    const originRow = isChange ? lastRequestRow(history) : null;
    const wasInternal = originRow && String(originRow.FieldChanged || '') === 'Office Change (Internal)';

    await createListItem(ORDER_HISTORY_LIST, Object.assign(historyBase(), {
      Title:        nextAdminLabel(),
      ChangeType:   changeType,
      FieldChanged: wasInternal ? 'Office Change (Internal)' : 'Status',
      Notes:        decisionNote,
      OldValue:     current,
      NewValue:     newStatus
    }));

    /* --- PDF: solo al aprobar (orden nueva o cambio). Nunca en cancelacion --- */
    let pdf = null;
    if ((decision === 'approve' && !isCancel) || decision === 'reassign') {
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
