/* ============================================================
   lib/catalog-fields.js -- columnas reales (23/09/2026, el dueño las
   creo en SharePoint; "si se ocupan nuevas columnas, las hacemos").

   ServicesCatalog: Areas (JSON, lista de areas comunes), PackageItems
   (JSON, [{sku, level}]), Level2Price/Level2Mode, Level3Price/Level3Mode
   (Mode: Percent | Dollar; Level 1 = precio de QuickBooks).
   Clients: ShowRecurring, ShowPrices (Si/No).
   Orders: PackageContents (JSON {skuPaquete: [{sku, serviceName,
   level}]}, la copia congelada de lo que incluyo cada paquete).
   ClientPackages: ClientID, PackageSKU, Items (version del paquete por
   cliente, para lo que sigue).

   Estas funciones son las mismas en Admin, Orders y Tech.
============================================================ */
function parseJson(v, fallback) {
  if (v == null || v === '') return fallback;
  try { const x = JSON.parse(v); return x == null ? fallback : x; } catch (e) { return fallback; }
}
function areasOf(f) { const a = parseJson(f.Areas, []); return Array.isArray(a) ? a : []; }
function packageItemsOf(f) {
  const a = parseJson(f.PackageItems, []);
  return Array.isArray(a) ? a.filter(x => x && x.sku).map(x => ({ sku: String(x.sku), level: x.level || '' })) : [];
}
/* {l2: {t:'%'|'$', v}, l3: {...}} o null -- el mismo formato que usa admin.html */
function levelAdjustOf(f) {
  const one = (p, m) => (p == null || p === '' || isNaN(Number(p))) ? null : { t: m === 'Dollar' ? '$' : '%', v: Number(p) };
  const l2 = one(f.Level2Price, f.Level2Mode), l3 = one(f.Level3Price, f.Level3Mode);
  return (l2 || l3) ? { l2, l3 } : null;
}
function levelPricesFor(price, adj) {
  if (price == null || price === '' || isNaN(Number(price))) return null;
  const b = Number(price); const out = { 'Level 1': b };
  [['l2', 'Level 2'], ['l3', 'Level 3']].forEach(([k, L]) => {
    const a = adj && adj[k]; const v = a ? (Number(a.v) || 0) : 0;
    out[L] = Math.round((a && a.t === '$' ? b + v : b * (1 + v / 100)) * 100) / 100;
  });
  return out;
}
function truthy(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes'; }
module.exports = { parseJson, areasOf, packageItemsOf, levelAdjustOf, levelPricesFor, truthy };
