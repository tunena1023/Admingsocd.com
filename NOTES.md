# NOTES.md — Cómo se trabaja en este proyecto

Este archivo existe para que cualquier chat de Claude (u otra persona) que entre
a este repo después no tenga que adivinar el proceso, ni repetir preguntas ya
resueltas, ni subir cosas sin permiso. Léelo completo antes de tocar código.

## Reglas de trabajo con el dueño del proyecto

1. **Nada se sube al repo sin permiso explícito.** El dueño dice cómo quiere
   que algo funcione (el resultado, no el código línea por línea). Quien
   programa se inventa la forma técnica de lograrlo, pero antes de tocar el
   repo real, regresa y explica: "encontré esto, funciona así, ¿le entro?" —
   sobre todo si hay una decisión de por medio (crear una columna nueva,
   elegir entre 2 formas de resolverlo, etc.). Solo con un "dale"/"súbelo"
   explícito se sube. Sin excepción, aunque el fix se vea obvio.

2. **No asumas silenciosamente.** Si algo es ambiguo, o si el código actual
   sugiere un mecanismo distinto al que el dueño describe, se pregunta o se
   verifica ANTES de decidir por cuenta propia. Leer el código para entender
   cómo funciona hoy está bien y se espera — pero eso no reemplaza confirmar
   qué se quiere que pase.

3. **"Minis" antes de tocar UI/visual.** Para cualquier cambio visual o de
   comportamiento de interfaz, se arma una vista previa interactiva (HTML
   autocontenido, publicado como artifact) ANTES de tocar el repo real. Si
   el cambio usa un componente de `gsocd-shared`, el mini debe inyectar el
   componente REAL (el archivo tal cual, no una reconstrucción) para que lo
   que se prueba sea exactamente el comportamiento real, no una simulación.

4. **Los cambios se pueden acumular en local sin subir.** El dueño puede
   pedir varios cambios seguidos y decir "no subas nada todavía" — en ese
   caso los cambios se hacen sobre copias locales (en el sandbox de la
   sesión) y se van apilando, hasta que se den todos juntos con un solo
   "dale". Cuando esto pase, quien retome la conversación (aunque sea otra
   sesión) debe saber que puede haber cambios locales sin commitear — si el
   dueño menciona algo que "quedó pendiente" y no aparece en el repo, no es
   un error, probablemente sigue en el sandbox de la sesión anterior sin
   subir. Pregúntale directo si quiere que se rehaga o si ya se perdió.

5. **Cada commit debe explicar el porqué, no solo el qué.** El mensaje de
   commit tiene que ser lo bastante específico para que una sesión nueva
   entienda el contexto completo sin tener que re-investigar: qué problema
   real se encontró, por qué se eligió esa solución y no otra, y si hay
   trade-offs o casos que se dejaron fuera a propósito.

6. **El tono del dueño es directo y con groserías — no es un ataque
   personal, es como habla.** Se puede hablar de igual a igual, con más
   soltura de la que se usaría normalmente, sin necesidad de ser cortante
   ni de disculparse en exceso. Dicho eso: no hay que auto-insultarse ni
   quedarse callado si algo cruza a un insulto directo — se puede reconocer
   el error real sin necesidad de repetir el insulto.

7. **Antes de subir CUALQUIER cambio al repo (aunque ya esté "confirmado" y
   listo para el commit), hay que revisarlo de punta a punta como si fuera
   un caso real** — seguir el flujo completo, paso a paso, desde que algo
   se crea/pide hasta que se completa/cierra, buscando específicamente: dos
   flujos que puedan pisarse o duplicarse, un dato que se pierda en el
   camino entre una pantalla y otra, una pantalla que no se entere de un
   cambio que hizo otra, y campos usados en el código que no coincidan con
   lo documentado como columnas necesarias en SharePoint. Esto no es
   opcional ni solo para features grandes — es el último paso antes de
   cualquier "dale", cada vez. En esta sesión, esta revisión encontró 7
   bugs reales que el código "ya terminado" traía escondidos — ninguno era
   un error de sintaxis (esos ya se habían validado con `node --check`),
   todos eran de lógica: cosas que se ven perfectas archivo por archivo
   pero fallan en la costura entre dos archivos.

