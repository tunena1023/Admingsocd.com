const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../get-order-document');
module.exports = toVercel(handler);
