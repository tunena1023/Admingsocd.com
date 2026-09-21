/* ============================================================
   lib/orderpdf.js — arma y guarda el PDF oficial de una orden.

   REGLAS (decididas con el cliente):
   - Ruta:      Orders / <ClientID> - <Business Name> / <OrderID>-rN.pdf
   - La carpeta se busca por PREFIJO "<ClientID> - " para que un cambio
     de nombre del negocio no genere una carpeta duplicada.
   - La revision N se deduce de los PDF que ya existen en la carpeta:
     el primero es r1, el siguiente r2, y asi. Nunca se sobreescribe.
   - Se genera al APROBAR y cuando el admin cambia datos de control
     (fechas, ventana de servicio, servicios, direccion...).
   - Un cambio de SOLO estatus NO genera PDF.
   - Imprimir sirve el PDF guardado -- PERO si la orden se modifico
     DESPUES de que ese archivo se creo, o si de plano no existe
     ninguno, get-order-document.js genera una revision nueva sobre
     la marcha antes de servirla (a peticion del dueño, 19/09/2026:
     "el boton de Print debe imprimir la version mas reciente de la
     orden"). Nunca genera de mas si el guardado ya esta al dia.

   "Assign by service" (21/09/2026): el CONTENIDO del PDF (que texto
   trae cada pagina -- buildOrderPdf/buildCompletionPdf/buildRequestPdf,
   historyDetailLine, renderServicesTable, etc.) se movio a
   gsocd-shared/lib/order-pdf.js -- este archivo tenia su propia copia
   COMPLETA, identica a la de ordersgsocd.com, mantenidas a mano en 2
   lados -- eso fue la causa de un bug real: un arreglo aplicado aqui
   nunca llegaba a Orders. Aqui SOLO se queda lo que de verdad hace
   consultas a SharePoint/Graph (traer datos, guardar el archivo) --
   el patron real ya establecido para esto (ver lib/division-rules.js):
   piezas de backend compartidas son funciones PURAS, cada portal
   sigue siendo el que trae sus propios datos.
============================================================ */

const {
  ORDERS_FOLDER, ensureFolder, uploadFile, listChildren,
  findFolderByPrefix, driveItemByPath, downloadById,
  CLIENTS_LIST, FIELD_EMPLOYEES_LIST, SERVICE_ASSIGNMENTS_LIST, graphFetch, siteListPath
} = require('./graph');
const { buildOrderPdf, buildCompletionPdf, buildRequestPdf, historyDetailLine, serviceDiffText, fmtDate, fmtDateTime } =
  require('gsocd-shared/lib/order-pdf');
const heicConvert = require('heic-convert');

function clean(v) { return v == null ? '' : String(v).trim(); }

/* Misma carpeta que get-order-photos.js / get-my-gallery.js --
   TechPhotos/<ClientID> - <BusinessName>/<OrderID>/Photos/*.jpg */
const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';
const MAX_COMPLETION_PHOTOS = 60;
const LOGO_CACHE_MS = 30 * 60 * 1000;
let _logoCache = null;
let _logoCacheAt = 0;

