/* ============================================================
   quickbooks-attach-photos.js — fotos de la orden al Estimate / Invoice
   (26/09/2026, pedido del dueño: "cuando se suben a QuickBooks, puedes
   poner todas las fotos de esa orden?", "se envian por email, tipo
   antes... despues", "todas, desde la inspeccion hasta el trabajo").

   POST { orderId } -> adjunta hasta BATCH fotos que falten y regresa
   { attached, total, done }. La pagina lo llama varias veces (barrita de
   avance) para no pasarse del tiempo de Vercel con muchas fotos.
   - Solo imagenes (sin videos), de la misma carpeta que la galeria.
   - Nombre que ve el cliente en el correo:
       "GS-1001-1008 Unit 34 - Before 01.jpg"          (fotos insp-)
       "GS-1001-1008 Unit 34 - After 03 - Dusting.jpg" (svc-<servicio>-)
   - IncludeOnSend: van adjuntas cuando se manda el documento por correo.
   - Lo ya adjuntado se guarda (ids de SharePoint) en qb_imported_orders,
     asi que reintentar nunca duplica.
============================================================ */
const heicConvert = require('heic-convert');
const { ORDERS_LIST, listChildren, downloadById, jsonResponse } = require('./lib/graph');
const lq = require('./lib/list-query');
const qb = require('./lib/quickbooks');

const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';
const BATCH = 4;
const MAX_BYTES = 15 * 1024 * 1024;
const isImage = n => /\.(jpe?g|png|heic|heif)$/i.test(n || '');
const STAMP = /(\d{4}-\d{2}-\d{2}_\d{6}-[a-z0-9]+)\.\w+$/i;

function looksLikeHeic(buffer) {
  if (!buffer || buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(buffer.toString('ascii', 8, 12).toLowerCase());
}

/* Antes (inspeccion) primero, luego despues; cada grupo en orden de hora. */
function planPhotos(files) {
  const info = files.map(f => {
    const n = f.name;
    const stage = /^insp-/i.test(n) ? 'before' : 'after';
    const m = n.match(/^svc-(.+)-\d{4}-\d{2}-\d{2}_\d{6}-[a-z0-9]+\.\w+$/i);
    const service = m ? m[1].replace(/_+/g, ' ').trim() : '';
    const st = (n.match(STAMP) || [])[1] || n;
    return { f, stage, service, key: st };
  });
  const ordered = [];
  ['before', 'after'].forEach(stage => {
    info.filter(x => x.stage === stage).sort((a, b) => a.key.localeCompare(b.key))
      .forEach((x, i) => ordered.push(Object.assign(x, { n: i + 1 })));
  });
  return ordered;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const orderId = String(body.orderId || '');
    if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
    if (!(await qb.isConnected())) return jsonResponse(409, { error: 'QuickBooks is not connected yet.' });

    const imported = await qb.getImportedOrders();
    const entry = imported[orderId];
    if (!entry || !entry.estimateId) return jsonResponse(404, { error: 'This order has not been sent to QuickBooks yet.' });
    const type = entry.type === 'invoice' ? 'invoice' : 'estimate';

    const rows = await lq.fetchByValues(ORDERS_LIST, 'OrderID', [orderId]);
    const o = (rows.find(r => r.fields) || {}).fields;
    if (!o) return jsonResponse(404, { error: 'Order not found.' });
    const clientLabel = (String(o.ClientID || '').trim() + ' - ' + String(o.BusinessName || o.Title || '').trim()).replace(/[\\/:*?"<>|]/g, '').trim() || orderId;
    let kids = [];
    try { kids = await listChildren(PHOTOS_FOLDER + '/' + clientLabel + '/' + orderId + '/Photos'); } catch (e) { kids = []; }
    const plan = planPhotos(kids.filter(k => k.isFile && isImage(k.name) && !(k.size > MAX_BYTES)));

    const done = new Set(entry.photoIds || []);
    const pending = plan.filter(x => !done.has(x.f.id));
    const unit = String(o.UnitNumber || '').trim() ? ' Unit ' + String(o.UnitNumber).trim() : '';
    const failed = [];
    for (const x of pending.slice(0, BATCH)) {
      const label = (x.stage === 'before' ? 'Before ' : 'After ') + String(x.n).padStart(2, '0') + (x.service ? ' - ' + x.service : '');
      const fileName = (orderId + unit + ' - ' + label).replace(/[\\/:*?"<>|]/g, '') + '.jpg';
      try {
        let buffer = await downloadById(x.f.id);
        let contentType = /\.png$/i.test(x.f.name) ? 'image/png' : 'image/jpeg';
        if (looksLikeHeic(buffer)) { buffer = await heicConvert({ buffer, format: 'JPEG', quality: 0.85 }); contentType = 'image/jpeg'; }
        await qb.uploadAttachment(type, entry.estimateId, contentType === 'image/png' ? fileName.replace(/\.jpg$/, '.png') : fileName, buffer, contentType);
        done.add(x.f.id);
      } catch (e) {
        failed.push({ name: fileName, error: e.message });
      }
    }
    await qb.updateImportedOrder(orderId, { photoIds: [...done], photoTotal: plan.length });
    const remaining = plan.filter(x => !done.has(x.f.id)).length;
    return jsonResponse(200, {
      attached: plan.length - remaining, total: plan.length,
      /* done si ya no falta nada, o si esta vuelta no pudo con ninguna (no ciclar) */
      done: remaining === 0 || (failed.length > 0 && failed.length === Math.min(BATCH, pending.length)),
      failed
    });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
