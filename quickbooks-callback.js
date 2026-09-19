/* ============================================================
   quickbooks-callback.js — a donde Intuit redirige de regreso
   despues de que el usuario autoriza (o rechaza) la conexion.
   GET real, con ?code=&realmId=&state= (o ?error= si rechazo).

   Verifica el state contra el que se guardo en quickbooks-connect.js
   (proteccion CSRF basica), intercambia el code por tokens reales, y
   redirige de vuelta a Admin con un mensaje de exito o error -- la
   pantalla de QuickBooks en admin.html lee ese parametro y pinta el
   toast correspondiente.
============================================================ */

const { exchangeCodeForTokens, getSetting, saveSetting } = require('./lib/quickbooks');

const REDIRECT_BACK = 'https://admin.gsocd.com/admin.html?tab=quickbooks';

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};

  if (q.error) {
    return { statusCode: 302, headers: { Location: REDIRECT_BACK + '&qb=error&qb_msg=' + encodeURIComponent(q.error_description || q.error) } };
  }

  try {
    const savedState = await getSetting('qb_oauth_state');
    if (!q.state || !savedState || q.state !== savedState) {
      return { statusCode: 302, headers: { Location: REDIRECT_BACK + '&qb=error&qb_msg=' + encodeURIComponent('Invalid or expired connection attempt. Please try connecting again.') } };
    }
    await saveSetting('qb_oauth_state', ''); // un solo uso, se borra apenas se valida

    if (!q.code || !q.realmId) {
      return { statusCode: 302, headers: { Location: REDIRECT_BACK + '&qb=error&qb_msg=' + encodeURIComponent('QuickBooks did not return the expected data.') } };
    }

    await exchangeCodeForTokens(q.code, q.realmId);
    return { statusCode: 302, headers: { Location: REDIRECT_BACK + '&qb=connected' } };

  } catch (err) {
    return { statusCode: 302, headers: { Location: REDIRECT_BACK + '&qb=error&qb_msg=' + encodeURIComponent(err.message) } };
  }
};
