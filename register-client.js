/* ============================================================
   register-client.js — registro de cliente nuevo.
   - Negocio en Title · persona de contacto en BusinessName
   - ClientID secuencial GS-1001, GS-1002...
   - Validación de email duplicado antes de crear
   - Content-Type OBLIGATORIO en el POST (sin él Graph
     responde "Invalid request")
============================================================ */

const { CLIENTS_LIST, graphFetch, siteListPath, jsonResponse } = require('./lib/graph');

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

async function generateNewClientId() {
  const rows = await fetchAll(CLIENTS_LIST);
  const nums = (rows || [])
    .map(it => parseInt(String((it.fields.ClientID || '')).replace('GS-', ''), 10))
    .filter(n => !isNaN(n));
  return 'GS-' + (nums.length ? Math.max(...nums) + 1 : 1001);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const {
      businessName, contactPerson, address,
      suite, city, zip, contact, phone
    } = JSON.parse(event.body || '{}');

    if (!businessName || !contactPerson || !address || !city || !zip || !contact || !phone) {
      return jsonResponse(400, { error: 'Missing required fields' });
    }

    /* Evitar duplicados por email */
    const rows = await fetchAll(CLIENTS_LIST);
    const wantedEmail = String(contact).trim().toLowerCase();
    const dup = (rows || []).find(it =>
      it.fields && String(it.fields.Contact || '').trim().toLowerCase() === wantedEmail
    );
    if (dup) {
      const f = dup.fields;
      return jsonResponse(200, {
        valid: true,
        existing: true,
        clientId: f.ClientID,
        businessName: f.Title,
        contactPerson: f.BusinessName || '',
        address: f.Address || '',
        suite: f.Suite || '',
        city: f.City || '',
        zip: f.Zip || '',
        contact: f.Contact || '',
        phone: f.Phone || ''
      });
    }

    /* Crear el cliente */
    const clientId = await generateNewClientId();
    await graphFetch(siteListPath(CLIENTS_LIST), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          ClientID: clientId,
          Title: businessName,
          ClientName: contactPerson,
          Address: address,
          Suite: suite || '',
          City: city,
          Zip: zip,
          Contact: contact,
          Phone: phone
        }
      })
    });

    return jsonResponse(200, {
      valid: true,
      clientId,
      businessName,
      contactPerson,
      address,
      suite: suite || '',
      city,
      zip,
      contact,
      phone
    });

  } catch (err) {
    return jsonResponse(500, { valid: false, error: err.message });
  }
};