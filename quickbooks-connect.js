/* ============================================================
   quickbooks-connect.js — GET real (se abre con un link/boton
   normal, no un fetch con body) que arranca el flujo de OAuth:
   guarda un "state" al azar (para verificar en el callback que la
   respuesta es de verdad de esta misma sesion, no un CSRF) y manda
   al usuario a la pantalla de autorizacion de Intuit.
============================================================ */

const crypto = require('crypto');
const { buildAuthorizeUrl, saveSetting, jsonResponse } = require('./lib/quickbooks');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const state = crypto.randomBytes(24).toString('hex');
    await saveSetting('qb_oauth_state', state);
    const authorizeUrl = buildAuthorizeUrl(state);
    return {
      statusCode: 302,
      headers: { Location: authorizeUrl }
    };
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
