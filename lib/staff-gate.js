/* ============================================================
   lib/staff-gate.js -- solo la gente de la lista Staff entra a Admin
   (25/09/2026, decision del dueño, punto B8). Antes bastaba cualquier
   cuenta de Microsoft de la empresa.

   - La lista Staff se guarda 60 s en memoria (lib/list-query).
   - Si la lista Staff esta VACIA (o no se pudo leer), no se bloquea a
     nadie: nunca dejar a la oficina fuera por un error de configuracion.
============================================================ */
const lq = require('./list-query');
const { STAFF_LIST } = require('./graph');

async function isStaff(email) {
  const wanted = String(email || '').trim().toLowerCase();
  let rows;
  try {
    rows = (await lq.fetchAllCached(STAFF_LIST)).filter(it => it.fields && String(it.fields.Email || '').trim());
  } catch (e) {
    console.error('staff-gate: could not read Staff (' + e.message + ') -- letting the request through');
    return true;
  }
  if (!rows.length) return true;
  return rows.some(it => String(it.fields.Email || '').trim().toLowerCase() === wanted);
}

function forget() { lq.invalidate(STAFF_LIST); }

module.exports = { isStaff, forget };
