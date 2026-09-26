# PLAN-RESPALDOS.md — Proteger toda la información de GSMS

> Plan pedido por el dueño el 26/09/2026 (sesión `claude/brave-hopper-6t1lxt`),
> escrito para que **cualquier sesión lo pueda continuar** si esta se cae.
> Antes de tocar nada: lee **HANDOFF.md** y **WORKFLOW.md** (reglas fijas:
> nada se sube sin "dale", mini antes de cualquier UI, UI en inglés, commits
> que explican el porqué). Al avanzar, **marca las casillas de la sección 7**
> y reescribe HANDOFF.md.

---

## 1. Qué quiere el dueño (sus palabras)

1. "Que los servicios de GSMS y QuickBooks se conecten y si cambian en
   QuickBooks que también cambien en GSMS."
2. "Que todo lo que ya existe no cambie" — las órdenes que ya existen no se
   tocan nunca; las descripciones son "para usos futuros, no para lo que ya pasó".
3. "Un botón de migrar en algún lugar en Developer, y que también tenga forma
   de regresar a lo anterior si algo falla."
4. "Que se guarde un backup automático cada 24 horas, solo si hay cambios, y
   que me deje seleccionar cuál backup quiero usar."
5. "Lo que quiero es que **toda la información esté protegida** de cualquier
   cambio que se haga desde GSMS." — "Lo que quiero es asegurarme de no perder
   info."
6. Quiere poder "meterle mano" a los servicios de QuickBooks y ponerles las
   descripciones que ya están en GSMS, sin riesgo: si las descripciones se van
   a donde no deben, o se modifica mal un cliente (dirección, etc.), que se
   pueda regresar a como estaba.

Correcciones que hizo el dueño (no repetir el error):
- Los **precios ya están en GSMS**: vienen del mismo reporte de QuickBooks
  (`ServicesCatalog.Price` = Level 1) y solo se muestran cuando el cliente tiene
  `ShowPrices`. No proponer "agregar precios".

---

## 2. Estado al escribir esto

### Hecho y en la rama `claude/brave-hopper-6t1lxt` de Admingsocd.com (NO en producción)

Base: `main` en `fb7abd5`. Dos commits encima, **sin subir a `main`**:

