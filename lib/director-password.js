/* lib/director-password.js -- el password del director (26/09/2026).

   Donde vive: Developer > Operations Director Password lo guarda en la
   lista Settings (DirectorPassword). Si ese renglon no existe todavia,
   se usa la variable de entorno DIRECTOR_PASSWORD de Vercel. Antes el
   respaldo estaba escrito en el codigo; ya no. Si no hay ninguno de los
   dos, ningun password es valido. */
async function directorPassword(getSetting) {
  const saved = await getSetting('DirectorPassword');
  return saved || process.env.DIRECTOR_PASSWORD || '';
}
async function isDirectorPassword(pw, getSetting) {
  const real = await directorPassword(getSetting);
  return !!real && String(pw || '') === String(real);
}
module.exports = { isDirectorPassword };
