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
const lq = require('./lib/list-query');
const galleryScan = require('./lib/gallery-scan');
const graph = require('./lib/graph');
const orderDocs = require('./lib/order-docs');

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
/* BUG REAL encontrado y arreglado (18/09/2026): el nombre del
   archivo guarda la hora del SERVIDOR (Vercel corre en UTC por
   default), no la hora de Iowa -- se mostraba tal cual, sin
   convertir, y una foto tomada a las 9:57 PM se veia como "2:57 AM"
   en Gallery (5-6 horas adelantada, segun horario de verano/
   invierno). Ahora se convierte a America/Chicago antes de mostrarla
   -- Intl.DateTimeFormat ya calcula solo el ajuste correcto de CDT/
   CST segun la fecha, sin tener que llevar la cuenta a mano. */
function formatSvcPhotoDate(y, mo, d, h, mi) {
  const utcDate = new Date(Date.UTC(parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(mi, 10)));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(utcDate);
  const get = type => (parts.find(p => p.type === type) || {}).value || '';
  return get('month') + ' ' + get('day') + ', ' + get('year') + ' · ' + get('hour') + ':' + get('minute') + ' ' + get('dayPeriod');
}

/* BUG REAL encontrado y arreglado (18/09/2026, reportado por el
   dueño): fotos normales (sin pasar por la camarita de servicio)
   nunca tenian caption -- se veian sin fecha/hora en Gallery. Mismo
   criterio que tech.gsocd.com/get-my-gallery.js: usar
   createdDateTime (Graph lo da gratis en cada archivo) como
   respaldo. */
function formatIsoDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(d);
  const get = type => (parts.find(p => p.type === type) || {}).value || '';
  return get('month') + ' ' + get('day') + ', ' + get('year') + ' · ' + get('hour') + ':' + get('minute') + ' ' + get('dayPeriod');
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
   reales de esa orden -- Y AHORA TAMBIEN la lista completa de
   servicios programados (columna "Scheduled Services" de Gallery,
   rediseño 19/09/2026: cada foto trae su servicio pegado abajo de
   ELLA, y aparte, independiente, la lista de TODOS los servicios de
   la orden tengan foto o no). Antes esto se saltaba por completo si
   ninguna foto traia el prefijo svc- (evitaba pedir OrderServices de
   mas) -- ya no se puede saltar, la lista de servicios se necesita
   aunque la orden no tenga ninguna foto svc-. */
