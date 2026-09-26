/* ============================================================
   lib/catalog-backup.js -- respaldos del catalogo de servicios
   (ServicesCatalog). 26/09/2026, pedido del dueño: "que tenga forma de
   regresar a lo anterior si algo falla", "que se guarde uno automatico
   cada 24 horas, solo si hay cambios, y que me deje seleccionar cual
   back up quiero usar".

   Cada respaldo es una foto de TODA la lista como JSON en
   Documents/Backups/ServicesCatalog/catalog-<fecha>-<motivo>.json:
     before-qb-migrate  -- justo antes de Developer > Migrate from QuickBooks
     before-restore     -- justo antes de regresar a otro respaldo
     daily              -- el cron diario, SOLO si el catalogo cambio desde
                           el ultimo respaldo (cualquier motivo)

   Restore regresa cada servicio a como estaba en la foto -- solo los
   campos que cambian el import/Migrate; areas, paquetes, precios por
   nivel y Qty no se tocan -- y apaga (no borra) lo que se creo despues.
   Solo toca el catalogo: las ordenes guardan su propia copia de cada
   servicio y no cambian.
============================================================ */
const { SERVICES_CATALOG_LIST, uploadFile, listChildren, downloadByPath, updateListItemByItemId } = require('./graph');
const lq = require('./list-query');

const FOLDER = 'Backups/ServicesCatalog';
const RESTORE_FIELDS = ['Title', 'ServiceName', 'Division', 'PropertyType', 'Description', 'Price', 'Category', 'Active'];
const BACKUP_FIELDS = RESTORE_FIELDS.concat(['SKU', 'RequiresQuantity', 'Areas', 'PackageItems', 'Level2Price', 'Level2Mode', 'Level3Price', 'Level3Mode']);
const NAME_RE = /^catalog-[0-9TZ-]+-[a-z-]+\.json$/;

const truthy = v => v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';

function same(k, a, b) {
  if (k === 'Active' || k === 'RequiresQuantity') return truthy(a) === truthy(b);
  if (k === 'Price' || k === 'Level2Price' || k === 'Level3Price') return (a == null || a === '' ? null : Number(a)) === (b == null || b === '' ? null : Number(b));
  return String(a == null ? '' : a) === String(b == null ? '' : b);
}

/* La foto: siempre los mismos campos en el mismo orden. */
function snapshotRows(existing) {
  return existing.filter(it => it.fields).map(it => {
    const fields = {};
    BACKUP_FIELDS.forEach(k => { if (it.fields[k] !== undefined) fields[k] = it.fields[k]; });
    return { id: String(it.id), fields };
  });
}

/* lq.fetchAll SI truena si SharePoint falla -- nunca se respalda (ni se
   compara contra) un catalogo "vacio" que en realidad no se pudo leer. */
function readCatalog() {
  return lq.fetchAll(SERVICES_CATALOG_LIST);
}

async function backupCatalog(existing, reason, by) {
  const name = 'catalog-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + reason + '.json';
  const rows = snapshotRows(existing);
  const payload = { version: 1, createdAt: new Date().toISOString(), by: by || '', reason, count: rows.length, rows };
  await uploadFile(FOLDER, name, Buffer.from(JSON.stringify(payload)), 'application/json');
  return name;
}

