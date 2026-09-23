# NOTES.md — Historial y estado del proyecto (Admingsocd.com)

Reglas de proceso -> ver WORKFLOW.md (léelo primero). Aquí vive el historial
de features, bugs, decisiones y pendientes, en orden cronológico.

**Si este archivo supera ~600 líneas**, es hora de resumir entradas viejas
(más de ~3 semanas sin tocarse) a un párrafo o moverlas a NOTES_ARCHIVE.md,
en vez de seguir apilando sin límite.

## SUBIDO Y DESPLEGADO (confirmado 13/09/2026): rediseño de "+ Add a Unit" en Admin

Cambios en `admin.html` (función `addUnitFormHtml`, `submitAddBatchUnitAdmin`,
nuevas `addUnitOfficeNeedState`/`setAddUnitOfficeNeed`, más CSS
`.addunit-office-card`/`.addunit-dates-grid`) y en `submit-order.js` (bloque
`AddUnitToBatch` ahora acepta y guarda `NeedsOfficeAccess`/`OfficeNeedNotes`,
que antes no se persistían ahí para unidades agregadas a un PO existente).
Aprobado en un mini interactivo tras varias iteraciones de ajuste visual.

Resultado: mismos 6 campos y mismas acciones "Add Unit" (verde)/"Cancel" de
siempre — solo con el look premium `gs-ofp-*` (ya cargado en la página,
mismo componente que usa Create Order) en vez de inputs genéricos. Se agregó
la tarjeta "Need anything from the office?" — versión MÁS DELGADA que la de
Create Order (padding/fuente/íconos más chicos, aprobado así en el mini),
con el toggle conectado de verdad.

Confirmado en el repo real (13/09/2026): `admin.html` en `main` ya tiene
`addUnitFormHtml`/`submitAddBatchUnitAdmin` con el look `gs-ofp-*`.

**RESUELTO (confirmado 13/09/2026):** el mismo rediseño SÍ se portó a
Orders — `ordersgsocd.com/customer.html` en `main` ya usa
`addUnitFormHtml`/`toggleAddUnitForm`/`submitAddBatchUnit` con look
`gs-ofp-*` (vía `GSOrderFormPremium.unitDetailPanelHtml`), sin rastro del
modal viejo `addunit-dialog`. Ver el NOTES.md de `ordersgsocd.com` para el
detalle completo (ahí el flujo de carga de buildings terminó siendo
distinto: Building # es texto libre, no un select).

## SUBIDO Y DESPLEGADO (14/09/2026): diff de servicios en Active > Edit y Approvals > Update

A petición del dueño: mismo look que el "Request a Change" nuevo del
cliente (lista + selector + diff, `gsocd-shared/service-change-panel`),
pero aquí la oficina sigue aplicando DIRECTO con Save/Update — sin
Pending Review y sin nota obligatoria por quitado (el diff es
informativo). Se usa `GSServiceChangePanel.diffHtml()`/`namesOf()`
sobre el picker que ya existía:
- Active > Edit: caja de diff entre el picker y "Selected for this
  order", contra `adminSvcOriginal_` (snapshot que ya existía para
  Request Confirmation).
- Approvals > Update: nuevo snapshot `apprSvcOriginal_` al pintar la
  tarjeta, misma caja en el editor.
La lista (nombre + nota "not completed" + cámara) y el tiempo estimado
no cambian. Ojo al probar: el picker de Admin usa
`filterMode:'selected-plus-search'` — un servicio nuevo se agrega
BUSCÁNDOLO, no aparece su categoría sola.

**Pendiente relacionado:** el cliente ahora puede pedir agregar/quitar
servicios en una orden normal (Processing). Eso llega al historial como
`Services Change Requested` / `Requested Services`
(`NewValue = {services, removedNotes}`), igual que las fechas llegan como
`Reschedule Requested`. Falta que Review lo muestre y que
`admin-approve-order` lo aplique al aprobar (hoy solo se guarda).
Las de Recurring (`Source: Client`) sí se ven ya en Review, badge
"Recurring Change", con ➕/➖ — `renderRecurringChangeReview()` ya lo
manejaba.

## SUBIDO Y DESPLEGADO (13/09/2026): Preview de foto al pasar el mouse (1s, tamaño máximo, sin clic)

Aprobado con mini antes de tocar código real. Reemplaza el viejo
`.order-photo-thumb:hover { transform: scale(2.4) }` por un preview tipo
lightbox: al quedarse 1 segundo con el mouse sobre una miniatura de foto,
esta crece al tamaño máximo posible en pantalla — sin necesidad de clic.
Se cierra en cuanto el mouse SALE de la miniatura (no por micro-
movimientos naturales mientras sigue encima de la misma foto — decisión
explícita confirmada con el mini, se sentiría roto exigir inmovilidad
total).

Implementado con **delegación de eventos** (`mouseover`/`mouseout` en
`document`, revisando `closest('.order-photo-thumb')`) en vez de
`addEventListener` directo sobre cada miniatura — necesario porque estas
se insertan y reinsertan constantemente vía `innerHTML` cada vez que se
refresca cualquier tab. `setupOrderPhotoHoverPreview()` se conecta una
sola vez, en el punto que corre sin importar el camino de autenticación
(stored session o MSAL fresco).

