/* ============================================================
   get-admin-gallery.js — fotos agrupadas por orden, para toda la
   compania (sin filtrar por tecnico/supervisor como en tech.gsocd.com).

   Mismo criterio ya usado en tech.gsocd.com/get-my-gallery.js y
   get-order-photos.js: no hay ninguna lista de SharePoint que
   registre las fotos por separado -- todo se deduce leyendo la
   carpeta directo:
     TechPhotos/<ClientID> - <BusinessName>/<OrderID>/Photos/*.jpg

   statusFilter:
   - 'active'    -> solo ordenes con status en ACTIVE_STATUSES
                    (Assigned/Updated). Usado en Active > By Employee.
   - 'completed' -> solo Status === 'Completed'. Default del tab
                    Gallery dentro de History.
   - 'all' (o cualquier otro valor) -> todas las ordenes, sin
                    importar status. Sub-tab "All" de Gallery.
============================================================ */

const {
  ORDERS_LIST, listChildren, graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');

const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';
const ACTIVE_STATUSES = ['Assigned', 'Updated'];

async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=500';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

function clientFolderName(f) {
  return (String(f.ClientID || '').trim() + ' - ' + String(f.BusinessName || '').trim())
    .replace(/[\\/:*?"<>|]/g, '').trim();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    const statusFilter = String(b.statusFilter || 'all').trim().toLowerCase();

    const orderRows = await fetchAll(ORDERS_LIST);
    let orders = orderRows.filter(it => it.fields);

    if (statusFilter === 'active') {
      orders = orders.filter(it => ACTIVE_STATUSES.includes(it.fields.Status));
    } else if (statusFilter === 'completed') {
      orders = orders.filter(it => it.fields.Status === 'Completed');
    }
    /* 'all' (o cualquier otro valor): sin filtro, se quedan todas. */

    const groups = await Promise.all(orders.map(async (it) => {
      const f = it.fields;
      const orderId = f.OrderID || f.Title || '';
      const folderPath = PHOTOS_FOLDER + '/' + clientFolderName(f) + '/' + orderId + '/Photos';
      const kids = await listChildren(folderPath);
      const photos = kids.filter(k => k.isFile).sort((a, b) => a.name.localeCompare(b.name));
      if (!photos.length) return null;
      return {
        orderId,
        clientLabel: f.BusinessName || f.ClientID || '',
        division: f.Division || '',
        status: f.Status || '',
        date: f.EntryDate || f.DispatchDate || f.createdDateTime || '',
        photos: photos.map(p => ({ name: p.name, downloadUrl: p.downloadUrl }))
      };
    }));

    const nonEmpty = groups.filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));

    return jsonResponse(200, { groups: nonEmpty });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
