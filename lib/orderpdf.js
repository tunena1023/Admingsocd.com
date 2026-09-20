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
   - Imprimir NUNCA genera: imprime el PDF guardado.
============================================================ */

const {
  ORDERS_FOLDER, ensureFolder, uploadFile, listChildren,
  findFolderByPrefix, driveItemByPath, downloadById
} = require('./graph');
const { PdfDoc } = require('./pdf');
const heicConvert = require('heic-convert');

/* Misma carpeta que get-order-photos.js / get-my-gallery.js --
   TechPhotos/<ClientID> - <BusinessName>/<OrderID>/Photos/*.jpg */
const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';
const MAX_COMPLETION_PHOTOS = 60;

/* BUG REAL encontrado por el dueno probando Completacion (19/09/2026):
   las fotos no salian en el PDF, aunque el texto si. Causa: el input
   de camara de Tech (employee.html/supervisor.html) sube el archivo
   TAL CUAL sale del telefono, sin volver a codificarlo -- en iPhone,
   sin el ajuste "Most Compatible", eso es HEIC, no JPEG. El servidor
   (upload-photo.js) le pone extension .jpg y content-type image/jpeg
   de todos modos, asi que se ve bien en pantalla (Safari sabe abrir
   HEIC en un <img>) pero mi lector de JPEG a mano (jpegInfo) lo
   rechaza de inmediato -- no empieza con FFD8, cae en el placeholder
   gris silencioso. Se detecta por firma real (contenedor ISOBMFF
   "ftyp" + marca conocida de HEIC/HEIF) y se convierte a JPEG de
   verdad antes de intentar incrustarla. Si la conversion falla, esa
   foto se omite (nunca debe tumbar el documento completo). */
function looksLikeHeic(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buffer.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
}

/* Logo de marca de agua: mismo archivo que usa el nav (raiz del drive
   de SharePoint), cacheado por proceso para no pedirlo en cada PDF --
   si falla (no existe, sin permiso, lo que sea), el PDF se genera
   igual pero sin marca de agua; nunca debe tumbar la operacion. */
let _logoCache = null;
let _logoCacheAt = 0;
const LOGO_CACHE_MS = 30 * 60 * 1000;

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

/* ===== Utilidades de formato (todo en INGLES: es texto de la app) ===== */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return fmtDate(value) + ' ' + h + ':' + m + ' ' + ampm;
}

function clean(v) {
  return (v == null || v === '') ? '' : String(v).trim();
}

/* Catalogo nuevo: SubOption es el SKU interno (ej. "222-68"), nunca
   texto legible -- no se imprime tal cual. Si aplica un nivel (solo
   Janitorial), se muestra ese; si no, se deja en blanco. Ordenes
   viejas (antes de la migracion al catalogo nuevo) siguen con
   SubOption como texto legible -- esas se imprimen igual que siempre. */
function isSkuFormat(sub) { return /^\d{3}-\d+$/.test(clean(sub)); }
function svcOptionLabel(s) {
  const sub = clean(s.SubOption);
  if (isSkuFormat(sub)) return clean(s.Level) || '-';
  return sub || '-';
}

/* ===== Carpeta y nombre del archivo ===== */

function folderName(clientId, businessName) {
  const base = clean(clientId) || 'UNKNOWN';
  const name = clean(businessName);
  /* SharePoint prohibe estos caracteres en nombres de carpeta */
  const safe = name.replace(/[\\/:*?"<>|#%]/g, ' ').replace(/\s+/g, ' ').trim();
  return safe ? base + ' - ' + safe : base;
}

/* Devuelve la ruta relativa de la carpeta de la orden, creandola si falta.
   Busca primero por prefijo "<ClientID> - " para reutilizar la existente. */
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

/* Lista los PDF de esa orden que ya existen, ordenados por revision.
   kind es opcional: sin el, el patron es "<orderId>-rN.pdf" (el
   documento oficial de siempre); con kind (p.ej. 'completion' o
   'request'), el patron es "<orderId>-<kind>-rN.pdf" -- un tipo de
   documento nuevo, con su propia numeracion, en la MISMA carpeta. */
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

/* El PDF mas reciente de una orden, o null. Lo usa el boton Print. */
/* kind opcional (ver existingRevisions): sin el, el PDF oficial de
   siempre (<orderId>-rN.pdf); con 'completion' o 'request', el
   documento de ese tipo mas reciente en la misma carpeta. */
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
    webUrl: last.item.webUrl || ''
  };
}

