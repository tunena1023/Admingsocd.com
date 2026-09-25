/* ============================================================
   lib/push.js — notificaciones push a los tecnicos (tech.gsocd.com
   guarda sus suscripciones en PushSubscriptions).

   Rehecho el 25/09/2026 (pedido del dueño: "los tecnicos no ven
   emails... quiero push notificaciones para ellos: si se les asigna
   algo, si se cambia algo, si se cancela algo"). Lo de antes:
   - se mandaba sin await: en Vercel la funcion se apaga al responder y
     el push casi nunca salia;
   - solo avisaba a los de Scheduling (no a Assign by service ni a la
     inspeccion), siempre en ingles y siempre abria employee.html.

   Ahora: pushOrderDiff(antes, despues) compara QUIEN esta en la orden
   antes y despues del cambio y a cada persona le manda lo suyo:
     - le asignaron algo nuevo  -> 'assigned' / 'inspection'
     - ya estaba y cambio fecha, horario, direccion o servicios -> 'changed'
     - se lo quitaron           -> 'removed'
     - la orden se cancelo      -> 'cancelled'
   En su idioma (Techs.Language) y abriendo su portal (Supervisor ->
   supervisor.html). Quien es cada nombre se busca en Techs (nombre
   completo, PayrollID o "tech:<id>", igual que Scheduling).

   Nunca tumba el guardado de la orden: todo error se traga (y se
   escribe en el log), y cada envio tiene tope de tiempo.
============================================================ */

const webpush = require('web-push');
const { graphFetch, siteListPath, deleteListItem, TECHS_LIST, SCHEDULING_LIST, PUSH_SUBSCRIPTIONS_LIST, SERVICE_ASSIGNMENTS_LIST } = require('./graph');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const ENABLED = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (ENABLED) webpush.setVapidDetails('mailto:orders@gsocd.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const TIMEOUT_MS = 5000;
const low = s => String(s || '').trim().toLowerCase();
const names = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const withTimeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(res, ms))]);

