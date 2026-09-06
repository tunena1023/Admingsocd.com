/* ============================================================
   get-order-photos.js — fotos de UNA orden en particular, leidas
   directo de la carpeta (mismo criterio ya usado en
   tech.gsocd.com/get-my-gallery.js, sin lista de SharePoint aparte
   registrando fotos):
     TechPhotos/<ClientID> - <BusinessName>/<OrderID>/Photos/*.jpg

   Pensado para verse inline en la tarjeta de Review de una sugerencia
   de supervisor -- todavia no hay un tab de Gallery completo en
   admin.html, esto cubre esa necesidad puntual mientras tanto.
============================================================ */

const { ORDERS_LIST, listChildren, graphFetch, siteListPath, jsonResponse } = require('./lib/graph');

const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';

async function fetchByField(listName, fieldName, value) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
  const data = await graphFetch(siteListPath(listName) + `?$expand=fields&$top=50&$filter=${filter}`);
  return data.value || [];
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    const orderId = String(b.orderId || '').trim();
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });

    const rows = await fetchByField(ORDERS_LIST, 'OrderID', orderId);
    const item = rows.find(it => it.fields);
    if (!item) return jsonResponse(404, { error: 'Order not found.' });
    const f = item.fields;

    const clientLabel = (String(f.ClientID || '').trim() + ' - ' + String(f.BusinessName || '').trim())
      .replace(/[\\/:*?"<>|]/g, '').trim() || orderId;
    const folderPath = PHOTOS_FOLDER + '/' + clientLabel + '/' + orderId + '/Photos';

    const kids = await listChildren(folderPath);
    const photos = kids.filter(k => k.isFile).sort((a, b) => a.name.localeCompare(b.name))
      .map(p => ({ name: p.name, downloadUrl: p.downloadUrl }));

    return jsonResponse(200, { photos });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
