/* ============================================================
   developer-admin.js — backend del tab Developer: catalogo de
   servicios (Staff/Director pueden editar, Staff solo ve), y
   password del director + roles del staff (solo Developer).

   Una sola funcion para todo (como admin-approve-order.js), en vez de
   un archivo por accion -- el plan gratis de Vercel tiene limite de
   12 funciones y ya estabamos al tope.

   Seguridad: no basta con esconder botones en el frontend -- cada
   accion revisa aqui, del lado del servidor, el rol real de quien la
   pide (via su correo de MSAL, contra la lista Staff), y la rechaza
   si no le corresponde. Alguien que intente llamar el endpoint
   directo sin pasar por la pantalla no puede saltarse esto.

   DISEÑO A PRUEBA DE LISTAS VACIAS: si Staff o Settings todavia no
   existen o estan vacias (el admin las esta creando apenas), nada de
   esto debe romper el resto del sistema -- getRole() regresa null sin
   tronar, y quien llame a estas acciones simplemente no tiene permiso
   todavia (en vez de un error 500 feo).
============================================================ */

const {
  SERVICES_CATALOG_LIST, STAFF_LIST, SETTINGS_LIST,
  FIELD_EMPLOYEES_LIST, SCHEDULING_LIST, WEEKLY_HOURS_LIST, REPORT_UPLOADS_LIST,
  RECURRING_SERVICES_LIST, RECURRING_ASSIGNMENTS_LIST, RECURRING_LOG_LIST,
  ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, DRAFTS_LIST, CLIENTS_LIST,
  CLIENT_ADDRESSES_LIST, geocodeAddress, TECHS_LIST, ORDER_ASSIGNMENTS_LIST, SERVICE_TIMES_LIST,
  graphFetch, siteListPath, queryList,
  createListItem, updateListItemByItemId, deleteListItem,
  jsonResponse
} = require('./lib/graph');

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
    /* La lista todavia no existe, o algo salio mal leyendola -- se
       trata como "vacia" en vez de tronar todo el endpoint. */
    return [];
  }
  return out;
}

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

/* uAttend a veces exporta nombres con espacios dobles entre nombre y
   apellido, o con espacio sobrante al final (visto en un Hours Report
   real: "Andres  Galiano", "Clara  Chihuahua "). trim() nomas quita
   los extremos, no los espacios de en medio -- sin esto, el cruce por
   nombre fallaba en silencio para esa gente, aunque el nombre fuera
   "el mismo" a simple vista. */
function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/* ============================================================
   CATALOGO NUEVO (ServicesCatalog) -- clasificacion por SKU.
   Regla confirmada por el usuario, viene del reporte de QuickBooks
   (formato real de SKU: "110-10", "222-07", etc. -- el prefijo de
   3 digitos antes del guion es lo unico que importa):
     100-199 = Janitorial   | 200-299 = Renovations | 300-399 = Exteriors
     111/222/333 = Commercial dentro de su rango, cualquier otro
     prefijo del mismo rango (110/210/300) = Residential.
   Un SKU que no cae en ninguno de estos 6 prefijos exactos no se
   reconoce -- la fila se ignora en la importacion, nunca se adivina. */
const SKU_PREFIX_MAP = {
  '110': { division: 'Janitorial',  propertyType: 'Residential' },
  '111': { division: 'Janitorial',  propertyType: 'Commercial' },
  '210': { division: 'Renovations', propertyType: 'Residential' },
  '222': { division: 'Renovations', propertyType: 'Commercial' },
  '300': { division: 'Exteriors',   propertyType: 'Residential' },
  '333': { division: 'Exteriors',   propertyType: 'Commercial' }
};
function classifySku(sku) {
  const prefix = String(sku || '').trim().slice(0, 3);
  return SKU_PREFIX_MAP[prefix] || null;
}

/* Rol real de un correo, segun la lista Staff. null si Staff no
   existe todavia, esta vacia, o el correo no tiene renglon ahi --
   en los 3 casos, "sin permiso" es la respuesta correcta, no un error. */
