/* ============================================================
   lib/recurring-orders.js -- motor que mantiene un minimo de 30 dias
   de ordenes recurrentes futuras por contrato, generandolas conforme
   se van necesitando.

   REGLAS (decididas con el dueno, 19/09/2026):
   - Cada visita de un contrato recurrente ES una orden real, en la
     MISMA lista de siempre (ORDERS_LIST) -- no un sistema aparte.
   - El OrderID se ve distinto para notarse a simple vista:
     "<ClientID>-REC<N>", con su PROPIO contador global (nunca se
     mezcla con el de las ordenes normales).
   - Division siempre 'Janitorial' -- no hay opcion, se guarda asi.
   - Nacen YA asignadas (Supervisor/fecha/ventana vienen del
     contrato) -- por eso Creacion y Asignacion son UN SOLO evento de
     historial, no dos (a diferencia de una orden normal, que se crea
     y se asigna despues en Scheduling).
   - Status inicial: 'Recurring Scheduled' (PENDIENTE DE CONFIRMAR
     el nombre exacto con el dueno) -- visible para el cliente de
     inmediato, pero NO debe aparecer en Approvals todavia. Falta la
     pieza que la "asciende" a Approvals el dia que le toca (Fase 2,
     separada de este motor).
   - Requiere un campo NUEVO en ORDERS_LIST: RecurringServiceID (liga
     la orden a su contrato de origen, para saber que fechas ya
     tienen orden creada sin ambiguedad si un cliente tiene mas de un
     contrato). Si esa columna no existe todavia en SharePoint, hay
     que crearla ahi antes de que esto funcione en produccion.

   NO INCLUYE (fuera de este motor, fases separadas):
   - Promover una orden a Approvals cuando llega su dia.
   - La pantalla simplificada de Approvals (confirmar/reasignar).
   - El tab de Recurring del cliente mostrando estas ordenes.
============================================================ */

const {
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST,
  RECURRING_SERVICES_LIST, RECURRING_ASSIGNMENTS_LIST, FIELD_EMPLOYEES_LIST,
  CLIENTS_LIST, siteListPath, graphFetch, createListItem, updateListItemByItemId
} = require('./graph');

/* BUG REAL evitado antes de escribirse: queryList() (lib/graph.js) NO
   pagina -- una sola llamada a Graph, sin seguir @odata.nextLink. Para
   listas que pueden tener cientos de renglones (Orders, RecurringLog)
   eso recortaria resultados en silencio. fetchAll() SI pagina -- mismo
   patron exacto que developer-admin.js ya usa (ahi vive como funcion
   local, no exportada de lib/graph.js, por eso se repite aqui en vez
   de importarla). */
async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200';
  const out = [];
  try {
    while (url) {
      const data = await graphFetch(url);
      out.push(...(data.value || []));
      url = data['@odata.nextLink'] || null;
    }
  } catch (e) {
    return [];
  }
  return out;
}

const RECURRING_INITIAL_STATUS = 'Recurring Scheduled'; // <-- pendiente de confirmar el nombre con el dueno
const WINDOW_DAYS = 30;

/* ===== Fechas (ya probadas aparte con casos reales, 19/09/2026) ===== */

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseISO(d) {
  const [y, m, day] = String(d).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}
