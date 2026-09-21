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
Por regla del dueño (confirmada 10/09/2026): este acordeón es el estándar
en TODO lugar de Admin u Orders donde se pone o edita una orden — no
aplica a Tech (ahí nunca se crean órdenes). Los 5 lugares reales hoy (verificado
contra el código, 15/09/2026): `appr-` (Approvals > Update) en Admin,
`create-order` en Admin, `customer-order` en Orders, más `tpl-admin` (Admin)
y `template-editor` (Orders) para plantillas.

**Excepción confirmada:** Active (`admin.html`) YA NO usa este acordeón para
editar servicios de una orden en curso -- el rediseño del 15/09/2026 lo
reemplazó por una lista editable en línea (X/undo por servicio, pills
L1/L2/L3 para Janitorial), sin categorías. El código viejo que montaba el
acordeón ahí (`buildServiceRows`/`mountAdminServicePicker`/
`buildAdminLegacyNote`) se dejó de llamar en ese rediseño pero no se borró
hasta ahora (15/09/2026) -- quedó como código muerto que hacía parecer que
Active seguía usando el acordeón cuando ya no era cierto. Se confirmó con
el dueño que no hace falta reactivarlo, y se borró por completo.

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

## Regla nueva (19/09/2026): probar en un Preview de Vercel ANTES de pedir el "dale" a main -- no solo prometer que se probo

Motivo: una sesion anterior subio cambios directo a main sin permiso del
dueno (violando la regla de arriba), y otra dejo un bug real sin poder
probarlo de verdad antes de subirlo. Esto reemplaza "confio en que
funciona" por una forma de que el dueno lo vea funcionando de verdad,
en su propio celular, con datos reales, ANTES de que exista la
posibilidad de tocar produccion:

1. Cualquier cambio que vaya a subirse (no solo visual -- ver regla 3
   para el mini de UI, este paso es el que sigue DESPUES de eso, al
   tocar el repo real) se hace en una rama nueva creada desde
   `origin/main`, nunca commiteando directo a main. Nombre descriptivo,
   ej. `fix/services-requested-mobile-cards`.
2. Se hace `git push` de esa rama (con el token de GitHub). Vercel
   arma automaticamente un deployment de Preview para esa rama -- no
   hace falta configurar nada, es automatico en este proyecto (equipo
   "GS Solutions" en Vercel).
3. Para conseguir el link real del Preview (no adivinarlo): usar las
   herramientas de Vercel (`list_deployments` filtrando por `branch` y
   `slug: "gs-solutions1"`, luego `get_deployment` hasta que
   `readyState` sea `READY`). El campo `alias` del deployment trae la
   URL estable tipo
   `<proyecto>-git-<rama-slug>-gs-solutions1.vercel.app` -- ESA es la
   que se le manda al dueno, no la URL de un deployment individual
   (que cambia cada vez que se sube algo nuevo a la rama).
4. Esa URL alias NO cambia aunque se suban mas commits a la misma
   rama despues (para iterar un fix sin mandar un link nuevo cada
   vez) -- se le puede pedir al dueno que solo haga refresh.
5. Es el MISMO backend/datos reales que produccion (mismas
   SharePoint lists, mismo Graph), asi que el dueno puede probar con
   una orden real de verdad -- no es una simulacion.
6. Solo cuando el dueno prueba en ese link y dice explicitamente que
   se suba (ej. "dale", "subelo a produccion") se hace el merge de esa
   rama a `main` y el push a main (que es lo unico que de verdad toca
   orders.gsocd.com / admin.gsocd.com / tech.gsocd.com reales). Esto
   nunca se asume ni se hace por iniciativa propia, ni siquiera si el
   cambio "ya se probo y se ve bien" en el Preview -- ver la primera
   regla de este archivo.
7. Si algo sale mal despues de subir a la rama, se siguen iterando
   ahi (mas commits a la misma rama) -- production nunca se toca
   hasta que el dueno lo confirma, sin importar cuantas vueltas tome
   arreglarlo bien.


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
