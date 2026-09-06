/* admin-update-tech.js — la oficina asigna Rol (Employee/Supervisor)
   y Division a un registro de Techs. Tambien permite desactivar una
   cuenta (Active) sin borrarla. */

const { TECHS_LIST, updateListItemByItemId, jsonResponse } = require('./lib/graph');

const VALID_ROLES = ['Employee', 'Supervisor'];
const VALID_DIVISIONS = ['Janitorial', 'Renovations', 'Exteriors'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  try {
    const b = JSON.parse(event.body || '{}');
    const techId = String(b.techId || '').trim();
    if (!techId) return jsonResponse(400, { error: 'techId is required' });

    const fields = {};
    if (b.role !== undefined) {
      if (VALID_ROLES.indexOf(b.role) === -1) return jsonResponse(400, { error: 'Invalid role.' });
      fields.Role = b.role;
    }
    if (b.division !== undefined) {
      if (b.division !== '' && VALID_DIVISIONS.indexOf(b.division) === -1) return jsonResponse(400, { error: 'Invalid division.' });
      fields.Division = b.division;
    }
    if (b.active !== undefined) {
      fields.Active = !!b.active;
    }
    if (!Object.keys(fields).length) return jsonResponse(400, { error: 'Nothing to update.' });

    await updateListItemByItemId(TECHS_LIST, techId, fields);
    return jsonResponse(200, { success: true });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