/* ===== Contenido del documento ===== */

const DELAY_LABELS = {
  'Site not ready': 'The site was not ready for service at the scheduled time.',
  'Rescheduled by us': 'This order was rescheduled by GS Solutions.',
  'Rescheduled by client': 'This order was rescheduled at the client\'s request.',
  'Weather': 'Service was delayed by weather conditions.',
  'Other': 'This order was delayed.'
};

/* Avisos que llevan cargo extra: solo AVISO, el monto lo maneja la oficina */
const FEE_REASONS = ['Site not ready', 'Rescheduled by client'];

function buildOrderPdf(data) {
  const order = data.order || {};
  const services = data.services || [];
  const history = data.history || [];
  const revision = data.revision || 1;
  const orderId = clean(order.OrderID) || 'ORDER';

  const doc = new PdfDoc();
  if (data.logoBuffer) doc.setWatermark(data.logoBuffer);
  const GRAY = [0.42, 0.42, 0.42];

  /* --- Encabezado --- */
  doc.h1('Service Order ' + orderId);
  doc.text('GS Solutions   |   Revision ' + revision
    + '   |   Issued ' + fmtDateTime(new Date().toISOString()),
    { size: 9.5, color: GRAY });
  doc.gap(4);
  doc.rule([0.788, 0.659, 0.298], 1.4);

  /* --- Cliente --- */
  doc.h2('Client');
  doc.kv('Business', clean(order.BusinessName) || clean(order.Title));
  doc.kv('Client ID', clean(order.ClientID));
  doc.kv('Contact', clean(order.Contact));
  const suite = clean(order.Suite);
  const addr = [clean(order.Address), suite ? 'Suite ' + suite : '',
    clean(order.City), clean(order.Zip)].filter(Boolean).join(', ');
  doc.kv('Address', addr);

  /* --- Orden --- */
  doc.h2('Order Details');
  doc.kv('Status', clean(order.Status));
  doc.kv('Division', clean(order.Division));
  doc.kv('Supervisor', clean(order.Supervisor));
  doc.kv('Submitted', fmtDateTime(order.createdDateTime));
  doc.kv('Entry Date', fmtDate(order.EntryDate));
  doc.kv('Due Date', fmtDate(order.DueDate));
  doc.kv('Service Window', clean(order.ServiceWindow));
  const unit = [
    clean(order.BuildingNumber) ? 'Building ' + clean(order.BuildingNumber) : '',
    clean(order.UnitNumber) ? 'Unit ' + clean(order.UnitNumber) : '',
    clean(order.Bedrooms) ? clean(order.Bedrooms) + ' bed' : '',
    clean(order.Bathrooms) ? clean(order.Bathrooms) + ' bath' : ''
  ].filter(Boolean).join('   ');
  if (unit) doc.kv('Unit', unit);
  doc.kv('Dirt Level', clean(order.DirtLevel));

  /* --- Servicios --- */
  doc.h2('Services');
  if (!services.length) {
    doc.text('No services recorded on this order.', { size: 9.5, color: GRAY });
  } else {
    const orderStatus = clean(order.Status);
    const rows = services.map(s => {
      let status;
      if (String(s.NotCompleted) === 'true' || s.NotCompleted === true) {
        status = 'NOT COMPLETED';
        const why = clean(s.NotCompletedReason);
        if (why) status += ' - ' + why;
      } else if (orderStatus === 'Cancelled') {
        status = 'Cancelled';
      } else if (orderStatus === 'Completed') {
        status = 'Completed';
      } else {
        status = 'Scheduled';
      }
      return [clean(s.Category), clean(s.ServiceName), svcOptionLabel(s), status];
    });
    doc.table(['Category', 'Service', 'Option', 'Result'], rows,
      [0.19, 0.25, 0.22, 0.34]);
  }

  /* --- Retraso / cargo extra (solo aviso) --- */
  const delayType = clean(order.DelayReasonType);
  if (delayType) {
    doc.h2('Delay Notice');
    const parts = [DELAY_LABELS[delayType] || ('Delay reason: ' + delayType)];
    const notes = clean(order.DelayReasonNotes);
    if (notes) parts.push(notes);
    if (FEE_REASONS.indexOf(delayType) !== -1) {
      parts.push('An additional fee may apply to this order. Please contact our office '
        + 'to review the details before the next scheduled visit.');
      doc.notice('An additional fee may apply.', parts.join(' '));
    } else {
      doc.notice(delayType, parts.join(' '));
    }
  }

  /* --- Notas --- */
  if (clean(order.Notes)) {
    doc.h2('Notes');
    doc.text(clean(order.Notes), { size: 9.5 });
  }

  /* --- Historial completo: nada se pierde, todo queda en el documento --- */
  doc.h2('Change History');
  if (!history.length) {
    doc.text('No history recorded.', { size: 9.5, color: GRAY });
  } else {
    const rows = history.map(h => [
      fmtDateTime(h.ChangeDate || h.createdDateTime),
      clean(h.ChangeType),
      clean(h.ChangedBy),
      historyDetailLine(h)
    ]);
    doc.table(['Date', 'Event', 'By', 'Detail'], rows, [0.23, 0.17, 0.14, 0.46]);
  }

  return doc.end('GS Solutions   |   ' + orderId + '   |   Revision ' + revision);
}

