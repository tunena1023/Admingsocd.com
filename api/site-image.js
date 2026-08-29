const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../site-image');
module.exports = toVercel(handler);
