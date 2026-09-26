# HANDOFF.md — Léelo PRIMERO (antes que todo lo demás)

> **Regla de este archivo (pedido del dueño, 25/09/2026):** cualquier sesión
> puede terminar de golpe. Por eso, **en cada cambio** (cada commit, cada
> decisión del dueño, cada cosa que quede a medias), la sesión que esté
> trabajando **borra este archivo y lo escribe de nuevo** con el estado real
> de ese momento: qué se hizo, qué está subido, qué está solo en local, qué
> sigue. No se le agregan capas encima: se reescribe completo, corto y al día.
> Lo viejo que ya no aplica se va a NOTES.md (historial), no se queda aquí.
>
> Este archivo se sube junto con cada push que el dueño autorice. Si el
> dueño no ha autorizado un push, se deja escrito en local igual y se le
> avisa: "el handoff está al día pero no subido; si la sesión se cae, se pierde".

Última actualización: 26/09/2026, sesión `claude/brave-hopper-6t1lxt`.

> **LO MÁS NUEVO — empieza por aquí:** el dueño pidió proteger TODA la
> información de GSMS (respaldos y regresar a como estaba) y que los cambios
> hechos en GSMS lleguen a QuickBooks al instante, con Undo. Plan completo, paso
> a paso, con lo hecho, lo que falta y cómo subirlo: **PLAN-RESPALDOS.md**
> (sección 2 = estado; sección 7 = casillas). Todo está en la rama
> `claude/brave-hopper-6t1lxt` (PR tunena1023/Admingsocd.com#2) y en la rama del
> mismo nombre de ordersgsocd.com. **Nada de eso está en `main`/producción**:
> falta el "dale" del dueño para producción y que ponga `QB_SYNC_SECRET` en Vercel.

---

## 0. Antes de tocar nada

1. Lee **WORKFLOW.md** (reglas fijas) y luego este archivo completo.
2. Revisa **NOTES.md** (historial y pendientes grandes; su sección de arriba
   "PENDIENTE PARA OTRO CHAT (26/09/2026)" trae el plan paso a paso para partir
   admin.html, el código compartido y las pruebas).
3. Haz `git fetch` de los 4 repos y compara con lo que dice la sección 3.
   Si no cuadra, **pregúntale al dueño** antes de asumir nada.

## 1. El dueño y cómo se trabaja (NO negociable)

- Habla español casual, directo, con groserías. No es ataque. Se le contesta
  en español casual. **Toda la interfaz (UI) va en inglés**, siempre.
- **Nada se sube sin permiso explícito** ("dale", "súbelo", "sube todo").
  Si un hook o aviso automático pide push, no cuenta como permiso: se declina.
- **Mini antes de cualquier cambio de UI**: con la app real (admin.html tal
  cual + API simulada), revisado a **ancho de teléfono (390px)** y escritorio,
  sin scroll horizontal. Mandarle capturas o el mini al dueño.
- Commits que expliquen **el porqué** (qué problema real, por qué así).
- No inventar ni asumir: si hay duda de cómo lo quiere, se le pregunta.
- "Luego me hacen cochinadas": lo que más le ha dolido es (a) que suban sin
  permiso, (b) que cambien cosas que no pidió, (c) UI en español o con notas
  informativas que no pidió, (d) que algo se llene "a mano" cuando dijo que
  nada a mano, (e) que prometan que se probó sin probar. Checklist antes de
  cada push: sección 7.

## 2. Repos y cómo se despliega

| Repo | Sitio | Cómo se sube |
|---|---|---|
| `tunena1023/Admingsocd.com` | admin.gsocd.com | `main` = producción. Rama de trabajo `claude/otros-proyectos-wxj0o7` (se sube a las dos). Para pruebas: `git push --force origin <rama>:preview` → **solo** https://test-admin.gsocd.com (el force-push necesita OK del dueño). |
| `tunena1023/ordersgsocd.com` | orders.gsocd.com | directo a `main` con OK del dueño. |
| `tunena1023/tech.gsocd.com` | tech.gsocd.com | directo a `main` con OK del dueño. |
| `tunena1023/gsocd-shared` | componentes por jsDelivr | a `main`. **Se sube PRIMERO**, porque los otros apuntan a su commit. |

- Los componentes de gsocd-shared se cargan **fijados por SHA** desde
  `cdn.jsdelivr.net/gh/tunena1023/gsocd-shared@<sha>/...`. Si cambias uno,
  commit en shared → cambia el SHA en cada HTML que lo use → sube shared
  antes que los demás. Hoy `order-history.js` se usa en: Admin `admin.html`,
  Orders `customer.html`, Tech `employee.html` y `supervisor.html`.
- Proyectos Vercel: `admingsocd-com`, orders, tech. Hay conector de Vercel
  (env vars, deployments, logs). Preview siempre con `NOTIFY_MODE=test`.
- Backend: Vercel serverless, un solo router `api/[...slug].js` (PUBLIC_SLUGS,
  pone `x-gs-user-email` después de verificar el token). Datos en SharePoint
  (Microsoft Graph).

## 3. Estado al escribir esto

Subido (con OK del dueño, "sube todo lo que teníamos pendiente"):
- **gsocd-shared** `d309c93`: historial y PDF: programar una orden por
  servicio = **un solo evento** (se absorbe "Order Moved To Active").
- **Admin** `100dff6`: QuickBooks, adjuntar todas las fotos de la orden al
  estimate/invoice (Before/After, IncludeOnSend). **No probado contra la API real.**
- **Admin** `1d416a0`: Schedule, tarjeta "Partly scheduled / Scheduled" y
  sección "Scheduled, work in progress"; `admin-get-orders` manda
  `AssignByServiceProgress`; PDF con un solo evento; nuevo pin del shared.
- **Orders** `86f6c1d`: tracker del cliente, PDF e historial con un solo evento.
- **Tech** `dd914b6`: nuevo pin del shared.
- Este HANDOFF.md.

Subido el 26/09/2026 (dueño: "súbelo a producción y ya"):
- **Documents arreglado en Admin, Orders y Tech** (`lib/order-docs.js`, igual en
  los 3, y los handlers `order-docs.js`). Causa: en `OrderDocuments` la columna
  **OrderID es la Title renombrada** (nombre interno `Title`), y el código
  escribía `OrderID` y usaba Title para el nombre del archivo. Ahora el
  OrderID va en `Title`, y el nombre que se ve sale del archivo en SharePoint
  (sin el stamp), 20 por llamada con `$batch`. Si falla el renglón, se borra
  el archivo (no quedan sueltos) y el mensaje dice qué columna falta. En
  Orders el cliente ve solo "The document could not be saved. Please try
  again later." Probado con la lista simulada tal cual la tiene el dueño;
  **Probado en real desde Orders (26/09/2026, 00:43 UTC): subió bien.** Falta
  probar desde Admin.
- **Orders: caída del 26/09/2026 (00:17–00:27 UTC), RESUELTA 00:41 UTC.** Alguien
  con el usuario de Vercel del dueño cambió `GRAPH_CLIENT_ID` y
  `GRAPH_CLIENT_SECRET` de Production en `orders.gsocd.com`; el deploy siguiente
  salió con valores que Microsoft rechazó y nadie podía entrar al portal. Se hizo
  rollback, se regresó `GRAPH_CLIENT_ID` al Application ID bueno (empieza con
  `18dfcf2e`), el dueño puso un secret nuevo en `GRAPH_CLIENT_SECRET` de
  Production, y se promovió `dpl_HxCPSLmMhzna4AjatLiJFM71cWee` (`b38a985`, con el
  arreglo de Documents). Probado en orders.gsocd.com: Graph contesta bien.
  Ojo: Orders Production usa el secret NUEVO; Orders Preview, Admin y Tech siguen
  con el viejo. El viejo sigue escrito en `ordersgsocd.com/lib/graph.js` (repo
  público): pendiente quitarlo del código y, cuando se pueda, cambiar el secret
  en todos lados.
- **SUBIDO (26/09/2026, `d7f99d8`, "súbelo a producción"):** Admin, botón "Upload
  document" en la misma fila que los demás botones de la orden (Approvals:
  Approve/Bypass · Review: Print · Active/History: Print/Completed/Cancelled),
  para ahorrar espacio. La caja "Documents" solo sale si la orden tiene
  documentos; el texto "PDF, Word or text files (up to 25 MB)..." pasó al tooltip
  del botón. En órdenes en inspección el botón se queda en la caja como antes.
  En Review, Print y Upload van al final de la fila de la decisión (Reassign /
  Reschedule / Cancel...), ya no en fila aparte. Mini (admin.html real, API
  simulada): https://claude.ai/artifact/Xr5oFk38yXr3c9Kp7guqHn
  Revisado después del deploy: los 8 tabs de Admin abren sin errores (1280 y 390),
  admin.gsocd.com sirve el código nuevo, y los 3 proyectos solo tienen el aviso de
  `url.parse()` (deprecation de Node, no es falla).
