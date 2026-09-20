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

/* ===== Utilidades de formato (todo en INGLES: es texto de la app) =====
   A peticion del dueño (19/09/2026): todas las fechas/horas del PDF
   (incluyendo "Issued" en el pie de pagina) deben verse en hora de
   Iowa, no UTC crudo -- America/Chicago via Intl.DateTimeFormat, que
   ya resuelve solo el horario de verano (CDT/CST) sin tener que
   calcularlo a mano ni que se desfase 2 veces al año. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CHICAGO_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true
});
function chicagoParts(d) {
  const out = {};
  CHICAGO_FMT.formatToParts(d).forEach(p => { out[p.type] = p.value; });
  return out;
}

function fmtDate(value) {
  if (!value) return '';
  /* Fechas SOLO-fecha (ej. "2026-09-19", sin hora -- EntryDate,
     DueDate, DispatchDate, etc.) se interpretan como medianoche UTC;
     convertir eso a hora de Iowa las correria un dia para atras (CDT/
     CST siempre estan detras de UTC). Se ancla al mediodia UTC para
     ese caso -- nunca cruza medianoche en Iowa, sea CDT o CST. Fechas
     que SI traen hora real (ChangeDate, createdDateTime, "Issued")
     se convierten tal cual, sin este ajuste. */
  const raw = String(value);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const d = new Date(isDateOnly ? raw + 'T12:00:00Z' : raw);
  if (isNaN(d.getTime())) return String(value);
  const p = chicagoParts(d);
  return MONTHS[parseInt(p.month, 10) - 1] + ' ' + p.day + ', ' + p.year;
}

function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  const p = chicagoParts(d);
  return fmtDate(value) + ' ' + p.hour + ':' + p.minute + ' ' + p.dayPeriod;
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
    webUrl: last.item.webUrl || '',
    createdDateTime: last.item.createdDateTime || ''
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

/* Info real de GS Solutions (gsocd.com/contact-us), para la columna a
   la derecha de "Client" en los 3 documentos -- a peticion del dueño.
   El correo es orders@gsocd.com (corregido por el dueño -- la pagina
   trae info@gsocd.com, pero ese no es el que se quiere aqui). */
const GS_SOLUTIONS_LINES = [
  'GS Solutions',
  '1985 NW 94th St, Suite F',
  'Clive, IA 50325',
  '(515) 209-2204',
  'orders@gsocd.com'
];

/* "Client" + la columna de GS Solutions a la derecha -- misma pieza
   para los 3 documentos (orden, completion, solicitud). includeContact
   es opcional porque solo el documento de la orden trae ese campo. */
function renderClientSection(doc, order, includeContact) {
  doc.h2('Client');
  const startY = doc.y;
  doc.kv('Business', clean(order.BusinessName) || clean(order.Title));
  doc.kv('Client ID', clean(order.ClientID));
  if (includeContact) doc.kv('Contact', clean(order.Contact));
  const suite = clean(order.Suite);
  const addr = [clean(order.Address), suite ? 'Suite ' + suite : '',
    clean(order.City), clean(order.Zip)].filter(Boolean).join(', ');
  doc.kv('Address', addr);
  const leftEndY = doc.y;
  const rightEndY = doc.rightBlock(GS_SOLUTIONS_LINES, { startY, boldFirst: true, align: 'left' });
  doc.y = Math.min(leftEndY, rightEndY);
}

/* "Change History" completa -- misma pieza para el documento de la
   orden Y el de solicitud (Review). A peticion del dueño (19/09/2026:
   "te dije que TODOS los botones tenian que imprimir los mismos
   eventos") -- antes solo vivia dentro de buildOrderPdf, asi que el
   documento de Review (buildRequestPdf) nunca mostraba el historial,
   aunque print-request-document.js ya lo traia fresco (solo lo usaba
   para encontrar la solicitud pendiente, nunca se lo pasaba al PDF). */
