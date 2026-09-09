/* admin-update-client.js — editar datos de un cliente.

   REGLA DEL PROYECTO: nada se sobreescribe sin quedar registrado.
   Antes esta funcion machacaba los datos del cliente sin dejar ningun
   rastro: si alguien borraba el telefono, el valor anterior se perdia
   para siempre. Ahora cada campo modificado genera un renglon en la
   lista ClientHistory con el valor viejo, el nuevo y quien lo cambio.

   Ojo con el mapeo historico de columnas (se conserva tal cual para no
   romper los datos que ya existen):
     Title        <- businessName
     ClientName   <- contactPerson
*/
const {
  CLIENTS_LIST, CLIENT_HISTORY_LIST, CLIENT_ADDRESSES_LIST, CLIENT_CONTACTS_LIST,
  createListItem, updateListItemByItemId,
  graphFetch, siteListPath, geocodeAddress,
  jsonResponse
} = require('./lib/graph');

async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=200';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

async function fetchByField(listName, fieldName, value) {
  const filter = encodeURIComponent(`fields/${fieldName} eq '${value}'`);
  let url = siteListPath(listName) + `?$expand=fields&$top=200&$filter=${filter}`;
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

/* undefined / null / '' cuentan como el mismo "sin valor" */
function sameValue(a, b) {
  return String(a == null ? '' : a) === String(b == null ? '' : b);
}

/* Mismo criterio que ya se usa en admin-update-order.js para columnas Si/No */
function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'Yes';
}

/* Buildings (ClientAddresses) del cliente -- se maneja AQUI, reusando
   este mismo endpoint, porque el repo admin ya esta topado en 12/12
   funciones de Vercel Hobby y no se puede crear una nueva.
   Peticion separada de la de info de negocio: si b.building viene,
   SOLO se procesa eso y se regresa -- no se toca Clients de paso. */
