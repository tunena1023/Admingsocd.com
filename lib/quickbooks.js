/* ============================================================
   lib/quickbooks.js — conexion real a QuickBooks Online (Accounting
   API), OAuth 2.0 authorization_code + refresh_token.

   Credenciales: SIEMPRE desde variables de entorno de Vercel
   (QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET) -- nunca escritas
   en el repo. Ambiente sandbox por ahora (QUICKBOOKS_ENVIRONMENT=
   'sandbox' | 'production', default sandbox si no esta puesta).

   Tokens: se guardan en la lista Settings (Key/Value) que ya existe
   -- mismo patron que developer-admin.js (get-settings/save-setting),
   no hizo falta crear ninguna lista nueva:
     qb_access_token, qb_access_token_expires_at (epoch ms),
     qb_refresh_token, qb_realm_id (el ID de la compañia de
     QuickBooks conectada), qb_oauth_state (temporal, solo durante
     el intercambio, se borra despues de usarse).

   Alcance (scope) usado: SOLO com.intuit.quickbooks.accounting --
   sin Payments, confirmado con el dueno (19/09/2026).
============================================================ */

const {
  SETTINGS_LIST,
  queryList, createListItem, updateListItemByItemId,
  jsonResponse
} = require('./graph');

const QB_SCOPE = 'com.intuit.quickbooks.accounting';
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function qbEnvironment() {
  return (process.env.QUICKBOOKS_ENVIRONMENT || 'sandbox').toLowerCase();
}

/* Base de la API de Accounting -- distinta segun sandbox/produccion. */
function qbApiBase() {
  return qbEnvironment() === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function qbCredentials() {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI || 'https://admin.gsocd.com/api/quickbooks-callback';
  if (!clientId || !clientSecret) {
    throw new Error('QuickBooks no esta configurado todavia (faltan QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET en Vercel).');
  }
  return { clientId, clientSecret, redirectUri };
}

/* ---- Settings: lectura/escritura, mismo patron que developer-admin.js
   (fetchAll + buscar en JS) -- NO se puede filtrar por Key del lado
   de SharePoint, esa columna no esta indexada. BUG REAL encontrado
   por el dueno en produccion (19/09/2026): la primera version de
   este archivo usaba $filter=fields/Key eq '...', que Graph rechaza
   con "Field 'Key' cannot be referenced in filter... not indexed".
   developer-admin.js nunca lo hacia asi -- trae TODOS los renglones
   de Settings (la lista es chica, no hace falta paginar de verdad)
   y busca el que hace falta en memoria. */

async function fetchAllSettings() {
  return queryList(SETTINGS_LIST, '$expand=fields&$top=200');
}

async function getSetting(key) {
  const rows = await fetchAllSettings();
  const found = rows.find(it => it.fields && it.fields.Key === key);
  return found ? (found.fields.Value || '') : null;
}

async function saveSetting(key, value) {
  const rows = await fetchAllSettings();
  const existing = rows.find(it => it.fields && it.fields.Key === key);
  if (existing) {
    await updateListItemByItemId(SETTINGS_LIST, existing.id, { Value: value == null ? '' : String(value) });
  } else {
    await createListItem(SETTINGS_LIST, { Title: key, Key: key, Value: value == null ? '' : String(value) });
  }
}

async function deleteSetting(key) {
  // No hace falta borrar de verdad -- guardar vacio alcanza y es mas
  // simple (mismo criterio que el resto de Settings).
  await saveSetting(key, '');
}

/* ---- Paso 1: URL de autorizacion (el boton "Connect to QuickBooks") ---- */

function buildAuthorizeUrl(state) {
  const { clientId, redirectUri } = qbCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: QB_SCOPE,
    redirect_uri: redirectUri,
    state
  });
  return QB_AUTH_URL + '?' + params.toString();
}

/* ---- Paso 2: intercambiar el code (o un refresh_token) por tokens ---- */

async function requestTokens(bodyParams) {
  const { clientId, clientSecret } = qbCredentials();
  const basicAuth = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const res = await fetch(QB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basicAuth,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams(bodyParams).toString()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error_description || data.error || ('HTTP ' + res.status);
    throw new Error('QuickBooks token request failed: ' + detail);
  }
  return data; // { access_token, refresh_token, expires_in, x_refresh_token_expires_in, token_type }
}

async function exchangeCodeForTokens(code, realmId) {
  const { redirectUri } = qbCredentials();
  const data = await requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  });
  await storeTokens(data, realmId);
  return data;
}

