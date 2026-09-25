/* lib/wipe-password.js -- el password de confirmacion para BORRAR
   (Wipe Test Data, Wipe Clients Only y Delete from QuickBooks).

   26/09/2026: ya no vive escrito en el codigo. Se lee de la variable de
   entorno WIPE_PASSWORD de Vercel. Si no esta puesta, NADA se puede
   borrar (se contesta con un mensaje claro) -- nunca se cae a un valor
   escrito aqui. */
function isWipePassword(pw) {
  const real = process.env.WIPE_PASSWORD || '';
  return !!real && String(pw || '') === real;
}
function wipePasswordConfigured() { return !!process.env.WIPE_PASSWORD; }
module.exports = { isWipePassword, wipePasswordConfigured };