- `fea5007` — **Developer › Settings › "Migrate from QuickBooks"**
  - `lib/quickbooks.js`: `listItems()` (todos los Item activos e inactivos,
    `select *` porque si no, `Sku` no viene; quita Type Category/Group).
  - `developer-admin.js`:
    - `catalogDiff(rows, existing, opts)` — la comparación que antes vivía dentro
      de `preview-catalog-import`. El import por archivo la usa igual (probado:
      resultado **idéntico** al código viejo con el catálogo real, modo completo y
      parcial). Con `opts.fromQb`: un Item inactivo en QB se propone apagar y
      nunca se crea; **una descripción de QB vacía o más corta nunca pisa la de
      GSMS** (hoy 37 servicios tienen mejor texto en GSMS) → van a `descKept`;
      `appOnly` = activos en GSMS que QB no tiene (se quedan igual).
    - Acciones: `qb-migrate-preview` (no escribe), `qb-migrate-apply` (vuelve a
      leer QB en el servidor, guarda respaldo, luego escribe; recibe solo
      `reactivateSkus` / `deactivateSkus` marcados).
  - `admin.html`: sección `#qb-migrate-section` (junto a "Import from
    QuickBooks"), funciones `qbMigratePreview`, `renderQbMigratePreview`,
    `confirmQbMigrate`.
- `5e77365` — **Respaldos del catálogo: diario + escoger cuál regresar**
  - `lib/catalog-backup.js` (nuevo): `backupCatalog`, `listBackups`,
    `readBackup`, `differsFrom`, `dailyBackupIfChanged`, `restorePlan`,
    `restoreBackup(name, {dryRun})`. Archivos en
    `Documents/Backups/ServicesCatalog/catalog-<ISO>-<motivo>.json`, motivos
    `before-qb-migrate`, `before-restore`, `daily`.
  - `cron-recurring-orders.js`: además de los recurrentes, corre
    `dailyBackupIfChanged()` en su propio try (si falla uno no afecta al otro).
    Se colgó de este cron para no gastar otro Cron Job de Vercel.
  - `admin.html`: "Backups" con selector; al escoger uno corre un dryRun que
    enseña qué regresaría / qué se apagaría, y solo entonces sale "Restore this
    backup".
  - **Migrate bloqueado fuera de producción:** si `QUICKBOOKS_ENVIRONMENT` no es
    `production` responde 409. test-admin usa el QuickBooks **sandbox** pero el
    **mismo SharePoint real**: correrlo ahí metería artículos de prueba al
    catálogo real.

Mini (admin.html real + API simulada, catálogo real): 
https://claude.ai/artifact/UymUh41KXd4veVpUA2xSvB

Probado (simulación con SharePoint y QuickBooks falsos, datos reales):
Check no escribe; Migrate guarda respaldo → crea 10 que solo están en QB,
actualiza lo cambiado, apaga lo inactivo en QB, no toca las 37 descripciones de
GSMS ni áreas/paquetes; segundo Check = "No changes"; dryRun no escribe;
Restore deja el catálogo idéntico y apaga lo creado; el diario solo guarda si
hubo cambios; nombre de respaldo inventado → 400; sandbox bloqueado. Playwright
a 1280 y 390 px sin errores ni scroll horizontal. **No se ha probado contra el
QuickBooks ni el SharePoint reales.**

Cómo se probó (para repetirlo): script de Node que mete módulos falsos en
`require.cache` **antes** de requerir `developer-admin.js`:
`lib/graph.js` → listas en memoria (`graphFetch` regresa `{value: [...]}` según
`siteListPath`, `createListItem`, `updateListItemByItemId` que borra el campo
cuando llega `null`, `uploadFile`/`listChildren`/`downloadByPath` en un objeto
"drive"); `lib/quickbooks.js` → `isConnected`, `listItems`. Catálogo real: POST
público `https://orders.gsocd.com/api/get-services` (trae `catalog` con SKU,
nombre, descripción). Artículos de QB: conector de Intuit
(`qbo_accounting_get_product_service_list`; no trae SKU, se unió por
tipo+división+nombre). Llamar el handler con
`{httpMethod:'POST', body: JSON.stringify({action, email})}` y un renglón
`Developer` en la lista Staff falsa.

### Ya en producción (26/09/2026)

- Orders `311e84b`: se quitó del código el respaldo escrito del Client Secret de
  Graph (`ordersgsocd.com/lib/graph.js`). Probado en vivo después del deploy.
  **Pendiente del dueño:** poner el secret nuevo en Admin, Tech y Orders
  Preview, y después borrar el viejo en Azure (sigue en el historial de git
  del repo público).

---

## 3. Decisiones ya tomadas (no reabrir sin preguntar)

- Los respaldos se guardan como **archivos JSON** en la biblioteca
  **Documents** del sitio (`Documents/Backups/<Lista>/`), **no en listas
  nuevas** (una lista no aguanta un bloque así: ya pasó con el límite de 255 de
  `Settings.Value`). La app crea las carpetas sola (`uploadFile` →
  `ensureFolder`). Sugerirle al dueño limitar el acceso a la carpeta `Backups`
  (Manage access); la app sigue pudiendo escribir con su permiso de aplicación.
- **Nunca** se guardan en un respaldo: tokens de QuickBooks (`qb_*token*`,
  `prod_qb_*`, `qb_oauth_state`), `DirectorPassword`, la lista
  `TechDeviceTokens` y `PushSubscriptions` completas. Son llaves.
- Las órdenes que ya existen **no cambian** por ningún Migrate/Restore del
  catálogo: cada orden guarda su propia copia (`OrderServices.ServiceName`,
  `SubOption`=SKU, `Level`, `Quantity`) y congela paquetes
  (`Orders.PackageContents`). Ojo, dos cosas que sí se leen en vivo del
  catálogo: el **tooltip** (descripción por SKU) y el **precio** al mandar a
  QuickBooks una orden aún no mandada (`quickbooks-import-estimates.js:121-133`).
  El dueño ya sabe; no cambiar sin que lo pida.
- Regresar **toda una lista** a una fecha solo para listas de **configuración**.
  Para datos **vivos** (clientes, órdenes…) se regresa **un registro a la vez**,
  porque regresar la lista entera borraría lo que clientes y técnicos hicieron
  después.
- Todo Restore guarda **antes** un respaldo de cómo está, para poder deshacer
  el Restore. Lo creado después del respaldo se **apaga**, no se borra (si ya
  se usó un SKU en una orden, sigue existiendo).
- Migrate **solo** en admin.gsocd.com (QuickBooks de producción).

### Decisiones del dueño (26/09/2026, ya contestadas)

1. Retención: **90 días** de respaldos diarios (siempre se queda el más nuevo de
   cada lista y todos los `before-*`).
2. Restore de un **cliente**: **todo junto** — Clients + ClientAddresses +
   ClientContacts + ClientHolidays (y lo demás que cuelgue del ClientID).
3. Restore de una **orden**: **todo junto**, "que parezca que no cambió nada" —
   Orders + OrderServices + ServiceAssignments + Scheduling (y lo demás que
   cuelgue del OrderID). OrderHistory no se borra: se agrega un renglón que
   diga que se restauró.
4. **Nuevo requisito:** "que si se hacen cambios desde la app se reflejen en
   QuickBooks **inmediatamente**, y que eso guarde un backup, y si después algo
   sale mal en QuickBooks poder regresar a antes del cambio que se hizo en
   GSMS." → la FASE 2 cambia (ver sección 5): cada cambio que GSMS manda a
   QuickBooks se registra con cómo estaba antes, y tiene "Undo in QuickBooks".

### Respuestas del dueño a las preguntas a–c (26/09/2026)

- a) **"Los 3"** van a QuickBooks al instante:
  - clientes existentes: cada cambio hecho en GSMS se manda solo (ya no hace
    falta el botón "Update in QuickBooks" con password del director para esto);
  - clientes nuevos: se crean solos en QuickBooks al darse de alta en GSMS
    (registro en Orders o alta en Admin). Esto cambia la decisión del 25/09;
  - descripciones de servicios: se podrán editar en GSMS y se mandan a QB.
