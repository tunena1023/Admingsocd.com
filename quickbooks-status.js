/* ============================================================
   quickbooks-status.js — para el panel de QuickBooks en Admin: si
   ya esta conectado, y cuales ordenes ya se importaron como Estimate
   (para pintar el badge en vez del selector en esas tarjetas).
============================================================ */

const { isConnected, getImportedOrders, jsonResponse } = require('./lib/quickbooks');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  try {
    const [connected, imported] = await Promise.all([isConnected(), getImportedOrders()]);
    return jsonResponse(200, { connected, imported });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
