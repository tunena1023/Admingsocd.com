/* ============================================================
   quickbooks-status.js — para el panel de QuickBooks en Admin: si
   ya esta conectado, y cuales ordenes ya se importaron (para pintar
   el badge en vez del selector en esas tarjetas).

   25/09/2026: tambien regresa
   - canSend: { estimate, invoice } de quien esta viendo (se configura
     por persona en Developer > Staff & Roles),
   - environment: 'sandbox' | 'production',
   - setup: como esta armada la compania (campos UNIT # / BEDROOMS /
     BATHROOMS, Class, Location, numeros personalizados), leido de
     QuickBooks, para que el panel avise si falta algo.
============================================================ */

const {
  isConnected, getImportedOrders, getSendPerms,
  getCompanySetup, usesCustomTxnNumbers, jsonResponse
} = require('./lib/quickbooks');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

    const email = (event.headers || {})['x-gs-user-email'] || '';
    const [connected, imported, canSend] = await Promise.all([isConnected(), getImportedOrders(), getSendPerms(email)]);
    const environment = (process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
    let setup = null;
    if (connected) {
      try {
        const [s, customNumbers] = await Promise.all([getCompanySetup(), usesCustomTxnNumbers()]);
        setup = Object.assign(s, { customNumbers });
      } catch (e) {
        setup = { error: e.message };
      }
    }
    return jsonResponse(200, { connected, imported, canSend, environment, setup });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
