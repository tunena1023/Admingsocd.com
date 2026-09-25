/* admin-get-orders.js — todas las órdenes (sin filtro de cliente) */
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, CLIENTS_LIST, CLIENT_ADDRESSES_LIST,
  HOLIDAYS_LIST, CLIENT_HOLIDAYS_LIST, SERVICE_ASSIGNMENTS_LIST, ORDER_SEEN_BY_LIST,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');
/* HOTFIX 22/09/2026: se copia la funcion aqui en vez de traerla de
   gsocd-shared/lib/seen-tracking -- esa dependencia via npm/git
   tumbo TODO el backend de Admin en produccion ("Cannot find module",
   probablemente cache vieja de node_modules en el build de Vercel,
   sin lockfile de por medio que lo detecte). Es la MISMA logica
   exacta, solo que sin el riesgo de que un modulo externo no
   resuelva en build y tire abajo funciones que ni siquiera la usan
   (comparten el mismo proceso api/[...slug].js). Confirmado con el
   dueño: prioridad total a la estabilidad, estamos por entrar a
   pruebas. */
function isUnseen(seenAt, lastModifiedDateTime) {
  if (!lastModifiedDateTime) return false;
  if (!seenAt) return true;
  const seenMs = new Date(seenAt).getTime();
  const modMs = new Date(lastModifiedDateTime).getTime();
  if (isNaN(seenMs) || isNaN(modMs)) return false;
  return seenMs < modMs;
}
function unseenIds(entities, seenMap, idField) {
  const field = idField || 'OrderID';
  const out = new Set();
  (entities || []).forEach(function (e) {
    const id = e && e[field];
    if (id && isUnseen((seenMap || {})[id], e.lastModifiedDateTime)) out.add(id);
  });
  return out;
}

/* Todos los renglones de OrderSeenBy de ESTE viewer -- no esta
   indexada por columna (lista nueva), mismo header que ya usa
   get-order-detail.js para ServiceAssignments. Si viewerId viene
   vacio (llamada vieja sin actualizar, o algo fallo del lado del
   frontend), regresa vacio y ninguna orden se marca -- nunca truena
   la carga completa por esto. */
async function fetchSeenMap(viewerId) {
  if (!viewerId) return {};
  const filter = encodeURIComponent(`fields/ViewerId eq '${viewerId}'`);
  const map = {};
  let url = siteListPath(ORDER_SEEN_BY_LIST) + `?$expand=fields&$top=200&$filter=${filter}`;
  const opts = { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } };
  while (url) {
    const data = await graphFetch(url, opts);
    (data.value || []).forEach(it => { map[it.fields.OrderID] = it.fields.SeenAt; });
    url = data['@odata.nextLink'] || null;
  }
  return map;
}

/* Velocidad (25/09/2026). scope:
     'all'    (default, como siempre) -- todas las ordenes.
     'live'   -- todo menos Completed y Cancelled ya archivadas. Es lo que
                 pide Admin al abrir y en la revision de cada 30 s. Incluye
                 tambien las cerradas que comparten BatchId con una viva,
                 para que el agrupado por serie salga igual que antes.
     'closed' -- Completed y Cancelled (History / QuickBooks), se piden
                 una vez en segundo plano.
   Servicios y asignaciones por servicio se piden solo de esas ordenes.
   lib/list-query.js cae sola a la lista completa si un filtro falla. */
const lq = require('./lib/list-query');
const isClosed = f => f.Status === 'Completed' || (f.Status === 'Cancelled' && (f.Archived === true || f.Archived === 'true'));

async function ordersForScope(scope) {
  if (scope === 'closed') {
    const c = lq.statusIn(['Completed', 'Cancelled']);
    return lq.fetchWhere(ORDERS_LIST, c.filter, c.test);
  }
  if (scope === 'live') {
    const rows = (await lq.fetchWhere(ORDERS_LIST, "fields/Status ne 'Completed'", f => f.Status !== 'Completed'))
      .filter(it => it.fields && !isClosed(it.fields));
    const batchIds = [...new Set(rows.map(it => it.fields.BatchId).filter(Boolean))];
    if (batchIds.length) {
      const have = new Set(rows.map(it => it.id));
      (await lq.fetchByValues(ORDERS_LIST, 'BatchId', batchIds)).forEach(it => { if (!have.has(it.id)) { have.add(it.id); rows.push(it); } });
    }
    return rows;
  }
  return lq.fetchAll(ORDERS_LIST);
}

