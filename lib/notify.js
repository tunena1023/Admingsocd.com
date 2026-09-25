/* COPIA LOCAL de gsocd-shared/lib/notify.js -- no editar aqui: se
   cambia alla y se copia tal cual a Admin, Orders y Tech (ver el
   encabezado de abajo y lib/division-rules.js para el porque). */
/* ============================================================
   gsocd-shared/lib/notify.js
   Correos de notificacion de los 3 portales (clientes y oficina),
   mandados desde orders@gsocd.com por Microsoft Graph (sendMail).
   Reemplaza los flows de Power Automate que nunca quedaron armados
   (pedido del dueño, 25/09/2026; vista previa aprobada:
   https://claude.ai/artifact/2VhdVbEYgSsxDwRuvbTNbv).

   Requisito en Azure (ya hecho por el dueño, 25/09/2026): la app
   GSPortal (GRAPH_CLIENT_ID) tiene Mail.Send tipo Application con
   admin consent. Recomendado ademas: Application Access Policy que la
   limite a mandar solo como orders@gsocd.com.

   MISMO CRITERIO QUE division-rules.js: este es el original, y cada
   backend (Admin, Orders, Tech) trae su COPIA en lib/notify.js --
   Vercel reusa su cache de node_modules y no instala tags nuevos de
   gsocd-shared (ver el comentario de lib/division-rules.js en Admin).
   Si cambia algo aqui, se copia tal cual a los 3.

   VARIABLES DE ENTORNO (en Vercel, por proyecto):
     NOTIFY_MODE      'off' (default) | 'test' | 'live'
                        off  -> no sale NINGUN correo (seguro por default:
                                subir este codigo no manda nada hasta que
                                alguien lo prenda a proposito)
                        test -> todo correo se desvia a NOTIFY_TEST_TO,
                                con el destinatario real en el asunto. Para
                                probar en Preview, que usa el MISMO
                                SharePoint real que produccion.
                        live -> a los destinatarios reales
     NOTIFY_TEST_TO   a donde van los correos en modo test
     NOTIFY_FROM      buzon que manda (default orders@gsocd.com). OJO: tiene
                      que ser un buzon de verdad (usuario o compartido);
                      orders@gsocd.com es un GRUPO de distribucion y Graph lo
                      rechaza ("The requested user ... is invalid"). En Vercel
                      va noreply@gsocd.com (buzon compartido "GS Solutions").
     NOTIFY_REPLY_TO  a donde van las respuestas de los clientes (default
                      orders@gsocd.com: el grupo que ya reparte los correos)
     NOTIFY_OFFICE_TO a quien le llegan los avisos de oficina (default
                      orders@gsocd.com; se pueden poner varios con coma)

   REGLAS DE PREFERENCIAS (las que ya guardan Orders y Admin):
     - Confirmations: SIEMPRE sale si la orden necesita que el cliente
       confirme algo, sin importar ningun ajuste (el "candado" que
       save-order-notifications.js decia que viviria en Power Automate).
     - Changes / Updates: el ajuste de la ORDEN (Yes/No) gana; '' hereda
       el de la cuenta (Clients). En la cuenta, vacio = Si (para no
       silenciar clientes viejos sin querer, mismo criterio que
       update-client-profile.js). El maestro apaga todo menos
       Confirmations.
     - A quien: contacto elegido en la orden -> contacto del edificio
       (ClientAddresses.ContactId, emparejado por direccion porque la
       orden no guarda el id del edificio) -> contacto marcado como
       "recibe notificaciones" -> email principal de la cuenta
       (Clients.Contact) -> el email con que se hizo la orden. Un
       contacto de tipo Phone se salta (no hay SMS todavia).

   NUNCA truena: todo el modulo atrapa sus errores y regresa un
   resultado. Un correo que falla nunca debe tumbar el guardado real de
   una orden (mismo criterio que lib/push.js). Cada intento queda en la
   lista NotificationLog si existe (si no existe, se ignora).
============================================================ */

const LISTS = {
  CLIENTS: 'Clients',
  CONTACTS: 'ClientContacts',
  ADDRESSES: 'ClientAddresses',
  ORDERS: 'Orders',
  ORDER_SERVICES: 'OrderServices',
  LOG: 'NotificationLog'
};

const ORDERS_URL = 'https://orders.gsocd.com';
const ADMIN_URL = 'https://admin.gsocd.com';
const OFFICE_PHONE = '(515) 473-5990';
const TZ = 'America/Chicago';
/* sendMail acepta ~4 MB por peticion con adjuntos en linea; con el
   base64 (+33%) se deja el PDF en maximo 2.8 MB. Si pesa mas (muchas
   fotos), el correo sale sin adjunto y con el enlace al portal. */