**A petición explícita del dueño ("en todos los tabs... las fotos siempre
deben ser visibles desde cualquier orden")**, se extendió a TODOS los
lugares que muestran una orden real con `OrderID` y podrían tener fotos —
se mapeó cada uno con `orderPhotoStripHtml()`:
- Approvals (2 tipos de tarjeta), Active, History — ya lo tenían.
- **Agregados en esta sesión:** Schedule (cola por agendar +
  "Already scheduled, waiting for Approve") y Review (sección "Materials
  Ready" + asignaciones huérfanas por técnico desactivado).
- Dejado FUERA a propósito: la sección "Recurring Change" de Review — son
  cambios a un contrato recurrente, no órdenes individuales con
  `OrderID`/fotos propias.

También se extendió el MISMO preview a Gallery (`.gs-gal-ph`, componente
compartido `gallery-groups.js`) — a diferencia de `.order-photo-thumb`
(un `<img>` directo), `.gs-gal-ph` es un `<div>` que envuelve un `<img>`
adentro, y también se usa para videos (`.gs-gal-ph.video`) — los videos
se excluyen del hover-preview (un video pausado agrandado no da el mismo
vistazo rápido que una foto). El clic en Gallery sigue abriendo el
lightbox normal con navegación prev/next, sin cambios ahí.

**RESUELTO (13/09/2026):** portado después a `ordersgsocd.com`
(Processing/History + Gallery nueva ahí — ver su NOTES.md para el detalle
completo, incluyendo una lección real sobre por qué Gallery ahí tuvo que
construirse como panel interno de `customer.html` y no como página
separada). Y el plan de moverlo a `gsocd-shared` YA se hizo el mismo
día: nuevo componente `photo-hover-preview` (tag `v1.26.0`, ver NOTES.md
de `gsocd-shared` para el detalle completo). Este archivo (`admin.html`)
ya usa `GSPhotoHoverPreview.setup()`/`GSPhotoHoverPreview.stripHtml()` en
vez de su propia copia local — el CSS y `setupOrderPhotoHoverPreview()`
completos se quitaron de aquí. **YA se conectó también en
`tech.gsocd.com`** (`employee.html`/`supervisor.html`, mismo día) —
resulta que Tech YA tenía Gallery completo y funcionando
(`get-my-gallery.js` + `GSGalleryGroups`), solo le faltaba el
hover-preview mismo. Los 3 repos quedan conectados al mismo componente
compartido, sin ninguna copia local en ningún lado — ver el NOTES.md de
`ordersgsocd.com` para el detalle completo de los 3.



- **Fechas heredadas + resplandor en "+ Add a Unit"**: se había acordado
  (pensando que era Orders) que Entry/Due date de la unidad nueva
  vinieran pre-llenadas con las fechas del PO, con un resplandor dorado
  suave mientras no se tocaran. Al construir la version real de Admin
  esto se quedó fuera (las fechas quedan vacías, "Pick a date"). El
  dueño decidió NO resolverlo ahora — queda pendiente de confirmar si
  se agrega, y en Admin, Orders, o ambos. Revisar cuando el dueño diga
  "ya acabé" con el resto del proyecto.

## En local, sin subir (12/09/2026): Building # pasó de select a texto libre

Corrección sobre el rediseño de "+ Add a Unit" documentado arriba: el campo
Building dejó de ser un `<select>` de direcciones guardadas
(`CLIENT_ADDRESSES_LIST`) y ahora es texto libre y OPCIONAL, igual que
"Building #" en el modo Single de crear orden. La unidad nueva SIEMPRE usa
la dirección del cliente (`Clients` list) — ya no elige entre varias
propiedades guardadas. Si se deja vacío, el backend (`submit-order.js`,
bloque `AddUnitToBatch`) autorellena con los dígitos iniciales de esa
dirección (`"4720 NW 59th Ave"` → `"4720"`), regex `/^\s*(\d+)/`.

Las coordenadas para Routing ya no vienen de un building ligado (ya no
existe ese concepto aquí) — se reutilizó `resolveOrderCoordinates()`, que
ya existía en el archivo para el flujo normal, pasándole `null` como
buildingId para que geocodifique la dirección de texto directo.

**Aviso dado en el chat, no confirmado explícitamente:** si un cliente
maneja varias propiedades distintas y el PO original se creó bajo una
dirección que NO es la default del cliente, las unidades agregadas por
este formulario de todos modos van a ir a la dirección default del
cliente, no a la del PO. No se bloqueó por esto porque el dueño ya dio la
instrucción explícita; queda anotado por si se vuelve un problema real.

## SUBIDO Y DESPLEGADO (12/09/2026): Office Access unificado en gsocd-shared

Se reemplazaron las 2 tarjetas duplicadas de "Need anything from the
office?" en este repo (flujo de crear orden y formulario de Add Unit)
por llamadas al componente unificado en `gsocd-shared/order-form-premium`
(ver su NOTES.md nuevo para el detalle completo). Se quitaron
`createOfficeNeedYes`/`setCreateOfficeNeed` y
`addUnitOfficeNeedState`/`setAddUnitOfficeNeed` locales — ahora se lee/
escribe con `GSOrderFormPremium.getOfficeNeedValue(dom)`/
`getOfficeNeedNotes(dom)`/`setOfficeNeed(dom, yes)`. `<script src>`
actualizado a `gsocd-shared@v1.25.0`.

Detalle importante que se agregó en `startCreateOrderFor()`: el reset del
toggle (`GSOrderFormPremium.setOfficeNeed('create', false)`) se movió a
DESPUÉS de que el HTML nuevo ya exista en el DOM (antes solo se ponía en
`false` una variable local, ahora hay que tocar elementos reales que
todavía no existen si se hace antes de `content.innerHTML = ...`).
Probado con jsdom que reabrir el formulario para un cliente distinto no
arrastra el estado (toggle prendido / nota escrita) del cliente anterior
(7/7).

Título/label/placeholder nuevos confirmados con jsdom sobre el código
real de `admin.html` (no solo el componente aislado): 14/14 en Add Unit.

**Estado real (12/09/2026, verificado con fetch directo a producción):**
`gsocd-shared@v1.25.0` se subió primero (repo + tag), luego este repo.
`admin.html` en producción ya referencia `gsocd-shared@v1.25.0` en su
`<script src>`, y el archivo servido ya no trae ningún rastro del texto
viejo ("Need anything from the office?", "What do we need from the
office?", "Keys for the mailroom...") ni del CSS huérfano (`.field-sub`).
Deployment en Vercel: `READY`, sin errores nuevos en runtime logs.

## Proyecto grande (15/09/2026): cámara propia + cola offline real

Ver `gsocd-shared/NOTES.md` para el contexto completo (origen, por qué
`camera-capture.html` vive por dominio, los 9 puntos totales en los 3
repos). Aquí solo lo que le tocó a **Admin específicamente**:

- Único punto de captura en este repo: la foto de "Not Completed" en
  Active > Update Services (`startServicePhoto`).
- **`Admingsocd.com/camera-capture.html`** (nuevo) -- sin MSAL a
  propósito: `/upload-service-photo` no necesita saber el actor (solo
  `orderId`/`serviceName`/`imageBase64`), así que no valía la pena cargar
  toda la librería de login solo para esta página chica. Solo checa que
  exista `sessionStorage.getItem('admin_account')` antes de dejar entrar
  (mismo criterio rápido que `admin.html` ya usaba antes de inicializar
  MSAL de verdad).
- Se quitó por completo el mecanismo viejo (`svcPhotoPending`,
  `uploadPendingServicePhotos`, `hasPendingServicePhotos`) -- la foto ya
  no espera a "Save Changes", se guarda y sube al momento de tomarla,
  totalmente separada del guardado de servicios (confirmado con el
  dueño: "son cosas diferentes... si en lugar de dar clic en Save se da
  clic en Cancel, igual se guardan").
- **Efecto secundario real:** como esto navega fuera de `admin.html` por
  completo, y el panel de "Update Services" de Active SÍ tiene edición
  sin guardar que solo vive en memoria (`adminSvc_`/`adminNC_`/
  `adminLevel_` + los campos del formulario), se agregó
  `saveAdminEditSnapshot()`/`restoreAdminEditSnapshotIfAny()` --
  `sessionStorage` guarda un snapshot completo justo antes de ir a la
  cámara, y al volver reabre la MISMA orden, abre su panel de Update, y
  pisa el estado recién inicializado (fresco del servidor) con lo que de
  verdad tenía el usuario sin guardar -- incluyendo el puntito visual de
  "ya tiene foto" en el ícono de cámara de ese servicio.
- Se revisó `get-admin-gallery.js` antes de subir por una duda real: ¿el
  orden foto-antes-de-nota rompe algo en cómo Gallery arma la
  descripción? No -- la descripción se arma EN VIVO cada vez que se ve
  la Galería (cruza el nombre de archivo contra el `NotCompletedReason`
  ACTUAL de ese servicio, no un valor congelado al momento de subir), así
  que no importa el orden en que lleguen foto y nota.

## Cómo funciona hoy: Recurring Services Scheduler (Developer > Services)

Tabla editable para crear y mantener contratos recurrentes en lote, sin
pasar uno por uno por el formulario normal de "Recurring". Vive junto a
"Import Recurring Contracts" (misma tarjeta la sube, la de abajo la
edita).

**Cómo se llena:**
- **Import Recurring Contracts** — sube un `.xlsx` con columnas en
  inglés: `Contract #, Client, Frequency, Mon…Sun, Hours, Target,
  Tech 1, Tech 1 Hours/Day, Tech 2, Tech 2 Hours/Day…` (tantos pares de
  Tech como haga falta). Los días se marcan con `X` (mayúscula o
  minúscula). Las horas van como duración en formato `xx:xx` — 8 horas
  es `"08:00"`, 4.5 horas es `"04:30"` (no es hora del día).
- **Contract #** se rellena solo: si la celda viene vacía (caso normal
  la primera vez), se calcula al momento de agregar la fila. Es el
  ClientID real del cliente (`GS-1001`) una vez que su nombre logra
  cruzar contra la lista real de Clientes — si ese mismo cliente ya
  tiene otro edificio en la matriz, se le agrega una letra
  (`GS-1001-A`, `GS-1001-B`…) para distinguirlos. Mientras el Client de
  una fila no tenga cruce, Contract # se queda vacío hasta que se elija
  el cliente a mano en el dropdown de esa fila — en ese momento se
  calcula y se guarda solo.
- También se puede simplemente dar clic en **Save** en cualquier fila
  ya cargada, sin volver a subir ningún archivo — cada campo se guarda
  automáticamente en cuanto se edita (autosave), Save nomás confirma
  que el contrato real ya se creó/actualizó en `RecurringServices`.

**Botón "Download Report (.xlsx)"** — baja exactamente lo que está
cargado en la tabla en ese momento, mismas columnas y mismo formato que
espera Import Recurring Contracts (Contract # ya con su ClientID/letra
puestos, días en `X`, horas en `xx:xx`). Sirve para tener una copia de
respaldo, o para volver a subir ese mismo archivo más adelante sin
perder nada — un archivo ya descargado con su Contract # puesto se
reconoce como "ya existe" al volver a subirlo, no se duplica.

**Técnicos:** el selector de "Tech" en cada fila sale de `allTechs`
(Developer > Settings > Techs & Roles), filtrado a división Janitorial
o Mixed y activos — no de una lista aparte. Un técnico que no tenga
`PayrollID` real (como un Contractor recién agregado a mano) no
funciona aquí todavía porque el cruce del picker necesita un sku/id
real para reconocer la selección ya hecha.

**Mobile:** cada contrato se ve como tarjeta (Contract #/Client/
Frequency apilados con su etiqueta, Days+Hours+Target juntos en una
sola línea con mini-etiquetas arriba de cada uno). Desktop se queda
exactamente con la tabla de columnas de siempre — son 2 renderizados
distintos que arma la misma función según el ancho de pantalla.

**Pendiente:**
- Solo se pueden crear contratos con Frequency **Weekly** desde aquí —
  Biweekly/Monthly se pueden seleccionar en la tabla pero el botón Save
  se queda bloqueado (falta la fecha ancla real y esa lógica no está
  terminada para este flujo en lote).
- **Resuelto en parte (16/09/2026):** el cruce de Client por nombre ya
  ignora mayúsculas, acentos, espacios dobles y puntuación común
  (`. , ' " &`) — `"St. John's Lutheran Church"` cruza contra
  `"St Johns Lutheran Church"`, `"D&K Products"` contra
  `"D & K Products"`, etc. (`normalizeForClientMatch()`, junto a los
  demás helpers del parser). Lo que sigue sin cruzar solo, a propósito,
  porque no hay forma segura de resolverlo sin arriesgar cruzar al
  cliente equivocado: un **apodo** que no comparte texto real con el
  nombre del negocio (`"Viejitos Southridge"` vs `"Southridge Senior
  Lofts"`), o un nombre **acortado** (`"D&K"` vs `"D&K Products"`) — esos
  siguen necesitando corregirse a mano en el dropdown de esa fila.
- Ningún tech sin `PayrollID` real (Contractors agregados a mano)
  aparece asignable aquí todavía de forma completamente confiable — la
  lista sí los incluye (si son Janitorial o Mixed), pero como no traen
  un sku propio, el picker los reconoce por nombre, no por id — mismo
  comportamiento que ya tienen los técnicos de Recurring en general
  (ver el "quirk" documentado en `gsocd-shared/service-change-panel`),
  no algo exclusivo de Contractors.

## Cómo funciona hoy: Subcontratistas (Developer > Settings > Techs & Roles)

Un subcontratista es, para el sistema, un técnico más — se le asigna
trabajo exactamente igual que a cualquier empleado. En Active > Edit y
Approvals eso ya era cierto de entrada (el campo "Supervisor" es texto
libre, cualquier nombre ahí ya funciona). En **Scheduling** — donde se
elige quién va a hacer una orden nueva — el selector de candidatos no
salía de ahí sino de una lista curada (empleados reales, con sus horas
de la semana); un Contractor no aparecía y no se le podía asignar
trabajo por ese camino. Ya se corrigió: ahora aparece en la misma
lista, junto a los empleados reales, solo que sin las estadísticas de
horas (no se les da seguimiento ahí).

**Cómo se da de alta:** botón **"+ Add Person Manually"** junto al
buscador de Techs & Roles — pide Nombre, Apellido, Teléfono, División y
Rol (con "Contractor" ya preseleccionado). El teléfono es obligatorio
porque de sus últimos 4 dígitos sale el código temporal con el que la
persona reclama su propio dispositivo — sin eso no se le puede generar
el QR para que entre a `tech.gsocd.com` y vea sus órdenes asignadas,
igual que cualquier técnico.

Una vez creado, aparece en la tabla con su propio botón "Generate QR"
(el mismo mecanismo que ya existía para todos los técnicos, sin ningún
cambio ahí) y con **"Contractor — no payroll"** en la columna de nómina
en vez de la alarma naranja de "falta payroll" que sale para todos los
demás — para un Contractor eso es lo esperado, no algo por resolver.

**División "Mixed"** — para alguien que puede trabajar en las 3
divisiones (Janitorial, Renovations, Exteriors) en vez de estar atado a
una sola. Donde el sistema necesita filtrar por una división exacta
(hoy, el único lugar real es el selector de técnicos del Recurring
Scheduler, que es Janitorial nomás), Mixed cuenta igual que si fuera
esa división.

**Mobile:** tanto Techs & Roles como Staff & Roles (la tabla de quién
tiene acceso a Developer) se ven como tarjetas apiladas, una persona
por tarjeta con su propia etiqueta arriba de cada campo. El formulario
de "Add Person Manually" usa los mismos campos (`.field-group`/
`.field-row`) que ya usa el resto de los formularios de Developer, así
que hereda su mismo comportamiento mobile sin nada aparte.

**Pendiente:**
- Un Contractor no puede iniciar sesión en `tech.gsocd.com` sin que
  alguien de oficina le genere el QR primero desde aquí y se lo
  comparta — no hay (ni se pidió) un flujo de auto-registro para ellos
  como sí lo tienen los empleados reales.
- No hay todavía ninguna vista que junte "las órdenes que se le han
  asignado a este subcontratista" en un solo lugar dentro de Admin —
  su trabajo se ve orden por orden (igual que cualquier Supervisor), no
  hay un resumen tipo "Active > By Employee" armado específicamente
  para Contractors.

## Estado del repaso de mobile (Admin)

Se revisó Admin de punta a punta (los 8 tabs principales + las 6
categorías de Developer con sus tarjetas) renderizando cada uno a
375px real, no adivinando. Quedaron corregidos: las filas de filtro
"pill" que se cortaban en Active > By Employee/History/Schedule, y las
3 tablas de Developer que no tenían ninguna versión mobile (Recurring
Services Scheduler, Techs & Roles, Staff & Roles). El resto de Admin ya
estaba bien.

**Pendiente:** el mismo repaso todavía no se ha hecho en los otros 2
repos (`ordersgsocd.com` y `tech.gsocd.com`) — quedó ofrecido, no
empezado.

## Regla nueva (21/09/2026): los Previews de Vercel NO le sirven al dueño para probar -- login de Azure lo rechaza

El login de MSAL (Azure AD) solo tiene registradas las redirect URIs de
producción (`admin.gsocd.com` y las alias fijas de Vercel) -- una URL de
Preview de una rama nueva (`<proyecto>-git-<rama>-gs-solutions1.vercel.app`)
siempre da `AADSTS50011: redirect URI ... does not match`, porque Azure no
tiene wildcard para ramas dinámicas. Agregar cada URL de rama una por una en
Azure (como se hizo alguna vez para probar QuickBooks) no es práctico como
flujo normal -- son demasiadas ramas.

**Consecuencia real para el flujo de trabajo:** la regla de "Preview antes de
pedir el dale" (19/09/2026, más arriba en este archivo) asume que el dueño
puede abrir el link y loguearse -- en Admin, hoy, NO puede. Cuando el dueño
diga "no puedo ver Previews" o pida saltarse ese paso, es por esto -- no hay
que ofrecer un link de Preview esperando que funcione.

**Qué hacer en su lugar cuando el dueño lo pida:** revisar el cambio de punta
a punta uno mismo (sintaxis real con Node, no solo `node --check` -- cargar
el router `api/[...slug].js` con `require()` de verdad es el chequeo más
importante, ver el bug real de abajo), fusionar directo a main con cuidado
extra, y verificar el deployment de producción (`Vercel:get_deployment` hasta
`READY`, más `Vercel:get_runtime_logs` con `statusCode: 5xx` los minutos
después de subir) antes de avisar que ya quedó.

**BUG REAL encontrado en este flujo (21/09/2026, antes de que llegara a
producción):** 2 endpoints nuevos (`toggle-assign-by-service.js`,
`get-service-assignments.js`, `save-service-assignment.js`, de "Assign by
service") nunca se registraron en el mapa estático de `api/[...slug].js` --
sin esto hubieran regresado 404 (no hubieran roto nada más, pero la función
nueva ni hubiera funcionado). Se atrapó con un `require('./api/[...slug].js')`
real en Node antes de fusionar, no solo revisando sintaxis. Lección: cualquier
archivo backend nuevo SIEMPRE tiene que agregarse a ese mapa, y la forma de
confirmarlo es cargar el router de verdad, no solo `node --check` sobre el
archivo nuevo por separado.

---

## SUBIDO (23/09/2026): el servidor de Admin valida el login de Microsoft en CADA petición

Antes `/api/*` se fiaba del correo del body (developer-admin decidía
permisos con `body.email`): cualquiera que supiera el correo de un
Developer/Director podía llamar al API directo. Ahora:

- `lib/auth.js` valida el **ID token de Microsoft** (firma RS256 contra
  el JWKS del tenant, `aud` = clientId de Admin, `iss` = tenant GS,
  vigencia con 5 min de tolerancia).
- `api/[...slug].js` lo exige en todo endpoint salvo `site-image`
  (imágenes públicas), `quickbooks-callback` (OAuth, su propio state) y
  `cron-recurring-orders` (su propio CRON_SECRET). Header
  `Authorization: Bearer`, o `?t=` en links que abren otra pestaña
  (PDFs, conectar QuickBooks). El correo del token **reemplaza**
  `email` (developer-admin) y `viewerId` (admin-get-orders,
  admin-mark-order-seen); ningún otro endpoint usa esos campos para
  otra cosa (el correo de clientes/contactos va en otros campos).
- Páginas: `admin.html` (`getIdToken`/`authFetch`, renovación cada 4 min
  y antes de vencer, reintento con token nuevo si da 401, una sola
  vuelta al login por sesión para no rebotar sin fin), `calendar.html`
  y `camera-capture.html` (mismo MSAL, `gsAuthFetch`).
- **Pendiente, misma clase de problema:** Orders (se fía de `clientId`)
  y Tech (se fía de `techId`) — ahí no hay login de Microsoft, hace
  falta un token de sesión propio.

## SUBIDO (23/09/2026): parte 1 del picker Recurring / Units

- gsocd-shared **v1.51.0**: toggle RECURRING / UNITS (mismo estilo que
  Commercial / Residential) y, en Recurring, Common Areas en tarjetas
  por área; la del lugar (`placeArea`) se abre sola y va primero; lo
  demás en "+ Other services". Opt-in (`workToggle`).
- Admin: el editor del lugar en Recurring lo usa (`rsAreaCardFor` pasa
  del tipo de lugar a la tarjeta). Developer > Service Catalog tiene la
  columna **Areas** (clic para editar); se guarda por SKU en Settings
  (`catalog_service_areas`), con el borrador del mini como default
  (`DEFAULT_SERVICE_AREAS` en developer-admin.js).
- **Parte 2 pendiente:** paquetes como plantilla en modo Units (sin
  precio los incluidos; QuickBooks factura solo el paquete, confirmado
  por el dueño) y el toggle en Create Order / portal del cliente / Tech.

## ACORDADO (23/09/2026, corregido el mismo día): categorías + picker Recurring / Units

**Corrección:** la propuesta de 5 categorías "por cómo se vende" (Common
Areas / Floor Care / Deep Cleaning / Packages / Extras) quedó
DESCARTADA: quitaba Kitchen & Bathrooms, Floors, etc., y la mayoría del
trabajo es **limpieza de unidades vacías**, que se piensa por cuarto.
Se quedan las categorías de cuarto del dueño ("Baseborads" corregido a
"Baseboards & Trim"); los 14 servicios nuevos: Vacuuming y Sweep & mop
→ Floors, Patio & courtyard → Patio, Extra cleaning request → Extras, el
resto → Common Areas. Así viene la columna "App category" de
GS-services-QuickBooks-and-App.csv.

**Aprobado con mini** ("Services: common areas by area + packages as
templates"), POR CONSTRUIR:
- El picker con un **toggle Recurring / Units** (mismo estilo que el
  toggle Commercial / Residential del picker).
- **Recurring:** Common Areas se abre en **tarjetas por área**
  (Restrooms & Locker Rooms, Hallways & Floors, Lobby & Entry,
  Elevators & Stairs, Trash, Kitchen & Breakroom, Offices & Meeting
  Rooms, Amenities, Exterior). La tarjeta que coincide con el lugar
  ("Floor 1 / Restroom") se abre sola y va primero. Un servicio puede
  estar en varias tarjetas → las áreas son una **lista aparte por
  servicio** (editable en Developer), no la categoría.
- **Units:** categorías de cuarto + **paquetes como plantilla**: cada
  paquete (Move-out, Move-in, Regular Cleaning, Touch-Up,
  Post-construction) lista sus servicios con nivel; "Use this package"
  = UNA línea para facturar (el paquete) + checklist para el técnico;
  se pueden agregar servicios sueltos encima. Contenido editable en
  Developer (el del mini es borrador).
- Pendiente de decidir al construir: cómo guarda la orden el checklist
  del paquete sin que salga facturado línea por línea (QuickBooks sigue
  viendo solo el paquete).

## SUBIDO (23/09/2026): mismo archivo para QuickBooks y para la app + descripciones en tooltip

- **Import del catálogo acepta la plantilla de importación de QuickBooks**
  (la del sample oficial: "Product/service name", "Sales price/rate",
  "Sales description"...). Si el archivo es esa plantilla (trae
  "Sales price/rate" o "Quantity as of date") se trata como **parcial**:
  crea/actualiza lo que trae y NO propone apagar nada de lo que no viene.
  El reporte completo exportado de QuickBooks sigue funcionando igual
  que siempre (modo completo). Columna opcional **"App category"**
  (QuickBooks la ignora) = categoría de la app (Floors, Dusting...), se
  pone al crear y al actualizar solo si viene llena.
- **Descripciones en tooltip** (gsocd-shared v1.50.0,
  `service-tooltip`): el picker (Admin/Orders/Tech) y los nombres de
  servicio en Approvals/Active/History, el panel "Who does what", la
  lista del técnico y el seguimiento del cliente. Se registra el
  catálogo en loadAll(); la descripción es la Sales Description de
  QuickBooks (ServicesCatalog.Description).

## SUBIDO (23/09/2026): Developer > Service Catalog > "Download Excel"

Pedido del dueño para revisar qué servicios faltan crear en QuickBooks
(los de Recurring por lugar). Baja TODO el catálogo (activos e
inactivos) con categoría, descripción, precio, "Requires Quantity" y
los minutos por nivel de ServiceTimes. Mismo patrón (SheetJS) que el
export del Recurring Scheduler.

## SUBIDO (23/09/2026, tarde): Recurring con edificios + columnas + tarjeta nueva

Rediseño aprobado en mini con el dueño ("Recurring — edificios y pisos
según el cliente"), porque no todos los clientes son iguales: torre de
19 pisos (Equitable), complejo de varias direcciones (INDIGO), negocio
de un solo nivel (Bratney).

- **Edificios = direcciones del cliente en Clients** (la principal +
  ClientAddresses sin archivar). Con una sola dirección no hay nivel de
  edificio; con 1 piso no hay nivel de piso. Pisos por edificio.
- **Pantalla grande: 3 columnas** (menú Where con edificios que abren y
  cierran sus pisos / Who and what con personas que se colapsan y
  líneas cortas `.svc-assign-line` / Selected place con el picker real,
  sticky). Mediana: 2 columnas con el editor bajo la línea. Celular:
  acordeón (edificio > piso > persona > lugares). Horas en una fila
  "Team" (una por persona para todo el contrato).
- **ServicesJSON** ahora trae además `bld`, `bldLabel`, `floors`,
  `multiBld` por renglón. El texto del lugar sale de `placeLabel()`
  (lib/recurring-orders.js) con solo los niveles que aplican:
  "1301 W 16th St S / Floor 2 / Hallway", "Floor 3 / Hallway",
  "Restroom ×2". Mismas reglas en `rsPlaceLabel()` (admin.html) y en
  ordersgsocd.com/get-my-recurring.js -- si cambian, cambiar las 3.
  Renglones de antes (sin bld/floors) siguen funcionando.
- **Una orden por lugar se reconoce por RecurringServiceID + Assign by
  service** (`isPlaceOrderId` en Admin, `isPlaceOrder` en Tech,
  `placeMode` en submit-service-complete solo en esas órdenes). Ya no
  por el texto "Floor N /" (RC_PLACE_RE queda de respaldo).
- **Tarjeta "New Recurring Contract" rediseñada**: título Cormorant,
  "+" dorado y descripción en inglés.
- **BUG REAL de antes arreglado (A/B en Puppeteer contra 1858c61):**
  `loadInitialData()` corre en cada `loadAll()` (casi cualquier acción
  en Admin) y dejaba el formulario de Recurring a medio llenar sin
  cliente, con la hora en 6:00 AM y un renglón de empleado vacío de más
  cada vez (que luego se guardaban como asignaciones extra). Ahora la
  hora y el primer renglón solo se montan la primera vez, el select de
  cliente conserva su valor y el picker simple se remonta con lo que
  tenía.

## TEMPORAL (23/09/2026): boton "Fill with Equitable (test)" en el formulario de Recurring

Pedido del dueño para probar el flujo completo con el caso real. Rellena
(NO guarda) el contrato de Equitable según el PDF: Lun-Vie 7:00, 5 h,
**3 pisos por defecto** (pedido del dueño); pisos 1-2 diario, piso 3
lun/mié/jue/vie, jueves oficina completa, elevadores diario, lunes patio
(Exterior / Courtyard). Los pisos 4-19 del jueves del PDF NO se
rellenan: si hacen falta, se sube Floors y se agregan con + Add place.
Servicios buscados en el catálogo real por palabra clave (avisa en el
toast cuáles no encontró); gente = los 2 primeros técnicos Janitorial,
a cambiar a mano. **Quitar** el botón (comentario TEMPORAL en #rc-scope)
y `fillEquitableTest()` cuando ya no haga falta.

## SUBIDO (23/09/2026): Recurring "Who does what" por lugar -- reemplaza el diseño de piso/amenidad de abajo

El diseño de "layout del edificio + día por día" (entrada de abajo) se
descartó en minis con el dueño por complicado. Lo aprobado (mini
"Recurring — quién hace qué"): UN contrato, y dentro, cada persona con
SUS lugares (piso + área + cantidad), cada lugar con sus servicios
(GSServicePicker real) y sus propios 7 días. Oficina ve todo junto en una
sola orden por día; cada técnico recibe solo lo suyo.

**Sin columnas nuevas en SharePoint (a propósito):**
- Contrato: el mismo `ServicesJSON`, un renglón por servicio con
  `zone` (F1..Fn | BLD | EXT), `area`, `qty`, `days`, `payrollNumber`.
  `DaysOfWeek` = unión de los días (Calendar y computeRecurringDates no
  cambian). `RecurringAssignments` = una fila por persona con sus horas.
- Orden: el LUGAR ("Floor 1 / Hallway") viaja en `Category` de
  OrderServices y ServiceAssignments (antes siempre decía 'Janitorial').
  Así la llave Category+ServiceName de todo Assign by service queda única
  por lugar sin tocar esas piezas. Detección: regex
  `^(Floor \d+|Elevators & stairs|Exterior) \/ ` (RC_PLACE_RE en
  admin.html, PLACE_RE en Tech) -- si se cambia el formato de
  placeLabel() en lib/recurring-orders.js hay que cambiar los 2 regex.
- Estas órdenes nacen con `AssignByService=true` y sus ServiceAssignments
  ya repartidos (AssignedTo = nombres de Techs por PayrollID). Se trabajan
  en PARALELO (svcAssignmentStatusRows detecta lugar y no aplica la fila).
- Editar un contrato por lugar SIEMPRE regenera sus órdenes futuras
  (propagateContractEdit): cada día de la semana lleva otro alcance.

**Piezas:** formulario (switch "Who does what by place", default prendido
en contratos nuevos; los viejos abren en el formulario de siempre),
tarjeta del contrato con resumen por persona + botón "Scope of Work"
(hoja imprimible para el cliente; "lo que no está aquí se cotiza
aparte"), panel "Who does what" en Active con Confirm por lugar
(`complete-service-assignment` con `placeMode`), y EXTRAS: el técnico
manda "el cliente pidió algo que no está en mi lista" (Tech,
`submit-extra-request`) -> evento 'Extra Requested' en OrderHistory con
FieldChanged 'Office Change (Internal)' (oculto al cliente) -> oficina
aprueba (cobro aparte) o rechaza (`resolve-extra-request.js`, nuevo,
registrado en api/[...slug].js). La aprobación queda en el historial;
todavía NO crea una línea de cobro sola.

`vercel.json`: maxDuration 60 para api/[...slug].js -- generar 30 días
de un contrato por lugar crea muchos más renglones que uno plano.

Probado antes de subir: plan por día con Node (datos de Equitable), el
router cargado de verdad, y admin.html real en Puppeteer con login y API
simulados (crear, editar lugar/viejo, cancelar, Active con Confirm y
extras, 375px sin scroll horizontal).

## 23/09/2026 -- (DESCARTADO, ver arriba) Diseño en curso: Recurring detallado por piso/amenidad

Disparado por un contrato real difícil de capturar (Equitable Building,
PDF adjunto: 5 horas, Lun-Vie 7am-12pm, con tareas que cambian por día --
lunes Pisos 1,2,3; martes solo 1&2; jueves además limpieza completa de
oficina 1 vez/semana -- y tareas fijas por zona como Elevadores/Pasillos
"todos los dias"). El sistema actual de Recurring solo entiende UNA
lista de servicios plana, igual para todos los dias del contrato --
Equitable no cabe ahi.

**Rechazado en el camino (2 minis construidos y rechazados, ver
Artifact tool para los links si hacen falta):**
- Un mini con "líneas" (días + servicios en texto libre por línea) --
  rechazado por texto libre: el sistema factura via SKU real, cada
  servicio debe venir del catálogo real, nunca texto escrito a mano.
- Un segundo mini con GSServicePicker real (sin texto libre) pero
  organizado en "líneas" con nombre libre -- rechazado también: el
  dueño ya había dicho que cada DÍA debe ser su propio toggle
  (como Assign by Service), no un concepto nuevo de "líneas".

**Diseño actual acordado (aún sin construir, seguir aquí la próxima
sesión):**

1. Catálogo de amenidades: 38 tipos reales, sacados investigando en
   internet ~30 clientes reales de GS Solutions (complejos de
   apartamentos de Iowa, de `All-Clients-2026-09-23.xlsx`) -- NO
   inventado. Lista completa: Clubhouse, Playground, Basketball Court,
   RV Storage, Dog Park, Fitness Center/Gym, Movie Theater/Cinema,
   Business Center, Community Room, Pool, Garages, Storage Units,
   Laundry Facilities, Elevator, Controlled Access, Villas con garage,
   Gazebo, Pond, Pet Wash Station, Pet Play Area, Planned Social
   Activities, Computer Center, TV Room, Coffee Bar, Courtyard, Bike
   Storage, Conference Room, Guest Suite, Key Fob Access, Lobby, Media
   Room, Package Receiving, Pool Table, Shuffleboard, Yoga Studio,
   Rooftop Patio/Terrace, Skywalk Connection, Grill/BBQ Area, Picnic
   Area.

2. El selector de CLIENTE no es nuevo -- ya existe, es la lista de
   Clients de Admin. No construir nada aparte para esto (ya se
   confundió una vez en esta misma sesión, ojo).

3. Jerarquía real de captura, nada se infiere, todo se marca a mano:
   - Al edificio se le pone cuántos PISOS tiene (número real).
   - Excepción: Elevadores y Escaleras se registran UNA VEZ por
     edificio (no piso por piso) -- son una sola pieza física que
     atraviesa varios pisos, con puerta en cada uno. Se captura
     cuántos hay (ej. "2 elevadores") y el sistema ya sabe que cuentan
     para todos los pisos del edificio -- NO se pregunta piso por piso
     si "tiene elevador".
   - PENDIENTE SIN RESOLVER: ¿Elevadores/Escaleras son las ÚNICAS 2
     excepciones "de todo el edificio", o hay otras de las 38 que
     también funcionan así? No se alcanzó a contestar antes de que el
     dueño cortara la sesión.
   - Cada PISO (que no sea la excepción de arriba) se marca a mano con
     qué amenidades tiene, del catálogo de 38 -- nada se copia de un
     piso a otro ni se asume.
   - Dentro de cada amenidad de un piso, se elige qué SERVICIO se hace
     ahí -- el selector real (GSServicePicker de gsocd-shared, con
     niveles L1/L2/L3), nunca texto libre.
   - Un total (cuántos pasillos hay en todo el edificio, por ejemplo)
     sale solo de contar cuántos pisos lo tienen marcado -- no se
     vuelve a capturar aparte.

4. Del lado del contrato recurrente: 7 toggles, uno por día de la
   semana (Dom-Sáb), igual que Assign by Service pero por día en vez
   de por servicio. Prender el toggle de un día muestra un selector
   para elegir QUÉ PISO(S) le tocan ese día -- y al elegir un piso,
   salen las amenidades/servicios que ESE piso ya trae configurados
   (del paso 3), no una lista genérica. Cada día es 100% independiente
   -- si lunes/miércoles/viernes llevan lo mismo, se captura 3 veces,
   nada se comparte entre días (decisión explícita del dueño).

5. Equipo asignado: por default es el del contrato completo, pero
   puede haber equipo propio distinto -- AÚN SIN RESOLVER si esto vive
   a nivel día, a nivel piso, o ambos.

**No se ha escrito ni una línea de código de esto.** Es puro diseño
hablado, sujeto a seguir cambiando. Antes de construir nada: confirmar
el pendiente del punto 3, y el del punto 5.
