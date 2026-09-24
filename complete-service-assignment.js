/* ============================================================
   complete-service-assignment.js — marca UN servicio como
   completado dentro de una orden en modo "Assign by service"
   (21/09/2026). Oficina puede marcarlo DIRECTO en cualquier momento
   (misma autoridad que ya tiene hoy con markCompleted de toda-la-
   orden) -- no depende de que un tecnico haya reportado nada
   primero. Deja su propio evento 'Service Completed' en el
   historial real.

   Si es el ULTIMO servicio de la orden en quedar completado, deja
   ademas un 'Completed' (FieldChanged: PerServiceRecap) con el
   recap de quien hizo cada uno -- NO cambia Orders.Status a
   'Completed' todavia (eso lo sigue haciendo markCompleted, a
   proposito, para que oficina de la ultima palabra formal de que la
   orden se cierra -- mismo criterio que hoy).
============================================================ */
const {
  SERVICE_ASSIGNMENTS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  graphFetch, siteListPath, updateListItemByItemId, createListItem, jsonResponse
} = require('./lib/graph');

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

/* ---- Completado por persona ---- */
function namesOf(v) { return String(v || '').split(',').map(x => x.trim()).filter(Boolean); }
function hasName(list, name) { const n = String(name).trim().toLowerCase(); return list.some(x => x.toLowerCase() === n); }

