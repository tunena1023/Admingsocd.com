/* ============================================================
   lib/division-rules.js -- COPIA LOCAL de gsocd-shared/lib/division-rules.js
   (v1.35.0, sin cambios de logica).
   Por que copia (24/09/2026): se instalaba como paquete de npm desde
   GitHub (github:tunena1023/gsocd-shared#v1.35.0), pero Vercel reusa su
   cache de node_modules ('up to date' sin reinstalar) y en produccion
   seguia la version vieja (v1.34.0), que NO tiene
   divisionChangeHistoryPayload -> 'divisionChangeHistoryPayload is not a
   function' al agregar un servicio que cambia la division (captura del
   dueño en Admin). Mismo patron que las demas piezas de lib/: cada
   backend trae su copia. Si cambia la regla, cambiarla en los 3 lados.
============================================================ */
/* ============================================================
   gsocd-shared/lib/division-rules.js
   Logica compartida de BACKEND (Node, no navegador) -- primera pieza
   de gsocd-shared pensada para requerirse desde el servidor en vez de
   cargarse con <script> en el navegador. Los 3 repos (Admin, Orders,
   Tech) la instalan como dependencia real de git en su package.json,
   fijada a un tag (mismo criterio de version fija que ya usa todo lo
   demas en este repo), y la importan con require() desde donde cada
   uno guarda servicios de una orden.

   Por que existe: si a una orden de una sola division (ej. Janitorial)
   se le agrega un servicio de otra division (ej. Renovations) desde
   cualquiera de los 3 portales -- Active/Approvals en Admin, una
   sugerencia de supervisor en Tech, o el cliente pidiendo un cambio en
   Orders -- la orden debe pasar a Division='Mixed' de una vez, sin
   preguntar, y quedar registrado en el historial (de que division
   venia y que servicios lo causaron). Antes esto no pasaba en ningun
   lado: cada servicio se guardaba con el campo Division heredado en
   bloque de la orden completa, nunca con su division real del
   catalogo -- confirmado con el dueno, 20/09/2026.

   Por eso este modulo NUNCA confia en un campo Division que ya venga
   escrito en cada renglon de servicio (puede venir mal) -- siempre
   busca la division real de cada servicio por su SKU contra el
   catalogo real (ServicesCatalog), que cada backend ya puede
   consultar (SERVICES_CATALOG_LIST, ya existe en cada lib/graph.js).

   Sin dependencias de SharePoint/Graph aqui adentro -- funcion pura,
   cada repo sigue siendo el que hace sus propias consultas y sus
   propios createListItem(). Esto solo calcula.
============================================================ */

/* catalog: array de {sku, division} (normalizado, minusculas) -- cada
   backend ya mapea asi su propia lectura de ServicesCatalog (fields.SKU
   / fields.Division), igual que ya hace developer-admin.js.

   services: array de los servicios que se van a guardar en la orden,
   forma SharePoint (SubOption es el SKU, ServiceName el nombre) --
   mismo shape que ya usa cada ORDER_SERVICES_LIST en los 3 repos.

   currentDivision: la Division actual de la orden (string).

   Regresa null si no hace falta ningun cambio (orden ya es Mixed, o
   ninguno de los servicios pertenece a otra division). Si hace falta
   el cambio, regresa:
     { newDivision: 'Mixed', previousDivision: <la que tenia>,
       causedBy: [ { serviceName, division }, ... ] }  -- sin
     duplicados por nombre de servicio. */
function resolveOrderDivision(currentDivision, services, catalog) {
  const cur = String(currentDivision == null ? '' : currentDivision).trim();
  if (cur.toLowerCase() === 'mixed') return null;

  const catalogBySku = {};
  (catalog || []).forEach(function (c) {
    const sku = String((c && (c.sku != null ? c.sku : c.SKU)) || '').trim();
    if (sku) catalogBySku[sku] = c;
  });

  const foreign = [];
  const seenNames = {};
  (services || []).forEach(function (s) {
    if (!s) return;
    const sku = String(s.SubOption != null ? s.SubOption : (s.subOption || '')).trim();
    const catEntry = sku ? catalogBySku[sku] : null;
    if (!catEntry) return; // sin match en catalogo (SKU viejo/manual) -- no se puede verificar, se deja pasar
    const realDivision = String((catEntry.division != null ? catEntry.division : catEntry.Division) || '').trim();
    if (!realDivision) return;
    if (cur && realDivision.toLowerCase() !== cur.toLowerCase()) {
      const name = String(s.ServiceName || s.serviceName || '').trim() || sku;
      if (seenNames[name]) return;
      seenNames[name] = true;
      foreign.push({ serviceName: name, division: realDivision });
    }
  });

  if (!foreign.length) return null;

  return {
    newDivision: 'Mixed',
    previousDivision: cur,
    causedBy: foreign
  };
}

/* Objeto listo para JSON.stringify() y guardarse en el NewValue del
   renglon de historial 'Division Changed' -- order-history.js
   (v1.35.0+) ya sabe leer exactamente esta forma
   ({division, causedBy:[{serviceName,division},...]}) para dibujar el
   cambio de division junto con el/los servicios que lo causaron en el
   mismo detalle, con el mismo formato que ya usa el resto del
   historial para servicios agregados. Notes se deja vacio a proposito
   -- CAMBIO (20/09/2026, reportado por el dueño con captura real):
   antes esto regresaba una frase completa para Notes
   ("Division changed from X to Mixed because of: ..."), que se veia
   repetida/de mas junto al detalle. Ya no se manda texto suelto por
   Notes -- toda la informacion vive aqui, en NewValue. */
function divisionChangeHistoryPayload(result) {
  if (!result) return null;
  return { division: result.newDivision, causedBy: result.causedBy };
}

module.exports = { resolveOrderDivision: resolveOrderDivision, divisionChangeHistoryPayload: divisionChangeHistoryPayload };
