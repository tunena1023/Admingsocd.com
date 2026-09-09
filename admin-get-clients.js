/* admin-get-clients.js — todos los clientes */
const {
  CLIENTS_LIST, CLIENT_ADDRESSES_LIST, CLIENT_CONTACTS_LIST,
  HOLIDAYS_LIST, CLIENT_HOLIDAYS_LIST,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');

/* Mismo criterio que admin-update-client.js */
function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

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

/* ===== "Now Open" -- mismo calculo que admin-get-orders.js, pedido
   por el usuario tambien aqui en el tab de Clients. Duplicado a
   proposito (cada backend es independiente en este proyecto), no
   compartido entre archivos. ===== */
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
    const [rows, addrRows, contactRows, holidayRows, choiceRows] = await Promise.all([
      fetchAll(CLIENTS_LIST),
      fetchAll(CLIENT_ADDRESSES_LIST),
      fetchAll(CLIENT_CONTACTS_LIST),
      fetchAll(HOLIDAYS_LIST),
      fetchAll(CLIENT_HOLIDAYS_LIST)
    ]);

    /* Festivos de HOY (si los hay) + eleccion de cada cliente/building
       para ese festivo -- mismo patron que admin-get-orders.js. */
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

    /* Direcciones agrupadas por ClientID -- se traen TODAS (incluyendo
       archivadas), el admin necesita poder desarchivar una desde aqui. */
    const addrByClient = {};
    addrRows.forEach(it => {
      if (!it.fields) return;
      const cid = String(it.fields.ClientID || '').trim().toLowerCase();
      if (!cid) return;
      const cidKey = cid;
      const bidKey = it.id;
      (addrByClient[cid] = addrByClient[cid] || []).push({
        id:             it.id,
        label:          it.fields.Label          || '',
        buildingNumber: it.fields.BuildingNumber || '',
        address:        it.fields.Address        || '',
        suite:          it.fields.Suite          || '',
        city:           it.fields.City           || '',
        zip:            it.fields.Zip            || '',
        contactId:      it.fields.ContactId      || '',
        monOpen:        truthy(it.fields.MonOpen),
        tueOpen:        truthy(it.fields.TueOpen),
        wedOpen:        truthy(it.fields.WedOpen),
        thuOpen:        truthy(it.fields.ThuOpen),
        friOpen:        truthy(it.fields.FriOpen),
        satOpen:        truthy(it.fields.SatOpen),
        sunOpen:        truthy(it.fields.SunOpen),
        officeHours:    it.fields.OfficeHours    || '',
        latitude:       it.fields.Latitude  != null ? Number(it.fields.Latitude)  : null,
        longitude:      it.fields.Longitude != null ? Number(it.fields.Longitude) : null,
        archived:       truthy(it.fields.Archived),
        nowOpenStatus:  computeNowOpenStatus(
          { monOpen: it.fields.MonOpen, tueOpen: it.fields.TueOpen, wedOpen: it.fields.WedOpen, thuOpen: it.fields.ThuOpen, friOpen: it.fields.FriOpen, satOpen: it.fields.SatOpen, sunOpen: it.fields.SunOpen, officeHours: it.fields.OfficeHours },
          holidayChoiceByKey[cidKey + '|' + bidKey], now
        )
      });
    });

    /* Contactos adicionales del cliente (mas alla del Email/Phone
       principal que ya vive en Clients), agrupados igual por ClientID.
       Se traen TODOS (incluyendo archivados) -- igual que buildings,
       para poder desarchivar uno desde la interfaz. */
    const contactsByClient = {};
    contactRows.forEach(it => {
      if (!it.fields) return;
      const cid = String(it.fields.ClientID || '').trim().toLowerCase();
      if (!cid) return;
      (contactsByClient[cid] = contactsByClient[cid] || []).push({
        id:    it.id,
        name:  it.fields.Name        || '',
        type:  it.fields.ContactType || '',
        value: it.fields.Value       || '',
        notifyRecipient: truthy(it.fields.NotifyRecipient),
        archived: truthy(it.fields.Archived)
      });
    });

    const clients = rows
      .filter(it => it.fields)
      .map(it => {
        const f = it.fields;
        const cid = String(f.ClientID || '').trim().toLowerCase();
        return {
          id: it.id,
          clientId: f.ClientID || '',
          businessName: f.Title || '',
          contactPerson: f.ClientName || '',
          address: f.Address || '',
          suite: f.Suite || '',
          city: f.City || '',
          zip: f.Zip || '',
          contact: f.Contact || '',
          phone: f.Phone || '',
          notificationsEnabled: f.NotificationsEnabled == null ? true : truthy(f.NotificationsEnabled),
          notifyConfirmations:  f.NotifyConfirmations  == null ? true : truthy(f.NotifyConfirmations),
          notifyChanges:        f.NotifyChanges        == null ? true : truthy(f.NotifyChanges),
          notifyUpdates:        f.NotifyUpdates        == null ? true : truthy(f.NotifyUpdates),
          monOpen:        truthy(f.MonOpen),
          tueOpen:        truthy(f.TueOpen),
          wedOpen:        truthy(f.WedOpen),
          thuOpen:        truthy(f.ThuOpen),
          friOpen:        truthy(f.FriOpen),
          satOpen:        truthy(f.SatOpen),
          sunOpen:        truthy(f.SunOpen),
          officeHours:    f.OfficeHours || '',
          nowOpenStatus:  computeNowOpenStatus(
            { monOpen: f.MonOpen, tueOpen: f.TueOpen, wedOpen: f.WedOpen, thuOpen: f.ThuOpen, friOpen: f.FriOpen, satOpen: f.SatOpen, sunOpen: f.SunOpen, officeHours: f.OfficeHours },
            holidayChoiceByKey[cid + '|'], now
          ),
          active: f.Active === undefined ? true : truthy(f.Active),
          buildings: (addrByClient[cid] || []).slice().sort((a, b) => a.label.localeCompare(b.label)),
          contacts: (contactsByClient[cid] || []).slice().sort((a, b) => a.name.localeCompare(b.name))
        };
      })
      .sort((a,b) => a.businessName.localeCompare(b.businessName));
    return jsonResponse(200, { clients });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
