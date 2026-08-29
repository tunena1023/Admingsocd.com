/* admin-get-orders.js — todas las órdenes (sin filtro de cliente) */
const { ORDERS_LIST, graphFetch, siteListPath, jsonResponse } = require('./lib/graph');

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
    const rows = await fetchAll(ORDERS_LIST);
    const orders = rows
      .filter(it => it.fields && it.fields.Status !== 'Cancelled')
      .map(it => {
        const f = it.fields;
        return {
          id: it.id,
          createdDateTime: it.createdDateTime || '',
          OrderID: f.OrderID || f.Title || '',
          ClientID: f.ClientID || '',
          BusinessName: f.BusinessName || f.Title || '',
          Division: f.Division || '',
          Status: f.Status || 'Pending',
          Supervisor: f.Supervisor || '',
          DirtLevel: f.DirtLevel || '',
          BuildingNumber: f.BuildingNumber || '',
          UnitNumber: f.UnitNumber || '',
          Bedrooms: f.Bedrooms || '',
          Bathrooms: f.Bathrooms || '',
          EntryDate: f.EntryDate || '',
          DueDate: f.DueDate || '',
          Address: f.Address || '',
          Suite: f.Suite || '',
          City: f.City || '',
          Zip: f.Zip || '',
          Contact: f.Contact || '',
          Notes: f.Notes || '',
          /* Columnas nuevas (28/08/2026): la pestana Approvals y el editor
             del admin las necesitan en la lista, no solo en el detalle. */
          ServiceWindow: f.ServiceWindow || '',
          DelayReasonType: f.DelayReasonType || '',
          DelayReasonNotes: f.DelayReasonNotes || ''
        };
      })
      .sort((a,b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)));
    return jsonResponse(200, { orders });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