async function completePerson(b) {
  const [assignmentRows, orderSvcRows] = await Promise.all([
    fetchByOrderId(SERVICE_ASSIGNMENTS_LIST, b.orderId),
    fetchByOrderId(ORDER_SERVICES_LIST, b.orderId)
  ]);
  const person = String(b.person).trim();
  const mine = assignmentRows.filter(it => it.fields && hasName(namesOf(it.fields.AssignedTo), person));
  if (!mine.length) return jsonResponse(400, { error: person + ' has no work assigned in this order.' });
  const nowIso = new Date().toISOString();
  const nowCompleted = new Set();
  let cameFromTech = false;
  await Promise.all(mine.map(it => {
    const f = it.fields;
    const assigned = namesOf(f.AssignedTo);
    if (hasName(namesOf(f.DoneBy), person) || f.WorkStatus === 'Pending Review') cameFromTech = true;
    const confirmed = namesOf(f.ConfirmedFor);
    /* Se guarda el nombre tal como esta en AssignedTo. */
    if (!hasName(confirmed, person)) confirmed.push(assigned.find(n => n.toLowerCase() === person.toLowerCase()) || person);
    const patch = { ConfirmedFor: confirmed.join(', ') };
    if (f.WorkStatus !== 'Completed' && assigned.every(n => hasName(confirmed, n))) {
      patch.WorkStatus = 'Completed'; patch.CompletedDate = nowIso; nowCompleted.add(it.id);
    }
    return updateListItemByItemId(SERVICE_ASSIGNMENTS_LIST, it.id, patch);
  }));
  /* Historial (24/09/2026, pedido del dueño): quien termino y la LISTA
     de lo que hizo (lugar + servicio + nivel), no solo "All of X's
     work". ChangeType propio para que un componente viejo no pinte
     "undefined": gsocd-shared/order-history v1.58.0 lo dibuja. */
  const levelOf = {};
  orderSvcRows.forEach(it => { if (it.fields) levelOf[(it.fields.Category || '') + '|' + (it.fields.ServiceName || '')] = it.fields.Level || ''; });
  const canonical = (namesOf(mine[0].fields.AssignedTo).find(n => n.toLowerCase() === person.toLowerCase())) || person;
  await createListItem(ORDER_HISTORY_LIST, {
    Title: b.orderId + '-work-completed-' + Date.now(),
    OrderID: b.orderId,
    ChangeType: 'Work Completed',
    ChangedBy: b.changedBy,
    ChangeDate: nowIso,
    Notes: '',
    NewValue: JSON.stringify({
      person: canonical, finishedText: nowIso,
      items: mine.map(it => ({ place: it.fields.Category || '', service: it.fields.ServiceName || '', level: levelOf[(it.fields.Category || '') + '|' + (it.fields.ServiceName || '')] || '' })),
      confirmedNote: cameFromTech ? ('Confirmed by the office after ' + canonical + ' marked it done in Tech') : ''
    })
  });

  const doneKeys = new Set(assignmentRows
    .filter(it => it.fields && (it.fields.WorkStatus === 'Completed' || nowCompleted.has(it.id)))
    .map(it => it.fields.Category + '|' + it.fields.ServiceName));
  const allSvcKeys = orderSvcRows.filter(it => it.fields).map(it => (it.fields.Category || '') + '|' + (it.fields.ServiceName || ''));
  const allDone = allSvcKeys.length > 0 && allSvcKeys.every(k => doneKeys.has(k));
  if (allDone) {
    await createListItem(ORDER_HISTORY_LIST, {
      Title: b.orderId + '-recap-' + Date.now(),
      OrderID: b.orderId,
      ChangeType: 'Completed',
      FieldChanged: 'PerServiceRecap',
      ChangedBy: b.changedBy,
      ChangeDate: nowIso,
      Notes: '',
      NewValue: JSON.stringify({ recap: assignmentRows.filter(it => it.fields).map(it => ({ serviceName: it.fields.ServiceName, completedBy: it.fields.AssignedTo })) })
    });
  }
  return jsonResponse(200, { success: true, allDone });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    /* Por lugar (recurrentes "Who does what", 23/09/2026): placeMode
       confirma de un jalon TODOS los servicios de ese lugar (misma
       Category) -- el tecnico los marco juntos con un solo Mark as Done
       y una foto del lugar. Sin placeMode, todo igual que siempre: un
       servicio por llamada. */
    const placeMode = b.placeMode === true;
    /* Por PERSONA (recurrentes, 24/09/2026, mini aprobado): la oficina
       cierra de un jalon TODO lo que le toca a esa persona en la orden,
       en cualquier momento -- haya o no marcado algo el tecnico en Tech.
       Un servicio compartido (AssignedTo "A, B") solo queda Completed
       cuando la oficina ya confirmo a TODOS sus nombres (columna
       ConfirmedFor); DoneBy la llena Tech cuando el tecnico termina. */
    const personMode = b.personMode === true;
    const required = personMode ? ['orderId', 'person', 'changedBy']
      : placeMode ? ['orderId', 'category', 'changedBy'] : ['orderId', 'category', 'serviceName', 'changedBy'];
    for (const k of required) if (!b[k]) return jsonResponse(400, { error: k + ' is required' });
    if (personMode) return await completePerson(b);

    const [assignmentRows, orderSvcRows] = await Promise.all([
      fetchByOrderId(SERVICE_ASSIGNMENTS_LIST, b.orderId),
      fetchByOrderId(ORDER_SERVICES_LIST, b.orderId)
    ]);
    const matches = placeMode
      ? assignmentRows.filter(it => it.fields.Category === b.category && it.fields.AssignedTo && it.fields.WorkStatus !== 'Completed')
      : assignmentRows.filter(it => it.fields.Category === b.category && it.fields.ServiceName === b.serviceName).slice(0, 1);
    const match = matches[0];
    if (!match || !match.fields.AssignedTo) {
      return jsonResponse(400, { error: placeMode ? 'Nothing left to confirm in this place.' : 'This service has not been scheduled yet.' });
    }
    const cameFromTech = matches.some(m => m.fields.WorkStatus === 'Pending Review');
    const nowIso = new Date().toISOString();
    await Promise.all(matches.map(m => updateListItemByItemId(SERVICE_ASSIGNMENTS_LIST, m.id, {
      WorkStatus: 'Completed', CompletedDate: nowIso
    })));
    const doneBy = [...new Set(matches.map(m => m.fields.AssignedTo))].join(', ');
    await createListItem(ORDER_HISTORY_LIST, {
      Title: b.orderId + '-svc-completed-' + Date.now(),
      OrderID: b.orderId,
      ChangeType: 'Service Completed',
      ChangedBy: b.changedBy,
      ChangeDate: nowIso,
      Notes: '',
      NewValue: JSON.stringify({
        serviceName: placeMode ? b.category : b.serviceName, completedBy: doneBy, finishedText: nowIso,
        services: placeMode ? matches.map(m => m.fields.ServiceName) : undefined,
        confirmedNote: cameFromTech ? ('Confirmed by office after ' + doneBy + ' marked it done') : ''
      })
    });

    /* Recap si este era el ultimo que faltaba -- servicios reales de
       OrderServices contra WorkStatus real de ServiceAssignments,
       incluyendo el que se acaba de marcar arriba. */
    const matchIds = new Set(matches.map(m => m.id));
    const doneKeys = new Set(assignmentRows
      .filter(it => it.fields.WorkStatus === 'Completed' || matchIds.has(it.id))
      .map(it => it.fields.Category + '|' + it.fields.ServiceName));
    const allSvcKeys = orderSvcRows.filter(it => it.fields).map(it => (it.fields.Category || '') + '|' + (it.fields.ServiceName || ''));
    const allDone = allSvcKeys.length > 0 && allSvcKeys.every(k => doneKeys.has(k));

    if (allDone) {
      const recap = assignmentRows.map(it => ({
        serviceName: it.fields.ServiceName,
        completedBy: it.fields.AssignedTo
      }));
      await createListItem(ORDER_HISTORY_LIST, {
        Title: b.orderId + '-recap-' + Date.now(),
        OrderID: b.orderId,
        ChangeType: 'Completed',
        FieldChanged: 'PerServiceRecap',
        ChangedBy: b.changedBy,
        ChangeDate: nowIso,
        Notes: '',
        NewValue: JSON.stringify({ recap })
      });
    }

    return jsonResponse(200, { success: true, allDone });
  } catch (err) {
    console.error('complete-service-assignment.js error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
