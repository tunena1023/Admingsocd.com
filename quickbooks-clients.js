/* ============================================================
   quickbooks-clients.js — tab "Clients" del panel de QuickBooks y
   boton "Update in QuickBooks" del tab Clients / Developer.

   Historia:
   - 25/09/2026 (1a version): solo los que se registraron solos.
   - 25/09/2026 (el dueño: "el cliente que esta en nuestra app no existe
     en QB... y como no fue que se registrara no lo puso en el tab"):
     ahora se comparan TODOS los clientes de la app contra QuickBooks.

   GET  -> cada cliente de la app con:
             qb:   como esta en QuickBooks (o null si no existe)
             diff: que campos son distintos entre la app y QuickBooks
           Un cliente con el MISMO nombre en QuickBooks se liga solo
           (qb_customer_id_map), igual que ya pasaba al mandar ordenes.
   POST { action:'create', clients:[datos revisados], password }
        -> los crea en QuickBooks con los datos de la tarjeta, y esos
           mismos datos se guardan en la app (con historial, via
           admin-update-client). Si mientras tanto alguien ya lo creo
           en QuickBooks con ese nombre, solo se liga (nunca duplica).
   POST { action:'update', clientId, password }
        -> manda a QuickBooks los datos que tiene HOY la app.
   El password del director se revisa aqui en el servidor.
============================================================ */
const { CLIENTS_LIST, jsonResponse } = require('./lib/graph');
const lq = require('./lib/list-query');
const qb = require('./lib/quickbooks');

const truthy = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
const norm = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
const FIELDS = ['businessName', 'contactPerson', 'email', 'phone', 'address', 'suite', 'city', 'zip'];

function appClient(it) {
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
    active: f.Active === undefined ? true : truthy(f.Active),
    selfRegistered: truthy(f.SelfRegistered),
    registeredAt: it.createdDateTime || ''
  };
}

/* Telefonos se comparan solo por digitos ("(515) 555-0142" = "5155550142"). */
function sameField(k, a, b) {
  if (k === 'phone') return String(a || '').replace(/\D/g, '') === String(b || '').replace(/\D/g, '');
  return norm(a) === norm(b);
}

async function checkPassword(pw) {
  return require('./lib/director-password').isDirectorPassword(pw, k => qb.getSetting(k));
}

async function updateApp(event, c) {
  /* Mismo endpoint que el tab Clients: deja historial de cada cambio. */
  const email = (event.headers || {})['x-gs-user-email'] || 'Admin';
  const res = await require('./admin-update-client').handler({
    httpMethod: 'POST',
    headers: event.headers,
    body: JSON.stringify({
      clientId: c.clientId, changedBy: email,
      businessName: c.businessName, contactPerson: c.contactPerson, contact: c.email,
      phone: c.phone, address: c.address, suite: c.suite, city: c.city, zip: c.zip,
      /* QuickBooks lo manda quien llama (lib/qb-sync.js, con registro). */
      skipQbSync: true
    })
  });
  if (res.statusCode !== 200) throw new Error('Saved in QuickBooks, but the app could not be updated: ' + (JSON.parse(res.body || '{}').error || res.statusCode));
}

