/* ============================================================
   submit-order.js — enviar orden nueva o convertir draft en orden.

   Flujos:
   A) OrderID contiene "-TEMP-" → viene de Drafts
   B) OrderID real existe en Orders → edición de orden existente
   C) Sin OrderID → orden nueva directa
============================================================ */

const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, DRAFTS_LIST, CLIENT_ADDRESSES_LIST,
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
      const parts = id.split('-');
      const last = parts[parts.length - 1];
      /* Ordenes de un pedido multi-unidad terminan en "-PONNNN"; el
         sufijo real (el que hay que contar) es el segmento de ANTES
         de ese, no el ultimo. Sin esto, esos sufijos quedan invisibles
         para el contador y se podrian repetir por accidente. */
      const s = /^PO\d+$/.test(last) ? parts[parts.length - 2] : last;
      const n = parseInt(s, 10);
      return isNaN(n) ? null : n;
    })
    .filter(n => n !== null);

  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1001;
  return String(next).padStart(4, '0');
}

/* PO compartido entre las unidades de un pedido multi-unidad. Mismo
   criterio que nextGlobalSuffix: global (no por cliente), arranca en
   5000 para nunca confundirse a simple vista con un sufijo normal. */
function nextGlobalPO(allOrderRows) {
  const nums = allOrderRows
    .map(it => {
      const id = String(it.fields?.OrderID || it.fields?.Title || '');
      const m = id.match(/-PO(\d+)$/);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(n => n !== null);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 5000;
  return 'PO' + next;
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

/* BUG FIX (2026-08-30): admin.html manda Services como arreglo de objetos
   { Category, ServiceName, SubOption, Division }, no como el string
   "Categoria > Servicio – Opcion | ..." que parseServicesString espera.
   Antes, un arreglo se convertia con String() a "[object Object],..." y
   parseServicesString no encontraba nada que parsear, guardando la orden
   sin ningun servicio. resolveServices acepta ambos formatos para que
   ningun llamador (actual o futuro) pierda servicios silenciosamente. */
function resolveServices(raw, division) {
  if (Array.isArray(raw)) {
    return raw.map(s => ({
      Category:    s.Category    || '',
      ServiceName: s.ServiceName || '',
      SubOption:   s.SubOption   || '',
      Division:    s.Division    || division
    })).filter(s => s.Category || s.ServiceName);
  }
  return parseServicesString(raw, division);
}

function dateField(v) { return v ? v : null; }


exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.ClientID) {
      return jsonResponse(400, { error: 'ClientID is required' });
    }

    /* ===== FLUJO E: agregar UNA unidad a un PO ya existente =====
       Se checa ANTES que todo lo demas (igual que aprendimos con el
       bug del draft desviando el lote nuevo) para que nunca se
       confunda con una orden normal. Copia Division/Servicios/
       BusinessName/Requester del resto del lote -- solo pide
       Building, Unit#, Bed/Bath y fechas de la unidad nueva. */
    if (b.AddUnitToBatch) {
      const add = b.AddUnitToBatch;
      if (!add.batchId)    return jsonResponse(400, { error: 'batchId is required' });
      if (!add.buildingId) return jsonResponse(400, { error: 'Please choose a building.' });
      if (!add.unitNumber) return jsonResponse(400, { error: 'Please enter the Unit Number.' });
      if (!add.bedrooms)   return jsonResponse(400, { error: 'Please enter Bedrooms.' });
      if (!add.bathrooms)  return jsonResponse(400, { error: 'Please enter Bathrooms.' });
      if (!add.entryDate)  return jsonResponse(400, { error: 'Please enter the entry date.' });
      if (!add.dueDate)    return jsonResponse(400, { error: 'Please enter the due date.' });

      const [allOrders, allBuildings] = await Promise.all([
        fetchAll(ORDERS_LIST),
        fetchAll(CLIENT_ADDRESSES_LIST)
      ]);

      const clientOrders = allOrders.filter(it =>
        it.fields && String(it.fields.ClientID || '').trim().toLowerCase() === String(b.ClientID).trim().toLowerCase()
      );
      const siblings = clientOrders.filter(it => it.fields.BatchId === add.batchId);
      if (!siblings.length) return jsonResponse(404, { error: 'That order was not found.' });

      const building = allBuildings.find(it =>
        it.id === String(add.buildingId) &&
        it.fields && String(it.fields.ClientID || '').trim().toLowerCase() === String(b.ClientID).trim().toLowerCase()
      );
      if (!building) return jsonResponse(403, { error: 'That building does not belong to this client.' });
      const bf = building.fields;

      const template = siblings[0].fields;
      const actor = (b.changedBy && String(b.changedBy).trim()) || 'Admin';
      const suffix = nextGlobalSuffix(allOrders);
      const orderId = String(b.ClientID).trim() + '-' + suffix + '-' + add.batchId;

      await createListItem(ORDERS_LIST, {
        Title:          template.BusinessName || '',
        OrderID:        orderId,
        ClientID:       b.ClientID,
        BusinessName:   template.BusinessName || '',
        Requester:      template.Requester || '',
        Division:       template.Division || '',
        DirtLevel:      template.DirtLevel || '',
        Status:         'Received',
        BuildingNumber: bf.BuildingNumber || '',
        UnitNumber:     add.unitNumber,
        Bedrooms:       add.bedrooms,
        Bathrooms:      add.bathrooms,
        Address:        bf.Address || '',
        Suite:          bf.Suite   || '',
        City:           bf.City    || '',
        Zip:            bf.Zip     || '',
        Email:          template.Email || '',
        Notes:          template.Notes || '',
        EntryDate:      add.entryDate,
        DueDate:        add.dueDate,
        DraftData:      '',
        BatchId:        add.batchId,
        BuildingId:     String(add.buildingId)
      });

      try {
        const svcRows = await fetchByOrderId(ORDER_SERVICES_LIST, template.OrderID);
        await Promise.all(svcRows.map(row => {
          const f = row.fields;
          return createListItem(ORDER_SERVICES_LIST, {
            Title:       f.ServiceName || '',
            OrderID:     orderId,
            Category:    f.Category    || '',
            ServiceName: f.ServiceName || '',
            SubOption:   f.SubOption   || '',
            Division:    f.Division    || template.Division
          });
        }));

        await createListItem(ORDER_HISTORY_LIST, {
          Title:      orderId,
          OrderID:    orderId,
          ChangeType: 'Created',
          ChangedBy:  actor,
          ChangeDate: new Date().toISOString(),
          Notes:      'Added to existing order ' + template.OrderID + ' by ' + actor + '.',
          OldValue:   '',
          NewValue:   'Received'
        });
      } catch (e) {
        console.error('AddUnitToBatch post-create write failed:', e.message);
      }

      return jsonResponse(200, { success: true, orderId });
    }

    if (!b.Division) {
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

      /* Red de seguridad: si el draft no trae ninguna fila de servicio
         guardada (por ejemplo, una carrera con el autosave, una limpieza
         de borrador huerfano que corrio en paralelo, o un retraso de
         replicacion de SharePoint), no dejar la orden sin servicios.
         El cliente ya mando su seleccion actual en este mismo envio
         (b.Services); usarla como respaldo en vez de perderla. */
      const svcSource = draftServiceRows.length
        ? draftServiceRows.map(row => ({
            Category:    row.fields.Category    || '',
            ServiceName: row.fields.ServiceName || '',
            SubOption:   row.fields.SubOption   || '',
            Division:    row.fields.Division    || b.Division
          }))
        : resolveServices(b.Services, b.Division);

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
          ...svcSource.map(s =>
            createListItem(ORDER_SERVICES_LIST, {
              Title:       s.ServiceName || '',
              OrderID:     orderId,
              Category:    s.Category    || '',
              ServiceName: s.ServiceName || '',
              SubOption:   s.SubOption   || '',
              Division:    s.Division    || b.Division
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

      for (const s of resolveServices(b.Services, b.Division)) {
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
      const newServices = resolveServices(b.Services, b.Division).map(s => ({
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

    /* ===== FLUJO D: Pedido multi-unidad → N ordenes reales con un PO compartido =====
       Calcado del Flujo D del repo orders, adaptado al estilo de este
       archivo (fetchAll + filtro en JS, no fetchByField) y con
       atribucion de quien lo creo (changedBy) en vez de asumir que
       fue el propio cliente. */
    if (Array.isArray(b.Units) && b.Units.length >= 2) {
      if (!b.Services) return jsonResponse(400, { error: 'Services are required' });

      const buildingIds = b.Units.map(u => String(u.buildingId || '').trim());
      if (buildingIds.some(id => !id)) {
        return jsonResponse(400, { error: 'Every unit needs a building selected.' });
      }

      const [allOrderRows, allBuildingRows] = await Promise.all([
        fetchAll(ORDERS_LIST),
        fetchAll(CLIENT_ADDRESSES_LIST)
      ]);
      const buildingRows = allBuildingRows.filter(it =>
        it.fields && String(it.fields.ClientID || '').trim().toLowerCase() === String(b.ClientID).trim().toLowerCase()
      );

      const buildingsById = {};
      buildingRows.forEach(it => { if (it.fields) buildingsById[it.id] = it.fields; });
      for (const id of buildingIds) {
        if (!buildingsById[id]) return jsonResponse(403, { error: 'One of the selected buildings does not belong to this client.' });
      }

      const actor = (b.changedBy && String(b.changedBy).trim()) || 'Admin';
      const poTag = nextGlobalPO(allOrderRows);
      let nextSuffixNum = parseInt(nextGlobalSuffix(allOrderRows), 10);
      const parsedServices = resolveServices(b.Services, b.Division);

      const createdOrderIds = [];
      for (const unit of b.Units) {
        const bId = String(unit.buildingId).trim();
        const bf = buildingsById[bId];
        const suffix = String(nextSuffixNum++).padStart(4, '0');
        const orderId = String(b.ClientID).trim() + '-' + suffix + '-' + poTag;

        const unitFields = Object.assign({}, orderFields, {
          OrderID:        orderId,
          Status:         b.Status || 'Received',
          BuildingNumber: bf.BuildingNumber || '',
          UnitNumber:     unit.unitNumber || '',
          Bedrooms:       unit.bedrooms    || '',
          Bathrooms:      unit.bathrooms   || '',
          Address:        bf.Address || '',
          Suite:          bf.Suite   || '',
          City:           bf.City    || '',
          Zip:            bf.Zip     || '',
          BatchId:        poTag,
          BuildingId:     bId
        });

        try {
          await createListItem(ORDERS_LIST, unitFields);
        } catch (e) {
          throw new Error('Could not create unit ' + orderId + ': ' + e.message);
        }

        try {
          await Promise.all(parsedServices.map(s =>
            createListItem(ORDER_SERVICES_LIST, {
              Title:       s.ServiceName || '',
              OrderID:     orderId,
              Category:    s.Category    || '',
              ServiceName: s.ServiceName || '',
              SubOption:   s.SubOption   || '',
              Division:    s.Division    || b.Division
            })
          ));

          await createListItem(ORDER_HISTORY_LIST, {
            Title:      orderId,
            OrderID:    orderId,
            ChangeType: 'Created',
            ChangedBy:  actor,
            ChangeDate: new Date().toISOString(),
            Notes:      '',
            OldValue:   '',
            NewValue:   b.Status || 'Received'
          });
        } catch (e) {
          /* Mismo criterio que el Flujo C: un problema al escribir
             servicios/historial no debe tumbar la orden completa. */
          console.error('Batch unit post-order write failed for ' + orderId + ':', e.message);
        }

        createdOrderIds.push(orderId);
      }

      /* Fila resumen del lote, pegada a la ULTIMA unidad creada. */
      const lastOrderId = createdOrderIds[createdOrderIds.length - 1];
      try {
        await createListItem(ORDER_HISTORY_LIST, {
          Title:      lastOrderId + '-batch',
          OrderID:    lastOrderId,
          ChangeType: 'Batch Created',
          ChangedBy:  actor,
          ChangeDate: new Date().toISOString(),
          Notes:      '',
          OldValue:   poTag,
          NewValue:   JSON.stringify(createdOrderIds)
        });
      } catch (e) { console.error('Batch Created history write failed:', e.message); }

      return jsonResponse(200, { success: true, batchId: poTag, orderIds: createdOrderIds });
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
    const parsedServices = resolveServices(b.Services, b.Division);
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
      /* Si la orden se creo desde admin (Create Order), el "quien lo hizo"
         debe ser la persona de oficina que la creo, no el numero de
         cliente -- para eso admin.html manda b.ChangedBy con el nombre
         del staff logueado. Si la mando el cliente (flujo normal desde
         customer.html), b.ChangedBy nunca llega y se sigue usando su
         ClientID como siempre. */
      ChangedBy:  (b.OfficeCreated && b.ChangedBy) ? b.ChangedBy : b.ClientID,
      ChangeDate: new Date().toISOString(),
      Notes:      '',
      FieldChanged: b.OfficeCreated ? 'Office Order' : '',
      OldValue:   '',
      NewValue:   b.Status || 'Received'
    });
} catch (e) { console.error('Post-order write failed:', e.message); }
    return jsonResponse(200, { success: true, orderId, id: result.id });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};