- b) "Nadie se va a meter en QuickBooks. Ambos siempre van a ser desde GSMS."
  → para **clientes**, GSMS es la fuente de verdad. Aun así, mandar solo los
  campos cambiados y avisar en el Undo si QB no coincide (cuesta poco y protege).
- c) "Me agrada la idea": **servicios** — la **descripción** se edita en GSMS y
  va a QB; **nombre, precio y SKU** se editan en QB y llegan a GSMS con Migrate
  (Migrate ya protege la descripción de GSMS: nunca la pisa con una más corta;
  con el editor nuevo, Migrate debe **ignorar la descripción de QB** por
  completo, porque ahora la dueña es GSMS).

---

## 4. FASE 1 — Proteger todo lo que GSMS guarda en SharePoint

Objetivo: cualquier cambio hecho desde Admin, Orders o Tech se puede regresar.

### 1.1 Generalizar `lib/catalog-backup.js` → `lib/backup-store.js`

- Mismas ideas, pero para cualquier lista: `snapshotList(listName, rows)`,
  `backupList(listName, reason, by)`, `listBackups(listName)`,
  `readBackup(listName, name)`, `differsFrom`, `pruneOld(listName, days)`.
- Archivo: `Backups/<Lista>/<Lista>-<ISO>-<motivo>.json.gz` (gzip con `zlib`;
  guardar también `count`, `createdAt`, `by`, `reason`, `version`).
- Campos: guardar **todos** los `fields` del renglón menos los de sistema de
  SharePoint (`@odata.etag`, `ContentType`, `Edit`, `_UIVersionString`,
  `Attachments`, `LinkTitle*`, `Modified`, `Created`, `AuthorLookupId`,
  `EditorLookupId`, `FolderChildCount`, `ItemChildCount`, `_ComplianceFlags`…).
  Hacer una lista blanca de exclusión y probarla con un renglón real.
