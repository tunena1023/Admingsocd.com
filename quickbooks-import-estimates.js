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
  ORDER_HISTORY_LIST, SERVICES_CATALOG_LIST, SERVICE_ASSIGNMENTS_LIST,
  createListItem, queryList, ORDERS_LIST,
  jsonResponse
} = require('./lib/graph');
const lq = require('./lib/list-query');

const {
  isConnected, findItemBySku, findOrCreateCustomerId, createSalesDoc,
  markOrderImported, getImportedOrders, getSendPerms, getCompanySetup, getClassesAndDepartments,
  usesCustomTxnNumbers, nextDocNumber
} = require('./lib/quickbooks');

/* ============================================================
   MAPEO AL DOCUMENTO DE QUICKBOOKS (25/09/2026), copiado del invoice
   real #5177 que mando el dueño:
   - Fecha del documento (TxnDate) = el dia en que se crea (hoy, hora
     de Iowa).
   - Fecha de cada linea (ServiceDate) = el dia en que se completo ESE
     servicio (ServiceAssignments.CompletedDate si se asigno por
     servicio; si no, Orders.CompletedDate).
   - UNIT # / BEDROOMS / BATHROOMS = los campos personalizados de la
     compania, buscados por nombre (getCompanySetup). Si un campo no
     existe en esa compania, simplemente no se manda.
   - Ship To = direccion de la propiedad de la orden.
   - Impuesto: cada linea cobra impuesto si el articulo de QuickBooks
     es Taxable (las "T" del invoice real).
   - Numero: el siguiente al ultimo que ya hay (ver nextDocNumber).
   - Nota interna (PrivateNote): el numero de orden de la app.
   - Estimate o Invoice segun lo que escoja la persona en el panel, y
     solo si tiene permiso para ese tipo (Developer > Staff & Roles).
   Solo se CREAN documentos; nunca se edita uno que ya exista.
============================================================ */
const TZ = 'America/Chicago';
const STATE = process.env.QUICKBOOKS_DEFAULT_STATE || 'IA';
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const isoDay = v => { if (!v) return ''; const d = new Date(v); return isNaN(d) ? '' : ymd(d); };
const low = v => String(v || '').trim().toLowerCase();

/* Class / Department por nombre: se comparan las primeras letras
   ("Renovations" = "Renovation Services", "Exterior" = "Exteriors"). */
const stem = v => low(v).replace(/[^a-z]/g, '').slice(0, 5);
function classFor(cd, division) {
  return cd.classes.find(c => !c.full.includes(':') && stem(c.name) === stem(division));
}
function departmentFor(cd, division, propertyType) {
  return cd.departments.find(d => {
    const parts = d.full.split(':');
    return parts.length === 2 && stem(parts[0]) === stem(division) && low(parts[1]) === low(propertyType);
  });
}