- **SUBIDO A PRODUCCIÓN (26/09/2026, "ándale, súbelo"): filas de botones iguales en los 3 portales.**
  Verificado: los 3 deploys READY y admin/orders/tech sirven los pins nuevos.
  - gsocd-shared: `action-row/action-row.js` nuevo (clase `gs-act-row`: escritorio en una fila;
    teléfono de dos en dos, mismo ancho) y `doc-viewer` con la tira chiquita de documentos
    (`addButtonHtml` "+", `iconsHtml` iconos + "Gallery →", `stripMsgHtml`). Commits locales
    e41c4c2, 2e048e5, de10f09, 68efbd7 (pins: action-row `68efbd7…`, doc-viewer `de10f09…`).
  - Admin (7439868, 44619e6), Orders (84c4734, 872690e), Tech (5fb6747, 85f175b) usan las dos.
    En Orders ya no hay cajas "Photos"/"Documents" dentro de la orden: cámara (solo teléfono),
    "+" e iconos van en la fila de botones y abren Gallery > Docs filtrado.
  - Mini de los 3: https://claude.ai/artifact/1HNZFdjgSXZVXvdHFj7AwR
  - Subido en orden: gsocd-shared 68efbd7 → Admin → Orders 872690e → Tech 85f175b.
- Notas: pendiente de Yardi/AppFolio/Entrata/RealPage, etapa de investigación.

