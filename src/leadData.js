const CONTACT_FIELDS = ['name', 'phone', 'email', 'vehicleInterest', 'contactNotes'];

function leadDataPatch(body, current = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Dados do lead inválidos');
  const patch = {};
  for (const field of CONTACT_FIELDS) {
    if (!Object.hasOwn(body, field)) continue;
    // Um identificador legado inalterado não é uma tentativa de editar telefone.
    if (field === 'phone' && body[field] === current.phone) continue;
    const message = field === 'name' ? 'Informe o nome do cliente.' : field === 'phone' ? 'Informe um telefone válido.'
      : field === 'email' ? 'Informe um e-mail válido.' : 'Informe um texto válido.';
    if (body[field] !== null && typeof body[field] !== 'string') throw new Error(message);
    const value = (body[field] || '').trim();
    if (['name', 'phone'].includes(field) && !value) throw new Error(message);
    if (field === 'phone' && (!/^[+\d\s().-]+$/.test(value) || !/\d/.test(value))) throw new Error(message);
    if (field === 'email' && value && !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(value)) throw new Error(message);
    patch[field] = field === 'email' ? value || null : value;
  }
  return patch;
}

module.exports = { leadDataPatch };
