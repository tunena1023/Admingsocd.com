const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../admin-get-orders');
module.exports = toVercel(handler);