async function fetchAll(listName, filter) {
  let url = siteListPath(listName) + '?$expand=fields&$top=500' + (filter ? '&$filter=' + encodeURIComponent(filter) : '');
  const out = [];
  while (url) {
    const data = await graphFetch(url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/* ---------- textos ---------- */
function fmtDay(v, lang) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString(lang === 'es' ? 'es-MX' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/* kind: assigned | inspection | changed | removed | cancelled
   info: { date, window, what: [..], service } */
function message(kind, o, info, lang) {
  const es = lang === 'es';
  const id = o.OrderID || '';
  const unit = o.UnitNumber ? (es ? ' · Unidad ' : ' · Unit ') + o.UnitNumber : '';
  const place = (o.BusinessName || o.ClientID || '') + unit;
  const when = [fmtDay(info.date, lang), info.window || ''].filter(Boolean).join(' · ');
  const addr = o.Address || '';
  switch (kind) {
    case 'assigned':
      return {
        title: es ? 'Trabajo nuevo: ' + place : 'New job: ' + place,
        body: [when, addr, id].filter(Boolean).join('\n')
      };
    case 'inspection':
      return {
        title: es ? 'Inspección asignada: ' + place : 'Inspection assigned: ' + place,
        body: [when, addr, id].filter(Boolean).join('\n')
      };
    case 'changed': {
      const LBL = es
        ? { date: 'Fecha nueva', window: 'Horario nuevo', address: 'Dirección nueva', services: 'Cambiaron los servicios', inspection: 'Inspección cambiada' }
        : { date: 'New date', window: 'New time', address: 'New address', services: 'Services changed', inspection: 'Inspection changed' };
      const lines = (info.what || []).map(w =>
        w === 'date' ? LBL.date + ': ' + fmtDay(info.date, lang)
          : w === 'window' ? LBL.window + ': ' + (info.window || '')
            : w === 'address' ? LBL.address + ': ' + addr
              : LBL[w] || w);
      return {
        title: es ? 'Cambio en tu trabajo: ' + place : 'Job changed: ' + place,
        body: lines.concat([id]).filter(Boolean).join('\n')
      };
    }
    case 'removed':
      return {
        title: es ? 'Ya no tienes este trabajo: ' + place : 'Job removed: ' + place,
        body: [es ? 'La oficina te quitó de esta orden.' : 'The office took you off this order.', when, id].filter(Boolean).join('\n')
      };
    case 'cancelled':
      return {
        title: es ? 'Trabajo cancelado: ' + place : 'Job cancelled: ' + place,
        body: [es ? 'No vayas: la orden se canceló.' : 'Do not go: this order was cancelled.', when, id].filter(Boolean).join('\n')
      };
    default:
      return { title: 'GS Solutions', body: id };
  }
}

/* ---------- a quien ---------- */
function techKey(t) { return String(t.fields.PayrollID || '').trim() || ('tech:' + t.id); }
function fullName(t) { return low((t.fields.FirstName || '') + ' ' + (t.fields.LastName || '')); }

/* people: [{ name } | { payroll }] -> renglones de Techs (sin repetir) */
function resolveTechs(techs, people) {
  const out = new Map();
  people.forEach(p => {
    const hit = techs.find(t => {
      if (!t.fields) return false;
      if (p.payroll) return low(p.payroll) === low(t.fields.PayrollID) || low(p.payroll) === low('tech:' + t.id);
      return p.name && fullName(t) === low(p.name);
    });
    if (hit) out.set(hit.id, hit);
  });
  return [...out.values()];
}

async function sendTo(tech, kind, order, info) {
  const lang = low(tech.fields.Language) === 'es' ? 'es' : 'en';
  const role = String(tech.fields.Role || 'Employee');
  const msg = message(kind, order, info, lang);
  const payload = JSON.stringify(Object.assign(msg, {
    url: (role === 'Supervisor' || role === 'Developer') ? '/supervisor.html' : '/employee.html',
    /* Mismo tag por orden: varias pushes seguidas (p. ej. 3 servicios
       asignados uno por uno) se reemplazan en vez de amontonarse. */
    tag: (order.OrderID || 'gs') + '-' + kind
  }));
  const subs = await fetchAll(PUSH_SUBSCRIPTIONS_LIST, `fields/PayrollID eq '${techKey(tech).replace(/'/g, "''")}'`);
  await Promise.all(subs.map(async row => {
    const f = row.fields || {};
    if (!f.Endpoint) return;
    try {
      await webpush.sendNotification({ endpoint: f.Endpoint, keys: { p256dh: f.P256dh, auth: f.Auth } }, payload, { TTL: 24 * 3600 });
    } catch (e) {
      /* 404/410: ese telefono ya no acepta avisos (borro datos, quito la app). */
      if (e.statusCode === 410 || e.statusCode === 404) await deleteListItem(PUSH_SUBSCRIPTIONS_LIST, row.id).catch(() => {});
      else console.error('push: send failed', e.statusCode || '', e.message);
    }
  }));
  return subs.length;
}

/* sends: [{ people: [{name}|{payroll}], kind, info }] */
async function deliver(order, sends) {
  if (!ENABLED || !sends.length) return;
  try {
    const techs = await fetchAll(TECHS_LIST);
    const jobs = [];
    const done = new Set();
    sends.forEach(s => resolveTechs(techs, s.people).forEach(t => {
      const k = t.id + '|' + s.kind;
      if (done.has(k)) return;
      done.add(k);
      jobs.push(sendTo(t, s.kind, order, s.info || {}).then(n => console.log('push:', s.kind, order.OrderID, fullName(t), n + ' device(s)')));
    }));
    await withTimeout(Promise.allSettled(jobs), TIMEOUT_MS);
  } catch (e) {
    console.error('push: deliver failed', e.message);
  }
}

/* ---------- que cambio ---------- */
const INSP_STATUSES = ['Inspection'];

/* before/after: campos de la orden (after = before + patch).
   opts.saBefore/saAfter: nombres de ServiceAssignments (AssignByService).
   opts.servicesChanged: la lista de servicios cambio.
   opts.schedulingPayrolls: PayrollNumbers de Scheduling (primera asignacion). */
function planOrderDiff(before, after, opts) {
  opts = opts || {};
  const sends = [];
  const workBefore = new Set(names(before.Supervisor).concat(opts.saBefore || []).map(low));
  const workAfter = new Set(names(after.Supervisor).concat(opts.saAfter || []).map(low));
  const inspBefore = INSP_STATUSES.includes(before.Status) ? low(before.InspectionBy) : '';
  const inspAfter = INSP_STATUSES.includes(after.Status) ? low(after.InspectionBy) : '';
  const nameOf = new Map();
  names(before.Supervisor).concat(names(after.Supervisor), opts.saBefore || [], opts.saAfter || [], [before.InspectionBy || '', after.InspectionBy || ''])
    .forEach(n => { if (n) nameOf.set(low(n), n); });
  const P = arr => arr.filter(Boolean).map(n => ({ name: nameOf.get(n) || n }));
  const workInfo = o => ({ date: o.DispatchDate, window: o.ServiceWindow });
  const inspInfo = o => ({ date: o.InspectionDate, window: o.InspectionWindow });

  if (after.Status === 'Cancelled' && before.Status !== 'Cancelled') {
    sends.push({ people: P([...workBefore, inspBefore]), kind: 'cancelled', info: workInfo(before) });
    return sends;
  }

  /* Trabajo */
  const added = [...workAfter].filter(n => !workBefore.has(n));
  const removed = [...workBefore].filter(n => !workAfter.has(n));
  const stayed = [...workAfter].filter(n => workBefore.has(n));
  if (added.length) {
    const people = P(added).concat((opts.schedulingPayrolls || []).map(p => ({ payroll: p })));
    sends.push({ people, kind: 'assigned', info: workInfo(after) });
  }
  if (removed.length) sends.push({ people: P(removed), kind: 'removed', info: workInfo(before) });
  if (stayed.length) {
    const what = [];
    if (String(before.DispatchDate || '').slice(0, 10) !== String(after.DispatchDate || '').slice(0, 10) && after.DispatchDate) what.push('date');
    if (String(before.ServiceWindow || '') !== String(after.ServiceWindow || '') && after.ServiceWindow) what.push('window');
    if (String(before.Address || '') !== String(after.Address || '')) what.push('address');
    if (opts.servicesChanged) what.push('services');
    if (what.length) sends.push({ people: P(stayed), kind: 'changed', info: Object.assign(workInfo(after), { what }) });
  }

  /* Inspeccion */
  if (inspAfter && inspAfter !== inspBefore) sends.push({ people: P([inspAfter]), kind: 'inspection', info: inspInfo(after) });
  if (inspBefore && inspBefore !== inspAfter && !(after.Status === 'Inspected')) {
    sends.push({ people: P([inspBefore]), kind: 'removed', info: inspInfo(before) });
  }
  if (inspAfter && inspAfter === inspBefore) {
    const what = [];
    if (String(before.InspectionDate || '').slice(0, 10) !== String(after.InspectionDate || '').slice(0, 10)) what.push('date');
    if (String(before.InspectionWindow || '') !== String(after.InspectionWindow || '')) what.push('window');
    if (what.length) sends.push({ people: P([inspAfter]), kind: 'changed', info: Object.assign(inspInfo(after), { what: ['inspection'].concat(what) }) });
  }
  return sends;
}

async function pushOrderDiff(before, after, opts) {
  try {
    const order = Object.assign({}, before, after);
    await deliver(order, planOrderDiff(before, after, opts));
  } catch (e) {
    console.error('push: pushOrderDiff failed', e.message);
  }
}

/* PayrollNumbers de Scheduling de una orden (para la primera asignacion). */
async function schedulingPayrolls(orderId) {
  try {
    const rows = await fetchAll(SCHEDULING_LIST, `fields/OrderID eq '${String(orderId).replace(/'/g, "''")}'`);
    return [...new Set(rows.map(r => String((r.fields && r.fields.PayrollNumber) || '').trim()).filter(Boolean))];
  } catch (e) { return []; }
}

/* Nombres en ServiceAssignments de una orden (Assign by service). */
async function serviceAssignees(orderId) {
  try {
    const rows = await fetchAll(SERVICE_ASSIGNMENTS_LIST, `fields/OrderID eq '${String(orderId).replace(/'/g, "''")}'`);
    return [...new Set(rows.flatMap(r => names(r.fields && r.fields.AssignedTo)))];
  } catch (e) { return []; }
}

module.exports = { pushOrderDiff, planOrderDiff, message, schedulingPayrolls, serviceAssignees };
