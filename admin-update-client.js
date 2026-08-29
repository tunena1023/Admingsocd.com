/* admin-update-client.js — editar datos de un cliente.

   REGLA DEL PROYECTO: nada se sobreescribe sin quedar registrado.
   Antes esta funcion machacaba los datos del cliente sin dejar ningun
   rastro: si alguien borraba el telefono, el valor anterior se perdia
   para siempre. Ahora cada campo modificado genera un renglon en la
   lista ClientHistory con el valor viejo, el nuevo y quien lo cambio.

   Ojo con el mapeo historico de columnas (se conserva tal cual para no
   romper los datos que ya existen):
     Title        <- businessName
     ClientName   <- contactPerson
*/
const {
  CLIENTS_LIST, CLIENT_HISTORY_LIST,
  createListItem, updateListItemByItemId,
  graphFetch, siteListPath, jsonResponse
} = require('./lib/graph');

async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/* undefined / null / '' cuentan como el mismo "sin valor" */
function sameValue(a, b) {
  return String(a == null ? '' : a) === String(b == null ? '' : b);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.clientId) return jsonResponse(400, { error: 'clientId is required' });

    const actor = (b.changedBy && String(b.changedBy).trim()) || 'Admin';

    const rows = await fetchAll(CLIENTS_LIST);
    const item = rows.find(it =>
      it.fields && String(it.fields.ClientID||'').trim().toLowerCase() === String(b.clientId).trim().toLowerCase()
    );
    if (!item) return jsonResponse(404, { error: 'Client not found.' });

    const f = item.fields;

    /* [columna, valor entrante, etiqueta que ve el humano] */
    const map = [
      ['Title',        b.businessName,  'Business Name'],
      ['ClientName',   b.contactPerson, 'Contact Person'],
      ['Contact',      b.contact,       'Contact Email'],
      ['Phone',        b.phone,         'Phone'],
      ['Address',      b.address,       'Address'],
      ['Suite',        b.suite,         'Suite'],
      ['City',         b.city,          'City'],
      ['Zip',          b.zip,           'Zip']
    ];

    const patch = {};
    const changes = [];

    for (const [col, incoming, label] of map) {
      const oldValue = f[col] == null ? '' : String(f[col]);
      /* Solo se toca lo que realmente llego en la peticion */
      if (incoming === undefined) { patch[col] = oldValue; continue; }
      const next = incoming == null ? '' : String(incoming);
      patch[col] = next;
      if (!sameValue(oldValue, next)) {
        changes.push({ label, old: oldValue, next });
      }
    }

    await updateListItemByItemId(CLIENTS_LIST, item.id, patch);

    /* El registro se escribe despues del guardado. Si ClientHistory no
       existiera todavia, el cambio ya quedo hecho: se avisa en la respuesta
       en vez de fingir que todo salio bien. */
    let logged = 0;
    let logError = null;
    for (const ch of changes) {
      try {
        await createListItem(CLIENT_HISTORY_LIST, {
          Title:        b.clientId + ' - ' + ch.label,
          ClientID:     b.clientId,
          ChangeType:   'Client Data Updated',
          ChangedBy:    actor,
          ChangeDate:   new Date().toISOString(),
          FieldChanged: ch.label,
          OldValue:     ch.old,
          NewValue:     ch.next,
          Notes:        (b.notes && String(b.notes).trim()) || ''
        });
        logged++;
      } catch (e) {
        logError = e.message;
      }
    }

    return jsonResponse(200, {
      success: true,
      changesLogged: logged,
      changesDetected: changes.length,
      historyError: logError
    });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