8. **Todo cambio visual o de comportamiento se considera en mobile ANTES de
   proponerlo o subirlo — no después.** No basta con que se vea bien en
   desktop. En la sesión del 13/09/2026 esto se pasó por alto varias veces
   seguidas sobre el mismo componente compartido
   (`gsocd-shared/order-form-premium`): un fix se probaba, se declaraba
   listo, se subía, y el dueño encontraba en su propio celular que seguía
   roto — o que se veía distinto entre Admin y Orders aunque los dos usan
   el mismo componente, porque el padding/contexto que lo envuelve en cada
   app es distinto. Esto obligó a repetir el mismo ciclo de investigación
   3-4 veces sobre lo mismo (filas de unidad, pestañas de división, padding
   de tarjetas). La lección: antes de decir "ya está" sobre cualquier
   componente visual — sobre todo uno compartido, usado en más de un lugar
   — hay que verificar con un render real (no solo leer el CSS) a un ancho
   angosto realista (320-375px, el peor caso siendo un iPhone SE de 320px),
   y hacerlo DENTRO de cada contexto donde ese componente se usa, no solo
   uno — un componente puede verse perfecto en una pantalla y roto en otra
   por lo que lo rodea, no por el componente en sí.

## Mapa de la arquitectura (para no perderse)

**4 repos, todos de `tunena1023` en GitHub, cada uno su propio proyecto en
Vercel (equipo "GS Solutions"):**

| Repo | Dominio | Para quién | Notas |
|---|---|---|---|
| `tech.gsocd.com` | tech.gsocd.com | Empleados/supervisores en campo | Login por QR + DeviceToken (sin password). Nunca se crean órdenes aquí. |
| `Admingsocd.com` | admin.gsocd.com | Oficina/staff | Aprobar órdenes, catálogo de servicios, scheduling |
| `ordersgsocd.com` | orders.gsocd.com | Clientes | Pedir servicio, tracking, portal de cliente |
| `gsocd-shared` | — (no se despliega) | — | Componentes de UI reutilizados por los 3 portales, vía jsDelivr + git tags |

**Cómo se consume `gsocd-shared`:** cada componente se referencia en el HTML
con una URL fija a una versión (`https://cdn.jsdelivr.net/gh/tunena1023/
gsocd-shared@vX.X.X/nombre-componente/archivo.js`). Los tags son de TODO el
repo (no por componente), así que subir un fix implica: 1) editar el archivo
en `main`, 2) crear un tag nuevo (`git/refs` con `refs/tags/vX.X.X` apuntando
al commit), 3) actualizar el `<script src>` en cada HTML que lo usa a la
versión nueva. Sin el paso 3, el fix vive en el repo pero nadie lo usa
todavía — cada consumidor está pegado a la versión que tenga escrita.

**El catálogo de servicios tiene 2 listas de SharePoint, NO conectadas entre
sí por el sistema — son fuentes independientes, a propósito:**
- **`ServicesCatalog`** — SKUs importados de QuickBooks (Division,
  PropertyType, Price, ServiceName se sobreescriben en cada import). El
  campo `Category` es la ÚNICA excepción: el import nunca la toca, se
  mantiene a mano desde `developer.html` > tab "Services" (botón junto a
  cada renglón). Esta es la lista real que alimenta el selector de
  servicios en TODO lugar donde se pone o edita una orden.
- **`Services`** — lista vieja, migrada de un Excel el 30/08/2026. Ya no es
  la fuente real para nada activo del selector de servicios nuevo (ver
  historial de conversación del 10/09/2026 para el porqué se descartó como
  fuente — quedó documentado ahí que mezclar las 2 listas fue un error).

**El selector de servicios compartido (`gsocd-shared/service-picker`)**
tiene una opción `groupByCategory: true` que agrupa por `Category` en un
acordeón (categorías sin asignar caen en "Uncategorized", nunca se pierden).
Por regla del dueño (confirmada 10/09/2026): **este acordeón es el estándar
en TODO lugar de Admin u Orders donde se pone o edita una orden** — no
aplica a Tech (ahí nunca se crean órdenes). Los 6 lugares que existen hoy:
`create-order` y `appr-`/`admin-` (edición) en Admin, `customer-order` en
Orders, más `tpl-admin` (Admin) y `template-editor` (Orders) para
plantillas — estos últimos 2 se estandarizaron el 10/09/2026, antes se
habían quedado en una versión vieja del componente sin el acordeón.

## Pendientes conocidos (al 10/09/2026)

- El **sistema de servicios recurrentes** (ubicaciones/clientes con
  servicio recurrente, técnico asignado que ve y marca servicios como
  hechos) está apenas empezado — no es funcional todavía. Documento de
  referencia pendiente de analizar con el dueño.
- **En local, sin subir al repo:** fix en `service-picker.js` para que solo
  una categoría del acordeón esté abierta a la vez (hoy se pueden abrir
  varias al mismo tiempo). Vive en el sandbox de la sesión del 10/09/2026,
  no en GitHub — si no aparece en el repo y no se sabe por qué, es por esto.
