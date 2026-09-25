/* api/[...slug].js — un solo endpoint que reparte el trafico a todas
   las funciones de la raiz, leyendo el nombre directo de la URL
   (mismo patron que ya existe en ordersgsocd.com). Esto quita el
   limite de 12 funciones serverless del plan de Vercel -- Vercel
   solo cuenta ESTE archivo como una funcion, sin importar cuantas
   acciones se registren aqui adentro. */
const { toVercel } = require('../lib/vercel-adapter');
const { verifyIdToken } = require('../lib/auth');

const handlers = {
  'admin-approve-order': require('../admin-approve-order').handler,
  'admin-get-clients':   require('../admin-get-clients').handler,
  'admin-get-client-holidays': require('../admin-get-client-holidays').handler,
  'admin-save-client-holiday': require('../admin-save-client-holiday').handler,
  'admin-get-orders':    require('../admin-get-orders').handler,
  'admin-update-client': require('../admin-update-client').handler,
  'admin-update-order':  require('../admin-update-order').handler,
  'developer-admin':     require('../developer-admin').handler,
  'get-order-detail':    require('../get-order-detail').handler,
  'get-order-document':  require('../get-order-document').handler,
  'get-order-photos':    require('../get-order-photos').handler,
  'print-request-document': require('../print-request-document').handler,
  'get-admin-gallery':   require('../get-admin-gallery').handler,
  'register-client':     require('../register-client').handler,
  'site-image':          require('../site-image').handler,
  'submit-order':        require('../submit-order').handler,
  'upload-service-photo': require('../upload-service-photo').handler,
  'quickbooks-connect':  require('../quickbooks-connect').handler,
  'quickbooks-callback': require('../quickbooks-callback').handler,
  'quickbooks-status':   require('../quickbooks-status').handler,
  'quickbooks-import-estimates': require('../quickbooks-import-estimates').handler,
  'cron-recurring-orders': require('../cron-recurring-orders').handler,
  'toggle-assign-by-service': require('../toggle-assign-by-service').handler,
  'get-service-assignments': require('../get-service-assignments').handler,
  'save-service-assignment': require('../save-service-assignment').handler,
  'complete-service-assignment': require('../complete-service-assignment').handler,
  'resolve-extra-request': require('../resolve-extra-request').handler,
  'resolve-service-change-request': require('../resolve-service-change-request').handler,
  'reorder-service-queue': require('../reorder-service-queue').handler,
  'admin-mark-order-seen': require('../admin-mark-order-seen').handler,
  'order-docs': require('../order-docs').handler
};

const PUBLIC_SLUGS = new Set(['site-image', 'quickbooks-callback', 'cron-recurring-orders']);

module.exports = async (req, res) => {
  const pathOnly = (req.url || '').split('?')[0];
  const parts = pathOnly.split('/').filter(Boolean); // ['api', 'submit-order']
  const slug = parts[parts.length - 1];
  const h = handlers[slug];
  if (!h) {
    res.status(404).json({ error: 'Unknown endpoint: ' + slug });
    return;
  }
  /* 23/09/2026: TODA peticion trae el ID token de Microsoft y se
     valida aqui (lib/auth.js) -- antes el servidor se fiaba del correo
     que mandaba la pagina. Excepciones: imagenes del sitio (publicas),
     el regreso de QuickBooks (OAuth, lo valida su propio state) y el
     cron (lo valida su propio CRON_SECRET). El token viaja en el header
     Authorization; los links que se abren en otra pestaña (PDFs,
     conectar QuickBooks) lo mandan en ?t=. */
  if (!PUBLIC_SLUGS.has(slug)) {
    const authz = String((req.headers && req.headers.authorization) || '');
    let token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    if (!token && req.query && req.query.t) token = String(req.query.t);
    let user;
    try {
      user = await verifyIdToken(token);
    } catch (e) {
      res.status(401).json({ error: 'Please sign in again (' + e.message + ')', code: 'AUTH' });
      return;
    }
    /* Quien hace la peticion = el del token, no el que diga el body:
       developer-admin decide permisos por body.email, y "visto por"
       usa viewerId. Ningun otro endpoint usa esos campos para otra
       cosa (revisado: el correo de clientes/contactos va en otros). */
    const IDENTITY_FIELD = { 'developer-admin': 'email', 'admin-get-orders': 'viewerId', 'admin-mark-order-seen': 'viewerId', 'order-docs': 'email' };
    const field = IDENTITY_FIELD[slug];
    if (field) {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b || '{}'); } catch (e) { b = null; } }
      if (b && typeof b === 'object') { b[field] = user.email; req.body = b; }
    }
  }
  return toVercel(h)(req, res);
};
