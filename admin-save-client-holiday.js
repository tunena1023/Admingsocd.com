/* ============================================================
   admin-save-client-holiday.js — guarda la eleccion de UN festivo en
   nombre del cliente (abre o cierra, y si abre, a que hora). Mismo
   patron que save-client-holiday.js de ordersgsocd.com.
============================================================ */

const { CLIENT_HOLIDAYS_LIST, createListItem, updateListItemByItemId, jsonResponse } = require('./lib/graph');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.clientId) return jsonResponse(400, { error: 'clientId is required' });
    if (!b.holidayName) return jsonResponse(400, { error: 'holidayName is required' });
    if (typeof b.isOpen !== 'boolean') return jsonResponse(400, { error: 'isOpen must be true or false' });

    const fields = {
      Title: String(b.clientId).trim() + ' - ' + b.holidayName,
      ClientID: String(b.clientId).trim(),
      BuildingId: String(b.buildingId || '').trim(),
      HolidayName: b.holidayName,
      IsOpen: b.isOpen,
      OpenTime: b.isOpen ? (b.openTime || '') : '',
      CloseTime: b.isOpen ? (b.closeTime || '') : ''
    };

    if (b.choiceId) {
      await updateListItemByItemId(CLIENT_HOLIDAYS_LIST, b.choiceId, fields);
      return jsonResponse(200, { success: true, id: b.choiceId });
    }
    const created = await createListItem(CLIENT_HOLIDAYS_LIST, fields);
    return jsonResponse(200, { success: true, id: created.id });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
