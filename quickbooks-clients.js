/* ============================================================
   quickbooks-clients.js — tab "New clients" del panel de QuickBooks
   (25/09/2026, pedido del dueño: "que si un cliente se registra solo,
   en la ventana de QuickBooks nos aparezca ... y para poder importar a
   QB que se use el password del director").

   GET  -> clientes que se registraron solos desde orders.gsocd.com
           (Clients.SelfRegistered, lo pone register-client.js de
           Orders), cada uno con inQuickBooks (si ya esta ligado en
           qb_customer_id_map). Los que vienen del reporte de QuickBooks
           o los que crea la oficina no salen aqui: esos ya existen alla.
   POST { clientIds, password } -> los manda como Customer. El password
           del director se revisa AQUI (no solo en la pagina), igual
           que verify-director-password de developer-admin.js. Nunca
           duplica: si ya hay un Customer con ese nombre, solo se liga.
============================================================ */
const { CLIENTS_LIST, jsonResponse } = require('./lib/graph');
const lq = require('./lib/list-query');
const { isConnected, findOrCreateCustomer, getJsonSetting, getSetting } = require('./lib/quickbooks');

const truthy = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';

function clientOut(it, map) {
  const f = it.fields || {};
  return {
    clientId: f.ClientID || '',
    businessName: f.Title || '',
    contactPerson: f.ClientName || '',
    email: f.Contact || '',
    phone: f.Phone || '',
    address: f.Address || '',
    suite: f.Suite || '',
    city: f.City || '',
    zip: f.Zip || '',
    registeredAt: it.createdDateTime || '',
    inQuickBooks: !!map[f.ClientID]
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'GET') {
      const [rows, map] = await Promise.all([lq.fetchAll(CLIENTS_LIST), getJsonSetting('qb_customer_id_map')]);
      const clients = rows
        .filter(it => it.fields && it.fields.ClientID && truthy(it.fields.SelfRegistered))
        .map(it => clientOut(it, map))
        .sort((a, b) => String(b.registeredAt).localeCompare(String(a.registeredAt)));
      return jsonResponse(200, { clients });
    }
    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

    const body = JSON.parse(event.body || '{}');
    const ids = [...new Set((Array.isArray(body.clientIds) ? body.clientIds : []).map(String).filter(Boolean))];
    if (!ids.length) return jsonResponse(400, { error: 'No clients selected.' });

    const real = (await getSetting('DirectorPassword')) || '080922';
    if (String(body.password || '') !== String(real)) {
      return jsonResponse(403, { error: 'Wrong Operations Director password.', code: 'BAD_PASSWORD' });
    }
    if (!(await isConnected())) return jsonResponse(409, { error: 'QuickBooks is not connected yet.' });

    const rows = await lq.fetchByValues(CLIENTS_LIST, 'ClientID', ids);
    const byId = new Map(rows.filter(it => it.fields).map(it => [String(it.fields.ClientID), it.fields]));
    const results = [];
    /* Uno por uno: si uno falla (p. ej. el nombre ya lo usa un
       proveedor en QuickBooks) los demas siguen. */
    for (const id of ids) {
      const f = byId.get(id);
      if (!f) { results.push({ clientId: id, success: false, error: 'Client not found.' }); continue; }
      try {
        const r = await findOrCreateCustomer(id, {
          businessName: f.Title, contactPerson: f.ClientName, email: f.Contact, phone: f.Phone,
          address: f.Address, suite: f.Suite, city: f.City, zip: f.Zip
        });
        results.push({ clientId: id, success: true, customerId: r.id, how: r.how });
      } catch (err) {
        results.push({ clientId: id, success: false, error: err.message });
      }
    }
    return jsonResponse(200, { results });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