function truthy(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes'; }

async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/* ===== "Now Open" -- confirmado con el usuario: debe seguir la orden
   igual que cualquier parte del historial, con el estatus REAL del
   momento (si hoy es sabado y ese dia esta cerrado, sale cerrado; si
   es lunes y esta abierto, sale abierto) -- para no tener que
   buscarlo aparte en Maps. Cruza el horario semanal normal CON las
   elecciones de Holidays (si hoy es un festivo que el cliente eligio,
   esa eleccion gana sobre el horario semanal de siempre). ===== */
const DAY_KEYS = ['sunOpen', 'monOpen', 'tueOpen', 'wedOpen', 'thuOpen', 'friOpen', 'satOpen'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function computeHolidayDate(h, year) {
  if (h.RuleType === 'Fixed') return new Date(Date.UTC(year, (h.Month || 1) - 1, h.Day || 1, 12));
  const month = (h.Month || 1) - 1, weekday = h.Weekday || 0, nth = h.Nth || 1;
  if (nth === 5) {
    const lastOfMonth = new Date(Date.UTC(year, month + 1, 0, 12));
    const diff = (lastOfMonth.getUTCDay() - weekday + 7) % 7;
    lastOfMonth.setUTCDate(lastOfMonth.getUTCDate() - diff);
    return lastOfMonth;
  }
  const firstOfMonth = new Date(Date.UTC(year, month, 1, 12));
  const diff = (weekday - firstOfMonth.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + diff + (nth - 1) * 7, 12));
}

function parseOfficeHoursRange(s) {
  const m = String(s || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  const to24min = (h, mm, ap) => {
    h = parseInt(h, 10); mm = parseInt(mm, 10);
    if (ap) { ap = ap.toUpperCase(); if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0; }
    return h * 60 + mm;
  };
  return { openMin: to24min(m[1], m[2], m[3]), closeMin: to24min(m[4], m[5], m[6]) };
}

function hhmmToMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function fmt12(min) {
  if (min == null) return '';
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12; if (h === 0) h = 12;
  return h + (m ? ':' + String(m).padStart(2, '0') : '') + ap;
}

/* "now": {dateStr, minutesSinceMidnight, weekdayIdx} en hora de Iowa,
   sin importar en que zona horaria corra el servidor. */
function nowInOfficeTimezone() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return {
    dateStr: map.year + '-' + map.month + '-' + map.day,
    minutesNow: parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10),
    weekdayIdx: WEEKDAY_SHORT.indexOf(map.weekday)
  };
}

/* Un solo calculo, reusado para CADA orden -- 'place' es el objeto
   con monOpen..sunOpen + officeHours (del cliente o del building que
   le corresponda a la orden); 'holidaysToday' es el renglon de
   ClientHolidays para HOY, si lo hay. */
