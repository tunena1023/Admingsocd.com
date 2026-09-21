/* ============================================================
   get-order-detail.js — TODO sobre una orden o un draft en una sola llamada.
   - Si el orderId contiene "-TEMP-" → busca en Drafts.
   - Si es orden normal → busca en Orders, OrderServices y OrderHistory.
   Todas las lecturas filtran por OrderID via OData.
============================================================ */

const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, DRAFTS_LIST, SERVICE_ASSIGNMENTS_LIST,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { latestOrderPdf } = require('./lib/orderpdf');

/* honorNonIndexed (opcional): BUG REAL encontrado en produccion
   (21/09/2026) -- ServiceAssignments (lista nueva de "Assign by
   service") nunca se indexo por OrderID, a diferencia de las listas
   viejas que ya usan esta misma funcion (esas SI estan indexadas,
   nunca necesitaron esto). Arreglo inmediato con el header que el
   propio error de Graph sugiere -- el arreglo de fondo sigue siendo
   indexar la columna en SharePoint. Solo se pasa true para esa
   lista especifica, las demas llamadas se quedan igual que siempre. */
async function fetchByField(listName, fieldName, value, honorNonIndexed) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    if (!body.orderId) return jsonResponse(400, { error: 'orderId is required' });

    const wanted = String(body.orderId);
    const isTempDraft = wanted.includes('-TEMP-');

    /* ===== DRAFT (ID temporal) ===== */
    if (isTempDraft) {
      const draftRows = await fetchByField(DRAFTS_LIST, 'OrderID', wanted);

      const draftItem = draftRows.find(it =>
        it.fields && !it.fields.ServiceName
      );
      if (!draftItem) return jsonResponse(404, { error: 'Draft not found.' });

      if (body.clientId &&
          String(draftItem.fields.ClientID || '').trim().toLowerCase() !==
          String(body.clientId).trim().toLowerCase()) {
        return jsonResponse(403, { error: 'This draft does not belong to you.' });
      }

      const f = draftItem.fields;
      const order = {
        id:              draftItem.id,
        createdDateTime: draftItem.createdDateTime || f.DraftDate || '',
        OrderID:         f.OrderID || f.Title || '',
        ClientID:        f.ClientID || '',
        BusinessName:    f.BusinessName || f.Title || '',
        Division:        f.Division || '',
        Status:          'Incomplete',
        DirtLevel:       f.DirtLevel || '',
        Services:        '',
        DraftData:       '',
        BuildingNumber:  f.BuildingNumber || '',
        UnitNumber:      f.UnitNumber || '',
        Bedrooms:        f.Bedrooms || '',
        Bathrooms:       f.Bathrooms || '',
        EntryDate:       f.EntryDate || '',
        DueDate:         f.DueDate || '',
        Address:         f.Address || '',
        Suite:           f.Suite || '',
        City:            f.City || '',
        Zip:             f.Zip || '',
        Contact:         f.Contact || '',
        Notes:           f.Notes || '',
      /* Columnas nuevas 28/08/2026 */
      ServiceWindow:    f.ServiceWindow || '',
      DelayReasonType:  f.DelayReasonType || '',
      DelayReasonNotes: f.DelayReasonNotes || ''
      };

      const services = draftRows
        .filter(it => it.fields && it.fields.ServiceName)
        .map(it => ({
          Category:    it.fields.Category    || '',
          ServiceName: it.fields.ServiceName || '',
          SubOption:   it.fields.SubOption   || '',
          Division:    it.fields.Division    || order.Division
        }));

      return jsonResponse(200, { order, services, history: [] });
    }

    /* ===== ORDEN NORMAL — las 3 listas de siempre, en paralelo ===== */
    const [orderRows, svcRows, histRows] = await Promise.all([
      fetchByField(ORDERS_LIST,        'OrderID', wanted),
      fetchByField(ORDER_SERVICES_LIST, 'OrderID', wanted),
      fetchByField(ORDER_HISTORY_LIST,  'OrderID', wanted)
    ]);

    /* "Assign by service" (21/09/2026) -- APARTE y con su propio
       try/catch a proposito: BUG REAL encontrado en produccion
       (21/09/2026) -- estaba adentro del Promise.all de arriba, asi
       que un fallo aqui (lista/columna nueva, todavia sin confirmar
       la causa exacta) tumbaba TODO get-order-detail -- Approvals,
       Active, History, todo lo que ya funcionaba antes de "Assign by
       service" siquiera existir. Nunca debe poder romper el resto de
       la orden -- si falla, la orden se ve sin su cola por servicio,
       no deja de verse. */
    let assignmentRows = [];
    try {
      assignmentRows = await fetchByField(SERVICE_ASSIGNMENTS_LIST, 'OrderID', wanted, true);
    } catch (svcAssignErr) {
      console.error('get-order-detail: fetch de ServiceAssignments fallo (no fatal):', svcAssignErr);
    }

    const orderItem = orderRows.find(it => it.fields);
    if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });

    if (body.clientId &&
        String(orderItem.fields.ClientID || '').trim().toLowerCase() !==
        String(body.clientId).trim().toLowerCase()) {
      return jsonResponse(403, { error: 'This order does not belong to you.' });
    }

    const f = orderItem.fields;
    const order = {
      id:              orderItem.id,
      createdDateTime: orderItem.createdDateTime || '',
      OrderID:         f.OrderID || f.Title || '',
      ClientID:        f.ClientID || '',
      BusinessName:    f.BusinessName || f.Title || '',
      Division:        f.Division || '',
      Status:          f.Status || 'Pending',
      DirtLevel:       f.DirtLevel || '',
      Services:        f.Services || '',
      DraftData:       f.DraftData || '',
      BuildingNumber:  f.BuildingNumber || '',
      UnitNumber:      f.UnitNumber || '',
      Bedrooms:        f.Bedrooms || '',
      Bathrooms:       f.Bathrooms || '',
      EntryDate:       f.EntryDate || '',
      DueDate:         f.DueDate || '',
      Address:         f.Address || '',
      Suite:           f.Suite || '',
      City:            f.City || '',
      Zip:             f.Zip || '',
      Contact:         f.Contact || '',
      Notes:           f.Notes || '',
      Supervisor:       f.Supervisor || '',
      ServiceWindow:    f.ServiceWindow || '',
      DispatchDate:     f.DispatchDate || '',
      /* Columna nueva (19/09/2026): liga la orden a su contrato
         recurrente de origen, para la pantalla simplificada de
         Approvals (Fase 3, pendiente). */
      RecurringServiceID: f.RecurringServiceID || '',
      InspectionDate:   f.InspectionDate || '',
      DelayReasonType:  f.DelayReasonType || '',
      DelayReasonNotes: f.DelayReasonNotes || '',
      Technician:       f.Technician || '',
      TechMarkedComplete: f.TechMarkedComplete === true || f.TechMarkedComplete === 'true',
      CompletedDate:    f.CompletedDate || '',
      Archived:         f.Archived === true || f.Archived === 'true',
      OrderNotificationsEnabled: f.OrderNotificationsEnabled || '',
      OrderNotifyConfirmations:  f.OrderNotifyConfirmations  || '',
      OrderNotifyChanges:        f.OrderNotifyChanges        || '',
      OrderNotifyUpdates:        f.OrderNotifyUpdates        || '',
      OrderContactId:            f.OrderContactId            || '',
      BatchId:    f.BatchId    || '',
      BuildingId: f.BuildingId || '',
      /* Renovations: aviso del cliente de que el material ya esta listo
         para que entremos. MaterialsReadySeen controla la burbuja de
         Review (default true en filas viejas sin la columna todavia). */
      ExpectedReadyDate: f.ExpectedReadyDate || '',
      MaterialsReady: f.MaterialsReady === true || f.MaterialsReady === 'true',
      MaterialsReadySeen: f.MaterialsReadySeen === undefined ? true : (f.MaterialsReadySeen === true || f.MaterialsReadySeen === 'true'),
      EntryTime: f.EntryTime || '',
      /* Columna nueva (21/09/2026): "Assign by service" -- ver mismo
         comentario en admin-get-orders.js. */
      AssignByService: f.AssignByService === true || f.AssignByService === 'true'
    };

    const services = svcRows
      .filter(it => it.fields)
      .map(it => ({
        Category:    it.fields.Category    || '',
        ServiceName: it.fields.ServiceName || '',
        SubOption:   it.fields.SubOption   || '',
        Division:    it.fields.Division    || order.Division,
        Level:       it.fields.Level       || '',
        Quantity:    it.fields.Quantity    || '',
        /* Columnas nuevas 28/08/2026: servicio no realizado + motivo */
        NotCompleted:       it.fields.NotCompleted === true
                            || String(it.fields.NotCompleted) === 'true',
        NotCompletedReason: it.fields.NotCompletedReason || ''
      }));

    const history = histRows
      .filter(it => it.fields)
      .sort((a, b) =>
        String(a.createdDateTime || '').localeCompare(String(b.createdDateTime || '')))
      .map(it => ({
        Title:      it.fields.Title      || '',
        ChangeType: it.fields.ChangeType || '',
        ChangedBy:  it.fields.ChangedBy  || '',
        ChangeDate: it.fields.ChangeDate || it.createdDateTime || '',
        Notes:      it.fields.Notes      || '',
        FieldChanged: it.fields.FieldChanged || '',
        OldValue:   it.fields.OldValue   || '',
        NewValue:   it.fields.NewValue   || ''
      }));

    /* Solo para saber si mostrar el boton de Print habilitado -- la
       generacion/regeneracion de verdad (si hace falta) vive en
       get-order-document.js, no aqui. */
    let document = null;
    try {
      const found = await latestOrderPdf(order);
      if (found) {
        document = {
          name: found.name,
          revision: found.revision,
          webUrl: found.webUrl,
          driveItemId: found.id
        };
      }
    } catch (e) { document = null; }

    /* Documento de Completacion (con fotos) -- solo tiene caso
       buscarlo si la orden ya esta Completed. */
    let completionDocument = null;
    if (order.Status === 'Completed') {
      try {
        const foundCompletion = await latestOrderPdf(order, 'completion');
        if (foundCompletion) {
          completionDocument = {
            name: foundCompletion.name,
            revision: foundCompletion.revision,
            webUrl: foundCompletion.webUrl,
            driveItemId: foundCompletion.id
          };
        }
      } catch (e) { completionDocument = null; }
    }

    /* "Assign by service" -- mismo mapeo que get-service-assignments.js,
       para que Active pueda pintar el estatus por servicio sin pedirlo
       aparte. */
    const serviceAssignments = assignmentRows
      .filter(it => it.fields)
      .map(it => ({
        itemId: it.id,
        Category: it.fields.Category || '',
        ServiceName: it.fields.ServiceName || '',
        Sequence: it.fields.Sequence != null ? Number(it.fields.Sequence) : null,
        AssignedTo: it.fields.AssignedTo || '',
        ScheduledDate: it.fields.ScheduledDate || '',
        WorkStatus: it.fields.WorkStatus || 'Not Started',
        CompletedDate: it.fields.CompletedDate || ''
      }))
      .sort((a, b) => (a.Sequence || 0) - (b.Sequence || 0));

    return jsonResponse(200, { order, services, history, document, completionDocument, serviceAssignments });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};