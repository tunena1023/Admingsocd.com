/* ============================================================
   lib/push.js — manda notificaciones push a los tecnicos asignados de
   una orden, leyendo las suscripciones que tech.gsocd.com guarda en
   PushSubscriptions.

   Los tecnicos asignados de verdad a una orden viven en Scheduling
   (PayrollNumber) -- NO en el campo de texto Supervisor de la orden,
   mismo criterio ya confirmado y usado por tech.gsocd.com (ver
   get-my-orders.js de ese repo).

   3 momentos donde se llama (confirmados con el usuario), todos desde
   admin-update-order.js:
     1) Se asigna una orden nueva (Supervisor+Ventana+Fecha pasan de
        vacio a tener valor)
     2) Algo cambia en una orden ya asignada (mismo campos "control"
        que ya regeneran el PDF)
     3) Se marca la orden como Completed

   Nunca debe tumbar el guardado real de la orden si algo aqui falla
   (llaves VAPID sin configurar todavia, un tecnico sin suscripcion,
   el servicio de push caido, etc.) -- todo el modulo es silencioso
   ante errores a proposito.
============================================================ */

const webpush = require('web-push');
const { graphFetch, siteListPath, deleteListItem, SCHEDULING_LIST, PUSH_SUBSCRIPTIONS_LIST } = require('./graph');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:orders@gsocd.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function fetchByField(listName, fieldName, value) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${String(value).replace(/'/g, "''")}'`);
  const url = siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const data = await graphFetch(url);
  return data.value || [];
}

async function getAssignedPayrollIds(orderId) {
  const rows = await fetchByField(SCHEDULING_LIST, 'OrderID', orderId);
  const ids = new Set();
  rows.forEach(r => {
    const pn = r.fields && String(r.fields.PayrollNumber || '').trim();
    if (pn) ids.add(pn);
  });
  return Array.from(ids);
}

async function sendPushToPayrollId(payrollId, payload) {
  const subs = await fetchByField(PUSH_SUBSCRIPTIONS_LIST, 'PayrollID', payrollId);
  const body = JSON.stringify(payload);
  await Promise.all(subs.map(async (row) => {
    const f = row.fields || {};
    if (!f.Endpoint) return;
    const subscription = { endpoint: f.Endpoint, keys: { p256dh: f.P256dh, auth: f.Auth } };
    try {
      await webpush.sendNotification(subscription, body);
    } catch (e) {
      /* 410/404 = el navegador ya no reconoce esta suscripcion
         (usuario borro datos, desinstalo, etc.) -- se borra para no
         seguir intentando en vano cada vez. */
      if (e.statusCode === 410 || e.statusCode === 404) {
        await deleteListItem(PUSH_SUBSCRIPTIONS_LIST, row.id).catch(() => {});
      }
    }
  }));
}

/* Punto de entrada unico. payload: { title, body, url } */
async function notifyOrderTechs(orderId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return; /* llaves no configuradas todavia en Vercel */
  try {
    const payrollIds = await getAssignedPayrollIds(orderId);
    await Promise.all(payrollIds.map(pid => sendPushToPayrollId(pid, payload)));
  } catch (e) {
    /* silencioso a proposito */
  }
}

module.exports = { notifyOrderTechs };
