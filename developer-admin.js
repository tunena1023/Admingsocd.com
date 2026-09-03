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
  SERVICES_LIST, STAFF_LIST, SETTINGS_LIST,
  FIELD_EMPLOYEES_LIST, SCHEDULING_LIST, WEEKLY_HOURS_LIST, REPORT_UPLOADS_LIST,
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

    /* ---- Catalogo de servicios: ver (cualquier rol con acceso) ---- */
    if (action === 'list-services') {
      const rows = await fetchAll(SERVICES_LIST);
      const services = rows.filter(it => it.fields).map(it => ({
        id:          it.id,
        Title:       it.fields.Title || '',
        Division:    it.fields.Division || '',
        Category:    it.fields.Category || '',
        ServiceName: it.fields.ServiceName || '',
        SubOption:   it.fields.SubOption || '',
        Description: it.fields.Description || '',
        Active:      it.fields.Active === undefined ? true : truthy(it.fields.Active),
        SortOrder:   Number(it.fields.SortOrder) || 0
      }));
      return jsonResponse(200, { services });
    }

    /* ---- Catalogo: crear/editar/borrar (Director/Developer) ---- */
    if (action === 'save-service') {
      if (!canEditCatalog) return jsonResponse(403, { error: 'Your role cannot edit the service catalog.' });
      const s = body.service || {};
      if (!s.Division || !s.Category || !s.ServiceName || !s.SubOption) {
        return jsonResponse(400, { error: 'Division, Category, ServiceName and SubOption are required.' });
      }
      const fields = {
        Title:       s.ServiceName,
        Division:    s.Division,
        Category:    s.Category,
        ServiceName: s.ServiceName,
        SubOption:   s.SubOption,
        Description: s.Description || '',
        Active:      s.Active !== false,
        SortOrder:   Number(s.SortOrder) || 0
      };
      if (s.id) {
        await updateListItemByItemId(SERVICES_LIST, s.id, fields);
        return jsonResponse(200, { success: true, id: s.id });
      }
      const created = await createListItem(SERVICES_LIST, fields);
      return jsonResponse(200, { success: true, id: created.id });
    }

    if (action === 'delete-service') {
      if (!canEditCatalog) return jsonResponse(403, { error: 'Your role cannot edit the service catalog.' });
      if (!body.id) return jsonResponse(400, { error: 'id is required' });
      await deleteListItem(SERVICES_LIST, body.id);
      return jsonResponse(200, { success: true });
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
      const seenIds = new Set();
      const missingPayroll = [];
      let created = 0, updated = 0, skippedOffice = 0;

      for (const r of rows) {
        const firstName = String(r.firstName || '').trim();
        const lastName = String(r.lastName || '').trim();
        if (!firstName && !lastName) continue;

        const deptCode = parseInt(String(r.departmentCode || '').trim(), 10);
        if (isNaN(deptCode) || deptCode >= 1000) { skippedOffice++; continue; }

        const payrollNumber = String(r.payrollNumber || '').trim();
        const active = String(r.activeStatus || '').trim().toUpperCase() === 'ACTIVE';

        const janitorial  = deptCode >= 100 && deptCode < 200;
        const renovations = deptCode >= 200 && deptCode < 300;
        const exteriors   = deptCode >= 300 && deptCode < 400;

        /* Cruce: primero por PayrollNumber si ya lo teniamos guardado
           (mas confiable), si no por nombre normalizado. */
        let match = null;
        if (payrollNumber) {
          match = existing.find(it => it.fields && String(it.fields.PayrollNumber || '').trim() === payrollNumber);
        }
        if (!match) {
          const wanted = (firstName + ' ' + lastName).toLowerCase();
          match = existing.find(it => it.fields &&
            (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).toLowerCase() === wanted);
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
      }

      /* Quien ya no aparecio en este reporte, se desactiva (no se
         borra) -- si vuelve a aparecer despues, se reactiva solo. */
      let deactivated = 0;
      const toDeactivate = existing.filter(it => it.fields && !seenIds.has(it.id) && truthy(it.fields.Active));
      await Promise.all(toDeactivate.map(it => updateListItemByItemId(FIELD_EMPLOYEES_LIST, it.id, { Active: false })));
      deactivated = toDeactivate.length;

      const summary = created + ' agregados, ' + updated + ' actualizados, ' + deactivated + ' desactivados, ' +
        skippedOffice + ' de oficina ignorados' +
        (missingPayroll.length ? '. Falta Payroll Number: ' + missingPayroll.join(', ') : '');

      await createListItem(REPORT_UPLOADS_LIST, {
        Title: 'Employee Report',
        ReportType: 'Employee Report',
        UploadDate: new Date().toISOString(),
        Summary: summary
      });

      return jsonResponse(200, { success: true, created, updated, deactivated, skippedOffice, missingPayroll });
    }

    /* Hours Report (Average Hours) -> reemplaza WeeklyHours completo.
       Se cruza por nombre contra FieldEmployees para guardar todo con
       PayrollNumber, nunca con el nombre suelto. */
    if (action === 'upload-hours-report') {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return jsonResponse(400, { error: 'No rows to process.' });

      const employees = await fetchAll(FIELD_EMPLOYEES_LIST);
      const byName = {};
      employees.forEach(it => {
        if (!it.fields) return;
        const name = (String(it.fields.FirstName || '').trim() + ' ' + String(it.fields.LastName || '').trim()).trim().toLowerCase();
        if (name && it.fields.PayrollNumber) byName[name] = String(it.fields.PayrollNumber).trim();
      });

      const existingHours = await fetchAll(WEEKLY_HOURS_LIST);
      await Promise.all(existingHours.map(it => deleteListItem(WEEKLY_HOURS_LIST, it.id)));

      let inserted = 0;
      const unmatched = new Set();
      const toCreate = [];

      for (const r of rows) {
        const name = String(r.employeeName || '').trim();
        if (!name) continue;
        const payrollNumber = byName[name.toLowerCase()];
        if (!payrollNumber) { unmatched.add(name); continue; }

        toCreate.push({
          Title: name,
          PayrollNumber: payrollNumber,
          WeekStart: r.weekStart,
          WeekEnd: r.weekEnd,
          TotalWeeklyHours: Number(r.totalHours) || 0
        });
      }

      await Promise.all(toCreate.map(f => createListItem(WEEKLY_HOURS_LIST, f)));
      inserted = toCreate.length;

      const summary = inserted + ' semanas guardadas' +
        (unmatched.size ? '. Sin cruce en el catalogo: ' + Array.from(unmatched).join(', ') : '');

      await createListItem(REPORT_UPLOADS_LIST, {
        Title: 'Hours Report',
        ReportType: 'Hours Report',
        UploadDate: new Date().toISOString(),
        Summary: summary
      });

      return jsonResponse(200, { success: true, inserted, unmatched: Array.from(unmatched) });
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

    return jsonResponse(400, { error: 'Unknown action: ' + action });

  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
};