- **Límite de subida:** `uploadFile` en `lib/graph.js` es PUT simple (≤4 MB).
  Si un .gz pasa de 4 MB (Orders/OrderHistory con el tiempo), agregar subida por
  *upload session* de Graph (`/createUploadSession`, trozos de 3.75 MB; mismo
  patrón que `GSDocViewer.upload`, pero del lado del servidor).
- Leer siempre con `lq.fetchAll` (truena si falla). **Nunca** respaldar ni
  comparar contra una lista "vacía" que en realidad no se pudo leer.
- `lib/catalog-backup.js` puede quedarse como está (ya funciona) o pasar a usar
  `backup-store`; si se cambia, repetir sus pruebas.

### 1.2 Qué listas y cómo

| Lista | Tipo | Restore |
|---|---|---|
| ServicesCatalog | configuración | lista completa (ya hecho) |
| ServiceTimes, ClientPackages, ServiceTemplates, Holidays, Staff, RecurringImportMatrix | configuración | lista completa |
| Settings | configuración | lista completa **sin** llaves secretas (sección 3) |
| Clients (+ ClientAddresses, ClientContacts, ClientHolidays) | vivo | por cliente |
| Orders (+ OrderServices, ServiceAssignments, Scheduling) | vivo | por orden |
| RecurringServices (+ RecurringAssignments) | vivo | por contrato |
| Techs (sin `LoginFailCount`/`LoginLockedUntil`), FieldEmployees | vivo | por persona |
| Drafts, WeeklyHours, RecurringLog, ReportUploads, OrderDocuments, TechPhotoLog, PromoCodes, RedeemedPromoCodes, ContactMessages | vivo | por registro |
| OrderHistory, ClientHistory | solo se agregan renglones | solo respaldo (para consulta), sin Restore |
| OrderSeenBy, NotificationLog, IdRecovery | ruido | no se respaldan |
| TechDeviceTokens, PushSubscriptions | llaves | **nunca** |

Los nombres exactos de listas están en `lib/graph.js` (constantes `*_LIST`) de
cada repo. Revisar Orders y Tech por listas que Admin no declara (PromoCodes,
RedeemedPromoCodes, ContactMessages, IdRecovery, NotificationLog).

### 1.3 Respaldo diario automático

- Cron: hoy `vercel.json` tiene un solo cron (`/api/cron-recurring-orders`,
  `0 11 * * *`, 6 am Iowa) y la función tiene `maxDuration: 60`. Respaldar ~25
  listas puede pasar de 60 s cuando crezcan. Opciones (decidir con datos):
  a) **cron nuevo** `/api/cron-backups` a otra hora (revisar el límite de Cron
     Jobs del plan de Vercel con `search_vercel_documentation` antes);
  b) repartir las listas en tandas con un cursor en Settings (`backup_cursor`).
  El endpoint nuevo debe ir en `PUBLIC_SLUGS` de `api/[...slug].js` y validar
  `CRON_SECRET` igual que `cron-recurring-orders.js`. Registrar el slug en el
  mapa `handlers` del router (probarlo con un `require` real del router).
- Solo guardar la lista si **cambió** contra su último respaldo.
- Después: `pruneOld` (retención de la decisión 1).

### 1.4 Respaldo antes de cada acción masiva o peligrosa

Llamar `backupList(...)` (de las listas que toca) **antes** de escribir, y si
el respaldo falla, **no hacer nada** y regresar el error:

| Acción (archivo) | Listas |
|---|---|
| `bulk-import-clients` (developer-admin.js) | Clients, ClientAddresses |
| `bulk-update-clients`, `apply-bulk-office-hours` | Clients |
| `wipe-test-data` | todas las que borra |
| `wipe-clients-only` | Clients, ClientAddresses, ClientContacts, ClientHistory |
| `apply-catalog-import` (reporte por archivo) | ServicesCatalog (usar `catalog-backup`) |
| `split-package-rows` con apply | OrderServices, Orders |
| `import-service-times`, `clear-service-times` | ServiceTimes |
| `quickbooks-clients.js` create/update | Clients (y ver fase 2 para QB) |

### 1.5 Pantalla "Backups" (Developer › Settings)

