/* ============================================================
   lib/backup-store.js -- respaldos de TODAS las listas de GSMS
   (26/09/2026, el dueño: "que toda la informacion este protegida por
   cualquier cambio que se haga desde GSMS", "asegurarme de no perder
   info"). Plan completo: PLAN-RESPALDOS.md.

   Cada respaldo es una foto de una lista completa, comprimida, en
     Documents/Backups/<Lista>/<Lista>-<fecha>-<motivo>-<hash>.json.gz
   motivo: daily (cron, solo si la lista cambio), manual (boton), o
   before-<accion> (justo antes de algo masivo/peligroso). El hash va en el
   nombre para saber si la lista cambio sin bajar el archivo.
   Se quedan 90 dias (decision del dueño); siempre se queda el mas nuevo
   de cada lista y todos los before-*.

   Regresar:
   - restoreList: una lista de CONFIGURACION completa a una fecha.
   - restoreRecord: UN cliente (Clients + ClientAddresses + ClientContacts
     + ClientHolidays) o UNA orden (Orders + OrderServices +
     ServiceAssignments + Scheduling) a una fecha, "todo junto, que parezca
     que no cambio nada" (el dueño). Antes de regresar se guarda como
     estaba, para poder deshacer el regreso.

   NUNCA se guardan llaves: renglones de Settings con token/secret/
   password/oauth en la Key, ni las listas TechDeviceTokens y
   PushSubscriptions (no estan en GROUPS). ServicesCatalog tiene lo suyo
   en lib/catalog-backup.js.
============================================================ */
const zlib = require('zlib');
const crypto = require('crypto');
const g = require('./graph');
const lq = require('./list-query');

const ROOT = 'Backups';
const RETENTION_DAYS = 90;

/* Un cron diario por grupo (vercel.json), para que ninguno pase de los
   60 s de la funcion. */
const GROUPS = {
  config: ['ServiceTimes', 'ClientPackages', 'ServiceTemplates', 'Holidays', 'Staff', 'RecurringImportMatrix', 'Settings'],
  clients: ['Clients', 'ClientAddresses', 'ClientContacts', 'ClientHolidays', 'ClientHistory'],
  orders: ['Orders', 'OrderServices', 'ServiceAssignments', 'Scheduling', 'Drafts', 'OrderDocuments'],
  history: ['OrderHistory'],
  other: ['RecurringServices', 'RecurringAssignments', 'RecurringLog', 'Techs', 'FieldEmployees', 'WeeklyHours', 'ReportUploads', 'TechPhotoLog', 'PromoCodes', 'RedeemedPromoCodes', 'ContactMessages']
};
const ALL_LISTS = [].concat(...Object.values(GROUPS));
/* Listas que se regresan COMPLETAS (configuracion). Las demas: por registro. */
const CONFIG_LISTS = GROUPS.config.slice();

/* Registros que se regresan "todo junto". key = columna que los une. */
const BUNDLES = {
  client: { key: 'ClientID', main: 'Clients', lists: ['Clients', 'ClientContacts', 'ClientAddresses', 'ClientHolidays'], history: 'ClientHistory' },
  order: { key: 'OrderID', main: 'Orders', lists: ['Orders', 'OrderServices', 'ServiceAssignments', 'Scheduling'], history: 'OrderHistory' }
};

/* Columnas que pone SharePoint solo (no se guardan ni se escriben). */
const SYSTEM_FIELDS = new Set(['id', 'ContentType', 'Edit', 'LinkTitle', 'LinkTitleNoMenu', 'Attachments', 'ItemChildCount',
  'FolderChildCount', 'AuthorLookupId', 'EditorLookupId', 'AppAuthorLookupId', 'AppEditorLookupId', 'Modified', 'Created',
  'DocIcon', 'ComplianceAssetId']);
const SECRET_KEY_RE = /token|secret|password|oauth/i;

