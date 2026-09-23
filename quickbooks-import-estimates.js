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

/* "Includes: 111-59 Dusting (L3), 111-23 Kitchen appliance wipe-down (L2)…" */
function pkgIncludesText(snap, sku) {
  const items = snap && snap[String(sku || '')];
  if (!Array.isArray(items) || !items.length) return '';
  return '\nIncludes: ' + items.map(x => String(x.sku) + ' ' + (x.serviceName || '') + (x.level ? ' (' + String(x.level).replace('Level ', 'L') + ')' : '')).join(', ');
}

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
    /* Precio por nivel (Developer > Service Times): L2/L3 suman % o $ al
       precio de QuickBooks (= Level 1). Se manda como precio de ESA
       linea; el articulo en QuickBooks nunca se reescribe. */
    let levelAdj = {};
    try {
      const st = await queryList('Settings', '$expand=fields&$top=200');
      levelAdj = require('./lib/settings-json').readJson(st, 'catalog_level_prices') || {};
    } catch (e) { levelAdj = {}; }
    const levelPrice = (sku, base, level) => {
      const a = levelAdj[sku] && levelAdj[sku][level === 'Level 2' ? 'l2' : level === 'Level 3' ? 'l3' : ''];
      if (!a) return base;
      const v = Number(a.v) || 0;
      return Math.round((a.t === '$' ? base + v : base * (1 + v / 100)) * 100) / 100;
    };
    const priceBySku = {};
    catalogRows.forEach(it => {
      if (it.fields && it.fields.SKU) priceBySku[it.fields.SKU] = it.fields.Price;
    });

    const results = [];

    for (const o of orders) {
      try {
        const services = o.ServicesDetailed || [];
        if (!services.length) throw new Error('This order has no services to import.');

        /* Lo que incluyo cada paquete EN ESTA orden (su copia congelada,
           'Package Snapshot' en su historial) -- va en la descripcion de
           la linea del paquete, con SKU (pedido del dueño). */
        let pkgSnap = {};
        try {
          const hist = await queryList('OrderHistory', '$expand=fields&$top=200&$filter=' + encodeURIComponent("fields/OrderID eq '" + String(o.OrderID || '').replace(/'/g, "''") + "'"));
          hist.filter(h => h.fields && h.fields.ChangeType === 'Package Snapshot').forEach(h => {
            try { Object.assign(pkgSnap, JSON.parse(h.fields.NewValue || '{}')); } catch (e) { /* sigue */ }
          });
        } catch (e) { pkgSnap = {}; }

        const lines = [];
        for (const s of services) {
          const sku = s.SubOption;
          if (!sku) throw new Error('Service "' + s.ServiceName + '" has no SKU on file.');
          const itemId = await findItemIdBySku(sku);
          if (!itemId) throw new Error('Service "' + s.ServiceName + '" (SKU ' + sku + ') was not found in QuickBooks.');
          const price = priceBySku[sku] != null ? levelPrice(sku, Number(priceBySku[sku]), s.Level) : 0;
          const qty = Number(s.Quantity) || 1;
          lines.push({
            Amount: price * qty,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: qty, UnitPrice: price },
            Description: s.ServiceName + (s.Level ? ' — ' + s.Level : '') + pkgIncludesText(pkgSnap, sku)
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