async function refreshTokens() {
  const refreshToken = await getSetting('qb_refresh_token');
  if (!refreshToken) throw new Error('QuickBooks is not connected yet.');
  const data = await requestTokens({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  await storeTokens(data, null);
  return data;
}

async function storeTokens(data, realmId) {
  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  await Promise.all([
    saveSetting('qb_access_token', data.access_token),
    saveSetting('qb_access_token_expires_at', String(expiresAt)),
    /* refresh_token viene en CADA respuesta (tambien al refrescar) --
       QuickBooks lo rota; hay que guardar siempre el mas reciente. */
    saveSetting('qb_refresh_token', data.refresh_token),
    realmId ? saveSetting('qb_realm_id', String(realmId)) : Promise.resolve()
  ]);
}

/* ---- Paso 3: access token vigente (refresca solo si ya expiro) ---- */

async function getValidAccessToken() {
  const [accessToken, expiresAtStr] = await Promise.all([
    getSetting('qb_access_token'),
    getSetting('qb_access_token_expires_at')
  ]);
  const expiresAt = Number(expiresAtStr) || 0;
  /* 60s de margen -- evita usar un token que expira a medio request. */
  if (accessToken && Date.now() < expiresAt - 60000) return accessToken;
  const refreshed = await refreshTokens();
  return refreshed.access_token;
}

async function isConnected() {
  const [refreshToken, realmId] = await Promise.all([
    getSetting('qb_refresh_token'),
    getSetting('qb_realm_id')
  ]);
  return !!(refreshToken && realmId);
}

/* ---- Llamada generica y autenticada a la Accounting API ---- */

async function qbFetch(path, options = {}) {
  const [accessToken, realmId] = await Promise.all([
    getValidAccessToken(),
    getSetting('qb_realm_id')
  ]);
  if (!realmId) throw new Error('QuickBooks is not connected yet.');
  const url = qbApiBase() + '/v3/company/' + realmId + path;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: Object.assign({
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }, options.headers || {}),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data.Fault && data.Fault.Error && data.Fault.Error[0] && data.Fault.Error[0].Message) || ('HTTP ' + res.status);
    throw new Error('QuickBooks API error: ' + detail);
  }
  return data;
}

/* ---- Consultas tipo SQL de QuickBooks (/query?query=...) ---- */

async function qbQuery(query) {
  return qbFetch('/query?query=' + encodeURIComponent(query));
}

/* ---- Mapeos cacheados -- UN blob JSON por tipo en Settings, no un
   renglon por servicio/cliente (Settings no se puede filtrar del
   lado del servidor, ver bug real del 19/09/2026 mas arriba -- con
   un blob solo se trae/actualiza un renglon, no una lista que crece
   sin limite). */

async function getJsonSetting(key) {
  const raw = await getSetting(key);
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}
async function setJsonSettingEntry(key, entryKey, entryValue) {
  const map = await getJsonSetting(key);
  map[entryKey] = entryValue;
  await saveSetting(key, JSON.stringify(map));
}

/* ---- Items: buscar por SKU. NUNCA se autocrean -- un Item nuevo en
   QuickBooks necesita una cuenta de ingresos (IncomeAccountRef), eso
   no es algo que debamos adivinar por nuestra cuenta. Si no se
   encuentra, quien llama decide que hacer (aqui: no importar esa
   orden, avisar cual servicio falta). SELECT * (no una lista de
   campos) porque Sku se omite en la respuesta si no se pide asi --
   bug real documentado por Intuit. */
async function findItemIdBySku(sku) {
  const map = await getJsonSetting('qb_item_id_map');
  if (map[sku]) return map[sku];
  const escaped = String(sku).replace(/'/g, "\\'");
  const data = await qbQuery(`select * from Item where Sku = '${escaped}'`);
  const items = (data.QueryResponse && data.QueryResponse.Item) || [];
  if (!items.length) return null;
  const id = items[0].Id;
  await setJsonSettingEntry('qb_item_id_map', sku, id);
  return id;
}

/* ---- Customers: buscar por nombre, autocrear si no existe --
   confirmado con el dueno (19/09/2026): los clientes normalmente YA
   existen en QuickBooks (el mismo reporte de donde se importaron a
   esta plataforma), pero un cliente capturado despues de ese reporte
   puede no estar todavia -- en ese caso SI se crea automatico. */
async function findOrCreateCustomerId(clientId, businessName, addr) {
  const map = await getJsonSetting('qb_customer_id_map');
  if (map[clientId]) return map[clientId];
  const escaped = String(businessName || '').replace(/'/g, "\\'");
  const data = await qbQuery(`select * from Customer where DisplayName = '${escaped}'`);
  const customers = (data.QueryResponse && data.QueryResponse.Customer) || [];
  let id;
  if (customers.length) {
    id = customers[0].Id;
  } else {
    const payload = { DisplayName: businessName || clientId };
    if (addr && (addr.address || addr.city || addr.zip)) {
      payload.BillAddr = { Line1: addr.address || '', City: addr.city || '', PostalCode: addr.zip || '' };
    }
    const created = await qbFetch('/customer', { method: 'POST', body: payload });
    id = created.Customer.Id;
  }
  await setJsonSettingEntry('qb_customer_id_map', clientId, id);
  return id;
}

async function createEstimate(payload) {
  return qbFetch('/estimate', { method: 'POST', body: payload });
}

/* ---- Ordenes ya importadas (para el badge/checkbox en la lista) ---- */

async function getImportedOrders() {
  return getJsonSetting('qb_imported_orders');
}
async function markOrderImported(orderId, estimateId, docNumber) {
  await setJsonSettingEntry('qb_imported_orders', orderId, {
    estimateId, docNumber: docNumber || '', date: new Date().toISOString()
  });
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
  getValidAccessToken,
  isConnected,
  qbFetch,
  qbQuery,
  findItemIdBySku,
  findOrCreateCustomerId,
  createEstimate,
  getImportedOrders,
  markOrderImported,
  getSetting, saveSetting, deleteSetting,
  jsonResponse
};