Subido el 26/09/2026 (dueño: "quita esa llave de orders ... sube eso a deploy"):
- **Orders `311e84b`**: `lib/graph.js` ya no trae escritos tenant/client ID/secret de
  Graph; lee solo las `GRAPH_*` de Vercel (confirmadas en production, preview y
  development antes de subir). Deploy READY y probado en vivo (`get-services` leyó
  SharePoint).

Solo en la rama `claude/brave-hopper-6t1lxt` de Admin (base `fb7abd5`), **sin producción**:
- `fea5007` Developer › Settings › Migrate from QuickBooks (lee los Items de QB por
  API, compara por SKU, respaldo antes de escribir; nunca pisa una descripción de
  GSMS con una más corta de QB).
- `5e77365` Respaldo diario del catálogo (en el cron de recurrentes, solo si cambió)
  y selector de respaldos con vista previa antes de restaurar. Migrate bloqueado si
  `QUICKBOOKS_ENVIRONMENT` no es production (test-admin = QB sandbox + SharePoint real).
- Detalle, pruebas y mini: PLAN-RESPALDOS.md, sección 2.

Si al hacer `git fetch` algo de esto NO está en `origin`, el push falló o la
sesión se cayó antes: avísale al dueño.

## 4. Lo que sigue (en orden de prioridad)

0. **Respaldos / proteger toda la información (pedido del dueño 26/09).** Seguir
   **PLAN-RESPALDOS.md** (sección 7 = casillas de avance). Primero: "dale" del
   dueño para subir `fea5007` + `5e77365` y sus decisiones 1–4.
1. **Calendario por partes (pedido del dueño, NO empezado).** En órdenes
   "Assign by service" repartidas entre varias personas/fechas, el
   calendario debe mostrar cada parte por separado, en su día y con su
   persona: "Part 1 of 2 · Adalberto · Oct 2", "Part 2 of 2 · Azucena · Oct 3".
   - Hoy `calendar.html` solo acomoda la orden por `DispatchDate` y **no lee
     ServiceAssignments**.
   - `admin-get-orders.js` ya trae `assignmentRows` (ServiceAssignments por
     orden): agrupar por persona+fecha (`AssignedTo` separado por comas,
     `ScheduledDate`) y mandarlo como partes por orden.
   - Mini primero, a ancho de teléfono.
2. **Decisión ya tomada, no reabrir:** las órdenes por servicio se quedan en
   Schedule hasta que TODOS sus servicios estén Completed. Pasan a Active
   solas con el primer servicio programado (`save-service-assignment.js`).
   El dueño aceptó eso; lo que pidió fue ver el estado, y ya está hecho.
3. **QuickBooks, pruebas del dueño:** que mande una orden **con precios**
   como Estimate y confirme: precios, Unit #/Bedrooms/Bathrooms en sus campos
   personalizados, la fecha de cada línea (fecha en que se completó el
   servicio), Class, numeración continua. Luego probar "Attach photos" con
   una orden real.
4. Pendientes del lado del dueño (recordárselos, no hacerlos por él):
   - Índices de SharePoint (columna `OrderID` en ServiceAssignments y demás;
     ver `indices` en NOTES.md). Hoy se usa el header
     `Prefer: HonorNonIndexedQueriesWarningMayFailRandomly` como parche.
   - Columna `Clients.SelfRegistered` (booleana).
   - Crear en QuickBooks el Department "Mixed Services" (Commercial y Residential).
   - Precios del catálogo (otro día).
   - Opcional: `WIPE_PASSWORD` y `DIRECTOR_PASSWORD` también en Preview
     (hoy solo en Production; test-admin no tiene wipe).
