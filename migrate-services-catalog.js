/* ============================================================
   migrate-services-catalog.js — funcion de UN SOLO USO: lee el
   catalogo de servicios del Excel de SharePoint (misma fuente que
   get-services.js) y crea un renglon por cada combinacion unica de
   Division + Category + ServiceName + SubOption en la lista nueva
   "Services". No borra ni toca el Excel original.

   Seguridad basica: si la lista Services YA tiene renglones, no hace
   nada y avisa -- para no correr la migracion dos veces por accidente
   y duplicar todo. Si de verdad se quiere volver a correr (por
   ejemplo, el Excel cambio y se quiere re-migrar desde cero), hay que
   vaciar la lista Services a mano primero.

   Se dispara UNA VEZ visitando esta URL en el navegador ya logueado,
   y despues se puede dejar el archivo en el repo sin riesgo (no hace
   nada si la lista ya tiene datos).
============================================================ */

const XLSX = require('xlsx');
const {
  SERVICES_LIST, graphFetch, siteListPath, createListItem, jsonResponse
} = require('./lib/graph');

const EXCEL_SHARE_URL = process.env.SERVICES_EXCEL_URL ||
  'https://netorgft10263312.sharepoint.com/:x:/s/Onlineorders/IQAUNmABQk2aSrWjZJbmpjNdAROA07wWvLt2EnU5qKNSfEA?e=CzpjFk';

async function resolveExcelItem() {
  const { driveItemByShareLink } = require('./lib/graph');
  const item = await driveItemByShareLink(EXCEL_SHARE_URL);
  return { driveId: item.parentReference.driveId, itemId: item.id };
}

/* Lee las filas crudas del Excel, sin agrupar -- una entrada por cada
   combinacion unica de Division+Category+ServiceName+SubOption. La
   descripcion se asigna a nivel Division+Category+ServiceName (la
   primera no vacia que aparezca), igual que ya hace get-services.js,
   para que el comportamiento no cambie tras la migracion. */
function parseRowsForMigration(wb) {
  const sheet = wb.Sheets['Services'];
  if (!sheet) throw new Error('Sheet "Services" not found in the workbook.');

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const divisionMap = { 'janitorial': 'Janitorial', 'renovations': 'renovations', 'exteriors': 'exteriors' };

  const descByService = {};   // "division|category|service" -> primera descripcion no vacia
  const seen = new Set();     // "division|category|service|sub" ya visto
  const out = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 4) continue;

    const division = divisionMap[(r[0] || '').toString().trim().toLowerCase()];
    const category = (r[1] || '').toString().trim();
    const name     = (r[2] || '').toString().trim();
    const sub      = (r[3] || '').toString().trim();
    const desc     = (r[4] || '').toString().trim();

    if (!division || !category || !name || !sub) continue;

    const svcKey = division + '|' + category + '|' + name;
    if (desc && !descByService[svcKey]) descByService[svcKey] = desc;

    const rowKey = svcKey + '|' + sub;
    if (seen.has(rowKey)) continue;   // fila duplicada en el Excel, se ignora
    seen.add(rowKey);

    out.push({ division, category, name, sub });
  }

  return out.map((row, idx) => ({
    Title:        row.name,
    Division:     row.division,
    Category:     row.category,
    ServiceName:  row.name,
    SubOption:    row.sub,
    Description:  descByService[row.division + '|' + row.category + '|' + row.name] || '',
    Active:       true,
    SortOrder:    idx
  }));
}

exports.handler = async () => {
  try {
    /* Seguro contra migrar dos veces: si Services ya tiene algo, no tocar nada */
    const existing = await graphFetch(siteListPath(SERVICES_LIST) + '?$expand=fields&$top=1');
    if ((existing.value || []).length > 0) {
      return jsonResponse(409, {
        error: 'The Services list already has data — migration was not run again, to avoid duplicating everything. Empty the list first if you really want to re-run it.'
      });
    }

    const { driveId, itemId } = await resolveExcelItem();
    const res = await graphFetch('/drives/' + driveId + '/items/' + itemId + '/content', {}, true);
    if (!res.ok) throw new Error('Could not download services file (' + res.status + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer' });

    const items = parseRowsForMigration(wb);

    /* Crear en tandas para no saturar Graph con cientos de llamadas
       simultaneas de golpe */
    const BATCH = 15;
    let created = 0;
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      await Promise.all(batch.map(item => createListItem(SERVICES_LIST, item)));
      created += batch.length;
    }

    return jsonResponse(200, {
      success: true,
      message: 'Migration complete. ' + created + ' service rows created in the Services list.',
      count: created
    });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
