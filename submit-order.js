/* ============================================================
   submit-order.js — enviar orden nueva o convertir draft en orden.

   Flujos:
   A) OrderID contiene "-TEMP-" → viene de Drafts
   B) OrderID real existe en Orders → edición de orden existente
   C) Sin OrderID → orden nueva directa
============================================================ */

const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, DRAFTS_LIST,
  createListItem, updateListItemByItemId, deleteListItem,
  graphFetch, siteListPath,
  jsonResponse
} = require('./lib/graph');

async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

async function fetchAllOrderIds() {
  let url = siteListPath(ORDERS_LIST) + '?$expand=fields($select=OrderID,Title,Status)&$top=500';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
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

function nextGlobalSuffix(allOrderRows) {
  const nums = allOrderRows
    .map(it => {
      const id = String(it.fields?.OrderID || it.fields?.Title || '');
      if (id.includes('-TEMP-')) return null;
      const s = id.split('-').pop();
      const n = parseInt(s, 10);
      return isNaN(n) ? null : n;
    })
    .filter(n => n !== null);

  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1001;
  return String(next).padStart(4, '0');
}

function parseServicesString(str, division) {
  const out = [];
  String(str || '').split(' | ').forEach(item => {
    if (item.includes('Dirt Level:')) return;
    const parts = item.split(' \u2013 ');
    if (parts.length === 2) {
      const m = parts[0].match(/^(.*?)>\s*(.+)$/);
      out.push({
        Category:    m ? m[1].replace(/\s*>\s*$/, '').trim() : '',
        ServiceName: (m ? m[2] : parts[0]).trim(),
        SubOption:   parts[1].trim(),
        Division:    division
      });
    }
  });
  return out;
}

function dateField(v) { return v ? v : null; }


exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.ClientID || !b.Division) {
      return jsonResponse(400, { error: 'ClientID and Division are required' });
    }

    const requestedId = b.OrderID ? String(b.OrderID) : null;
    const isTempDraft = requestedId && requestedId.includes('-TEMP-');

    const orderFields = {
      Title:          b.BusinessName || '',
      ClientID:       b.ClientID,
      BusinessName:   b.BusinessName || '',
      Requester:      b.Requester || '',
      Division:       b.Division,
      DirtLevel:      b.DirtLevel || '',
      BuildingNumber: b.BuildingNumber || '',
      UnitNumber:     b.UnitNumber || '',
      Bedrooms:       b.Bedrooms || '',
      Bathrooms:      b.Bathrooms || '',
      Address:        b.Address || '',
      Suite:          b.Suite || '',
      City:           b.City || '',
      Zip:            b.Zip || '',
      Email:          b.Contact || '',
      Notes:          b.Notes || '',
      EntryDate:      dateField(b.EntryDate),
      DueDate:        dateField(b.DueDate),
      DraftData:      ''
    };

    /* ===== FLUJO A: Draft temporal → Orden real ===== */
    if (isTempDraft) {
            const [myDraftRows, allOrderRows] = await Promise.all([
        fetchByOrderId(DRAFTS_LIST, requestedId),
        fetchAllOrderIds()
      ]);

      const draftHeader = myDraftRows.find(it => !it.fields.ServiceName);
      if (!draftHeader) return jsonResponse(404, { error: 'Draft not found.' });

      const draftServiceRows = myDraftRows.filter(it => it.fields.ServiceName);

      const suffix = nextGlobalSuffix(allOrderRows);
      const orderId = String(b.ClientID).trim() + '-' + suffix;
      const newStatus = b.Status || 'Received';

      const result = await createListItem(ORDERS_LIST,
        Object.assign({}, orderFields, { OrderID: orderId, Status: newStatus })
      );

      try {
        await updateListItemByItemId(DRAFTS_LIST, draftHeader.id, {
          Status:  'Order',
          OrderID: orderId
        });
      } catch (e) { console.error('Draft header update failed:', e.message); }

      try {
        await Promise.all([
          ...draftServiceRows.map(row =>
            createListItem(ORDER_SERVICES_LIST, {
              Title:       row.fields.ServiceName || '',
              OrderID:     orderId,
              Category:    row.fields.Category    || '',
              ServiceName: row.fields.ServiceName || '',
              SubOption:   row.fields.SubOption   || '',
              Division:    row.fields.Division    || b.Division
            })
          ),
          createListItem(ORDER_HISTORY_LIST, {
            Title:      orderId,
            OrderID:    orderId,
            ChangeType: 'Created',
            ChangedBy:  b.ClientID,
            ChangeDate: new Date().toISOString(),
            Notes:      'Submitted from draft.',
            OldValue:   'Draft',
            NewValue:   newStatus
          })
        ]);
      } catch (e) { console.error('Post-order write failed:', e.message); }

      try {
        await Promise.all(draftServiceRows.map(row => deleteListItem(DRAFTS_LIST, row.id)));
      } catch (e) { console.error('Draft cleanup failed:', e.message); }

      return jsonResponse(200, { success: true, orderId, id: result.id });
    }

    /* ===== FLUJO B: Orden existente → edicion ===== */
    if (requestedId) {
      if (!b.Services) return jsonResponse(400, { error: 'Services are required' });

      const [orderRows, svcRows, histRows] = await Promise.all([
        fetchByOrderId(ORDERS_LIST,         requestedId),
        fetchByOrderId(ORDER_SERVICES_LIST,  requestedId),
        fetchByOrderId(ORDER_HISTORY_LIST,   requestedId)
      ]);

      const orderItem = orderRows.find(it =>
        it.fields &&
        (it.fields.OrderID || it.fields.Title) === requestedId &&
        String(it.fields.ClientID || '').trim().toLowerCase() ===
        String(b.ClientID).trim().toLowerCase()
      );
      if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });

      const stale = svcRows.filter(it =>
        it.fields && it.fields.OrderID === requestedId
      );

      const existing = {
        itemId:    orderItem.id,
        OrderID:   orderItem.fields.OrderID || orderItem.fields.Title || '',
        Status:    orderItem.fields.Status  || 'Pending',
        DirtLevel: orderItem.fields.DirtLevel || '',
        Division:  orderItem.fields.Division || ''
      };

      const newStatus = b.Status || 'Pending';

      const snapshot = 'SERVICES:' + JSON.stringify({
        services: stale.map(it => ({
          Category:    it.fields.Category    || '',
          ServiceName: it.fields.ServiceName || '',
          SubOption:   it.fields.SubOption   || '',
          Division:    it.fields.Division    || existing.Division
        })),
        dirtLevel: existing.DirtLevel || ''
      });

      await updateListItemByItemId(ORDERS_LIST, existing.itemId,
        Object.assign({}, orderFields, { Status: newStatus })
      );

      if (stale.length) {
        await Promise.all(stale.map(row => deleteListItem(ORDER_SERVICES_LIST, row.id)));
      }

      for (const s of parseServicesString(b.Services, b.Division)) {
        await createListItem(ORDER_SERVICES_LIST, {
          Title:       s.ServiceName || '',
          OrderID:     existing.OrderID,
          Category:    s.Category,
          ServiceName: s.ServiceName,
          SubOption:   s.SubOption,
          Division:    s.Division
        });
      }

      const revCount = histRows.filter(it =>
        it.fields &&
        it.fields.OrderID === existing.OrderID &&
        (it.fields.ChangeType === 'Change Requested' || it.fields.ChangeType === 'Cancellation Requested')
      ).length;

      /* Servicios nuevos que el cliente seleccionó */
      const newServices = parseServicesString(b.Services, b.Division).map(s => ({
        Category: s.Category, ServiceName: s.ServiceName, SubOption: s.SubOption, Division: s.Division
      }));

      await createListItem(ORDER_HISTORY_LIST, {
        Title:      existing.OrderID + '-' + (revCount + 1),
        OrderID:    existing.OrderID,
        ChangeType: 'Change Requested',
        ChangedBy:  b.ClientID,
        ChangeDate: new Date().toISOString(),
        Notes:      '',
        OldValue:   JSON.stringify(stale.map(it => ({
          Category:    it.fields.Category    || '',
          ServiceName: it.fields.ServiceName || '',
          SubOption:   it.fields.SubOption   || '',
          Division:    it.fields.Division    || existing.Division
        }))),
        NewValue:   JSON.stringify(newServices)
      });

      return jsonResponse(200, { success: true, orderId: existing.OrderID });
    }

    /* ===== FLUJO C: Orden nueva directa ===== */
    if (!b.Services) return jsonResponse(400, { error: 'Services are required' });

    const allOrderRows = await fetchAllOrderIds();
    const suffix = nextGlobalSuffix(allOrderRows);
    const orderId = String(b.ClientID).trim() + '-' + suffix;

    const result = await createListItem(ORDERS_LIST,
      Object.assign({}, orderFields, { OrderID: orderId, Status: b.Status || 'Received' })
    );

    try {
    const parsedServices = parseServicesString(b.Services, b.Division);
    await Promise.all(parsedServices.map(s =>
      createListItem(ORDER_SERVICES_LIST, {
        Title:       s.ServiceName || '',
        OrderID:     orderId,
        Category:    s.Category,
        ServiceName: s.ServiceName,
        SubOption:   s.SubOption,
        Division:    s.Division
      })
    ));

    await createListItem(ORDER_HISTORY_LIST, {
      Title:      orderId,
      OrderID:    orderId,
      ChangeType: 'Created',
      ChangedBy:  b.ClientID,
      ChangeDate: new Date().toISOString(),
      Notes:      '',
      OldValue:   '',
      NewValue:   b.Status || 'Received'
    });
} catch (e) { console.error('Post-order write failed:', e.message); }
    return jsonResponse(200, { success: true, orderId, id: result.id });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};