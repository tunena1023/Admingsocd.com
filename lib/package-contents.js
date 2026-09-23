/* ============================================================
   lib/package-contents.js -- paquetes (23/09/2026, columnas reales).

   - Lo que incluye cada paquete vive en ServicesCatalog.PackageItems
     (JSON [{sku, level}]); lo edita Developer > Package contents.
   - La copia congelada por orden vive en Orders.PackageContents (JSON
     {skuPaquete: [{sku, serviceName, level}]}): lo que incluia el
     paquete EL DIA que se creo la orden (o se le agrego el paquete).
     Cambiar un paquete despues solo afecta ordenes nuevas.
   DEFAULT_PACKAGE_CONTENTS es el borrador del mini; solo lo usa la
   migracion unica de developer-admin.js.
============================================================ */
const { SERVICES_CATALOG_LIST, ORDERS_LIST, graphFetch, siteListPath, updateListItemByItemId } = require('./graph');
const { packageItemsOf } = require('./catalog-fields');

const DEFAULT_PACKAGE_CONTENTS = {"111-50": [{"sku": "111-59", "level": "Level 3"}, {"sku": "111-23", "level": "Level 3"}, {"sku": "111-13", "level": "Level 3"}, {"sku": "111-25", "level": "Level 2"}, {"sku": "111-36", "level": "Level 1"}, {"sku": "111-57", "level": "Level 2"}, {"sku": "111-58", "level": "Level 3"}, {"sku": "111-15", "level": "Level 1"}, {"sku": "111-56", "level": "Level 1"}], "111-48": [{"sku": "111-59", "level": "Level 2"}, {"sku": "111-23", "level": "Level 2"}, {"sku": "111-13", "level": "Level 2"}, {"sku": "111-25", "level": "Level 2"}, {"sku": "111-36", "level": "Level 1"}, {"sku": "111-57", "level": "Level 2"}, {"sku": "111-58", "level": "Level 2"}], "111-43": [{"sku": "111-59", "level": "Level 2"}, {"sku": "111-23", "level": "Level 1"}, {"sku": "111-13", "level": "Level 2"}, {"sku": "111-57", "level": "Level 2"}, {"sku": "111-58", "level": "Level 2"}, {"sku": "111-15", "level": "Level 1"}], "111-42": [{"sku": "111-59", "level": "Level 1"}, {"sku": "111-13", "level": "Level 1"}, {"sku": "111-57", "level": "Level 1"}, {"sku": "111-58", "level": "Level 1"}, {"sku": "111-15", "level": "Level 1"}], "111-10": [{"sku": "111-59", "level": "Level 3"}, {"sku": "111-36", "level": "Level 2"}, {"sku": "111-23", "level": "Level 2"}, {"sku": "111-13", "level": "Level 3"}, {"sku": "111-25", "level": "Level 3"}, {"sku": "111-57", "level": "Level 3"}, {"sku": "111-58", "level": "Level 3"}]};

async function fetchAllRows(listName, filter) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200' + (filter ? '&$filter=' + encodeURIComponent(filter) : '');
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

async function orderRow(orderId) {
  const rows = await fetchAllRows(ORDERS_LIST, "fields/OrderID eq '" + String(orderId).replace(/'/g, "''") + "'");
  return rows[0] || null;
}

/* Lo que ya tiene congelado una orden: {skuPaquete: [items]} */
async function snapshotsForOrder(orderId) {
  const o = await orderRow(orderId);
  if (!o || !o.fields || !o.fields.PackageContents) return {};
  try { return JSON.parse(o.fields.PackageContents) || {}; } catch (e) { return {}; }
}

/* services: [{ SubOption (SKU), ... }]. Los paquetes que la orden ya
   tenia congelados no se vuelven a fotografiar. Nunca truena la
   creacion de la orden: si algo falla, se registra y se sigue. */
async function recordPackageSnapshots(orderId, services, actor, _defaults, skipSkus) {
  try {
    const skus = [...new Set((services || []).map(s => String((s && (s.SubOption || s.sku)) || '').trim()).filter(Boolean))];
    if (!skus.length) return null;
    const catalog = await fetchAllRows(SERVICES_CATALOG_LIST);
    const bySku = {};
    catalog.forEach(it => { if (it.fields && it.fields.SKU) bySku[String(it.fields.SKU).trim()] = it.fields; });
    const o = await orderRow(orderId);
    if (!o) return null;
    let existing = {};
    try { existing = JSON.parse(o.fields.PackageContents || '{}') || {}; } catch (e) { existing = {}; }
    const skip = new Set((skipSkus || []).map(String).concat(Object.keys(existing)));
    const snap = {};
    skus.forEach(k => {
      if (skip.has(k) || !bySku[k]) return;
      const items = packageItemsOf(bySku[k]);
      if (!items.length) return;
      snap[k] = items.map(x => ({ sku: x.sku, serviceName: (bySku[x.sku] && bySku[x.sku].ServiceName) || x.sku, level: x.level || '' }));
    });
    if (!Object.keys(snap).length) return null;
    const merged = Object.assign({}, existing, snap);
    await updateListItemByItemId(ORDERS_LIST, o.id, { PackageContents: JSON.stringify(merged) });
    return snap;
  } catch (e) {
    console.error('Package snapshot for ' + orderId + ':', e.message);
    return null;
  }
}

module.exports = { DEFAULT_PACKAGE_CONTENTS, snapshotsForOrder, recordPackageSnapshots };
