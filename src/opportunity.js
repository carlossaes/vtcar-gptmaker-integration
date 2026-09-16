const MONEY_FIELDS = ['assetValue', 'negotiatedValue', 'downPayment', 'financingAmount', 'installmentValue', 'tradeInValue'];
const PAYMENT_COMPOSITIONS = ['avista', 'financiamento', 'entrada_financiamento', 'troca_financiamento', 'troca_dinheiro', 'troca_dinheiro_financiamento'];
const TEXT_FIELDS = ['vehicleInterest', 'tradeInVehicle', 'notes'];

function normalizeOpportunity(lead) {
  if (lead.recordType !== 'opportunity') return lead;
  const result = { ...lead };
  for (const field of [...MONEY_FIELDS, 'installmentsCount']) result[field] = lead[field] ?? null;
  for (const field of [...TEXT_FIELDS, 'paymentComposition']) result[field] = lead[field] ?? '';
  result.hasTradeIn = lead.hasTradeIn === true;
  if (!result.hasTradeIn) { result.tradeInVehicle = ''; result.tradeInValue = null; }
  return result;
}

// Allowlist: ownership, stage, recordType and control fields never enter this patch.
function commercialPatch(body, current = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Dados comerciais inválidos');
  const patch = {};
  if (Object.hasOwn(body, 'hasTradeIn')) {
    if (typeof body.hasTradeIn !== 'boolean') throw new Error('hasTradeIn deve ser booleano');
    patch.hasTradeIn = body.hasTradeIn;
  }
  const hasTradeIn = patch.hasTradeIn ?? (current.hasTradeIn === true);
  for (const field of [...MONEY_FIELDS, 'installmentsCount']) {
    if (!Object.hasOwn(body, field) || (field === 'tradeInValue' && !hasTradeIn)) continue;
    const value = body[field];
    if (value === null || value === '') { patch[field] = null; continue; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${field} deve ser um número não negativo`);
    if (field === 'installmentsCount' && (!Number.isSafeInteger(value) || value < 1)) throw new Error('installmentsCount deve ser um inteiro maior ou igual a 1');
    patch[field] = value;
  }
  for (const field of TEXT_FIELDS) {
    if (!Object.hasOwn(body, field) || (field === 'tradeInVehicle' && !hasTradeIn)) continue;
    if (body[field] !== null && typeof body[field] !== 'string') throw new Error(`${field} deve ser texto`);
    patch[field] = (body[field] || '').trim();
  }
  if (Object.hasOwn(body, 'paymentComposition')) {
    const value = body.paymentComposition;
    if (value !== null && value !== '' && !PAYMENT_COMPOSITIONS.includes(value)) throw new Error('Composição do pagamento inválida');
    patch.paymentComposition = value || '';
  }
  if (!hasTradeIn) { patch.tradeInVehicle = ''; patch.tradeInValue = null; }
  return patch;
}

module.exports = { normalizeOpportunity, commercialPatch };