- Mini primero (admin.html real + API simulada; ver cómo se armó el de Migrate:
  scripts de gsocd-shared inline, MSAL y `fetch('/api/...')` falsos, insertado
  antes del ÚLTIMO `</body>`; en el visor de artifacts `confirm()` regresa
  false, así que el mini lo acepta solo).
- Arriba: por lista, fecha del último respaldo y cuántos hay.
- **Configuración:** selector de respaldo → dryRun (qué regresa / qué se apaga) →
  "Restore this backup" (igual que el catálogo).
- **Vivos:** buscador (ClientID / nombre / OrderID) → lista de fechas en que ese
  registro cambió → escoger una → vista previa campo por campo (viejo → nuevo) →
  "Restore this client/order". Guarda respaldo antes.
- Botón "Back up now" (respaldo manual de todo, motivo `manual`).
- UI en inglés. Revisar a 390 px.

### 1.6 Pruebas

- Mismo tipo de simulación que el catálogo (sección 2): para cada lista,
  respaldo → cambio → dryRun (0 escrituras) → restore → comparación exacta;
  lista vacía por falla de lectura → no respalda; respaldo >4 MB → upload
  session; secretos ausentes del archivo (buscar `token`, `Password` en el JSON).
- `node --check` a todo; `require('./api/[...slug].js')` real.

---

## 5. FASE 2 — QuickBooks

GSMS escribe en QuickBooks: clientes (`quickbooks-clients.js` create/update),
estimates/invoices (`quickbooks-import-estimates.js` crea,
`quickbooks-delete-doc.js` borra) y adjuntos (`quickbooks-attach-photos.js`).
Todo con `lib/quickbooks.js`.

### 2.1 Foto diaria de QuickBooks (solo lectura)

- `listCustomers()` ya existe; `listItems()` ya existe (fase de Migrate).
- Guardar `Backups/QuickBooks/Customers-<ISO>-daily.json.gz` e `Items-…` solo
  si cambiaron. Solo en producción (`QUICKBOOKS_ENVIRONMENT=production`).

### 2.2 GSMS → QuickBooks al instante, con registro y "Undo in QuickBooks"

(Requisito 4 del dueño; respuestas a–c en la sección 3.)

- Un solo lugar por donde pasa **toda** escritura a QuickBooks: p. ej.
  `lib/qb-sync.js` con `pushChange({ entity, id, fields, reason, by })`:
  1. Lee el objeto actual de QuickBooks (Customer/Item) completo.
  2. Guarda el registro **antes** de escribir:
     `Documents/Backups/QuickBooks/changes/<ISO>-<Entity>-<Id>.json` con
     `{ before, sent, by, reason, source (pantalla/endpoint), gsmsRef (ClientID/SKU) }`.
     Si no se pudo guardar, **no se manda nada** y se avisa.
  3. Manda solo los campos que cambiaron (sparse update con `SyncToken`).
  4. Guarda `after` en el mismo registro.
- Engancharlo donde GSMS cambia datos que viven en QuickBooks (según a):
  `admin-update-client.js` (y lo que llama desde Orders: `update-client-profile.js`,
  `save-client-address.js` si la dirección principal cambia),
  `quickbooks-clients.js` (create/update ya existentes), y el editor de
  descripciones si se aprueba (c). Si QuickBooks falla, GSMS igual guarda su
  cambio y la tarjeta del cliente queda "Different in QuickBooks" (ya existe
  esa vista) para reintentar.
- Pantalla (Developer o QuickBooks › "Changes sent"): lista de cambios
  (fecha, quién, cliente/servicio, campos viejo → nuevo) con **"Undo in
  QuickBooks"**: vuelve a mandar los valores de `before` (sparse, `SyncToken`
  actual). Antes de deshacer, compara con lo que QuickBooks tiene hoy: si alguien
  lo cambió después directo en QuickBooks, lo enseña y pide confirmar. El Undo
  también queda registrado (se puede deshacer el Undo).
- Retención: 90 días, igual que el resto.
- Estimates/invoices que se borran desde GSMS (`quickbooks-delete-doc.js`):
  guardar el documento completo antes de borrar
  (`minorversion=75&include=enhancedAllCustomFields`). QuickBooks no recupera el
  mismo número; la copia sirve para recrearlo.
