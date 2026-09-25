/* ============================================================
   quickbooks-status.js — para el panel de QuickBooks en Admin: si
   ya esta conectado, y cuales ordenes ya se importaron (para pintar
   el badge en vez del selector en esas tarjetas).

   25/09/2026: tambien regresa
   - sendAs: 'estimate' | 'invoice' (boton del panel; POST lo cambia),
   - environment: 'sandbox' | 'production',
   - setup: como esta armada la compania (campos UNIT # / BEDROOMS /
     BATHROOMS, Class, Location, numeros personalizados), leido de
     QuickBooks, para que el panel avise si falta algo.
============================================================ */

const {
  isConnected, getImportedOrders, getSendAs, saveSetting,
  getCompanySetup, usesCustomTxnNumbers, jsonResponse
} = require('./lib/quickbooks');

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const v = String(body.sendAs || '').toLowerCase();
      if (v !== 'estimate' && v !== 'invoice') return jsonResponse(400, { error: 'sendAs must be estimate or invoice' });
      await saveSetting('qb_send_as', v);
      return jsonResponse(200, { sendAs: v });
    }
    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

    const [connected, imported, sendAs] = await Promise.all([isConnected(), getImportedOrders(), getSendAs()]);
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
    return jsonResponse(200, { connected, imported, sendAs, environment, setup });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
