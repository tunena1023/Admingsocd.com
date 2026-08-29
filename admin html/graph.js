/* ============================================================
   lib/graph.js — cliente de Microsoft Graph para todas las
   Netlify Functions del portal.

   Variables de entorno en Netlify (mismos nombres que la v1):
     GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET,
     GRAPH_HOSTNAME (netorgft10263312.sharepoint.com),
     GRAPH_SITE_PATH (/sites/Onlineorders)

   Permiso Azure: Microsoft Graph → Application → Sites.ReadWrite.All
============================================================ */

const GRAPH = 'https://graph.microsoft.com/v1.0';

const TENANT_ID = process.env.GRAPH_TENANT_ID || 'd18a66ea-5185-4a02-99cc-46b6578ff498';
const CLIENT_ID = process.env.GRAPH_CLIENT_ID || '18dfcf2e-0059-40f5-831c-69d13b9091fc';
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 'ee88Q~xsylb2A.2kFKI0eyLSFVzDAXj-dw8PccTB';
const HOSTNAME = process.env.GRAPH_HOSTNAME || 'netorgft10263312.sharepoint.com';
const SITE_PATH = process.env.GRAPH_SITE_PATH || '/sites/Onlineorders';

/* Listas del sitio */
const CLIENTS_LIST = 'Clients';
const ORDERS_LIST = 'Orders';
const ORDER_SERVICES_LIST = 'OrderServices';
const ORDER_HISTORY_LIST = 'OrderHistory';
const DRAFTS_LIST = 'Drafts';
const CLIENT_HISTORY_LIST = 'ClientHistory';

/* Carpeta raiz donde viven los PDF de las ordenes, relativa al root del drive.
   Estructura: Orders / <ClientID> - <Business Name> / <OrderID>-rN.pdf */
const ORDERS_FOLDER = process.env.GRAPH_ORDERS_FOLDER || 'Orders';

/* Rutas fijas dentro del drive (paridad con el modo demo local) */
const PATHS = {
  categoryImages: 'Assets/CategoryImages',
  servicesImages: 'Assets/Services'
};



/* ===== Token de aplicación (cacheado ~55 min por proceso) ===== */
let _tokenCache = null;

async function getGraphToken() {
  if (_tokenCache && _tokenCache.exp > Date.now()) return _tokenCache.token;


  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const res = await fetch('https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Token request failed: ' + res.status + ' ' + (await res.text()).slice(0, 200));

  const data = await res.json();
  _tokenCache = { token: data.access_token, exp: Date.now() + ((data.expires_in || 3600) - 60) * 1000 };
  return _tokenCache.token;
}

/* ===== Fetch autenticado por RUTA, con retry ante 429/503 =====
   raw=true devuelve la Response cruda (descargas binarias).
   Si no, devuelve JSON parseado y lanza error si !ok. */
async function graphFetch(path, options = {}, raw = false) {
  const token = await getGraphToken();
  const url = path.startsWith('http') ? path : GRAPH + path;

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, options.headers || {})
    }));
    if (res.status !== 429 && res.status !== 503) break;
    await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
  }

  if (raw) return res;

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* respuesta vacía */ }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ('Graph API error ' + res.status + ': ' + text.slice(0, 300));
    throw new Error(msg);
  }
  return data;
}

/* ===== Sitio y drive (resueltos una vez por proceso) ===== */
let _siteId = null;

async function getSiteId() {
  if (_siteId) return _siteId;
  const site = await graphFetch('/sites/' + HOSTNAME + ':' + SITE_PATH);
  _siteId = site.id;
  return _siteId;
}

let _driveId = null;

async function getDriveId() {
  if (_driveId) return _driveId;
  const siteId = await getSiteId();
  const data = await graphFetch('/sites/' + siteId + '/drives');
  const drives = data.value || [];
  const chosen = drives.find(d => d.name === 'Documents') ||
                 drives.find(d => d.driveType === 'documentLibrary') || drives[0];
  if (!chosen) throw new Error('No document library found on site.');
  _driveId = chosen.id;
  return _driveId;
}

/* ===== HELPERS DE LISTAS ===== */

function siteListPath(listName) {
  return '/sites/' + HOSTNAME + ':' + SITE_PATH + ':/lists/' + encodeURIComponent(listName) + '/items';
}

async function createListItem(listName, fields) {
  return graphFetch(siteListPath(listName), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
}

async function updateListItemByItemId(listName, itemId, fields) {
  return graphFetch(siteListPath(listName) + '/' + itemId + '/fields', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields)
  });
}

/* DELETE de un item usando siteId resuelto — la ruta con colon-encoding no funciona para DELETE */
async function deleteListItem(listName, itemId) {
  const siteId = await getSiteId();
  return graphFetch("/sites/" + siteId + "/lists/" + encodeURIComponent(listName) + "/items/" + itemId, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" }
  });
}

/* Consulta con $filter/$expand/$orderby/$top opcionales.
   Ej.: queryList(ORDERS_LIST, '$expand=fields&$top=200') */
async function queryList(listName, odata) {
  const qs = odata ? '?' + String(odata).replace(/^\?/, '') : '?$expand=fields';
  const data = await graphFetch(siteListPath(listName) + qs);
  return data.value || [];
}

/* ===== HELPERS DE DRIVE (archivos e imágenes) ===== */

/* Codifica una URL compartida al formato que espera Graph (/shares/) */
function encodeShareLink(url) {
  return 'u!' + Buffer.from(url, 'utf-8').toString('base64')
    .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
}

