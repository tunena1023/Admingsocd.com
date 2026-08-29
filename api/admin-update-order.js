const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../admin-update-order');
module.exports = toVercel(handler);
