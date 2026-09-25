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
  CLIENTS_LIST, TECHS_LIST, SERVICE_ASSIGNMENTS_LIST,
  siteListPath, graphFetch, createListItem, updateListItemByItemId,
  deleteListItem
} = require('./graph');
/* Paquetes -> sus servicios (25/09/2026): un contrato puede traer un
   paquete; cada visita guarda sus servicios, no el paquete. */
const { expandPackages, recordPackageSnapshots } = require('./package-contents');

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

/* ===== "Who does what" por lugar (23/09/2026, aprobado con mini
   interactivo con el dueno) =====
   Un contrato puede guardar su alcance POR LUGAR: cada renglon de
   ServicesJSON trae, ademas de sku/serviceName/level de siempre:
     zone: 'F1'..'Fn' (piso) | 'BLD' (elevadores y escaleras) | 'EXT'
     area: 'Hallway', 'Restroom', ...   qty: cuantos (ej. 2 banos)
     days: ['Mon','Thu',...]            payrollNumber: quien lo hace
   SIN columnas nuevas en SharePoint, a proposito:
   - El contrato sigue en ServicesJSON (texto libre de siempre).
     DaysOfWeek se sigue llenando (union de los dias de todos los
     renglones), asi que computeRecurringDates/Calendar no cambian.
   - En la orden, el LUGAR viaja en OrderServices.Category y en
     ServiceAssignments.Category (ej. "Floor 1 / Hallway"). Para una
     orden recurrente de siempre Category solo decia 'Janitorial' (la
     division, repetida en cada renglon), asi que aqui es donde de
     verdad sirve: la llave Category+ServiceName que ya usa TODO
     Assign by service (Admin, Tech, submit-service-complete,
     complete-service-assignment) queda unica por lugar sin tocar
     ninguna de esas piezas -- "Aspirar" en piso 1 y en piso 2 ya no
     chocan.
   - Estas ordenes nacen con AssignByService=true y sus
     ServiceAssignments ya repartidos (AssignedTo = NOMBRES, igual
     que el resto del sistema -- ver get-my-orders.js en Tech), asi
     que cada tecnico ve SOLO lo suyo, filtrado del lado del
     servidor, con el mecanismo que ya existia.
   Contratos viejos (lista plana, sin zone/area) no cambian en nada. */
