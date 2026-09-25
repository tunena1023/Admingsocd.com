/* ============================================================
   lib/order-docs.js -- documentos por orden (PDF, Word, TXT).
   25/09/2026, pedido del dueño: cada orden puede tener documentos que
   suben el cliente o la oficina; se ven en Gallery > Docs de los 3
   portales (tecnicos solo ven). MISMO archivo en Admin, Orders y Tech.

   Donde viven:
     - El archivo: <PHOTOS_FOLDER>/<ClientID - BusinessName>/<OrderID>/Documents/
       (la misma carpeta de la orden donde ya estan sus fotos).
     - Un renglon en la lista OrderDocuments (la creo el dueño):
       Title (nombre que se ve), OrderID, ClientID, ItemId (id del
       archivo en SharePoint), UploadedBy ('Client' | 'Office'),
       UploaderName, SizeBytes. Asi Docs carga con UNA consulta y se sabe
       quien subio que (el cliente solo borra lo suyo).

   Subida: startUpload() abre una "upload session" de Graph y regresa su
   uploadUrl; el navegador sube el archivo en pedazos DIRECTO a
   SharePoint (gsocd-shared/doc-viewer). Vercel no acepta cuerpos de mas
   de ~4.5 MB, por eso el archivo nunca pasa por aqui. finishUpload()
   revisa que el archivo quedo en la carpeta de ESA orden y escribe el
   renglon.

   Ver: viewUrls() pide a Graph el visor embebible (preview: PDF, Word y
   TXT) y el link de descarga (valido ~1 hora).
============================================================ */

const DOCS_LIST = 'OrderDocuments';
const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';
const MAX_BYTES = 25 * 1024 * 1024;
const EXTS = ['pdf', 'doc', 'docx', 'txt'];

