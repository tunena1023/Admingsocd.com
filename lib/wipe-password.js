/* lib/wipe-password.js -- el password de confirmacion para BORRAR (25/09/2026).
   Antes vivia escrito solo dentro de developer-admin.js (Wipe Test Data /
   Wipe Clients Only). El dueño pidio usar el MISMO para borrar documentos
   de QuickBooks desde Admin, asi que vive aqui y lo usan los dos. */
const WIPE_PASSWORD = 'BorraTodoYnoDejesNada';
function isWipePassword(pw) { return String(pw || '') === WIPE_PASSWORD; }
module.exports = { isWipePassword };
