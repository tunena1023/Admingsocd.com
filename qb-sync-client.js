/* ============================================================
   qb-sync-client.js -- (26/09/2026, PLAN-RESPALDOS.md fase 2)
   1) POST { clientId, gsmsBefore? } desde orders.gsocd.com cuando el
      cliente edita su perfil o se registra: manda ese cliente a QuickBooks
      al instante (lib/qb-sync.js, con registro y Undo). Orders no tiene la
      conexion de QuickBooks; la tiene Admin. Se protege con la llave
      compartida QB_SYNC_SECRET (header x-gs-sync-secret), que debe estar
      en Vercel en los dos proyectos. Sin esa llave, 401.
   2) cronHandler: revision diaria (vercel.json) -- todo cliente activo que
      falte o este distinto en QuickBooks se manda (CRON_SECRET).
============================================================ */
const { jsonResponse } = require('./lib/graph');

const FIELDS = ['businessName', 'contactPerson', 'email', 'phone', 'address', 'suite', 'city', 'zip'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const expected = process.env.QB_SYNC_SECRET || '';
  const got = (event.headers && (event.headers['x-gs-sync-secret'] || event.headers['X-GS-Sync-Secret'])) || '';
  if (expected.length < 16 || got !== expected) return jsonResponse(401, { error: 'Unauthorized' });
  try {
    const body = JSON.parse(event.body || '{}');
    const clientId = String(body.clientId || '').trim();
    if (!/^GS-\d+$/.test(clientId)) return jsonResponse(400, { error: 'clientId is required' });
    let gsmsBefore = null;
    if (body.gsmsBefore && typeof body.gsmsBefore === 'object') {
      gsmsBefore = { clientId };
      FIELDS.forEach(k => { gsmsBefore[k] = String(body.gsmsBefore[k] == null ? '' : body.gsmsBefore[k]).slice(0, 300); });
    }
    const r = await require('./lib/qb-sync').pushClient(clientId, { by: 'Client portal (' + clientId + ')', reason: body.reason === 'new-client' ? 'new-client' : 'client-portal', gsmsBefore });
    return jsonResponse(200, r);
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};

exports.cronHandler = async (event) => {
  const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const qsSecret = (event.queryStringParameters || {}).secret || '';
  const expected = process.env.CRON_SECRET || '';
  if (!expected || (auth !== 'Bearer ' + expected && qsSecret !== expected)) return jsonResponse(401, { error: 'Unauthorized' });
  try {
    return jsonResponse(200, await require('./lib/qb-sync').reconcileAll(45000));
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
