/* ============================================================
   lib/package-contents.js -- contenido de los paquetes (plantillas) y
   su "foto" por orden (23/09/2026, pedido del dueño: "cada orden guarda
   sus datos; lo que ya paso no se cambia; los cambios van del dia del
   cambio en adelante").

   - Contenido vigente: Settings, Key catalog_package_contents, JSON
     {skuPaquete: [{sku, level}]} (lo edita Developer > Package contents;
     sin editar, el default de developer-admin.js).
   - Al crear una orden (o agregarle un paquete) se congela lo que
     incluia ESE dia en su historial: ChangeType 'Package Snapshot',
     FieldChanged 'Office Change (Internal)' (el cliente no lo ve; Admin
     lo saca de la linea de tiempo), NewValue JSON
     {skuPaquete: [{sku, serviceName, level}]}. Admin muestra "Includes"
     SOLO desde esa foto.
============================================================ */
const {
  SETTINGS_LIST, SERVICES_CATALOG_LIST, ORDER_HISTORY_LIST,
  graphFetch, siteListPath, createListItem
} = require('./graph');

const PACKAGE_CONTENTS_KEY = 'catalog_package_contents';
/* Borrador aprobado en el mini (se usa mientras nadie edite los paquetes). */
const DEFAULT_PACKAGE_CONTENTS = {"111-50": [{"sku": "111-59", "level": "Level 3"}, {"sku": "111-23", "level": "Level 3"}, {"sku": "111-13", "level": "Level 3"}, {"sku": "111-25", "level": "Level 2"}, {"sku": "111-36", "level": "Level 1"}, {"sku": "111-57", "level": "Level 2"}, {"sku": "111-58", "level": "Level 3"}, {"sku": "111-15", "level": "Level 1"}, {"sku": "111-56", "level": "Level 1"}], "111-48": [{"sku": "111-59", "level": "Level 2"}, {"sku": "111-23", "level": "Level 2"}, {"sku": "111-13", "level": "Level 2"}, {"sku": "111-25", "level": "Level 2"}, {"sku": "111-36", "level": "Level 1"}, {"sku": "111-57", "level": "Level 2"}, {"sku": "111-58", "level": "Level 2"}], "111-43": [{"sku": "111-59", "level": "Level 2"}, {"sku": "111-23", "level": "Level 1"}, {"sku": "111-13", "level": "Level 2"}, {"sku": "111-57", "level": "Level 2"}, {"sku": "111-58", "level": "Level 2"}, {"sku": "111-15", "level": "Level 1"}], "111-42": [{"sku": "111-59", "level": "Level 1"}, {"sku": "111-13", "level": "Level 1"}, {"sku": "111-57", "level": "Level 1"}, {"sku": "111-58", "level": "Level 1"}, {"sku": "111-15", "level": "Level 1"}], "111-10": [{"sku": "111-59", "level": "Level 3"}, {"sku": "111-36", "level": "Level 2"}, {"sku": "111-23", "level": "Level 2"}, {"sku": "111-13", "level": "Level 3"}, {"sku": "111-25", "level": "Level 3"}, {"sku": "111-57", "level": "Level 3"}, {"sku": "111-58", "level": "Level 3"}]};

async function fetchAllRows(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

async function readPackageContents(defaults) {
  const rows = await fetchAllRows(SETTINGS_LIST);
  const row = rows.find(it => it.fields && it.fields.Key === PACKAGE_CONTENTS_KEY);
  if (row && row.fields.Value) {
    try { const v = JSON.parse(row.fields.Value); if (v && typeof v === 'object') return { map: v, row }; } catch (e) { /* default */ }
  }
  return { map: JSON.parse(JSON.stringify(defaults || DEFAULT_PACKAGE_CONTENTS)), row: row || null };
}

/* services: [{ SubOption (SKU), ... }]. skipSkus: paquetes que la orden
   ya tiene congelados (no se vuelven a fotografiar). Nunca truena la
   creacion de la orden: si algo falla, se registra y se sigue. */
async function recordPackageSnapshots(orderId, services, actor, defaults, skipSkus) {
  try {
    const skus = [...new Set((services || []).map(s => String((s && (s.SubOption || s.sku)) || '').trim()).filter(Boolean))];
    if (!skus.length) return null;
    const { map } = await readPackageContents(defaults);
    const skip = new Set((skipSkus || []).map(String));
    const pkgs = skus.filter(k => Array.isArray(map[k]) && map[k].length && !skip.has(k));
    if (!pkgs.length) return null;
    const catalog = await fetchAllRows(SERVICES_CATALOG_LIST);
    const nameOf = {};
    catalog.forEach(it => { if (it.fields && it.fields.SKU) nameOf[String(it.fields.SKU).trim()] = it.fields.ServiceName || ''; });
    const snap = {};
    pkgs.forEach(k => { snap[k] = map[k].map(x => ({ sku: String(x.sku), serviceName: nameOf[String(x.sku)] || String(x.sku), level: x.level || '' })); });
    await createListItem(ORDER_HISTORY_LIST, {
      Title: orderId,
      OrderID: orderId,
      ChangeType: 'Package Snapshot',
      FieldChanged: 'Office Change (Internal)',
      ChangedBy: actor || 'System',
      ChangeDate: new Date().toISOString(),
      Notes: 'What each package included on this date.',
      OldValue: '',
      NewValue: JSON.stringify(snap)
    });
    return snap;
  } catch (e) {
    console.error('Package snapshot for ' + orderId + ':', e.message);
    return null;
  }
}

module.exports = { PACKAGE_CONTENTS_KEY, DEFAULT_PACKAGE_CONTENTS, readPackageContents, recordPackageSnapshots };
