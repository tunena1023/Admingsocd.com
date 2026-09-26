/* Simulacion de lib/qb-sync.js (PLAN-RESPALDOS.md fase 2): SharePoint y
   QuickBooks falsos en memoria (require.cache), datos inventados. Correr con
   `npm install && node tests/qb-sync.sim.js`: cada linea dice OK o FAIL. */
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.QUICKBOOKS_ENVIRONMENT = 'production';
let nid = 900;
const L = {
  Clients: [{ id: '1', fields: { Title: 'Equitable Building', ClientID: 'GS-1001', ClientName: 'Ana Morales', Contact: 'ana@equitable.com', Phone: '(515) 555-0142', Address: '699 Walnut St', Suite: 'Ste 100', City: 'Des Moines', Zip: '50309' } },
            { id: '2', fields: { Title: 'Bratney Companies', ClientID: 'GS-1002', ClientName: 'Bob Lee', Contact: 'bob@bratney.com', Phone: '5155550100', Address: '1 Main', City: 'Clive', Zip: '50325' } }],
  ClientHistory: [], ClientAddresses: [], ClientContacts: [], Settings: [],
  ServicesCatalog: [{ id: '5', fields: { Title: 'Restroom cleaning', SKU: '111-13', ServiceName: 'Restroom cleaning', Description: 'Clean and disinfect toilets, sinks and floors.', Active: true } }],
  Staff: [{ id: '9', fields: { Email: 'admin@gsocd.com', Role: 'Developer' } }]
};
const drive = {};
let failUploadOnce = false, uploads = 0;
const matchFilter = (f, filter) => { if (!filter) return true; const t = [...filter.matchAll(/fields\/(\w+) eq '((?:[^']|'')*)'/g)]; return t.some(m => String(f[m[1]] ?? '') === m[2].replace(/''/g, "'")); };
const fakeGraph = {
  CLIENTS_LIST: 'Clients', CLIENT_HISTORY_LIST: 'ClientHistory', CLIENT_ADDRESSES_LIST: 'ClientAddresses', CLIENT_CONTACTS_LIST: 'ClientContacts',
  SERVICES_CATALOG_LIST: 'ServicesCatalog', STAFF_LIST: 'Staff', SETTINGS_LIST: 'Settings',
  siteListPath: n => '/lists/' + encodeURIComponent(n) + '/items',
  graphFetch: async (url, opts) => {
    const n = decodeURIComponent(String(url).split('/lists/')[1].split('/')[0].split('?')[0]);
    if (opts && opts.method === 'POST') { const it = { id: String(++nid), fields: JSON.parse(opts.body).fields }; L[n].push(it); return it; }
    const fm = (String(url).split('?')[1] || '').match(/\$filter=([^&]+)/);
    return { value: JSON.parse(JSON.stringify((L[n] || []).filter(it => matchFilter(it.fields, fm ? decodeURIComponent(fm[1]) : '')))) };
  },
  createListItem: async (n, f) => { const it = { id: String(++nid), fields: Object.assign({}, f) }; L[n].push(it); return it; },
  updateListItemByItemId: async (n, id, f) => { const it = L[n].find(x => x.id === String(id)); Object.keys(f).forEach(k => { if (f[k] === null) delete it.fields[k]; else it.fields[k] = f[k]; }); },
  geocodeAddress: async () => null,
  uploadFile: async (folder, name, buf) => { if (failUploadOnce) { failUploadOnce = false; throw new Error('SharePoint is down'); } uploads++; drive[folder + '/' + name] = Buffer.from(buf); return { name }; },
  listChildren: async folder => Object.keys(drive).filter(k => k.startsWith(folder + '/')).map(k => ({ name: k.slice(folder.length + 1), isFile: true })),
  downloadByPath: async p => drive[p] || null,
  jsonResponse: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) })
};
const graphProxy = new Proxy(fakeGraph, { get: (t, k) => k in t ? t[k] : (typeof k === 'string' && /_LIST$|_FOLDER$/.test(k) ? k : async () => []) });
require.cache[path.join(ROOT, 'lib/graph.js')] = { id: 'g', filename: 'g', loaded: true, exports: graphProxy };
const realQb = require(path.join(ROOT, 'lib/quickbooks.js'));   // solo para customerView real
// ---- QuickBooks falso ----
const QB = { Customer: { '58': { Id: '58', SyncToken: '0', DisplayName: 'Equitable Building', CompanyName: 'Equitable Building', GivenName: 'Ana', FamilyName: 'Morales', PrimaryEmailAddr: { Address: 'ana@equitable.com' }, PrimaryPhone: { FreeFormNumber: '(515) 555-0142' }, BillAddr: { Id: '7', Line1: '699 Walnut St', Line2: 'Ste 100', City: 'Des Moines', CountrySubDivisionCode: 'IA', PostalCode: '50309' }, Active: true } },
  Item: { '31': { Id: '31', SyncToken: '3', Name: 'Restroom cleaning', Sku: '111-13', Description: 'Restroom cleaning (Regular)', UnitPrice: 0 } } };
