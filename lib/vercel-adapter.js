function toVercel(handler) {
  return async function (req, res) {
    const event = {
      httpMethod: req.method,
      queryStringParameters: req.query || {},
      body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})
    };
    try {
      const result = await handler(event);
      const headers = result.headers || {};
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
      res.status(result.statusCode || 200);
      if (result.isBase64Encoded) {
        res.send(Buffer.from(result.body, 'base64'));
      } else {
        res.send(result.body);
      }
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}
module.exports = { toVercel };