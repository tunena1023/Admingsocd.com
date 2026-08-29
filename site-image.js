/* ============================================================
   site-image.js — proxy de imágenes desde SharePoint.
   5 modos según query params (todos GET):
     ?cat=Kitchen                  → Assets/CategoryImages/Kitchen-Image.png
                                     (regla de prefijo, igual que customer.html)
     ?name=Logo.png                → archivo exacto en la raíz del drive
     ?svc=Kitchen-Stove-DeepClean  → Assets/Services/{nombre} (sin extensión,
                                     sin importar mayúsculas)
     ?gallery-list=Kitchen         → JSON {files:[...]} de Assets/Services/Kitchen/
     ?gallery=Kitchen&file=x.jpg   → esa foto de la carpeta de la categoría

   Caché: listados de carpetas en memoria del proceso (TTL 5 min)
   + Cache-Control para que el navegador también cachee.

   LÍMITE: las respuestas de Netlify Functions topan en ~6MB.
   Fotos mayores a 4.5MB se rechazan (el front cae a placeholder).
   Comprime las fotos de galería antes de subirlas.
============================================================ */

const {
  PATHS,
  listChildren, findByPrefix, findByName, downloadById,
  jsonResponse
} = require('./lib/graph');

const MAX_BYTES = 4.5 * 1024 * 1024;
const CACHE_TTL = 5 * 60 * 1000;

/* ===== Content-Type por extensión ===== */
const EXT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

function typeOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? (EXT_TYPES[name.slice(dot).toLowerCase()] || 'application/octet-stream') : 'application/octet-stream';
}

/* ===== Respuesta binaria con caché de navegador ===== */
function binaryResponse(buffer, contentType) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300'
    },
    body: buffer.toString('base64'),
    isBase64Encoded: true
  };
}

function notFound() {
  return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: '{"error":"not found"}' };
}

/* ===== Listados con caché de proceso (evita golpear Graph por imagen) ===== */
const _listings = {};

async function cachedChildren(folderPath) {
  const key = folderPath.toLowerCase();
  const hit = _listings[key];
  if (hit && hit.exp > Date.now()) return hit.data;
  const kids = await listChildren(folderPath);
  _listings[key] = { exp: Date.now() + CACHE_TTL, data: kids };
  return kids;
}

/* ===== Modos ===== */

/* ?cat=Categoria — Assets/CategoryImages/{Categoria}-Image.* */
async function serveCategory(cat) {
  const item = await findByPrefix(PATHS.categoryImages, cat);
  if (!item || item.size > MAX_BYTES) return notFound();
  return binaryResponse(await downloadById(item.id), typeOf(item.name));
}

/* ?name=Logo.png — archivo en la raíz del drive buscado por ruta directa */
async function serveRootFile(name) {
  const { driveItemByPath } = require('./lib/graph');
  const item = await driveItemByPath(String(name));
  if (!item || (item.size || 0) > MAX_BYTES) return notFound();
  return binaryResponse(await downloadById(item.id), typeOf(item.name));
}

/* ?svc=Categoria-Servicio[-Subopcion] — Assets/Services/ */
async function serveServiceImage(baseName) {
  /* Acepta el nombre tal cual (el front ya normaliza sin espacios) */
  const item = await findByName(PATHS.servicesImages, baseName);
  if (!item || item.size > MAX_BYTES) return notFound();
  return binaryResponse(await downloadById(item.id), typeOf(item.name));
}

/* ?gallery-list=Categoria — nombres de imagen de Assets/Services/Categoria/ */
async function serveGalleryList(cat) {
  const kids = await cachedChildren(PATHS.servicesImages + '/' + String(cat));
  const files = kids
    .filter(k => k.isFile && k.size <= MAX_BYTES && typeOf(k.name).startsWith('image/') && typeOf(k.name) !== 'image/svg+xml')
    .map(k => k.name)
    .sort();
  return jsonResponse(200, { files });
}

/* ?gallery=Categoria&file=x.jpg — foto individual de la categoría */
async function serveGalleryPhoto(cat, file) {
  const kids = await cachedChildren(PATHS.servicesImages + '/' + String(cat));
  const wanted = String(file).toLowerCase();
  const item = kids.find(k => k.isFile && k.name.toLowerCase() === wanted);
  if (!item || item.size > MAX_BYTES) return notFound();
  return binaryResponse(await downloadById(item.id), typeOf(item.name));
}

/* ===== Handler ===== */
exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const p = event.queryStringParameters || {};
  try {
    if (p.cat) return await serveCategory(p.cat);
    if (p.name) return await serveRootFile(p.name);
    if (p.svc) return await serveServiceImage(p.svc);
    if (p['gallery-list']) return await serveGalleryList(p['gallery-list']);
    if (p.gallery && p.file) return await serveGalleryPhoto(p.gallery, p.file);
    return jsonResponse(400, { error: 'Missing parameters' });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};