function cleanFields(f) {
  const out = {};
  Object.keys(f || {}).sort().forEach(k => {
    if (k.startsWith('@') || k.startsWith('_') || k.includes('@') || SYSTEM_FIELDS.has(k)) return;
    out[k] = f[k];
  });
  return out;
}
function isSecretRow(list, f) {
  return list === 'Settings' && SECRET_KEY_RE.test(String((f && (f.Key || f.Title)) || ''));
}
function snapshotRows(list, items) {
  return items.filter(it => it.fields && !isSecretRow(list, it.fields))
    .map(it => ({ id: String(it.id), fields: cleanFields(it.fields) }))
    .sort((a, b) => (Number(a.id) - Number(b.id)) || a.id.localeCompare(b.id));
}
const hashRows = rows => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 10);
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');
/* 2026-09-26T11-00-05-123Z -> Date */
function stampToDate(st) {
  const m = String(st).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d+)Z$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7])) : null;
}
const nameRe = list => new RegExp('^' + list + '-([0-9TZ-]+Z)-([a-z-]+)-([0-9a-f]{10})\\.json\\.gz$');
const folderOf = list => ROOT + '/' + list;
const isMissingList = e => /not ?found|does not exist|itemNotFound/i.test(String(e && e.message));

async function readList(list) {
  return lq.fetchAll(list);
}

/* Subida: PUT simple hasta ~3.9 MB; mas grande, upload session en trozos. */
async function putFile(folder, name, buf) {
  if (buf.length <= 3900000) return g.uploadFile(folder, name, buf, 'application/gzip');
  await g.ensureFolder(folder);
  const driveId = await g.getDriveId();
  const path = '/drives/' + driveId + '/root:/' + folder.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(name) + ':/createUploadSession';
  const session = await g.graphFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) });
  const CHUNK = 320 * 1024 * 12; /* multiplo de 320 KiB, como pide Graph */
  for (let i = 0; i < buf.length; i += CHUNK) {
    const part = buf.subarray(i, Math.min(i + CHUNK, buf.length));
    const res = await fetch(session.uploadUrl, { method: 'PUT', headers: { 'Content-Range': 'bytes ' + i + '-' + (i + part.length - 1) + '/' + buf.length }, body: part });
    if (!res.ok) throw new Error('Backup upload failed (' + res.status + ')');
  }
  return { name };
}

async function listBackups(list) {
  const re = nameRe(list);
  const kids = await g.listChildren(folderOf(list));
  return kids.filter(k => k.isFile && re.test(k.name)).map(k => {
    const m = k.name.match(re);
    return { list, name: k.name, at: (stampToDate(m[1]) || new Date(0)).toISOString(), reason: m[2], hash: m[3], size: k.size, id: k.id };
  }).sort((a, b) => b.at.localeCompare(a.at));
}

async function readBackup(list, name) {
  if (!nameRe(list).test(String(name || ''))) { const e = new Error('Unknown backup.'); e.status = 400; throw e; }
  const buf = await g.downloadByPath(folderOf(list) + '/' + name);
  if (!buf) { const e = new Error('Backup not found.'); e.status = 404; throw e; }
  let snap;
  try { snap = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); } catch (e) { snap = null; }
  if (!snap || !Array.isArray(snap.rows)) { const e = new Error('This backup file cannot be read.'); e.status = 400; throw e; }
  return snap;
}

/* Respaldo de UNA lista. Si es igual al ultimo, no se guarda otro (sirve
   el anterior). items: los renglones ya leidos, para no leer dos veces. */
