/* Simulacion de lib/backup-store.js (PLAN-RESPALDOS.md fase 1): SharePoint y
   QuickBooks falsos en memoria (require.cache), datos inventados. Correr con
   `npm install && node tests/backup-store.sim.js`: cada linea dice OK o FAIL. */
const path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
let nid = 5000;
const L = {
  Clients: [{ id: '1', fields: { Title: 'Equitable', ClientID: 'GS-1001', Address: '699 Walnut', City: 'Des Moines', Zip: '50309', Contact: 'a@x.com', Active: true } },
            { id: '2', fields: { Title: 'Bratney', ClientID: 'GS-1002', Address: '1 Main', City: 'Clive', Zip: '50325' } }],
  ClientContacts: [{ id: '10', fields: { Title: 'Ana', ClientID: 'GS-1001', Name: 'Ana', ContactType: 'Email', Value: 'ana@x.com', NotifyRecipient: true } },
                   { id: '11', fields: { Title: 'Bob', ClientID: 'GS-1002', Name: 'Bob', ContactType: 'Phone', Value: '515' } }],
  ClientAddresses: [{ id: '20', fields: { Title: 'Tower B', ClientID: 'GS-1001', Label: 'Tower B', Address: '700 Walnut', ContactId: '10', Archived: false } }],
  ClientHolidays: [{ id: '30', fields: { Title: 'x', ClientID: 'GS-1001', HolidayName: 'Christmas Day', IsOpen: false } }],
  ClientHistory: [],
  Orders: [{ id: '40', fields: { Title: 'Equitable', OrderID: 'GS-1001-1001', ClientID: 'GS-1001', Status: 'Assigned', Supervisor: 'Adalberto', OrderContactId: '10', Notes: 'Keys at desk' } },
           { id: '41', fields: { Title: 'Bratney', OrderID: 'GS-1002-1002', ClientID: 'GS-1002', Status: 'Received' } }],
  OrderServices: [{ id: '50', fields: { Title: 'Restroom cleaning', OrderID: 'GS-1001-1001', ServiceName: 'Restroom cleaning', SubOption: '111-13', Level: 'Level 2' } },
                  { id: '51', fields: { Title: 'Dusting', OrderID: 'GS-1001-1001', ServiceName: 'Dusting', SubOption: '111-59', Level: 'Level 1' } },
                  { id: '52', fields: { Title: 'Wall washing', OrderID: 'GS-1002-1002', ServiceName: 'Wall washing', SubOption: '110-18' } }],
  ServiceAssignments: [{ id: '60', fields: { Title: 'a', OrderID: 'GS-1001-1001', Category: 'Commercial', ServiceName: 'Restroom cleaning', AssignedTo: 'Adalberto', WorkStatus: 'Not Started' } }],
  Scheduling: [{ id: '70', fields: { Title: 's', OrderID: 'GS-1001-1001', PayrollNumber: 'EMP12', AssignedDate: '2026-10-02' } }],
  OrderHistory: [], Drafts: [], OrderDocuments: [],
  Settings: [{ id: '80', fields: { Title: 'qb_refresh_token', Key: 'qb_refresh_token', Value: 'SECRET-REFRESH' } },
             { id: '81', fields: { Title: 'DirectorPassword', Key: 'DirectorPassword', Value: 'SECRET-PW' } },
             { id: '82', fields: { Title: 'prod_qb_access_token#2', Key: 'prod_qb_access_token#2', Value: 'SECRET-ACCESS' } },
             { id: '83', fields: { Title: 'qb_customer_id_map', Key: 'qb_customer_id_map', Value: '{"GS-1001":"58"}' } }],
  Staff: [{ id: '90', fields: { Title: 'admin@gsocd.com', Email: 'admin@gsocd.com', Role: 'Developer' } }],
  ServiceTimes: [], ClientPackages: [], ServiceTemplates: [], Holidays: [], RecurringImportMatrix: [],
  RecurringServices: [], RecurringAssignments: [], RecurringLog: [], Techs: [], FieldEmployees: [], WeeklyHours: [], ReportUploads: [], TechPhotoLog: [], ContactMessages: []
  // PromoCodes / RedeemedPromoCodes: no existen (deben saltarse)
};
// campos de sistema que SharePoint agrega (no deben terminar en respaldos)
Object.values(L).forEach(rows => rows.forEach(r => Object.assign(r.fields, { '@odata.etag': '"x"', Modified: '2026-09-01', Created: '2026-08-01', AuthorLookupId: '6', _UIVersionString: '1.0', ContentType: 'Item' })));
const drive = {};
let uploads = 0, sessions = 0;
const matchFilter = (f, filter) => {
  if (!filter) return true;
  const terms = [...filter.matchAll(/fields\/(\w+) eq '((?:[^']|'')*)'/g)].map(m => [m[1], m[2].replace(/''/g, "'")]);
  return terms.some(([k, v]) => String(f[k] ?? '') === v);
};
const listNameOf = url => decodeURIComponent(String(url).split('/lists/')[1].split('/')[0].split('?')[0]);
const fake = {
  siteListPath: n => '/sites/x:/y:/lists/' + encodeURIComponent(n) + '/items',
  graphFetch: async (url, opts) => {
    if (/createUploadSession/.test(url)) { sessions++; const p = decodeURIComponent(url.split('root:/')[1].replace(':/createUploadSession', '')); return { uploadUrl: 'https://upload.test/' + encodeURIComponent(p) }; }
    const n = listNameOf(url);
    if (!L[n]) throw new Error('The specified list was not found');
    const q = String(url).split('?')[1] || ''; const fm = q.match(/\$filter=([^&]+)/);
    const filter = fm ? decodeURIComponent(fm[1]) : '';
    return { value: JSON.parse(JSON.stringify(L[n].filter(it => matchFilter(it.fields, filter)))) };
  },
  getDriveId: async () => 'd1',
  createListItem: async (n, f) => { const it = { id: String(++nid), fields: Object.assign({}, f) }; L[n].push(it); return it; },
  updateListItemByItemId: async (n, id, f) => { const it = L[n].find(x => x.id === String(id)); if (!it) throw new Error('404'); Object.keys(f).forEach(k => { if (f[k] === null) delete it.fields[k]; else it.fields[k] = f[k]; }); },
  deleteListItem: async (n, id) => { const i = L[n].findIndex(x => x.id === String(id)); if (i < 0) throw new Error('404'); L[n].splice(i, 1); },
  uploadFile: async (folder, name, buf) => { uploads++; drive[folder + '/' + name] = Buffer.from(buf); return { name }; },
  ensureFolder: async () => {},
  listChildren: async folder => Object.keys(drive).filter(k => k.startsWith(folder + '/') && !k.slice(folder.length + 1).includes('/')).map(k => ({ name: k.slice(folder.length + 1), id: k, isFile: true, size: drive[k].length })),
  downloadByPath: async p => drive[p] || null,
  deleteDriveItemById: async id => { delete drive[id]; },
  jsonResponse: (statusCode, body) => ({ statusCode, body: JSON.stringify(body) })
};
const graphProxy = new Proxy(fake, { get: (t, k) => k in t ? t[k] : (typeof k === 'string' && /_LIST$|_FOLDER$/.test(k) ? ({ CLIENTS_LIST: 'Clients', STAFF_LIST: 'Staff', SETTINGS_LIST: 'Settings', SERVICES_CATALOG_LIST: 'ServicesCatalog', SERVICE_TIMES_LIST: 'ServiceTimes' }[k] || k) : async () => []) });
require.cache[path.join(ROOT, 'lib/graph.js')] = { id: 'g', filename: 'g', loaded: true, exports: graphProxy };
// fetch global: solo para los PUT de upload session
const chunksBy = {};
global.fetch = async (url, init) => { const p = decodeURIComponent(url.replace('https://upload.test/', '')); const r = init.headers['Content-Range'].match(/bytes (\d+)-(\d+)\/(\d+)/); chunksBy[p] = chunksBy[p] || []; chunksBy[p].push(Buffer.from(init.body)); if (+r[2] + 1 === +r[3]) drive[p] = Buffer.concat(chunksBy[p]); return { ok: true, status: +r[2] + 1 === +r[3] ? 201 : 202 }; };

