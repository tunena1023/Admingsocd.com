const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../get-order-detail');
module.exports = toVercel(handler);
