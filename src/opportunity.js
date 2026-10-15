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
    const message = field === 'installmentsCount' ? 'A quantidade de parcelas deve ser um número inteiro maior que zero.' : 'Informe um valor válido.';
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(message);
    if (field === 'installmentsCount' && (!Number.isSafeInteger(value) || value < 1)) throw new Error(message);
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

// ZINIX-MVP-002A — dados para financiamento, TODOS OPCIONAIS.
// O registro lead/oportunidade já é a ficha do cliente (1 telefone = 1
// registro), então os dados do cliente e a estrutura técnica do veículo de
// interesse ficam nele mesmo. Registros antigos não têm nenhum destes campos
// e continuam iguais: nada é preenchido por padrão e nada é migrado.
const CUSTOMER_FIELDS = ['customerDocument', 'customerBirthDate', 'customerGender', 'customerState', 'customerCity', 'customerHasDriverLicense'];
const VEHICLE_CATALOG_FIELDS = ['vehicleType', 'vehicleBrandCode', 'vehicleBrandName', 'vehicleModelCode', 'vehicleModelName', 'vehicleVersionCode',
  'vehicleVersionName', 'vehicleManufactureYear', 'vehicleModelYear', 'vehicleZeroKm', 'vehicleCatalogInterest', 'vehicleCatalogConfirmedAt'];
const FINANCING_FIELDS = [...CUSTOMER_FIELDS, ...VEHICLE_CATALOG_FIELDS];

const textoVeiculo = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

// Visão pública (API/telas): o CPF nunca sai inteiro do servidor, só mascarado.
// A revalidação do veículo é derivada: a estrutura foi confirmada para um texto
// de veículo de interesse; se o texto mudou depois, precisa confirmar de novo.
// Sem nenhum campo novo, o registro é devolvido exatamente como veio.
function publicFinancingFields(lead) {
  if (!lead || (lead.customerDocument == null && lead.vehicleVersionCode == null)) return lead;
  const result = { ...lead };
  if (lead.customerDocument != null) {
    const d = String(lead.customerDocument).replace(/\D/g, '');
    delete result.customerDocument;
    result.customerDocumentMasked = d.length === 11 ? `•••.•••.•••-${d.slice(9)}` : '•••';
  }
  if (lead.vehicleVersionCode != null) {
    result.vehicleCatalogNeedsReview = textoVeiculo(lead.vehicleCatalogInterest) !== textoVeiculo(lead.vehicleInterest);
  }
  return result;
}

module.exports = { normalizeOpportunity, commercialPatch, publicFinancingFields, CUSTOMER_FIELDS, VEHICLE_CATALOG_FIELDS, FINANCING_FIELDS };
