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
  ORDERS_LIST, ORDER_SERVICES_LIST, listChildren, graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');

const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';
const ACTIVE_STATUSES = ['Assigned', 'Updated'];

/* Las fotos de un servicio especifico (ver admin.html, boton de
   camara en Edit Order) llevan el nombre del servicio codificado en
   el archivo mismo -- "svc-<ServiceNameSafe>-<timestamp>.jpg" -- sin
   ninguna columna nueva en SharePoint. La nota que va en la
   descripcion NUNCA se guarda aparte: siempre se lee de
   NotCompletedReason en OrderServices, el mismo campo que ya llena
   "Save Changes". Por eso esa nota "no cambia nunca" una vez tomada
   la foto -- es el registro de ESE momento, no algo editable despues. */
const SVC_PHOTO_PREFIX = /^svc-(.+?)-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:-[a-z0-9]+)?\.[a-z0-9]+$/i;
function safeName(s) { return String(s || '').replace(/[^a-z0-9]/gi, '_'); }

/* "Sep 17, 2026 · 2:30 PM" a partir de los grupos que ya captura
   SVC_PHOTO_PREFIX -- el timestamp ya viene en el nombre del archivo
   (fileTimestamp() en upload-service-photo.js), no hace falta pedirle
   nada extra a Graph. Mismo formato en Admin/Tech/Orders. */
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatSvcPhotoDate(y, mo, d, h, mi) {
  const hNum = parseInt(h, 10);
  const ampm = hNum >= 12 ? 'PM' : 'AM';
  const h12 = hNum % 12 === 0 ? 12 : hNum % 12;
  return MONTH_NAMES[parseInt(mo, 10) - 1] + ' ' + parseInt(d, 10) + ', ' + y + ' · ' + h12 + ':' + mi + ' ' + ampm;
}

async function fetchByOrderId(listName, orderId) {
  const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
  let url = siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/* Arma la descripcion de cada foto svc-* de una orden, cruzando el
   nombre de servicio codificado en el archivo contra los servicios
   reales de esa orden. Solo se llama si la orden de verdad tiene al
   menos una foto de este tipo -- evita pedir OrderServices de mas. */
async function buildServiceCaptions(orderId, photoNames) {
  const svcNamesInPhotos = photoNames
    .map(n => (n.match(SVC_PHOTO_PREFIX) || [])[1])
    .filter(Boolean);
  if (!svcNamesInPhotos.length) return {};

  const rows = await fetchByOrderId(ORDER_SERVICES_LIST, orderId);
  const bySafeName = {};
  rows.forEach(it => {
    const f = it.fields || {};
    const name = f.ServiceName || '';
    if (!name) return;
    bySafeName[safeName(name)] = { name, reason: f.NotCompletedReason || '' };
  });

  const captions = {};
  photoNames.forEach(fileName => {
    const m = fileName.match(SVC_PHOTO_PREFIX);
    if (!m) return;
    const svc = bySafeName[m[1]];
    if (!svc) return;
    const dateStr = formatSvcPhotoDate(m[2], m[3], m[4], m[5], m[6]);
    captions[fileName] = svc.name + (svc.reason ? ' — ' + svc.reason : '') + ' · ' + dateStr;
  });
  return captions;
}

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
      const captions = await buildServiceCaptions(orderId, photos.map(p => p.name));
      return {
        orderId,
        clientLabel: f.BusinessName || f.ClientID || '',
        division: f.Division || '',
        status: f.Status || '',
        date: f.EntryDate || f.DispatchDate || f.createdDateTime || '',
        photos: photos.map(p => ({ name: p.name, downloadUrl: p.downloadUrl, caption: captions[p.name] || undefined }))
      };
    }));

    const nonEmpty = groups.filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));

    return jsonResponse(200, { groups: nonEmpty });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