const DOW_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function parseServicesJSON(json) {
  try { const p = JSON.parse(json || '[]'); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}
function isPlaceEntry(s) { return !!(s && typeof s === 'object' && s.zone && s.area); }
function isPlaceContract(list) { return (list || []).some(isPlaceEntry); }
function zoneLabel(z) {
  const v = String(z || '');
  if (v === 'BLD') return 'Elevators & stairs';
  if (v === 'EXT') return 'Exterior';
  if (/^F\d+$/.test(v)) return 'Floor ' + v.slice(1);
  return v;
}
/* Contexto del contrato para armar el texto del lugar (23/09/2026,
   edificios): cuantos edificios distintos hay, y cuantos pisos tiene
   cada uno (el campo floors que guarda Admin, o el piso mas alto usado
   si el renglon es de antes de los edificios). */
function placeContext(list) {
  const places = (list || []).filter(isPlaceEntry);
  const blds = new Set(places.map(s => String(s.bld || 'main')));
  const floorsBy = {};
  places.forEach(s => {
    const bid = String(s.bld || 'main');
    const fl = /^F\d+$/.test(String(s.zone)) ? +String(s.zone).slice(1) : 1;
    floorsBy[bid] = Math.max(floorsBy[bid] || 1, Number(s.floors) || 1, fl, s.zone === 'BLD' ? 2 : 1);
  });
  return { multi: blds.size > 1, floorsBy };
}
/* El lugar se lee SOLO con los niveles que aplican: edificio si el
   contrato tiene varios; piso si ese edificio tiene varios (o si es
   Elevators & stairs / Exterior). Un negocio de un solo nivel queda en
   "Restroom" a secas. Mismas reglas que rsPlaceLabel() en admin.html y
   placeLabel() en ordersgsocd.com/get-my-recurring.js. */
function placeLabel(s, ctx) {
  const c = ctx || placeContext([s]);
  const bid = String(s.bld || 'main');
  const out = [];
  if (c.multi) out.push(String(s.bldLabel || 'Building').trim());
  if ((c.floorsBy[bid] || 1) > 1 || s.zone === 'EXT' || s.zone === 'BLD') out.push(zoneLabel(s.zone));
  const q = Number(s.qty) || 1;
  out.push(String(s.area || '').trim() + (q > 1 ? ' \u00d7' + q : ''));
  return out.join(' / ');
}
/* Que se hace ESE dia: renglones cuyo days incluye el dia de la
   semana de dispatchDate. Un mismo lugar+servicio con 2 personas =
   UN renglon de servicio y UNA asignacion con los 2 nombres. */
function placeDayPlan(list, dispatchDate, time, nameByPayroll) {
  const dow = DOW_KEYS[new Date(String(dispatchDate).slice(0, 10) + 'T12:00:00Z').getUTCDay()];
  const byKey = {};
  const order = [];
  const ctx = placeContext(list);
  (list || []).filter(isPlaceEntry).forEach(s => {
    const days = Array.isArray(s.days) ? s.days : [];
    if (!days.includes(dow)) return;
    const place = placeLabel(s, ctx);
    const name = String(s.serviceName || s.sku || '').trim();
    if (!name) return;
    const key = place + '|' + name;
    if (!byKey[key]) { byKey[key] = { place, name, sku: s.sku || '', level: s.level || '', people: [] }; order.push(key); }
    const who = nameByPayroll[String(s.payrollNumber || '').trim()] || '';
    if (who && !byKey[key].people.includes(who)) byKey[key].people.push(who);
  });
  const scheduledDate = String(dispatchDate).slice(0, 10) + (time ? 'T' + String(time).slice(0, 5) : '');
  const services = order.map(k => ({
    Category: byKey[k].place, ServiceName: byKey[k].name, SubOption: byKey[k].sku, Level: byKey[k].level
  }));
  const assignments = order.map((k, i) => ({
    Category: byKey[k].place, ServiceName: byKey[k].name, Sequence: i + 1,
    AssignedTo: byKey[k].people.join(', '), ScheduledDate: scheduledDate, WorkStatus: 'Not Started'
  }));
  return { services, assignments };
}
/* Nombres por PayrollID desde Techs (lo que compara Tech para saber
   que es de quien), con FieldEmployees de respaldo -- mismo formato
   "Nombre Apellido" en los dos. */
function namesByPayroll(techs, employees) {
  const out = {};
  (employees || []).forEach(it => {
    if (!it.fields || !it.fields.PayrollNumber) return;
    out[String(it.fields.PayrollNumber).trim()] = (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).trim();
  });
  (techs || []).forEach(it => {
    if (!it.fields || !it.fields.PayrollID) return;
    const n = (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).trim();
    if (n) out[String(it.fields.PayrollID).trim()] = n;
  });
  return out;
}

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
/* BUG REAL corregido (20/09/2026): esto guardaba la hora suelta del
   contrato (ej. "6:00 AM") directo en ServiceWindow -- pero el resto
   del sistema (admin.html, SERVICE_WINDOWS) espera uno de 4 RANGOS
   fijos ("5:00 AM - 8:00 AM", etc.), nunca una hora sola. Confirmado
   con capturas reales lado a lado: el dropdown de editar salia en
   blanco (la hora no matcheaba ningun rango), y si se guardaba asi
   sin corregir a mano, se perdia el valor. Ahora mapea la hora del
   contrato al rango que le corresponde -- los mismos 4 bloques de 3
   horas que ya existen en SERVICE_WINDOWS, sin inventar nada nuevo. */
const SERVICE_WINDOW_BUCKETS = [
  { startMin: 5 * 60,  label: '5:00 AM - 8:00 AM'  },
  { startMin: 8 * 60,  label: '8:00 AM - 11:00 AM' },
  { startMin: 11 * 60, label: '11:00 AM - 2:00 PM' },
  { startMin: 14 * 60, label: '2:00 PM - 5:00 PM'  }
];
function toServiceWindow(time) {
  const t = String(time || '').trim();
  const m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return SERVICE_WINDOW_BUCKETS[0].label; // no se pudo leer la hora -- default al primer bloque
  let hour = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') hour += 12;
  const minutes = hour * 60 + Number(m[2]);
  let chosen = SERVICE_WINDOW_BUCKETS[0];
  for (const bucket of SERVICE_WINDOW_BUCKETS) {
    if (minutes >= bucket.startMin) chosen = bucket;
  }
  return chosen.label;
}

async function ensureRecurringOrders(todayISO_) {
  const today = todayISO_ || toISO(new Date());
  const report = { created: [], skipped: [], errors: [] };

  const [services, assignments, employees, clients, allOrders, techs] = await Promise.all([
    fetchAll(RECURRING_SERVICES_LIST),
    fetchAll(RECURRING_ASSIGNMENTS_LIST),
    fetchAll(FIELD_EMPLOYEES_LIST),
    fetchAll(CLIENTS_LIST),
    fetchAll(ORDERS_LIST),
    fetchAll(TECHS_LIST)
  ]);
  const placeNames = namesByPayroll(techs, employees);

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

    const contractEntries = parseServicesJSON(f.ServicesJSON);
    const placeBased = isPlaceContract(contractEntries);
    let servicesPayload = [];
    let servicesPayloadRaw = [];
    if (!placeBased) {
      servicesPayload = contractEntries.map(s => ({
        Category: 'Janitorial',
        ServiceName: s.serviceName || s.sku || '',
        SubOption: s.sku || ''
      }));
      servicesPayloadRaw = servicesPayload;
      servicesPayload = await expandPackages(servicesPayload, f.ClientID);
    }

    const missing = missingDatesFor(contract, existingDatesByContract[String(contractId)] || [], today, WINDOW_DAYS);

    for (const dispatchDate of missing) {
      try {
        const orderId = String(f.ClientID).trim() + '-REC' + recCounter;
        recCounter++;

        /* Por lugar: los servicios de ESE dia de la semana, con su
           lugar en Category y su gente ya repartida. */
        const plan = placeBased ? placeDayPlan(contractEntries, dispatchDate, f.Time, placeNames) : null;
        const daySvc = plan ? plan.services : servicesPayload;

        const orderFields = {
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
        };
        if (plan) orderFields.AssignByService = true;
        await createListItem(ORDERS_LIST, orderFields);
        if (!plan && servicesPayloadRaw.length !== servicesPayload.length) {
          try { await recordPackageSnapshots(orderId, servicesPayloadRaw, 'Recurring'); } catch (e) { console.error('Package snapshot (recurring):', e.message); }
        }

        await Promise.all([
          ...daySvc.map(s => createListItem(ORDER_SERVICES_LIST, Object.assign({
            Title: s.ServiceName || '',
            OrderID: orderId,
            Category: s.Category || 'Janitorial',
            ServiceName: s.ServiceName || '',
            SubOption: s.SubOption || '',
            Division: 'Janitorial'
          }, s.Level ? { Level: s.Level } : {}))),
          ...(plan ? plan.assignments.map(a => createListItem(SERVICE_ASSIGNMENTS_LIST, Object.assign({
            Title: a.ServiceName, OrderID: orderId
          }, a))) : []),
          createListItem(ORDER_HISTORY_LIST, {
            Title: orderId,
            OrderID: orderId,
            ChangeType: 'Created',
            ChangedBy: 'Office',
            ChangeDate: new Date().toISOString(),
            FieldChanged: 'Office Order',
            NewValue: 'SERVICES:' + JSON.stringify({ services: daySvc, serviceWindow: toServiceWindow(f.Time) })
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

/* ===== Propagar un cambio de contrato a sus ordenes ya generadas
   (20/09/2026, decidido con el dueno) =====
   Editar un contrato ("Update" en su tarjeta) aplica el cambio
   DIRECTO a todas sus ordenes que sigan en 'Recurring Scheduled' --
   sin pasar por Review, a diferencia de editar una orden individual.
   Una orden que ya paso su dia (Assigned/Completed/etc) NUNCA se
   toca aqui -- ya es historia real.

   Si cambiaron los Dias: "todo ese pedo debe ser dinamico" -- se
   borran las 'Recurring Scheduled' que ya no correspondan al patron
   nuevo (y sus renglones de ORDER_SERVICES_LIST) y se vuelve a
   correr ensureRecurringOrders() para rellenar el colchon de 30 dias
   con el patron correcto. Si los dias NO cambiaron, es mas barato:
   actualiza los campos que si cambiaron (Building/Supervisor/
   ServiceWindow) y reemplaza los servicios de cada orden, sin
   borrar/regenerar nada. */
async function propagateContractEdit(serviceId, oldDaysOfWeek, todayISO_) {
  const today = todayISO_ || toISO(new Date());
  const report = { daysChanged: false, deleted: 0, updated: 0, regenerated: null, errors: [] };

  const [contractItem, allOrders] = await Promise.all([
    graphFetch(siteListPath(RECURRING_SERVICES_LIST) + '/' + serviceId + '?$expand=fields'),
    fetchAll(ORDERS_LIST)
  ]);
  const f = contractItem.fields;
  if (!f) { report.errors.push('Contract not found: ' + serviceId); return report; }

  const newDaysOfWeek = f.DaysOfWeek || '';
  report.daysChanged = String(oldDaysOfWeek || '') !== String(newDaysOfWeek);

  const scheduledOrders = allOrders.filter(it => it.fields
    && String(it.fields.RecurringServiceID) === String(serviceId)
    && it.fields.Status === RECURRING_INITIAL_STATUS);

  /* Por lugar: cada dia de la semana lleva servicios/gente distintos,
     asi que "actualizar en su lugar" con UN solo payload (rama de abajo)
     le pondria el alcance de un dia a todos. Si el contrato es (o era)
     por lugar, se regenera siempre -- mismo camino ya probado que
     cuando cambian los dias. */
  const placeNow = isPlaceContract(parseServicesJSON(f.ServicesJSON));
  const placeBefore = scheduledOrders.some(o => o.fields.AssignByService === true || o.fields.AssignByService === 'true');
  report.placeBased = placeNow;

  if (report.daysChanged || placeNow || placeBefore) {
    /* Borrar las que ya no corresponden -- TODAS las que sigan en
       Recurring Scheduled, ya que se van a regenerar desde cero con
       el patron nuevo (mas simple y seguro que calcular cuales de
       las viejas "por casualidad" siguen cayendo en un dia valido
       del patron nuevo). */
    /* Una sola lectura de cada lista (antes se volvia a traer TODA
       OrderServices por cada orden a borrar). ServiceAssignments
       tambien se limpia: una orden por lugar las trae ya creadas. */
    const [svcRowsAll, assignRowsAll] = scheduledOrders.length
      ? await Promise.all([fetchAll(ORDER_SERVICES_LIST), fetchAll(SERVICE_ASSIGNMENTS_LIST)])
      : [[], []];
    for (const o of scheduledOrders) {
      try {
        const orderId = o.fields.OrderID || o.fields.Title || '';
        const toDeleteSvc = svcRowsAll.filter(s => s.fields && s.fields.OrderID === orderId);
        const toDeleteAssign = assignRowsAll.filter(s => s.fields && s.fields.OrderID === orderId);
        await Promise.all([
          ...toDeleteSvc.map(s => deleteListItem(ORDER_SERVICES_LIST, s.id)),
          ...toDeleteAssign.map(s => deleteListItem(SERVICE_ASSIGNMENTS_LIST, s.id))
        ]);
        await deleteListItem(ORDERS_LIST, o.id);
        report.deleted++;
      } catch (e) {
        report.errors.push(e.message);
      }
    }
    report.regenerated = await ensureRecurringOrders(today);
    return report;
  }

  /* Dias iguales -- actualizar en su lugar, sin borrar nada. */
  const [assignments, employees, clients] = await Promise.all([
    fetchAll(RECURRING_ASSIGNMENTS_LIST),
    fetchAll(FIELD_EMPLOYEES_LIST),
    fetchAll(CLIENTS_LIST)
  ]);
  const nameByPayroll = {};
  employees.forEach(it => {
    if (!it.fields || !it.fields.PayrollNumber) return;
    nameByPayroll[String(it.fields.PayrollNumber).trim()] =
      (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).trim();
  });
  const myAssignment = assignments.find(a => a.fields && String(a.fields.RecurringServiceID) === String(serviceId));
  const supervisorName = myAssignment ? (nameByPayroll[String(myAssignment.fields.PayrollNumber).trim()] || '') : '';

  let servicesPayload = [];
  try {
    const parsed = JSON.parse(f.ServicesJSON || '[]');
    servicesPayload = (Array.isArray(parsed) ? parsed : []).map(s => ({
      Category: 'Janitorial', ServiceName: s.serviceName || s.sku || '', SubOption: s.sku || ''
    }));
  } catch (e) { servicesPayload = []; }
  servicesPayload = await expandPackages(servicesPayload, f.ClientID);

  const newServiceWindow = toServiceWindow(f.Time);
  const allSvcRows = await fetchAll(ORDER_SERVICES_LIST);

  for (const o of scheduledOrders) {
    try {
      const orderId = o.fields.OrderID || o.fields.Title || '';
      await updateListItemByItemId(ORDERS_LIST, o.id, {
        BuildingNumber: f.BuildingNumber || '',
        Supervisor: supervisorName,
        ServiceWindow: newServiceWindow
      });
      const oldSvc = allSvcRows.filter(s => s.fields && s.fields.OrderID === orderId);
      await Promise.all(oldSvc.map(s => deleteListItem(ORDER_SERVICES_LIST, s.id)));
      await Promise.all(servicesPayload.map(s => createListItem(ORDER_SERVICES_LIST, {
        Title: s.ServiceName || '', OrderID: orderId, Category: s.Category || 'Janitorial',
        ServiceName: s.ServiceName || '', SubOption: s.SubOption || '', Division: 'Janitorial'
      })));
      report.updated++;
    } catch (e) {
      report.errors.push(e.message);
    }
  }
  return report;
}

module.exports = {
  placeDayPlan, placeLabel, placeContext, isPlaceContract, parseServicesJSON,
  ensureRecurringOrders,
  promoteDueRecurringOrders,
  propagateContractEdit,
  computeRecurringDates,
  nextRecId,
  missingDatesFor,
  toServiceWindow,
  RECURRING_INITIAL_STATUS
};
