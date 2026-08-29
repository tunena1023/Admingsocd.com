const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../admin-update-client');
module.exports = toVercel(handler);