- Esto cambia reglas viejas de HANDOFF sección 5 ("QuickBooks nunca se
  reescribe", "no se crean clientes solos"): **solo con el OK explícito del
  dueño** a las preguntas a–c.

---

## 6. Red extra que el dueño debe prender (recordárselo, no hacerlo por él)

- SharePoint: en cada lista, *List settings › Versioning settings › Create a
  version each time you edit* = **Yes**. Más la papelera (93 días). Así
  Microsoft guarda cada versión aunque todo lo demás falle.
- QuickBooks: *Sales › Products and services › Export* y *Customers › Export*
  antes de editar a mano. QuickBooks también tiene *Audit Log*.

---

## 7. Avance (marcar al terminar cada paso)

- [x] Migrate from QuickBooks + respaldo antes (`fea5007`, rama, sin producción)
- [x] Respaldo diario del catálogo si cambió + selector con dryRun (`5e77365`, rama)
- [x] Quitar el Client Secret escrito en Orders (`311e84b`, producción)
- [ ] Dueño: "dale" para subir `fea5007` + `5e77365` a producción; después probar
      Check QuickBooks en admin.gsocd.com y ver el primer respaldo en
      `Documents/Backups/ServicesCatalog`
- [x] Dueño: decisiones 1–4 (sección 3) — 90 días, cliente todo junto, orden todo junto, GSMS→QB inmediato
- [x] Dueño: preguntas a–c (sección 3) — los 3 al instante; clientes solo desde GSMS; descripción en GSMS, nombre/precio/SKU en QB
- [x] 1.1 `lib/backup-store.js` (misma hora en todas las listas de un respaldo; mapa id viejo→nuevo en `Backups/id-map.json` para contactos/edificios recreados)
- [x] 1.2 listas en `GROUPS` y campos de sistema excluidos (probado con renglones simulados; **falta revisar con un renglón real de SharePoint** que no quede fuera una columna)
- [x] 1.3 respaldo diario: `cron-backups.js`, un cron por grupo en `vercel.json` (07,08,09,10,12 UTC; Vercel permite 100 crons, 1/día en Hobby)
- [x] 1.4 respaldo antes de: bulk-import/update clients, bulk hours, wipe (x2), package fix, service times import/clear, catalog import (`backupBefore` en developer-admin.js). Falta: `quickbooks-clients.js` (va con la fase 2)
- [x] 1.5 pantalla Backups construida (Developer › Settings › Backups: regresar cliente / orden / lista de configuración, con vista previa; estado de cada lista; Back up now). Mini: https://claude.ai/artifact/UymUh41KXd4veVpUA2xSvB (abrir con `#migrate` para Migrate). **Falta el OK del dueño al mini**
- [x] 1.6 pruebas: `node tests/backup-store.sim.js` (27 OK). Falta la prueba contra SharePoint real después del deploy
- [ ] 2.1 foto diaria de QuickBooks
- [x] 2.2 backend GSMS → QuickBooks al instante (`lib/qb-sync.js`): ediciones de cliente en Admin (`admin-update-client.js`), alta (`register-client.js`), botones de QuickBooks › Clients, regreso de cliente desde Backups, descripciones (`save-service-description`, `qb-send-descriptions`); lista de cambios y Undo que regresa QuickBooks **y** GSMS (`qb-changes`, `qb-undo-change`); aviso desde Orders (`qb-sync-client`, llave `QB_SYNC_SECRET`); revisión diaria (`cron-qb-sync`, 13 UTC). Migrate ya no toma la descripción de QB si GSMS tiene una. Pruebas: `node tests/qb-sync.sim.js` (20 OK)
- [ ] 2.2 pantallas: QuickBooks changes + Undo, editar descripción en Service Catalog, "Send to QuickBooks" en Migrate, avisos al guardar cliente
- [ ] 2.2 Orders: llamar `qb-sync-client` al editar perfil / registrarse (rama en ordersgsocd.com) + dueño pone `QB_SYNC_SECRET` en Vercel (Admin y Orders)
- [ ] Dueño: versiones de SharePoint prendidas (sección 6)
