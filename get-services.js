/* ============================================================
   get-services.js — catálogo de servicios desde la lista de
   SharePoint "Services" (Division/Category/ServiceName/SubOption/
   Description/Active/SortOrder). Mismo JSON de salida que la version
   vieja basada en Excel (migrada el 30/08/2026 via
   migrate-services-catalog.js) -- nada mas en el sistema tuvo que
   cambiar.

   Solo se leen los renglones con Active=true, ordenados por
   SortOrder, para que "apagar" un servicio (sin borrarlo) y
   reordenar categorias/servicios se refleje aqui sin tocar codigo.
============================================================ */

const { SERVICES_LIST, graphFetch, siteListPath, jsonResponse } = require('./lib/graph');

async function fetchAllServices() {
  let url = siteListPath(SERVICES_LIST) + '?$expand=fields&$top=200';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

/* Misma forma de salida que la version basada en Excel: un objeto por
   division, con categories agrupadas y una entrada { name, desc, subs }
   por servicio -- para que el frontend (Active/Approvals/Create Order/
   customer.html/services.html) no necesite ningun cambio. */
function buildCatalog(rows) {
  const out = {
    Janitorial:  { type: 'categorized_rooms',  dirtLevels: true,  categories: {} },
    renovations: { type: 'categorized_trades', dirtLevels: false, categories: {} },
    exteriors:   { type: 'categorized_trades', dirtLevels: false, categories: {} }
  };

  const items = rows
    .filter(it => it.fields)
    .map(it => it.fields)
    .filter(f => truthy(f.Active === undefined ? true : f.Active))
    .sort((a, b) => (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0));

  items.forEach(f => {
    const division = String(f.Division || '').trim();
    const category = String(f.Category || '').trim();
    const name     = String(f.ServiceName || '').trim();
    const sub      = String(f.SubOption || '').trim();
    const desc     = String(f.Description || '').trim();

    if (!out[division] || !category || !name || !sub) return;

    if (!out[division].categories[category]) out[division].categories[category] = [];

    let entry = out[division].categories[category].find(s => s.name === name);
    if (!entry) {
      entry = { name: name, desc: desc, subs: [] };
      out[division].categories[category].push(entry);
    }
    if (!entry.desc && desc) entry.desc = desc;
    if (!entry.subs.includes(sub)) entry.subs.push(sub);
  });

  return out;
}

exports.handler = async () => {
  /* La página lo pide con GET (GS.api('/get-services', { method: 'GET' })) */
  try {
    const rows = await fetchAllServices();
    return jsonResponse(200, buildCatalog(rows));
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
