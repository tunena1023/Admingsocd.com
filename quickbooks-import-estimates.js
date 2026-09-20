/* ============================================================
   quickbooks-import-estimates.js — recibe las ordenes que el
   staff selecciono en el panel de QuickBooks y las manda como
   Estimate (cotizacion), una por una. Cada orden se procesa por
   separado -- si una falla (ej. un servicio sin SKU en QuickBooks
   todavia), las demas se siguen procesando; el resultado de cada
   una se regresa por separado para que la pantalla lo muestre.

   No vuelve a pedir el detalle de cada orden -- confia en los datos
   que Admin ya trae cargados (ClientID, BusinessName, direccion,
   ServicesDetailed), los mismos que usan Approvals/Active. El unico
   dato que SI se vuelve a pedir fresco aqui es el precio de cada
   servicio (ServicesCatalog, por SKU) -- ese es el que de verdad
   importa que este actualizado, no vale la pena confiar en lo que
   traiga el navegador para eso.
============================================================ */

const {
  ORDER_HISTORY_LIST, SERVICES_CATALOG_LIST,
  createListItem, queryList,
  jsonResponse
} = require('./lib/graph');

const {
  isConnected, findItemIdBySku, findOrCreateCustomerId, createEstimate,
  markOrderImported
} = require('./lib/quickbooks');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (!orders.length) return jsonResponse(400, { error: 'No orders provided' });

    if (!(await isConnected())) {
      return jsonResponse(409, { error: 'QuickBooks is not connected yet.' });
    }

    /* Precio actual de cada SKU -- una sola pasada al catalogo
       completo, no una consulta por servicio por orden. */
    const catalogRows = await queryList(SERVICES_CATALOG_LIST, '$expand=fields&$top=500');
    const priceBySku = {};
    catalogRows.forEach(it => {
      if (it.fields && it.fields.SKU) priceBySku[it.fields.SKU] = it.fields.Price;
    });

    const results = [];

    for (const o of orders) {
      try {
        const services = o.ServicesDetailed || [];
        if (!services.length) throw new Error('This order has no services to import.');

        const lines = [];
        for (const s of services) {
          const sku = s.SubOption;
          if (!sku) throw new Error('Service "' + s.ServiceName + '" has no SKU on file.');
          const itemId = await findItemIdBySku(sku);
          if (!itemId) throw new Error('Service "' + s.ServiceName + '" (SKU ' + sku + ') was not found in QuickBooks.');
          const price = priceBySku[sku] != null ? Number(priceBySku[sku]) : 0;
          const qty = Number(s.Quantity) || 1;
          lines.push({
            Amount: price * qty,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: qty, UnitPrice: price },
            Description: s.ServiceName + (s.Level ? ' — ' + s.Level : '')
          });
        }

        const customerId = await findOrCreateCustomerId(o.ClientID, o.BusinessName, {
          address: o.Address, city: o.City, zip: o.Zip
        });

        const estimateRes = await createEstimate({ CustomerRef: { value: customerId }, Line: lines });
        const estimate = estimateRes.Estimate;

        await Promise.all([
          markOrderImported(o.OrderID, estimate.Id, estimate.DocNumber || ''),
          createListItem(ORDER_HISTORY_LIST, {
            Title: o.OrderID + '-qbestimate',
            OrderID: o.OrderID,
            ChangeType: 'QuickBooks Estimate Created',
            ChangedBy: 'Admin',
            ChangeDate: new Date().toISOString(),
            Notes: 'Estimate ' + (estimate.DocNumber || ('#' + estimate.Id)) + ' created in QuickBooks.'
          })
        ]);

        results.push({ orderId: o.OrderID, success: true, estimateId: estimate.Id, docNumber: estimate.DocNumber || '' });
      } catch (err) {
        results.push({ orderId: o.OrderID, success: false, error: err.message });
      }
    }

    return jsonResponse(200, { results });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