const MAX_ATTACHMENT_BYTES = 2.8 * 1024 * 1024;

const CATEGORY_OF = {
  received: 'updates',
  scheduled: 'updates',
  completed: 'updates',
  changed: 'changes',
  'request-decision': 'changes',
  confirm: 'confirmations',
  'reactivation-confirm': 'confirmations'
};
const CATEGORY_LABEL = { updates: 'Updates', changes: 'Changes', confirmations: 'Confirmations' };

/* ===================== configuracion ===================== */

function config() {
  const mode = String(process.env.NOTIFY_MODE || 'off').trim().toLowerCase();
  return {
    mode: mode === 'live' || mode === 'test' ? mode : 'off',
    testTo: String(process.env.NOTIFY_TEST_TO || '').trim(),
    from: String(process.env.NOTIFY_FROM || 'orders@gsocd.com').trim(),
    replyTo: String(process.env.NOTIFY_REPLY_TO || 'orders@gsocd.com').trim(),
    officeTo: String(process.env.NOTIFY_OFFICE_TO || 'orders@gsocd.com')
      .split(',').map(s => s.trim()).filter(Boolean)
  };
}

/* ===================== reglas (puras, con pruebas) ===================== */

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

/* Cuenta: vacio/null = Si. */
function accountPref(v) {
  if (v === undefined || v === null || v === '') return true;
  return truthy(v);
}

/* Orden: 'Yes' / 'No' / '' (hereda). Regresa true/false/null. */
function orderPref(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === 'Yes' || v === true) return true;
  if (s === 'No' || v === false) return false;
  return null;
}

const SUB_COLUMN = { changes: 'Changes', updates: 'Updates', confirmations: 'Confirmations' };

function shouldSend(category, order, client) {
  if (category === 'confirmations') return true;
  const o = order || {};
  const c = client || {};
  const masterOrder = orderPref(o.OrderNotificationsEnabled);
  const master = masterOrder !== null ? masterOrder : accountPref(c.NotificationsEnabled);
  if (!master) return false;
  const col = SUB_COLUMN[category];
  if (!col) return false;
  const subOrder = orderPref(o['OrderNotify' + col]);
  return subOrder !== null ? subOrder : accountPref(c['Notify' + col]);
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

/* El edificio de la orden: misma direccion (sin importar mayusculas,
   espacios ni puntuacion) y, si los dos lo tienen, mismo # de edificio. */
function matchAddress(order, addresses) {
  const o = order || {};
  const street = norm(o.Address);
  if (!street) return null;
  const bldg = norm(o.BuildingNumber);
  const candidates = (addresses || []).filter(a => a && !truthy(a.Archived) && norm(a.Address) === street);
  if (!candidates.length) return null;
  if (bldg) {
    const exact = candidates.find(a => norm(a.BuildingNumber) === bldg);
    if (exact) return exact;
  }
  return candidates.find(a => !norm(a.BuildingNumber)) || candidates[0];
}

/* contacts: [{ id, Name, ContactType, Value, Archived, NotifyRecipient }] */
function pickRecipient(order, client, contacts, addresses) {
  const o = order || {};
  const c = client || {};
  const live = (contacts || []).filter(x => x && !truthy(x.Archived));
  const asEmail = (ct, source) => {
    if (!ct) return null;
    const type = String(ct.ContactType || 'Email');
    if (type !== 'Email' || !looksLikeEmail(ct.Value)) return null;
    return { email: String(ct.Value).trim(), name: ct.Name || '', source };
  };
  const byId = id => live.find(x => String(x.id) === String(id));

  if (o.OrderContactId) {
    const r = asEmail(byId(o.OrderContactId), 'order');
    if (r) return r;
  }
  const bldg = matchAddress(o, addresses);
  if (bldg && bldg.ContactId) {
    const r = asEmail(byId(bldg.ContactId), 'building');
    if (r) return r;
  }
  const r = asEmail(live.find(x => truthy(x.NotifyRecipient)), 'recipient');
  if (r) return r;
  if (looksLikeEmail(c.Contact)) return { email: String(c.Contact).trim(), name: c.ClientName || '', source: 'account' };
  if (looksLikeEmail(o.Email)) return { email: String(o.Email).trim(), name: o.Requester || '', source: 'order-email' };
  return null;
}

/* ===================== formato ===================== */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Fechas de dia (SharePoint las guarda a mediodia UTC): se lee solo el
   dia, sin que la zona horaria lo mueva. */
function fmtDay(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtDateTime(v) {
  const d = new Date(v || Date.now());
  if (isNaN(d.getTime())) return String(v || '');
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ });
}