function toISO(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const out = new Date(d); out.setUTCDate(out.getUTCDate() + n); return out; }
function startOfWeekUTC(d) { const out = new Date(d); out.setUTCDate(out.getUTCDate() - out.getUTCDay()); return out; }
function weeksBetween(a, b) {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  return Math.round((startOfWeekUTC(b) - startOfWeekUTC(a)) / msPerWeek);
}
function clampDayOfMonth(year, month0, day) {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

/* Fechas de visita de un contrato entre fromISO y toISO (inclusive).
   Weekly: cae en daysOfWeek todas las semanas, sin ancla.
   Biweekly: cae en daysOfWeek, cada 2 semanas contando desde la
     semana del AnchorDate (ambos dias de esa semana caen juntos).
   Monthly: una vez al mes, mismo dia-del-mes que AnchorDate (con
     clamp si ese dia no existe en un mes corto). */
function computeRecurringDates(contract, fromISO, toISO_) {
  const days = String(contract.daysOfWeek || '').split(',').map(s => s.trim()).filter(Boolean);
  const dayNums = days.map(d => DAY_ABBR.indexOf(d)).filter(n => n >= 0);
  const from = parseISO(fromISO);
  const to = parseISO(toISO_);
  const freq = contract.frequency || 'Weekly';
  const out = [];

  if (freq === 'Weekly') {
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
      if (dayNums.includes(d.getUTCDay())) out.push(toISO(d));
    }
    return out;
  }

  if (freq === 'Biweekly') {
    if (!contract.anchorDate) return [];
    const anchor = parseISO(contract.anchorDate);
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
      if (!dayNums.includes(d.getUTCDay())) continue;
      if (weeksBetween(anchor, d) % 2 === 0) out.push(toISO(d));
    }
    return out;
  }

  if (freq === 'Monthly') {
    if (!contract.anchorDate) return [];
    const anchor = parseISO(contract.anchorDate);
    const anchorDay = anchor.getUTCDate();
    let y = from.getUTCFullYear(), m = from.getUTCMonth();
    const endY = to.getUTCFullYear(), endM = to.getUTCMonth();
    while (y < endY || (y === endY && m <= endM)) {
      const day = clampDayOfMonth(y, m, anchorDay);
      const candidate = new Date(Date.UTC(y, m, day));
      if (candidate >= anchor && candidate >= from && candidate <= to) out.push(toISO(candidate));
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return out;
  }

  return [];
}

/* Siguiente numero para el REC-ID -- GLOBAL, contador propio, nunca
   se mezcla con el de las ordenes normales. */
