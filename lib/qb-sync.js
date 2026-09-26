/* ============================================================
   lib/qb-sync.js -- GSMS -> QuickBooks al instante, con registro de
   cada cambio y "Undo" (26/09/2026, PLAN-RESPALDOS.md fase 2).

   El dueño: "que si se hacen cambios desde la app se reflejen en
   QuickBooks inmediatamente, y que eso guarde un backup, y si despues
   algo sale mal en QuickBooks poder regresar a antes del cambio que se
   hizo en GSMS". Clientes: GSMS es la fuente de verdad ("nadie se va a
   meter en QuickBooks"). Servicios: la DESCRIPCION se edita en GSMS y va
   a QuickBooks; nombre, precio y SKU vienen de QuickBooks (Migrate).

   Toda escritura a QuickBooks que hace GSMS pasa por aqui:
     1. lee como esta el Customer/Item en QuickBooks;
     2. guarda el registro ANTES de escribir, en
        Documents/Backups/QuickBooks/<ambiente>/changes/<fecha>-<Entidad>-<Id>-<accion>.json
        (si no se pudo guardar, no se manda nada);
     3. manda SOLO lo que cambio (sparse update con SyncToken);
     4. guarda en el mismo registro como quedo.
   Undo regresa QuickBooks a "before" y, si el cambio vino de una edicion
   en GSMS, tambien regresa GSMS (gsmsBefore). Un Undo tambien queda
   registrado, asi que se puede deshacer.
============================================================ */
const g = require('./graph');
const lq = require('./list-query');
const qb = require('./quickbooks');