function customFieldsFor(setup, o) {
  const unit = String(o.UnitNumber || '').trim() || String(o.BuildingNumber || '').trim();
  const want = [
    [/unit/i, unit],
    [/bed/i, o.Bedrooms],
    [/bath/i, o.Bathrooms]
  ];
  const out = [];
  want.forEach(([re, val]) => {
    const f = setup.customFields.find(x => re.test(x.name));
    if (f && val != null && String(val).trim() !== '') {
      out.push({ DefinitionId: f.definitionId, Name: f.name, Type: 'StringType', StringValue: String(val).trim().slice(0, 31) });
    }
  });
  return out;
}

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

    const sendAs = body.sendAs === 'invoice' ? 'invoice' : 'estimate';
    const perms = await getSendPerms((event.headers || {})['x-gs-user-email']);
    if (!perms[sendAs]) {
      return jsonResponse(403, { error: 'You are not allowed to send ' + (sendAs === 'invoice' ? 'Invoices' : 'Estimates') + ' to QuickBooks. Ask a Developer to turn it on in Staff & Roles.' });
    }
    const [setup, customNums, already, cd] = await Promise.all([
      getCompanySetup(), usesCustomTxnNumbers(), getImportedOrders(), getClassesAndDepartments()
    ]);
    const docLabel = sendAs === 'invoice' ? 'Invoice' : 'Estimate';
    const today = ymd(new Date());

    /* Precio actual de cada SKU -- una sola pasada al catalogo
       completo, no una consulta por servicio por orden. */
    const catalogRows = await queryList(SERVICES_CATALOG_LIST, '$expand=fields&$top=500');
    /* Precio por nivel (columnas Level2/3Price+Mode de ServicesCatalog):
       L2/L3 suman % o $ al precio de QuickBooks (= Level 1). Se manda
       como precio de ESA linea; el articulo en QuickBooks no se toca. */
    const { levelAdjustOf, levelPricesFor } = require('./lib/catalog-fields');
    const adjBySku = {};
    catalogRows.forEach(it => { if (it.fields && it.fields.SKU) adjBySku[it.fields.SKU] = levelAdjustOf(it.fields); });
    /* BUG REAL (24/09/2026, lo encontro una revision de variables sin
       definir): el 23/09 (9aabf4a) se borro por accidente este mapa de
       precios junto con el viejo de Settings, y cada importacion a
       QuickBooks tronaba con 'priceBySku is not defined'. */
    const priceBySku = {};
    catalogRows.forEach(it => { if (it.fields && it.fields.SKU) priceBySku[it.fields.SKU] = it.fields.Price; });
    const divBySku = {}, propBySku = {};
    catalogRows.forEach(it => { const f = it.fields || {}; if (f.SKU) { divBySku[f.SKU] = f.Division || ''; propBySku[f.SKU] = f.PropertyType || ''; } });
    const levelPrice = (sku, base, level) => {
      const lp = levelPricesFor(base, adjBySku[sku]);
      return lp && lp[level] != null ? lp[level] : base;
    };

    const results = [];

    for (const o of orders) {
      try {
        /* Nunca dos documentos para la misma orden. */
        if (already[o.OrderID]) throw new Error('Already sent to QuickBooks' + (already[o.OrderID].docNumber ? ' (#' + already[o.OrderID].docNumber + ')' : '') + '.');
        const services = o.ServicesDetailed || [];
        if (!services.length) throw new Error('This order has no services to import.');

        /* Lo que incluyo cada paquete EN ESTA orden (columna
           Orders.PackageContents) -- va en la descripcion de la linea del
           paquete, con SKU (pedido del dueño). */
        let pkgSnap = {};
        try {
          const rows = await queryList(ORDERS_LIST, '$expand=fields&$top=5&$filter=' + encodeURIComponent("fields/OrderID eq '" + String(o.OrderID || '').replace(/'/g, "''") + "'"));
          pkgSnap = JSON.parse((rows[0] && rows[0].fields && rows[0].fields.PackageContents) || '{}') || {};
        } catch (e) { pkgSnap = {}; }

        /* 24/09/2026 (el dueño: "QuickBooks debe recibir cada servicio en
           una linea; los paquetes son solo nombres para agrupar"). Las
           ordenes nuevas ya guardan cada servicio suelto. Las VIEJAS que
           todavia traen el renglon del paquete se desglosan aqui con lo
           que incluyo el paquete EN ESA orden (PackageContents): una linea
           por servicio, con su nivel y su precio. */
        const expanded = [];
        services.forEach(s => {
          const items = pkgSnap[String(s.SubOption || '')];
          if (Array.isArray(items) && items.length) {
            items.forEach(x => expanded.push({ ServiceName: x.serviceName || x.sku, SubOption: x.sku, Level: x.level || '', Quantity: s.Quantity || '', fromPackage: s.ServiceName, parentKey: low(s.Category) + '|' + low(s.ServiceName), Division: s.Division || '' }));
          } else expanded.push(s);
        });
        /* Dia en que se completo cada servicio. */
        const doneBy = {};
        try {
          const sa = await lq.fetchByValues(SERVICE_ASSIGNMENTS_LIST, 'OrderID', [o.OrderID]);
          sa.forEach(it => {
            const f = it.fields || {};
            if (f.CompletedDate) doneBy[low(f.Category) + '|' + low(f.ServiceName)] = f.CompletedDate;
          });
        } catch (e) { /* sin asignaciones por servicio: se usa la fecha de la orden */ }
        const orderDone = isoDay(o.CompletedDate);

        const lines = [], lineDivs = [], lineProps = [];
        for (const s of expanded) {
          const sku = s.SubOption;
          if (!sku) throw new Error('Service "' + s.ServiceName + '" has no SKU on file.');
          const item = await findItemBySku(sku);
          if (!item) throw new Error('Service "' + s.ServiceName + '" (SKU ' + sku + ') was not found in QuickBooks.');
          const price = priceBySku[sku] != null ? levelPrice(sku, Number(priceBySku[sku]), s.Level) : 0;
          const qty = Number(s.Quantity) || 1;
          const serviceDate = isoDay(doneBy[low(s.Category) + '|' + low(s.ServiceName)] || doneBy[s.parentKey]) || orderDone;
          const detail = { ItemRef: { value: item.id }, Qty: qty, UnitPrice: price, TaxCodeRef: { value: item.taxable ? 'TAX' : 'NON' } };
          if (serviceDate) detail.ServiceDate = serviceDate;
          const division = s.Division || divBySku[sku] || o.Division || '';
          lineDivs.push(division);
          if (propBySku[sku]) lineProps.push(propBySku[sku]);
          if (setup.classTracking) {
            const cls = classFor(cd, division);
            if (!cls) throw new Error('Class "' + (division || '(no division)') + '" was not found in QuickBooks for "' + s.ServiceName + '", so nothing was created.');
            detail.ClassRef = { value: cls.id };
          }
          lines.push({
            Amount: price * qty,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: detail,
            Description: s.ServiceName + (s.Level ? ' — ' + s.Level : '') + (s.fromPackage ? ' (' + s.fromPackage + ')' : '')
          });
        }

        const customerId = await findOrCreateCustomerId(o.ClientID, o.BusinessName, {
          address: o.Address, city: o.City, zip: o.Zip
        });

        const doc = {
          CustomerRef: { value: customerId },
          TxnDate: today,
          Line: lines,
          PrivateNote: 'GS app order ' + o.OrderID
        };
        const cf = customFieldsFor(setup, o);
        if (cf.length) doc.CustomField = cf;
        if (o.Address) {
          doc.ShipAddr = { Line1: o.Address, City: o.City || '', CountrySubDivisionCode: STATE, PostalCode: o.Zip || '' };
          if (o.Suite) doc.ShipAddr.Line2 = o.Suite;
        }
        /* Department solo en invoices (los estimates de GS no lo llevan).
           Una sola division -> "<Division> Services:<tipo>"; varias ->
           "Mixed Services:<tipo>" (hay que crearlo en QuickBooks). */
        if (sendAs === 'invoice' && setup.locationTracking) {
          const divs = [...new Set(lineDivs.map(stem).filter(Boolean))];
          const division = divs.length === 1 ? lineDivs.find(d => stem(d) === divs[0]) : 'Mixed';
          const counts = {};
          lineProps.forEach(p => { counts[p] = (counts[p] || 0) + 1; });
          const propertyType = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'Commercial';
          const dep = departmentFor(cd, division, propertyType);
          if (!dep) throw new Error((setup.locationLabel || 'Department') + ' "' + division + ' Services:' + propertyType + '" was not found in QuickBooks, so nothing was created.');
          doc.DepartmentRef = { value: dep.id };
        }
        if (customNums) doc.DocNumber = await nextDocNumber(sendAs);

        /* Nada se llena a mano (el dueño, 25/09/2026): si la orden trae
           unidad / recamaras / baños y QuickBooks no tiene donde
           ponerlos, NO se crea el documento -- se avisa y la orden se
           queda lista para mandarse otra vez. Nunca en la descripcion. */
        const needsFields = [o.UnitNumber || o.BuildingNumber, o.Bedrooms, o.Bathrooms].filter(v => String(v || '').trim()).length;
        if (needsFields && cf.length < needsFields) {
          throw new Error('QuickBooks fields for Unit #, Bedrooms or Bathrooms were not found, so nothing was created.');
        }
        const estimate = await createSalesDoc(sendAs, doc);

        await Promise.all([
          markOrderImported(o.OrderID, estimate.Id, estimate.DocNumber || '', sendAs),
          createListItem(ORDER_HISTORY_LIST, {
            Title: o.OrderID + '-qb' + sendAs,
            OrderID: o.OrderID,
            ChangeType: 'QuickBooks ' + docLabel + ' Created',
            ChangedBy: 'Admin',
            ChangeDate: new Date().toISOString(),
            Notes: docLabel + ' ' + (estimate.DocNumber || ('#' + estimate.Id)) + ' created in QuickBooks.'
          })
        ]);
        already[o.OrderID] = { docNumber: estimate.DocNumber || '' };

        results.push({ orderId: o.OrderID, success: true, type: sendAs, estimateId: estimate.Id, docNumber: estimate.DocNumber || '' });
      } catch (err) {
        results.push({ orderId: o.OrderID, success: false, error: err.message });
      }
    }

    return jsonResponse(200, { results, sendAs });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