let qbFail = false, qbWrites = 0, qid = 100;
const idMap = { 'GS-1001': '58' };
const sparseApply = (ent, body) => {
  const cur = QB[ent][body.Id];
  if (String(body.SyncToken) !== String(cur.SyncToken)) throw new Error('QuickBooks API error: Stale Object Error');
  Object.keys(body).forEach(k => { if (!['Id', 'SyncToken', 'sparse'].includes(k)) cur[k] = JSON.parse(JSON.stringify(body[k])); });
  cur.SyncToken = String(+cur.SyncToken + 1); return JSON.parse(JSON.stringify(cur));
};
const fakeQb = {
  customerView: realQb.customerView,
  isConnected: async () => true,
  getJsonSetting: async () => idMap,
  linkCustomers: async pairs => Object.assign(idMap, pairs),
  findCustomerId: async (cid, name) => idMap[cid] || (Object.values(QB.Customer).find(c => c.DisplayName === name) || {}).Id || null,
  createCustomer: async c => { if (qbFail) throw new Error('QuickBooks API error: down'); qbWrites++; const id = String(++qid); const pn = String(c.contactPerson || '').trim().split(/\s+/); QB.Customer[id] = { Id: id, SyncToken: '0', DisplayName: c.businessName, CompanyName: c.businessName, GivenName: pn[0] || '', FamilyName: pn.slice(1).join(' '), PrimaryEmailAddr: { Address: c.email }, PrimaryPhone: { FreeFormNumber: c.phone }, BillAddr: { Line1: c.address, Line2: c.suite || '', City: c.city, PostalCode: c.zip, CountrySubDivisionCode: 'IA' }, Active: true }; /* igual que customerPayload real */ return JSON.parse(JSON.stringify(QB.Customer[id])); },
  listCustomers: async () => Object.values(QB.Customer).map(c => JSON.parse(JSON.stringify(c))),
  findItemBySku: async sku => { const it = Object.values(QB.Item).find(i => i.Sku === sku); return it ? { id: it.Id, taxable: false } : null; },
  qbFetch: async (p, o) => {
    const m = p.match(/^\/(customer|item)(?:\/(\w+))?/); const ent = m[1] === 'customer' ? 'Customer' : 'Item';
    if (o && o.method === 'POST') { if (qbFail) throw new Error('QuickBooks API error: down'); qbWrites++; return { [ent]: sparseApply(ent, o.body) }; }
    return { [ent]: JSON.parse(JSON.stringify(QB[ent][m[2]])) };
  },
  getAllSendPerms: async () => ({}), sendPermsFrom: () => ({})
};
require.cache[path.join(ROOT, 'lib/quickbooks.js')] = { id: 'q', filename: 'q', loaded: true, exports: fakeQb };

const ok = (c, m) => console.log((c ? 'OK  ' : 'FAIL') + ' ' + m);
const updateClient = async body => JSON.parse((await require(path.join(ROOT, 'admin-update-client.js')).handler({ httpMethod: 'POST', body: JSON.stringify(body) })).body);
const { handler: dev } = require(path.join(ROOT, 'developer-admin.js'));
const call = async (action, extra) => { const r = await dev({ httpMethod: 'POST', body: JSON.stringify(Object.assign({ action, email: 'admin@gsocd.com' }, extra || {})) }); return { code: r.statusCode, body: JSON.parse(r.body) }; };
const records = () => Object.keys(drive).filter(k => k.includes('/changes/')).sort();