async function buildServiceCaptionsAndList(orderId, photoNames, svcRowsByOrder) {
  const svcNamesInPhotos = photoNames
    .map(n => (n.match(SVC_PHOTO_PREFIX) || [])[1])
    .filter(Boolean);

  /* Servicios ya traidos de una vez para todas las ordenes (velocidad, 25/09/2026). */
  const rows = (svcRowsByOrder && svcRowsByOrder[orderId]) || [];
  const bySafeName = {};
  const services = [];
  rows.forEach(it => {
    const f = it.fields || {};
    const name = f.ServiceName || '';
    if (!name) return;
    const level = f.Level || '';
    bySafeName[safeName(name)] = { name, level, reason: f.NotCompletedReason || '' };
    services.push({ name, level });
  });

  const captions = {};
  if (svcNamesInPhotos.length) {
    photoNames.forEach(fileName => {
      const m = fileName.match(SVC_PHOTO_PREFIX);
      if (!m) return;
      const svc = bySafeName[m[1]];
      if (!svc) return;
      const dateStr = formatSvcPhotoDate(m[2], m[3], m[4], m[5], m[6]);
      /* sortKey: ISO real (no el caption formateado) para que Gallery
         pueda ordenar de verdad por fecha el orden inicial. Mismos
         componentes del nombre de archivo que ya usa
         formatSvcPhotoDate, reconstruidos aqui como Date.UTC (m[7]
         son los segundos, antes no se usaban para nada). */
      const sortKey = new Date(Date.UTC(
        parseInt(m[2], 10), parseInt(m[3], 10) - 1, parseInt(m[4], 10),
        parseInt(m[5], 10), parseInt(m[6], 10), parseInt(m[7] || '0', 10)
      )).toISOString();
      captions[fileName] = {
        serviceName: svc.name,
        level: svc.level || '',
        reason: svc.reason || '',
        caption: dateStr,
        sortKey
      };
    });
  }
  return { captions, services };
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
    /* Documentos de todas las ordenes (Gallery > Docs, 25/09/2026):
       "ClientID - Negocio · Unit X", sin importar el filtro de estatus. */
    const allById = {};
    orderRows.forEach(it => { if (it.fields) allById[it.fields.OrderID || it.fields.Title || ''] = it.fields; });
    const docsPromise = orderDocs.listDocs(graph, {});
    let orders = orderRows.filter(it => it.fields);

    if (statusFilter === 'active') {
      orders = orders.filter(it => ACTIVE_STATUSES.includes(it.fields.Status));
    } else if (statusFilter === 'completed') {
      orders = orders.filter(it => it.fields.Status === 'Completed');
    }
    /* 'all' (o cualquier otro valor): sin filtro, se quedan todas. */

    /* Velocidad (25/09/2026): solo se abren las ordenes que SI tienen
       carpeta (una consulta por cliente, lib/gallery-scan.js), y los
       servicios de todas se piden juntos en vez de uno por orden. */
    const withFolders = await galleryScan.ordersWithFolders(orders, clientFolderName, PHOTOS_FOLDER);
    const listed = await Promise.all(withFolders.map(async (it) => {
      const f = it.fields;
      const orderId = f.OrderID || f.Title || '';
      const folderPath = PHOTOS_FOLDER + '/' + clientFolderName(f) + '/' + orderId + '/Photos';
      const kids = await listChildren(folderPath);
      const photos = kids.filter(k => k.isFile).sort((a, b) => a.name.localeCompare(b.name));
      return photos.length ? { it, photos } : null;
    }));
    const found = listed.filter(Boolean);
    const svcRowsByOrder = {};
    (await lq.fetchByValues(ORDER_SERVICES_LIST, 'OrderID', found.map(x => x.it.fields.OrderID || x.it.fields.Title))).forEach(r => {
      if (r.fields && r.fields.OrderID) (svcRowsByOrder[r.fields.OrderID] = svcRowsByOrder[r.fields.OrderID] || []).push(r);
    });
    const groups = await Promise.all(found.map(async ({ it, photos }) => {
      const f = it.fields;
      const orderId = f.OrderID || f.Title || '';
      const { captions, services } = await buildServiceCaptionsAndList(orderId, photos.map(p => p.name), svcRowsByOrder);
      return {
        orderId,
        clientLabel: f.BusinessName || f.ClientID || '',
        division: f.Division || '',
        status: f.Status || '',
        date: f.EntryDate || f.DispatchDate || f.createdDateTime || '',
        bedrooms: f.Bedrooms || '',
        bathrooms: f.Bathrooms || '',
        supervisor: f.Supervisor || '',
        unitNumber: f.UnitNumber || '',
        completedDate: f.CompletedDate || '',
        services,
        photos: photos.map(p => {
          const info = captions[p.name];
          return {
            name: p.name,
            downloadUrl: p.downloadUrl,
            serviceName: info ? info.serviceName : null,
            level: (info && info.level) || '',
            reason: (info && info.reason) || '',
            caption: (info && info.caption) || formatIsoDate(p.createdDateTime) || undefined,
            sortKey: (info && info.sortKey) || p.createdDateTime || '',
            /* Foto de inspeccion (antes) vs de trabajo (despues), 25/09/2026:
               upload-photo (Tech) le pone insp- mientras la orden esta en
               'Inspection'. gallery-groups v1.69.0 las separa en 2 pestañas. */
            stage: /^insp-/i.test(p.name) ? 'inspection' : 'work'
          };
        })
      };
    }));

    const nonEmpty = groups.filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const docGroups = orderDocs.groupDocs(await docsPromise, id => {
      const f = allById[id] || {};
      return [[f.ClientID, f.BusinessName].filter(Boolean).join(' - '), f.UnitNumber ? 'Unit ' + f.UnitNumber : ''].filter(Boolean).join(' · ') || id;
    });

    return jsonResponse(200, { groups: nonEmpty, docGroups });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