async function handleBuilding(b) {
  const bld = b.building;

  if (bld.action === 'archive' || bld.action === 'unarchive') {
    if (!bld.addressId) return jsonResponse(400, { error: 'addressId is required' });
    await updateListItemByItemId(CLIENT_ADDRESSES_LIST, bld.addressId, { Archived: bld.action === 'archive' });
    return jsonResponse(200, { success: true, addressId: bld.addressId });
  }

  /* action 'save': con addressId edita (patch parcial, solo lo que llego),
     sin addressId crea una fila nueva. */
  if (bld.addressId) {
    const rows = await fetchByField(CLIENT_ADDRESSES_LIST, 'ClientID', b.clientId);
    const item = rows.find(it => it.id === String(bld.addressId));
    if (!item) return jsonResponse(404, { error: 'Building not found.' });

    /* Si viene un contacto nuevo (name+value llenos), se crea primero en
       ClientContacts (compartida entre primaria y buildings) y su id
       gana sobre cualquier contactId que haya llegado por separado. */
    let newContactId = null;
    if (bld.newContact && bld.newContact.name && String(bld.newContact.name).trim()
        && bld.newContact.value && String(bld.newContact.value).trim()) {
      const created = await createListItem(CLIENT_CONTACTS_LIST, {
        Title:           bld.newContact.name,
        ClientID:        b.clientId,
        Name:            bld.newContact.name  || '',
        ContactType:     bld.newContact.type  || 'Email',
        Value:           bld.newContact.value || '',
        Archived:        false,
        NotifyRecipient: false
      });
      newContactId = created.id;
    }

    const map = [
      ['Label',          bld.label,          'Title'],
      ['BuildingNumber', bld.buildingNumber],
      ['Address',        bld.address],
      ['Suite',          bld.suite],
      ['City',           bld.city],
      ['Zip',            bld.zip],
      ['ContactId',      newContactId !== null ? newContactId : bld.contactId],
      ['OfficeHours',    bld.officeHours]
    ];
    const patch = {};
    for (const [col, incoming, alsoTitle] of map) {
      if (incoming === undefined) continue;
      patch[col] = incoming || '';
      if (alsoTitle) patch.Title = incoming || '';
    }
    /* Booleanos (horarios de oficina abierta por dia) aparte del map
       generico de arriba -- ese usa "incoming || ''" para texto, lo
       cual convertiria false (dia cerrado) en '' por accidente. */
    const DAY_FIELDS = ['monOpen', 'tueOpen', 'wedOpen', 'thuOpen', 'friOpen', 'satOpen', 'sunOpen'];
    const DAY_COLUMNS = { monOpen: 'MonOpen', tueOpen: 'TueOpen', wedOpen: 'WedOpen', thuOpen: 'ThuOpen', friOpen: 'FriOpen', satOpen: 'SatOpen', sunOpen: 'SunOpen' };
    DAY_FIELDS.forEach(f => { if (bld[f] !== undefined) patch[DAY_COLUMNS[f]] = !!bld[f]; });

    /* Colchon de entrada/salida por edificio -- confirmado con el
       usuario: no todos los edificios son iguales (elevador vs
       escaleras), asi que vive aqui, no como un numero fijo para
       todos. Mismo cuidado que los booleanos de arriba -- "0" es un
       valor valido (aunque raro), "incoming || ''" lo hubiera borrado
       por accidente. */
    if (bld.entryCushionMinutes !== undefined) patch.EntryCushionMinutes = Number(bld.entryCushionMinutes) || 0;
    if (bld.exitCushionMinutes !== undefined) patch.ExitCushionMinutes = Number(bld.exitCushionMinutes) || 0;

    if (patch.Address !== undefined || patch.City !== undefined || patch.Zip !== undefined) {
      const finalAddress = patch.Address !== undefined ? patch.Address : (item.fields.Address || '');
      const finalCity    = patch.City    !== undefined ? patch.City    : (item.fields.City    || '');
      const finalZip     = patch.Zip     !== undefined ? patch.Zip     : (item.fields.Zip      || '');
      const geo = await geocodeAddress(finalAddress, finalCity, finalZip);
      if (geo) { patch.Latitude = geo.lat; patch.Longitude = geo.lon; }
    }

    await updateListItemByItemId(CLIENT_ADDRESSES_LIST, item.id, patch);
    return jsonResponse(200, { success: true, addressId: item.id, contactId: newContactId });
  }

  if (!bld.label || !String(bld.label).trim()) {
    return jsonResponse(400, { error: 'Label is required for a new building.' });
  }

  /* Mismo mecanismo de newContact que ya existe arriba al EDITAR un
     edificio -- antes solo funcionaba ahi, nunca al CREAR uno nuevo,
     por eso un edificio recien creado nunca podia tener telefono. */
  let newContactId = null;
  if (bld.newContact && bld.newContact.name && String(bld.newContact.name).trim()
      && bld.newContact.value && String(bld.newContact.value).trim()) {
    const created = await createListItem(CLIENT_CONTACTS_LIST, {
      Title:           bld.newContact.name,
      ClientID:        b.clientId,
      Name:            bld.newContact.name  || '',
      ContactType:     bld.newContact.type  || 'Email',
      Value:           bld.newContact.value || '',
      Archived:        false,
      NotifyRecipient: false
    });
    newContactId = created.id;
  }

  const geo = await geocodeAddress(bld.address, bld.city, bld.zip);
  const newFields = {
    Title:          bld.label,
    ClientID:       b.clientId,
    Label:          bld.label          || '',
    BuildingNumber: bld.buildingNumber || '',
    Address:        bld.address        || '',
    Suite:          bld.suite          || '',
    City:           bld.city           || '',
    Zip:            bld.zip            || '',
    ContactId:      newContactId || '',
    MonOpen:        !!bld.monOpen,
    TueOpen:        !!bld.tueOpen,
    WedOpen:        !!bld.wedOpen,
    ThuOpen:        !!bld.thuOpen,
    FriOpen:        !!bld.friOpen,
    SatOpen:        !!bld.satOpen,
    SunOpen:        !!bld.sunOpen,
    OfficeHours:    bld.officeHours    || '',
    EntryCushionMinutes: Number(bld.entryCushionMinutes) || 0,
    ExitCushionMinutes:  Number(bld.exitCushionMinutes)  || 0,
    Archived:       false
  };
  if (geo) { newFields.Latitude = geo.lat; newFields.Longitude = geo.lon; }
  const result = await createListItem(CLIENT_ADDRESSES_LIST, newFields);
  return jsonResponse(200, { success: true, addressId: result.id, contactId: newContactId });
}

/* Archivar/desarchivar un contacto puntual (la "X" junto a cada uno).
   OJO: el nombre del campo es 'contactAction', a proposito distinto de
   'contact' (que ya es el email principal en el body) y de 'contacts'
   (el arreglo completo que se manda al guardar primaria/notifications)
   -- el bug anterior fue justo por reusar un nombre que ya significaba
   otra cosa. */
