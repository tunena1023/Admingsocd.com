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
  getCompanySetup, getClassesAndDepartments, usesCustomTxnNumbers, jsonResponse
} = require('./lib/quickbooks');

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });

    const email = (event.headers || {})['x-gs-user-email'] || '';
    const [connected, imported, canSend] = await Promise.all([isConnected(), getImportedOrders(), getSendPerms(email)]);
    const environment = (process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox').toLowerCase() === 'production' ? 'production' : 'sandbox';
    let setup = null;
    /* Mandados que ya no existen en QuickBooks (los borraron alla). */
    let missing = [];
    if (connected) {
      try {
        const qb = require('./lib/quickbooks');
        const byType = { estimate: [], invoice: [] };
        Object.keys(imported).forEach(oid => { const e = imported[oid]; if (e && e.estimateId) byType[e.type === 'invoice' ? 'invoice' : 'estimate'].push(oid); });
        for (const t of ['estimate', 'invoice']) {
          if (!byType[t].length) continue;
          const found = await qb.existingDocIds(t, byType[t].map(oid => imported[oid].estimateId));
          byType[t].forEach(oid => { if (!found.has(String(imported[oid].estimateId))) missing.push(oid); });
        }
      } catch (e) { missing = []; /* si no se pudo revisar, no se asume nada */ }
    }
    if (connected) {
      try {
        const [s, customNumbers, cd] = await Promise.all([getCompanySetup(), usesCustomTxnNumbers(), getClassesAndDepartments()]);
        /* Ordenes con varias divisiones van al Department "Mixed Services:..." */
        const mixed = cd.departments.filter(d => /^mixed/i.test(d.full)).map(d => d.full);
        setup = Object.assign(s, { customNumbers, mixedDepartments: mixed });
      } catch (e) {
        setup = { error: e.message };
      }
    }
    return jsonResponse(200, { connected, imported, canSend, environment, setup, missing });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
