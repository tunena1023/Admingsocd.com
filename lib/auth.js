/* ============================================================
   lib/auth.js -- verifica el login de Microsoft en el servidor
   (23/09/2026, pedido del dueño).

   Antes el servidor se fiaba del correo que mandaba la pagina en el
   body: cualquiera que supiera el correo de un Developer/Director
   podia mandar peticiones directo a /api/... sin haber iniciado sesion.
   Ahora cada peticion trae el ID token de Microsoft (MSAL, el mismo
   login de siempre) y aqui se valida de verdad:
     - firma RS256 con las llaves publicas del tenant (JWKS, en cache),
     - aud = el clientId de la app de Admin,
     - iss = el tenant de GS Solutions,
     - que no este vencido (5 min de tolerancia de reloj).
   Del token sale el correo real (preferred_username), que es el que
   usa el router para los permisos -- nunca el que diga el body.
============================================================ */
const crypto = require('crypto');

const TENANT_ID = 'd18a66ea-5185-4a02-99cc-46b6578ff498';
const CLIENT_ID = '18dfcf2e-0059-40f5-831c-69d13b9091fc';
const ISSUER = 'https://login.microsoftonline.com/' + TENANT_ID + '/v2.0';
const JWKS_URL = 'https://login.microsoftonline.com/' + TENANT_ID + '/discovery/v2.0/keys';
const SKEW = 300;

let jwksCache = null;
let jwksAt = 0;
let fetchImpl = (...a) => fetch(...a);

async function getKeys(force) {
  if (!force && jwksCache && Date.now() - jwksAt < 6 * 3600 * 1000) return jwksCache;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error('Could not load Microsoft signing keys (' + res.status + ')');
  const data = await res.json();
  jwksCache = Array.isArray(data.keys) ? data.keys : [];
  jwksAt = Date.now();
  return jwksCache;
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(String(part), 'base64url').toString('utf8'));
}

async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('No sign-in token.');
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch (e) { throw new Error('Malformed sign-in token.'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported sign-in token.');

  let keys = await getKeys(false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await getKeys(true); jwk = keys.find(k => k.kid === header.kid); }
  /* Apps con llave de firma propia (claims mapping) firman con llaves
     que solo salen pidiendo el JWKS con ?appid=. */
  if (!jwk) {
    try {
      const res = await fetchImpl(JWKS_URL + '?appid=' + CLIENT_ID);
      if (res.ok) { const d = await res.json(); jwk = (d.keys || []).find(k => k.kid === header.kid); }
    } catch (e) { /* sigue abajo */ }
  }
  if (!jwk) throw new Error('Unknown signing key.');

  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pub, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Invalid sign-in token.');

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== CLIENT_ID) throw new Error('Token is not for this app.');
  if (payload.iss !== ISSUER) throw new Error('Token is not from GS Solutions.');
  if (payload.tid && payload.tid !== TENANT_ID) throw new Error('Token is not from GS Solutions.');
  if (!(Number(payload.exp) > now - SKEW)) throw new Error('Session expired.');
  if (payload.nbf && Number(payload.nbf) > now + SKEW) throw new Error('Token not valid yet.');

  /* Mismo texto que MSAL da como account.username (lo que la pagina
     ya mandaba) -- sin cambiar mayusculas, para no mover las llaves de
     "visto por" guardadas con ese correo. */
  const email = String(payload.preferred_username || payload.email || payload.upn || '').trim();
  if (!email) throw new Error('Token has no user.');
  return { email, name: payload.name || '' };
}

/* Solo para pruebas locales (sin red): inyectar un fetch falso. */
function __setFetchForTests(f) { fetchImpl = f; jwksCache = null; jwksAt = 0; }

module.exports = { verifyIdToken, TENANT_ID, CLIENT_ID, ISSUER, __setFetchForTests };
