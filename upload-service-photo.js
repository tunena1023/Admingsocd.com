/* ============================================================
   upload-service-photo.js — el admin sube una foto ligada a UN
   servicio especifico de una orden (boton de camara en Edit Order,
   dentro de Active). Mismo mecanismo exacto que
   ordersgsocd.com/upload-client-photo.js -- no hay ninguna columna
   nueva en SharePoint: el nombre del archivo mismo dice a que
   servicio pertenece.

   Formato del archivo: "svc-<ServiceNameSafe>-<timestamp>.jpg".
   get-admin-gallery.js lee este prefijo para armar la descripcion en
   Gallery, cruzando <ServiceNameSafe> contra el ServiceName real de
   esa orden -- la nota que se le pega (NotCompletedReason) siempre
   se lee de OrderServices en ese momento, nunca se duplica aqui.

   Misma carpeta que ya usa Tech (TechPhotos/.../Photos/), para que
   aparezca en la MISMA galeria de siempre sin tocar nada mas.
============================================================ */

const {
  ORDERS_LIST, ensureFolder, uploadFile, graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');

const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';

async function fetchByField(listName, fieldName, value) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
  const url = siteListPath(listName) + `?$expand=fields&$top=50&$filter=${filter}`;
  const data = await graphFetch(url);
  return data.value || [];
}

function fileTimestamp(d) {
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function safeName(s) { return String(s || '').trim().replace(/[^a-z0-9]/gi, '_'); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    const orderId = String(b.orderId || '').trim();
    const serviceName = String(b.serviceName || '').trim();
    const imageBase64 = b.imageBase64;
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
    if (!serviceName) return jsonResponse(400, { error: 'serviceName is required' });
    if (!imageBase64) return jsonResponse(400, { error: 'No image data received' });

    const rows = await fetchByField(ORDERS_LIST, 'OrderID', orderId);
    const orderItem = rows.find(it => it.fields);
    if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });
    const f = orderItem.fields;

    const clientLabel = (String(f.ClientID || '').trim() + ' - ' + String(f.BusinessName || '').trim())
      .replace(/[\\/:*?"<>|]/g, '').trim() || orderId;
    const folderPath = PHOTOS_FOLDER + '/' + clientLabel + '/' + orderId + '/Photos';

    const fileName = 'svc-' + safeName(serviceName) + '-' + fileTimestamp(new Date()) + '.jpg';
    const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');

    await ensureFolder(folderPath);
    const result = await uploadFile(folderPath, fileName, buffer, 'image/jpeg');

    return jsonResponse(200, { success: true, fileName, webUrl: result.webUrl });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
