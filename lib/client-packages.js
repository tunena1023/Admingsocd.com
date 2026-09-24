/* ============================================================
   lib/client-packages.js -- version de un paquete POR CLIENTE
   (24/09/2026, aprobado con mini). Lista ClientPackages (la creo el
   dueño): ClientID, PackageSKU, Items (JSON [{sku, level}], mismo
   formato que ServicesCatalog.PackageItems).

   - Admin > Clients > Create Order > Edit guarda aqui (developer-admin:
     save-client-package / reset-client-package).
   - El catalogo que ve ese cliente (Admin y su portal) trae sus
     packageItems en vez de los generales (applyClientPackages).
   - recordPackageSnapshots congela la version del cliente en cada
     orden nueva (Orders.PackageContents).
   Si despues cambia el paquete general en Developer, el cliente con
   version propia se queda con la suya. Mismo archivo en Admin y Orders.
============================================================ */
const { CLIENT_PACKAGES_LIST, graphFetch, siteListPath } = require('./graph');
const { parseJson } = require('./catalog-fields');

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function itemsOf(f) {
  const a = parseJson(f && f.Items, []);
  return Array.isArray(a) ? a.filter(x => x && x.sku).map(x => ({ sku: String(x.sku), level: x.level || '' })) : [];
}

/* La lista es chica (un renglon por cliente+paquete editado): se trae
   completa y se filtra aqui, sin depender de que ClientID este indexada. */
async function allRows() {
  let url = siteListPath(CLIENT_PACKAGES_LIST) + '?$expand=fields&$top=500';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.filter(it => it.fields);
}

async function clientPackageRows(clientId) {
  const c = norm(clientId);
  if (!c) return [];
  return (await allRows()).filter(it => norm(it.fields.ClientID) === c);
}

/* { skuPaquete: [{sku, level}] } de ese cliente. */
async function clientPackagesFor(clientId) {
  const out = {};
  (await clientPackageRows(clientId)).forEach(it => {
    const sku = String(it.fields.PackageSKU || '').trim();
    if (sku) out[sku] = itemsOf(it.fields);
  });
  return out;
}

/* Catalogo con los packageItems del cliente encima de los generales. */
function applyClientPackages(catalog, byPkg) {
  if (!byPkg || !Object.keys(byPkg).length) return catalog;
  return (catalog || []).map(s => byPkg[String(s.sku)] ? Object.assign({}, s, { packageItems: byPkg[String(s.sku)] }) : s);
}

module.exports = { clientPackageRows, clientPackagesFor, applyClientPackages, itemsOf };
