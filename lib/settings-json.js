/* ============================================================
   lib/settings-json.js -- JSON largo en la lista Settings (23/09/2026).

   Hallazgo (bug reportado por el dueño, "Could not save: Invalid
   request"): la columna Value de Settings no acepta textos largos
   (Graph contesta "Invalid request"); los mapas de areas, contenido de
   paquetes y precios por nivel pasan de largo. Solucion sin tocar
   SharePoint: el JSON se parte en trozos de 250 caracteres y cada
   trozo va en su propio renglon: Key = clave (trozo 1), clave#2,
   clave#3, ... Al leer se pegan en orden. Orders y Tech leen igual
   (lib/package-contents.js en cada uno).
============================================================ */
const { SETTINGS_LIST, graphFetch, siteListPath, createListItem, updateListItemByItemId, deleteListItem } = require('./graph');

const CHUNK = 250;

async function fetchSettingsRows() {
  let url = siteListPath(SETTINGS_LIST) + '?$expand=fields&$top=200';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/* Renglones de una clave, en orden: [clave, clave#2, clave#3, ...] */
function rowsForKey(rows, key) {
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:#(\\d+))?$');
  return rows.filter(it => it.fields && re.test(String(it.fields.Key || '')))
    .map(it => ({ it, n: Number((String(it.fields.Key).match(re) || [])[1] || 1) }))
    .sort((a, b) => a.n - b.n);
}

function joinValue(rows, key) {
  return rowsForKey(rows, key).map(r => r.it.fields.Value || '').join('');
}

/* Lee un JSON (objeto) guardado en trozos; {} si no hay o no parsea. */
function readJson(rows, key) {
  const text = joinValue(rows, key);
  if (!text) return null;
  try { const v = JSON.parse(text); return (v && typeof v === 'object') ? v : null; } catch (e) { return null; }
}

/* Escribe un JSON en trozos: actualiza los renglones que existen, crea
   los que faltan y borra los que sobran. */
async function writeJson(key, value, rows) {
  return writeText(key, JSON.stringify(value), rows);
}

/* Igual que writeJson pero con texto tal cual (25/09/2026: tokens de
   QuickBooks, que pasan de 255 caracteres). */
async function writeText(key, text, rows) {
  text = text == null ? '' : String(text);
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  if (!parts.length) parts.push('');
  const existing = rowsForKey(rows || await fetchSettingsRows(), key);
  const byN = {}; existing.forEach(r => { byN[r.n] = r.it; });
  for (let i = 0; i < parts.length; i++) {
    const n = i + 1, k = n === 1 ? key : key + '#' + n;
    if (byN[n]) await updateListItemByItemId(SETTINGS_LIST, byN[n].id, { Value: parts[i] });
    else await createListItem(SETTINGS_LIST, { Title: k, Key: k, Value: parts[i] });
  }
  /* Trozos que sobran: primero se vacian (asi nunca se pegan de mas al
     leer, aunque el borrado falle) y luego se intentan borrar. */
  for (const r of existing) {
    if (r.n <= parts.length) continue;
    try { await updateListItemByItemId(SETTINGS_LIST, r.it.id, { Value: '' }); } catch (e) { /* sigue */ }
    try { await deleteListItem(SETTINGS_LIST, r.it.id); } catch (e) { /* sobrante vacio, no estorba */ }
  }
  return parts.length;
}

module.exports = { CHUNK, fetchSettingsRows, rowsForKey, joinValue, readJson, writeJson, writeText };