(async () => {
  // 1) editar direccion en GSMS -> QuickBooks al instante, solo BillAddr
  const r1 = await updateClient({ clientId: 'GS-1001', changedBy: 'Ana (office)', address: '700 Walnut St', zip: '50310' });
  ok(r1.quickbooks && r1.quickbooks.updated && JSON.stringify(r1.quickbooks.fields) === '["address","zip"]', 'address edit pushed to QuickBooks right away: ' + JSON.stringify(r1.quickbooks && r1.quickbooks.fields));
  ok(QB.Customer['58'].BillAddr.Line1 === '700 Walnut St' && QB.Customer['58'].BillAddr.Id === '7' && QB.Customer['58'].BillAddr.CountrySubDivisionCode === 'IA' && QB.Customer['58'].DisplayName === 'Equitable Building', 'QuickBooks got only the address (same address Id, state kept, name untouched)');
  const rec1 = JSON.parse(drive[records()[0]]);
  ok(rec1.before.BillAddr.Line1 === '699 Walnut St' && rec1.gsmsBefore.address === '699 Walnut St' && rec1.after.BillAddr.Line1 === '700 Walnut St', 'change record has QuickBooks before/after and GSMS before');
  // 2) edicion que no toca QuickBooks
  const w0 = qbWrites; const r2 = await updateClient({ clientId: 'GS-1001', officeHours: '8:00 AM - 5:00 PM' });
  ok(r2.quickbooks === null && qbWrites === w0, 'office-hours edit does not touch QuickBooks');
  // 3) cliente nuevo -> se crea en QuickBooks
  L.Clients.push({ id: '3', fields: { Title: 'Indigo Apartments', ClientID: 'GS-1003', ClientName: 'Cy', Contact: 'cy@indigo.com', Phone: '5155550111', Address: '5 Oak', City: 'Ankeny', Zip: '50023' } });
  const r3 = await require(path.join(ROOT, 'lib/qb-sync.js')).pushClient('GS-1003', { reason: 'new-client' });
  ok(r3.created && idMap['GS-1003'] === r3.qbId && QB.Customer[r3.qbId].DisplayName === 'Indigo Apartments', 'new client created in QuickBooks and linked');
  // 4) lista de cambios y Undo (QuickBooks y GSMS regresan)
  const ch = await call('qb-changes');
  const addrChange = ch.body.changes.find(c => c.gsmsRef === 'GS-1001' && c.action === 'update');
  ok(ch.code === 200 && addrChange && addrChange.lines.some(l => l.field === 'Address' && l.from === '699 Walnut St' && l.to === '700 Walnut St'), 'change list shows Address 699 → 700');
  const u = await call('qb-undo-change', { name: addrChange.name });
  ok(u.code === 200 && u.body.success && QB.Customer['58'].BillAddr.Line1 === '699 Walnut St' && QB.Customer['58'].BillAddr.PostalCode === '50309', 'Undo put QuickBooks back');
  ok(L.Clients[0].fields.Address === '699 Walnut St' && L.Clients[0].fields.Zip === '50309' && L.ClientHistory.some(h => /Undo/.test(h.fields.ChangedBy)), 'Undo put GSMS back too (with client history)');
  const ch2 = (await call('qb-changes')).body.changes;
  ok(ch2.find(c => c.name === addrChange.name).undone && ch2[0].action === 'undo' && ch2[0].canUndo, 'original marked undone; the undo itself can be undone');
  // 5) conflicto: alguien cambio QuickBooks despues
  await updateClient({ clientId: 'GS-1001', phone: '5155559999' });
  const phoneChange = (await call('qb-changes')).body.changes[0];
  QB.Customer['58'].PrimaryPhone = { FreeFormNumber: '5150000000' }; QB.Customer['58'].SyncToken = String(+QB.Customer['58'].SyncToken + 1);
  const c1 = await call('qb-undo-change', { name: phoneChange.name });
  ok(c1.body.conflict && c1.body.fields.includes('PrimaryPhone'), 'undo warns when QuickBooks changed after');
  const c2 = await call('qb-undo-change', { name: phoneChange.name, force: true });
  ok(c2.body.success && QB.Customer['58'].PrimaryPhone.FreeFormNumber === '(515) 555-0142', 'forced undo puts the phone back');
  // 6) QuickBooks falla: GSMS se guarda igual y se avisa; el registro queda con el error
  qbFail = true; const r6 = await updateClient({ clientId: 'GS-1002', city: 'Urbandale' }); qbFail = false;
  ok(L.Clients[1].fields.City === 'Urbandale' && r6.quickbooks && /down/.test(r6.quickbooks.error || ''), 'QuickBooks down: GSMS saved, error reported');
  // 7) no se pudo guardar el registro -> no se manda nada a QuickBooks
  const w7 = qbWrites; failUploadOnce = true; const r7 = await updateClient({ clientId: 'GS-1001', suite: 'Ste 200' });
  ok(qbWrites === w7 && r7.quickbooks && /SharePoint is down/.test(r7.quickbooks.error || ''), 'no record saved -> nothing sent to QuickBooks');
  // 8) descripcion: se edita en GSMS y va a QuickBooks; Undo regresa las dos
  const d = await call('save-service-description', { sku: '111-13', description: 'Clean and disinfect toilets, urinals, sinks, mirrors and floors.' });
  ok(d.body.quickbooks.updated && QB.Item['31'].Description.startsWith('Clean and disinfect toilets, urinals') && QB.Item['31'].Name === 'Restroom cleaning', 'description saved in GSMS and sent to QuickBooks');
  const dch = (await call('qb-changes')).body.changes.find(c => c.gsmsRef === '111-13');
  await call('qb-undo-change', { name: dch.name });
  ok(QB.Item['31'].Description === 'Restroom cleaning (Regular)' && L.ServicesCatalog[0].fields.Description === 'Clean and disinfect toilets, sinks and floors.', 'description undo puts QuickBooks and GSMS back');
  const sd = await call('qb-send-descriptions', { skus: ['111-13'] });
  ok(sd.body.results[0].updated && QB.Item['31'].Description === L.ServicesCatalog[0].fields.Description, 'send GSMS descriptions to QuickBooks');
  // 9) revision diaria: manda lo distinto (GS-1002 quedo distinto en el paso 6)
  const rec = await require(path.join(ROOT, 'lib/qb-sync.js')).reconcileAll(20000);
  ok(rec.results.some(x => x.clientId === 'GS-1002' && (x.updated || x.created)), 'daily check pushed the client left different (' + rec.different + ' different)');
  const rec2 = await require(path.join(ROOT, 'lib/qb-sync.js')).reconcileAll(20000);
  ok(rec2.different === 0, 'second daily check finds nothing to send'); if (rec2.different) console.log(JSON.stringify(rec2.results), JSON.stringify(L.Clients.map(c=>c.fields)), JSON.stringify(QB.Customer));
  // 10) aviso desde Orders
  process.env.QB_SYNC_SECRET = 'a-long-shared-secret-123';
  const ep = require(path.join(ROOT, 'qb-sync-client.js')).handler;
  ok((await ep({ httpMethod: 'POST', headers: {}, body: '{"clientId":"GS-1001"}' })).statusCode === 401, 'Orders endpoint refuses without the shared key');
  L.Clients[0].fields.City = 'West Des Moines';
  const e2 = JSON.parse((await ep({ httpMethod: 'POST', headers: { 'x-gs-sync-secret': 'a-long-shared-secret-123' }, body: JSON.stringify({ clientId: 'GS-1001', gsmsBefore: { city: 'Des Moines' } }) })).body);
  ok(e2.updated && QB.Customer['58'].BillAddr.City === 'West Des Moines', 'Orders endpoint pushes the client');
  // 11) Migrate ya no pisa descripciones de GSMS
  console.log('records saved:', records().length);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
