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

/* 25/09/2026 (bug real al conectar el QuickBooks real: "Could not read
   the QuickBooks setup: Invalid request"): la columna Value de Settings
   no acepta mas de ~255 caracteres y el access token de produccion es
   mucho mas largo. Ahora cada valor se guarda en trozos con
   lib/settings-json (clave, clave#2, ...), igual que los mapas de areas
   y paquetes. Un valor corto sigue siendo un solo renglon, igual que
   antes, asi que lo que ya estaba guardado se sigue leyendo. */
const sj = require('./settings-json');

/* Sandbox y produccion NO comparten datos (25/09/2026): test-admin se
   queda en el sandbox y admin.gsocd.com pasa al QuickBooks real, pero
   los dos leen la MISMA lista Settings. Los Ids del sandbox (tokens,
   compania, articulos, clientes, campos, ordenes ya mandadas) no sirven
   en la compania real -- usarlos ahi mandaria articulos o clientes
   equivocados. En produccion esas llaves llevan "prod_" adelante; el
   sandbox sigue con las de siempre. qb_send_perms (quien puede mandar
   que) es de personas, no de QuickBooks: se comparte. */
function envKey(key) {
  return qbEnvironment() === 'production' && /^qb_/.test(key) && key !== 'qb_send_perms' ? 'prod_' + key : key;
}

async function getSetting(key) {
  key = envKey(key);
  const rows = await sj.fetchSettingsRows();
  if (!sj.rowsForKey(rows, key).length) return null;
  return sj.joinValue(rows, key);
}

