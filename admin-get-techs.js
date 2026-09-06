/* admin-get-techs.js — lista todos los que se han registrado en
   tech.gsocd.com (Techs), para que la oficina les asigne Rol y
   Division. El registro nunca pide esos 2 datos (la persona que se
   registra no tiene por que saberlos) -- se asignan aqui. */

const { TECHS_LIST, graphFetch, siteListPath, jsonResponse } = require('./lib/graph');

async function fetchAll(listName) {
  let url = siteListPath(listName) + '?$expand=fields&$top=500';
  const out = [];
  while (url) {
    const data = await graphFetch(url);
    out.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

exports.handler = async () => {
  try {
    const rows = await fetchAll(TECHS_LIST);
    const techs = rows.filter(it => it.fields).map(it => ({
      id: it.id,
      firstName: it.fields.FirstName || '',
      lastName: it.fields.LastName || '',
      phone: it.fields.Phone || '',
      email: it.fields.Email || '',
      tempId: it.fields.TempID || '',
      payrollId: it.fields.PayrollID || '',
      role: it.fields.Role || 'Employee',
      division: it.fields.Division || '',
      active: it.fields.Active === undefined ? true : (it.fields.Active === true || it.fields.Active === 'true')
    })).sort((a, b) => (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName));

    return jsonResponse(200, { techs });
  } catch (e) {
    return jsonResponse(500, { error: e.message });
  }
};