const env = () => ((process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox');
const folder = () => 'Backups/QuickBooks/' + env() + '/changes';
const NAME_RE = /^[0-9TZ-]+Z-(Customer|Item)-[0-9A-Za-z]+-(create|update|undo)\.json$/;
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

const norm = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
const FIELDS = ['businessName', 'contactPerson', 'email', 'phone', 'address', 'suite', 'city', 'zip'];
function sameField(k, a, b) {
  if (k === 'phone') return String(a || '').replace(/\D/g, '') === String(b || '').replace(/\D/g, '');
  return norm(a) === norm(b);
}

/* Cliente de la app en el lenguaje de QuickBooks (igual que quickbooks-clients.js). */
function appClient(f) {
  return {
    clientId: f.ClientID || '', businessName: f.Title || '', contactPerson: f.ClientName || '',
    email: f.Contact || '', phone: f.Phone || '', address: f.Address || '', suite: f.Suite || '',
    city: f.City || '', zip: f.Zip || ''
  };
}

async function saveRecord(name, rec) {
  await g.uploadFile(folder(), name, Buffer.from(JSON.stringify(rec)), 'application/json');
}
async function readRecord(name) {
  if (!NAME_RE.test(String(name || ''))) { const e = new Error('Unknown change.'); e.status = 400; throw e; }
  const buf = await g.downloadByPath(folder() + '/' + name);
  if (!buf) { const e = new Error('Change not found.'); e.status = 404; throw e; }
  return JSON.parse(buf.toString('utf8'));
}

/* Registrar -> escribir -> registrar como quedo. write() hace la llamada real. */
async function recorded(entity, qbId, action, rec, write) {
  const name = stampNow() + '-' + entity + '-' + String(qbId || 'new').replace(/[^0-9A-Za-z]/g, '') + '-' + action + '.json';
  rec = Object.assign({ version: 1, env: env(), entity, qbId: String(qbId || ''), action, at: new Date().toISOString() }, rec);
  await saveRecord(name, rec); /* si esto truena, no se manda nada */
  let after;
  try { after = await write(); }
  catch (e) { rec.error = e.message; try { await saveRecord(name, rec); } catch (x) { /* ya se aviso arriba */ } throw e; }
  rec.after = after;
  if (after && after.Id && !rec.qbId) rec.qbId = String(after.Id);
  try { await saveRecord(name, rec); } catch (e) { /* el cambio ya se hizo; el registro guarda el "antes" */ }
  return { name, after };
}

/* Payload SOLO con lo que cambio. BillAddr va completo (QuickBooks reemplaza
   el objeto), conservando su Id y el estado que ya tiene QuickBooks (la app
   no guarda estado). Un correo o telefono vacio no se manda: QuickBooks no
   deja borrar el correo asi, y se avisa en skipped. */
function customerDiffPayload(c, cur) {
  const view = qb.customerView(cur);
  const diff = FIELDS.filter(k => !sameField(k, c[k], view[k]));
  const payload = { Id: String(cur.Id), SyncToken: cur.SyncToken, sparse: true };
  const skipped = [];
  if (diff.includes('businessName')) { payload.DisplayName = c.businessName; payload.CompanyName = c.businessName; }
  if (diff.includes('contactPerson')) {
    const p = String(c.contactPerson || '').trim().split(/\s+/).filter(Boolean);
    payload.GivenName = p[0] || ''; payload.FamilyName = p.slice(1).join(' ');
  }
  if (diff.includes('email')) { if (String(c.email || '').trim()) payload.PrimaryEmailAddr = { Address: String(c.email).trim() }; else skipped.push('email'); }
  if (diff.includes('phone')) { if (String(c.phone || '').trim()) payload.PrimaryPhone = { FreeFormNumber: String(c.phone).trim() }; else skipped.push('phone'); }
  if (['address', 'suite', 'city', 'zip'].some(k => diff.includes(k))) {
    const a = cur.BillAddr || {};
    payload.BillAddr = Object.assign(a.Id ? { Id: a.Id } : {}, { Line1: c.address || '', Line2: c.suite || '', City: c.city || '', CountrySubDivisionCode: a.CountrySubDivisionCode || 'IA', PostalCode: c.zip || '' });
  }
  return { payload, diff: diff.filter(k => !skipped.includes(k)), skipped };
}

/* Manda a QuickBooks como esta HOY el cliente en GSMS. opts.gsmsBefore: como
   estaba en GSMS antes de la edicion (para que Undo regrese GSMS tambien). */
async function pushClient(clientId, opts) {
  opts = opts || {};
  if (!(await qb.isConnected())) return { skipped: 'QuickBooks is not connected' };
  const rows = await lq.fetchByValues(g.CLIENTS_LIST || 'Clients', 'ClientID', [clientId]);
  const it = rows.find(r => r.fields && String(r.fields.ClientID) === String(clientId));
  if (!it) return { skipped: 'Client not found' };
  const c = appClient(it.fields);
  if (!c.businessName.trim()) return { skipped: 'Client has no business name' };
  const base = { by: opts.by || '', reason: opts.reason || 'client-edit', gsmsRef: c.clientId, label: c.businessName, gsmsBefore: opts.gsmsBefore || null, gsmsAfter: c };

  const qbId = await qb.findCustomerId(c.clientId, c.businessName);
  if (!qbId) {
    const r = await recorded('Customer', '', 'create', Object.assign(base, { before: null, sent: { customer: c } }), async () => {
      const cu = await qb.createCustomer(c);
      await qb.linkCustomers({ [c.clientId]: String(cu.Id) });
      return cu;
    });
    return { created: true, qbId: String(r.after.Id), change: r.name };
  }
  const cur = (await qb.qbFetch('/customer/' + encodeURIComponent(qbId))).Customer;
  const { payload, diff, skipped } = customerDiffPayload(c, cur);
  if (!diff.length) return { unchanged: true, qbId: String(qbId), skipped };
  const r = await recorded('Customer', qbId, 'update', Object.assign(base, { before: cur, sent: payload, fields: diff }), async () =>
    (await qb.qbFetch('/customer', { method: 'POST', body: payload })).Customer);
  return { updated: true, qbId: String(qbId), fields: diff, skipped, change: r.name };
}

/* Descripcion de un servicio (GSMS -> QuickBooks). */
async function pushItemDescription(sku, description, opts) {
  opts = opts || {};
  if (!(await qb.isConnected())) return { skipped: 'QuickBooks is not connected' };
  const found = await qb.findItemBySku(sku);
  if (!found) return { skipped: 'SKU ' + sku + ' is not in QuickBooks' };
  const cur = (await qb.qbFetch('/item/' + encodeURIComponent(found.id))).Item;
  const want = String(description || '').trim();
  if (String(cur.Description || '').trim() === want) return { unchanged: true, qbId: String(cur.Id) };
  const payload = { Id: String(cur.Id), SyncToken: cur.SyncToken, sparse: true, Name: cur.Name, Description: want };
  const r = await recorded('Item', cur.Id, 'update', {
    by: opts.by || '', reason: opts.reason || 'description', gsmsRef: sku, label: cur.Name,
    before: cur, sent: payload, fields: ['description'], gsmsBefore: opts.gsmsBefore != null ? { description: opts.gsmsBefore } : null, gsmsAfter: { description: want }
  }, async () => (await qb.qbFetch('/item', { method: 'POST', body: payload })).Item);
  return { updated: true, qbId: String(cur.Id), change: r.name };
}

/* Lo que se ve en la lista: campo, antes -> despues. */
const CUSTOMER_FIELD_LABEL = { businessName: 'Business name', contactPerson: 'Contact', email: 'Email', phone: 'Phone', address: 'Address', suite: 'Suite', city: 'City', zip: 'Zip', description: 'Description' };
function changeLines(rec) {
  if (rec.entity === 'Customer' && rec.action === 'create') return [{ field: 'Customer', from: '', to: 'Created in QuickBooks' }];
  if (rec.entity === 'Customer') {
    const b = rec.before ? qb.customerView(rec.before) : {};
    const a = rec.after ? qb.customerView(rec.after) : {};
    return (rec.fields || []).map(k => ({ field: CUSTOMER_FIELD_LABEL[k] || k, from: b[k] || '', to: a[k] != null && rec.after ? a[k] : '' }));
  }
  return [{ field: 'Description', from: (rec.before && rec.before.Description) || '', to: (rec.after && rec.after.Description) || (rec.sent && rec.sent.Description) || '' }];
}

async function listChanges(limit) {
  const kids = await g.listChildren(folder());
  const names = kids.filter(k => k.isFile && NAME_RE.test(k.name)).map(k => k.name).sort().reverse().slice(0, limit || 60);
  const recs = [];
  for (let i = 0; i < names.length; i += 8) {
    const part = await Promise.all(names.slice(i, i + 8).map(async n => { try { return Object.assign({ name: n }, await readRecord(n)); } catch (e) { return null; } }));
    recs.push(...part.filter(Boolean));
  }
  const undone = new Set(recs.filter(r => r.undoOf).map(r => r.undoOf));
  return recs.map(r => ({
    name: r.name, at: r.at, entity: r.entity, action: r.action, by: r.by, reason: r.reason, gsmsRef: r.gsmsRef,
    label: r.label, error: r.error || '', undoOf: r.undoOf || '', undone: undone.has(r.name), lines: changeLines(r),
    canUndo: !r.error && !!r.after && !undone.has(r.name)
  }));
}

/* ---- Undo ---- */
function sameQbPart(k, a, b) {
  const pick = x => x == null ? null : (typeof x === 'object'
    ? JSON.stringify(Object.keys(x).filter(y => y !== 'Id' && y !== 'Lat' && y !== 'Long').sort().map(y => [y, String(x[y] == null ? '' : x[y]).trim()]))
    : String(x).trim());
  return pick(a) === pick(b);
}

async function undoChange(name, opts) {
  opts = opts || {};
  const rec = await readRecord(name);
  if (rec.env !== env()) { const e = new Error('This change belongs to the other QuickBooks (' + rec.env + ').'); e.status = 409; throw e; }
  if (rec.error || !rec.after) { const e = new Error('That change never reached QuickBooks, so there is nothing to undo.'); e.status = 400; throw e; }
  const entity = rec.entity;
  const path = entity === 'Customer' ? '/customer/' : '/item/';
  const cur = (await qb.qbFetch(path + encodeURIComponent(rec.qbId)))[entity];

  let payload;
  if (rec.action === 'create') {
    payload = { Id: String(cur.Id), SyncToken: cur.SyncToken, sparse: true, Active: false };
  } else {
    const keys = Object.keys(rec.sent || {}).filter(k => !['Id', 'SyncToken', 'sparse'].includes(k));
    /* Alguien lo cambio en QuickBooks despues? Se ensena antes de pisarlo. */
    const conflicts = keys.filter(k => !sameQbPart(k, cur[k], rec.after[k]));
    if (conflicts.length && !opts.force) return { conflict: true, fields: conflicts };
    payload = { Id: String(cur.Id), SyncToken: cur.SyncToken, sparse: true };
    const skipped = [];
    keys.forEach(k => {
      const was = rec.before ? rec.before[k] : undefined;
      if (was === undefined) {
        /* QuickBooks no tenia ese dato antes: texto -> vacio; correo -> no se puede borrar. */
        if (k === 'PrimaryEmailAddr') skipped.push('email');
        else if (k === 'PrimaryPhone') payload[k] = { FreeFormNumber: '' };
        else if (k === 'BillAddr') payload[k] = Object.assign(cur.BillAddr && cur.BillAddr.Id ? { Id: cur.BillAddr.Id } : {}, { Line1: '', Line2: '', City: '', PostalCode: '' });
        else payload[k] = '';
      } else payload[k] = k === 'BillAddr' && cur.BillAddr && cur.BillAddr.Id ? Object.assign({}, was, { Id: cur.BillAddr.Id }) : was;
    });
    if (entity === 'Item') payload.Name = cur.Name;
    if (skipped.length) opts.skipped = skipped;
  }

  const r = await recorded(entity, rec.qbId, 'undo', {
    by: opts.by || '', reason: 'undo', undoOf: name, gsmsRef: rec.gsmsRef, label: rec.label,
    before: cur, sent: payload, fields: rec.fields || [],
    gsmsBefore: rec.gsmsAfter || null, gsmsAfter: rec.gsmsBefore || null
  }, async () => (await qb.qbFetch(entity === 'Customer' ? '/customer' : '/item', { method: 'POST', body: payload }))[entity]);

  /* GSMS tambien a como estaba antes de ese cambio (si se sabe). */
  let gsms = null;
  if (rec.action !== 'create' && rec.gsmsBefore && opts.restoreGsms) {
    try { gsms = await opts.restoreGsms(rec); } catch (e) { gsms = { error: e.message }; }
  }
  return { success: true, change: r.name, gsms, skipped: opts.skipped || [] };
}

/* Revision diaria: todo cliente ACTIVO de GSMS que falte o este distinto en
   QuickBooks se manda (cubre importaciones masivas y avisos de Orders que
   no llegaron). Primero compara todo con una sola lectura de QuickBooks y
   solo manda los distintos, parando antes de pasarse del tiempo. */
async function reconcileAll(budgetMs) {
  const start = Date.now();
  if (!(await qb.isConnected())) return { skipped: 'QuickBooks is not connected' };
  const [rows, map, customers] = await Promise.all([lq.fetchAll(g.CLIENTS_LIST || 'Clients'), qb.getJsonSetting('qb_customer_id_map'), qb.listCustomers()]);
  const byId = new Map(customers.map(cu => [String(cu.Id), cu]));
  const byName = new Map();
  customers.forEach(cu => { const k = norm(cu.DisplayName); if (k && !byName.has(k)) byName.set(k, cu); });
  const truthy = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
  const todo = [];
  rows.forEach(it => {
    const f = it.fields || {};
    if (!f.ClientID || !String(f.Title || '').trim() || (f.Active !== undefined && !truthy(f.Active))) return;
    const c = appClient(f);
    const cu = (map[c.clientId] && byId.get(String(map[c.clientId]))) || byName.get(norm(c.businessName));
    if (!cu) { todo.push(c.clientId); return; }
    const view = qb.customerView(cu);
    if (FIELDS.some(k => !sameField(k, c[k], view[k]) && !((k === 'email' || k === 'phone') && !String(c[k] || '').trim()))) todo.push(c.clientId);
  });
  const results = [];
  for (const id of todo) {
    if (Date.now() - start > (budgetMs || 45000)) { results.push({ clientId: id, skipped: 'out of time, next run' }); continue; }
    try { results.push(Object.assign({ clientId: id }, await pushClient(id, { by: 'Daily QuickBooks check', reason: 'daily-check' }))); }
    catch (e) { results.push({ clientId: id, error: e.message }); }
  }
  return { checked: rows.length, different: todo.length, results };
}

module.exports = { reconcileAll, pushClient, pushItemDescription, listChanges, undoChange, customerDiffPayload, appClient, env, folder, NAME_RE };
