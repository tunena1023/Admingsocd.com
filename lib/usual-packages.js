/* ============================================================
   lib/usual-packages.js -- "Your usual order" de cada cliente
   (24/09/2026, pedido y aprobado con mini por el dueño:
   https://claude.ai/artifact/4wAEnrAQVzHjD2zJbggTi4).

   Reglas (una por division del cliente):
   - Cada orden que MANDA EL CLIENTE (no las que crea la oficina) se
     compara con la anterior de esa division: mismo set de servicios
     (los mismos SKU, sin importar niveles) -> suma 1; distinto ->
     arranca en 1. Un PO de varias unidades cuenta como UNA orden.
   - Al llegar a `threshold` seguidas (10; 3 despues de que el cliente
     guardo uno como su paquete) ese set se vuelve su "usual", con los
     niveles de la ULTIMA orden. Si ya tenia uno, se queda hasta que otro
     set junte sus seguidas ("para dar mas tiempo": cambios de una vez
     no mueven nada).
   - Si el cliente pide justo lo de un paquete que ya guardo (sus
     Templates), esa orden no cuenta (ni suma ni corta la racha).
   - Guardarlo como "My package" (save-template con fromUsual) esconde
     el usual, reinicia el conteo y baja el umbral a 3.

   Se guarda en Clients.UsualPackages (texto de varias lineas, JSON):
   { "<Division>": { cur: {key, items, count}, usual: {key, items} | null,
                     threshold: 10|3 } }
   Si la columna no existe todavia, nada truena: simplemente no hay usual.
   COPIA de ordersgsocd.com/lib/usual-packages.js -- cambiar las dos.
   Admin solo LEE (usualSetsFromFields): las ordenes de la oficina no cuentan.
============================================================ */
const { CLIENTS_LIST, SERVICE_TEMPLATES_LIST, queryList, updateListItemByItemId } = require('./graph');

const FIRST_THRESHOLD = 10;
const AFTER_SAVE_THRESHOLD = 3;
const LEVEL = /^Level [123]$/;

function esc(v) { return String(v || '').replace(/'/g, "''"); }
function parseState(raw) { try { const o = JSON.parse(raw || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }

/* services: los renglones de la orden (SubOption = SKU, Level). */
function setOf(services) {
  const bySku = {};
  (services || []).forEach(s => {
    const sku = String((s && (s.SubOption || s.sku)) || '').trim();
    if (!sku) return;
    const lv = String((s && (s.Level || s.level)) || '');
    const q = parseInt((s && (s.Quantity || s.qty)) || '', 10);
    bySku[sku] = { level: LEVEL.test(lv) ? lv : '', qty: q > 0 ? q : '' };
  });
  /* El set se compara solo por SKU (niveles y cantidades no cortan la
     racha); se guardan nivel y cantidad de la ULTIMA orden. Sirve para
     todas las divisiones: con nivel (Janitorial), sin nivel y con
     cantidad (Renovations / Exteriors). */
  const skus = Object.keys(bySku).sort();
  return { key: skus.join('|'), items: skus.map(sku => Object.assign({ sku, level: bySku[sku].level }, bySku[sku].qty ? { qty: bySku[sku].qty } : {})) };
}

async function clientRow(clientId) {
  const rows = await queryList(CLIENTS_LIST, '$expand=fields&$top=5&$filter=' + encodeURIComponent("fields/ClientID eq '" + esc(clientId) + "'"));
  return rows[0] || null;
}
async function savedKeys(clientId, division) {
  try {
    const rows = await queryList(SERVICE_TEMPLATES_LIST, '$expand=fields&$top=200&$filter=' + encodeURIComponent("fields/ClientID eq '" + esc(clientId) + "'"));
    return rows.filter(r => r.fields && (!division || String(r.fields.Division || '') === String(division)))
      .map(r => { let sv = []; try { sv = JSON.parse(r.fields.ServicesJSON || '[]'); } catch (e) {} return setOf(sv).key; })
      .filter(Boolean);
  } catch (e) { return []; }
}

/* Llamar UNA vez por orden nueva que manda el cliente. Nunca lanza. */
async function recordUsualOrder(clientId, division, services) {
  try {
    if (!clientId || !division) return null;
    const set = setOf(services);
    if (!set.key) return null;
    const row = await clientRow(clientId);
    if (!row || !row.fields) return null;
    if ((await savedKeys(clientId, division)).indexOf(set.key) > -1) return null; // ya es un paquete suyo
    const state = parseState(row.fields.UsualPackages);
    const d = state[division] || { cur: null, usual: null, threshold: FIRST_THRESHOLD };
    if (d.cur && d.cur.key === set.key) { d.cur.count = (d.cur.count || 0) + 1; d.cur.items = set.items; }
    else d.cur = { key: set.key, items: set.items, count: 1 };
    const threshold = d.threshold || FIRST_THRESHOLD;
    if (d.cur.count >= threshold) d.usual = { key: set.key, items: set.items };
    else if (d.usual && d.usual.key === set.key) d.usual.items = set.items; // mismo usual: niveles de la ultima
    state[division] = d;
    await updateListItemByItemId(CLIENTS_LIST, row.id, { UsualPackages: JSON.stringify(state) });
    return d;
  } catch (e) {
    console.error('UsualPackages for ' + clientId + ':', e.message);
    return null;
  }
}

/* El cliente guardo su usual como "My package": se esconde, conteo en 0
   y el siguiente sale con AFTER_SAVE_THRESHOLD seguidas. Nunca lanza. */
async function usualSaved(clientId, division) {
  try {
    const row = await clientRow(clientId);
    if (!row || !row.fields) return;
    const state = parseState(row.fields.UsualPackages);
    state[division] = { cur: null, usual: null, threshold: AFTER_SAVE_THRESHOLD };
    await updateListItemByItemId(CLIENTS_LIST, row.id, { UsualPackages: JSON.stringify(state) });
  } catch (e) { console.error('UsualPackages save for ' + clientId + ':', e.message); }
}

/* Lo que el picker necesita: [{key, name, division, items}] */
function usualSetsFromFields(fields) {
  const state = parseState(fields && fields.UsualPackages);
  return Object.keys(state).filter(div => state[div] && state[div].usual && (state[div].usual.items || []).length)
    .map(div => ({ key: div, name: 'Your usual order', division: div, items: state[div].usual.items }));
}

module.exports = { recordUsualOrder, usualSaved, usualSetsFromFields, setOf, FIRST_THRESHOLD, AFTER_SAVE_THRESHOLD };
