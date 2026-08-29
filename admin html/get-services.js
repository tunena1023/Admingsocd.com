/* ============================================================
   get-services.js — catálogo de servicios desde el Excel de
   SharePoint (hoja "Services": Division|Location|Service|
   SubOption|Description). Mismo JSON que el modo demo.

   El archivo se resuelve por ENLACE COMPARTIDO (no por ruta),
   así da igual en qué carpeta viva o si se mueve.
   Override opcional: variable de entorno SERVICES_EXCEL_URL.

   Requiere dependencia "xlsx" en package.json:
     npm install xlsx@0.18.5
============================================================ */

const XLSX = require('xlsx');
const { graphFetch, jsonResponse } = require('./lib/graph');

const EXCEL_SHARE_URL = process.env.SERVICES_EXCEL_URL ||
  'https://netorgft10263312.sharepoint.com/:x:/s/Onlineorders/IQAUNmABQk2aSrWjZJbmpjNdAROA07wWvLt2EnU5qKNSfEA?e=CzpjFk';

/* Item resuelto del Excel — se cachea por proceso. Si el archivo se
   movió y el ID viejo muere, se re-resuelve desde el enlace. */
let _excelItem = null;
let _excelItemAt = 0;
const EXCEL_CACHE_MS = 10 * 60 * 1000;   /* re-resolver el enlace cada 10 min */

async function resolveExcelItem() {
  if (_excelItem && (Date.now() - _excelItemAt) < EXCEL_CACHE_MS) return _excelItem;
  const { driveItemByShareLink } = require('./lib/graph');
  const item = await driveItemByShareLink(EXCEL_SHARE_URL);
  _excelItem = {
    driveId: item.parentReference.driveId,
    itemId: item.id
  };
  _excelItemAt = Date.now();
  return _excelItem;
}

/* Parser idéntico a DEMO._parseServices (shared.js) */
function parseServices(wb) {
  const sheet = wb.Sheets['Services'];
  if (!sheet) throw new Error('Sheet "Services" not found in the workbook.');

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const divisionMap = { 'janitorial': 'Janitorial', 'renovations': 'renovations', 'exteriors': 'exteriors' };

  const out = {
    Janitorial:  { type: 'categorized_rooms',  dirtLevels: true,  categories: {} },
    renovations: { type: 'categorized_trades', dirtLevels: false, categories: {} },
    exteriors:   { type: 'categorized_trades', dirtLevels: false, categories: {} }
  };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 4) continue;

    const division = divisionMap[(r[0] || '').toString().trim().toLowerCase()];
    const location = (r[1] || '').toString().trim();
    const name = (r[2] || '').toString().trim();
    const sub = (r[3] || '').toString().trim();
    const desc = (r[4] || '').toString().trim();

    if (!division || !location || !name || !sub) continue;

    if (!out[division].categories[location]) out[division].categories[location] = [];

    let entry = out[division].categories[location].find(s => s.name === name);
    if (!entry) {
      entry = { name: name, desc: desc, subs: [] };
      out[division].categories[location].push(entry);
    }
    if (!entry.desc && desc) entry.desc = desc;
    if (!entry.subs.includes(sub)) entry.subs.push(sub);
  }

  return out;
}

exports.handler = async () => {
  /* La página lo pide con GET (GS.api('/get-services', { method: 'GET' })) */
  try {
    const { driveId, itemId } = await resolveExcelItem();

    const res = await graphFetch('/drives/' + driveId + '/items/' + itemId + '/content', {}, true);
    if (!res.ok) throw new Error('Could not download services file (' + res.status + ')');

    const buf = Buffer.from(await res.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });

    return jsonResponse(200, parseServices(wb));
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};