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
  findFolderByPrefix, driveItemByPath, downloadById,
  CLIENTS_LIST, FIELD_EMPLOYEES_LIST, SERVICE_ASSIGNMENTS_LIST, graphFetch, siteListPath
} = require('./graph');
const { PdfDoc } = require('./pdf');
const heicConvert = require('heic-convert');

/* Misma carpeta que get-order-photos.js / get-my-gallery.js --
   TechPhotos/<ClientID> - <BusinessName>/<OrderID>/Photos/*.jpg */
const PHOTOS_FOLDER = process.env.GRAPH_PHOTOS_FOLDER || 'TechPhotos';
const MAX_COMPLETION_PHOTOS = 60;

/* "Assign by service" (21/09/2026) -- estatus real por servicio para
   la tabla de Services y el resumen del Change History. Mismo
   arreglo puente de siempre para el OrderID sin indexar en
   SharePoint. Aislado (try/catch), no fatal -- si falla, el PDF se
   sigue generando normal, solo sin este detalle extra. */
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
   Iowa, no UTC crudo.

   BUG REAL encontrado por el dueño (con la hora real -- "son las
   12:19 AM" contra "5:18 AM" en el PDF, 5 horas exactas de
   diferencia): la primera version de esto usaba Intl.DateTimeFormat
   con timeZone:'America/Chicago' -- en mi sandbox de pruebas SI
   convertia bien, pero el runtime de Node en Vercel no trae la base
   de datos de zonas horarias completa (ICU reducido, comun en
   runtimes serverless) -- ahi Intl con una zona por NOMBRE no
   convierte nada, sin error, se queda en UTC crudo. Nunca fallo en
   pruebas locales, solo en produccion.

   Arreglado calculando el horario de verano A MANO, sin depender de
   que el runtime tenga esos datos -- son 2 reglas fijas desde 2007 en
   EEUU: CDT (UTC-5) del segundo domingo de marzo al primer domingo de
   noviembre; CST (UTC-6) el resto del año. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* El dia (1-31) del N-esimo domingo de un mes dado (monthIndex 0-11). */
function nthSundayUTC(year, monthIndex, n) {
  const firstDay = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay(); // 0=domingo
  const firstSunday = firstDay === 0 ? 1 : (8 - firstDay);
  return firstSunday + (n - 1) * 7;
}

/* Offset de Iowa contra UTC, en horas (negativo) -- -5 en horario de
   verano (CDT), -6 el resto del año (CST). El cambio siempre es a las
   2:00 AM hora local, que en UTC es 8:00 AM (saliendo de CST) o
   7:00 AM (saliendo de CDT). */
function chicagoOffsetHours(utcDate) {
  const year = utcDate.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, nthSundayUTC(year, 2, 2), 8, 0, 0));
  const dstEnd = new Date(Date.UTC(year, 10, nthSundayUTC(year, 10, 1), 7, 0, 0));
  return (utcDate >= dstStart && utcDate < dstEnd) ? -5 : -6;
}