async function handleContactAction(b) {
  const ca = b.contactAction;
  if (!ca.contactId) return jsonResponse(400, { error: 'contactId is required' });
  if (ca.action !== 'archive' && ca.action !== 'unarchive') {
    return jsonResponse(400, { error: 'Unknown contact action.' });
  }
  await updateListItemByItemId(CLIENT_CONTACTS_LIST, ca.contactId, { Archived: ca.action === 'archive' });
  return jsonResponse(200, { success: true, contactId: ca.contactId });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    if (!b.clientId) return jsonResponse(400, { error: 'clientId is required' });

    if (b.building)      return await handleBuilding(b);
    if (b.contactAction) return await handleContactAction(b);

    const actor = (b.changedBy && String(b.changedBy).trim()) || 'Admin';

    const rows = await fetchAll(CLIENTS_LIST);
    const item = rows.find(it =>
      it.fields && String(it.fields.ClientID||'').trim().toLowerCase() === String(b.clientId).trim().toLowerCase()
    );
    if (!item) return jsonResponse(404, { error: 'Client not found.' });

    const f = item.fields;

    /* [columna, valor entrante, etiqueta que ve el humano] */
    const map = [
      ['Title',        b.businessName,  'Business Name'],
      ['ClientName',   b.contactPerson, 'Contact Person'],
      ['Contact',      b.contact,       'Contact Email'],
      ['Phone',        b.phone,         'Phone'],
      ['Address',      b.address,       'Address'],
      ['Suite',        b.suite,         'Suite'],
      ['City',         b.city,          'City'],
      ['Zip',          b.zip,           'Zip']
    ];

    const patch = {};
    const changes = [];

    for (const [col, incoming, label] of map) {
      const oldValue = f[col] == null ? '' : String(f[col]);
      /* Solo se toca lo que realmente llego en la peticion */
      if (incoming === undefined) { patch[col] = oldValue; continue; }
      const next = incoming == null ? '' : String(incoming);
      patch[col] = next;
      if (!sameValue(oldValue, next)) {
        changes.push({ label, old: oldValue, next });
      }
    }

    /* [columna, valor entrante, etiqueta] — preferencias de notificacion.
       Solo admin las toca, el cliente no tiene acceso a esto. Maestro
       (NotificationsEnabled) corta todo; las tres de abajo son
       independientes entre si y solo importan si el maestro esta en Si. */
    const boolMap = [
      ['NotificationsEnabled', b.notificationsEnabled, 'Notifications: Master'],
      ['NotifyConfirmations',  b.notifyConfirmations,  'Notifications: Confirmations'],
      ['NotifyChanges',        b.notifyChanges,        'Notifications: Changes'],
      ['NotifyUpdates',        b.notifyUpdates,        'Notifications: Updates']
    ];

    for (const [col, incoming, label] of boolMap) {
      /* Columna nueva: si todavia no existe en SharePoint, f[col] es undefined.
         Default = Si (true), para no silenciar clientes existentes sin querer. */
      const oldValue = f[col] == null ? true : truthy(f[col]);
      if (incoming === undefined) { patch[col] = oldValue; continue; }
      const next = truthy(incoming);
      patch[col] = next;
      if (oldValue !== next) {
        changes.push({ label, old: oldValue ? 'Yes' : 'No', next: next ? 'Yes' : 'No' });
      }
    }

    /* Horarios de oficina -- default Sin marcar (false) si la columna
       no existe todavia o nunca se configuro, IGUAL que ya hace
       buildingHoursRowHtml para los edificios secundarios (no "Si"
       como las preferencias de notificacion de arriba). */
    const dayBoolMap = [
      ['MonOpen', b.monOpen, 'Office Hours: Mon'],
      ['TueOpen', b.tueOpen, 'Office Hours: Tue'],
      ['WedOpen', b.wedOpen, 'Office Hours: Wed'],
      ['ThuOpen', b.thuOpen, 'Office Hours: Thu'],
      ['FriOpen', b.friOpen, 'Office Hours: Fri'],
      ['SatOpen', b.satOpen, 'Office Hours: Sat'],
      ['SunOpen', b.sunOpen, 'Office Hours: Sun']
    ];
    for (const [col, incoming, label] of dayBoolMap) {
      const oldValue = truthy(f[col]);
      if (incoming === undefined) { patch[col] = oldValue; continue; }
      const next = truthy(incoming);
      patch[col] = next;
      if (oldValue !== next) {
        changes.push({ label, old: oldValue ? 'Yes' : 'No', next: next ? 'Yes' : 'No' });
      }
    }
    if (b.officeHours !== undefined) {
      const oldValue = f.OfficeHours || '';
      const next = b.officeHours || '';
      patch.OfficeHours = next;
      if (!sameValue(oldValue, next)) changes.push({ label: 'Office Hours: Shared', old: oldValue, next });
    }
    if (b.entryCushionMinutes !== undefined) {
      const oldValue = Number(f.EntryCushionMinutes) || 0;
      const next = Number(b.entryCushionMinutes) || 0;
      patch.EntryCushionMinutes = next;
      if (oldValue !== next) changes.push({ label: 'Entry Cushion (min)', old: String(oldValue), next: String(next) });
    }
    if (b.exitCushionMinutes !== undefined) {
      const oldValue = Number(f.ExitCushionMinutes) || 0;
      const next = Number(b.exitCushionMinutes) || 0;
      patch.ExitCushionMinutes = next;
      if (oldValue !== next) changes.push({ label: 'Exit Cushion (min)', old: String(oldValue), next: String(next) });
    }

    /* Las 8 columnas de horarios son NUEVAS en Clients (recien
       agregadas por el usuario, o pendientes de agregar) -- si
       todavia no existen, Graph rechaza el PATCH COMPLETO. Mismo
       respaldo ya usado para Technician/CompletedDate en
       admin-update-order.js: reintentar sin esos campos, para que
       el resto de la edicion (nombre, telefono, direccion...) nunca
       se bloquee por columnas que el usuario aun no crea. */
    const HOURS_COLUMNS = ['MonOpen','TueOpen','WedOpen','ThuOpen','FriOpen','SatOpen','SunOpen','OfficeHours','EntryCushionMinutes','ExitCushionMinutes'];
    try {
      await updateListItemByItemId(CLIENTS_LIST, item.id, patch);
    } catch (patchErr) {
      const fallbackPatch = Object.assign({}, patch);
      let hadHoursField = false;
      HOURS_COLUMNS.forEach(col => { if (col in fallbackPatch) { delete fallbackPatch[col]; hadHoursField = true; } });
      if (!hadHoursField) throw patchErr;
      await updateListItemByItemId(CLIENTS_LIST, item.id, fallbackPatch);
      changes.splice(0, changes.length, ...changes.filter(c => !String(c.label).startsWith('Office Hours')));
    }

    /* Contactos: llegan como un arreglo completo (existentes + filas nuevas
       que se hayan llenado), cada uno con isRecipient marcando si ese es
       el que debe recibir notificaciones. Se manda el arreglo COMPLETO
       (no solo el que cambio) para poder desmarcar al anterior y marcar
       al nuevo en la misma pasada. Filas nuevas sin nombre/valor llenos
       se ignoran (fila vacia que el usuario no llego a usar). */
    let contactsProcessed = 0;
    if (Array.isArray(b.contacts)) {
      for (const entry of b.contacts) {
        if (entry.contactId) {
          await updateListItemByItemId(CLIENT_CONTACTS_LIST, entry.contactId, {
            NotifyRecipient: !!entry.isRecipient
          });
          contactsProcessed++;
        } else if (entry.name && String(entry.name).trim() && entry.value && String(entry.value).trim()) {
          await createListItem(CLIENT_CONTACTS_LIST, {
            Title:           entry.name,
            ClientID:        b.clientId,
            Name:            entry.name           || '',
            ContactType:     entry.type            || 'Email',
            Value:           entry.value           || '',
            Archived:        false,
            NotifyRecipient: !!entry.isRecipient
          });
          contactsProcessed++;
        }
      }
    }

    /* El registro se escribe despues del guardado. Si ClientHistory no
       existiera todavia, el cambio ya quedo hecho: se avisa en la respuesta
       en vez de fingir que todo salio bien. */
    let logged = 0;
    let logError = null;
    for (const ch of changes) {
      try {
        await createListItem(CLIENT_HISTORY_LIST, {
          Title:        b.clientId + ' - ' + ch.label,
          ClientID:     b.clientId,
          ChangeType:   'Client Data Updated',
          ChangedBy:    actor,
          ChangeDate:   new Date().toISOString(),
          FieldChanged: ch.label,
          OldValue:     ch.old,
          NewValue:     ch.next,
          Notes:        (b.notes && String(b.notes).trim()) || ''
        });
        logged++;
      } catch (e) {
        logError = e.message;
      }
    }

    return jsonResponse(200, {
      success: true,
      changesLogged: logged,
      changesDetected: changes.length,
      contactsProcessed,
      historyError: logError
    });
  } catch(e) {
    return jsonResponse(500, { error: e.message });
  }
};
