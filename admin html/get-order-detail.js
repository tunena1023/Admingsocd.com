/* ============================================================
   get-order-detail.js — TODO sobre una orden o un draft en una sola llamada.
   - Si el orderId contiene "-TEMP-" → busca en Drafts.
   - Si es orden normal → busca en Orders, OrderServices y OrderHistory.
   Todas las lecturas filtran por OrderID via OData.
============================================================ */

const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, DRAFTS_LIST,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
const { latestOrderPdf } = require('./lib/orderpdf');

async function fetchByField(listName, fieldName, value) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
  let url = siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const out = [];
  while (url) {
    const data = await graphFetch(url);
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

    /* ===== ORDEN NORMAL — las tres listas en paralelo ===== */
    const [orderRows, svcRows, histRows] = await Promise.all([
      fetchByField(ORDERS_LIST,        'OrderID', wanted),
      fetchByField(ORDER_SERVICES_LIST, 'OrderID', wanted),
      fetchByField(ORDER_HISTORY_LIST,  'OrderID', wanted)
    ]);

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
      Notes:           f.Notes || ''
    };

    const services = svcRows
      .filter(it => it.fields)
      .map(it => ({
        Category:    it.fields.Category    || '',
        ServiceName: it.fields.ServiceName || '',
        SubOption:   it.fields.SubOption   || '',
        Division:    it.fields.Division    || order.Division,
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

    /* PDF guardado: Imprimir NUNCA genera, solo descarga el que ya existe.
       Si no hay PDF, la orden todavia no ha sido aprobada. */
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

    return jsonResponse(200, { order, services, history, document });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};