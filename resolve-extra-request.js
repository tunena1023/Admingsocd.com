/* ============================================================
   resolve-extra-request.js — oficina decide sobre un EXTRA que el
   cliente le pidio al tecnico en sitio (algo que NO esta en su lista
   del contrato). Nace del rediseno de Recurring "Who does what"
   (23/09/2026): el dueno detecto que al facturar solo "Areas comunes"
   nadie sabia hasta donde llegaba el alcance, y la gente terminaba
   haciendo de mas sin cobrarlo.

   El tecnico lo manda desde Tech (submit-extra-request.js) como un
   evento 'Extra Requested' en OrderHistory; aqui se contesta con
   'Extra Approved' (se hace y se cobra aparte) o 'Extra Declined'
   (no es parte del contrato). Mismo requestId en los dos eventos para
   ligarlos. SIN lista nueva: todo vive en el historial real de la
   orden, con FieldChanged 'Office Change (Internal)' -- el que el
   componente compartido order-history ya esconde del cliente.
============================================================ */
const { ORDER_HISTORY_LIST, createListItem, jsonResponse } = require('./lib/graph');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  try {
    const b = JSON.parse(event.body || '{}');
    for (const k of ['orderId', 'requestId', 'decision', 'changedBy']) if (!b[k]) return jsonResponse(400, { error: k + ' is required' });
    if (b.decision !== 'approved' && b.decision !== 'declined') return jsonResponse(400, { error: 'decision must be approved or declined' });
    const approved = b.decision === 'approved';
    await createListItem(ORDER_HISTORY_LIST, {
      Title: b.orderId + '-extra-' + b.decision + '-' + Date.now(),
      OrderID: b.orderId,
      ChangeType: approved ? 'Extra Approved' : 'Extra Declined',
      FieldChanged: 'Office Change (Internal)',
      ChangedBy: b.changedBy,
      ChangeDate: new Date().toISOString(),
      Notes: approved ? 'Approved as an extra charge, billed separately.' : 'Declined: not part of this contract.',
      NewValue: JSON.stringify({ requestId: String(b.requestId), decision: b.decision })
    });
    return jsonResponse(200, { success: true });
  } catch (err) {
    console.error('resolve-extra-request.js error:', err);
    return jsonResponse(500, { error: err.message });
  }
};
