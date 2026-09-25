/* ============================================================
   lib/list-query.js -- pedir a SharePoint solo lo que se necesita
   (25/09/2026, pedido del dueño: "arregla toda la A" -- velocidad).

   Antes casi todas las pantallas bajaban listas COMPLETAS (todas las
   ordenes, todo el historial, todos los servicios de la empresa) y
   filtraban despues. Con el tiempo eso se vuelve lento y Microsoft
   empieza a frenar (429). Aqui:

     fetchAll(list)                       -> toda la lista (como antes)
     fetchWhere(list, filter)             -> solo lo que cumple el filtro
     fetchByValues(list, field, values)   -> renglones cuyo field esta en
                                             values (p. ej. OrderID de
                                             estas ordenes), en tandas
     fetchById(list, id)                  -> un renglon por su id

   REGLA DE ORO: si un filtro falla (columna sin indice en una lista de
   mas de 5,000 renglones, o cualquier otra cosa), se cae solo a
   fetchAll + filtrar aqui. Nunca regresa algo distinto a lo de antes;
   solo mas rapido cuando se puede. Las columnas que conviene indexar
   estan en NOTES.md.

   MISMO archivo en Admin, Orders y Tech.
============================================================ */
const { graphFetch, siteListPath } = require('./graph');

const PREFER = { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' };
const CHUNK = 15;       /* valores por consulta (la URL no debe crecer de mas) */
const PARALLEL = 5;     /* consultas a la vez */

const q = s => String(s == null ? '' : s).replace(/'/g, "''");

async function pages(url) {
  const out = [];
  while (url) {
    const data = await graphFetch(url, { headers: PREFER });
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

function fetchAll(listName) {
  return pages(siteListPath(listName) + '?$expand=fields&$top=500');
}

/* filter: texto OData ("fields/Status eq 'Completed'").
   localTest(fields): el mismo filtro en JS, para el plan B. */
async function fetchWhere(listName, filter, localTest) {
  try {
    return await pages(siteListPath(listName) + '?$expand=fields&$top=500&$filter=' + encodeURIComponent(filter));
  } catch (e) {
    console.warn('list-query: filter failed on ' + listName + ' (' + e.message + ') -- falling back to full list');
    const all = await fetchAll(listName);
    return localTest ? all.filter(it => it.fields && localTest(it.fields)) : all;
  }
}

/* Renglones donde fields[field] es uno de values. Sin values -> []. */
async function fetchByValues(listName, field, values) {
  const uniq = [...new Set((values || []).map(v => String(v == null ? '' : v).trim()).filter(Boolean))];
  if (!uniq.length) return [];
  const chunks = [];
  for (let i = 0; i < uniq.length; i += CHUNK) chunks.push(uniq.slice(i, i + CHUNK));
  const out = [];
  try {
    for (let i = 0; i < chunks.length; i += PARALLEL) {
      const batch = await Promise.all(chunks.slice(i, i + PARALLEL).map(c =>
        pages(siteListPath(listName) + '?$expand=fields&$top=500&$filter=' +
          encodeURIComponent(c.map(v => `fields/${field} eq '${q(v)}'`).join(' or ')))));
      batch.forEach(rows => out.push(...rows));
    }
    return out;
  } catch (e) {
    console.warn('list-query: by-values failed on ' + listName + '.' + field + ' (' + e.message + ') -- falling back to full list');
    const set = new Set(uniq);
    return (await fetchAll(listName)).filter(it => it.fields && set.has(String(it.fields[field] == null ? '' : it.fields[field]).trim()));
  }
}

/* filtro "Status es uno de estos" (texto OData + prueba local) */
function statusIn(statuses, field) {
  field = field || 'Status';
  return {
    filter: statuses.map(s => `fields/${field} eq '${q(s)}'`).join(' or '),
    test: f => statuses.includes(f[field])
  };
}

/* null solo si no existe; cualquier otra falla se avisa (como antes). */
async function fetchById(listName, id) {
  if (!id) return null;
  try {
    return await graphFetch(siteListPath(listName) + '/' + encodeURIComponent(id) + '?$expand=fields');
  } catch (e) {
    if (/not ?found|404|itemNotFound/i.test(e.message)) return null;
    throw e;
  }
}

/* Listas chiquitas que casi no cambian (clientes, direcciones, festivos,
   tecnicos, contratos recurrentes): se guardan 60 s en la memoria del
   servidor. Admin revisa cambios cada 30 s por cada persona conectada;
   sin esto se volvian a pedir enteras en cada vuelta. Un cambio en estas
   listas se ve a mas tardar en 1 minuto. Nunca se usa para ordenes,
   servicios ni historial. */
const CACHE_MS = 60 * 1000;
const cache = new Map();
function fetchAllCached(listName) {
  const hit = cache.get(listName);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = fetchAll(listName);
  cache.set(listName, { at: Date.now(), promise });
  promise.catch(() => cache.delete(listName));
  return promise;
}
function invalidate(listName) { if (listName) cache.delete(listName); else cache.clear(); }

module.exports = { fetchAll, fetchAllCached, invalidate, fetchWhere, fetchByValues, fetchById, statusIn };