async function saveSetting(key, value) {
  key = envKey(key);
  await sj.writeText(key, value == null ? '' : String(value));
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

async function refreshTokensNow() {
  const refreshToken = await getSetting('qb_refresh_token');
  if (!refreshToken) throw new Error('QuickBooks is not connected yet.');
  let data;
  try {
    data = await requestTokens({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
  } catch (e) {
    /* Refresh token vencido o revocado (invalid_grant, 25/09/2026 --
       cuestionario de Intuit): ya no sirve reintentar. Se borra la
       conexion para que el panel ensene "Connect to QuickBooks" y
       alguien la vuelva a autorizar. */
    if (/invalid_grant/i.test(e.message)) {
      memToken = null;
      await Promise.all([saveSetting('qb_refresh_token', ''), saveSetting('qb_access_token', ''), saveSetting('qb_access_token_expires_at', '')]);
      throw new Error('The QuickBooks connection expired. Open QuickBooks in Admin and click Connect to QuickBooks again.');
    }
    throw e;
  }
  await storeTokens(data, null);
  return data;
}

/* Una sola renovacion a la vez (25/09/2026, bug real en produccion:
   "The resource has changed since the caller last read it; usually an
   eTag mismatch"). El panel pide 3 cosas a QuickBooks en paralelo; con
   el token vencido las 3 renovaban y escribian los mismos renglones de
   Settings al mismo tiempo, y SharePoint rechazaba a las que llegaban
   tarde. Ahora la primera renueva y las demas esperan ese resultado. El
   token vigente tambien se recuerda en memoria mientras vive el
   servidor, para no leer Settings en cada llamada. */
let refreshing = null;
let memToken = null; /* { env, token, exp } */
function refreshTokens() {
  if (!refreshing) refreshing = refreshTokensNow().finally(() => { refreshing = null; });
  return refreshing;
}

async function storeTokens(data, realmId) {
  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  memToken = { env: qbEnvironment(), token: data.access_token, exp: expiresAt };
  /* Una por una (no en paralelo): cada una lee y escribe Settings. */
  /* refresh_token viene en CADA respuesta (tambien al refrescar) --
     QuickBooks lo rota; hay que guardar siempre el mas reciente. */
  await saveSetting('qb_refresh_token', data.refresh_token);
  await saveSetting('qb_access_token', data.access_token);
  await saveSetting('qb_access_token_expires_at', String(expiresAt));
  if (realmId) await saveSetting('qb_realm_id', String(realmId));
}

/* ---- Paso 3: access token vigente (refresca solo si ya expiro) ---- */

async function getValidAccessToken() {
  if (memToken && memToken.env === qbEnvironment() && Date.now() < memToken.exp - 60000) return memToken.token;
  const [accessToken, expiresAtStr] = await Promise.all([
    getSetting('qb_access_token'),
    getSetting('qb_access_token_expires_at')
  ]);
  const expiresAt = Number(expiresAtStr) || 0;
  /* 60s de margen -- evita usar un token que expira a medio request. */
  if (accessToken && Date.now() < expiresAt - 60000) {
    memToken = { env: qbEnvironment(), token: accessToken, exp: expiresAt };
    return accessToken;
  }
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

async function qbFetch(path, options = {}, retried) {
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
  /* intuit_tid (25/09/2026): Intuit lo pide en su cuestionario de
     produccion -- es el numero con el que su soporte encuentra una
     llamada. Va en el mensaje de error y en el log, y en la respuesta
     (_tid) para guardarlo en el historial de la orden. */
  const tid = res.headers.get('intuit_tid') || '';
  /* 401 = el access token ya no sirve aunque no habia vencido (p. ej.
     lo revocaron): se renueva y se reintenta UNA sola vez. */
  if (res.status === 401 && !retried) {
    memToken = null;
    await refreshTokens();
    return qbFetch(path, options, true);
  }
  if (!res.ok) {
    const detail = (data.Fault && data.Fault.Error && data.Fault.Error[0] && (data.Fault.Error[0].Detail || data.Fault.Error[0].Message)) || ('HTTP ' + res.status);
    console.error('QuickBooks API error', res.status, path.split('?')[0], 'intuit_tid=' + tid, detail);
    throw new Error('QuickBooks API error: ' + detail + (tid ? ' (intuit_tid ' + tid + ')' : ''));
  }
  if (tid && data && typeof data === 'object') Object.defineProperty(data, '_tid', { value: tid, enumerable: false });
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
  const it = await findItemBySku(sku);
  return it ? it.id : null;
}

/* 25/09/2026 (mapeo del invoice real, #5177): tambien hace falta saber
   si el articulo cobra impuesto -- en el invoice real las lineas salen
   con "T". Se guarda { id, taxable } en el mismo mapa; las entradas
   viejas (solo el id) se completan la primera vez que se usan. */
async function findItemBySku(sku) {
  const map = await getJsonSetting('qb_item_id_map');
  const hit = map[sku];
  if (hit && typeof hit === 'object' && hit.id) return hit;
  let item;
  if (hit) {
    const data = await qbQuery(`select * from Item where Id = '${String(hit).replace(/'/g, "\\'")}'`);
    item = ((data.QueryResponse && data.QueryResponse.Item) || [])[0];
  } else {
    const escaped = String(sku).replace(/'/g, "\\'");
    const data = await qbQuery(`select * from Item where Sku = '${escaped}'`);
    item = ((data.QueryResponse && data.QueryResponse.Item) || [])[0];
  }
  if (!item) return null;
  const out = { id: item.Id, taxable: item.Taxable === true };
  await setJsonSettingEntry('qb_item_id_map', sku, out);
  return out;
}

/* ---- Customers: buscar por nombre, autocrear si no existe --
   confirmado con el dueno (19/09/2026): los clientes normalmente YA
   existen en QuickBooks (el mismo reporte de donde se importaron a
   esta plataforma), pero un cliente capturado despues de ese reporte
   puede no estar todavia -- en ese caso SI se crea automatico. */
async function findOrCreateCustomerId(clientId, businessName, addr) {
  const r = await findOrCreateCustomer(clientId, Object.assign({ businessName }, addr || {}));
  return r.id;
}

/* 25/09/2026 (tab "New clients" del panel de QuickBooks): lo mismo
   pero con todos los datos del cliente (contacto, correo, telefono,
   suite) al crearlo, y dice que paso: 'mapped' (ya estaba ligado),
   'linked' (ya existia en QuickBooks con ese nombre, solo se ligo) o
   'created'. Nunca crea dos veces: primero busca por DisplayName. */
/* ---- Todos los clientes de QuickBooks (25/09/2026, tab Clients del
   panel): activos e inactivos, con los datos que se comparan contra la
   app. Pocas decenas en GS; se pagina por si acaso. */
async function listCustomers() {
  const out = [];
  for (let start = 1; start <= 5001; start += 1000) {
    const data = await qbQuery(`select * from Customer where Active in (true, false) startposition ${start} maxresults 1000`);
    const rows = (data.QueryResponse && data.QueryResponse.Customer) || [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/* Como se ve un Customer de QuickBooks en el lenguaje de la app. */
function customerView(cu) {
  const a = cu.BillAddr || {};
  return {
    id: String(cu.Id),
    active: cu.Active !== false,
    businessName: cu.DisplayName || '',
    contactPerson: [cu.GivenName, cu.FamilyName].filter(Boolean).join(' '),
    email: (cu.PrimaryEmailAddr && cu.PrimaryEmailAddr.Address) || '',
    phone: (cu.PrimaryPhone && cu.PrimaryPhone.FreeFormNumber) || '',
    address: a.Line1 || '',
    suite: a.Line2 || '',
    city: a.City || '',
    state: a.CountrySubDivisionCode || '',
    zip: a.PostalCode || ''
  };
}

/* Campos de Customer desde los datos de la app. */
function customerPayload(c) {
  const name = String(c.businessName || '').trim();
  const payload = { DisplayName: name, CompanyName: name };
  const person = String(c.contactPerson || '').trim().split(/\s+/).filter(Boolean);
  payload.GivenName = person[0] || '';
  payload.FamilyName = person.slice(1).join(' ');
  /* Vacios no se mandan (QuickBooks rechaza un correo vacio). */
  if (String(c.email || '').trim()) payload.PrimaryEmailAddr = { Address: String(c.email).trim() };
  if (String(c.phone || '').trim()) payload.PrimaryPhone = { FreeFormNumber: String(c.phone).trim() };
  payload.BillAddr = { Line1: c.address || '', Line2: c.suite || '', City: c.city || '', CountrySubDivisionCode: c.state || 'IA', PostalCode: c.zip || '' };
  return payload;
}

async function createCustomer(c) {
  const created = await qbFetch('/customer', { method: 'POST', body: customerPayload(c) });
  return created.Customer;
}

/* Actualiza un Customer que ya existe (sparse: solo lo que se manda). */
async function updateCustomer(id, c) {
  const cur = await qbFetch('/customer/' + encodeURIComponent(id));
  const payload = Object.assign(customerPayload(c), { Id: String(id), SyncToken: cur.Customer.SyncToken, sparse: true });
  const res = await qbFetch('/customer', { method: 'POST', body: payload });
  return res.Customer;
}

async function linkCustomers(pairs) {
  if (!Object.keys(pairs).length) return;
  const map = await getJsonSetting('qb_customer_id_map');
  Object.assign(map, pairs);
  await saveSetting('qb_customer_id_map', JSON.stringify(map));
}

/* Al mandar ordenes (25/09/2026, el dueño: el cliente de la app no existia
   en QuickBooks y la app lo creaba sola con datos incompletos). Ahora solo
   BUSCA: ligado por ClientID o mismo nombre. Si no esta, regresa null y
   quien llama avisa que se agregue en QuickBooks > Clients. */
async function findCustomerId(clientId, businessName) {
  const map = await getJsonSetting('qb_customer_id_map');
  if (map[clientId]) return map[clientId];
  const escaped = String(businessName || '').trim().replace(/'/g, "\\'");
  if (!escaped) return null;
  const data = await qbQuery(`select * from Customer where DisplayName = '${escaped}'`);
  const cu = ((data.QueryResponse && data.QueryResponse.Customer) || [])[0];
  if (!cu) return null;
  await setJsonSettingEntry('qb_customer_id_map', clientId, String(cu.Id));
  return String(cu.Id);
}

async function findOrCreateCustomer(clientId, c) {
  const map = await getJsonSetting('qb_customer_id_map');
  if (map[clientId]) return { id: map[clientId], how: 'mapped' };
  const name = String(c.businessName || '').trim() || clientId;
  const escaped = name.replace(/'/g, "\\'");
  const data = await qbQuery(`select * from Customer where DisplayName = '${escaped}'`);
  const customers = (data.QueryResponse && data.QueryResponse.Customer) || [];
  let id, how;
  if (customers.length) {
    id = customers[0].Id; how = 'linked';
  } else {
    const payload = { DisplayName: name, CompanyName: name };
    const person = String(c.contactPerson || '').trim().split(/\s+/).filter(Boolean);
    if (person.length) { payload.GivenName = person[0]; if (person.length > 1) payload.FamilyName = person.slice(1).join(' '); }
    if (c.email) payload.PrimaryEmailAddr = { Address: String(c.email).trim() };
    if (c.phone) payload.PrimaryPhone = { FreeFormNumber: String(c.phone).trim() };
    if (c.address || c.city || c.zip) {
      payload.BillAddr = { Line1: c.address || '', City: c.city || '', PostalCode: c.zip || '' };
      if (c.suite) payload.BillAddr.Line2 = c.suite;
    }
    const created = await qbFetch('/customer', { method: 'POST', body: payload });
    id = created.Customer.Id; how = 'created';
  }
  await setJsonSettingEntry('qb_customer_id_map', clientId, id);
  return { id, how };
}

async function createEstimate(payload) {
  return qbFetch('/estimate', { method: 'POST', body: payload });
}

/* Estimate o Invoice (boton del panel, 25/09/2026): el mismo documento,
   solo cambia a donde se manda. */
/* ENHANCED = los campos personalizados "nuevos" de QuickBooks (los de
   GS: UNIT #, BEDROOMS, BATHROOMS). Solo se ven y se guardan si la
   peticion los pide con este parametro. */
const ENHANCED = 'minorversion=75&include=enhancedAllCustomFields';

async function createSalesDoc(type, payload) {
  const path = (type === 'invoice' ? '/invoice' : '/estimate') + '?' + ENHANCED;
  const data = await qbFetch(path, { method: 'POST', body: payload });
  const doc = data.Invoice || data.Estimate;
  if (doc && data._tid) doc._tid = data._tid;
  return doc;
}

/* ---- Quien puede mandar que (25/09/2026, el dueño: "cada quien tiene
   su propio ajuste, quien puede mandar como estimate y quien puede
   mandar como invoice"). Se edita en Developer > Staff & Roles. Un
   blob JSON en Settings por correo (en minusculas), asi no hace falta
   crear columnas en Staff. Quien no tiene nada guardado puede mandar
   Estimate (como hasta hoy) pero no Invoice. */
const DEFAULT_SEND_PERMS = { estimate: true, invoice: false };
async function getAllSendPerms() {
  return getJsonSetting('qb_send_perms');
}
function sendPermsFrom(all, email) {
  const p = all[String(email || '').trim().toLowerCase()];
  return p ? { estimate: !!p.estimate, invoice: !!p.invoice } : Object.assign({}, DEFAULT_SEND_PERMS);
}
async function getSendPerms(email) {
  return sendPermsFrom(await getAllSendPerms(), email);
}
async function setSendPerms(email, perms) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return;
  await setJsonSettingEntry('qb_send_perms', key, { estimate: !!perms.estimate, invoice: !!perms.invoice });
}

/* ---- Como esta armada la compania de QuickBooks (Preferences) --
   los 3 campos personalizados de ventas (en el invoice real: UNIT #,
   BEDROOMS, BATHROOMS) con su DefinitionId, y si usan Class /
   Location. Se lee de QuickBooks cada vez (no se adivina), asi el
   sandbox y produccion funcionan igual aunque los campos esten en
   otro orden. */
async function getCompanySetup() {
  const data = await qbQuery('select * from Preferences');
  const prefs = ((data.QueryResponse && data.QueryResponse.Preferences) || [])[0] || {};
  const flat = [];
  ((prefs.SalesFormsPrefs && prefs.SalesFormsPrefs.CustomField) || []).forEach(g => (g.CustomField || []).forEach(x => flat.push(x)));
  const customFields = [];
  for (let n = 1; n <= 3; n++) {
    const on = flat.find(x => x.Name === 'SalesFormsPrefs.UseSalesCustomName' + n);
    const name = flat.find(x => x.Name === 'SalesFormsPrefs.SalesCustomName' + n);
    if (on && on.BooleanValue && name && name.StringValue) customFields.push({ definitionId: String(n), name: name.StringValue });
  }
  /* Campos NUEVOS (25/09/2026, revisado en el QuickBooks real de GS:
     UNIT # / BEDROOMS / BATHROOMS son de este tipo y NO salen en
     Preferences). Intuit solo da la lista de definiciones a apps socias
     (permiso custom-field-definitions, que la app de GS no tiene), pero
     un invoice o estimate que YA los tiene llenos trae el DefinitionId
     de cada uno. Se buscan en los ultimos documentos y se guardan en
     Settings (qb_custom_field_ids) para no buscarlos cada vez. */
  if (!customFields.length) {
    (await discoverEnhancedFields()).forEach(f => customFields.push(f));
  }
  const acc = prefs.AccountingInfoPrefs || {};
  return {
    customFields,
    classTracking: !!(acc.ClassTrackingPerTxn || acc.ClassTrackingPerTxnLine),
    locationTracking: !!acc.TrackDepartments,
    locationLabel: acc.DepartmentTerminology || 'Location'
  };
}

/* ---- Class y Department (25/09/2026, revisado en el QuickBooks real
   de GS): cada linea lleva Class (Janitorial, Renovations...) y cada
   invoice un Department "<Division> Services:<Commercial|Residential>".
   Se leen de QuickBooks (listas chicas) para no adivinar Ids. */
async function getClassesAndDepartments() {
  const [c, d] = await Promise.all([
    qbQuery('select * from Class maxresults 1000'),
    qbQuery('select * from Department maxresults 1000')
  ]);
  const pick = x => ({ id: String(x.Id), name: x.Name || '', full: x.FullyQualifiedName || x.Name || '' });
  return {
    classes: ((c.QueryResponse && c.QueryResponse.Class) || []).filter(x => x.Active !== false).map(pick),
    departments: ((d.QueryResponse && d.QueryResponse.Department) || []).filter(x => x.Active !== false).map(pick)
  };
}

async function discoverEnhancedFields() {
  const cached = await getJsonSetting('qb_custom_field_ids');
  const found = Object.assign({}, cached);
  const want = [/unit/i, /bed/i, /bath/i];
  const done = () => want.every(re => Object.keys(found).some(n => re.test(n)));
  if (!done()) {
    for (const entity of ['Invoice', 'Estimate']) {
      const q = `select * from ${entity} orderby MetaData.CreateTime desc maxresults 200`;
      const data = await qbFetch('/query?query=' + encodeURIComponent(q) + '&' + ENHANCED);
      ((data.QueryResponse && data.QueryResponse[entity]) || []).forEach(doc => (doc.CustomField || []).forEach(cf => {
        if (cf && cf.DefinitionId && cf.Name && !found[cf.Name]) found[cf.Name] = String(cf.DefinitionId);
      }));
      if (done()) break;
    }
    if (JSON.stringify(found) !== JSON.stringify(cached)) await saveSetting('qb_custom_field_ids', JSON.stringify(found));
  }
  return Object.keys(found).map(name => ({ definitionId: found[name], name }));
}

/* ---- Numero del documento (25/09/2026, el dueño: "debe mantener
   continuidad con lo que ya hay en QB ... si en QB ya tenemos el
   estimate 1058 desde ahi se sube el que sigue").
   - Si la compania NO usa numeros personalizados (CustomTxnNumbers
     apagado), QuickBooks pone el siguiente numero solo: no se manda
     DocNumber.
   - Si SI los usa, QuickBooks no numera lo que llega por la API (se
     quedaria sin numero). Entonces se busca el numero mas alto de ese
     tipo de documento y se usa el siguiente, revisando que nadie lo
     tenga ya. Nunca se toca ni se renumera un documento existente. */
async function usesCustomTxnNumbers() {
  const data = await qbQuery('select * from Preferences');
  const prefs = ((data.QueryResponse && data.QueryResponse.Preferences) || [])[0] || {};
  return !!(prefs.SalesFormsPrefs && prefs.SalesFormsPrefs.CustomTxnNumbers);
}

async function nextDocNumber(type) {
  const entity = type === 'invoice' ? 'Invoice' : 'Estimate';
  let max = 0;
  for (let start = 1; start <= 2001; start += 1000) {
    const data = await qbQuery(`select DocNumber from ${entity} orderby MetaData.CreateTime desc startposition ${start} maxresults 1000`);
    const rows = (data.QueryResponse && data.QueryResponse[entity]) || [];
    rows.forEach(r => { const n = /^\d+$/.test(String(r.DocNumber || '')) ? Number(r.DocNumber) : 0; if (n > max) max = n; });
    if (rows.length < 1000) break;
  }
  let next = max + 1;
  for (let i = 0; i < 20; i++, next++) {
    const hit = await qbQuery(`select Id from ${entity} where DocNumber = '${next}'`);
    if (!((hit.QueryResponse && hit.QueryResponse[entity]) || []).length) return String(next);
  }
  throw new Error('Could not find a free ' + entity + ' number in QuickBooks.');
}

/* ---- Ordenes ya importadas (para el badge/checkbox en la lista) ---- */

async function getImportedOrders() {
  return getJsonSetting('qb_imported_orders');
}
async function markOrderImported(orderId, estimateId, docNumber, type) {
  await setJsonSettingEntry('qb_imported_orders', orderId, {
    estimateId, docNumber: docNumber || '', type: type || 'estimate', date: new Date().toISOString()
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
  findOrCreateCustomer,
  findCustomerId,
  listCustomers,
  customerView,
  createCustomer,
  updateCustomer,
  linkCustomers,
  createEstimate,
  createSalesDoc,
  getSendPerms,
  getAllSendPerms,
  sendPermsFrom,
  setSendPerms,
  getCompanySetup,
  getClassesAndDepartments,
  usesCustomTxnNumbers,
  nextDocNumber,
  findItemBySku,
  getJsonSetting,
  getImportedOrders,
  markOrderImported,
  getSetting, saveSetting, deleteSetting,
  jsonResponse
};
