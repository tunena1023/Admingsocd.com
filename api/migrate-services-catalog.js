const { toVercel } = require('../lib/vercel-adapter');
const { handler } = require('../migrate-services-catalog');
module.exports = toVercel(handler);
