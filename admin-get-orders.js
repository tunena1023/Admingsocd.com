/* admin-get-orders.js — todas las órdenes (sin filtro de cliente) */
const {
  ORDERS_LIST, ORDER_SERVICES_LIST, CLIENTS_LIST, CLIENT_ADDRESSES_LIST,
  HOLIDAYS_LIST, CLIENT_HOLIDAYS_LIST,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');

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
    const [rows, svcRows, clientRows, buildingRows, holidayRows, choiceRows] = await Promise.all([
      fetchAll(ORDERS_LIST),
      fetchAll(ORDER_SERVICES_LIST),
      fetchAll(CLIENTS_LIST),
      fetchAll(CLIENT_ADDRESSES_LIST),
      fetchAll(HOLIDAYS_LIST),
      fetchAll(CLIENT_HOLIDAYS_LIST)
    ]);

    /* Resumen de servicios por orden, para poder filtrar por servicio
       en la lista sin tener que abrir cada orden. */
    const servicesByOrder = {};
    svcRows.forEach(it => {
      if (!it.fields) return;
      const oid = it.fields.OrderID;
      const name = it.fields.ServiceName;
      if (!oid || !name) return;
      (servicesByOrder[oid] = servicesByOrder[oid] || []).push(name);
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
          InspectionDate: f.InspectionDate || '',
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
          NowOpenStatus: computeNowOpenStatus(place, holidayToday, now),
          Services: servicesByOrder[f.OrderID || f.Title] || []
        };
      })
      .sort((a,b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)));
    return jsonResponse(200, { orders });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