/* Mensaje automatico generico de aprobar/rechazar: el "Event" y "By" de
   la fila ya dicen lo mismo, asi que repetirlo en Detail no aporta nada.
   Si el admin escribio una nota personalizada en su lugar, esa SI se
   conserva (no calzara con este patron). */
function isGenericDecisionNote(notes) {
  if (!notes) return false;
  if (/^Approved by .+\.$/.test(notes)) return true;
  if (/^Rejected by .+?\.( Previous services were restored\.)?$/.test(notes)) return true;
  return false;
}

/* Resume un renglon del historial en una linea legible.
   Misma logica que el panel del admin, pero en texto plano. */
function historyDetailLine(h) {
  const rawNotes = clean(h.Notes);
  const notes = isGenericDecisionNote(rawNotes) ? '' : rawNotes;
  const field = clean(h.FieldChanged);
  const oldV = clean(h.OldValue);
  const newV = clean(h.NewValue);
  const changeType = clean(h.ChangeType);

  /* "Created": el renglon 'Draft -> Received' (o cualquier OldValue ->
     NewValue generico) no dice nada util -- lo que si importa es quien
     la puso. FieldChanged='Office Order' es el mismo marcador que ya
     usa admin.html para saber si una orden nueva vino de la oficina o
     del cliente. */
  if (changeType === 'Created') {
    const origin = field === 'Office Order'
      ? 'Created directly by GS Solutions staff.'
      : 'Submitted by the client through the online portal.';
    return notes && notes !== 'Submitted from draft.' ? origin + ' ' + notes : origin;
  }

  /* El JSON de servicios puede venir con el prefijo "SERVICES:" (flujos
     de la oficina) o crudo, sin prefijo (flujo del cliente al pedir un
     cambio desde el portal -- submit-order.js solo hace
     JSON.stringify(services) directo). Sin este segundo caso
     reconocido, el JSON crudo se imprimia tal cual en el PDF. */
  const looksLikeServicesJson = v => v.indexOf('SERVICES:') === 0 || /^\s*[\[{]/.test(v);
  if (looksLikeServicesJson(oldV) || looksLikeServicesJson(newV)) {
    const diff = serviceDiffText(oldV, newV);
    return [notes, diff].filter(Boolean).join(' | ') || 'Services updated';
  }
  /* "Status: OldValue -> NewValue" nunca se imprime: el evento (Event) y
     quien lo hizo (By) ya van en sus propias columnas de la misma fila. */
  if (field === 'Status') {
    return notes || '';
  }
  if (field && (oldV || newV)) {
    const line = field + ': ' + (oldV || '(empty)') + ' -> ' + (newV || '(empty)');
    return notes ? notes + ' | ' + line : line;
  }
  if (oldV && newV) {
    const line = oldV + ' -> ' + newV;
    return notes ? notes + ' | ' + line : line;
  }
  return notes || '';
}

function parseServicesPayload(value) {
  const raw = clean(value);
  const body = raw.indexOf('SERVICES:') === 0 ? raw.slice('SERVICES:'.length) : raw;
  try {
    const obj = JSON.parse(body);
    if (Array.isArray(obj)) return { services: obj };
    return obj || {};
  } catch (e) { return null; }
}

function serviceKey(s) {
  return clean(s.Category || s.category) + '|' + clean(s.ServiceName || s.service || s.name);
}

function serviceLabel(s) {
  const name = clean(s.ServiceName || s.service || s.name);
  const sub = clean(s.SubOption || s.subOption || s.option);
  const opt = isSkuFormat(sub) ? clean(s.Level || s.level) : sub;
  return opt ? name + ' (' + opt + ')' : name;
}

function serviceDiffText(oldValue, newValue) {
  const before = parseServicesPayload(oldValue);
  const after = parseServicesPayload(newValue);
  if (!before || !after) return '';
  const a = (before.services || []), b = (after.services || []);
  const mapA = {}, mapB = {};
  a.forEach(s => { mapA[serviceKey(s)] = s; });
  b.forEach(s => { mapB[serviceKey(s)] = s; });
  const lines = [];
  Object.keys(mapB).forEach(k => {
    if (!mapA[k]) lines.push('Added: ' + serviceLabel(mapB[k]));
    else {
      const subA = clean(mapA[k].SubOption || mapA[k].subOption || mapA[k].option);
      const subB = clean(mapB[k].SubOption || mapB[k].subOption || mapB[k].option);
      const o = isSkuFormat(subA) ? clean(mapA[k].Level || mapA[k].level) : subA;
      const n = isSkuFormat(subB) ? clean(mapB[k].Level || mapB[k].level) : subB;
      if (o !== n) lines.push(serviceLabel(mapB[k]).replace(/\s*\(.*\)$/, '') + ': '
        + (o || '(none)') + ' -> ' + (n || '(none)'));
    }
  });
  Object.keys(mapA).forEach(k => {
    if (!mapB[k]) lines.push('Removed: ' + serviceLabel(mapA[k]));
  });
  const dOld = clean(before.dirtLevel), dNew = clean(after.dirtLevel);
  if (dOld !== dNew && (dOld || dNew)) {
    lines.push('Dirt Level: ' + (dOld || '(empty)') + ' -> ' + (dNew || '(empty)'));
  }
  return lines.join('; ');
}

/* ===== Fotos de la orden (para el documento de Completacion) ===== */

/* Descarga todas las fotos de una orden como buffers listos para
   incrustar en el PDF. Misma ruta que get-order-photos.js. Una foto
   individual que no se puede bajar se omite -- nunca debe tumbar el
   documento completo por una sola foto corrupta o borrada a medias. */
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

/* ===== Documento de Completacion (con fotos) ===== */

function buildCompletionPdf(data) {
  const order = data.order || {};
  const services = data.services || [];
  const photos = data.photos || [];
  const revision = data.revision || 1;
  const orderId = clean(order.OrderID) || 'ORDER';

  const doc = new PdfDoc();
  if (data.logoBuffer) doc.setWatermark(data.logoBuffer);
  const GRAY = [0.42, 0.42, 0.42];

  doc.h1('Order Completed — ' + orderId);
  doc.text('GS Solutions   |   Completion record ' + revision
    + '   |   Issued ' + fmtDateTime(new Date().toISOString()),
    { size: 9.5, color: GRAY });
  doc.gap(4);
  doc.rule([0.788, 0.659, 0.298], 1.4);

  doc.h2('Client');
  doc.kv('Business', clean(order.BusinessName) || clean(order.Title));
  doc.kv('Client ID', clean(order.ClientID));
  const suite = clean(order.Suite);
  const addr = [clean(order.Address), suite ? 'Suite ' + suite : '',
    clean(order.City), clean(order.Zip)].filter(Boolean).join(', ');
  doc.kv('Address', addr);

  doc.h2('Completion');
  doc.kv('Completed by', clean(data.completedBy));
  doc.kv('Completed on', fmtDateTime(data.completedAt || new Date().toISOString()));
  doc.kv('Supervisor', clean(order.Supervisor));
  doc.kv('Service Date', fmtDate(order.DispatchDate));

  doc.h2('Services');
  if (!services.length) {
    doc.text('No services recorded on this order.', { size: 9.5, color: GRAY });
  } else {
    const rows = services.map(s => {
      let status = 'Completed';
      if (String(s.NotCompleted) === 'true' || s.NotCompleted === true) {
        status = 'NOT COMPLETED';
        const why = clean(s.NotCompletedReason);
        if (why) status += ' - ' + why;
      }
      return [clean(s.Category), clean(s.ServiceName), svcOptionLabel(s), status];
    });
    doc.table(['Category', 'Service', 'Option', 'Result'], rows, [0.19, 0.25, 0.22, 0.34]);
  }

  doc.h2('Photos' + (photos.length ? ' (' + photos.length + ')' : ''));
  if (!photos.length) {
    doc.text('No photos were taken on this order.', { size: 9.5, color: GRAY });
  } else {
    doc.photoGrid(photos, { cols: 3, cellH: 165 });
  }

  return doc.end('GS Solutions   |   ' + orderId + '   |   Completion ' + revision);
}

/* Punto de entrada: genera el documento de Completacion (con fotos),
   lo guarda en la MISMA carpeta que el resto de los PDF de la orden
   (patron "<orderId>-completion-rN.pdf", nunca se sobreescribe), y
   regresa el resultado. NUNCA lanza hacia arriba -- si falla, la
   orden ya se guardo como Completed y esa operacion no se debe
   perder por un problema al generar el documento. */
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
    const [logoBuffer, photos] = await Promise.all([
      fetchLogoBuffer(),
      fetchOrderPhotoBuffers(order)
    ]);
    const buffer = buildCompletionPdf(Object.assign({}, data, {
      revision: revision, logoBuffer: logoBuffer, photos: photos
    }));
    const uploaded = await uploadFile(folderPath, fileName, buffer, 'application/pdf');
    return {
      ok: true, fileName, revision, folderPath,
      webUrl: uploaded.webUrl || '', id: uploaded.id, photoCount: photos.length
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ===== Documento de Solicitud (constancia de lo pedido en Review) ===== */

function buildRequestPdf(data) {
  const order = data.order || {};
  const req = data.request || {};
  const revision = data.revision || 1;
  const orderId = clean(order.OrderID) || 'ORDER';
  const isCancel = clean(req.ChangeType) === 'Cancellation Requested';
  const kindLabel = isCancel ? 'Cancellation Request' : 'Change Request';

  const doc = new PdfDoc();
  if (data.logoBuffer) doc.setWatermark(data.logoBuffer);
  const GRAY = [0.42, 0.42, 0.42];

  doc.h1(kindLabel + ' — ' + orderId);
  doc.text('GS Solutions   |   Request record ' + revision
    + '   |   Issued ' + fmtDateTime(new Date().toISOString()),
    { size: 9.5, color: GRAY });
  doc.gap(4);
  doc.rule([0.788, 0.659, 0.298], 1.4);

  doc.h2('Client');
  doc.kv('Business', clean(order.BusinessName) || clean(order.Title));
  doc.kv('Client ID', clean(order.ClientID));
  const suite = clean(order.Suite);
  const addr = [clean(order.Address), suite ? 'Suite ' + suite : '',
    clean(order.City), clean(order.Zip)].filter(Boolean).join(', ');
  doc.kv('Address', addr);

  doc.h2('Request');
  doc.kv('Requested by', clean(req.ChangedBy) || (data.origin === 'office' ? 'GS Solutions staff' : 'Client'));
  doc.kv('Requested on', fmtDateTime(req.ChangeDate));
  const note = clean(req.Notes);
  if (note) doc.text(note, { size: 9.5 });

  doc.h2('Requested change');
  const looksLikeServicesJson = v => v && (v.indexOf('SERVICES:') === 0 || /^\s*[\[{]/.test(v));
  const oldV = clean(req.OldValue), newV = clean(req.NewValue);
  if (isCancel) {
    doc.text('The client requested this order be cancelled.', { size: 9.5 });
  } else if (looksLikeServicesJson(oldV) || looksLikeServicesJson(newV)) {
    const diff = serviceDiffText(oldV, newV);
    doc.text(diff || 'Services updated (no field-level differences recorded).', { size: 9.5 });
  } else if (clean(req.FieldChanged) && (oldV || newV)) {
    doc.kv(clean(req.FieldChanged), (oldV || '(empty)') + '  ->  ' + (newV || '(empty)'));
  } else {
    doc.text('No further detail was recorded with the request.', { size: 9.5, color: GRAY });
  }

  doc.h2('Order at the time of this request');
  doc.kv('Status', clean(order.Status));
  doc.kv('Service date', fmtDate(order.DispatchDate));
  doc.kv('Service window', clean(order.ServiceWindow));

  return doc.end('GS Solutions   |   ' + orderId + '   |   ' + kindLabel + ' ' + revision);
}

/* Punto de entrada: genera el documento de Solicitud, lo guarda en la
   MISMA carpeta que el resto de los PDF de la orden (patron
   "<orderId>-request-rN.pdf", nunca se sobreescribe), y regresa el
   resultado. NUNCA lanza hacia arriba. */
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
    const logoBuffer = await fetchLogoBuffer();
    const buffer = buildRequestPdf(Object.assign({}, data, { revision: revision, logoBuffer: logoBuffer }));
    const uploaded = await uploadFile(folderPath, fileName, buffer, 'application/pdf');
    return {
      ok: true, fileName, revision, folderPath, buffer,
      webUrl: uploaded.webUrl || '', id: uploaded.id
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ===== Punto de entrada: genera, sube y devuelve el resultado =====
   NUNCA lanza hacia arriba: si el PDF falla, la orden ya se guardo y no
   se debe perder la operacion. Devuelve { ok:false, error } para que el
   endpoint lo registre en el historial. */
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
    const logoBuffer = await fetchLogoBuffer();
    const buffer = buildOrderPdf(Object.assign({}, data, { revision: revision, logoBuffer: logoBuffer }));
    const uploaded = await uploadFile(folderPath, fileName, buffer, 'application/pdf');
    return {
      ok: true,
      fileName: fileName,
      revision: revision,
      folderPath: folderPath,
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
  ensureOrderFolder,
  existingRevisions,
  historyDetailLine,
  serviceDiffText,
  fmtDate,
  fmtDateTime
};