function locationLines(o) {
  o = o || {};
  const top = [o.BusinessName || o.Title || '',
    o.BuildingNumber ? 'Bldg ' + o.BuildingNumber : '',
    o.UnitNumber ? 'Unit ' + o.UnitNumber : ''].filter(Boolean).join(' · ');
  const street = [o.Address, o.Suite].filter(Boolean).join(', ');
  const city = [o.City, o.Zip].filter(Boolean).join(' ');
  return [top, [street, city].filter(Boolean).join(', ')].filter(Boolean);
}

function serviceLine(s) {
  s = s || {};
  const name = s.ServiceName || s.service || '';
  const extra = [s.SubOption || s.subOption, s.Level || s.level].filter(Boolean).join(', ');
  const qty = s.Quantity || s.qty;
  const place = s.Category || s.category || '';
  return name + (extra ? ' (' + extra + ')' : '') + (qty ? ' ×' + qty : '') + (place ? ' — ' + place : '');
}

/* ===================== plantillas ===================== */

const C = { black: '#111111', gold: '#C9A84C', goldLt: '#E2C97E', goldDk: '#8C6F2A', off: '#F7F6F3', border: '#E0D9CC', gray: '#6B6B6B', warn: '#B4541F' };

function rowsTable(rows) {
  const body = rows.filter(r => r && r[1] !== undefined && r[1] !== null && r[1] !== '').map((r, i, arr) =>
    `<tr><td style="padding:6px 0;color:${C.gray};font-size:14px;vertical-align:top;${i < arr.length - 1 ? `border-bottom:1px solid #ECE6DA;` : ''}">${esc(r[0])}</td>` +
    `<td style="padding:6px 0 6px 12px;font-size:14px;font-weight:bold;text-align:right;vertical-align:top;${i < arr.length - 1 ? `border-bottom:1px solid #ECE6DA;` : ''}">${r[2] ? r[1] : esc(r[1])}</td></tr>`
  ).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.border};background:${C.off};border-radius:4px;margin:18px 0;"><tr><td style="padding:10px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table></td></tr></table>`;
}

/* old -> new, con lo viejo tachado encima */
function diffValue(oldV, newV) {
  const o = String(oldV == null ? '' : oldV);
  const n = String(newV == null ? '' : newV);
  const e = v => esc(v).replace(/\n/g, '<br>');
  if (!o || o === n) return e(n || '—');
  return `<span style="display:block;color:#8a8a8a;text-decoration:line-through;font-weight:normal;">${e(o)}</span>${e(n || '—')}`;
}

function listHtml(lines) {
  if (!lines || !lines.length) return '';
  return lines.map(esc).join('<br>');
}

function button(label, href, dark) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${dark ? C.black : C.gold};color:${dark ? C.goldLt : C.black};font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:3px;margin:6px 0 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;">${esc(label)}</a>`;
}

function p(html, muted) {
  return `<p style="margin:0 0 14px;${muted ? `font-size:13px;color:${C.gray};` : ''}">${html}</p>`;
}

function quote(text) {
  return `<div style="border-left:3px solid ${C.gold};padding:4px 0 4px 14px;margin:14px 0;font-style:italic;color:#333;">${esc(text).replace(/\n/g, '<br>')}</div>`;
}

function alertBox(text) {
  return `<div style="background:#FDF3E7;border-left:3px solid ${C.warn};padding:10px 14px;font-size:14px;margin:0 0 16px;">${esc(text)}</div>`;
}

function layout(tag, heading, inner, footer) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#EFEDE8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEDE8;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1d1d1b;">
<tr><td style="background:${C.black};padding:18px 24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  <td style="font-family:Georgia,serif;color:${C.gold};font-size:20px;font-weight:bold;">GS Solutions<div style="color:#ffffff;font-weight:normal;font-size:12px;letter-spacing:2px;margin-top:2px;">ORDERS</div></td>
  <td align="right" style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${C.goldLt};">${esc(tag)}</td>
  </tr></table>
</td></tr>
<tr><td style="padding:26px 24px 10px;">
  <h1 style="font-family:Georgia,serif;font-size:24px;line-height:1.25;margin:0 0 12px;color:${C.black};font-weight:bold;">${esc(heading)}</h1>
  ${inner}
