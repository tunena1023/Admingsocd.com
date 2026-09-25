# NOTES.md — Historial y estado del proyecto (Admingsocd.com)

Reglas de proceso -> ver WORKFLOW.md (léelo primero). Aquí vive el historial
de features, bugs, decisiones y pendientes, en orden cronológico.

**Si este archivo supera ~600 líneas**, es hora de resumir entradas viejas
(más de ~3 semanas sin tocarse) a un párrafo o moverlas a NOTES_ARCHIVE.md,
en vez de seguir apilando sin límite.

## EN PREVIEW (25/09/2026): site-image ya no entrega cualquier archivo

`site-image.js` es PÚBLICA (no pide sesión). `?name=` pasaba el texto directo a
`driveItemByPath`, así que con una ruta se podía bajar CUALQUIER archivo del
SharePoint (fotos y PDFs de órdenes). Ahora cada parámetro es un solo segmento
(sin `/`, `\` ni `..`) y `?name=` solo entrega imágenes de la raíz (Logo.jpg,
NavBackground.jpg, LoginBackground.jpg). Probado: esas 3 siguen funcionando; una
ruta o un .pdf da 404.

## REGLA FIJA (25/09/2026): cómo se prueba Admin en Preview -- SIEMPRE en test-admin.gsocd.com

Reemplaza la regla del 21/09/2026 de más abajo ("los Previews no le sirven al
dueño"): eso ya se arregló, pero la forma de usarlos cambió.

**El problema:** el login de Microsoft (MSAL, app de Azure
`18dfcf2e-0059-40f5-831c-69d13b9091fc`) solo deja regresar a direcciones
registradas en Azure. Cada preview de Vercel tiene una dirección distinta
(`admingsocd-<letras>-gs-solutions1.vercel.app` o
`admingsocd-com-git-<rama>-gs-solutions1.vercel.app`), así que Microsoft la
rechaza con `AADSTS50011: redirect URI ... does not match`.

**La solución (hecha con el dueño, 25/09/2026):** una sola dirección fija de pruebas:
- **https://test-admin.gsocd.com** es un dominio del proyecto `admingsocd-com`
  en Vercel, ligado a la rama **`preview`**. En GoDaddy es un CNAME `test-admin`
  que apunta a `199c536b2aeeae0a.vercel-dns-017.com` (el mismo destino que `admin`).
- En Azure (app `18dfcf2e-...` → Authentication → Single-page application) están
  registradas las 2 que hacen falta: `https://test-admin.gsocd.com/` (la usa
  index.html) y `https://test-admin.gsocd.com/index.html` (admin.html,
  calendar.html y camera-capture.html).

**Cómo se usa de aquí en adelante:**
1. El trabajo se hace en su rama de siempre (la que toque en la sesión).
2. Para que el dueño lo pruebe, esa rama se manda ENCIMA de `preview`:
   `git push --force origin <tu-rama>:preview`. El dueño confirmó (25/09/2026)
   que `preview` no guarda nada suyo y se puede sobrescribir. `main` NUNCA se toca
   con esto.
3. Vercel despliega `preview` solo y test-admin.gsocd.com pasa al deploy nuevo.
   **Ojo:** si ese commit exacto ya se había desplegado desde otra rama, Vercel NO
   vuelve a desplegar y el dominio se queda en lo anterior. En ese caso hay que
   asignarlo a mano (Vercel `assign_alias` del deploy de ese commit a
   `test-admin.gsocd.com`), como se hizo el 25/09/2026.
4. Al dueño se le da SOLO **https://test-admin.gsocd.com**. Pide primero la cuenta
   de Vercel (protección normal de previews) y luego el login de Microsoft de
   siempre.
5. Solo cabe UNA cosa a la vez en `preview`: subir otra rama reemplaza lo que el
   dueño estaba probando. Avísale antes si todavía no terminaba.

**Nunca:**
- Darle al dueño un link de preview de Admin con letras al azar o `-git-<rama>`:
  siempre falla con AADSTS50011.
- Registrar en Azure la dirección de cada rama nueva (así se hizo una vez para
  QuickBooks; no escala y es lo que confundía).
- Crear otro dominio de pruebas: con test-admin basta.

**Orders y Tech no tienen este problema:** no usan login de Microsoft (Orders
entra con Client ID; Tech con QR/DeviceToken). Sus previews normales, de letras al
azar, sí funcionan; solo piden la cuenta de Vercel.