const q = s => String(s == null ? '' : s).replace(/'/g, "''");
const encodePath = p => String(p).split('/').map(encodeURIComponent).join('/');
const extOf = n => { const m = String(n || '').toLowerCase().match(/\.([a-z0-9]+)$/); return m ? m[1] : ''; };

function clientFolderName(f) {
  return (String(f.ClientID || '').trim() + ' - ' + String(f.BusinessName || '').trim()).replace(/[\\/:*?"<>|]/g, '').trim();
}
function docsFolder(order) {
  return PHOTOS_FOLDER + '/' + clientFolderName(order) + '/' + String(order.OrderID || '').trim() + '/Documents';
}

/* Nombre seguro para SharePoint (sin caracteres prohibidos). */
function safeFileName(name) {
  let n = String(name || '').split(/[\\/]/).pop().replace(/[:*?"<>|#%~&{}]/g, '').replace(/\s+/g, ' ').trim();
  if (n.length > 120) { const e = extOf(n); n = n.slice(0, 110).trim() + (e ? '.' + e : ''); }
  return n || 'document';
}

function checkFile(fileName, size) {
  if (EXTS.indexOf(extOf(fileName)) === -1) return 'Only PDF, Word (.doc, .docx) or text (.txt) files.';
  const n = Number(size) || 0;
  if (n <= 0) return 'That file is empty.';
  if (n > MAX_BYTES) return 'The limit is 25 MB.';
  return '';
}

function stamp() {
  const d = new Date(), p = x => String(x).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + '_' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) +
    '-' + Math.random().toString(36).slice(2, 6);
}

function docOf(it) {
  const f = it.fields || {};
  return {
    id: String(it.id),
    orderId: f.OrderID || '',
    clientId: f.ClientID || '',
    name: f.Title || '',
    size: Number(f.SizeBytes) || 0,
    by: f.UploadedBy === 'Client' ? 'Client' : 'Office',
    uploaderName: f.UploaderName || '',
    uploadedAt: f.Created || it.createdDateTime || ''
  };
}

async function fetchRows(graph, filter) {
  let url = graph.siteListPath(DOCS_LIST) + '?$expand=fields&$top=500' + (filter ? '&$filter=' + encodeURIComponent(filter) : '');
  const out = [];
  while (url) {
    const data = await graph.graphFetch(url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.filter(it => it.fields);
}

/* Todos los documentos (Admin), los de un cliente (Orders) o los de
   unas ordenes (Tech). Si la lista todavia no existe, [] sin tronar. */
async function listDocs(graph, opts) {
  opts = opts || {};
  let rows;
  try {
    rows = await fetchRows(graph, opts.clientId ? `fields/ClientID eq '${q(opts.clientId)}'` : '');
  } catch (e) {
    console.error('order-docs: list failed', e.message);
    return [];
  }
  let docs = rows.map(docOf);
  if (opts.orderIds) { const set = new Set(opts.orderIds); docs = docs.filter(d => set.has(d.orderId)); }
  return docs.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
}

/* docs -> [{ orderId, clientLabel, date, docs }] (mas reciente primero). */
function groupDocs(docs, labelFor) {
  const by = new Map();
  docs.forEach(d => {
    if (!by.has(d.orderId)) by.set(d.orderId, { orderId: d.orderId, clientLabel: labelFor ? labelFor(d.orderId, d) : d.orderId, date: d.uploadedAt, docs: [] });
    by.get(d.orderId).docs.push(d);
  });
  return [...by.values()];
}

async function findOrder(graph, orderId) {
  const url = graph.siteListPath(graph.ORDERS_LIST) + '?$expand=fields&$top=5&$filter=' + encodeURIComponent(`fields/OrderID eq '${q(orderId)}'`);
  const data = await graph.graphFetch(url);
  const it = (data.value || []).find(x => x.fields);
  return it ? Object.assign({}, it.fields, { OrderID: orderId }) : null;
}

async function getRow(graph, docId) {
  try {
    return await graph.graphFetch(graph.siteListPath(DOCS_LIST) + '/' + encodeURIComponent(docId) + '?$expand=fields');
  } catch (e) { return null; }
}

/* -> { uploadUrl } */
async function startUpload(graph, order, fileName, size) {
  const bad = checkFile(fileName, size);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  const folder = docsFolder(order);
  await graph.ensureFolder(folder);
  const driveId = await graph.getDriveId();
  const target = stamp() + ' ' + safeFileName(fileName);
  const s = await graph.graphFetch('/drives/' + driveId + '/root:/' + encodePath(folder + '/' + target) + ':/createUploadSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } })
  });
  if (!s || !s.uploadUrl) throw new Error('Could not start the upload.');
  return { uploadUrl: s.uploadUrl };
}

/* Revisa que el archivo este en la carpeta de ESA orden y escribe el
   renglon. -> doc */
async function finishUpload(graph, order, itemId, fileName, by, uploaderName) {
  const driveId = await graph.getDriveId();
  const item = await graph.graphFetch('/drives/' + driveId + '/items/' + encodeURIComponent(itemId));
  const parentPath = decodeURIComponent(String((item.parentReference && item.parentReference.path) || ''));
  if (!item || !item.file || !parentPath.endsWith('/' + docsFolder(order))) {
    throw Object.assign(new Error('That file is not in this order\'s folder.'), { status: 400 });
  }
  const bad = checkFile(item.name, item.size);
  if (bad) {
    await graph.graphFetch('/drives/' + driveId + '/items/' + encodeURIComponent(itemId), { method: 'DELETE' }, true).catch(() => {});
    throw Object.assign(new Error(bad), { status: 400 });
  }
  const created = await graph.createListItem(DOCS_LIST, {
    Title: safeFileName(fileName || item.name),
    OrderID: order.OrderID,
    ClientID: order.ClientID || '',
    ItemId: item.id,
    UploadedBy: by === 'Client' ? 'Client' : 'Office',
    UploaderName: String(uploaderName || '').slice(0, 120),
    SizeBytes: item.size || 0
  });
  return docOf({ id: created.id, fields: Object.assign({ Created: new Date().toISOString() }, created.fields || {}, {
    Title: safeFileName(fileName || item.name), OrderID: order.OrderID, ClientID: order.ClientID || '',
    UploadedBy: by === 'Client' ? 'Client' : 'Office', UploaderName: uploaderName || '', SizeBytes: item.size || 0
  }) });
}

/* -> { viewUrl, downloadUrl } (null si no se pudo) */
async function viewUrls(graph, row) {
  const f = row.fields || {};
  const driveId = await graph.getDriveId();
  const base = '/drives/' + driveId + '/items/' + encodeURIComponent(f.ItemId);
  let viewUrl = null, downloadUrl = null;
  try {
    const p = await graph.graphFetch(base + '/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    viewUrl = p && (p.getUrl || null);
  } catch (e) { console.error('order-docs: preview failed', e.message); }
  try {
    const it = await graph.graphFetch(base);
    downloadUrl = it && it['@microsoft.graph.downloadUrl'] || null;
  } catch (e) { console.error('order-docs: download url failed', e.message); }
  return { viewUrl, downloadUrl };
}

async function deleteDoc(graph, row) {
  const f = row.fields || {};
  const driveId = await graph.getDriveId();
  if (f.ItemId) {
    await graph.graphFetch('/drives/' + driveId + '/items/' + encodeURIComponent(f.ItemId), { method: 'DELETE' }, true).catch(e => console.error('order-docs: file delete failed', e.message));
  }
  await graph.deleteListItem(DOCS_LIST, row.id);
}

module.exports = { DOCS_LIST, MAX_BYTES, docsFolder, listDocs, groupDocs, findOrder, getRow, startUpload, finishUpload, viewUrls, deleteDoc, docOf };
