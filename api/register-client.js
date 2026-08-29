const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../register-client');
module.exports = toVercel(handler);
