/* api/[...slug].js — un solo endpoint que reparte el trafico a todas
   las funciones de la raiz, leyendo el nombre directo de la URL
   (mismo patron que ya existe en ordersgsocd.com). Esto quita el
   limite de 12 funciones serverless del plan de Vercel -- Vercel
   solo cuenta ESTE archivo como una funcion, sin importar cuantas
   acciones se registren aqui adentro. */
const { toVercel } = require('../lib/vercel-adapter');

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
  'resolve-service-change-request': require('../resolve-service-change-request').handler,
  'reorder-service-queue': require('../reorder-service-queue').handler,
  'admin-mark-order-seen': require('../admin-mark-order-seen').handler
};

module.exports = async (req, res) => {
  const pathOnly = (req.url || '').split('?')[0];
  const parts = pathOnly.split('/').filter(Boolean); // ['api', 'submit-order']
  const slug = parts[parts.length - 1];
  const h = handlers[slug];
  if (!h) {
    res.status(404).json({ error: 'Unknown endpoint: ' + slug });
    return;
  }
  return toVercel(h)(req, res);
};
