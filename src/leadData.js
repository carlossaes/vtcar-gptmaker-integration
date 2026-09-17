const CONTACT_FIELDS = ['name', 'phone', 'email', 'vehicleInterest', 'contactNotes'];

function leadDataPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Dados do lead inválidos');
  const patch = {};
  for (const field of CONTACT_FIELDS) {
    if (!Object.hasOwn(body, field)) continue;
    if (body[field] !== null && typeof body[field] !== 'string') throw new Error(`${field} deve ser texto`);
    const value = (body[field] || '').trim();
    if (['name', 'phone'].includes(field) && !value) throw new Error(`${field} não pode ficar vazio`);
    if (field === 'phone' && !/^[+\d\s().-]+$/.test(value)) throw new Error('Telefone inválido');
    if (field === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('E-mail inválido');
    patch[field] = field === 'email' ? value || null : value;
  }
  return patch;
}

module.exports = { leadDataPatch };