/* Resuelve un enlace compartido (":x:/s/...", ":f:/..." etc.) al item real */
async function driveItemByShareLink(shareUrl) {
  const data = await graphFetch('/shares/' + encodeURIComponent(encodeShareLink(shareUrl)) + '/driveItem');
  return data;   // incluye id y parentReference.driveId
}

/* Item por ruta relativa al root del drive · null si no existe */
async function driveItemByPath(relPath) {
  const driveId = await getDriveId();
  const clean = String(relPath || '').replace(/^\/+|\/+$/g, '');
  try {
    return await graphFetch('/drives/' + driveId + '/root:/'
      + clean.split('/').map(encodeURIComponent).join('/'));
  } catch (e) { return null; }
}

/* Hijos de una carpeta: [{name,id,size,isFile,isFolder}] · [] si no existe */
async function listChildren(folderRelPath) {
  const driveId = await getDriveId();
  const clean = String(folderRelPath || '').replace(/^\/+|\/+$/g, '');
  try {
    const data = await graphFetch('/drives/' + driveId + '/root:/'
      + clean.split('/').map(encodeURIComponent).join('/') + ':/children');
    return (data.value || []).map(x => ({
      name: x.name, id: x.id, size: x.size || 0,
      isFile: !!x.file, isFolder: !!x.folder
    }));
  } catch (e) { return []; }
}

/* Primer archivo cuyo nombre EMPIEZA con prefix (case-insensitive)
   Regla CategoryImages: "kitchen" → Kitchen-Image.png */
async function findByPrefix(folderRelPath, prefix) {
  const kids = await listChildren(folderRelPath);
  const p = String(prefix || '').toLowerCase();
  return kids.find(k => k.isFile && k.name.toLowerCase().startsWith(p)) || null;
}

/* Archivo por nombre EXACTO sin importar mayúsculas ni extensión
   "Kitchen-Stove-DeepClean" encuentra .png/.jpg/.jpeg/.webp */
async function findByName(folderRelPath, baseName) {
  const kids = await listChildren(folderRelPath);
  const target = String(baseName || '').toLowerCase();
  return kids.find(k => {
    if (!k.isFile) return false;
    const dot = k.name.lastIndexOf('.');
    const stem = (dot >= 0 ? k.name.slice(0, dot) : k.name).toLowerCase();
    return stem === target;
  }) || null;
}

/* Descarga un item por ID → Buffer */
async function downloadById(itemId) {
  const driveId = await getDriveId();
  const res = await graphFetch('/drives/' + driveId + '/items/' + itemId + '/content', {}, true);
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  return Buffer.from(await res.arrayBuffer());
}


/* ===== ESCRITURA EN EL DRIVE (carpetas y subida de archivos) ===== */

function encodePath(relPath) {
  return String(relPath || '').replace(/^\/+|\/+$/g, '')
    .split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

/* Primera CARPETA cuyo nombre empieza con prefix (case-insensitive).
   Se usa para hallar "GS-6062 - Cualquier Nombre" solo con "GS-6062 -". */
async function findFolderByPrefix(parentRelPath, prefix) {
  const kids = await listChildren(parentRelPath);
  const p = String(prefix || '').trim().toLowerCase();
  if (!p) return null;
  return kids.find(k => k.isFolder && k.name.trim().toLowerCase().startsWith(p)) || null;
}

/* Crea la carpeta si no existe y devuelve su ruta relativa.
   Crea cada nivel por separado: Graph no crea rutas intermedias. */
async function ensureFolder(relPath) {
  const driveId = await getDriveId();
  const parts = String(relPath || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let walked = '';
  for (const part of parts) {
    const next = walked ? walked + '/' + part : part;
    const existing = await driveItemByPath(next);
    if (existing && existing.folder) { walked = next; continue; }
    const parentUrl = walked
      ? '/drives/' + driveId + '/root:/' + encodePath(walked) + ':/children'
      : '/drives/' + driveId + '/root/children';
    try {
      await graphFetch(parentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: part,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'replace'
        })
      });
    } catch (e) {
      /* Otra ejecucion pudo crearla al mismo tiempo: solo falla si sigue ausente */
      const check = await driveItemByPath(next);
      if (!check) throw e;
    }
    walked = next;
  }
  return walked;
}

/* Sube (o reemplaza) un archivo. Usa PUT simple hasta 4 MB, que es de sobra
   para un PDF de una orden. Devuelve { id, name, webUrl }. */
async function uploadFile(folderRelPath, fileName, buffer, contentType) {
  const driveId = await getDriveId();
  await ensureFolder(folderRelPath);
  const target = '/drives/' + driveId + '/root:/' + encodePath(folderRelPath)
    + '/' + encodeURIComponent(fileName) + ':/content';
  const item = await graphFetch(target, {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: buffer
  });
  return { id: item.id, name: item.name, webUrl: item.webUrl };
}

/* Descarga un archivo por ruta relativa -> Buffer, o null si no existe */
async function downloadByPath(relPath) {
  const driveId = await getDriveId();
  try {
    const res = await graphFetch('/drives/' + driveId + '/root:/'
      + encodePath(relPath) + ':/content', {}, true);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) { return null; }
}

module.exports = {
  PATHS,
  CLIENTS_LIST, ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, DRAFTS_LIST,
  CLIENT_HISTORY_LIST, ORDERS_FOLDER,
  getGraphToken, graphFetch, getSiteId, getDriveId,
  siteListPath, queryList, createListItem, updateListItemByItemId, deleteListItem,
  encodeShareLink, driveItemByShareLink,
  driveItemByPath, listChildren, findByPrefix, findByName, downloadById,
  findFolderByPrefix, ensureFolder, uploadFile, downloadByPath,
  jsonResponse
};

/* Respuesta JSON estándar para handlers */
function jsonResponse(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  };
}