exports.handler = async (event) => {
  try {
    if (!(await qb.isConnected())) return jsonResponse(409, { error: 'QuickBooks is not connected yet.' });

    if (event.httpMethod === 'GET') {
      const [rows, map, customers] = await Promise.all([
        lq.fetchAll(CLIENTS_LIST), qb.getJsonSetting('qb_customer_id_map'), qb.listCustomers()
      ]);
      const byId = new Map(customers.map(cu => [String(cu.Id), cu]));
      const byName = new Map();
      customers.forEach(cu => { const k = norm(cu.DisplayName); if (k && !byName.has(k)) byName.set(k, cu); });
      const newLinks = {};
      const clients = rows.filter(it => it.fields && it.fields.ClientID).map(it => {
        const c = appClient(it);
        let cu = map[c.clientId] ? byId.get(String(map[c.clientId])) : null;
        if (!cu) {
          cu = byName.get(norm(c.businessName)) || null;
          if (cu) newLinks[c.clientId] = String(cu.Id);
        }
        const view = cu ? qb.customerView(cu) : null;
        c.qb = view;
        c.diff = view ? FIELDS.filter(k => !sameField(k, c[k], view[k])) : [];
        return c;
      }).sort((a, b) => String(a.businessName).localeCompare(String(b.businessName)));
      await qb.linkCustomers(newLinks);
      return jsonResponse(200, { clients });
    }

    if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
    const body = JSON.parse(event.body || '{}');
    if (!(await checkPassword(body.password))) {
      return jsonResponse(403, { error: 'Wrong Operations Director password.', code: 'BAD_PASSWORD' });
    }

    if (body.action === 'update') {
      const clientId = String(body.clientId || '');
      const rows = await lq.fetchByValues(CLIENTS_LIST, 'ClientID', [clientId]);
      const it = rows.find(r => r.fields);
      if (!it) return jsonResponse(404, { error: 'Client not found.' });
      const c = appClient(it);
      const map = await qb.getJsonSetting('qb_customer_id_map');
      const id = map[clientId] || await qb.findCustomerId(clientId, c.businessName);
      if (!id) return jsonResponse(404, { error: c.businessName + ' is not in QuickBooks yet. Create it in QuickBooks › Clients.' });
      /* 26/09/2026: por lib/qb-sync.js -- solo los campos distintos, con
         registro de como estaba (se puede deshacer). El estado lo deja el
         que tenga QuickBooks (la app no lo guarda). */
      const r = await require('./lib/qb-sync').pushClient(clientId, { by: (event.headers || {})['x-gs-user-email'] || 'Admin', reason: 'update-button' });
      if (r.error) return jsonResponse(500, { error: r.error });
      const cur = await qb.qbFetch('/customer/' + encodeURIComponent(r.qbId || id));
      return jsonResponse(200, { success: true, qb: qb.customerView(cur.Customer), change: r.change || null });
    }

    /* create (tambien sin action, como la 1a version) */
    const list = Array.isArray(body.clients) ? body.clients : [];
    if (!list.length) return jsonResponse(400, { error: 'No clients selected.' });
    const customers = await qb.listCustomers();
    const byName = new Map();
    customers.forEach(cu => { const k = norm(cu.DisplayName); if (k && !byName.has(k)) byName.set(k, cu); });
    const results = [];
    for (const raw of list) {
      const c = {};
      ['clientId', 'state'].concat(FIELDS).forEach(k => { c[k] = String(raw[k] == null ? '' : raw[k]).trim(); });
      if (!c.clientId || !c.businessName) { results.push({ clientId: c.clientId, success: false, error: 'Business name is required.' }); continue; }
      try {
        /* 26/09/2026: primero se guarda en la app (GSMS manda) y luego
           lib/qb-sync.js lo manda: lo liga si ya hay uno con ese nombre (y le
           pone los datos de la app) o lo crea, siempre con registro. */
        let cu = byName.get(norm(c.businessName));
        if (cu) await qb.linkCustomers({ [c.clientId]: String(cu.Id) });
        await updateApp(event, c);
        const r = await require('./lib/qb-sync').pushClient(c.clientId, { by: (event.headers || {})['x-gs-user-email'] || 'Admin', reason: 'create-button' });
        if (r.skipped) throw new Error(r.skipped);
        if (!cu) byName.set(norm(c.businessName), { Id: r.qbId, DisplayName: c.businessName });
        results.push({ clientId: c.clientId, success: true, how: r.created ? 'created' : 'linked', customerId: String(r.qbId) });
      } catch (err) {
        results.push({ clientId: c.clientId, success: false, error: err.message });
      }
    }
    return jsonResponse(200, { results });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