function computeNowOpenStatus(place, holidayToday, now) {
  if (!place) return null;
  if (holidayToday) {
    if (!holidayToday.isOpen) return { open: false, text: 'Closed · Holiday' };
    const openMin = hhmmToMin(holidayToday.openTime), closeMin = hhmmToMin(holidayToday.closeTime);
    if (openMin == null || closeMin == null) return { open: false, text: 'Closed · Holiday' };
    if (now.minutesNow >= openMin && now.minutesNow < closeMin) return { open: true, text: 'Now Open · ' + fmt12(openMin) + '–' + fmt12(closeMin) };
    return { open: false, text: now.minutesNow < openMin ? 'Closed · Opens ' + fmt12(openMin) : 'Closed · Holiday' };
  }
  const isOpenDay = truthy(place[DAY_KEYS[now.weekdayIdx]]);
  const hrs = parseOfficeHoursRange(place.officeHours);
  if (!isOpenDay || !hrs) return { open: false, text: 'Closed' };
  if (now.minutesNow >= hrs.openMin && now.minutesNow < hrs.closeMin) return { open: true, text: 'Now Open · ' + fmt12(hrs.openMin) + '–' + fmt12(hrs.closeMin) };
  return { open: false, text: now.minutesNow < hrs.openMin ? 'Closed · Opens ' + fmt12(hrs.openMin) : 'Closed' };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const viewerId = String(body.viewerId || '').trim();
    const scope = ['live', 'closed'].includes(body.scope) ? body.scope : 'all';
    const rows = await ordersForScope(scope);
    const ids = rows.filter(it => it.fields).map(it => it.fields.OrderID || it.fields.Title);
    const byOrder = list => scope === 'all' ? fetchAll(list) : lq.fetchByValues(list, 'OrderID', ids);
    const [svcRows, clientRows, buildingRows, holidayRows, choiceRows, assignmentRows, seenMap] = await Promise.all([
      byOrder(ORDER_SERVICES_LIST),
      lq.fetchAllCached(CLIENTS_LIST),
      lq.fetchAllCached(CLIENT_ADDRESSES_LIST),
      lq.fetchAllCached(HOLIDAYS_LIST),
      lq.fetchAllCached(CLIENT_HOLIDAYS_LIST),
      /* "Assign by service" (21/09/2026) -- para que Scheduling sepa
         cuales ordenes YA se fueron a Active (Status: 'Assigned')
         pero TODAVIA tienen algun servicio sin programar, y las siga
         mostrando ahi -- a peticion explicita del dueño, confirmado
         varias veces durante el mini: la cola de Scheduling nunca
         deja de mostrar una orden solo porque su primer servicio ya
         la mando a Active, mientras le falte algo por programar. */
      byOrder(SERVICE_ASSIGNMENTS_LIST).catch(err => { console.error('admin-get-orders: fetch de ServiceAssignments fallo (no fatal):', err); return []; }),
      fetchSeenMap(viewerId).catch(err => { console.error('admin-get-orders: fetch de OrderSeenBy fallo (no fatal):', err); return {}; })
    ]);

    /* Resumen de servicios por orden, para poder filtrar por servicio
       en la lista sin tener que abrir cada orden. */
    const servicesByOrder = {};
    /* Detalle completo (no solo el nombre) -- lo necesita Scheduling
       para calcular el tiempo estimado sin tener que pedir la orden
       completa aparte solo por eso. Aparte de Services (que se queda
       igual, string[], lo sigue usando el filtro de abajo). */
    const servicesDetailedByOrder = {};
    svcRows.forEach(it => {
      if (!it.fields) return;
      const oid = it.fields.OrderID;
      const name = it.fields.ServiceName;
      if (!oid || !name) return;
      (servicesByOrder[oid] = servicesByOrder[oid] || []).push(name);
      (servicesDetailedByOrder[oid] = servicesDetailedByOrder[oid] || []).push({
        /* BUG REAL encontrado en produccion (21/09/2026): Category
           nunca se incluia aqui -- "Assign by service" lo necesita
           para ligar cada servicio con su renglon de
           ServiceAssignments (mismo par Category+ServiceName que ya
           usa el resto del sistema para identificar un servicio
           dentro de una orden). Sin esto, todo se agrupaba bajo
           "General" en renderOrderDetail (byCat usa s.Category||
           'General') y el emparejamiento con ServiceAssignments
           comparaba contra undefined. */
        Category: it.fields.Category || '',
        ServiceName: name,
        SubOption: it.fields.SubOption || '',
        Division: it.fields.Division || '',
        Level: it.fields.Level || '',
        Quantity: it.fields.Quantity || '',
        /* "Assign by service" -- sin esto, un servicio marcado como
           quitado/no completado desde el editor de Active (Update)
           se seguia viendo "Needs scheduling" en la cola de
           Scheduling para siempre, como si nunca se hubiera tocado. */
        NotCompleted: it.fields.NotCompleted === true || it.fields.NotCompleted === 'true'
      });
    });

    /* "Assign by service" -- por orden, cuantos servicios YA estan
       Completed contra el total real de OrderServices (sin los
       quitados/no completados via Active). BUG REAL corregido
       (21/09/2026, reportado por el dueño en vivo -- "no se debe
       mover de Schedule mientras no esten TODOS Completed"): esto
       antes contaba servicios ya ASIGNADOS (persona+fecha), no
       COMPLETADOS -- una orden con todo asignado pero nada trabajado
       todavia desaparecia de Scheduling de un jalon, y si despues se
       le agregaba un servicio nuevo desde Active, no habia tarjeta
       en Scheduling a donde ese servicio nuevo pudiera aparecer. Ya
       aprobado en el mini interactivo desde el principio: Scheduling
       y Active conviven durante TODA la vida de la orden -- la orden
       solo sale de Scheduling cuando el ULTIMO servicio queda
       Completed, no cuando el ultimo queda asignado. */
    const completedCountByOrder = {};
    assignmentRows.forEach(it => {
      if (!it.fields || it.fields.WorkStatus !== 'Completed') return;
      const oid = it.fields.OrderID;
      if (!oid) return;
      completedCountByOrder[oid] = (completedCountByOrder[oid] || 0) + 1;
    });

    /* Lugares (cliente principal + cada building) por clave "clientId|buildingId"
       ("" de buildingId = la direccion principal) -- con sus dias/horario. */
    const placeByKey = {};
    clientRows.forEach(it => {
      if (!it.fields) return;
      const cid = String(it.fields.ClientID || '').trim().toLowerCase();
      if (!cid) return;
      placeByKey[cid + '|'] = {
        monOpen: it.fields.MonOpen, tueOpen: it.fields.TueOpen, wedOpen: it.fields.WedOpen,
        thuOpen: it.fields.ThuOpen, friOpen: it.fields.FriOpen, satOpen: it.fields.SatOpen, sunOpen: it.fields.SunOpen,
        officeHours: it.fields.OfficeHours || ''
      };
    });
    buildingRows.forEach(it => {
      if (!it.fields) return;
      const cid = String(it.fields.ClientID || '').trim().toLowerCase();
      if (!cid) return;
      placeByKey[cid + '|' + it.id] = {
        monOpen: it.fields.MonOpen, tueOpen: it.fields.TueOpen, wedOpen: it.fields.WedOpen,
        thuOpen: it.fields.ThuOpen, friOpen: it.fields.FriOpen, satOpen: it.fields.SatOpen, sunOpen: it.fields.SunOpen,
        officeHours: it.fields.OfficeHours || ''
      };
    });

    /* Festivos: solo hace falta calcular la fecha real de HOY una vez
       -- si algun festivo cae hoy, se guarda su nombre para cruzarlo
       con las elecciones de cada cliente. */
    const now = nowInOfficeTimezone();
    const todayYear = parseInt(now.dateStr.slice(0, 4), 10);
    const holidayNameToday = {};
    holidayRows.forEach(it => {
      if (!it.fields) return;
      const d = computeHolidayDate(it.fields, todayYear).toISOString().slice(0, 10);
      if (d === now.dateStr) holidayNameToday[it.fields.HolidayName || ''] = true;
    });
    const holidayChoiceByKey = {};
    if (Object.keys(holidayNameToday).length) {
      choiceRows.forEach(it => {
        if (!it.fields) return;
        if (!holidayNameToday[it.fields.HolidayName || '']) return;
        const cid = String(it.fields.ClientID || '').trim().toLowerCase();
        const bid = String(it.fields.BuildingId || '').trim();
        holidayChoiceByKey[cid + '|' + bid] = {
          isOpen: truthy(it.fields.IsOpen), openTime: it.fields.OpenTime || '', closeTime: it.fields.CloseTime || ''
        };
      });
    }

    const orders = rows
      .filter(it => it.fields)
      .map(it => {
        const f = it.fields;
        const cidKey = String(f.ClientID || '').trim().toLowerCase();
        const bidKey = String(f.BuildingId || '').trim();
        const place = placeByKey[cidKey + '|' + bidKey];
        const holidayToday = holidayChoiceByKey[cidKey + '|' + bidKey];
        return {
          id: it.id,
          createdDateTime: it.createdDateTime || '',
          lastModifiedDateTime: it.lastModifiedDateTime || it.createdDateTime || '',
          OrderID: f.OrderID || f.Title || '',
          ClientID: f.ClientID || '',
          /* Copia congelada de lo que incluyo cada paquete (columna Orders.PackageContents). */
          PackageContents: f.PackageContents || '',
          BusinessName: f.BusinessName || f.Title || '',
          Division: f.Division || '',
          Status: f.Status || 'Pending',
          Supervisor: f.Supervisor || '',
          DirtLevel: f.DirtLevel || '',
          BuildingNumber: f.BuildingNumber || '',
          UnitNumber: f.UnitNumber || '',
          Bedrooms: f.Bedrooms || '',
          Bathrooms: f.Bathrooms || '',
          EntryDate: f.EntryDate || '',
          DueDate: f.DueDate || '',
          Address: f.Address || '',
          Suite: f.Suite || '',
          City: f.City || '',
          Zip: f.Zip || '',
          Contact: f.Contact || '',
          Notes: f.Notes || '',
          /* Columnas nuevas (28/08/2026): la pestana Approvals y el editor
             del admin las necesitan en la lista, no solo en el detalle. */
          ServiceWindow: f.ServiceWindow || '',
          DispatchDate: f.DispatchDate || '',
          /* Columna nueva (19/09/2026): liga la orden a su contrato
             recurrente de origen -- isFullyScheduled() la necesita en
             la LISTA (no solo en el detalle) para decidir en que tab
             vive cada orden. */
          RecurringServiceID: f.RecurringServiceID || '',
          InspectionDate: f.InspectionDate || '',
          InspectionBy:   f.InspectionBy || '',
          InspectionWindow: f.InspectionWindow || '',
          InspectionDoneAt: f.InspectionDoneAt || '',
          InspectionNotes: f.InspectionNotes || '',
          Archived: f.Archived === true || f.Archived === 'true',
          DelayReasonType: f.DelayReasonType || '',
          DelayReasonNotes: f.DelayReasonNotes || '',
          Technician: f.Technician || '',
          TechMarkedComplete: f.TechMarkedComplete === true || f.TechMarkedComplete === 'true',
          CompletedDate: f.CompletedDate || '',
          OrderNotificationsEnabled: f.OrderNotificationsEnabled || '',
          OrderNotifyConfirmations:  f.OrderNotifyConfirmations  || '',
          OrderNotifyChanges:        f.OrderNotifyChanges        || '',
          OrderNotifyUpdates:        f.OrderNotifyUpdates        || '',
          OrderContactId:            f.OrderContactId            || '',
          BatchId:    f.BatchId    || '',
          BuildingId: f.BuildingId || '',
          Latitude:   f.Latitude   != null ? f.Latitude  : null,
          Longitude:  f.Longitude  != null ? f.Longitude : null,
          /* Renovations: cliente avisa cuando el material ya esta listo
             para que entremos, con hora opcional. MaterialsReadySeen
             controla la burbuja de aviso en Review (Sí = ya lo vio el
             staff, No = pendiente). */
          ExpectedReadyDate: f.ExpectedReadyDate || '',
          MaterialsReady: f.MaterialsReady === true || f.MaterialsReady === 'true',
          MaterialsReadySeen: f.MaterialsReadySeen === undefined ? true : (f.MaterialsReadySeen === true || f.MaterialsReadySeen === 'true'),
          EntryTime: f.EntryTime || '',
          /* Renovations/Janitorial: cliente avisa si actualmente vive
             alguien en la unidad -- solo lectura del lado de Admin. */
          UnitOccupied: f.UnitOccupied === true || f.UnitOccupied === 'true',
          /* Exteriors: si necesita algo de la oficina del edificio antes
             de poder entrar (llaves, codigo de acceso, etc.). */
          NeedsOfficeAccess: f.NeedsOfficeAccess === true || f.NeedsOfficeAccess === 'true',
          OfficeNeedNotes: f.OfficeNeedNotes || '',
          /* Columna nueva (21/09/2026): "Assign by service" -- si esta
             prendido, Scheduling asigna cada servicio por separado
             (en vez de un solo bloque para toda la orden) y Active
             usa el modelo por servicio en lugar del de siempre. */
          AssignByService: f.AssignByService === true || f.AssignByService === 'true',
          /* "Assign by service" -- ver comentario junto a completedCountByOrder
             arriba. true = todavia falta AL MENOS un servicio por
             completar (sin contar los quitados/no completados via
             Active) -- Scheduling usa esto para decidir si la orden
             se sigue mostrando ahi, sin importar su Status. */
          AssignByServiceHasIncomplete: (completedCountByOrder[f.OrderID || f.Title] || 0) <
            (servicesDetailedByOrder[f.OrderID || f.Title] || []).filter(s => !s.NotCompleted).length,
          NowOpenStatus: computeNowOpenStatus(place, holidayToday, now),
          Services: servicesByOrder[f.OrderID || f.Title] || [],
          ServicesDetailed: servicesDetailedByOrder[f.OrderID || f.Title] || []
        };
      })
      .sort((a,b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)));

    /* Marcado persistente por usuario (21/09/2026) -- distinto al
       destello de live-refresh, que se apaga solo. Esto se queda
       marcado hasta que ESTE viewer, por su cuenta, abra la orden
       (ver admin-mark-order-seen.js). Si viewerId vino vacio,
       seenMap ya es {} y unseen aqui sale false para todas. */
    const unseenSet = unseenIds(orders, seenMap);
    orders.forEach(o => { o.Unseen = unseenSet.has(o.OrderID); });

    return jsonResponse(200, { orders });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