async function getRole(email) {
  if (!email) return null;
  const rows = await fetchAll(STAFF_LIST);
  const wanted = String(email).trim().toLowerCase();
  const row = rows.find(it => it.fields &&
    String(it.fields.Email || '').trim().toLowerCase() === wanted);
  return row ? String(row.fields.Role || '').trim() : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, email } = body;
    if (!action) return jsonResponse(400, { error: 'action is required' });

    /* ---- Validar el password del director: se hace ANTES del gate de
       rol (Staff/Director/Developer), porque cualquier persona del
       staff -- tenga o no un rol asignado en la lista Staff -- puede
       necesitar confirmar una accion con este password (aprobar en
       Review, reactivar una orden, etc.). Nunca se manda el password
       guardado de vuelta al navegador -- solo true/false, para que no
       quede expuesto viendo el trafico de red. Si Settings no existe
       o no tiene el renglon todavia, usa el valor de respaldo actual,
       para no romper nada mientras se termina de configurar. */
    if (action === 'verify-director-password') {
      const rows = await fetchAll(SETTINGS_LIST);
      const row = rows.find(it => it.fields && it.fields.Key === 'DirectorPassword');
      const real = (row && row.fields.Value) || '080922';
      const valid = String(body.password || '') === String(real);
      return jsonResponse(200, { valid });
    }

    const role = await getRole(email);
    const canView = role === 'Staff' || role === 'Director' || role === 'Developer';
    const canEditCatalog = role === 'Director' || role === 'Developer';
    const isDeveloper = role === 'Developer';

    /* ---- Averiguar mi propio rol (para que developer.html sepa que
       mostrar sin necesitar un segundo endpoint) ---- */
    if (action === 'whoami') {
      return jsonResponse(200, { role: role || null });
    }

    if (!canView) {
      return jsonResponse(403, { error: 'You do not have access to the Developer tab.' });
    }

    /* ---- Catalogo viejo (Services, por-cuarto) retirado -- ya no
       tiene UI que lo use, se reemplazo por completo con
       ServicesCatalog (list-catalog/preview-catalog-import/
       apply-catalog-import/toggle-catalog-active mas abajo). La lista
       "Services" en SharePoint y get-services.js siguen intactos --
       services.html y customer.html (repo ordersgsocd.com) todavia
       leen de ahi hasta que les toque su turno de migracion. ---- */

    /* ============================================================
       CATALOGO NUEVO (ServicesCatalog) -- viene del reporte de
       QuickBooks (ProductsServicesList...csv), organizado por
       servicio completo de negocio, no por pieza/cuarto. Nada de
       edicion manual: la unica forma de cambiar un servicio es
       subiendo un reporte nuevo. Actualiza por SKU, nunca reemplaza
       de golpe, y nunca desactiva/reactiva en silencio -- por eso
       son 2 pasos separados (preview primero, apply solo con lo que
       el usuario ya confirmo en pantalla).
    ============================================================ */

    /* Toggle individual on/off -- prender/apagar un servicio sin subir
       un reporte nuevo. Solo cambia Active; nombre/SKU/precio/
       descripcion siguen sin poderse tocar a mano aqui. */
    if (action === 'toggle-catalog-active') {
      if (!canEditCatalog) return jsonResponse(403, { error: 'Your role cannot edit the service catalog.' });
      if (!body.id) return jsonResponse(400, { error: 'id is required' });
      await updateListItemByItemId(SERVICES_CATALOG_LIST, body.id, { Active: !!body.active });
      return jsonResponse(200, { success: true });
    }

    /* ---- Renovations: Mark as Seen -- el staff reconoce el aviso de
       "materials ready" que mando el cliente. No es una decision (no
       hay Approve/Reject), solo apaga la burbuja de Review. Cualquier
       rol con acceso puede hacerlo, no solo Director/Developer. ---- */
    if (action === 'mark-materials-seen') {
      if (!body.orderId) return jsonResponse(400, { error: 'orderId is required' });
      const rows = await fetchAll(ORDERS_LIST);
      const orderItem = rows.find(it => it.fields && String(it.fields.OrderID || it.fields.Title || '') === String(body.orderId));
      if (!orderItem) return jsonResponse(404, { error: 'Order not found.' });
      await updateListItemByItemId(ORDERS_LIST, orderItem.id, { MaterialsReadySeen: true });
      await createListItem(ORDER_HISTORY_LIST, {
        Title: body.orderId + '-seen',
        OrderID: body.orderId,
        ChangeType: 'Materials Ready Seen',
        ChangedBy: (email || 'Staff'),
        ChangeDate: new Date().toISOString(),
        Notes: ''
      });
      return jsonResponse(200, { success: true });
    }

    if (action === 'list-catalog') {
      const rows = await fetchAll(SERVICES_CATALOG_LIST);
      const services = rows.filter(it => it.fields).map(it => ({
        id: it.id,
        serviceName: it.fields.ServiceName || '',
        sku: it.fields.SKU || '',
        division: it.fields.Division || '',
        propertyType: it.fields.PropertyType || '',
        description: it.fields.Description || '',
        price: it.fields.Price != null ? it.fields.Price : null,
        active: truthy(it.fields.Active)
      }));
      return jsonResponse(200, { services });
    }

    /* Recibe las filas ya parseadas del CSV en el navegador
       ({ serviceName, sku, price, description }) y regresa el diff
       completo SIN escribir nada todavia -- para que el usuario vea
       que va a pasar antes de confirmar. */
    if (action === 'preview-catalog-import') {
      if (!canEditCatalog) return jsonResponse(403, { error: 'Your role cannot edit the service catalog.' });
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return jsonResponse(400, { error: 'No rows to process.' });

      const existing = await fetchAll(SERVICES_CATALOG_LIST);
      const bySku = new Map();
      existing.forEach(it => {
        const sku = it.fields && String(it.fields.SKU || '').trim();
        if (sku) bySku.set(sku, it);
      });

      const toCreate = [], toUpdate = [], toReactivate = [], skippedNoSku = [], skippedUnrecognized = [];
      const seenSkus = new Set();

      for (const r of rows) {
        const sku = String(r.sku || '').trim();
        const serviceName = String(r.serviceName || '').trim();
        if (!serviceName) continue;
        if (!sku) { skippedNoSku.push(serviceName); continue; }

        const cls = classifySku(sku);
        if (!cls) { skippedUnrecognized.push(serviceName + ' (' + sku + ')'); continue; }

        seenSkus.add(sku);
        const price = r.price === '' || r.price == null ? null : Number(r.price);
        const description = String(r.description || '').trim();

        const match = bySku.get(sku);
        if (!match) {
          toCreate.push({ sku, serviceName, division: cls.division, propertyType: cls.propertyType, price, description });
          continue;
        }

        const f = match.fields;
        const wasActive = truthy(f.Active);
        const changed = String(f.ServiceName || '') !== serviceName ||
          String(f.Division || '') !== cls.division ||
          String(f.PropertyType || '') !== cls.propertyType ||
          String(f.Description || '') !== description ||
          Number(f.Price || 0) !== (price || 0);

        const item = { sku, serviceName, division: cls.division, propertyType: cls.propertyType, price, description, id: match.id };
        if (!wasActive) {
          toReactivate.push(item);
        } else if (changed) {
          toUpdate.push(item);
        }
        /* si no cambio nada y ya estaba activo, no se hace nada -- ni
           siquiera se manda al frontend, para no llenar la pantalla
           de renglones sin novedad */
      }

      /* Lo que esta activo hoy en el catalogo pero no aparecio para
         nada en este reporte -- candidato a desactivar, con aviso. */
      const toDeactivate = [];
      existing.forEach(it => {
        const f = it.fields;
        if (!f) return;
        const sku = String(f.SKU || '').trim();
        if (sku && truthy(f.Active) && !seenSkus.has(sku)) {
          toDeactivate.push({ id: it.id, sku, serviceName: f.ServiceName || '' });
        }
      });

      return jsonResponse(200, { toCreate, toUpdate, toReactivate, toDeactivate, skippedNoSku, skippedUnrecognized });
    }

    /* Aplica de verdad: crea lo nuevo, actualiza lo que cambio, y
       SOLO reactiva/desactiva los SKUs que el usuario marco en la
       pantalla de preview (confirmedReactivateSkus/confirmedDeactivateSkus)
       -- cualquier otro candidato a reactivar/desactivar que el
       usuario haya dejado sin marcar se queda exactamente como esta. */
    if (action === 'apply-catalog-import') {
      if (!canEditCatalog) return jsonResponse(403, { error: 'Your role cannot edit the service catalog.' });
      const toCreate = Array.isArray(body.toCreate) ? body.toCreate : [];
      const toUpdate = Array.isArray(body.toUpdate) ? body.toUpdate : [];
      const confirmedReactivate = Array.isArray(body.confirmedReactivate) ? body.confirmedReactivate : [];
      const confirmedDeactivate = Array.isArray(body.confirmedDeactivate) ? body.confirmedDeactivate : [];

      let created = 0, updated = 0, reactivated = 0, deactivated = 0;

      for (const r of toCreate) {
        await createListItem(SERVICES_CATALOG_LIST, {
          Title: r.serviceName,
          ServiceName: r.serviceName,
          SKU: r.sku,
          Division: r.division,
          PropertyType: r.propertyType,
          Description: r.description || '',
          Price: r.price,
          Active: true
        });
        created++;
      }

      for (const r of toUpdate) {
        await updateListItemByItemId(SERVICES_CATALOG_LIST, r.id, {
          ServiceName: r.serviceName,
          Division: r.division,
          PropertyType: r.propertyType,
          Description: r.description || '',
          Price: r.price
        });
        updated++;
      }

      for (const r of confirmedReactivate) {
        await updateListItemByItemId(SERVICES_CATALOG_LIST, r.id, {
          ServiceName: r.serviceName,
          Division: r.division,
          PropertyType: r.propertyType,
          Description: r.description || '',
          Price: r.price,
          Active: true
        });
        reactivated++;
      }

      for (const r of confirmedDeactivate) {
        await updateListItemByItemId(SERVICES_CATALOG_LIST, r.id, { Active: false });
        deactivated++;
      }

      return jsonResponse(200, { success: true, created, updated, reactivated, deactivated });
    }

    /* ============================================================
       SCHEDULING — Reports: subir Employee Report y Hours Report.
       Nivel de acceso: igual que canView (Staff/Director/Developer) --
       los permisos finos de Scheduling quedaron pendientes aparte,
       por ahora no se restringe mas que eso.
    ============================================================ */

    /* Employee Report -> crea/actualiza FieldEmployees. Division y
       Active SIEMPRE se sobreescriben con lo que diga el reporte mas
       reciente -- nunca hay edicion manual que sobreviva a la
       siguiente subida (confirmado explicitamente). Cualquiera con
       Department Code >= 1000 es de oficina y se ignora por completo. */
    if (action === 'upload-employee-report') {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return jsonResponse(400, { error: 'No rows to process.' });

      const existing = await fetchAll(FIELD_EMPLOYEES_LIST);
      const existingTechs = await fetchAll(TECHS_LIST);
      const seenIds = new Set();
      const missingPayroll = [];
      let created = 0, updated = 0, officeCount = 0;
      let techsCreated = 0, techsUpdated = 0;
      const missingPhone = [];

      for (const r of rows) {
        const firstName = String(r.firstName || '').trim();
        const lastName = String(r.lastName || '').trim();
        if (!firstName && !lastName) continue;

        const deptCode = parseInt(String(r.departmentCode || '').trim(), 10);
        const isOffice = isNaN(deptCode) || deptCode >= 1000;
        if (isOffice) officeCount++;

        const payrollNumber = String(r.payrollNumber || '').trim();
        const active = String(r.activeStatus || '').trim().toUpperCase() === 'ACTIVE';
        const email = String(r.email || '').trim();
        const phone = String(r.phone || '').trim();

        /* La gente de oficina SI se guarda en FieldEmployees -- si no,
           el Hours Report nunca puede cruzarla, y siempre saldria como
           "sin cruce" aunque sea esperado que asi sea. Se guarda sin
           ninguna division marcada, asi nunca sale como candidata para
           asignar (el filtro de Scheduling siempre exige una division
           que coincida) -- son "invisibles" para asignar, pero SI
           encontrables para las horas. */
        const janitorial  = !isOffice && deptCode >= 100 && deptCode < 200;
        const renovations = !isOffice && deptCode >= 200 && deptCode < 300;
        const exteriors    = !isOffice && deptCode >= 300 && deptCode < 400;

        /* Cruce: primero por PayrollNumber si ya lo teniamos guardado
           (mas confiable), si no por nombre normalizado. */
        let match = null;
        if (payrollNumber) {
          match = existing.find(it => it.fields && String(it.fields.PayrollNumber || '').trim() === payrollNumber);
        }
        if (!match) {
          const wanted = normalizeName(firstName + ' ' + lastName);
          match = existing.find(it => it.fields &&
            normalizeName(String(it.fields.FirstName || '') + ' ' + String(it.fields.LastName || '')) === wanted);
        }

        const fields = {
          Title: (firstName + ' ' + lastName).trim(),
          FirstName: firstName,
          LastName: lastName,
          PayrollNumber: payrollNumber,
          Janitorial: janitorial,
          Renovations: renovations,
          Exteriors: exteriors,
          Active: active
        };

        if (match) {
          await updateListItemByItemId(FIELD_EMPLOYEES_LIST, match.id, fields);
          seenIds.add(match.id);
          updated++;
        } else {
          const row = await createListItem(FIELD_EMPLOYEES_LIST, fields);
          seenIds.add(row.id);
          created++;
        }

        if (!payrollNumber) missingPayroll.push((firstName + ' ' + lastName).trim());

        /* Cuenta de tech.gsocd.com automatica -- para que nadie de
           campo tenga que registrarse a mano. Solo gente de campo
           (Janitorial/Renovations/Exteriors), la oficina no necesita
           el portal de tecnicos.

           Cruce por NOMBRE normalizado nomas (no por telefono/TempID):
           si esta persona YA se registro sola en tech.gsocd.com antes
           de que subieras este reporte, su TempID (el que ya esta
           usando para entrar) y su Role (si ya se lo cambiaste a
           Supervisor) NUNCA se tocan aqui -- solo se le rellena el
           PayrollID real y se actualiza su Division segun este
           reporte. Si es la primera vez que aparece, se crea de cero
           con un TempID calculado del telefono del reporte. */
        if (!isOffice) {
          const division = janitorial ? 'Janitorial' : renovations ? 'Renovations' : exteriors ? 'Exteriors' : '';
          const wantedName = normalizeName(firstName + ' ' + lastName);
          const techMatch = existingTechs.find(it => it.fields &&
            normalizeName(String(it.fields.FirstName || '') + ' ' + String(it.fields.LastName || '')) === wantedName);

          if (techMatch) {
            const techFields = { PayrollID: payrollNumber, Division: division };
            if (email) techFields.Email = email;
            if (phone) techFields.Phone = phone;
            await updateListItemByItemId(TECHS_LIST, techMatch.id, techFields);
            techsUpdated++;
          } else {
            const tempId = String(phone).replace(/\D/g, '').slice(-4);
            if (tempId.length !== 4) {
              missingPhone.push((firstName + ' ' + lastName).trim());
            } else {
              await createListItem(TECHS_LIST, {
                Title: firstName + ' ' + lastName,
                FirstName: firstName,
                LastName: lastName,
                Phone: phone,
                Email: email,
                TempID: tempId,
                PayrollID: payrollNumber,
                Role: 'Employee',
                Division: division,
                Active: active
              });
              techsCreated++;
            }
          }
        }
      }

      /* Quien ya no aparecio en este reporte, se desactiva (no se
         borra) -- si vuelve a aparecer despues, se reactiva solo. */
      let deactivated = 0;
      const toDeactivate = existing.filter(it => it.fields && !seenIds.has(it.id) && truthy(it.fields.Active));
      await Promise.all(toDeactivate.map(it => updateListItemByItemId(FIELD_EMPLOYEES_LIST, it.id, { Active: false })));
      deactivated = toDeactivate.length;

      const summary = created + ' agregados, ' + updated + ' actualizados, ' + deactivated + ' desactivados, ' +
        officeCount + ' de oficina (guardados, nunca asignables). Tech portal: ' +
        techsCreated + ' cuentas nuevas, ' + techsUpdated + ' actualizadas' +
        (missingPhone.length ? '. Sin telefono valido (sin cuenta creada): ' + missingPhone.join(', ') : '') +
        (missingPayroll.length ? '. Falta Payroll Number: ' + missingPayroll.join(', ') : '');

      await createListItem(REPORT_UPLOADS_LIST, {
        Title: 'Employee Report',
        ReportType: 'Employee Report',
        UploadDate: new Date().toISOString(),
        Summary: summary
      });

      return jsonResponse(200, { success: true, created, updated, deactivated, officeCount, techsCreated, techsUpdated, missingPhone, missingPayroll });
    }

    /* Hours Report (Average Hours) -> reemplaza WeeklyHours completo.
       Se cruza por nombre contra FieldEmployees para guardar todo con
       PayrollNumber, nunca con el nombre suelto. */
    if (action === 'upload-hours-report') {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return jsonResponse(400, { error: 'No rows to process.' });

      /* El Punch Report trae EMP## directo (=PayrollNumber), asi que
         ya no hace falta cruzar por nombre para nada -- el frontend
         ya suma las horas por semana y manda payrollNumber tal cual.
         Aqui solo se valida contra el catalogo para avisar si algun
         numero no se reconoce (typo, alguien que no esta en
         FieldEmployees todavia, etc). */
      const employees = await fetchAll(FIELD_EMPLOYEES_LIST);
      const knownPayrollNumbers = new Set(
        employees.filter(it => it.fields && it.fields.PayrollNumber)
          .map(it => String(it.fields.PayrollNumber).trim())
      );

      /* CAMBIO DE LOGICA (ver comentario largo en admin.html, junto a
         onHoursFileChosen): cada renglon que llega ahora es UN DIA,
         no una semana completa -- se guarda uno por (persona, dia),
         nunca se reemplaza toda la semana con un solo numero. Subir
         el mismo dia dos veces solo sobreescribe ESE dia, no duplica
         ni pisa los demas dias de la semana. */
      const existingHours = await fetchAll(WEEKLY_HOURS_LIST);
      const existingByKey = {};
      existingHours.forEach(it => {
        if (!it.fields) return;
        const key = String(it.fields.PayrollNumber || '').trim() + '|' + String(it.fields.Date || '').slice(0, 10);
        existingByKey[key] = it;
      });

      let created = 0, updated = 0;
      const unmatched = new Set();
      const tasks = [];

      for (const r of rows) {
        const payrollNumber = String(r.payrollNumber || '').trim();
        const date = String(r.date || '').slice(0, 10);
        if (!payrollNumber || !date) continue;
        if (!knownPayrollNumbers.has(payrollNumber)) { unmatched.add(payrollNumber); continue; }

        const key = payrollNumber + '|' + date;
        const fields = {
          Title: payrollNumber + ' ' + date,
          PayrollNumber: payrollNumber,
          Date: date,
          WeekStart: r.weekStart,
          WeekEnd: r.weekEnd,
          TotalWeeklyHours: Number(r.hours) || 0
        };
        const existingRow = existingByKey[key];
        if (existingRow) {
          tasks.push(updateListItemByItemId(WEEKLY_HOURS_LIST, existingRow.id, fields).then(() => { updated++; }));
        } else {
          tasks.push(createListItem(WEEKLY_HOURS_LIST, fields).then(() => { created++; }));
        }
      }
      await Promise.all(tasks);

      const summary = created + ' semanas nuevas, ' + updated + ' actualizadas' +
        (unmatched.size ? '. Payroll Number sin reconocer: ' + Array.from(unmatched).join(', ') : '');

      await createListItem(REPORT_UPLOADS_LIST, {
        Title: 'Punch Report',
        ReportType: 'Punch Report',
        UploadDate: new Date().toISOString(),
        Summary: summary
      });

      return jsonResponse(200, { success: true, created, updated, unmatched: Array.from(unmatched) });
    }

    if (action === 'list-report-uploads') {
      const rows = await fetchAll(REPORT_UPLOADS_LIST);
      const uploads = rows.filter(it => it.fields).map(it => ({
        id: it.id,
        ReportType: it.fields.ReportType || '',
        UploadDate: it.fields.UploadDate || '',
        Summary: it.fields.Summary || ''
      })).sort((a, b) => String(b.UploadDate).localeCompare(String(a.UploadDate)));
      return jsonResponse(200, { uploads });
    }

    /* Panorama de horas: por cada empleado activo con PayrollNumber
       (sin eso no se puede asignar, se excluye), sus horas de la
       semana que contiene HOY (de WeeklyHours) y cuantas ordenes ya
       tiene asignadas esa misma semana (de Scheduling, aunque hoy
       todavia este vacia esa lista). */
    /* Escribe las filas de Scheduling (una por persona seleccionada,
       para ese dia especifico). NO toca la orden en si -- eso lo hace
       /admin-update-order, que ya existe y ya sabe escribir Supervisor/
       ServiceWindow/DispatchDate/InspectionDate + el historial; el
       frontend llama a los dos en secuencia. */
    if (action === 'save-scheduling-assignment') {
      const { orderId, payrollNumbers, assignedDate, division, startsFromOffice } = body;
      if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
      if (!Array.isArray(payrollNumbers) || !payrollNumbers.length) return jsonResponse(400, { error: 'At least one employee is required' });
      if (!assignedDate) return jsonResponse(400, { error: 'assignedDate is required' });

      await Promise.all(payrollNumbers.map(pn => createListItem(SCHEDULING_LIST, {
        Title: orderId + '-' + pn + '-' + assignedDate,
        OrderID: orderId,
        PayrollNumber: String(pn).trim(),
        AssignedDate: assignedDate,
        Division: division || '',
        StartsFromOffice: !!startsFromOffice
      })));

      return jsonResponse(200, { success: true });
    }

    if (action === 'list-scheduling') {
      const rows = await fetchAll(SCHEDULING_LIST);
      const items = rows.filter(it => it.fields).map(it => ({
        id: it.id,
        OrderID: it.fields.OrderID || '',
        PayrollNumber: it.fields.PayrollNumber || '',
        AssignedDate: it.fields.AssignedDate || '',
        Division: it.fields.Division || '',
        StartsFromOffice: truthy(it.fields.StartsFromOffice)
      }));
      return jsonResponse(200, { items });
    }

    /* Asignaciones huerfanas: filas de Scheduling con AssignedDate de
       HOY en adelante, cuyo PayrollNumber ya quedo inactivo (se fue
       de la empresa, desaparecio del ultimo Employee Report) --
       nadie va a ir a hacer ese trabajo si nadie se da cuenta. */
    if (action === 'list-orphaned-assignments') {
      const [scheduling, employees] = await Promise.all([
        fetchAll(SCHEDULING_LIST),
        fetchAll(FIELD_EMPLOYEES_LIST)
      ]);

      const inactiveByPayroll = {};
      employees.forEach(it => {
        if (!it.fields) return;
        const pn = String(it.fields.PayrollNumber || '').trim();
        if (!pn) return;
        if (!truthy(it.fields.Active)) {
          inactiveByPayroll[pn] = (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).trim();
        }
      });

      const today = new Date(); today.setHours(0, 0, 0, 0);

      const orphaned = scheduling
        .filter(it => it.fields)
        .filter(it => {
          const pn = String(it.fields.PayrollNumber || '').trim();
          if (!inactiveByPayroll[pn]) return false;
          const d = new Date(it.fields.AssignedDate);
          return !isNaN(d) && d >= today;
        })
        .map(it => ({
          id: it.id,
          orderId: it.fields.OrderID || '',
          payrollNumber: it.fields.PayrollNumber || '',
          employeeName: inactiveByPayroll[String(it.fields.PayrollNumber || '').trim()] || '',
          assignedDate: it.fields.AssignedDate || '',
          division: it.fields.Division || ''
        }));

      return jsonResponse(200, { orphaned });
    }

    /* Botón Reschedule: borra las filas de Scheduling de esa orden.
       El frontend, despues de esto, tambien llama a /admin-update-order
       para limpiar Supervisor/ServiceWindow/DispatchDate/InspectionDate
       en la orden misma (eso ya queda registrado en su historial por
       ese mismo endpoint, sin duplicar esa logica aqui). */
    if (action === 'reschedule-order') {
      const { orderId } = body;
      if (!orderId) return jsonResponse(400, { error: 'orderId is required' });
      const rows = await fetchAll(SCHEDULING_LIST);
      const toDelete = rows.filter(it => it.fields && it.fields.OrderID === orderId);
      await Promise.all(toDelete.map(it => deleteListItem(SCHEDULING_LIST, it.id)));
      return jsonResponse(200, { success: true, removed: toDelete.length });
    }

    if (action === 'get-hours-overview') {
      const [employees, hours, scheduling] = await Promise.all([
        fetchAll(FIELD_EMPLOYEES_LIST),
        fetchAll(WEEKLY_HOURS_LIST),
        fetchAll(SCHEDULING_LIST)
      ]);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      /* Domingo-Sabado, igual que uAttend (confirmado con su propio
         Time Card real: el periodo empieza en domingo, no lunes) --
         si no coincide con el corte que uAttend usa, el cruce con
         WeeklyHours nunca alinea bien. */
      const weekStartSunday = new Date(today);
      weekStartSunday.setDate(weekStartSunday.getDate() - weekStartSunday.getDay());
      const weekEndSaturday = new Date(weekStartSunday);
      weekEndSaturday.setDate(weekEndSaturday.getDate() + 6);

      const prevWeekStart = new Date(weekStartSunday);
      prevWeekStart.setDate(prevWeekStart.getDate() - 7);
      const prevWeekEnd = new Date(prevWeekStart);
      prevWeekEnd.setDate(prevWeekEnd.getDate() + 6);

      const overview = employees
        .filter(it => it.fields && truthy(it.fields.Active) && String(it.fields.PayrollNumber || '').trim() &&
          (truthy(it.fields.Janitorial) || truthy(it.fields.Renovations) || truthy(it.fields.Exteriors)))
        .map(it => {
          const f = it.fields;
          const payrollNumber = String(f.PayrollNumber).trim();
          const name = (String(f.FirstName || '').trim() + ' ' + String(f.LastName || '').trim()).trim();

          const weekRows = hours.filter(h => {
            if (!h.fields || String(h.fields.PayrollNumber || '').trim() !== payrollNumber) return false;
            const d = new Date(h.fields.Date);
            return d >= weekStartSunday && d <= weekEndSaturday;
          });
          const hoursThisWeek = weekRows.reduce((sum, h) => sum + (Number(h.fields.TotalWeeklyHours) || 0), 0);

          /* Semana anterior: mismo criterio, sumando todos los dias
             de esa lista de fechas. Cada dia se guarda por separado
             (columna Date) -- no se pierde nada al subir un reporte
             diario nuevo, cada subida solo toca el dia que le
             corresponde. */
          const prevWeekRows = hours.filter(h => {
            if (!h.fields || String(h.fields.PayrollNumber || '').trim() !== payrollNumber) return false;
            const d = new Date(h.fields.Date);
            return d >= prevWeekStart && d <= prevWeekEnd;
          });
          const hoursLastWeek = prevWeekRows.length
            ? prevWeekRows.reduce((sum, h) => sum + (Number(h.fields.TotalWeeklyHours) || 0), 0)
            : null;

          /* Ordenes UNICAS (no filas de Scheduling) -- un trabajo de
             varios dias en la misma orden cuenta como 1 servicio, no
             uno por cada dia asignado. */
          const assignedOrdersThisWeek = new Set(scheduling.filter(s => {
            if (!s.fields || String(s.fields.PayrollNumber || '').trim() !== payrollNumber) return false;
            const d = new Date(s.fields.AssignedDate);
            return d >= weekStartSunday && d <= weekEndSaturday;
          }).map(s => s.fields.OrderID)).size;

          const assignedOrdersLastWeek = new Set(scheduling.filter(s => {
            if (!s.fields || String(s.fields.PayrollNumber || '').trim() !== payrollNumber) return false;
            const d = new Date(s.fields.AssignedDate);
            return d >= prevWeekStart && d <= prevWeekEnd;
          }).map(s => s.fields.OrderID)).size;

          return {
            payrollNumber,
            name,
            janitorial: truthy(f.Janitorial),
            renovations: truthy(f.Renovations),
            exteriors: truthy(f.Exteriors),
            hoursThisWeek,
            hasWeekData: !!weekRows.length,
            hoursLastWeek,
            assignedOrdersThisWeek,
            assignedOrdersLastWeek
          };
        });

      return jsonResponse(200, {
        employees: overview,
        weekStart: weekStartSunday.toISOString().slice(0, 10),
        weekEnd: weekEndSaturday.toISOString().slice(0, 10),
        prevWeekStart: prevWeekStart.toISOString().slice(0, 10),
        prevWeekEnd: prevWeekEnd.toISOString().slice(0, 10)
      });
    }

    /* ---- Todo lo demas (password del director, roles del staff)
       es exclusivo de Developer ---- */
    if (!isDeveloper) {
      return jsonResponse(403, { error: 'Only the Developer role can manage passwords and staff roles.' });
    }

    if (action === 'get-settings') {
      const rows = await fetchAll(SETTINGS_LIST);
      const settings = {};
      rows.forEach(it => {
        if (!it.fields) return;
        settings[it.fields.Key || ''] = it.fields.Value || '';
      });
      return jsonResponse(200, { settings });
    }

    if (action === 'save-setting') {
      const key = body.key, value = body.value;
      if (!key) return jsonResponse(400, { error: 'key is required' });
      const rows = await fetchAll(SETTINGS_LIST);
      const existing = rows.find(it => it.fields && it.fields.Key === key);
      if (existing) {
        await updateListItemByItemId(SETTINGS_LIST, existing.id, { Value: value || '' });
      } else {
        await createListItem(SETTINGS_LIST, { Title: key, Key: key, Value: value || '' });
      }
      return jsonResponse(200, { success: true });
    }

    if (action === 'list-techs') {
      const rows = await fetchAll(TECHS_LIST);
      const techs = rows.filter(it => it.fields).map(it => ({
        id: it.id,
        firstName: it.fields.FirstName || '',
        lastName: it.fields.LastName || '',
        phone: it.fields.Phone || '',
        email: it.fields.Email || '',
        tempId: it.fields.TempID || '',
        payrollId: it.fields.PayrollID || '',
        role: it.fields.Role || 'Employee',
        division: it.fields.Division || '',
        active: it.fields.Active === undefined ? true : (it.fields.Active === true || it.fields.Active === 'true')
      })).sort((a, b) => (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName));
      return jsonResponse(200, { techs });
    }

    if (action === 'update-tech') {
      const techId = String(body.techId || '').trim();
      if (!techId) return jsonResponse(400, { error: 'techId is required' });
      const validRoles = ['Employee', 'Supervisor'];
      const validDivisions = ['Janitorial', 'Renovations', 'Exteriors'];
      const fields = {};
      if (body.role !== undefined) {
        if (validRoles.indexOf(body.role) === -1) return jsonResponse(400, { error: 'Invalid role.' });
        fields.Role = body.role;
      }
      if (body.division !== undefined) {
        if (body.division !== '' && validDivisions.indexOf(body.division) === -1) return jsonResponse(400, { error: 'Invalid division.' });
        fields.Division = body.division;
      }
      if (body.active !== undefined) fields.Active = !!body.active;
      if (!Object.keys(fields).length) return jsonResponse(400, { error: 'Nothing to update.' });
      await updateListItemByItemId(TECHS_LIST, techId, fields);
      return jsonResponse(200, { success: true });
    }

    /* Tiempo de trabajo estimado por orden -- SOLO para uso interno de
       Routing (nunca se le muestra al cliente). Suma, por cada
       servicio de la orden, el tiempo guardado en ServiceTimes segun
       su SKU (SubOption) y su Level si es Janitorial. Un servicio sin
       tiempo asignado todavia simplemente no suma nada -- se avisa
       aparte cuantos quedaron sin poder calcular, para no fingir una
       precision que no existe. */
    if (action === 'get-order-time-estimates') {
      const orderIds = Array.isArray(body.orderIds) ? body.orderIds : [];
      if (!orderIds.length) return jsonResponse(400, { error: 'orderIds is required' });

      const [svcRows, timeRows] = await Promise.all([
        fetchAll(ORDER_SERVICES_LIST),
        fetchAll(SERVICE_TIMES_LIST)
      ]);
      const timesBySku = {};
      timeRows.forEach(it => { if (it.fields && it.fields.SKU) timesBySku[String(it.fields.SKU).trim()] = it.fields; });

      const orderIdSet = new Set(orderIds);
      const byOrder = {};
      orderIds.forEach(id => { byOrder[id] = { minutes: 0, missing: 0, serviceCount: 0 }; });

      svcRows.forEach(it => {
        if (!it.fields || !orderIdSet.has(it.fields.OrderID)) return;
        const oid = it.fields.OrderID;
        byOrder[oid].serviceCount++;
        const sku = String(it.fields.SubOption || '').trim();
        const t = timesBySku[sku];
        if (!t) { byOrder[oid].missing++; return; }
        const level = String(it.fields.Level || '').trim();
        let minutes = t.Level1Minutes;
        if (level === 'Level 2' && t.Level2Minutes != null) minutes = t.Level2Minutes;
        if (level === 'Level 3' && t.Level3Minutes != null) minutes = t.Level3Minutes;
        if (minutes == null) { byOrder[oid].missing++; return; }
        byOrder[oid].minutes += Number(minutes) || 0;
      });

      return jsonResponse(200, { estimates: byOrder });
    }

    if (action === 'list-service-times') {
      const [catalog, times] = await Promise.all([
        fetchAll(SERVICES_CATALOG_LIST),
        fetchAll(SERVICE_TIMES_LIST)
      ]);
      const timesBySku = {};
      times.forEach(it => { if (it.fields && it.fields.SKU) timesBySku[String(it.fields.SKU).trim()] = it; });

      const services = catalog.filter(it => it.fields && it.fields.SKU).map(it => {
        const f = it.fields;
        const sku = String(f.SKU).trim();
        const t = timesBySku[sku];
        return {
          sku,
          serviceName: f.ServiceName || '',
          division: f.Division || '',
          propertyType: f.PropertyType || '',
          level1: t && t.fields.Level1Minutes != null ? Number(t.fields.Level1Minutes) : null,
          level2: t && t.fields.Level2Minutes != null ? Number(t.fields.Level2Minutes) : null,
          level3: t && t.fields.Level3Minutes != null ? Number(t.fields.Level3Minutes) : null
        };
      }).sort((a, b) => (a.division + a.serviceName).localeCompare(b.division + b.serviceName));

      return jsonResponse(200, { services });
    }

    if (action === 'save-service-time') {
      const sku = String(body.sku || '').trim();
      const serviceName = String(body.serviceName || '').trim();
      const division = String(body.division || '').trim();
      if (!sku) return jsonResponse(400, { error: 'sku is required' });

      const times = await fetchAll(SERVICE_TIMES_LIST);
      const existing = times.find(it => it.fields && String(it.fields.SKU || '').trim() === sku);

      const fields = {
        Title: sku,
        SKU: sku,
        ServiceName: serviceName,
        Division: division,
        Level1Minutes: body.level1 !== undefined && body.level1 !== '' ? Number(body.level1) : null,
        Level2Minutes: body.level2 !== undefined && body.level2 !== '' ? Number(body.level2) : null,
        Level3Minutes: body.level3 !== undefined && body.level3 !== '' ? Number(body.level3) : null
      };

      if (existing) {
        await updateListItemByItemId(SERVICE_TIMES_LIST, existing.id, fields);
      } else {
        await createListItem(SERVICE_TIMES_LIST, fields);
      }
      return jsonResponse(200, { success: true });
    }

    /* Rellena con numeros de PRUEBA coherentes (no reales) cualquier
       servicio del catalogo que todavia no tenga tiempo asignado --
       nunca pisa uno que ya se haya puesto de verdad. Sirve para ver
       el calculo de duracion funcionando mientras se miden los
       tiempos reales; se debe sobreescribir cuando lleguen. */
    if (action === 'seed-placeholder-service-times') {
      const [catalog, times] = await Promise.all([
        fetchAll(SERVICES_CATALOG_LIST),
        fetchAll(SERVICE_TIMES_LIST)
      ]);
      const skusWithTime = new Set(times.filter(it => it.fields && it.fields.SKU).map(it => String(it.fields.SKU).trim()));

      let seeded = 0;
      const tasks = [];
      catalog.filter(it => it.fields && it.fields.SKU && !skusWithTime.has(String(it.fields.SKU).trim())).forEach(it => {
        const f = it.fields;
        const sku = String(f.SKU).trim();
        const isJan = String(f.Division || '') === 'Janitorial';
        const level1 = isJan ? 30 : 45;
        const level2 = isJan ? Math.round(level1 * 1.35) : null;
        const level3 = isJan ? Math.round(level2 * 1.20) : null;
        tasks.push(createListItem(SERVICE_TIMES_LIST, {
          Title: sku, SKU: sku, ServiceName: f.ServiceName || '', Division: f.Division || '',
          Level1Minutes: level1, Level2Minutes: level2, Level3Minutes: level3
        }));
        seeded++;
      });
      await Promise.all(tasks);
      return jsonResponse(200, { success: true, seeded });
    }

    if (action === 'list-staff') {
      const rows = await fetchAll(STAFF_LIST);
      const staff = rows.filter(it => it.fields).map(it => ({
        id:    it.id,
        Email: it.fields.Email || '',
        Role:  it.fields.Role || ''
      }));
      return jsonResponse(200, { staff });
    }

    if (action === 'save-staff') {
      const s = body.staff || {};
      if (!s.Email || !s.Role) return jsonResponse(400, { error: 'Email and Role are required.' });
      if (['Staff', 'Director', 'Developer'].indexOf(s.Role) === -1) {
        return jsonResponse(400, { error: 'Role must be Staff, Director or Developer.' });
      }
      const fields = { Title: s.Email, Email: s.Email, Role: s.Role };
      if (s.id) {
        await updateListItemByItemId(STAFF_LIST, s.id, fields);
        return jsonResponse(200, { success: true, id: s.id });
      }
      const created = await createListItem(STAFF_LIST, fields);
      return jsonResponse(200, { success: true, id: created.id });
    }

    if (action === 'delete-staff') {
      if (!body.id) return jsonResponse(400, { error: 'id is required' });
      await deleteListItem(STAFF_LIST, body.id);
      return jsonResponse(200, { success: true });
    }

    /* Backfill de coordenadas para los Buildings que ya existian antes
       de que Latitude/Longitude existieran como columnas. Se procesa
       de a poco (8 por llamada) porque Nominatim pide 1 peticion por
       segundo -- con muchos edificios pendientes, hacerlo todo de un
       jalon se pasaria del limite de tiempo de la funcion. El
       frontend llama esto en bucle hasta que 'remaining' llegue a 0. */
    /* Geocodificar UNA direccion al momento -- para el buscador de
       clientes en Routing, cuando el cliente no tiene ningun edificio
       guardado con coordenadas ya resueltas (o usa solo su direccion
       principal, que nunca pasa por el backfill de ClientAddresses). */
    if (action === 'geocode-one-address') {
      const geo = await geocodeAddress(body.address, body.city, body.zip);
      return jsonResponse(200, { geo });
    }

    if (action === 'geocode-buildings-backfill') {
      const rows = await fetchAll(CLIENT_ADDRESSES_LIST);
      const missing = rows.filter(it => it.fields && it.fields.Address &&
        (it.fields.Latitude === undefined || it.fields.Latitude === null || it.fields.Latitude === '') );
      const batch = missing.slice(0, 8);

      let geocoded = 0;
      const failed = [];
      for (const it of batch) {
        const f = it.fields;
        const geo = await geocodeAddress(f.Address, f.City, f.Zip);
        if (geo) {
          await updateListItemByItemId(CLIENT_ADDRESSES_LIST, it.id, { Latitude: geo.lat, Longitude: geo.lon });
          geocoded++;
        } else {
          failed.push(f.Label || f.Address || it.id);
        }
        await new Promise(r => setTimeout(r, 1100));
      }

      return jsonResponse(200, {
        processed: batch.length, geocoded, failed,
        remaining: Math.max(missing.length - batch.length, 0)
      });
    }

    /* ============================================================
       RECURRING SERVICES -- trabajos fijos de Janitorial que se
       repiten cada semana. Viven separado de Orders por completo,
       nunca generan una Orden real ni pasan por Approvals (decidido
       explicitamente). Soportan 1 o varias personas por contrato,
       cada una cubriendo una parte de las horas totales.
    ============================================================ */

    if (action === 'save-recurring-service') {
      const { recurringServiceId, clientId, buildingNumber, division, servicesJson, daysOfWeek, time, totalHours, expirationDate, assignments } = body;
      if (!clientId) return jsonResponse(400, { error: 'clientId is required' });
      if (!daysOfWeek) return jsonResponse(400, { error: 'daysOfWeek is required' });
      if (!time) return jsonResponse(400, { error: 'time is required' });
      if (!Array.isArray(assignments) || !assignments.length) return jsonResponse(400, { error: 'At least one assignment is required' });

      const fields = {
        Title: clientId,
        ClientID: clientId,
        BuildingNumber: buildingNumber || '',
        Division: division || 'Janitorial',
        ServicesJSON: servicesJson || '',
        DaysOfWeek: daysOfWeek,
        Time: time,
        TotalHours: Number(totalHours) || 0,
        Active: true
      };
      /* Solo se toca si de verdad se mando -- si no, un simple "Save
         Change" de reasignar empleado (que reusa este mismo endpoint,
         mandando expirationDate en blanco) no debe borrar la fecha
         que ya estaba guardada. */
      if (expirationDate !== undefined) fields.ExpirationDate = expirationDate || null;

      let serviceId = recurringServiceId;
      if (serviceId) {
        await updateListItemByItemId(RECURRING_SERVICES_LIST, serviceId, fields);
        /* Se reemplazan las asignaciones viejas de este contrato por
           las nuevas -- mas simple que tratar de calcular cuales
           agregar/quitar/editar una por una. */
        const existingAssignments = await fetchAll(RECURRING_ASSIGNMENTS_LIST);
        const toDelete = existingAssignments.filter(it => it.fields && String(it.fields.RecurringServiceID) === String(serviceId));
        await Promise.all(toDelete.map(it => deleteListItem(RECURRING_ASSIGNMENTS_LIST, it.id)));
      } else {
        const created = await createListItem(RECURRING_SERVICES_LIST, fields);
        serviceId = created.id;
      }

      await Promise.all(assignments.map(a => createListItem(RECURRING_ASSIGNMENTS_LIST, {
        Title: serviceId + '-' + a.payrollNumber,
        RecurringServiceID: String(serviceId),
        PayrollNumber: String(a.payrollNumber).trim(),
        HoursAllocated: Number(a.hoursAllocated) || 0
      })));

      return jsonResponse(200, { success: true, recurringServiceId: serviceId });
    }

    if (action === 'list-recurring-services') {
      const [services, assignments, employees] = await Promise.all([
        fetchAll(RECURRING_SERVICES_LIST),
        fetchAll(RECURRING_ASSIGNMENTS_LIST),
        fetchAll(FIELD_EMPLOYEES_LIST)
      ]);

      const nameByPayroll = {};
      employees.forEach(it => {
        if (!it.fields || !it.fields.PayrollNumber) return;
        nameByPayroll[String(it.fields.PayrollNumber).trim()] =
          (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).trim();
      });

      const list = services.filter(it => it.fields).map(it => {
        const f = it.fields;
        const myAssignments = assignments
          .filter(a => a.fields && String(a.fields.RecurringServiceID) === String(it.id))
          .map(a => ({
            payrollNumber: a.fields.PayrollNumber,
            name: nameByPayroll[String(a.fields.PayrollNumber).trim()] || a.fields.PayrollNumber,
            hoursAllocated: Number(a.fields.HoursAllocated) || 0
          }));
        return {
          id: it.id,
          clientId: f.ClientID || '',
          buildingNumber: f.BuildingNumber || '',
          division: f.Division || '',
          servicesJson: f.ServicesJSON || '',
          daysOfWeek: f.DaysOfWeek || '',
          time: f.Time || '',
          totalHours: Number(f.TotalHours) || 0,
          expirationDate: f.ExpirationDate || '',
          active: truthy(f.Active),
          assignments: myAssignments
        };
      });

      return jsonResponse(200, { services: list });
    }

    if (action === 'toggle-recurring-active') {
      const { recurringServiceId, active } = body;
      if (!recurringServiceId) return jsonResponse(400, { error: 'recurringServiceId is required' });
      await updateListItemByItemId(RECURRING_SERVICES_LIST, recurringServiceId, { Active: !!active });
      return jsonResponse(200, { success: true });
    }

    /* Vista combinada por empleado para el tab "Assigned": Recurring +
       Scheduling normal, en un solo lugar. Solo trae OrderID/fecha del
       lado de Scheduling -- el frontend cruza eso contra los datos de
       Orders que ya carga aparte (mismo patron que ya usa Calendar). */
    if (action === 'get-assigned-overview') {
      const [employees, recurringServices, recurringAssignments, scheduling] = await Promise.all([
        fetchAll(FIELD_EMPLOYEES_LIST),
        fetchAll(RECURRING_SERVICES_LIST),
        fetchAll(RECURRING_ASSIGNMENTS_LIST),
        fetchAll(SCHEDULING_LIST)
      ]);

      const serviceById = {};
      recurringServices.forEach(it => { if (it.fields) serviceById[it.id] = it.fields; });

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const overview = employees
        .filter(it => it.fields && truthy(it.fields.Active) && String(it.fields.PayrollNumber || '').trim() &&
          (truthy(it.fields.Janitorial) || truthy(it.fields.Renovations) || truthy(it.fields.Exteriors)))
        .map(it => {
          const f = it.fields;
          const payrollNumber = String(f.PayrollNumber).trim();
          const name = (String(f.FirstName || '').trim() + ' ' + String(f.LastName || '').trim()).trim();

          const myRecurring = recurringAssignments
            .filter(a => a.fields && String(a.fields.PayrollNumber || '').trim() === payrollNumber &&
              a.fields.RecurringServiceID && serviceById[a.fields.RecurringServiceID] &&
              truthy(serviceById[a.fields.RecurringServiceID].Active))
            .map(a => {
              const svc = serviceById[a.fields.RecurringServiceID];
              return {
                recurringServiceId: a.fields.RecurringServiceID,
                clientId: svc.ClientID || '',
                buildingNumber: svc.BuildingNumber || '',
                daysOfWeek: svc.DaysOfWeek || '',
                time: svc.Time || '',
                hoursAllocated: Number(a.fields.HoursAllocated) || 0
              };
            });

          const myOrders = scheduling
            .filter(s => s.fields && String(s.fields.PayrollNumber || '').trim() === payrollNumber &&
              !isNaN(new Date(s.fields.AssignedDate)) && new Date(s.fields.AssignedDate) >= today)
            .map(s => ({ orderId: s.fields.OrderID, assignedDate: s.fields.AssignedDate }))
            .sort((a, b) => String(a.assignedDate).localeCompare(String(b.assignedDate)));

          return {
            payrollNumber, name,
            janitorial: truthy(f.Janitorial), renovations: truthy(f.Renovations), exteriors: truthy(f.Exteriors),
            recurring: myRecurring, orders: myOrders
          };
        });

      return jsonResponse(200, { employees: overview });
    }

    /* ============================================================
       DEBUG -- boton temporal para pruebas, borrar despues de usarlo.
       Borra TODO lo de Orders/Scheduling/Recurring (nunca Clients ni
       Services, confirmado explicitamente). Requiere password exacta
       ademas de rol Developer -- doble candado para algo tan
       destructivo e irreversible.
    ============================================================ */
    if (action === 'wipe-test-data') {
      if (!isDeveloper) return jsonResponse(403, { error: 'Developer only.' });
      if (String(body.password || '') !== 'BorraTodoYnoDejesNada') {
        return jsonResponse(403, { error: 'Incorrect password. Nothing was deleted.' });
      }

      const listsToWipe = [
        ORDERS_LIST, ORDER_SERVICES_LIST, ORDER_HISTORY_LIST, DRAFTS_LIST,
        FIELD_EMPLOYEES_LIST, SCHEDULING_LIST, WEEKLY_HOURS_LIST, REPORT_UPLOADS_LIST,
        RECURRING_SERVICES_LIST, RECURRING_ASSIGNMENTS_LIST, RECURRING_LOG_LIST,
        TECHS_LIST, ORDER_ASSIGNMENTS_LIST
        /* Staff y Settings SIEMPRE excluidas a proposito -- ahi vive
           quien tiene acceso a este mismo panel (Director/Developer)
           y la contrasena del director. Borrarlas dejaria a todos
           fuera del sistema, sin forma de volver a entrar. */
      ];

      const deleted = {};
      for (const list of listsToWipe) {
        const rows = await fetchAll(list);
        await Promise.all(rows.map(it => deleteListItem(list, it.id)));
        deleted[list] = rows.length;
      }

      return jsonResponse(200, { success: true, deleted });
    }

    /* DEBUG TEMPORAL -- companero de wipe-test-data, pero SOLO
       Clients. Mismo candado (rol Developer + password exacta). */
    if (action === 'wipe-clients-only') {
      if (!isDeveloper) return jsonResponse(403, { error: 'Developer only.' });
      if (String(body.password || '') !== 'BorraTodoYnoDejesNada') {
        return jsonResponse(403, { error: 'Incorrect password. Nothing was deleted.' });
      }

      const rows = await fetchAll(CLIENTS_LIST);
      await Promise.all(rows.map(it => deleteListItem(CLIENTS_LIST, it.id)));

      return jsonResponse(200, { success: true, deleted: rows.length });
    }

    /* ============================================================
       CARGA MASIVA DE CLIENTES -- mas flexible que register-client.js
       (ese exige TODOS los campos; un archivo real de verdad trae
       datos incompletos). Evita duplicados por nombre de negocio,
       nunca actualiza uno que ya existe -- solo crea los que faltan.
    ============================================================ */
    if (action === 'bulk-import-clients') {
      if (!canEditCatalog) return jsonResponse(403, { error: 'Your role cannot import clients.' });
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return jsonResponse(400, { error: 'No rows to process.' });

      const existing = await fetchAll(CLIENTS_LIST);
      const existingNames = new Set(
        existing.map(it => it.fields && String(it.fields.Title || '').trim().toLowerCase()).filter(Boolean)
      );

      let nextNum = existing
        .map(it => parseInt(String((it.fields && it.fields.ClientID) || '').replace('GS-', ''), 10))
        .filter(n => !isNaN(n))
        .reduce((max, n) => Math.max(max, n), 1000) + 1;

      let created = 0;
      const skipped = [];
      for (const r of rows) {
        const businessName = String(r.businessName || '').trim();
        if (!businessName) { skipped.push('(blank name)'); continue; }
        if (existingNames.has(businessName.toLowerCase())) { skipped.push(businessName + ' (already exists)'); continue; }

        const clientId = 'GS-' + nextNum;
        nextNum++;

        await createListItem(CLIENTS_LIST, {
          ClientID: clientId,
          Title: businessName,
          ClientName: r.contactPerson || businessName,
          Address: r.address || '',
          Suite: r.suite || '',
          City: r.city || '',
          Zip: r.zip || '',
          Contact: r.email || '',
          Phone: r.phone || ''
        });
        existingNames.add(businessName.toLowerCase());
        created++;
      }

      return jsonResponse(200, { success: true, created, skipped });
    }

    return jsonResponse(400, { error: 'Unknown action: ' + action });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