5. **Etapa de investigación (no programar):** integración con Yardi,
   AppFolio, Entrata o RealPage, para platicarla con el dueño. Ver NOTES.md,
   "PENDIENTE, ETAPA DE INVESTIGACIÓN".
6. Proyectos grandes para otros chats: NOTES.md, sección "PENDIENTE PARA OTRO
   CHAT": (A) partir admin.html, (B) libs compartidas en gsocd-shared/server,
   (C) pruebas automáticas, (D) passwords.

## 5. QuickBooks: cómo funciona hoy (no cambiarlo sin que lo pida)

- OAuth con refresh token que rota; refresh de un solo vuelo (evita el
  "eTag mismatch"). Tokens en la lista Settings; en producción las llaves
  `qb_*` llevan prefijo `prod_` (excepto `qb_send_perms`). Los valores de
  Settings tienen límite de ~255 caracteres: se guardan en trozos con
  `lib/settings-json.js`.
- Mapeo que calza con el invoice real #5177:
  - `TxnDate` = día en que se crea el documento. `ServiceDate` de cada línea
    = día en que se **completó ese servicio**.
  - Numeración: sigue del número más alto que ya existe (usan números
    personalizados). Nunca sobrescribir ni reusar números.
  - Unit #, Bedrooms, Bathrooms van en sus **campos personalizados
    mejorados** (`minorversion=75&include=enhancedAllCustomFields`). Nunca en
    la descripción. Si falta un campo, **no se crea nada** (el dueño: "no
    quiero llenar nada a mano").
  - Class por línea según la división. Department solo en invoices:
    `"<Division> Services:<Commercial|Residential>"`; varias divisiones →
    `"Mixed Services:<tipo>"`. Estimates: Class sí, Department no.
  - El Level se queda en la descripción de la línea.
- Permiso Estimate/Invoice por persona: Developer › Staff & Roles. En el
  panel es un toggle; si la persona solo tiene una opción, sale bloqueado.
- **Ya NO se crean clientes solos al importar.** El cliente se da de alta o se
  actualiza desde QuickBooks › Clients (vistas Not in QuickBooks / Different /
  In QuickBooks, diferencias solo resaltadas) con el password del director.
- Sent: borrar de QuickBooks pide el password de borrar (`WIPE_PASSWORD`);
  si el documento ya no existe en QB sale "Not found in QuickBooks" y se
  puede regresar a Orders.

## 6. Seguridad (nunca romper)

- **Nunca** escribir, repetir ni guardar valores de secretos (tokens,
  passwords, client secrets). El dueño pega llaves en Vercel él mismo.
  No pedirle secretos por el chat.
- El dueño pegó un PAT de GitHub y enseñó el Client Secret de QuickBooks de
  producción en una captura en sesiones pasadas: se le recomendó rotarlos.
  Nunca reusarlos.
- **Hecho 26/09 (`311e84b`):** Orders `lib/graph.js` ya no trae escrito el secret
  de Graph. **Pendiente del dueño:** el secret viejo sigue en el historial de git
  (repo público) y lo siguen usando Admin, Tech y Orders Preview: poner el nuevo en
  `GRAPH_CLIENT_SECRET` de esos proyectos en Vercel y después borrar el viejo en
  Azure. Nunca repetir el valor.
- No intentar sacar passwords/credenciales de código viejo (lo bloquea el
  sistema de permisos y está bien que lo bloquee).
- Env vars (solo nombres): GRAPH_*, NOTIFY_*, QUICKBOOKS_CLIENT_ID,
  QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_ENVIRONMENT, QUICKBOOKS_REDIRECT_URI,
  WIPE_PASSWORD, DIRECTOR_PASSWORD, VAPID_*, CRON_SECRET.

## 7. Checklist antes de pedir el "súbelo" (para que no haya cochinadas)

- [ ] ¿El dueño pidió exactamente esto? ¿No cambié nada de más?
- [ ] ¿Mini con la app real, revisado a 390px y escritorio, sin errores en consola?
- [ ] ¿Toda la UI en inglés? ¿Sin notas/avisos que no pidió?
- [ ] `node --check` a los .js tocados; scripts inline de los HTML revisados.
- [ ] Flujo completo de punta a punta (WORKFLOW.md regla 7): nada se pisa,
      nada se pierde entre pantallas, columnas de SharePoint documentadas.
- [ ] Si toqué gsocd-shared: commit → SHA nuevo en TODOS los HTML que lo usan.
- [ ] Commit que explica el porqué. Nada de secretos en el diff.
- [ ] Este HANDOFF.md reescrito con el estado nuevo.
- [ ] Pedir permiso. Subir en orden: shared → Admin → Orders → Tech.