**Variables de Preview (los 3 proyectos):** `NOTIFY_MODE=test`,
`NOTIFY_TEST_TO=CFO@gsocd.com`. Cualquier correo que salga de un preview le llega
solo a CFO@ con `[TEST → destinatario real]` en el asunto. Nunca poner `live` en
Preview: usa el MISMO SharePoint que producción.

## SUBIDO A PRODUCCIÓN (25/09/2026): correos de notificación (reemplaza Power Automate)

**Así quedó Vercel (25/09/2026, final, los 3 proyectos):**
- **Producción:** `NOTIFY_MODE=live`, `NOTIFY_FROM=noreply@gsocd.com`. Los correos
  les llegan a los clientes de verdad (el dueño le pasa el portal al primer
  cliente real el 26/09/2026).
- **Preview:** `NOTIFY_MODE=test`, `NOTIFY_TEST_TO=CFO@gsocd.com`. SIEMPRE en test:
  Preview usa el mismo SharePoint que producción, así que tocar una orden real en
  un preview le mandaría un correo al cliente. En test, todo lo que sale de un
  preview le llega solo a CFO@ con `[TEST → destinatario real]` en el asunto.
  Nunca poner `live` en Preview.
- Si cambias una variable en Vercel, los deploys que ya existen no la ven: hay que
  volver a desplegar (y reasignar test-admin.gsocd.com si hace falta).