function renderChangeHistory(doc, history) {
  const GRAY = [0.42, 0.42, 0.42];
  const ALWAYS_HIDDEN = ['Document Generated', 'Document Failed', 'Archived', 'Batch Created'];
  const NOISY_IF_EMPTY = ['Order Assigned', 'Order Approved', 'Change Rejected',
    'Change Request Cancelled', 'Materials Ready Seen', 'Completed'];
  doc.h2('Change History');
  const histRows = (history || [])
    .filter(h => ALWAYS_HIDDEN.indexOf(clean(h.ChangeType)) === -1)
    .map(h => ({ h, detail: historyDetailLine(h) }))
    .filter(e => !(NOISY_IF_EMPTY.indexOf(clean(e.h.ChangeType)) !== -1 && !e.detail));
  if (!histRows.length) {
    doc.text('No history recorded.', { size: 9.5, color: GRAY });
  } else {
    const rows = histRows.map(e => [
      fmtDateTime(e.h.ChangeDate || e.h.createdDateTime),
      clean(e.h.ChangeType),
      clean(e.h.ChangedBy),
      e.detail
    ]);
    doc.table(['Date', 'Event', 'By', 'Detail'], rows, [0.23, 0.17, 0.14, 0.46], { padY: 14 });
  }
}

function buildOrderPdf(data) {
  const order = data.order || {};
  const services = data.services || [];
  const history = data.history || [];
  const revision = data.revision || 1;
  const orderId = clean(order.OrderID) || 'ORDER';

  const doc = new PdfDoc();
  if (data.logoBuffer) doc.setWatermark(data.logoBuffer);
  const GRAY = [0.42, 0.42, 0.42];

  /* --- Encabezado ---
     A peticion del dueño (19/09/2026, con captura marcada): la linea
     de "Revision N | Issued [fecha]" ya no va aqui debajo del titulo
     -- se mueve a las esquinas inferiores del pie de pagina (ver
     doc.end() al final de esta funcion). */
  doc.h1('Service Order ' + orderId);
  doc.gap(4);
  doc.rule([0.788, 0.659, 0.298], 1.4);

  /* --- Cliente --- */
  renderClientSection(doc, order, true);

  /* --- Orden ---
     A peticion del dueño (19/09/2026): 2 columnas, pero agrupadas de
     verdad por tema -- no solo alternando parejas en el orden que
     llegan. Izquierda: datos del LUGAR (division, unidad, condicion).
     Derecha: datos del SERVICIO (estatus, tecnico/supervisor, fechas,
     ventana de horario). */
  doc.h2('Order Details');
  const unit = [
    clean(order.BuildingNumber) ? 'Building ' + clean(order.BuildingNumber) : '',
    clean(order.UnitNumber) ? 'Unit ' + clean(order.UnitNumber) : '',
    clean(order.Bedrooms) ? clean(order.Bedrooms) + ' bed' : '',
    clean(order.Bathrooms) ? clean(order.Bathrooms) + ' bath' : ''
  ].filter(Boolean).join('   ');
  doc.kv2colGroups(
    [
      ['Division', clean(order.Division)],
      ['Unit', unit],
      ['Dirt Level', clean(order.DirtLevel)]
    ].filter(p => p[0] !== 'Unit' || unit),
    [
      ['Status', clean(order.Status)],
      ['Supervisor', clean(order.Supervisor)],
      /* A peticion del dueño (19/09/2026): SOLO la fecha del servicio
         (DispatchDate) -- ya no Submitted/Entry Date/Due Date. Si la
         orden no tiene DispatchDate, el campo se queda vacio ('-',
         mismo comportamiento que ya tenia kv2col para cualquier valor
         ausente) -- sin caer a ninguna otra fecha en su lugar. */
      ['Service Date', fmtDate(order.DispatchDate)],
      ['Service Window', clean(order.ServiceWindow)]
    ]
  );

  /* --- Servicios ---
     A peticion del dueño (19/09/2026): la tabla muestra la lista
     ORIGINAL de la orden (la que trae el primer 'Services' del
     historial) MAS lo que se agrego despues -- todo en UNA sola
     tabla (a peticion del dueño, 19/09/2026: "eso que pusiste en
     verde se unifica con las demas" -- antes lo agregado salia como
     un renglon de texto aparte, en verde, debajo de la tabla; ahora
     es una fila mas, mezclada con las demas, con Result='Added').
     Un servicio quitado despues se queda en la tabla con
     Result='Removed'; uno agregado despues con Result='Added' --
     ambos por encima del estatus real que tendria (no se mezclan con
     Scheduled/Completed/etc., para que "que cambio contra la orden
     original" salte a la vista igual de claro que antes, nomas ya
     sin el color aparte). Si el historial no trae ningun 'Services'
     (ordenes viejas sin ese registro), originalServices cae de vuelta
     a la lista actual tal cual, sin marcar nada como
     agregado/quitado -- no hay con que comparar. */
  doc.h2('Services');
  const originalServices = findOriginalServices(history) || services;
  if (!originalServices.length && !services.length) {
    doc.text('No services recorded on this order.', { size: 9.5, color: GRAY });
  } else {
    const orderStatus = clean(order.Status);
    const currentByKey = {};
    services.forEach(s => { currentByKey[serviceKey(s)] = s; });
    const originalByKey = {};
    originalServices.forEach(s => { originalByKey[serviceKey(s)] = s; });

    const rowFor = s => {
      const key = serviceKey(s);
      const live = currentByKey[key];
      let status;
      if (!live) {
        status = 'Removed';
      } else if (!originalByKey[key]) {
        status = 'Added';
      } else if (String(live.NotCompleted) === 'true' || live.NotCompleted === true) {
        status = 'NOT COMPLETED';
        const why = clean(live.NotCompletedReason);
        if (why) status += ' - ' + why;
      } else if (orderStatus === 'Cancelled') {
        status = 'Cancelled';
      } else if (orderStatus === 'Completed') {
        status = 'Completed';
      } else {
        status = 'Scheduled';
      }
      return [clean(s.Category), clean(s.ServiceName), svcOptionLabel(s), status];
    };

    const addedSince = services.filter(s => !originalByKey[serviceKey(s)]);
    const rows = originalServices.map(rowFor).concat(addedSince.map(rowFor));
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

  /* --- Historial: nada se pierde a proposito, EXCEPTO ruido puramente
     operativo. A peticion del dueño (19/09/2026, con captura marcada):
       - "Document Generated" (y los mismos que ya oculta SIEMPRE el
         componente de historial de la app -- gsocd-shared/order-
         history: "Document Failed", "Archived", "Batch Created") --
         nunca aportan nada a "que paso con la orden" en el documento
         impreso, tengan o no detalle. Antes SI se imprimian aqui
         (unica diferencia real contra la app, que ya los escondia).
       - "Order Assigned"/"Order Approved"/"Change Rejected"/"Change
         Request Cancelled"/"Materials Ready Seen"/"Completed"
         (los ultimos 4, agregados con otra captura marcada) -- estos
         SOLO se saltan cuando no traen ningun detalle real que
         mostrar (puro marcador interno, sin informacion propia -- el
         Status actual ya se ve arriba, en Order Details). Si SI traen
         detalle real (ej. una nota personalizada de rechazo, o un
         cambio de servicios real paso justo en ese mismo evento), se
         quedan igual que siempre -- no se descartan por su tipo, se
         descartan por venir vacios. */
  renderChangeHistory(doc, history);

  return doc.end(
    'GS Solutions   |   ' + orderId + '   |   Revision ' + revision,
    'Issued ' + fmtDateTime(new Date().toISOString())
  );
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
    /* A peticion del dueño (19/09/2026: "no le vayas a quitar cosas
       que yo no te dije explicitamente") -- este evento solo traia la
       frase generica de origen, sin la fecha/hora con que se creo la
       orden ni la lista de servicios con que se pidio. Se agrega
       exactamente lo mismo que ya muestra el historial de la app
       (gsocd-shared/order-history, detailLinesFor para 'Created'):
       Entry/Due/Window + un renglon por cada servicio -- como lista,
       igual que el resto del Detail ahora (ver mas abajo). Nada mas
       de este evento ni de ningun otro tipo se toco. */
    const origin = field === 'Office Order'
      ? 'Created directly by GS Solutions staff.'
      : 'Submitted by the client through the online portal.';
    const lines = [origin];
    if (notes && notes !== 'Submitted from draft.') lines.push(notes);
    const payload = parseServicesPayload(newV);
    if (payload) {
      if (payload.entryDate) lines.push('Entry: ' + fmtDate(payload.entryDate));
      if (payload.dueDate) lines.push('Due: ' + fmtDate(payload.dueDate));
      if (payload.serviceWindow) lines.push('Window: ' + payload.serviceWindow);
      (payload.services || []).forEach(s => {
        const opt = svcOptionLabel(s);
        lines.push('• ' + clean(s.Category) + ': ' + clean(s.ServiceName) + (opt && opt !== '-' ? ' — ' + opt : ''));
      });
    }
    return lines.join('\n');
  }

  /* El JSON de servicios puede venir con el prefijo "SERVICES:" (flujos
     de la oficina) o crudo, sin prefijo (flujo del cliente al pedir un
     cambio desde el portal -- submit-order.js solo hace
     JSON.stringify(services) directo). Sin este segundo caso
     reconocido, el JSON crudo se imprimia tal cual en el PDF. */
  const looksLikeServicesJson = v => v.indexOf('SERVICES:') === 0 || /^\s*[\[{]/.test(v);
  if (looksLikeServicesJson(oldV) || looksLikeServicesJson(newV)) {
    /* A peticion del dueño (19/09/2026, con captura marcada): antes
       esto pegaba "notes" (el resumen corto que ya guarda
       svcChangeSummary, ej. "Added: X, Y, Z.") Y el diff calculado
       aqui (ej. "Added: X (Level 1); Added: Y (Level 1)") con " | ",
       diciendo lo MISMO dos veces con distinto detalle -- se ve como
       texto duplicado. Ahora solo se usa el diff, como una LISTA (un
       renglon por cambio, con salto de linea real -- table() ya sabe
       respetarlos) en vez de un parrafo separado por ";". Si no hay
       diff que mostrar (el snapshot no cambio nada de verdad), cae a
       notes si lo hay; si no hay ninguno de los dos, regresa vacio --
       ese renglon del historial se salta por completo mas abajo (ver
       "sin detalle real" en buildOrderPdf). */
    const lines = serviceDiffLines(oldV, newV);
    if (lines.length) return lines.join('\n');
    return notes || '';
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

/* Reconstruye la lista ORIGINAL de servicios de la orden a partir del
   historial -- el renglon MAS ANTIGUO (por fecha) cuyo NewValue sea
   un snapshot valido de servicios ("SERVICES:{...}" o JSON crudo).

   BUG REAL arreglado (19/09/2026, reportado por el dueño: "una vez
   aprobado el servicio, aparece en el historial y en los servicios
   como un servicio integro, lo que queda de que se agrego es en el
   historial" -- un servicio agregado en el PRIMER cambio de la orden
   se veia como si siempre hubiera sido parte de la orden original).
   La version anterior filtraba por FieldChanged==='Services', pero el
   renglon de CREACION de la orden (submit-order.js) nunca usa esa
   etiqueta -- usa FieldChanged='Office Order' (o vacio), aunque su
   NewValue SI trae el snapshot real de servicios con los que se creo
   la orden. Con el filtro viejo, esa primera fila se saltaba por
   completo y "original" terminaba siendo el primer CAMBIO real
   (FieldChanged='Services', escrito por admin-update-order.js al
   aprobar/editar) -- que ya incluye lo agregado en ese primer cambio,
   asi que se veia integrado como si siempre hubiera estado ahi. Ya no
   se filtra por FieldChanged en absoluto -- cualquier renglon, sea
   cual sea su etiqueta, cuenta si su NewValue parsea como una lista
   de servicios valida (todo snapshot "SERVICES:" en el sistema
   siempre es la lista COMPLETA en ese momento, nunca un delta parcial,
   asi que el mas antiguo de todos es de verdad el original). Si no
   hay ningun snapshot parseable en el historial (ordenes muy viejas,
   o algun caso raro), regresa null -- el llamador entonces usa la
   lista actual tal cual, sin marcar nada como agregado/quitado. */
function findOriginalServices(history) {
  const svcEntries = (history || [])
    .map(h => ({
      date: h.ChangeDate || h.createdDateTime || '',
      payload: parseServicesPayload(h.NewValue)
    }))
    .filter(e => e.payload && Array.isArray(e.payload.services) && e.payload.services.length);
  if (!svcEntries.length) return null;
  svcEntries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return svcEntries[0].payload.services;
}

/* Arreglo de lineas, una por cambio (Added/Removed/nivel/Dirt Level) --
   version "de lista" para donde el detalle se ve mejor como varios
   renglones (Change History) en vez de un parrafo largo. */
function serviceDiffLines(oldValue, newValue) {
  const before = parseServicesPayload(oldValue);
  const after = parseServicesPayload(newValue);
  if (!before || !after) return [];
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
  return lines;
}

/* Mismo resultado que serviceDiffLines, unido en un solo parrafo --
   para donde ya se usaba asi (ej. "Requested change" del documento
   de Solicitud, que solo describe UN cambio a la vez). */
function serviceDiffText(oldValue, newValue) {
  return serviceDiffLines(oldValue, newValue).join('; ');
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

  /* A peticion del dueño (19/09/2026, con captura marcada): la linea
     de "Completion record N | Issued [fecha]" ya no va aqui debajo
     del titulo -- se mueve a las esquinas inferiores del pie de
     pagina (ver doc.end() al final de esta funcion). */
  doc.h1('Order Completed — ' + orderId);
  doc.gap(4);
  doc.rule([0.788, 0.659, 0.298], 1.4);

  renderClientSection(doc, order, false);

  doc.h2('Completion');
  doc.kv2col([
    ['Completed by', clean(data.completedBy)],
    ['Completed on', fmtDateTime(data.completedAt || new Date().toISOString())],
    ['Supervisor', clean(order.Supervisor)],
    ['Service Date', fmtDate(order.DispatchDate)]
  ]);

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

  return doc.end(
    'GS Solutions   |   ' + orderId + '   |   Completion ' + revision,
    'Issued ' + fmtDateTime(new Date().toISOString())
  );
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
      ok: true, fileName, revision, folderPath, buffer,
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
  const history = data.history || [];
  const revision = data.revision || 1;
  const orderId = clean(order.OrderID) || 'ORDER';
  const isCancel = clean(req.ChangeType) === 'Cancellation Requested';
  const kindLabel = isCancel ? 'Cancellation Request' : 'Change Request';

  const doc = new PdfDoc();
  if (data.logoBuffer) doc.setWatermark(data.logoBuffer);
  const GRAY = [0.42, 0.42, 0.42];

  /* A peticion del dueño (19/09/2026, con captura marcada): la linea
     de "Request record N | Issued [fecha]" ya no va aqui debajo del
     titulo -- se mueve a las esquinas inferiores del pie de pagina
     (ver doc.end() al final de esta funcion). */
  doc.h1(kindLabel + ' — ' + orderId);
  doc.gap(4);
  doc.rule([0.788, 0.659, 0.298], 1.4);

  renderClientSection(doc, order, false);

  doc.h2('Request');
  doc.kv2col([
    ['Requested by', clean(req.ChangedBy) || (data.origin === 'office' ? 'GS Solutions staff' : 'Client')],
    ['Requested on', fmtDateTime(req.ChangeDate)]
  ]);
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
  doc.kv2col([
    ['Status', clean(order.Status)],
    ['Service date', fmtDate(order.DispatchDate)],
    ['Service window', clean(order.ServiceWindow)]
  ]);

  /* A peticion del dueño (19/09/2026): este documento tambien debe
     mostrar los mismos eventos que el resto -- antes se quedaba solo
     con "Requested change" (un renglon), sin el historial completo. */
  renderChangeHistory(doc, history);

  return doc.end(
    'GS Solutions   |   ' + orderId + '   |   ' + kindLabel + ' ' + revision,
    'Issued ' + fmtDateTime(new Date().toISOString())
  );
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
  ensureOrderFolder,
  existingRevisions,
  historyDetailLine,
  serviceDiffText,
  fmtDate,
  fmtDateTime
};