const bs = require(path.join(ROOT, 'lib/backup-store.js'));
const ok = (c, m) => console.log((c ? 'OK  ' : 'FAIL') + ' ' + m);
const bundleView = (kind, v) => { const b = bs.BUNDLES[kind]; return b.lists.map(l => L[l].filter(it => String(it.fields[b.key] ?? (l === 'Orders' ? it.fields.Title : '')) === v).map(it => { const f = Object.assign({}, it.fields); ['@odata.etag', 'Modified', 'Created', 'AuthorLookupId', '_UIVersionString', 'ContentType'].forEach(k => delete f[k]); return l + ':' + JSON.stringify(Object.keys(f).sort().map(k => [k, f[k]])); })).flat().sort(); };

(async () => {
  // 1) respaldos diarios
  for (const g of Object.keys(bs.GROUPS)) await bs.dailyGroup(g);
  const set = JSON.parse(zlib.gunzipSync(drive[Object.keys(drive).find(k => k.startsWith('Backups/Settings/'))]).toString());
  ok(set.rows.length === 1 && !JSON.stringify(set).includes('SECRET'), 'Settings backup has no secrets (' + set.rows.length + ' row)');
  const cl = JSON.parse(zlib.gunzipSync(drive[Object.keys(drive).find(k => k.startsWith('Backups/Clients/'))]).toString());
  ok(!JSON.stringify(cl).match(/odata|Modified|AuthorLookupId|_UIVersion/), 'system fields stripped');
  const missing = (await bs.dailyGroup('other')).find(r => r.list === 'PromoCodes');
  ok(missing && missing.missing, 'missing list skipped without error');
  const before = Object.keys(drive).length;
  for (const g of Object.keys(bs.GROUPS)) await bs.dailyGroup(g);
  ok(Object.keys(drive).length === before, 'second daily run saves nothing when nothing changed');
  const T1 = (await bs.listBackups('Clients'))[0].at, T1o = (await bs.listBackups('Orders'))[0].at;
  const origClient = bundleView('client', 'GS-1001'), origOrder = bundleView('order', 'GS-1001-1001'), origOther = bundleView('client', 'GS-1002').concat(bundleView('order', 'GS-1002-1002'));
  await new Promise(r => setTimeout(r, 20));

  // 2) alguien cambia cosas desde GSMS
  L.Clients[0].fields.Address = '999 WRONG'; delete L.Clients[0].fields.Zip;
  L.ClientContacts.splice(0, 1);                                   // borran el contacto al que apunta el edificio y la orden
  L.ClientAddresses.push({ id: '21', fields: { Title: 'Tower C', ClientID: 'GS-1001', Label: 'Tower C' } });
  L.ClientHolidays[0].fields.IsOpen = true;
  L.Orders[0].fields.Status = 'Cancelled'; L.Orders[0].fields.Supervisor = '';
  L.OrderServices.splice(L.OrderServices.findIndex(x => x.id === '51'), 1);
  L.OrderServices.push({ id: '53', fields: { Title: 'Extra', OrderID: 'GS-1001-1001', ServiceName: 'Extra', SubOption: '111-70' } });
  L.ServiceAssignments[0].fields.WorkStatus = 'Completed';
  L.Scheduling.splice(0, 1);
  L.Clients[1].fields.City = 'Urbandale';                         // otro cliente, NO se debe regresar
  for (const g of ['clients', 'orders']) await bs.dailyGroup(g);

  // 3) regresar el cliente GS-1001 a T1
  let w = JSON.stringify(L);
  const dry = await bs.restoreRecord('client', 'GS-1001', T1, { dryRun: true });
  ok(JSON.stringify(L) === w, 'client dry run writes nothing');
  ok(dry.found && dry.plans.find(p => p.list === 'ClientContacts').creates.length === 1 && dry.plans.find(p => p.list === 'ClientAddresses').deletes.length === 1, 'client dry run shows: recreate contact, remove Tower C');
  const rc = await bs.restoreRecord('client', 'GS-1001', T1, { by: 'admin@gsocd.com' });
  ok(rc.success, 'client restored (' + rc.changed + ' changes)');
  const newContact = L.ClientContacts.find(c => c.fields.ClientID === 'GS-1001');
  ok(newContact && L.ClientAddresses.find(a => a.fields.Label === 'Tower B').fields.ContactId === newContact.id, 'building points to the recreated contact (id ' + newContact.id + ')');
  const nowClient = bundleView('client', 'GS-1001').map(s => s.replace(/"ContactId","\d+"/, '"ContactId","10"'));
  ok(JSON.stringify(nowClient.filter(s => !s.startsWith('ClientContacts'))) === JSON.stringify(origClient.filter(s => !s.startsWith('ClientContacts'))) && bundleView('client','GS-1001').filter(s=>s.startsWith('ClientContacts')).length === 1, 'client bundle is exactly as before');
  ok(L.Clients[1].fields.City === 'Urbandale', 'other client untouched');
  ok(L.ClientHistory.some(h => h.fields.ChangeType === 'Restored from backup' && h.fields.ClientID === 'GS-1001'), 'client history note added');

  // 4) regresar la orden
  const ro = await bs.restoreRecord('order', 'GS-1001-1001', T1o, { by: 'admin@gsocd.com' });
  const nowOrder = bundleView('order', 'GS-1001-1001').map(s => s.replace('"OrderContactId","' + newContact.id + '"', '"OrderContactId","10"'));
  ok(ro.success && JSON.stringify(nowOrder) === JSON.stringify(origOrder), 'order + services + assignments + scheduling exactly as before');
  ok(L.Orders[0].fields.OrderContactId === newContact.id, 'restored order points to the recreated contact (' + newContact.id + '), not the old id');
  ok(L.OrderHistory.some(h => h.fields.FieldChanged === 'Office Change (Internal)' && h.fields.ChangeType === 'Restored from backup'), 'order history note is internal (client does not see it)');
  ok(JSON.stringify(bundleView('order', 'GS-1002-1002')) === JSON.stringify(origOther.filter(s => s.includes('GS-1002-1002'))), 'other order untouched');
  // deshacer el regreso: escoger el respaldo before-restore
  const dates = await bs.recordDates('order');
  ok(dates[0].reason === 'before-restore', 'undo point listed first: ' + dates[0].reason);
  try { await bs.restoreRecord('order', 'GS-9999', T1o, {}); ok(false, 'unknown order rejected'); } catch (e) { ok(/not in that backup/.test(e.message), 'unknown order rejected'); }

  // 5) regresar una lista de configuracion completa; Settings no toca llaves
  L.Settings.find(s => s.id === '83').fields.Value = '{}'; L.Settings.push({ id: '84', fields: { Title: 'new', Key: 'new', Value: '1' } });
  const sb = (await bs.listBackups('Settings')).find(b => b.reason === 'daily').name;
  const rl = await bs.restoreList('Settings', sb, { by: 'x' });
  ok(rl.success && L.Settings.find(s => s.id === '83').fields.Value === '{"GS-1001":"58"}' && !L.Settings.find(s => s.id === '84'), 'Settings restored');
  ok(['80', '81', '82'].every(id => L.Settings.find(s => s.id === id)), 'Settings secret rows never deleted');
  try { await bs.restoreList('Clients', 'x', {}); ok(false, 'Clients whole-list restore refused'); } catch (e) { ok(/one record at a time/.test(e.message), 'Clients whole-list restore refused'); }

  // 6) archivo grande -> upload session
  for (let i = 0; i < 2200; i++) L.OrderHistory.push({ id: String(100000 + i), fields: { Title: 'h' + i, OrderID: 'GS-1001-1001', Notes: crypto.randomBytes(2200).toString('hex') } });
  const big = await bs.backupList('OrderHistory', 'manual', 'x');
  const bigBuf = drive['Backups/OrderHistory/' + big.name];
  ok(sessions === 1 && bigBuf && bigBuf.length > 3900000 && JSON.parse(zlib.gunzipSync(bigBuf)).rows.length === L.OrderHistory.length, 'large backup (' + (bigBuf.length / 1e6).toFixed(1) + ' MB) uploaded in chunks and reads back');

  // 7) retencion 90 dias
  const oldName = st => 'Backups/Staff/Staff-' + st + '-daily-aaaaaaaaaa.json.gz';
  drive[oldName('2026-05-01T07-00-00-000Z')] = drive[Object.keys(drive).find(k => k.startsWith('Backups/Staff/'))];
  drive['Backups/Staff/Staff-2026-05-02T07-00-00-000Z-before-wipe-bbbbbbbbbb.json.gz'] = drive[oldName('2026-05-01T07-00-00-000Z')];
  const pr = await bs.pruneList('Staff');
  ok(pr === 1 && !drive[oldName('2026-05-01T07-00-00-000Z')] && drive['Backups/Staff/Staff-2026-05-02T07-00-00-000Z-before-wipe-bbbbbbbbbb.json.gz'], 'old daily pruned, before-* kept');

  // 8) acciones masivas guardan respaldo antes; cron pide secreto
  require.cache[path.join(ROOT, 'lib/quickbooks.js')] = { id: 'q', filename: 'q', loaded: true, exports: { getAllSendPerms: async () => ({}), sendPermsFrom: () => ({}) } };
  const { handler } = require(path.join(ROOT, 'developer-admin.js'));
  const call = async (action, extra) => { const r = await handler({ httpMethod: 'POST', body: JSON.stringify(Object.assign({ action, email: 'admin@gsocd.com' }, extra || {})) }); return { code: r.statusCode, body: JSON.parse(r.body) }; };
  const n0 = (await bs.listBackups('Clients')).length;
  const bu = await call('bulk-update-clients', { change: 'status', value: false, clients: [{ id: '2', clientId: 'GS-1002' }] });
  const cb = await bs.listBackups('Clients');
  ok(bu.code === 200 && cb.length === n0 + 1 && cb[0].reason === 'before-bulk-update' && L.Clients[1].fields.Active === false, 'bulk update saved a before-bulk-update backup first');
  const st = await call('backup-status');
  ok(st.code === 200 && st.body.lists.length === bs.ALL_LISTS.length, 'backup-status lists ' + st.body.lists.length + ' lists');
  process.env.CRON_SECRET = 'c';
  const cron = require(path.join(ROOT, 'cron-backups.js')).handlerFor('config');
  ok((await cron({ headers: {} })).statusCode === 401, 'cron without secret refused');
  ok((await cron({ headers: { authorization: 'Bearer c' } })).statusCode === 200, 'cron with secret runs');
  const router = require(path.join(ROOT, 'api/[...slug].js'));
  ok(typeof router === 'function', 'router loads with new slugs');
})().catch(e => { console.error('CRASH', e); process.exit(1); });
