const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../get-services');
module.exports = toVercel(handler);
