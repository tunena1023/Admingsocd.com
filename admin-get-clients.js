/* admin-get-clients.js — todos los clientes */
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const rows = await fetchAll(CLIENTS_LIST);
    const clients = rows
      .filter(it => it.fields)
      .map(it => {
        const f = it.fields;
        return {
          id: it.id,
          clientId: f.ClientID || '',
          businessName: f.Title || '',
          contactPerson: f.BusinessName || '',
          address: f.Address || '',
          suite: f.Suite || '',
          city: f.City || '',
          zip: f.Zip || '',
          contact: f.Contact || '',
          phone: f.Phone || ''
        };
      })
      .sort((a,b) => a.businessName.localeCompare(b.businessName));
    return jsonResponse(200, { clients });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