function nextRecId(existingOrderIds) {
  const re = /-REC(\d+)$/i;
  let max = 0;
  (existingOrderIds || []).forEach(id => {
    const m = re.exec(String(id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return max + 1;
}

function missingDatesFor(contract, existingDatesForThisContract, todayISO_, windowDays) {
  const today = parseISO(todayISO_);
  const until = toISO(addDays(today, windowDays || WINDOW_DAYS));
  const wanted = computeRecurringDates(contract, todayISO_, until);
  const have = new Set(existingDatesForThisContract || []);
  return wanted.filter(d => !have.has(d));
}

/* ===== Motor real: lee SharePoint, decide que falta, escribe ===== */

/* Convierte "8:00 AM" / "08:00" a algo presentable como ServiceWindow.
   El campo Time del contrato ya viene en el formato que se captura en
   Developer -- se guarda tal cual, sin reinterpretar. */
function toServiceWindow(time) { return String(time || '').trim(); }

async function ensureRecurringOrders(todayISO_) {
  const today = todayISO_ || toISO(new Date());
  const report = { created: [], skipped: [], errors: [] };

  const [services, assignments, employees, clients, allOrders] = await Promise.all([
    fetchAll(RECURRING_SERVICES_LIST),
    fetchAll(RECURRING_ASSIGNMENTS_LIST),
    fetchAll(FIELD_EMPLOYEES_LIST),
    fetchAll(CLIENTS_LIST),
    fetchAll(ORDERS_LIST)
  ]);

  const activeContracts = services.filter(it => it.fields && (it.fields.Active === true || it.fields.Active === 'true'));

  const nameByPayroll = {};
  employees.forEach(it => {
    if (!it.fields || !it.fields.PayrollNumber) return;
    nameByPayroll[String(it.fields.PayrollNumber).trim()] =
      (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).trim();
  });

  const clientById = {};
  clients.forEach(it => { if (it.fields && it.fields.ClientID) clientById[it.fields.ClientID] = it.fields; });

  const allOrderIds = allOrders.filter(it => it.fields).map(it => it.fields.OrderID || it.fields.Title || '');
  let recCounter = nextRecId(allOrderIds);

  // Fechas que YA tienen orden, agrupadas por RecurringServiceID.
  // Depende del campo RecurringServiceID en ORDERS_LIST -- si esa
  // columna no existe todavia, esto no puede distinguir contratos
  // con ambiguedad y habria que crearla primero en SharePoint.
  const existingDatesByContract = {};
  allOrders.forEach(it => {
    const f = it.fields;
    if (!f || !f.RecurringServiceID) return;
    const rid = String(f.RecurringServiceID);
    if (!existingDatesByContract[rid]) existingDatesByContract[rid] = [];
    if (f.DispatchDate) existingDatesByContract[rid].push(String(f.DispatchDate).slice(0, 10));
  });

  for (const contractItem of activeContracts) {
    const contractId = contractItem.id;
    const f = contractItem.fields;
    const contract = {
      frequency: f.Frequency || 'Weekly',
      daysOfWeek: f.DaysOfWeek || '',
      anchorDate: f.AnchorDate || ''
    };

    const myAssignment = assignments.find(a => a.fields && String(a.fields.RecurringServiceID) === String(contractId));
    const supervisorName = myAssignment ? (nameByPayroll[String(myAssignment.fields.PayrollNumber).trim()] || '') : '';

    const client = clientById[f.ClientID] || {};
    const businessName = client.Title || client.BusinessName || f.ClientID || '';

    let servicesPayload = [];
    try {
      const parsed = JSON.parse(f.ServicesJSON || '[]');
      servicesPayload = (Array.isArray(parsed) ? parsed : []).map(s => ({
        Category: 'Janitorial',
        ServiceName: s.serviceName || s.sku || '',
        SubOption: s.sku || ''
      }));
    } catch (e) { servicesPayload = []; }

    const missing = missingDatesFor(contract, existingDatesByContract[String(contractId)] || [], today, WINDOW_DAYS);

    for (const dispatchDate of missing) {
      try {
        const orderId = String(f.ClientID).trim() + '-REC' + recCounter;
        recCounter++;

        await createListItem(ORDERS_LIST, {
          Title: orderId,
          OrderID: orderId,
          ClientID: f.ClientID,
          BusinessName: businessName,
          Division: 'Janitorial',
          Status: RECURRING_INITIAL_STATUS,
          RecurringServiceID: String(contractId),
          BuildingNumber: f.BuildingNumber || '',
          Supervisor: supervisorName,
          DispatchDate: dispatchDate,
          ServiceWindow: toServiceWindow(f.Time)
        });

        await Promise.all([
          ...servicesPayload.map(s => createListItem(ORDER_SERVICES_LIST, {
            Title: s.ServiceName || '',
            OrderID: orderId,
            Category: s.Category || 'Janitorial',
            ServiceName: s.ServiceName || '',
            SubOption: s.SubOption || '',
            Division: 'Janitorial'
          })),
          createListItem(ORDER_HISTORY_LIST, {
            Title: orderId,
            OrderID: orderId,
            ChangeType: 'Created',
            ChangedBy: 'Office',
            ChangeDate: new Date().toISOString(),
            FieldChanged: 'Office Order',
            NewValue: 'SERVICES:' + JSON.stringify({ services: servicesPayload, serviceWindow: toServiceWindow(f.Time) })
          })
        ]);

        report.created.push({ orderId, dispatchDate, contractId });
      } catch (e) {
        report.errors.push({ contractId, dispatchDate, error: e.message });
      }
    }

    if (!missing.length) report.skipped.push({ contractId, reason: 'already has ' + WINDOW_DAYS + ' days covered' });
  }

  return report;
}

/* ===== Ascenso: 'Recurring Scheduled' -> 'Assigned' cuando llega el
   dia de la visita (DispatchDate <= hoy).

   REVISADO (19/09/2026, aclarado con el dueno): una visita recurrente
   SIN cambios pasa DIRECTO a Active -- nunca por Approvals, no hace
   falta que nadie la confirme. Approvals/Review solo entran en juego
   si alguien (cliente u oficina) le CAMBIA los servicios ANTES de que
   llegue su dia -- eso ya dispara el mecanismo real de 'Change
   Requested' que existe para cualquier orden, sin necesidad de nada
   especial aqui. Por eso esta funcion asciende directo a 'Assigned',
   no a 'Received' (que si pasaria por Approvals). */
async function promoteDueRecurringOrders(todayISO_) {
  const today = todayISO_ || toISO(new Date());
  const allOrders = await fetchAll(ORDERS_LIST);
  const due = allOrders.filter(it => {
    const f = it.fields;
    return f && f.Status === RECURRING_INITIAL_STATUS
      && f.DispatchDate && String(f.DispatchDate).slice(0, 10) <= today;
  });

  const report = { promoted: [], errors: [] };
  for (const it of due) {
    const orderId = it.fields.OrderID || it.fields.Title || '';
    try {
      await updateListItemByItemId(ORDERS_LIST, it.id, { Status: 'Assigned' });
      report.promoted.push({ orderId, dispatchDate: it.fields.DispatchDate });
    } catch (e) {
      report.errors.push({ orderId, error: e.message });
    }
  }
  return report;
}

module.exports = {
  ensureRecurringOrders,
  promoteDueRecurringOrders,
  computeRecurringDates,
  nextRecId,
  missingDatesFor,
  RECURRING_INITIAL_STATUS
};
