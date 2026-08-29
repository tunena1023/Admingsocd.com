const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../submit-order');
module.exports = toVercel(handler);
