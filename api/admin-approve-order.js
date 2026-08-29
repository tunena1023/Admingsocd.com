const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../admin-approve-order');
module.exports = toVercel(handler);
