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
const { clientPackagesFor } = require('./client-packages');

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
/* levelOverrides (24/09/2026, picker v1.59.0+): { pkgSku: [{sku, level}] }
   -- el nivel escogido para cada servicio de adentro del paquete en ESTA
   orden. Solo cambia el NIVEL de servicios que el paquete ya trae (nunca
   agrega ni quita) y solo acepta Level 1/2/3. Igual que en ordersgsocd.com. */
const VALID_LEVELS = { 'Level 1': 1, 'Level 2': 1, 'Level 3': 1 };
function parseLevelOverrides(raw) {
  let m = raw;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = {}; } }
  const out = {};
  if (!m || typeof m !== 'object') return out;
  Object.keys(m).forEach(k => {
    const byItem = {};
    (Array.isArray(m[k]) ? m[k] : []).forEach(x => { if (x && x.sku && VALID_LEVELS[x.level]) byItem[String(x.sku)] = x.level; });
    out[String(k)] = byItem;
  });
  return out;
}
async function recordPackageSnapshots(orderId, services, actor, _defaults, skipSkus, levelOverrides) {
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
    let custom = {};
    try { custom = await clientPackagesFor(o.fields && o.fields.ClientID); } catch (e) { console.error('ClientPackages for ' + orderId + ':', e.message); }
    const skip = new Set((skipSkus || []).map(String).concat(Object.keys(existing)));
    const snap = {};
    const overrides = parseLevelOverrides(levelOverrides);
    skus.forEach(k => {
      if (skip.has(k) || !bySku[k]) return;
      /* Version del cliente (ClientPackages) si tiene una; si no, la general. */
      const items = custom[k] || packageItemsOf(bySku[k]);
      if (!items.length) return;
      const ov = overrides[k] || {};
      snap[k] = items.map(x => ({ sku: x.sku, serviceName: (bySku[x.sku] && bySku[x.sku].ServiceName) || x.sku, level: ov[String(x.sku)] || x.level || '' }));
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

/* expandPackages (24/09/2026) -- COPIA de ordersgsocd.com/lib/package-contents.js (cambiar las dos).
   (24/09/2026, el dueño: "los paquetes son solo nombres para
   agrupar, no son un servicio como tal; QuickBooks debe recibir cada
   servicio en una linea"): cambia cada renglon que sea PAQUETE por los
   servicios que incluye (version del cliente si tiene, si no la general),
   cada uno con el nivel escogido (levelOverrides = PackageLevels del
   picker) o el nivel estandar del paquete. Lo demas pasa igual. Si un
   servicio ya viene (suelto o en otro paquete), no se repite. Si algo
   falla al leer el catalogo, regresa la lista tal cual (nunca pierde
   servicios). El paquete escogido sigue registrado en
   Orders.PackageContents (recordPackageSnapshots con la lista ORIGINAL). */
async function expandPackages(services, clientId, levelOverrides) {
  const list = Array.isArray(services) ? services : [];
  if (!list.some(s => s && s.SubOption)) return list;
  let bySku = {};
  try {
    const catalog = await fetchAllRows(SERVICES_CATALOG_LIST);
    catalog.forEach(it => { if (it.fields && it.fields.SKU) bySku[String(it.fields.SKU).trim()] = it.fields; });
  } catch (e) { console.error('expandPackages catalog:', e.message); return list; }
  const isPkg = k => !!(k && bySku[k] && packageItemsOf(bySku[k]).length);
  if (!list.some(s => isPkg(String(s.SubOption || '').trim()))) return list;
  let custom = {};
  try { custom = await clientPackagesFor(clientId); } catch (e) { custom = {}; }
  const ov = parseLevelOverrides(levelOverrides);
  const out = [], seen = new Set();
  list.forEach(s => {
    const k = String((s && s.SubOption) || '').trim();
    if (!isPkg(k)) {
      if (k && seen.has(k)) return;
      if (k) seen.add(k);
      out.push(s);
      return;
    }
    const items = (custom[k] && custom[k].length) ? custom[k] : packageItemsOf(bySku[k]);
    items.forEach(x => {
      const sku = String(x.sku || '').trim();
      if (!sku || seen.has(sku)) return;
      seen.add(sku);
      const f = bySku[sku] || {};
      out.push({
        Category:    s.Category || '',
        ServiceName: f.ServiceName || sku,
        SubOption:   sku,
        Division:    f.Division || s.Division || '',
        Level:       (ov[k] && ov[k][sku]) || x.level || '',
        Quantity:    ''
      });
    });
  });
  return out;
}
module.exports = { DEFAULT_PACKAGE_CONTENTS, snapshotsForOrder, recordPackageSnapshots, expandPackages };