async function backupList(list, reason, by, items, stamp) {
  if (!/^[a-z-]+$/.test(reason)) throw new Error('Bad backup reason.');
  let rowsIn = items;
  if (!rowsIn) {
    try { rowsIn = await readList(list); }
    catch (e) { if (isMissingList(e)) return { list, saved: false, missing: true }; throw e; }
  }
  const rows = snapshotRows(list, rowsIn);
  const hash = hashRows(rows);
  const last = (await listBackups(list))[0];
  if (last && last.hash === hash) return { list, saved: false, same: last.name, count: rows.length };
  const name = list + '-' + (stamp || stampNow()) + '-' + reason + '-' + hash + '.json.gz';
  const payload = { version: 1, list, createdAt: new Date().toISOString(), by: by || '', reason, count: rows.length, rows };
  await putFile(folderOf(list), name, zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
  return { list, saved: true, name, count: rows.length };
}

/* Varias listas con la MISMA hora en el nombre: asi "como estaba todo a
   esa hora" junta los archivos correctos de cada lista (con horas
   distintas, regresar un cliente podia tomar sus contactos de otro dia).
   Truena si una falla (quien llama decide si sigue con su accion o no). */
async function backupLists(lists, reason, by) {
  const stamp = stampNow();
  const results = [];
  for (const list of lists) results.push(await backupList(list, reason, by, null, stamp));
  return results;
}

async function pruneList(list, days) {
  const cutoff = Date.now() - (days || RETENTION_DAYS) * 864e5;
  const all = await listBackups(list);
  const old = all.slice(1).filter(b => !b.reason.startsWith('before-') && new Date(b.at).getTime() < cutoff);
  for (const b of old) { try { await g.deleteDriveItemById(b.id); } catch (e) { /* se intenta otra vez manana */ } }
  return old.length;
}

/* Cron: un grupo, solo lo que cambio, y limpieza de lo viejo. */
async function dailyGroup(group) {
  const lists = GROUPS[group];
  if (!lists) throw new Error('Unknown backup group: ' + group);
  const stamp = stampNow();
  const results = [];
  for (const list of lists) {
    try {
      const r = await backupList(list, 'daily', 'Daily backup', null, stamp);
      r.pruned = await pruneList(list);
      results.push(r);
    } catch (e) { results.push({ list, error: e.message }); }
  }
  return results;
}

async function status() {
  const out = [];
  for (let i = 0; i < ALL_LISTS.length; i += 6) {
    const part = await Promise.all(ALL_LISTS.slice(i, i + 6).map(async list => {
      const b = await listBackups(list);
      const group = Object.keys(GROUPS).find(k => GROUPS[k].includes(list));
      return { list, group, config: CONFIG_LISTS.includes(list), count: b.length, last: b[0] ? { name: b[0].name, at: b[0].at, reason: b[0].reason } : null };
    }));
    out.push(...part);
  }
  return out;
}

/* ---- Comparar / aplicar renglones ---- */
function sameValue(a, b) {
  const n = v => (v === undefined || v === '' ? null : v);
  a = n(a); b = n(b);
  if (a === null || b === null) return a === b;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}
/* Que cambiar en `cur` para que quede como `want` (solo columnas normales). */
function fieldPatch(curFields, wantFields) {
  const cur = cleanFields(curFields), want = cleanFields(wantFields);
  const patch = {}, changes = [];
  new Set([...Object.keys(cur), ...Object.keys(want)]).forEach(k => {
    if (!sameValue(cur[k], want[k])) {
      patch[k] = want[k] === undefined ? null : want[k];
      changes.push({ field: k, from: cur[k] === undefined ? '' : cur[k], to: want[k] === undefined ? '' : want[k] });
    }
  });
  return { patch, changes };
}

/* Plan de una lista: quedar como `wantRows` partiendo de `curItems`.
   keepSecret: renglones de Settings con llaves nunca se tocan. */
function planRows(list, curItems, wantRows) {
  const byId = new Map(curItems.filter(it => it.fields).map(it => [String(it.id), it]));
  const wantIds = new Set(wantRows.map(r => String(r.id)));
  const updates = [], creates = [], deletes = [];
  wantRows.forEach(r => {
    const cur = byId.get(String(r.id));
    if (!cur) { creates.push({ oldId: String(r.id), fields: cleanFields(r.fields) }); return; }
    const { patch, changes } = fieldPatch(cur.fields, r.fields);
    if (changes.length) updates.push({ id: String(cur.id), patch, changes, title: cur.fields.Title || '' });
  });
  curItems.forEach(it => {
    if (!it.fields || wantIds.has(String(it.id)) || isSecretRow(list, it.fields)) return;
    deletes.push({ id: String(it.id), title: it.fields.Title || '' });
  });
  return { list, updates, creates, deletes };
}

async function applyPlan(plan, idMap) {
  const failed = [];
  let done = 0;
  const run = async (arr, fn) => { for (let i = 0; i < arr.length; i += 8) await Promise.all(arr.slice(i, i + 8).map(async x => { try { await fn(x); done++; } catch (e) { failed.push(plan.list + ' ' + (x.id || x.oldId) + ': ' + e.message); } })); };
  await run(plan.creates, async c => {
    const fields = Object.assign({}, c.fields);
    remapRefs(plan.list, fields, idMap);
    const created = await g.createListItem(plan.list, fields);
    if (idMap) idMap[plan.list + ':' + c.oldId] = String(created.id);
  });
  await run(plan.updates, async u => {
    const patch = Object.assign({}, u.patch);
    remapRefs(plan.list, patch, idMap);
    await g.updateListItemByItemId(plan.list, u.id, patch);
  });
  await run(plan.deletes, d => g.deleteListItem(plan.list, d.id));
  return { done, failed };
}

/* Un renglon que se volvio a crear tiene id NUEVO (SharePoint no deja
   escoger el id). Las columnas que apuntan a el se corrigen con un mapa
   id viejo -> id nuevo que se guarda junto a los respaldos
   (Backups/id-map.json), asi tambien se corrige lo que se regrese despues
   (p. ej. una orden guardada con el contacto viejo). */
const REFS = [
  { list: 'ClientAddresses', field: 'ContactId', to: 'ClientContacts' },
  { list: 'Orders', field: 'OrderContactId', to: 'ClientContacts' },
  { list: 'Orders', field: 'BuildingId', to: 'ClientAddresses' }
];
const ID_MAP_PATH = ROOT + '/id-map.json';
async function loadIdMap() {
  const buf = await g.downloadByPath(ID_MAP_PATH);
  try { return buf ? JSON.parse(buf.toString('utf8')) : {}; } catch (e) { return {}; }
}
async function saveIdMap(map) {
  await g.uploadFile(ROOT, 'id-map.json', Buffer.from(JSON.stringify(map)), 'application/json');
}
function mapped(idMap, target, id) {
  let cur = String(id), hops = 0;
  while (idMap && idMap[target + ':' + cur] && hops++ < 20) cur = idMap[target + ':' + cur];
  return cur;
}
function remapRefs(list, fields, idMap) {
  if (!idMap) return;
  REFS.filter(r => r.list === list).forEach(r => {
    if (fields[r.field]) { const m = mapped(idMap, r.to, fields[r.field]); if (m !== String(fields[r.field])) fields[r.field] = m; }
  });
}
/* Despues de recrear renglones: corrige referencias en los renglones que
   ya existian (no salen en el plan porque "no cambiaron"). */
async function fixDanglingRefs(lists, key, value, idMap) {
  let fixed = 0;
  for (const r of REFS.filter(x => lists.includes(x.list))) {
    const rows = await lq.fetchByValues(r.list, key, [value]);
    for (const it of rows) {
      const v = it.fields && it.fields[r.field];
      if (!v) continue;
      const m = mapped(idMap, r.to, v);
      if (m !== String(v)) { await g.updateListItemByItemId(r.list, it.id, { [r.field]: m }); fixed++; }
    }
  }
  return fixed;
}

const summarizePlan = p => ({
  list: p.list,
  updates: p.updates.map(u => ({ id: u.id, title: u.title, changes: u.changes })),
  creates: p.creates.map(c => ({ oldId: c.oldId, title: c.fields.Title || '' })),
  deletes: p.deletes.map(d => ({ id: d.id, title: d.title }))
});

/* ---- Regresar una lista de configuracion completa ---- */
async function restoreList(list, name, opts) {
  opts = opts || {};
  if (!CONFIG_LISTS.includes(list)) { const e = new Error(list + ' is restored one record at a time, not as a whole list.'); e.status = 400; throw e; }
  const snap = await readBackup(list, name);
  const cur = await readList(list);
  const plan = planRows(list, cur, snap.rows);
  if (opts.dryRun) return { dryRun: true, backupAt: snap.createdAt, plan: summarizePlan(plan) };
  const before = await backupList(list, 'before-restore', opts.by, cur);
  const res = await applyPlan(plan, null);
  return { success: !res.failed.length, before: before.name || before.same, changed: res.done, failed: res.failed };
}

/* ---- Regresar UN cliente o UNA orden, todo junto ---- */
function keyOf(list, f, key) {
  if (f[key] !== undefined && f[key] !== null && f[key] !== '') return String(f[key]);
  return list === 'Orders' ? String(f.Title || '') : '';
}

/* Respaldo de cada lista del paquete tal como estaba en `at` (el mas nuevo
   que no pase de esa fecha). */
async function bundleAt(kind, at) {
  const b = BUNDLES[kind];
  const t = new Date(at).getTime();
  const out = {};
  for (const list of b.lists) {
    const pick = (await listBackups(list)).find(x => new Date(x.at).getTime() <= t);
    if (!pick) { const e = new Error('There is no backup of ' + list + ' from that date or before.'); e.status = 404; throw e; }
    out[list] = { name: pick.name, snap: await readBackup(list, pick.name) };
  }
  return out;
}

/* Fechas para escoger: los respaldos de la lista principal (Clients u Orders). */
async function recordDates(kind) {
  const b = BUNDLES[kind];
  if (!b) { const e = new Error('Unknown record type.'); e.status = 400; throw e; }
  return (await listBackups(b.main)).map(x => ({ at: x.at, reason: x.reason, name: x.name }));
}

async function restoreRecord(kind, value, at, opts) {
  opts = opts || {};
  const b = BUNDLES[kind];
  if (!b) { const e = new Error('Unknown record type.'); e.status = 400; throw e; }
  value = String(value || '').trim();
  if (!value) { const e = new Error('Missing ' + b.key + '.'); e.status = 400; throw e; }
  const bundle = await bundleAt(kind, at);
  const plans = [], curByList = {};
  for (const list of b.lists) {
    const cur = (await lq.fetchByValues(list, b.key, [value]))
      .concat(list === 'Orders' ? await lq.fetchByValues(list, 'Title', [value]).catch(() => []) : []);
    const seen = new Set();
    curByList[list] = cur.filter(it => it.fields && keyOf(list, it.fields, b.key) === value && !seen.has(String(it.id)) && seen.add(String(it.id)));
    const want = bundle[list].snap.rows.filter(r => keyOf(list, r.fields, b.key) === value);
    plans.push(planRows(list, curByList[list], want));
  }
  const empty = plans.every(p => !p.updates.length && !p.creates.length && !p.deletes.length);
  const inBackup = plans[0].creates.length + plans[0].updates.length > 0 ||
    bundle[b.main].snap.rows.some(r => keyOf(b.main, r.fields, b.key) === value);
  if (opts.dryRun) {
    return { dryRun: true, kind, value, at, found: inBackup, nothingToDo: empty, plans: plans.map(summarizePlan), files: Object.fromEntries(b.lists.map(l => [l, bundle[l].name])) };
  }
  if (!inBackup) { const e = new Error(value + ' is not in that backup.'); e.status = 404; throw e; }
  if (empty) return { success: true, changed: 0, failed: [] };

  /* Antes de regresar: foto de TODAS las listas del paquete (asi el regreso
     tambien se puede deshacer escogiendo la fecha de este respaldo). */
  await backupLists(b.lists, 'before-restore', opts.by);
  const idMap = await loadIdMap();
  const before = JSON.stringify(idMap);
  let changed = 0;
  const failed = [];
  for (const p of plans) { const r = await applyPlan(p, idMap); changed += r.done; failed.push(...r.failed); }
  if (JSON.stringify(idMap) !== before) { try { await saveIdMap(idMap); } catch (e) { failed.push('id map: ' + e.message); } }
  try {
    /* Cliente: sus edificios Y sus ordenes (fuera del paquete) apuntan a sus contactos/edificios. */
    changed += await fixDanglingRefs(kind === 'client' ? ['ClientAddresses', 'Orders'] : ['Orders'], kind === 'client' ? 'ClientID' : 'OrderID', value, idMap);
  } catch (e) { failed.push('references: ' + e.message); }

  /* Rastro interno (no lo ve el cliente: 'Office Change (Internal)'). */
  const when = new Date(at).toISOString();
  const note = 'Restored from the backup of ' + when.slice(0, 16).replace('T', ' ') + ' UTC by ' + (opts.by || 'Admin') + '.';
  try {
    if (kind === 'order') await g.createListItem(b.history, { Title: value + '-restore-' + Date.now(), OrderID: value, ChangeType: 'Restored from backup', FieldChanged: 'Office Change (Internal)', ChangedBy: opts.by || 'Admin', ChangeDate: new Date().toISOString(), Notes: note });
    else await g.createListItem(b.history, { Title: value, ClientID: value, ChangeType: 'Restored from backup', FieldChanged: 'Restore', ChangedBy: opts.by || 'Admin', ChangeDate: new Date().toISOString(), Notes: note });
  } catch (e) { failed.push('history note: ' + e.message); }
  return { success: !failed.length, changed, failed };
}

module.exports = {
  ROOT, RETENTION_DAYS, GROUPS, ALL_LISTS, CONFIG_LISTS, BUNDLES,
  cleanFields, snapshotRows, isSecretRow,
  listBackups, readBackup, backupList, backupLists, pruneList, dailyGroup, status,
  restoreList, recordDates, restoreRecord, planRows
};