function chicagoParts(d) {
  const shifted = new Date(d.getTime() + chicagoOffsetHours(d) * 3600000);
  let h = shifted.getUTCHours();
  const dayPeriod = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return {
    month: String(shifted.getUTCMonth() + 1),
    day: String(shifted.getUTCDate()),
    year: String(shifted.getUTCFullYear()),
    hour: String(h),
    minute: String(shifted.getUTCMinutes()).padStart(2, '0'),
    dayPeriod: dayPeriod
  };
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

/* '06:00' (24h, como lo guarda EntryTime) -> '6:00 AM'. Mismo
   formateador que ya se agrego en gsocd-shared/order-history.js
   (fmtTime24), repetido aqui porque este archivo es Node, no
   navegador -- no puede requerir ese componente. */
function fmtTime24(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return String(t || '');
  const h = parseInt(m[1], 10), min = m[2];
  const period = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + min + ' ' + period;
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
/* BUG REAL encontrado y arreglado (20/09/2026, reportado por el
   dueño): un servicio de cantidad (puertas, ventanas, persianas,
   etc.) siempre salia con un guion en el PDF -- solo revisaba Level,
   nunca Quantity. Mismo criterio que svcSubLabel() ya usa en
   customer.html/tracking.html/order-history.js. */
function svcOptionLabel(s) {
  const sub = clean(s.SubOption);
  if (isSkuFormat(sub)) {
    const lvl = clean(s.Level);
    if (lvl) return lvl;
    const qty = clean(s.Quantity != null ? s.Quantity : s.quantity);
    return qty ? 'Qty: ' + qty : '-';
  }
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
/* Busca el registro COMPLETO del cliente en la lista Clients, por
   ClientID -- a peticion del dueño (19/09/2026, con captura marcada
   y varios mensajes seguidos: "el nombre, direccion, telefono y
   contacto del cliente... esta vacio").

   BUG REAL encontrado revisando register-client.js linea por linea
   (el esquema real de Clients, con nombres de campo confusos):
     - Title        = nombre del NEGOCIO
     - ClientName   = nombre de la PERSONA de contacto (a pesar del
                       nombre del campo -- asi se decidio, no es que
                       yo lo haya inventado)
     - Contact      = EMAIL (no el nombre -- otro campo con nombre
                       enganoso)
     - Phone, Address, Suite, City, Zip = lo que dicen ser

   order.Contact (que es lo que yo leia antes para el nombre de la
   persona) NUNCA se escribe en NINGUN lado del sistema -- se
   confirmo buscando "Contact:" en submit-order.js, admin-update-
   order.js y admin-approve-order.js, cero resultados. Por eso
   siempre salia vacio, para CUALQUIER orden, sin excepcion -- no
   era un dato faltante de esa orden en particular, era un campo que
   nunca se llena.

   order.Address/City/Zip SI se copian a la orden en algunos flujos
   de submit-order.js, pero no en todos (depende del tipo de orden) --
   Clients es la fuente real y siempre disponible, asi que ahora se
   usa esa en vez de confiar en que la orden traiga su propia copia.

   Si el cliente no existe, o algun campo no esta guardado, esos
   campos regresan '' -- no truena, simplemente no se muestra eso de
   mas. NUNCA lanza hacia arriba (mismo patron que fetchLogoBuffer). */
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

/* Busca el telefono del tecnico asignado en FieldEmployees, cruzando
   por nombre completo -- mismo patron que ya usa findTechPhoneByName
   en admin.html (ahi cruza contra un cache en el navegador; aqui no
   hay cache, se pide fresco cada vez). El campo de la orden se llama
   'Supervisor' mismo que en el resto del sistema (asi vive en
   SharePoint) -- a peticion del dueño (19/09/2026: "no debe tener el
   nombre del supervisor, debe tener el nombre del tecnico asignado...
   y su telefono tambien") esto es conceptualmente el tecnico de campo
   asignado a hacer la limpieza, asi que en el documento se etiqueta
   'Technician', no 'Supervisor' -- el VALOR (order.Supervisor) es el
   mismo dato, solo cambia como se le llama en el papel. Si no se
   encuentra, o no tiene telefono guardado, regresa '' -- no truena. */
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

function renderClientSection(doc, order, includeContact) {
  const GRAY = [0.42, 0.42, 0.42];
  /* A peticion del dueño (19/09/2026, con captura marcada -- la
     flecha apuntaba de "Client ID: GS-1001" HACIA ARRIBA, al
     encabezado "CLIENT" mismo, no solo "mas arriba dentro del
     bloque" como lo entendi la primera vez): el ID va PEGADO al
     encabezado de la seccion ("CLIENT — GS-1001"), no como su propio
     renglon dentro del cuerpo. */
  doc.h2('Client' + (clean(order.ClientID) ? ' — ' + clean(order.ClientID) : ''));
  const startY = doc.y;
  /* A peticion del dueño (19/09/2026): mismo estilo que el bloque de
     GS Solutions al lado -- nombre del negocio en negritas como
     encabezado, y debajo lineas simples (sin "Business:"/"Address:"),
     en vez del formato anterior de una etiqueta por renglon.

     BUG REAL encontrado (19/09/2026, revisando register-client.js
     linea por linea): el nombre de la persona de contacto NUNCA vino
     de order.Contact -- ese campo nunca se escribe en ningun lado del
     sistema, siempre esta vacio. El nombre real vive en Clients,
     campo ClientName (nombre confuso, pero asi se decidio) --
     buscado por ClientID en generateAndSaveOrderPdf/Completion/
     RequestPdf, adjunto como order.ClientContactName antes de llegar
     aqui. Direccion: se prefiere la de la ORDEN (order.Address/City/
     Zip) si la tiene -- puede ser una propiedad especifica distinta
     a la direccion por defecto del cliente -- y solo si la orden no
     trae nada, cae de vuelta a la direccion del cliente en Clients
     (order.ClientAddress/City/Zip, mismo lookup). El telefono del
     cliente (campo 'Phone' en Clients) se pega junto al nombre del
     contacto, mismo patron "Nombre · Telefono" que ya se usa en
     otros lados de la app para el tecnico asignado. */
  /* Una sola fuente COMPLETA para la direccion (orden o cliente), no
     mezclar campos sueltos de las 2 -- si la orden trae algo de
     direccion propia, se usa esa completa; si no trae nada, se cae
     completa a la del cliente. */
  const orderHasAddr = clean(order.Address) || clean(order.City) || clean(order.Zip);
  const addrSrc = orderHasAddr
    ? { address: order.Address, suite: order.Suite, city: order.City, zip: order.Zip }
    : { address: order.ClientAddress, suite: order.ClientSuite, city: order.ClientCity, zip: order.ClientZip };
  const suite = clean(addrSrc.suite);
  const addrLine1 = [clean(addrSrc.address), suite ? 'Suite ' + suite : ''].filter(Boolean).join(', ');
  const addrLine2 = [clean(addrSrc.city), clean(addrSrc.zip)].filter(Boolean).join(', ');
  const contact = clean(order.Contact) || clean(order.ClientContactName);
  const phone = clean(order.ClientPhone);

  /* Client ID ya va en el encabezado de la seccion (arriba). El
     correo (order.ClientEmail, campo 'Contact' en Clients -- mismo
     nombre confuso que ya causo el bug del nombre de la persona) se
     agrega al final, como ya tiene GS Solutions. */
  const email = clean(order.ClientEmail);
  const lines = [clean(order.BusinessName) || clean(order.Title) || 'Client'];
  if (includeContact && contact) lines.push(contact + (phone ? ' · ' + phone : ''));
  if (addrLine1) lines.push(addrLine1);
  if (addrLine2) lines.push(addrLine2);
  if (includeContact && email) lines.push(email);
  lines.forEach((ln, i) => doc.text(ln, { size: 10, bold: i === 0 }));

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
/* A peticion del dueño (20/09/2026, con captura real): 'Expected
   Ready Date' y 'Materials Ready' son 2 llamadas separadas al
   backend, pero para el cliente es UNA sola accion -- deben salir
   como UN SOLO renglon de la tabla, no 2 aparte. Mismo criterio que
   gsocd-shared/order-history.js (mergeMaterialsReadyWithDate,
   v1.37.0), repetido aqui porque este archivo es Node y no puede
   requerir ese componente de navegador. En CUALQUIER orden (fecha u
   hora primero). */
const READY_GROUP_WINDOW_MS = 60000;
function mergeMaterialsReadyRows(history) {
  const out = [];
  (history || []).forEach(h => {
    const last = out[out.length - 1];
    const type = clean(h.ChangeType);
    const lastType = last && clean(last.ChangeType);
    const isPair = (type === 'Materials Ready' && lastType === 'Expected Ready Date') ||
      (type === 'Expected Ready Date' && lastType === 'Materials Ready');
    const sameActor = last && clean(last.ChangedBy) === clean(h.ChangedBy);
    const closeInTime = last && Math.abs(new Date(h.ChangeDate) - new Date(last.ChangeDate)) < READY_GROUP_WINDOW_MS;
    if (isPair && sameActor && closeInTime) {
      const rep = type === 'Materials Ready' ? h : (lastType === 'Materials Ready' ? last : h);
      const pair = (last._mergedPair || [last]).concat(h);
      out[out.length - 1] = Object.assign({}, rep, { _mergedPair: pair });
      return;
    }
    out.push(h);
  });
  return out;
}

/* "Assign by service" (25/09/2026, pedido del dueño): programar la
   orden es UN solo evento aunque se reparta entre varias personas y
   dias. Mismo criterio que mergeServiceScheduled de order-history.js
   (gsocd-shared), repetido aqui porque este archivo es Node: los
   'Service Scheduled' seguidos del mismo quien (max 30 min entre uno y
   otro, sin otro evento en medio) quedan en un renglon, y el 'Order
   Moved To Active' de esa tanda se absorbe. Los completados siguen
   saliendo cada uno por su lado. */
const SVC_BATCH_GAP_MS = 30 * 60000;
const SVC_BATCH_PASSTHRU = ['Service Now Active', 'Service Needs Scheduling'];
function svcSchedOf(h) {
  if (clean(h.ChangeType) !== 'Service Scheduled') return null;
  try { const v = JSON.parse(h.NewValue || 'null'); return v && v.serviceName ? v : null; } catch (e) { return null; }
}
function mergeServiceScheduledRows(history) {
  const rows = history || [];
  const tOf = h => new Date(h.ChangeDate).getTime();
  const out = [], used = {};
  for (let i = 0; i < rows.length; i++) {
    if (used[i]) continue;
    const h = rows[i], v = svcSchedOf(h);
    const absorbable = clean(h.ChangeType) === 'Order Moved To Active';
    if (!v && !absorbable) { out.push(h); continue; }
    const by = clean(h.ChangedBy);
    let tLast = tOf(h);
    const sched = v ? [{ h, v }] : [], after = [], took = [];
    for (let j = i + 1; j < rows.length; j++) {
      if (used[j]) continue;
      const r = rows[j], type = clean(r.ChangeType);
      if (Math.abs(tOf(r) - tLast) > SVC_BATCH_GAP_MS) break;
      const w = svcSchedOf(r);
      if (w && clean(r.ChangedBy) === by) { sched.push({ h: r, v: w }); took.push(j); tLast = tOf(r); continue; }
      if (type === 'Order Moved To Active') { took.push(j); tLast = tOf(r); continue; }
      if (!w && SVC_BATCH_PASSTHRU.indexOf(type) !== -1) { after.push(r); took.push(j); continue; }
      break;
    }
    if (!sched.length) { out.push(h); continue; }
    took.forEach(k => { used[k] = true; });
    sched.sort((a, b) => tOf(a.h) - tOf(b.h));
    const last = {};
    sched.forEach(s => { last[s.v.serviceName] = s.v; });
    const finals = sched.filter(s => last[s.v.serviceName] === s.v);
    if (finals.length === 1) out.push(finals[0].h);
    else {
      const groups = [], byKey = {};
      finals.forEach(s => {
        const key = clean(s.v.assigned) + '|' + clean(s.v.date);
        if (!byKey[key]) { byKey[key] = { assigned: s.v.assigned, date: s.v.date, services: [] }; groups.push(byKey[key]); }
        byKey[key].services.push(s.v.serviceName);
      });
      out.push(Object.assign({}, sched[0].h, { _svcBatch: groups }));
    }
    after.forEach(r => out.push(r));
  }
  return out;
}

function renderChangeHistory(doc, history) {
  const GRAY = [0.42, 0.42, 0.42];
  const ALWAYS_HIDDEN = ['Document Generated', 'Document Failed', 'Archived', 'Batch Created'];
  const NOISY_IF_EMPTY = ['Order Assigned', 'Order Approved', 'Change Rejected',
    'Change Request Cancelled', 'Materials Ready Seen', 'Completed'];
  doc.h2('Change History');
  const histRows = mergeMaterialsReadyRows(mergeServiceScheduledRows(history))
    .filter(h => ALWAYS_HIDDEN.indexOf(clean(h.ChangeType)) === -1)
    .map(h => ({ h, detail: historyDetailLine(h) }))
    .filter(e => !(NOISY_IF_EMPTY.indexOf(clean(e.h.ChangeType)) !== -1 && !e.detail));
  if (!histRows.length) {
    doc.text('No history recorded.', { size: 9.5, color: GRAY });
  } else {
    const rows = histRows.map(e => [
      fmtDateTime(e.h.ChangeDate || e.h.createdDateTime),
      e.h._svcBatch ? 'Services Scheduled' : clean(e.h.ChangeType),
      clean(e.h.ChangedBy),
      e.detail
    ]);
    doc.table(['Date', 'Event', 'By', 'Detail'], rows, [0.23, 0.17, 0.14, 0.46], { padY: 14 });
  }
}

/* Tabla de "Services" completa -- misma pieza para el documento de la
   orden Y el de solicitud (Review). A peticion del dueño (19/09/2026,
   "pero sí está en el shared ¿verdad?" -- despues de que Review
   terminara con su propia estructura vieja, sin tabla de Services en
   absoluto, por no reusar esta logica). Muestra la lista ORIGINAL de
   la orden (el primer 'Services' del historial) MAS lo que se agrego
   despues, todo en UNA tabla -- un servicio quitado se queda con
   Result='Removed', uno agregado con Result='Added'. */
function renderServicesTable(doc, order, services, history, serviceAssignments) {
  const GRAY = [0.42, 0.42, 0.42];
  doc.h2('Services');
  /* Orden vieja (antes del 24/09/2026) con un paquete guardado como
     servicio: en la lista "original" el paquete se cambia por lo que
     incluia (Orders.PackageContents), para que no salga como un
     servicio quitado junto a sus propios servicios. */
  const originalServices = splitPackagesWithSnapshot(findOriginalServices(history) || services, order);
  if (!originalServices.length && !services.length) {
    doc.text('No services recorded on this order.', { size: 9.5, color: GRAY });
    return;
  }
  const orderStatus = clean(order.Status);
  const currentByKey = {};
  services.forEach(s => { currentByKey[serviceKey(s)] = s; });
  const originalByKey = {};
  originalServices.forEach(s => { originalByKey[serviceKey(s)] = s; });
  /* "Assign by service" -- estatus real por servicio (Not started/
     Scheduled/Pending office confirmation/Completed), en vez del
     estatus de TODA la orden (que en este modelo siempre dice lo
     mismo para todos, sin importar en que va cada uno de verdad). */
  const isAssignByService = order.AssignByService === true || order.AssignByService === 'true';
  const svcAssignByKey = {};
  (serviceAssignments || []).forEach(a => { svcAssignByKey[a.Category + '|' + a.ServiceName] = a; });

  /* BUG REAL encontrado con una orden real (GS-1032-1001, 20/09/2026,
     confirmado con el dueño): un servicio agregado durante la orden
     (via Services Updated, Change Requested, etc.) se quedaba con
     Result='Added' PARA SIEMPRE, incluso despues de que la orden se
     completara -- 'Added' se checaba ANTES que Completed/Cancelled,
     asi que esos 2 nunca se alcanzaban para un servicio que no estaba
     en la lista original. Primer arreglo (20/09/2026): el estatus
     FINAL de la orden (o NotCompleted) siempre gana sin importar si
     el servicio es original o se agrego despues.

     SEGUNDO ARREGLO, mismo dia, reportado por el dueno con una orden
     real (GS-1001-1002): 'Added' TAMBIEN se quedaba de mas mientras
     la orden seguia activa (Assigned/Scheduled) -- un carpet shampoo
     agregado y YA aplicado (la orden ya paso por Mark as Seen/
     Reassign) seguia diciendo "Added" en vez de "Scheduled" como los
     demas servicios, aunque ya no hubiera nada pendiente. Confirmado
     con el dueno: 'Added' no debe verse en esta tabla en NINGUN caso
     -- ya queda registrado en Change History ("Services Updated:
     Added ..."), no hace falta repetirlo aqui. Un servicio agregado
     que ya esta en la lista real de la orden se trata IGUAL que uno
     original: sigue el mismo estatus (Scheduled/Completed/Cancelled/
     NOT COMPLETED) que todos los demas. */
  const rowFor = s => {
    const key = serviceKey(s);
    const live = currentByKey[key];
    let status;
    if (!live) {
      status = 'Removed';
    } else if (String(live.NotCompleted) === 'true' || live.NotCompleted === true) {
      status = 'NOT COMPLETED';
      const why = clean(live.NotCompletedReason);
      if (why) status += ' - ' + why;
    } else if (orderStatus === 'Cancelled') {
      status = 'Cancelled';
    } else if (isAssignByService) {
      /* BUG REAL reportado por el dueño con una orden real
         (GS-1032-1005): los 2 servicios se veian "Scheduled" por
         igual aunque uno YA estaba Completed de verdad -- este
         bloque nunca revisaba ServiceAssignments para nada. */
      const a = svcAssignByKey[clean(s.Category) + '|' + clean(s.ServiceName)];
      if (a && a.WorkStatus === 'Completed') status = 'Completed';
      else if (a && a.WorkStatus === 'Pending Review') status = 'Pending office confirmation';
      else if (a) status = 'Scheduled';
      else status = 'Not started';
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

function buildOrderPdf(data) {
  const order = data.order || {};
  const services = data.services || [];
  const history = data.history || [];
  const photos = data.photos || [];
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
      /* A peticion del dueño (19/09/2026: "no debe tener el nombre
         del supervisor, debe tener el nombre del tecnico asignado a
         hacer la limpieza y su telefono tambien") -- el campo de
         SharePoint se sigue llamando 'Supervisor' (mismo dato de
         siempre), pero en el papel se etiqueta 'Technician' -- es
         conceptualmente el tecnico de campo asignado. El telefono
         (buscado en FieldEmployees por findTechPhoneByName, en
         generateAndSaveOrderPdf) se pega igual que el del cliente. */
      ['Technician', clean(order.Supervisor) + (clean(order.TechnicianPhone) ? ' · ' + clean(order.TechnicianPhone) : '')],
      /* A peticion del dueño (19/09/2026): SOLO la fecha del servicio
         (DispatchDate) -- ya no Submitted/Entry Date/Due Date. Si la
         orden no tiene DispatchDate, el campo se queda vacio ('-',
         mismo comportamiento que ya tenia kv2col para cualquier valor
         ausente) -- sin caer a ninguna otra fecha en su lugar. */
      ['Service Date', fmtDate(order.DispatchDate)],
      ['Service Window', clean(order.ServiceWindow)]
    ]
  );

  renderServicesTable(doc, order, services, history, data.serviceAssignments);

  /* --- Fotos --- (a peticion del dueño, 19/09/2026: "si le pusiste
     que las que tengan foto tambien impriman las fotos, eso debe ser
     en cualquier orden en cualquier estatus, no solo en el de
     history") -- antes las fotos SOLO salian en el documento de
     Completion (buildCompletionPdf), que solo se genera cuando el
     estatus ya es Completed. Una orden que apenas va a la mitad
     (Assigned, por ejemplo) pero que ya tiene fotos subidas se
     quedaba sin mostrarlas para nada en el documento normal. Aqui SI
     se salta la seccion por completo cuando no hay ninguna foto --
     a diferencia de Completion (donde "sin fotos" es informacion en
     si misma, porque el trabajo ya se dio por terminado), en una
     orden a medias no tener fotos todavia es el estado normal, no
     vale la pena un renglon de "No photos" para eso. */
  if (photos.length) {
    doc.h2('Photos (' + photos.length + ')');
    doc.photoGrid(photos, { cols: 3, cellH: 165 });
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

/* "Assign by service" (21/09/2026) -- BUG REAL encontrado con una
   orden real (GS-1032-1005, reportado por el dueño: "los eventos de
   cada servicio que se asigno individual, si se deben de ver los
   detalles"): confirmado con esa misma orden, Detail salia
   completamente en blanco para Service Scheduled/Order Moved To
   Active/Service Completed/etc. -- el arreglo original se habia hecho
   en el orderpdf.js de la raiz, un archivo que NADIE usa de verdad
   (los 3 puntos de entrada reales -- admin-approve-order.js,
   admin-update-order.js, get-order-document.js -- requieren este
   archivo, lib/orderpdf.js). Mismos 9+ ChangeType reales que ya sabe
   resumir order-history.js (gsocd-shared), aqui repetidos en texto
   plano porque este archivo es Node puro, sin navegador. */
const PER_SERVICE_TYPES = ['Service Scheduled', 'Order Moved To Active', 'Service Marked Done By Tech',
  'Service Completed', 'Service Now Active', 'Service Needs Scheduling', 'Service Order Changed',
  'Service Added', 'Service Removed', 'Service Change Requested', 'Service Change Resolved'];
function perServiceDetailLine(h) {
  const type = clean(h.ChangeType);
  /* BUG REAL encontrado con la orden real GS-1032-1005 (Detail salia
     en blanco): 'Order Moved To Active' nunca trae NewValue (ver
     save-service-assignment.js) -- no necesita ningun dato, pero el
     "if (!p) return ''" de aqui abajo cortaba ANTES de llegar a
     revisar cual ChangeType es, asi que nunca alcanzaba su propio
     texto fijo. Se revisa este caso primero, sin depender de p. */
  if (type === 'Order Moved To Active') return 'Order moved to Active (first service scheduled)';
  let p = null;
  try { p = JSON.parse(h.NewValue || 'null'); } catch (e) { return ''; }
  if (!p) return '';
  if (type === 'Service Scheduled') return clean(p.serviceName) + ' scheduled with ' + clean(p.assigned) + ' on ' + fmtDate(p.date);
  if (type === 'Service Marked Done By Tech') return clean(p.serviceName) + ' marked done by the technician, waiting on office to confirm';
  if (type === 'Service Completed') {
    let line = clean(p.serviceName) + ' completed by ' + clean(p.completedBy) + ' on ' + fmtDateTime(p.finishedText);
    if (p.confirmedNote) line += ' (' + clean(p.confirmedNote) + ')';
    return line;
  }
  if (type === 'Service Now Active') return clean(p.serviceName) + ' is now the active service (already scheduled: ' + clean(p.assigned) + ', ' + fmtDate(p.date) + ')';
  if (type === 'Service Needs Scheduling') return clean(p.serviceName) + ' needs to be scheduled before work can continue';
  if (type === 'Service Order Changed') return 'Queue reordered: ' + (p.order || []).map(clean).join(' -> ');
  if (type === 'Service Added') return clean(p.serviceName) + ' added to the order';
  if (type === 'Service Removed') return clean(p.serviceName) + ' removed from the order';
  if (type === 'Service Change Requested') {
    const sub = clean(h.FieldChanged);
    return 'Client requested to ' + (sub === 'Add' ? 'add' : sub === 'Remove' ? 'remove' : 'modify') + ' ' + clean(p.serviceName);
  }
  if (type === 'Service Change Resolved') return 'Change request resolved for ' + clean(p.serviceName);
  return '';
}

/* Resume un renglon del historial en una linea legible.
   Misma logica que el panel del admin, pero en texto plano. */
function historyDetailLine(h) {
  if (h._svcBatch) {
    return h._svcBatch.map(g => clean(g.assigned) + (g.date ? ' on ' + fmtDate(g.date) : '') + ': ' + g.services.map(clean).join(', ')).join('\n');
  }
  /* _mergedPair (ver mergeMaterialsReadyRows mas abajo): 2 renglones
     crudos fusionados en uno -- se calcula el detalle de cada uno por
     su cuenta y se juntan en un solo bloque, mismo patron que ya usa
     este archivo para "Created" (varias lineas con \n real). */
  if (h._mergedPair) {
    return h._mergedPair.map(row => historyDetailLine(row)).filter(Boolean).join('\n');
  }

  const rawNotes = clean(h.Notes);
  const notes = isGenericDecisionNote(rawNotes) ? '' : rawNotes;
  const field = clean(h.FieldChanged);
  const oldV = clean(h.OldValue);
  const newV = clean(h.NewValue);
  const changeType = clean(h.ChangeType);

  if (PER_SERVICE_TYPES.indexOf(changeType) !== -1) {
    return perServiceDetailLine(h) || notes || '';
  }

  /* BUG REAL arreglado (20/09/2026, reportado por el dueño con
     captura real): Notes se dejo vacio a proposito en
     save-expected-ready-date.js/set-materials-ready.js desde que
     NewValue trae el dato real (para el formato bonito en la app,
     gsocd-shared v1.38.0) -- sin este caso dedicado, este renglon se
     imprimia con el Detail EN BLANCO en el PDF (regresion real, no
     intencional). */
  if (changeType === 'Expected Ready Date') {
    return newV ? ('Ready date: ' + fmtDate(newV)) : (notes || '');
  }
  if (changeType === 'Materials Ready') {
    return newV ? ('Ready for entry at: ' + fmtTime24(newV)) : (notes || '');
  }

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

/* Mismo criterio que svcOptionLabel() -- ver su comentario arriba. */
function serviceLabel(s) {
  const name = clean(s.ServiceName || s.service || s.name);
  const sub = clean(s.SubOption || s.subOption || s.option);
  let opt = '';
  if (isSkuFormat(sub)) {
    opt = clean(s.Level || s.level);
    if (!opt) {
      const qty = clean(s.Quantity != null ? s.Quantity : s.quantity);
      if (qty) opt = 'Qty: ' + qty;
    }
  } else {
    opt = sub;
  }
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
function splitPackagesWithSnapshot(list, order) {
  let snap = {};
  try { snap = JSON.parse((order && order.PackageContents) || '{}') || {}; } catch (e) { snap = {}; }
  if (!Object.keys(snap).length) return list;
  const out = [], seen = {};
  (list || []).forEach(s => {
    const items = snap[String(s.SubOption || '').trim()];
    if (!Array.isArray(items) || !items.length) { out.push(s); return; }
    items.forEach(x => {
      if (!x || !x.sku || seen[x.sku]) return;
      seen[x.sku] = 1;
      out.push({ Category: s.Category || '', ServiceName: x.serviceName || x.sku, SubOption: x.sku, Division: s.Division || '', Level: x.level || '' });
    });
  });
  return out;
}

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
      /* BUG REAL arreglado (20/09/2026, ver el comentario completo en
         svcOptionLabel arriba): esta comparacion solo revisaba Level
         -- un cambio de SOLO cantidad (ej. puertas de 4 a 6) nunca
         aparecia en el 'Change History' del PDF. */
      const subA = clean(mapA[k].SubOption || mapA[k].subOption || mapA[k].option);
      const subB = clean(mapB[k].SubOption || mapB[k].subOption || mapB[k].option);
      const optOf = (sub, s) => {
        if (!isSkuFormat(sub)) return sub;
        const lvl = clean(s.Level || s.level);
        if (lvl) return lvl;
        const qty = clean(s.Quantity != null ? s.Quantity : s.quantity);
        return qty ? 'Qty: ' + qty : '';
      };
      const o = optOf(subA, mapA[k]);
      const n = optOf(subB, mapB[k]);
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
  /* 25/09/2026: solo imagenes. Antes bajaba TODO lo de la carpeta,
     videos incluidos (MB y MB) -- con un video la funcion se pasaba de
     tiempo y el Print de Completed daba error. Los videos se ven en la
     galeria, no caben en un PDF. */
  const isImage = n => /\.(jpe?g|png|heic|heif)$/i.test(n || '');
  const files = kids.filter(k => k.isFile && isImage(k.name) && !(k.size > 15 * 1024 * 1024))
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
      out.push({ buffer, caption: f.name, stage: /^insp-/i.test(f.name) ? 'inspection' : 'work' });
    } catch (e) { /* una foto que no baja se omite */ }
  }
  return out;
}

/* ===== Documento de Completacion (con fotos) ===== */

function buildCompletionPdf(data) {
  const order = data.order || {};
  const services = data.services || [];
  const history = data.history || [];
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

  /* A peticion del dueño (19/09/2026, con captura marcada: "toda esa
     informacion se debe popular en cualquier PDF que vayas a imprimir
     al dar clic en Print, desde cualquier lado -- lo que va a cambiar
     es el estatus, dependiendo desde donde se haga clic"):
     includeContact=true -- antes era false, por eso el Contact (y su
     telefono) nunca salian aqui, sin importar que si estuvieran
     guardados. */
  renderClientSection(doc, order, true);

  doc.h2('Completion');
  doc.kv2col([
    ['Completed by', clean(data.completedBy)],
    ['Completed on', fmtDateTime(data.completedAt || new Date().toISOString())],
    ['Technician', clean(order.Supervisor) + (clean(order.TechnicianPhone) ? ' · ' + clean(order.TechnicianPhone) : '')],
    ['Service Date', fmtDate(order.DispatchDate)]
  ]);

  /* Services y Change History unificados con el resto de los
     documentos (renderServicesTable/renderChangeHistory, compartidas)
     -- antes esta funcion tenia su propia logica de Services aparte
     (sin original/Added/Removed) y ni siquiera tenia Change History. */
  renderServicesTable(doc, order, services, history, data.serviceAssignments);

  /* Antes / despues (25/09/2026): si hubo inspeccion, sus fotos van en
     su propia seccion antes de las del trabajo. */
  const inspPhotos = photos.filter(p => p.stage === 'inspection');
  const workPhotos = photos.filter(p => p.stage !== 'inspection');
  if (inspPhotos.length) {
    doc.h2('Inspection photos — before (' + inspPhotos.length + ')');
    doc.photoGrid(inspPhotos, { cols: 3, cellH: 165 });
  }
  doc.h2((inspPhotos.length ? 'Work photos — after' : 'Photos') + (workPhotos.length ? ' (' + workPhotos.length + ')' : ''));
  if (!workPhotos.length) {
    doc.text('No photos were taken on this order.', { size: 9.5, color: GRAY });
  } else {
    doc.photoGrid(workPhotos, { cols: 3, cellH: 165 });
  }

  renderChangeHistory(doc, history);

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

/* ===== Documento de Solicitud (constancia de lo pedido en Review) ===== */

function buildRequestPdf(data) {
  const order = data.order || {};
  const req = data.request || {};
  const history = data.history || [];
  const services = data.services || [];
  const photos = data.photos || [];
  const revision = data.revision || 1;
  const orderId = clean(order.OrderID) || 'ORDER';
  const isCancel = clean(req.ChangeType) === 'Cancellation Requested';
  const kindLabel = isCancel ? 'Cancellation Request' : 'Change Request';

  const doc = new PdfDoc();
  if (data.logoBuffer) doc.setWatermark(data.logoBuffer);

  /* A peticion del dueño (19/09/2026, con captura marcada): la linea
     de "Request record N | Issued [fecha]" ya no va aqui debajo del
     titulo -- se mueve a las esquinas inferiores del pie de pagina
     (ver doc.end() al final de esta funcion). */
  doc.h1(kindLabel + ' — ' + orderId);
  doc.gap(4);
  doc.rule([0.788, 0.659, 0.298], 1.4);

  /* A peticion del dueño (19/09/2026, con captura marcada): toda la
     informacion debe salir en CUALQUIER documento que se imprima --
     includeContact=true, igual que en buildOrderPdf/buildCompletionPdf. */
  renderClientSection(doc, order, true);

  /* A peticion del dueño (19/09/2026: "¿pero sí está en el shared,
     verdad?" -- tras encontrar que este documento tenia su propia
     estructura vieja, sin tabla de Services en absoluto): misma
     forma que el documento de la orden -- Order Details en 2
     columnas (lugar / quien y cuando pidio el cambio), tabla de
     Services compartida (renderServicesTable), Change History
     compartido (renderChangeHistory). Ya no hay secciones
     "Request"/"Requested change"/"Order at the time of this
     request" por separado -- ese detalle ya vive en la tabla de
     Services (que cambio) y en Change History (quien, cuando, que). */
  const unit = [
    clean(order.BuildingNumber) ? 'Building ' + clean(order.BuildingNumber) : '',
    clean(order.UnitNumber) ? 'Unit ' + clean(order.UnitNumber) : '',
    clean(order.Bedrooms) ? clean(order.Bedrooms) + ' bed' : '',
    clean(order.Bathrooms) ? clean(order.Bathrooms) + ' bath' : ''
  ].filter(Boolean).join('   ');
  doc.h2('Order Details');
  doc.kv2colGroups(
    [
      ['Division', clean(order.Division)],
      ['Unit', unit],
      ['Dirt Level', clean(order.DirtLevel)]
    ].filter(p => p[0] !== 'Unit' || unit),
    [
      ['Status', clean(order.Status)],
      ['Technician', clean(order.Supervisor) + (clean(order.TechnicianPhone) ? ' · ' + clean(order.TechnicianPhone) : '')],
      ['Requested by', clean(req.ChangedBy) || (data.origin === 'office' ? 'GS Solutions staff' : 'Client')],
      ['Requested on', fmtDateTime(req.ChangeDate)]
    ]
  );

  if (isCancel) {
    doc.gap(4);
    doc.text('The client requested this order be cancelled.', { size: 9.5 });
  }

  renderServicesTable(doc, order, services, history, data.serviceAssignments);

  if (photos.length) {
    doc.h2('Photos (' + photos.length + ')');
    doc.photoGrid(photos, { cols: 3, cellH: 165 });
  }

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