async function listBackups() {
  const kids = await listChildren(FOLDER);
  return kids.filter(k => k.isFile && NAME_RE.test(k.name))
    .map(k => ({ name: k.name, createdDateTime: k.createdDateTime, size: k.size }))
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

async function readBackup(name) {
  if (!NAME_RE.test(String(name || ''))) { const e = new Error('Unknown backup.'); e.status = 400; throw e; }
  const buf = await downloadByPath(FOLDER + '/' + name);
  if (!buf) { const e = new Error('Backup not found.'); e.status = 404; throw e; }
  let snap;
  try { snap = JSON.parse(buf.toString('utf8')); } catch (e) { snap = null; }
  if (!snap || !Array.isArray(snap.rows)) { const e = new Error('This backup file cannot be read.'); e.status = 400; throw e; }
  return snap;
}

/* true si el catalogo de hoy es distinto a la foto (renglones o campos). */
function differsFrom(existing, snap) {
  const now = snapshotRows(existing);
  if (now.length !== snap.rows.length) return true;
  const byId = new Map(snap.rows.map(r => [String(r.id), r.fields || {}]));
  return now.some(r => {
    const old = byId.get(r.id);
    return !old || BACKUP_FIELDS.some(k => !same(k, r.fields[k], old[k]));
  });
}

/* Cron diario: respaldo SOLO si algo cambio desde el ultimo respaldo. */
async function dailyBackupIfChanged() {
  const existing = await readCatalog();
  const list = await listBackups();
  if (list.length) {
    const last = await readBackup(list[0].name);
    if (!differsFrom(existing, last)) return { saved: false, reason: 'No changes since ' + list[0].name };
  }
  return { saved: true, backup: await backupCatalog(existing, 'daily', 'Daily backup') };
}

/* Que haria regresar a esta foto (sin escribir nada). */
function restorePlan(existing, snap) {
  const byId = new Map(existing.map(it => [String(it.id), it]));
  const snapIds = new Set(snap.rows.map(r => String(r.id)));
  const patches = [];
  let missing = 0;
  snap.rows.forEach(r => {
    const cur = byId.get(String(r.id));
    if (!cur) { missing++; return; }
    const patch = {}, changes = [];
    RESTORE_FIELDS.forEach(k => {
      const want = (r.fields || {})[k] === undefined ? null : r.fields[k];
      const have = (cur.fields || {})[k];
      if (!same(k, have, want)) {
        patch[k] = k === 'Active' ? truthy(want) : want;
        changes.push({ field: k, from: have == null ? '' : have, to: want == null ? '' : want });
      }
    });
    if (changes.length) patches.push({ id: cur.id, sku: (cur.fields || {}).SKU || '', serviceName: (cur.fields || {}).ServiceName || '', patch, changes });
  });
  /* Lo que se creo despues de la foto: se apaga, no se borra -- si alguien
     ya lo uso en una orden, su SKU sigue existiendo. */
  existing.forEach(it => {
    if (it.fields && !snapIds.has(String(it.id)) && truthy(it.fields.Active)) {
      patches.push({ id: it.id, sku: it.fields.SKU || '', serviceName: it.fields.ServiceName || '', patch: { Active: false }, createdAfter: true, changes: [{ field: 'Active', from: true, to: false }] });
    }
  });
  return { patches, missing };
}

async function restoreBackup(name, opts) {
  opts = opts || {};
  const snap = await readBackup(name);
  const existing = await readCatalog();
  const { patches, missing } = restorePlan(existing, snap);
  const summary = p => ({ sku: p.sku, serviceName: p.serviceName, createdAfter: !!p.createdAfter, changes: p.changes });
  if (opts.dryRun) {
    return {
      dryRun: true, backupCreatedAt: snap.createdAt, backupCount: snap.count,
      restored: patches.filter(p => !p.createdAfter).length, turnedOff: patches.filter(p => p.createdAfter).length,
      missing, changes: patches.map(summary)
    };
  }
  let before;
  try { before = await backupCatalog(existing, 'before-restore', opts.by); }
  catch (e) { const err = new Error('Could not save a backup of the current catalog, so nothing was changed: ' + e.message); err.status = 500; throw err; }
  let restored = 0, turnedOff = 0;
  const failed = [];
  for (let i = 0; i < patches.length; i += 8) {
    await Promise.all(patches.slice(i, i + 8).map(async p => {
      try {
        await updateListItemByItemId(SERVICES_CATALOG_LIST, p.id, p.patch);
        if (p.createdAfter) turnedOff++; else restored++;
      } catch (e) { failed.push((p.sku || p.id) + ': ' + e.message); }
    }));
  }
  return { success: !failed.length, backup: before, restored, turnedOff, missing, failed };
}

module.exports = { FOLDER, NAME_RE, readCatalog, backupCatalog, listBackups, readBackup, differsFrom, dailyBackupIfChanged, restorePlan, restoreBackup };
