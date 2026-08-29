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
  findFolderByPrefix, driveItemByPath
} = require('./graph');
const { PdfDoc } = require('./pdf');

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

/* Lista los PDF de esa orden que ya existen, ordenados por revision */
async function existingRevisions(folderRelPath, orderId) {
  let kids = [];
  try { kids = await listChildren(folderRelPath); } catch (e) { kids = []; }
  const re = new RegExp('^' + String(orderId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '-r(\\d+)\\.pdf$', 'i');
  return kids
    .filter(k => !k.isFolder && re.test(k.name))
    .map(k => ({ name: k.name, revision: parseInt(k.name.match(re)[1], 10), item: k }))
    .sort((a, b) => a.revision - b.revision);
}

/* El PDF mas reciente de una orden, o null. Lo usa el boton Print. */
async function latestOrderPdf(order) {
  const clientId = clean(order.ClientID);
  const orderId = clean(order.OrderID);
  if (!clientId || !orderId) return null;
  const prefix = clientId + ' - ';
  let folder = null;
  try { folder = await findFolderByPrefix(ORDERS_FOLDER, prefix); } catch (e) { folder = null; }
  const folderPath = folder
    ? ORDERS_FOLDER + '/' + folder.name
    : ORDERS_FOLDER + '/' + clientId;
  const revs = await existingRevisions(folderPath, orderId);
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
    const rows = services.map(s => {
      let status = 'Scheduled';
      if (String(s.NotCompleted) === 'true' || s.NotCompleted === true) {
        status = 'NOT COMPLETED';
        const why = clean(s.NotCompletedReason);
        if (why) status += ' - ' + why;
      } else if (clean(order.Status) === 'Completed') {
        status = 'Completed';
      }
      return [clean(s.Category), clean(s.ServiceName), clean(s.SubOption) || '-', status];
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

/* Resume un renglon del historial en una linea legible.
   Misma logica que el panel del admin, pero en texto plano. */
function historyDetailLine(h) {
  const notes = clean(h.Notes);
  const field = clean(h.FieldChanged);
  const oldV = clean(h.OldValue);
  const newV = clean(h.NewValue);

  if (oldV.indexOf('SERVICES:') === 0 || newV.indexOf('SERVICES:') === 0) {
    const diff = serviceDiffText(oldV, newV);
    return [notes, diff].filter(Boolean).join(' | ') || 'Services updated';
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
  const opt = clean(s.SubOption || s.subOption || s.option);
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
      const o = clean(mapA[k].SubOption || mapA[k].subOption || mapA[k].option);
      const n = clean(mapB[k].SubOption || mapB[k].subOption || mapB[k].option);
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
    const buffer = buildOrderPdf(Object.assign({}, data, { revision: revision }));
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
  buildOrderPdf,
  latestOrderPdf,
  ensureOrderFolder,
  existingRevisions,
  historyDetailLine,
  serviceDiffText,
  fmtDate,
  fmtDateTime
};
