const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../admin-get-clients');
module.exports = toVercel(handler);