- **RESUELTO (confirmado por el dueño, 13/09/2026):** banner "File
  downloaded... sharepoint.com" en Tech (portal de empleados, celular) —
  el fondo o logo se descargaba como archivo en vez de solo mostrarse.
  `site-image.js` de Tech ya sirve el buffer con `Content-Type` correcto
  por extensión y sin `Content-Disposition: attachment`. No quedó
  registrado en un commit con ese nombre específico — probablemente se
  arregló junto con otro cambio a `site-image.js`/`lib/graph.js`.
- 404 de `Logo.jpg` / `NavBackground.jpg` en Orders (`/api/site-image`) —
  pendiente de que el dueño confirme el nombre real de esos archivos en la
  raíz del drive de SharePoint (Onlineorders).
- **BUG REAL arreglado (12/09/2026): `devApi` no existia en admin.html.**
  Al fusionar developer.html dentro de admin.html (mismo dia), se
  renombraron todas las llamadas de su `api()` original a `devApi()`
  (para no chocar con el `api(path, opts)` generico que ya tenia
  admin.html) -- pero la funcion en si nunca se copio. Todo Developer
  (whoami, Staff, Techs, catalogo, Recurring, Service Times) llamaba a
  una funcion inexistente, capturado en silencio por cada try/catch
  -- por eso nunca se vio el error real hasta que la consola mostro
  "devApi is not defined". Se agrego `devApi(action, extra)`, identica
  a la `api()` original de developer.html. Leccion para la proxima
  fusion de paginas sueltas: cuando se renombra una funcion para
  evitar choque de nombres, verificar explicitamente que la funcion
  renombrada tambien se haya copiado -- no solo sus llamadas.
- **Pendiente menor, sin resolver:** la barra dorada de pestañas se ve
  "ligeramente más grande" en Admin que en Orders/Tech, aun usando el
  mismo `nav-premium.js` compartido (mismo CSS, confirmado byte por
  byte). Se probaron 2 hipótesis con medición real en navegador (badges
  de contador SI/NO, font-family del body) y ninguna mostró diferencia
  medible — puede ser una diferencia real muy chica (1-2px) o solo
  percepción por el zoom del navegador. La usuaria decidió dejarlo así
  por ahora, no vale la pena seguirle. Si se retoma: medir con
  `getBoundingClientRect()` en las 2 apps reales (no en un test
  aislado) para descartar que sea algo del layout completo de la
  página, no solo del componente.

## Cómo conectarse (para que una sesión nueva no tenga que preguntar)

**Vercel:** ya está disponible como conector en Claude -- no requiere token,
solo usar las herramientas Vercel: list_teams / list_projects / get_project
etc. Team: "GS Solutions" (team_JW18RqqLyzjaO9nYs4NWVAVA).

**GitHub:** NO hay conector instalado en Claude -- no existe, no hay que
buscarlo dos veces. La unica forma de acceso es que el dueño pegue un
Personal Access Token (fine-grained, scope: Contents Read/Write + Metadata
Read, limitado a los 3 repos de tunena1023) directo en el chat. Con ese
token se clonan los repos por HTTPS (`git clone https://<token>@github.com/
tunena1023/<repo>.git`). El token NO se guarda entre sesiones -- se pide
uno nuevo cada vez, y el dueño lo revoca al terminar.

Repos: tunena1023/Admingsocd.com, tunena1023/tech.gsocd.com,
tunena1023/ordersgsocd.com.


## Regla reforzada (12/09/2026): nunca tocar codigo en produccion directo

Todo cambio de codigo se hace SIEMPRE sobre la copia local del repo (el
sandbox de la sesion), nunca hay edicion directa a lo ya desplegado. El
commit + push (que dispara el deploy en Vercel) SOLO pasa cuando el dueño
lo autoriza explicitamente para ESE cambio puntual -- una autorizacion
general de "asi trabajamos" no cuenta como luz verde para subir algo
especifico. Si el dueño pide varios ajustes seguidos, se acumulan en
local (ver regla 4 de arriba) hasta que diga que los suba.


## Regla reforzada (12/09/2026): leer TODO este archivo antes de tocar nada

Antes de tocar codigo, revisar un bug, o proponer un cambio -- lo primero,
siempre, es leer este NOTES.md completo (los 3 repos, no solo el que se
va a tocar, porque comparten arquitectura y gsocd-shared). No asumir que
"ya se sabe" el contexto de sesiones anteriores sin haber leido esta
version actual del archivo -- puede haber pendientes, decisiones o
cambios en local sin subir que cambian por completo cual es la forma
correcta de resolver algo.


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