</td></tr>
<tr><td style="border-top:1px solid ${C.border};padding:16px 24px 22px;font-size:12px;color:#8a8a8a;line-height:1.5;">GS Solutions Inc. · ${OFFICE_PHONE} · orders@gsocd.com<br>${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

function clientFooter(category) {
  if (category === 'confirmations') return 'We send this email even when notifications are off, because your order needs your answer.';
  if (category === 'self') return 'You requested this email from orders.gsocd.com.';
  return `You get these emails because <b>${esc(CATEGORY_LABEL[category] || category)}</b> notifications are on for this order. <a href="${ORDERS_URL}/customer.html?tab=profile" style="color:${C.goldDk};">Change notification settings</a>`;
}

const OFFICE_FOOTER = 'Internal message from the GS Solutions portals.';

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

/* Cada plantilla regresa { subject, html }. ctx siempre trae order
   (campos de SharePoint) y lo demas depende del evento. */
const CLIENT_TEMPLATES = {
  received(ctx) {
    const o = ctx.order;
    const hi = firstName(ctx.recipientName);
    /* Un PO de varias unidades manda UN solo correo con todas. */
    const ids = (ctx.orderIds && ctx.orderIds.length > 1) ? ctx.orderIds : null;
    return {
      subject: ids ? `We received your order for ${ids.length} units` : `We received your order ${o.OrderID}`,
      html: layout('Order received', hi ? `Thanks, ${hi}. We got your order.` : 'Thanks. We got your order.',
        p("Our office will review it and schedule a date and time. We'll email you as soon as it's scheduled.") +
        rowsTable([
          ids ? ['Orders', listHtml(ids), true] : ['Order', o.OrderID],
          ['Location', listHtml(locationLines(o)), true],
          ['Requested date', fmtDay(o.DueDate || o.EntryDate)],
          ['Services', listHtml((ctx.services || []).map(serviceLine)), true]
        ]) +
        button('View order', `${ORDERS_URL}/customer.html?tab=processing`) +
        p("Need to change something? You can edit or cancel it from the portal until it's scheduled.", true),
        clientFooter('updates'))
    };
  },

  scheduled(ctx) {
    const o = ctx.order;
    return {
      subject: `Scheduled: ${o.OrderID} on ${fmtDay(o.DispatchDate)}${o.ServiceWindow ? ', ' + o.ServiceWindow : ''}`,
      html: layout('Scheduled', 'Your service is scheduled.',
        rowsTable([
          ['Date', fmtDay(o.DispatchDate)],
          ['Arrival window', o.ServiceWindow],
          ['Location', listHtml(locationLines(o)), true],
          ['Order', o.OrderID]
        ]) +
        p('Please make sure the unit is unlocked or that access instructions are in the order.') +
        button('View order', `${ORDERS_URL}/customer.html?tab=processing`),
        clientFooter('updates'))
    };
  },

  confirm(ctx) {
    const o = ctx.order;
    const rows = (ctx.diff || []).map(d => [d.label, diffValue(d.old, d.next), true]);
    rows.push(['Order', o.OrderID]);
    return {
      subject: `Action needed: please confirm a change to ${o.OrderID}`,
      html: layout('Action needed', 'Please confirm this change.',
        alertBox('Your order is on hold until you confirm or decline.') +
        p(ctx.reason ? esc(ctx.reason) : 'Our office is proposing these changes to your order:') +
        rowsTable(rows) +
        button('Review and confirm', `${ORDERS_URL}/customer.html?tab=processing`, true) +
        p(`Questions? Reply to this email or call ${OFFICE_PHONE}.`, true),
        clientFooter('confirmations'))
    };
  },

  'reactivation-confirm'(ctx) {
    const o = ctx.order;
    return {
      subject: `Action needed: confirm reactivating ${o.OrderID}`,
      html: layout('Action needed', 'Do you want this order back?',
        p(`Our office wants to reactivate order ${esc(o.OrderID)}, which was cancelled.` + (ctx.reason ? ' ' + esc(ctx.reason) : '')) +
        rowsTable([['Order', o.OrderID], ['Location', listHtml(locationLines(o)), true]]) +
        button('Review and confirm', `${ORDERS_URL}/customer.html?tab=processing`, true) +
        p(`Questions? Reply to this email or call ${OFFICE_PHONE}.`, true),
        clientFooter('confirmations'))
    };
  },

  changed(ctx) {
    const o = ctx.order;
    const rows = (ctx.diff || []).map(d => [d.label, diffValue(d.old, d.next), true]);
    rows.push(['Order', o.OrderID]);
    const first = (ctx.diff || [])[0];
    return {
      subject: `Updated: ${o.OrderID}` + (first && first.label === 'Date' && first.next ? ` moved to ${first.next}` : ''),
      html: layout('Order updated', 'We updated your order.',
        rowsTable(rows) +
        (ctx.backToScheduling ? p("We'll email you the new date and arrival window as soon as it's scheduled.") : p("If this doesn't work for you, request a different date from the portal.")) +
        button('View order', `${ORDERS_URL}/customer.html?tab=processing`),
        clientFooter('changes'))
    };
  },

  'request-decision'(ctx) {
    const o = ctx.order;
    const kindLabel = { cancel: 'cancellation', change: 'change request' }[ctx.kind] || 'request';
    const approved = !!ctx.approved;
    let heading, intro;
    if (ctx.kind === 'cancel' && approved && ctx.byOffice) {
      heading = 'Your order was cancelled.';
      intro = `Our office cancelled order ${esc(o.OrderID)}. No crew will be sent. Questions? Call ${OFFICE_PHONE}.`;
    } else if (ctx.kind === 'cancel' && approved) {
      heading = 'Your cancellation was approved.';
      intro = `Order ${esc(o.OrderID)} is now cancelled. No crew will be sent.`;
    } else if (ctx.kind === 'cancel') {
      heading = 'Your cancellation was not approved.';
      intro = `Order ${esc(o.OrderID)} stays active.`;
    } else if (approved) {
      heading = 'Your change request was approved.';
      intro = ctx.backToScheduling
        ? "We applied your changes. We'll email you the new date and arrival window as soon as it's scheduled."
        : 'We applied your changes. Your date and arrival window stay the same.';
    } else {
      heading = 'Your change request was not approved.';
      intro = 'Your order stays as it was.';
    }
    const rows = [['Request', kindLabel.charAt(0).toUpperCase() + kindLabel.slice(1)], ['Decision', approved ? 'Approved' : 'Not approved']];
    (ctx.diff || []).forEach(d => rows.push([d.label, diffValue(d.old, d.next), true]));
    rows.push(['Location', listHtml(locationLines(o)), true]);
    return {
      subject: ctx.kind === 'cancel' && approved && ctx.byOffice ? `Cancelled: ${o.OrderID}`
        : `${ctx.kind === 'cancel' ? 'Cancellation' : 'Change request'} ${approved ? 'approved' : 'not approved'}: ${o.OrderID}`,
      html: layout(approved ? 'Request approved' : 'Request declined', heading,
        p(intro) + (ctx.notes && (!approved || ctx.byOffice) ? quote(ctx.notes) : '') + rowsTable(ctx.byOffice ? rows.slice(2) : rows) +
        button('View order', `${ORDERS_URL}/customer.html?tab=processing`),
        clientFooter('changes'))
    };
  },

  completed(ctx) {
    const o = ctx.order;
    const where = locationLines(o).join(', ');
    return {
      subject: `Completed: ${o.OrderID}`,
      html: layout('Completed', 'Your service is complete.',
        p(`Our team finished the work${where ? ' at ' + esc(where) : ''}.`) +
        rowsTable([['Order', o.OrderID], ['Completed', fmtDateTime(ctx.completedAt)]]) +
        (ctx.attachmentName
          ? p(`The completion report is attached (${esc(ctx.attachmentName)}).`)
          : p('You can see the completion report and photos in the portal.')) +
        button('See photos', `${ORDERS_URL}/customer.html?tab=gallery`) +
        p("Something not right? Reply to this email and we'll take care of it.", true),
        clientFooter('updates'))
    };
  }
};

const OFFICE_TEMPLATES = {
  'tech-done'(ctx) {
    const o = ctx.order;
    return {
      subject: `Review needed: ${o.OrderID} marked done by ${ctx.tech || 'tech'}`,
      html: layout('Needs review', ctx.service ? 'Tech finished a service.' : 'Tech marked this order done.',
        rowsTable([
          ['Order', o.OrderID],
          ['Client', `${o.BusinessName || o.Title || ''}${o.ClientID ? ' (' + o.ClientID + ')' : ''}`],
          ['Location', listHtml(locationLines(o).slice(1)), true],
          ['Service', ctx.service],
          ['Tech', ctx.tech],
          ['Marked done', fmtDateTime(ctx.at)],
          ['Photos', ctx.photoCount ? ctx.photoCount + ' uploaded' : '']
        ]) +
        button('Open in Admin', `${ADMIN_URL}/admin.html?tab=active`, true) +
        p('The client is notified only after you mark it Completed.', true),
        OFFICE_FOOTER)
    };
  },

  'client-request'(ctx) {
    const o = ctx.order || {};
    const who = o.BusinessName || o.Title || o.ClientID || 'A client';
    const what = {
      new: 'sent a new order',
      edit: 'changed an order',
      change: 'asked to change an order',
      cancel: 'asked to cancel an order',
      reschedule: 'asked for new dates',
      confirmed: 'confirmed the change you sent',
      'reactivation-confirmed': 'confirmed reactivating an order',
      'login-locked': 'had portal sign-in locked after too many wrong tries'
    }[ctx.kind] || 'sent a request';
    const tab = ctx.kind === 'new' ? 'approvals' : ctx.kind === 'login-locked' ? 'clients'
      : ctx.kind === 'confirmed' || ctx.kind === 'reactivation-confirmed' ? 'active' : 'review';
    const label = { new: 'New order', edit: 'Order edited', change: 'Change', cancel: 'Cancellation', reschedule: 'New dates', confirmed: 'Change confirmed', 'reactivation-confirmed': 'Reactivation confirmed', 'login-locked': 'Sign-in locked' }[ctx.kind] || 'Request';
    const rows = [['Order', o.OrderID], ['Request', label]];
    (ctx.details || []).forEach(d => rows.push([d[0], d[1]]));
    if (o.DispatchDate) rows.push(['Scheduled for', fmtDay(o.DispatchDate) + (o.ServiceWindow ? ' · ' + o.ServiceWindow : '')]);
    rows.push(['Sent', fmtDateTime(ctx.at)]);
    return {
      subject: `Client request: ${label.toLowerCase()} — ${o.OrderID || who}`,
      html: layout('Client request', `${who} ${what}.`,
        rowsTable(rows) + (ctx.notes ? quote(ctx.notes) : '') +
        (ctx.kind === 'login-locked' ? p('If this was the client, they can try again in an hour or you can confirm their ZIP/phone on file. If it was not them, someone is guessing Client IDs.', true) : '') +
        button(tab === 'approvals' ? 'Open in Approvals' : tab === 'review' ? 'Open in Review' : tab === 'clients' ? 'Open Clients' : 'Open in Admin', `${ADMIN_URL}/admin.html?tab=${tab}`, true),
        OFFICE_FOOTER)
    };
  },

  'contact-form'(ctx) {
    return {
      subject: `Contact form: ${ctx.name || 'Portal visitor'}${ctx.clientId ? ' (' + ctx.clientId + ')' : ''}`,
      html: layout('Contact form', 'New message from the portal.',
        rowsTable([['Name', ctx.name], ['Email', ctx.email], ['Client ID', ctx.clientId]]) +
        quote(ctx.message || '') +
        (looksLikeEmail(ctx.email) ? p(`Reply to this email to answer ${esc(firstName(ctx.name) || 'them')} directly.`, true) : ''),
        OFFICE_FOOTER)
    };
  }
};

function clientIdTemplate(ctx) {
  return {
    subject: 'Your GS Solutions Client ID',
    html: layout('Client ID', "Here's your Client ID.",
      rowsTable([['Client ID', `<span style="font-size:20px;letter-spacing:1px;">${esc(ctx.clientId)}</span>`, true], ['Account', ctx.businessName]]) +
      button('Go to orders.gsocd.com', ORDERS_URL) +
      p("Didn't ask for this? You can ignore this email.", true),
      clientFooter('self'))
  };
}

/* ===================== Graph ===================== */

async function fetchByField(g, listName, field, value) {
  const filter = encodeURIComponent(`fields/${field} eq '${String(value).replace(/'/g, "''")}'`);
  let url = g.siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const out = [];
  while (url) {
    const data = await g.graphFetch(url, { headers: { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out.filter(it => it.fields).map(it => Object.assign({ id: it.id }, it.fields));
}

async function sendMail(g, cfg, msg) {
  let to = msg.to;
  let subject = msg.subject;
  if (cfg.mode === 'test') {
    if (!cfg.testTo) throw new Error('NOTIFY_MODE=test but NOTIFY_TEST_TO is empty');
    subject = `[TEST → ${to.join(', ')}] ${subject}`;
    to = [cfg.testTo];
  }
  const message = {
    subject,
    body: { contentType: 'HTML', content: msg.html },
    toRecipients: to.map(a => ({ emailAddress: { address: a } }))
  };
  if (msg.replyTo && looksLikeEmail(msg.replyTo)) message.replyTo = [{ emailAddress: { address: msg.replyTo } }];
  if (msg.attachment && msg.attachment.buffer) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: msg.attachment.name,
      contentType: msg.attachment.contentType || 'application/pdf',
      contentBytes: Buffer.from(msg.attachment.buffer).toString('base64')
    }];
  }
  await g.graphFetch('/users/' + encodeURIComponent(cfg.from) + '/sendMail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: true })
  });
}

/* Bitacora opcional: si la lista NotificationLog no existe (o le falta
   una columna), se ignora sin tumbar nada. */
async function logAttempt(g, entry) {
  try {
    await g.createListItem(LISTS.LOG, {
      Title: (entry.event || '') + ' ' + (entry.orderId || ''),
      OrderID: entry.orderId || '',
      Event: entry.event || '',
      Recipient: entry.recipient || '',
      Subject: String(entry.subject || '').slice(0, 250),
      Result: entry.result || '',
      Detail: String(entry.detail || '').slice(0, 1000),
      Mode: entry.mode || ''
    });
  } catch (e) { /* lista opcional */ }
}

/* ===================== puntos de entrada ===================== */

/* Correo al cliente de una orden.
   opts: { event, orderId, order?, services?, diff?, reason?, notes?,
           kind?, approved?, backToScheduling?, completedAt?,
           attachment?: { name, buffer } }
   order puede venir ya armado (fields de SharePoint, con cambios
   recien aplicados encima); si no, se lee de Orders. */
async function notifyClient(g, opts) {
  const cfg = config();
  const event = opts && opts.event;
  const orderId = (opts && (opts.orderId || (opts.order && opts.order.OrderID))) || '';
  const result = { event, orderId, sent: false };
  if (cfg.mode === 'off') return Object.assign(result, { skipped: 'NOTIFY_MODE is off' });
  const tpl = CLIENT_TEMPLATES[event];
  const category = CATEGORY_OF[event];
  if (!tpl || !category) return Object.assign(result, { skipped: 'unknown event' });
  let recipient = null;
  let subject = '';
  try {
    let order = opts.order;
    if (!order || !order.ClientID) {
      const rows = await fetchByField(g, LISTS.ORDERS, 'OrderID', orderId);
      order = Object.assign({}, rows[0] || {}, opts.order || {});
    }
    order = Object.assign({ OrderID: orderId }, order);
    if (!order.ClientID) throw new Error('order has no ClientID');

    const [clients, contacts, addresses] = await Promise.all([
      fetchByField(g, LISTS.CLIENTS, 'ClientID', order.ClientID),
      fetchByField(g, LISTS.CONTACTS, 'ClientID', order.ClientID).catch(() => []),
      fetchByField(g, LISTS.ADDRESSES, 'ClientID', order.ClientID).catch(() => [])
    ]);
    const client = clients[0] || {};

    if (!shouldSend(category, order, client)) {
      Object.assign(result, { skipped: CATEGORY_LABEL[category] + ' notifications are off' });
      await logAttempt(g, { event, orderId, result: 'Skipped', detail: result.skipped, mode: cfg.mode });
      return result;
    }
    recipient = pickRecipient(order, client, contacts, addresses);
    if (!recipient) {
      Object.assign(result, { skipped: 'no email on file' });
      await logAttempt(g, { event, orderId, result: 'Skipped', detail: result.skipped, mode: cfg.mode });
      return result;
    }

    let services = opts.services;
    if (!services && event === 'received') {
      services = await fetchByField(g, LISTS.ORDER_SERVICES, 'OrderID', orderId).catch(() => []);
    }
    let attachment = opts.attachment && opts.attachment.buffer ? opts.attachment : null;
    if (attachment && Buffer.byteLength(attachment.buffer) > MAX_ATTACHMENT_BYTES) attachment = null;

    const rendered = tpl(Object.assign({}, opts, {
      order, services, recipientName: recipient.name,
      attachmentName: attachment ? attachment.name : ''
    }));
    subject = rendered.subject;
    await sendMail(g, cfg, { to: [recipient.email], subject, html: rendered.html, attachment, replyTo: cfg.replyTo });
    Object.assign(result, { sent: true, to: recipient.email, source: recipient.source });
    await logAttempt(g, { event, orderId, recipient: recipient.email, subject, result: 'Sent', detail: 'recipient: ' + recipient.source, mode: cfg.mode });
  } catch (e) {
    Object.assign(result, { error: e && e.message ? e.message : String(e) });
    console.error('notifyClient ' + event + ' ' + orderId + ':', result.error);
    await logAttempt(g, { event, orderId, recipient: recipient && recipient.email, subject, result: 'Failed', detail: result.error, mode: cfg.mode });
  }
  return result;
}

/* Aviso a la oficina. opts: { event, order?, orderId?, ...campos de la
   plantilla, replyTo? } */
async function notifyOffice(g, opts) {
  const cfg = config();
  const event = opts && opts.event;
  const orderId = (opts && (opts.orderId || (opts.order && opts.order.OrderID))) || '';
  const result = { event, orderId, sent: false };
  if (cfg.mode === 'off') return Object.assign(result, { skipped: 'NOTIFY_MODE is off' });
  const tpl = OFFICE_TEMPLATES[event];
  if (!tpl) return Object.assign(result, { skipped: 'unknown event' });
  if (!cfg.officeTo.length) return Object.assign(result, { skipped: 'NOTIFY_OFFICE_TO is empty' });
  let subject = '';
  try {
    let order = opts.order;
    if (orderId && (!order || !order.ClientID)) {
      const rows = await fetchByField(g, LISTS.ORDERS, 'OrderID', orderId);
      order = Object.assign({}, rows[0] || {}, opts.order || {});
    }
    const rendered = tpl(Object.assign({}, opts, { order: Object.assign({ OrderID: orderId }, order || {}), at: opts.at || new Date().toISOString() }));
    subject = rendered.subject;
    const replyTo = opts.replyTo || (event === 'contact-form' ? opts.email : '');
    await sendMail(g, cfg, { to: cfg.officeTo, subject, html: rendered.html, replyTo });
    Object.assign(result, { sent: true, to: cfg.officeTo.join(', ') });
    await logAttempt(g, { event, orderId, recipient: cfg.officeTo.join(', '), subject, result: 'Sent', mode: cfg.mode });
  } catch (e) {
    Object.assign(result, { error: e && e.message ? e.message : String(e) });
    console.error('notifyOffice ' + event + ' ' + orderId + ':', result.error);
    await logAttempt(g, { event, orderId, recipient: cfg.officeTo.join(', '), subject, result: 'Failed', detail: result.error, mode: cfg.mode });
  }
  return result;
}

/* Recuperar Client ID: sale siempre (lo pidio el mismo cliente) al
   email con que lo pidio, que ya se verifico contra Clients.Contact. */
async function sendClientIdEmail(g, opts) {
  const cfg = config();
  const result = { event: 'client-id', sent: false };
  if (cfg.mode === 'off') return Object.assign(result, { skipped: 'NOTIFY_MODE is off' });
  const to = String((opts && opts.to) || '').trim();
  if (!looksLikeEmail(to)) return Object.assign(result, { skipped: 'bad email' });
  let subject = '';
  try {
    const rendered = clientIdTemplate(opts);
    subject = rendered.subject;
    await sendMail(g, cfg, { to: [to], subject, html: rendered.html, replyTo: cfg.replyTo });
    Object.assign(result, { sent: true, to });
    await logAttempt(g, { event: 'client-id', recipient: to, subject, result: 'Sent', detail: opts.clientId, mode: cfg.mode });
  } catch (e) {
    Object.assign(result, { error: e && e.message ? e.message : String(e) });
    console.error('sendClientIdEmail:', result.error);
    await logAttempt(g, { event: 'client-id', recipient: to, subject, result: 'Failed', detail: result.error, mode: cfg.mode });
  }
  return result;
}

/* Una linea en los logs de Vercel por CADA intento (mandado, saltado o
   fallido), con el porque. Antes solo quedaba rastro cuando fallaba: un
   correo aceptado por Microsoft o saltado por preferencias no dejaba
   nada y no habia como saber que paso (25/09/2026). */
function logged(name, fn) {
  return async (g, opts) => {
    const r = await fn(g, opts);
    const cfg = config();
    try {
      console.log('[notify] ' + name + ' ' + JSON.stringify({
        event: r.event, orderId: r.orderId || '', sent: r.sent, to: r.to || '',
        skipped: r.skipped || '', error: r.error || '', mode: cfg.mode, from: cfg.from
      }));
    } catch (e) { /* nunca truena por el log */ }
    return r;
  };
}

module.exports = {
  notifyClient: logged('client', notifyClient),
  notifyOffice: logged('office', notifyOffice),
  sendClientIdEmail: logged('client-id', sendClientIdEmail),
  /* expuestas para pruebas y para que cada backend arme su diff */
  shouldSend,
  pickRecipient,
  matchAddress,
  fmtDay,
  serviceLine,
  CLIENT_TEMPLATES,
  OFFICE_TEMPLATES,
  clientIdTemplate
};
