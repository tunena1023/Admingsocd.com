/* ============================================================
   admin-get-client-holidays.js — lista maestra de festivos YA
   COMBINADA con lo que este cliente (y, si aplica, este building
   especifico) ya eligio -- para que admin.html solo tenga que
   pintar, sin cruzar 2 respuestas el mismo.

   Mismo patron que get-holidays.js de ordersgsocd.com (el lado del
   cliente) -- duplicado a proposito aqui para que la oficina pueda
   ver/editar los festivos de un cliente EN SU NOMBRE, sin tener que
   pedirle que entre a su propio portal a hacerlo. Un festivo sin
   eleccion todavia viene con isOpen: null.
============================================================ */

const { HOLIDAYS_LIST, CLIENT_HOLIDAYS_LIST, graphFetch, siteListPath, jsonResponse } = require('./lib/graph');

async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200';
  const out = [];
  try {
    while (url) {
      const data = await graphFetch(url);
      out.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
  } catch (e) {
    return [];
  }
  return out;
}

/* Misma logica que developer-admin.js -- duplicada a proposito, cada
   backend es independiente en este proyecto. */
function computeHolidayDate(h, year) {
  if (h.RuleType === 'Fixed') {
    return new Date(Date.UTC(year, (h.Month || 1) - 1, h.Day || 1, 12));
  }
  const month = (h.Month || 1) - 1;
  const weekday = h.Weekday || 0;
  const nth = h.Nth || 1;
  if (nth === 5) {
    const lastOfMonth = new Date(Date.UTC(year, month + 1, 0, 12));
    const diff = (lastOfMonth.getUTCDay() - weekday + 7) % 7;
    lastOfMonth.setUTCDate(lastOfMonth.getUTCDate() - diff);
    return lastOfMonth;
  }
  const firstOfMonth = new Date(Date.UTC(year, month, 1, 12));
  const diff = (weekday - firstOfMonth.getUTCDay() + 7) % 7;
  const firstOccurrence = 1 + diff;
  return new Date(Date.UTC(year, month, firstOccurrence + (nth - 1) * 7, 12));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.clientId) return jsonResponse(400, { error: 'clientId is required' });
    const clientId = String(b.clientId).trim();
    const buildingId = String(b.buildingId || '').trim();
    const year = parseInt(b.year, 10) || new Date().getFullYear();

    const [holidayRows, choiceRows] = await Promise.all([
      fetchAll(HOLIDAYS_LIST),
      fetchAll(CLIENT_HOLIDAYS_LIST)
    ]);

    const choiceFor = {};
    choiceRows.forEach(it => {
      const f = it.fields;
      if (!f) return;
      if (String(f.ClientID || '').trim().toLowerCase() !== clientId.toLowerCase()) return;
      if (String(f.BuildingId || '').trim() !== buildingId) return;
      choiceFor[String(f.HolidayName || '')] = {
        choiceId: it.id,
        isOpen: !!f.IsOpen,
        openTime: f.OpenTime || '',
        closeTime: f.CloseTime || ''
      };
    });

    const holidays = holidayRows.filter(it => it.fields).map(it => {
      const f = it.fields;
      const date = computeHolidayDate(f, year);
      const choice = choiceFor[f.HolidayName || ''] || null;
      return {
        id: it.id,
        name: f.HolidayName || '',
        date: date.toISOString().slice(0, 10),
        choiceId: choice ? choice.choiceId : null,
        isOpen: choice ? choice.isOpen : null,
        openTime: choice ? choice.openTime : '',
        closeTime: choice ? choice.closeTime : ''
      };
    }).sort((a, b) => a.date.localeCompare(b.date));

    return jsonResponse(200, { holidays });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