orders@ es un grupo: sus correos caen en las bandejas de CFO@, Admin@, Service@ y
customercare@, no tiene bandeja propia. La pantalla nueva de "Order received" en
customer.html también se subió el mismo día ("así mero", mini con el portal
real: https://claude.ai/artifact/LiBZziphN8DccD8W3g6D2s).

El envío vive en `lib/notify.js`, que es una COPIA de `gsocd-shared/lib/notify.js`
(mismo criterio que division-rules: Vercel no reinstala tags nuevos). Manda desde
orders@gsocd.com por Graph `sendMail`. La app GSPortal ya tiene `Mail.Send`
(Application) con admin consent (dueño, 25/09/2026). Vista previa aprobada:
https://claude.ai/artifact/2VhdVbEYgSsxDwRuvbTNbv

**Variables en Vercel (por proyecto, Admin + Orders + Tech):**
- `NOTIFY_MODE`: `off` (default, no sale nada) / `test` (todo a `NOTIFY_TEST_TO`,
  con el destinatario real en el asunto) / `live`. Preview usa el MISMO SharePoint
  que producción: probar SIEMPRE en `test`, nunca en `live`.
- `NOTIFY_TEST_TO`, `NOTIFY_OFFICE_TO` (default orders@gsocd.com, varios con coma).
- `NOTIFY_FROM=noreply@gsocd.com` (puesto en Vercel, 25/09/2026): el buzón
  COMPARTIDO "GS Solutions". orders@gsocd.com es un GRUPO de distribución y Graph
  no puede mandar desde un grupo ("The requested user 'orders@gsocd.com' is
  invalid", primera prueba real en Preview). Las respuestas de los clientes van
  a orders@ por Reply-To (`NOTIFY_REPLY_TO`, default orders@gsocd.com). Si se
  arma la Application Access Policy, el buzón que va en el grupo es noreply@.

**Lista opcional `NotificationLog`** (bitácora de cada intento; si no existe, se
ignora): Title, OrderID, Event, Recipient, Subject, Result (Sent/Skipped/Failed),
Detail, Mode. Todas de texto.

**Qué sale y de dónde:**
- Cliente. **Confirmations** salen SIEMPRE: "Send to client" (`admin-update-order` requestOnly) y
  pedir reactivación (`admin-approve-order`). **Changes**: fecha/ventana movida en una
  orden ya asignada (`admin-update-order` directo); decisiones del director
  (cancelación aprobada; rechazo solo si lo pidió el cliente; Reassign/Reschedule
  aplicados); orden reactivada. **Updates**: orden recibida (`submit-order` flujos
  A/C/D/E y `add-batch-unit` en Orders; un PO = 1 correo); programada (primera
  asignación, `Order Assigned`); Completed (con el PDF de completación adjunto si
  pesa menos de 2.8 MB).
- Oficina (`NOTIFY_OFFICE_TO`): orden nueva, edición, cambio, cancelación o nuevas
  fechas pedidas por el cliente; cliente confirmó cambio o reactivación; técnico
  marcó su orden o un servicio como hecho (por lugar de recurrente NO); formulario
  de contacto (Reply-To = quien escribió).
- Recuperar Client ID: siempre, sin el candado de "una vez en la vida"; freno de
  10 min entre correos al mismo email.
- Nunca sale: cambios internos (Supervisor, inspección, Office Change (Internal)),
  aprobación de orden nueva (ya salió "Scheduled"), técnico terminó (al cliente).
- A quién: contacto de la orden → contacto del edificio (se empareja por dirección
  y # de edificio, la orden no guarda el id) → contacto marcado "recibe
  notificaciones" → Clients.Contact → Orders.Email. Contactos Phone se saltan.

**Antes de `live`:** apagar los flows viejos de Power Automate sobre ContactMessages
e IdRecovery si existen (si no, correos dobles), y la Application Access Policy
para que GSPortal solo pueda mandar como orders@.

**No cubierto todavía:** modo "Assign by service" (cada servicio con su propia
fecha: no manda "Scheduled"), órdenes creadas desde Admin (`submit-order` de Admin
no manda "received"), SMS.

## Minis: SIEMPRE con el app real (24/09/2026, el dueño: "esmerate")

Los minis sueltos (una cajita con estilos propios) no le sirven al dueño:
no se parecen a lo que despues ve. El mini se arma con el admin.html REAL
del repo (con el cambio ya puesto en la copia local), metiendo INLINE cada
<script> de gsocd-shared en su version exacta (git show vX:ruta), quitando
lo que el hosting de artifacts bloquea (sheetjs, qrcode, leaflet), y
cambiando SOLO el login (msal falso + sessionStorage admin_account) y la
API (window.fetch simulado para /api/* con datos de ordenes reales: Senior
Lofts, Equitable, Ashok). Logo y fondo del nav: recortados de una captura
del dueño (en el app salen de /api/site-image, que el sandbox no alcanza).
Insertar lo extra antes del ULTIMO </body> (hay un '</body>' dentro de un
string de impresion en admin.html). Probar con Playwright a 1280/375/320
antes de mandarlo. Ejemplo aprobado: https://claude.ai/artifact/G3imRZQbjWGHcrr8X3VYq1

## 24/09/2026 -- en Preview (rama feat/package-edit-no-select-all), falta el "dale" a main

- **Active > Recurring:** sin boton de completado por servicio (solo en
  recurrentes). Sigue el boton POR PERSONA (mini aprobado:
  https://claude.ai/artifact/8W4hpmzdFpsa8fF9vyepdL) -- necesita 2
  columnas en ServiceAssignments (DoneBy, ConfirmedFor) y camara por
  SERVICIO en Tech (facturan por servicio; la foto debe decir de que
  servicio y lugar es). Aun no construido.
- **Select all (L1/L2/L3) quitado de todos los pickers** (Admin y Orders).
- **Edit de paquetes por cliente** construido: picker v1.57.0
  (packageEdit), acciones list/save/reset-client-package en
  developer-admin, lib/client-packages.js (Admin y Orders), el portal
  muestra la version del cliente (get-services) y cada orden congela la
  version del cliente (recordPackageSnapshots). Mini aprobado:
  https://claude.ai/artifact/6NhneyVnNWVTkMwH5wgKCv. Se quedo el acomodo
  de tarjetas de hoy (una debajo de otra), no la galeria del mini viejo.

## HANDOFF (23/09/2026, fin de sesión — chat lleno, sigue en uno nuevo)

Sesión larga. Todo lo de abajo está SUBIDO y en producción salvo la
última entrada (paquetes por cliente), que es solo un mini aprobado,
sin código. Entradas viejas ya resueltas se movieron a
NOTES_ARCHIVE.md para no perder el hilo de lo que sigue vivo.

### Pendiente inmediato, con mini YA APROBADO por el dueño -- empezar por aquí

**Paquetes editables por cliente ("el botón de editar en Clients >
Create Order").** Mini: https://claude.ai/artifact/CkLdB3Tmt2QBcN3H28Xghp
("me gustó"). Construir:
- En Clients > Create Order > tarjeta del cliente, sección Packages:
  estilo **Gallery** -- el paquete elegido/abierto grande a la
  izquierda, los demás cerrados en una columna a la derecha (clic en
  uno cerrado = pasa a ser el abierto).
- El paquete abierto trae un botón **Edit** (**solo visible en Admin**,
  el cliente nunca lo ve): permite agregar/quitar servicios de ESE
  paquete y cambiarles el nivel, usando el mismo picker/estilo de
  siempre (L1/L2/L3, con el pool de servicios disponibles).
- Al guardar (**Save for <ClientID>**), esa configuración queda
  **específica de ese cliente** -- ese cliente (Admin y su portal) ve
  su versión custom del paquete; los demás clientes siguen viendo la
  versión general de Developer > Package contents. Se guarda en la
  lista **ClientPackages** (columnas `ClientID`, `PackageSKU`, `Items`
  -- ya existen en SharePoint, creadas por el dueño, AÚN SIN USAR).
- Tarjeta marcada "Custom for <ClientID>" (verde) cuando el cliente
  tiene su propia versión, con link **"Reset to standard"** para
  volver a la general.
- **Bug a corregir del mini** (no está en el código real, es del
  preview): la etiqueta debe pasar a "Custom" solo AL GUARDAR (Save),
  no apenas se entra a editar.
- **3 supuestos que el dueño vio en el mini y no objetó explícitamente
  -- confirmar con un "sí" antes de construir, no asumir silencio como
  aprobación total:**
  1. Si después se edita la versión GENERAL del paquete en Developer,
     un cliente que ya tiene su propia versión custom **se queda con
     la suya** (no se le actualiza solo).
  2. "Reset to standard" tira la versión custom y vuelve a lo que haya
     en Developer.
  3. Cada ORDEN sigue congelando su propia copia el día que se crea
     (Orders.PackageContents, sin cambios) -- editar aquí solo afecta
     qué usarán las órdenes NUEVAS de ese cliente.
- Relacionado, mencionado por el dueño y aún sin resolver: que
  cualquier servicio (no solo categoría "Package") se pueda armar como
  paquete desde su propia fila -- ej. "Janitorial Service (Part Time -
  Day)" 111-33. Confirmar en qué pantalla antes de construir (Service
  Catalog o Service Times -- la captura que mandó el dueño era de
  Service Times).

### Reglas ya confirmadas esta sesión, aplican a todo lo nuevo

- **Commercial es el default en TODO picker/toggle nuevo** que se
  agregue de aquí en adelante ("siempre deben estar en Commercial por
  defecto, lo residencial es poco y opcional"). Ya se audito y
  corrigio TODO lo existente (ver mas abajo) -- pero cualquier picker
  NUEVO que se construya debe nacer asi, no hace falta que el dueño lo
  vuelva a pedir.
- **Antes de construir algo con layout/diseño nuevo, mini primero.**
  Varias veces en esta sesión se construyó código sin mini y hubo que
  revertir o corregir (ver "Aprendido" abajo). El dueño SÍ quiere
  velocidad ("al mal paso, dale prisa") pero para BUGS y ajustes
  puntuales, no para diseño nuevo.
- **Antes de decidir DÓNDE va algo en la UI, preguntar.** El dueño lo
  pidió explícitamente tras un error real (ver "Aprendido").

### Aprendido esta sesión (para no repetir)

- Se agregó una tarjeta nueva "Recurring option in the client portal"
  en Developer sin preguntar dónde -- el dueño ya tenía un patrón
  (casillas por cliente en All Clients, junto a "Show Est. Time") y
  quería la opción AHÍ. Se revirtió y se rehizo en su lugar. Lección:
  con features que tocan una pantalla que ya existe, preguntar "¿dónde
  lo quieres?" ANTES de construir, no asumir el lugar "lógico".
- El picker de servicios dentro de Package contents (Developer) se
  construyó en modo simple sin el picker de tarjetas real (toggle,
  niveles, columnas) -- el dueño lo notó de inmediato ("y los niveles?
  pr que esta todo largo asi"). Se corrigió para usar el MISMO
  GSServicePicker que todo lo demás.
- El dropdown de paquetes en Package contents mezclaba Commercial y
  Residential ordenados solo alfabéticamente -- si un Residential caía
  primero en el alfabeto, la tarjeta abría ahí. Corregido: Commercial
  siempre primero y default.
- Las tarjetas de Developer se controlan por una lista de "elegibles
  por rol" -- una tarjeta nueva (Package contents) se agregó sin
  meterla a esa lista y quedó invisible para todos, sin que ningún
  test lo detectara porque las pruebas abrían la tarjeta por código en
  vez de navegar como un usuario real. Lección: probar features de
  Developer entrando con un rol real y viendo qué se muestra, no solo
  llamando las funciones directo.
- La columna `Value` de la lista `Settings` en SharePoint no acepta
  textos largos (JSON de áreas/paquetes tronaba con "Invalid request",
  en silencio, en cada carga de Admin). Se resolvió DE RAÍZ pidiéndole
  al dueño columnas reales en SharePoint (`Areas`, `PackageItems`,
  `Level2Price`/`Level2Mode`, `Level3Price`/`Level3Mode` en
  ServicesCatalog; `ShowRecurring`/`ShowPrices` en Clients;
  `PackageContents` en Orders; lista `ClientPackages` nueva) en vez de
  seguir partiendo JSON en pedazos. El dueño fue explícito: "si se
  ocupan nuevas columnas, las hacemos, no vayas a revolver cosas" --
  criterio a seguir para lo que sigue (paquetes por cliente
  incluido: usar ClientPackages, no otro truco).

### Dónde quedó cada pieza grande (todo en producción)

- **Picker de servicios (gsocd-shared), v1.56.0 actual:**
  toggle Recurring/Units, Common Areas en tarjetas por área (la del
  lugar se abre sola), paquetes como plantilla en Units (aunque no
  tengan contenido: "Contents not set yet"), precios opcionales
  (`showPrices`, con precio por nivel si el servicio lo tiene).
  `multi-select` v1.54.0 (dropdown con buscador, usado en Developer).
- **Áreas, contenido de paquetes y precio por nivel:** vive en
  columnas reales de ServicesCatalog (ver arriba). Se editan en
  Developer > Service Catalog (Areas) y Developer > Package contents
  (contenido + nada de precio ahí); precio por nivel en Developer >
  Service Times (columnas Level 2 price / Level 3 price, +% o +$).
- **Cada ORDEN congela su propia copia** de lo que incluía un paquete
  el día que se creó (columna `Orders.PackageContents`) -- cambiar el
  paquete después solo afecta órdenes nuevas. Las cotizaciones a
  QuickBooks mandan esa copia en la descripción de la línea, con SKU.
- **Clients > Create Order,** tarjeta de cada cliente: Client ID antes
  del nombre; "+ Add Order" y el toggle **Custom** en la misma línea
  del encabezado (arriba, no abajo). Custom abre oficina (días/horario,
  con fichas redondas y barra del día) + lo que ve en su portal (Show
  estimated time, Show Recurring, Show prices) -- se guarda solo al
  tocarlo, en columnas de Clients.
- **Developer > Customers > All Clients** = cambios en masa: 1) tarjeta
  de QUÉ cambiar (con su propio valor y su propia selección de
  clientes, no se pisan entre sí), 2) A QUIÉN, 3) "Apply N changes"
  aplica todas las tarjetas armadas de un golpe.
- **Developer > Settings** agrupado en Access / Imports / Tools.
  Reports se quedó solo con el Recurring Scheduler.
- **Auth:** Admin exige token de Microsoft válido en cada petición
  (excepto site-image, quickbooks-callback, cron). Verificado sin
  huecos (barrido Puppeteer de todas las pestañas).

### Pendientes sueltos, sin resolver, mencionados pero no retomados

- Auth: el mismo hueco (confiar en clientId/techId sin verificar)
  sigue existiendo en Orders y Tech -- no tienen login de Microsoft.
  Necesita su propia solución de sesión.
- QuickBooks sigue en modo sandbox -- pasar a producción antes de
  construir el sync automático App<->QuickBooks de clientes (ambas
  direcciones, ya diseñado, no construido -- ver NOTES_ARCHIVE.md o
  buscar "QuickBooks sync" en el historial del chat si hace falta el
  detalle).
- Botón temporal "Fill with Equitable (test)" en Recurring, sigue en
  producción a propósito -- quitar cuando ya no sirva para probar.
- Set real minutes / precios en servicios que hoy usan placeholders.

---

## SUBIDO (23/09/2026): columnas reales (fin de los JSON en Settings)

El dueño creó las columnas en SharePoint; el código ya las usa:
- **ServicesCatalog:** `Areas` (JSON lista), `PackageItems` (JSON
  [{sku, level}]), `Level2Price`/`Level2Mode`, `Level3Price`/`Level3Mode`
  (Percent | Dollar; Level 1 = precio de QuickBooks).
- **Clients:** `ShowRecurring`, `ShowPrices` (Sí/No), junto a
  `ShowEstimatedTime`.
- **Orders:** `PackageContents` (JSON): la copia congelada de lo que
  incluyó cada paquete en esa orden (antes iba en OrderHistory).
- **ClientPackages** (`ClientID`, `PackageSKU`, `Items`): lista nueva,
  todavía sin usar (versión del paquete por cliente, lo que sigue).
- Helpers iguales en Admin/Orders/Tech: `lib/catalog-fields.js`.
- `migrateToColumns()` (developer-admin.js) corre UNA vez al cargar el
  catálogo: pasa lo que hubiera en Settings (o los borradores del mini)
  a las columnas, solo llena lo vacío, y deja `columns_migrated` en
  Settings. `lib/settings-json.js` se queda solo para esa lectura.

## SUBIDO (23/09/2026): cambios en masa + precios en el portal + precio por nivel

- **Developer > Customers > All Clients** = cambios en masa (aprobado con
  mini): 1) UN cambio (Office days, Office hours, Estimated time,
  Recurring, Prices, Status) y su valor, 2) a quién (cada cliente muestra
  cómo lo tiene hoy), 3) Apply. Acción `bulk-update-clients`.
- **Precios en el portal:** apagados para todos por default; se prenden
  por cliente (Create Order > Custom > Show prices) o en masa. Settings
  `portal_price_clients`. El portal los pide en get-services
  (`pricesAllowed`) y el picker (gsocd-shared **v1.55.0**, `showPrices`)
  los muestra junto a cada servicio y paquete ("Included" adentro).
- **Precio por nivel:** QuickBooks = UN precio por servicio = Level 1.
  Developer > Service Times: Level 2 / Level 3 suman % o $ (Settings
  `catalog_level_prices`). El portal muestra el precio del nivel elegido;
  las cotizaciones a QuickBooks mandan ese precio como precio de la
  línea (el artículo en QuickBooks nunca se reescribe).

## REEMPLAZADA por la regla del 25/09/2026 de arriba -- (21/09/2026): los Previews de Vercel NO le sirven al dueño para probar -- login de Azure lo rechaza

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
- **Parte 2 SUBIDA (mismo día):** gsocd-shared **v1.52.0** — en Units,
  los paquetes salen como plantilla (tarjeta con lo que incluye; elegir
  el nivel del paquete = usarlo). La orden guarda **solo la línea del
  paquete** (QuickBooks factura solo eso, confirmado por el dueño); lo
  que incluye se muestra con `pkgIncludesHtml()` (Approvals/Active/
  History) desde el contenido actual del paquete. Contenido por paquete
  en Settings (`catalog_package_contents`, default = borrador del mini),
  editable en **Developer > Package contents**. Create Order arranca en
  Units (Janitorial/Mixed).
- **Cada orden guarda SUS datos (pedido del dueño, mismo día):** al
  crear una orden con paquete (submit-order, los 4 caminos) o agregarle
  uno al editarla (admin-update-order), se congela lo que incluía ESE
  día en su historial: ChangeType `Package Snapshot`, FieldChanged
  `Office Change (Internal)` (el cliente no lo ve; Admin lo saca de la
  línea de tiempo con `withoutPkgSnapshots`). `pkgIncludesHtml(sku,
  orderId)` muestra SOLO esa foto; órdenes de antes no muestran nada
  (igual que siempre). Cambiar un paquete afecta solo órdenes nuevas.
  Lógica en `lib/package-contents.js` (también el default).
- **Areas en Developer:** dropdown bonito (gsocd-shared **v1.53.0**,
  `multi-select`), se guarda al cerrarlo; solo Janitorial.
- **Portal del cliente y Tech (mismo día):** leen `catalog_service_areas`
  y `catalog_package_contents` de Settings (Admin los deja escritos la
  primera vez que carga el catálogo; ellos no tienen defaults). Orders:
  picker v1.52.0 (Create Order arranca en Units), foto al crear órdenes
  (sus 4 caminos) y "Includes" en tracking desde la foto. Tech:
  get-my-orders manda `PackageSnapshots` por orden y el técnico ve el
  checklist bajo el paquete; supervisor con el toggle. Admin también
  congela al aprobar un cambio que agrega paquete (admin-approve-order).

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

## DESCARTADO (23/09/2026): diseño viejo de Recurring por piso/amenidad (38 amenidades)

Reemplazado el mismo día por "Recurring 'Who does what' por lugar" (ver
arriba): lugares con building/floor/zona en vez de una lista fija de 38
amenidades. Se dejó de diseñar a medio camino (pendientes sin resolver:
si Elevators/Stairs eran la única excepción "de todo el edificio", y si
el equipo propio vive por día o por piso) — no se retomó y no hace falta
retomarlo salvo que el dueño lo pida explícitamente.

