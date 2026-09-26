/* ============================================================
   cron-backups.js -- respaldo diario de todas las listas de GSMS
   (26/09/2026, PLAN-RESPALDOS.md fase 1). Vercel Cron llama un slug
   por grupo (vercel.json), cada uno una vez al dia y a distinta hora,
   para que ninguno pase de los 60 s de la funcion:
     cron-backup-config, cron-backup-clients, cron-backup-orders,
     cron-backup-history, cron-backup-other
   Solo guarda las listas que cambiaron desde su ultimo respaldo y borra
   los respaldos diarios de mas de 90 dias (lib/backup-store.js).

   Seguridad: igual que cron-recurring-orders.js -- Vercel manda
   "Authorization: Bearer <CRON_SECRET>"; ?secret= solo para probar a mano.
============================================================ */
const { jsonResponse } = require('./lib/graph');

function handlerFor(group) {
  return async (event) => {
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const qsSecret = (event.queryStringParameters || {}).secret || '';
    const expected = process.env.CRON_SECRET || '';
    if (!expected || (auth !== 'Bearer ' + expected && qsSecret !== expected)) {
      return jsonResponse(401, { error: 'Unauthorized' });
    }
    try {
      const results = await require('./lib/backup-store').dailyGroup(group);
      return jsonResponse(200, { success: results.every(r => !r.error), group, results });
    } catch (e) {
      return jsonResponse(500, { error: e.message, group });
    }
  };
}

module.exports = { handlerFor };
