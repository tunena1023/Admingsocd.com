const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../developer-admin');
module.exports = toVercel(handler);
