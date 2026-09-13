/* TEMPORAL -- diagnostico para crear RecurringImportMatrix. Se borra
   despues de correr una vez, no es parte del sistema real. */
const { graphFetch, siteListPath } = require('../lib/graph');

module.exports = async (req, res) => {
  try {
    const existing = await graphFetch(siteListPath('RecurringImportMatrix') + '?$top=1').catch(e => null);
    if (existing) return res.status(200).json({ alreadyExists: true });
  } catch (e) { /* no existe todavia, seguimos */ }

  try {
    // Crear la lista via Graph directo (createListItem no crea listas, solo items)
    const TENANT_ID = process.env.GRAPH_TENANT_ID || 'd18a66ea-5185-4a02-99cc-46b6578ff498';
    const CLIENT_ID = process.env.GRAPH_CLIENT_ID || '18dfcf2e-0059-40f5-831c-69d13b9091fc';
    const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET || 'ee88Q~xsylb2A.2kFKI0eyLSFVzDAXj-dw8PccTB';
    const HOSTNAME = process.env.GRAPH_HOSTNAME || 'netorgft10263312.sharepoint.com';
    const SITE_PATH = process.env.GRAPH_SITE_PATH || '/sites/Onlineorders';

    const tokenRes = await fetch('https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(500).json({ step: 'token', tokenData });
    const token = tokenData.access_token;

    const siteRes = await fetch('https://graph.microsoft.com/v1.0/sites/' + HOSTNAME + ':' + SITE_PATH, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const siteData = await siteRes.json();
    if (!siteData.id) return res.status(500).json({ step: 'site', siteData });

    const createRes = await fetch('https://graph.microsoft.com/v1.0/sites/' + siteData.id + '/lists', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'RecurringImportMatrix',
        columns: [
          { name: 'Edificio', text: {} },
          { name: 'ClientID', text: {} },
          { name: 'Frecuencia', text: {} },
          { name: 'DaysOfWeek', text: {} },
          { name: 'HorasPorVisita', number: { decimalPlaces: 'one' } },
          { name: 'AssignmentsJSON', text: { allowMultipleLines: true } },
          { name: 'LinkedRecurringServiceID', text: {} }
        ],
        list: { template: 'genericList' }
      })
    });
    const createData = await createRes.json();
    return res.status(createRes.status).json({ created: createRes.ok, createData });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};