async function fetchServiceAssignments(orderId) {
  try {
    const filter = encodeURIComponent(`fields/OrderID eq '${orderId}'`);
    const url = siteListPath(SERVICE_ASSIGNMENTS_LIST) + `?$expand=fields&$top=200&$filter=${filter}`;
    const data = await graphFetch(url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
    return (data.value || []).filter(it => it.fields).map(it => ({
      Category: it.fields.Category || '', ServiceName: it.fields.ServiceName || '',
      WorkStatus: it.fields.WorkStatus || 'Not Started'
    }));
  } catch (e) { return []; }
}

function looksLikeHeic(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buffer.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
}

async function fetchLogoBuffer() {
  if (_logoCache && (Date.now() - _logoCacheAt) < LOGO_CACHE_MS) return _logoCache;
  try {
    const item = await driveItemByPath('Logo.jpg');
    if (!item) return null;
    _logoCache = await downloadById(item.id);
    _logoCacheAt = Date.now();
    return _logoCache;
  } catch (e) {
    return null;
  }
}

function folderName(clientId, businessName) {
  const base = clean(clientId) || 'UNKNOWN';
  const name = clean(businessName);
  /* SharePoint prohibe estos caracteres en nombres de carpeta */
  const safe = name.replace(/[\\/:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim();
  return safe ? base + ' - ' + safe : base;
}

async function ensureOrderFolder(clientId, businessName) {
  await ensureFolder(ORDERS_FOLDER);
  const prefix = clean(clientId) + ' - ';
  let existing = null;
  try {
    existing = await findFolderByPrefix(ORDERS_FOLDER, prefix);
  } catch (e) { existing = null; }
  if (!existing) {
    /* Puede que la carpeta se llame solo "<ClientID>" (sin nombre) */
    try {
      const bare = await driveItemByPath(ORDERS_FOLDER + '/' + clean(clientId));
      if (bare && bare.folder) return ORDERS_FOLDER + '/' + clean(clientId);
    } catch (e) { /* sigue */ }
  }
  const target = existing
    ? ORDERS_FOLDER + '/' + existing.name
    : ORDERS_FOLDER + '/' + folderName(clientId, businessName);
  await ensureFolder(target);
  return target;
}

async function existingRevisions(folderRelPath, orderId, kind) {
  let kids = [];
  try { kids = await listChildren(folderRelPath); } catch (e) { kids = []; }
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = kind ? '-' + esc(kind) : '';
  const re = new RegExp('^' + esc(orderId) + suffix + '-r(\\d+)\\.pdf$', 'i');
  return kids
    .filter(k => !k.isFolder && re.test(k.name))
    .map(k => ({ name: k.name, revision: parseInt(k.name.match(re)[1], 10), item: k }))
    .sort((a, b) => a.revision - b.revision);
}

async function latestOrderPdf(order, kind) {
  const clientId = clean(order.ClientID);
  const orderId = clean(order.OrderID);
  if (!clientId || !orderId) return null;
  const prefix = clientId + ' - ';
  let folder = null;
  try { folder = await findFolderByPrefix(ORDERS_FOLDER, prefix); } catch (e) { folder = null; }
  const folderPath = folder
    ? ORDERS_FOLDER + '/' + folder.name
    : ORDERS_FOLDER + '/' + clientId;
  const revs = await existingRevisions(folderPath, orderId, kind);
  if (!revs.length) return null;
  const last = revs[revs.length - 1];
  return {
    name: last.name,
    revision: last.revision,
    folderPath: folderPath,
    id: last.item.id,
    webUrl: last.item.webUrl || '',
    createdDateTime: last.item.createdDateTime || ''
  };
}

async function findClientInfo(clientId) {
  /* 'email' se lee del campo 'Contact' en Clients -- ahi es donde
     vive el correo de verdad (register-client.js: el parametro que
     llega como "contact" desde el formulario es el email, guardado
     tal cual en el campo Contact de SharePoint -- mismo nombre
     confuso que ya causo el bug del nombre de la persona, que ese
     SI vive en ClientName). */
  const empty = { name: '', phone: '', email: '', address: '', suite: '', city: '', zip: '' };
  if (!clientId) return empty;
  try {
    const filter = encodeURIComponent(`fields/ClientID eq '${clientId}'`);
    const data = await graphFetch(siteListPath(CLIENTS_LIST) + `?$expand=fields&$top=5&$filter=${filter}`);
    const item = (data.value || []).find(it => it.fields);
    if (!item) return empty;
    const f = item.fields;
    return {
      name: clean(f.ClientName),
      phone: clean(f.Phone),
      email: clean(f.Contact),
      address: clean(f.Address),
      suite: clean(f.Suite),
      city: clean(f.City),
      zip: clean(f.Zip)
    };
  } catch (e) {
    return empty;
  }
}

async function findTechPhoneByName(fullName) {
  const name = clean(fullName).toLowerCase();
  if (!name) return '';
  try {
    const data = await graphFetch(siteListPath(FIELD_EMPLOYEES_LIST) + '?$expand=fields&$top=999');
    const item = (data.value || []).find(it => {
      const f = it.fields || {};
      return (clean(f.FirstName) + ' ' + clean(f.LastName)).trim().toLowerCase() === name;
    });
    return item ? clean(item.fields.Phone) : '';
  } catch (e) {
    return '';
  }
}

async function fetchOrderPhotoBuffers(order) {
  const clientId = clean(order.ClientID);
  const orderId = clean(order.OrderID);
  if (!clientId || !orderId) return [];
  const clientLabel = (clientId + ' - ' + clean(order.BusinessName || order.Title))
    .replace(/[\\/:*?"<>|]/g, '').trim() || orderId;
  const folderPath = PHOTOS_FOLDER + '/' + clientLabel + '/' + orderId + '/Photos';
  let kids = [];
  try { kids = await listChildren(folderPath); } catch (e) { kids = []; }
  const files = kids.filter(k => k.isFile)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_COMPLETION_PHOTOS);
  const out = [];
  for (const f of files) {
    try {
      let buffer = await downloadById(f.id);
      if (looksLikeHeic(buffer)) {
        try {
          buffer = await heicConvert({ buffer, format: 'JPEG', quality: 0.85 });
        } catch (convErr) { continue; /* no se pudo convertir: se omite esta foto */ }
      }
      out.push({ buffer, caption: f.name });
    } catch (e) { /* una foto que no baja se omite */ }
  }
  return out;
}

async function generateAndSaveCompletionPdf(data) {
  const order = (data && data.order) || {};
  const orderId = clean(order.OrderID);
  const clientId = clean(order.ClientID);
  if (!orderId || !clientId) {
    return { ok: false, error: 'Missing OrderID or ClientID' };
  }
  try {
    const folderPath = await ensureOrderFolder(clientId, order.BusinessName || order.Title);
    const revs = await existingRevisions(folderPath, orderId, 'completion');
    const revision = (revs.length ? revs[revs.length - 1].revision : 0) + 1;
    const fileName = orderId + '-completion-r' + revision + '.pdf';
    const isAssignByService = order.AssignByService === true || order.AssignByService === 'true';
    const [logoBuffer, photos, clientInfo, techPhone, serviceAssignments] = await Promise.all([
      fetchLogoBuffer(),
      fetchOrderPhotoBuffers(order),
      findClientInfo(clientId),
      findTechPhoneByName(order.Supervisor),
      isAssignByService ? fetchServiceAssignments(orderId) : Promise.resolve([])
    ]);
    const buffer = buildCompletionPdf(Object.assign({}, data, {
      order: Object.assign({}, order, {
        ClientPhone: clientInfo.phone, ClientContactName: clientInfo.name, ClientEmail: clientInfo.email,
        ClientAddress: clientInfo.address, ClientSuite: clientInfo.suite,
        ClientCity: clientInfo.city, ClientZip: clientInfo.zip,
        TechnicianPhone: techPhone
      }),
      revision: revision, logoBuffer: logoBuffer, photos: photos, serviceAssignments: serviceAssignments
    }));
    const uploaded = await uploadFile(folderPath, fileName, buffer, 'application/pdf');
    return {
      ok: true, fileName, revision, folderPath, buffer,
      webUrl: uploaded.webUrl || '', id: uploaded.id, photoCount: photos.length
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function generateAndSaveRequestPdf(data) {
  const order = (data && data.order) || {};
  const orderId = clean(order.OrderID);
  const clientId = clean(order.ClientID);
  if (!orderId || !clientId) {
    return { ok: false, error: 'Missing OrderID or ClientID' };
  }
  try {
    const folderPath = await ensureOrderFolder(clientId, order.BusinessName || order.Title);
    const revs = await existingRevisions(folderPath, orderId, 'request');
    const revision = (revs.length ? revs[revs.length - 1].revision : 0) + 1;
    const fileName = orderId + '-request-r' + revision + '.pdf';
    const isAssignByService = order.AssignByService === true || order.AssignByService === 'true';
    const [logoBuffer, clientInfo, techPhone, photos, serviceAssignments] = await Promise.all([
      fetchLogoBuffer(), findClientInfo(clientId), findTechPhoneByName(order.Supervisor),
      fetchOrderPhotoBuffers(order),
      isAssignByService ? fetchServiceAssignments(orderId) : Promise.resolve([])
    ]);
    const buffer = buildRequestPdf(Object.assign({}, data, {
      order: Object.assign({}, order, {
        ClientPhone: clientInfo.phone, ClientContactName: clientInfo.name, ClientEmail: clientInfo.email,
        ClientAddress: clientInfo.address, ClientSuite: clientInfo.suite,
        ClientCity: clientInfo.city, ClientZip: clientInfo.zip,
        TechnicianPhone: techPhone
      }),
      revision: revision, logoBuffer: logoBuffer, photos: photos, serviceAssignments: serviceAssignments
    }));
    const uploaded = await uploadFile(folderPath, fileName, buffer, 'application/pdf');
    return {
      ok: true, fileName, revision, folderPath, buffer,
      webUrl: uploaded.webUrl || '', id: uploaded.id
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function generateAndSaveOrderPdf(data) {
  const order = (data && data.order) || {};
  const orderId = clean(order.OrderID);
  const clientId = clean(order.ClientID);
  if (!orderId || !clientId) {
    return { ok: false, error: 'Missing OrderID or ClientID' };
  }
  try {
    const folderPath = await ensureOrderFolder(clientId, order.BusinessName || order.Title);
    const revs = await existingRevisions(folderPath, orderId);
    const revision = (revs.length ? revs[revs.length - 1].revision : 0) + 1;
    const fileName = orderId + '-r' + revision + '.pdf';
    const isAssignByService = order.AssignByService === true || order.AssignByService === 'true';
    const [logoBuffer, clientInfo, techPhone, photos, serviceAssignments] = await Promise.all([
      fetchLogoBuffer(), findClientInfo(clientId), findTechPhoneByName(order.Supervisor),
      fetchOrderPhotoBuffers(order),
      isAssignByService ? fetchServiceAssignments(orderId) : Promise.resolve([])
    ]);
    const buffer = buildOrderPdf(Object.assign({}, data, {
      order: Object.assign({}, order, {
        ClientPhone: clientInfo.phone, ClientContactName: clientInfo.name, ClientEmail: clientInfo.email,
        ClientAddress: clientInfo.address, ClientSuite: clientInfo.suite,
        ClientCity: clientInfo.city, ClientZip: clientInfo.zip,
        TechnicianPhone: techPhone
      }),
      revision: revision, logoBuffer: logoBuffer, photos: photos, serviceAssignments: serviceAssignments
    }));
    const uploaded = await uploadFile(folderPath, fileName, buffer, 'application/pdf');
    return {
      ok: true,
      fileName: fileName,
      revision: revision,
      folderPath: folderPath,
      buffer: buffer,
      webUrl: uploaded.webUrl || '',
      id: uploaded.id
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
module.exports = {
  generateAndSaveOrderPdf,
  generateAndSaveCompletionPdf,
  generateAndSaveRequestPdf,
  buildOrderPdf,
  buildCompletionPdf,
  buildRequestPdf,
  fetchOrderPhotoBuffers,
  latestOrderPdf,
  fmtDateTime,
  ensureOrderFolder,
  existingRevisions,
  historyDetailLine,
  serviceDiffText,
  fmtDate,
  fmtDateTime
};
