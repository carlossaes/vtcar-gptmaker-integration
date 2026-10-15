// Regras de negocio do Financiamento (ZINIX-MVP-001).
//
// Fluxo: rota -> FinancingService -> ZinixAdapter (REST) -> API Zinix.
// Este modulo NAO conhece HTTP da Zinix; conhece o CRM: quem pode simular,
// em qual oportunidade, com quais dados, e como guardar a intencao ANTES de
// enviar (idempotencia).
//
// LGPD: CPF, nascimento, e-mail e telefone so existem em memoria durante o
// envio. O arquivo de simulacoes guarda apenas um HMAC do payload (com sal
// aleatorio por registro), o veiculo e as condicoes negociadas. Os logs de
// auditoria usam uma lista fechada de campos sem dado pessoal.

const crypto = require('crypto');
const { ZinixError, UUID } = require('./zinixAdapter');

const TERMINAL = new Set(['completed', 'partial', 'failed', 'expired']);
const BANK_STATUSES = new Set(['queued', 'pending', 'processing', 'completed', 'rejected', 'unavailable', 'failed', 'timed_out']);
const ISSUE_STATUSES = new Set(['rejected', 'failed', 'unavailable']);
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const MIN_POLL_MS = 20000; // contrato Zinix: primeiro GET ~20s, nunca mais rapido que isso
const RETRY_WINDOW_MS = 30 * 60 * 1000; // reenvio com a MESMA chave so dentro desta janela
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // duplo clique: devolve a simulacao em andamento
const CACHE_TTL_MS = 30 * 60 * 1000;
const ENTITY_TTL_MS = 10 * 60 * 1000;
const CREATE_LIMIT = { max: 8, windowMs: 10 * 60 * 1000 };

class FinancingError extends Error {
  constructor(httpStatus, message, extra = {}) {
    super(message);
    this.name = 'FinancingError';
    this.httpStatus = httpStatus;
    this.code = extra.code || 'erro';
    this.requestId = extra.requestId || null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.fields = extra.fields || null;
    this.simulation = extra.simulation || null;
  }
}

// --- auditoria tecnica sem PII -------------------------------------------
const AUDIT_FIELDS = ['userId', 'opportunityId', 'simulationId', 'zinixSimulationId', 'requestId', 'status', 'httpStatus', 'errorCode', 'bank', 'replay'];
function defaultAudit(evt, fields = {}) {
  const line = { evt, at: new Date().toISOString() };
  for (const k of AUDIT_FIELDS) if (fields[k] !== undefined && fields[k] !== null) line[k] = fields[k];
  console.log(`[zinix] ${JSON.stringify(line)}`);
}

// --- validacao -------------------------------------------------------------
function cpfValido(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const dv = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(digits[9]) && dv(10) === Number(digits[10]);
}

function idadeEm(dataIso, hoje) {
  const [y, m, d] = dataIso.split('-').map(Number);
  let idade = hoje.getUTCFullYear() - y;
  if (hoje.getUTCMonth() + 1 < m || (hoje.getUTCMonth() + 1 === m && hoje.getUTCDate() < d)) idade -= 1;
  return idade;
}

function dataValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const texto = (v) => (typeof v === 'string' ? v.trim() : '');
const semControle = (s) => !/[\u0000-\u001f\u007f]/.test(s);

function centavos(valor) {
  if (typeof valor !== 'number' || !Number.isFinite(valor)) return null;
  const c = Math.round(valor * 100);
  if (Math.abs(valor * 100 - c) > 1e-6) return null; // mais de 2 casas decimais
  return c;
}

function validarVeiculo(v, agora, erros) {
  if (!['car', 'motorcycle'].includes(v.type)) erros['vehicle.type'] = 'Selecione o tipo de veículo.';
  const codigo = (x) => { const s = texto(x); return s.length >= 1 && s.length <= 64 && semControle(s) ? s : null; };
  const brandCode = codigo(v.brandCode); if (!brandCode) erros['vehicle.brandCode'] = 'Selecione a marca no catálogo.';
  const modelCode = codigo(v.modelCode); if (!modelCode) erros['vehicle.modelCode'] = 'Selecione o modelo no catálogo.';
  const versionCode = codigo(v.versionCode); if (!versionCode) erros['vehicle.versionCode'] = 'Selecione a versão no catálogo.';
  const anoMax = agora.getUTCFullYear() + 2;
  const fab = v.manufactureYear;
  const mod = v.modelYear;
  if (!Number.isSafeInteger(fab) || fab < 1950 || fab > anoMax) erros['vehicle.manufactureYear'] = 'Informe o ano de fabricação.';
  if (!Number.isSafeInteger(mod) || mod < 1950 || mod > anoMax) erros['vehicle.modelYear'] = 'Informe o ano do modelo.';
  else if (Number.isSafeInteger(fab) && mod < fab) erros['vehicle.modelYear'] = 'O ano do modelo não pode ser anterior ao de fabricação.';
  if (typeof v.zeroKm !== 'boolean') erros['vehicle.zeroKm'] = 'Informe se o veículo é zero km.';
  return { type: v.type, brandCode, modelCode, versionCode, manufactureYear: fab, modelYear: mod, zeroKm: v.zeroKm };
}

// --- ZINIX-MVP-002A: dados do cliente gravados no CRM ----------------------
// Allowlist explícita (nome da API -> campo do registro). Qualquer outra chave
// é recusada. Mensagens nunca repetem o valor recebido (CPF fora de erro/log).
const CAMPOS_CLIENTE = {
  document: 'customerDocument', birthDate: 'customerBirthDate', gender: 'customerGender',
  state: 'customerState', city: 'customerCity', hasDriverLicense: 'customerHasDriverLicense',
};

function validarCliente(body, agora) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FinancingError(400, 'Dados do cliente inválidos.', { code: 'dados_invalidos' });
  const chaves = Object.keys(body);
  const estranhas = chaves.filter((k) => !Object.hasOwn(CAMPOS_CLIENTE, k));
  if (estranhas.length) {
    throw new FinancingError(400, 'Campo não permitido.', { code: 'campo_nao_permitido', fields: Object.fromEntries(estranhas.slice(0, 10).map((k) => [String(k).slice(0, 40), 'Campo não permitido.'])) });
  }
  if (!chaves.length) throw new FinancingError(400, 'Nada para salvar.', { code: 'dados_invalidos' });
  const erros = {}; const patch = {};
  for (const k of chaves) {
    const valor = body[k];
    if (valor === null) { patch[CAMPOS_CLIENTE[k]] = undefined; continue; } // limpar o campo
    if (k === 'document') {
      const cpf = texto(valor).replace(/\D/g, '');
      if (typeof valor !== 'string' || !cpfValido(cpf)) erros.document = 'Informe um CPF válido.'; else patch.customerDocument = cpf;
    } else if (k === 'birthDate') {
      const nasc = texto(valor);
      if (!dataValida(nasc)) erros.birthDate = 'Informe uma data de nascimento válida.';
      else { const idade = idadeEm(nasc, agora); if (idade < 18 || idade > 100) erros.birthDate = 'O cliente precisa ter entre 18 e 100 anos.'; else patch.customerBirthDate = nasc; }
    } else if (k === 'gender') {
      if (!['male', 'female'].includes(valor)) erros.gender = 'Selecione o sexo.'; else patch.customerGender = valor;
    } else if (k === 'state') {
      const uf = texto(valor).toUpperCase();
      if (!UFS.includes(uf)) erros.state = 'Selecione a UF.'; else patch.customerState = uf;
    } else if (k === 'city') {
      const cidade = texto(valor).replace(/\s+/g, ' ');
      if (cidade.length < 2 || cidade.length > 80 || !semControle(cidade) || !/[A-Za-zÀ-ÿ]/.test(cidade)) erros.city = 'Informe a cidade.'; else patch.customerCity = cidade;
    } else if (k === 'hasDriverLicense') {
      if (typeof valor !== 'boolean') erros.hasDriverLicense = 'Informe se o cliente possui CNH.'; else patch.customerHasDriverLicense = valor;
    }
  }
  if (Object.keys(erros).length) throw new FinancingError(400, 'Confira os campos destacados.', { code: 'dados_invalidos', fields: erros });
  return patch;
}

function validarEntrada(body, agora) {
  const erros = {};
  const b = body && typeof body === 'object' ? body : {};
  const a = b.applicant && typeof b.applicant === 'object' ? b.applicant : {};
  const v = b.vehicle && typeof b.vehicle === 'object' ? b.vehicle : {};
  const t = b.terms && typeof b.terms === 'object' ? b.terms : {};

  const cpf = texto(a.document).replace(/\D/g, '');
  if (!cpfValido(cpf)) erros['applicant.document'] = 'Informe um CPF válido.';
  const nome = texto(a.name).replace(/\s+/g, ' ');
  if (nome.length < 3 || nome.length > 120 || !/[A-Za-zÀ-ÿ]/.test(nome) || !semControle(nome)) erros['applicant.name'] = 'Informe o nome completo do cliente.';
  const nasc = texto(a.birthDate);
  if (!dataValida(nasc)) erros['applicant.birthDate'] = 'Informe a data de nascimento.';
  else {
    const idade = idadeEm(nasc, agora);
    if (idade < 18 || idade > 100) erros['applicant.birthDate'] = 'O cliente precisa ter entre 18 e 100 anos.';
  }
  if (!['male', 'female'].includes(a.gender)) erros['applicant.gender'] = 'Selecione o sexo.';
  const email = texto(a.email);
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email) || email.length > 160) erros['applicant.email'] = 'Informe um e-mail válido.';
  const fone = texto(a.phone).replace(/\D/g, '');
  if (fone.length < 10 || fone.length > 13) erros['applicant.phone'] = 'Informe um telefone com DDD.';
  const uf = texto(a.state).toUpperCase();
  if (!UFS.includes(uf)) erros['applicant.state'] = 'Selecione a UF.';
  const cidade = texto(a.city).replace(/\s+/g, ' ');
  if (cidade.length < 2 || cidade.length > 80 || !semControle(cidade)) erros['applicant.city'] = 'Informe a cidade.';
  if (typeof a.hasDriverLicense !== 'boolean') erros['applicant.hasDriverLicense'] = 'Informe se o cliente possui CNH.';

  const vehicle = validarVeiculo(v, agora, erros);

  const valor = centavos(t.assetValue);
  if (valor === null || valor <= 0 || valor > 1000000000) erros['terms.assetValue'] = 'Informe o valor do veículo.';
  const entrada = centavos(t.downPayment);
  if (entrada === null || entrada < 0) erros['terms.downPayment'] = 'Informe a entrada (pode ser R$ 0,00).';
  else if (valor !== null && entrada >= valor) erros['terms.downPayment'] = 'A entrada deve ser menor que o valor do veículo.';
  let parcelas = Array.isArray(t.installments) ? t.installments : [];
  if (!parcelas.length || parcelas.length > 12 || !parcelas.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 84)
    || new Set(parcelas).size !== parcelas.length) {
    erros['terms.installments'] = 'Selecione de 1 a 12 prazos diferentes, entre 1 e 84 parcelas.';
  } else parcelas = [...parcelas].sort((x, y) => x - y);

  if (Object.keys(erros).length) {
    throw new FinancingError(400, 'Confira os campos destacados.', { code: 'dados_invalidos', fields: erros });
  }
  return {
    applicant: { document: cpf, gender: a.gender, name: nome, birth_date: nasc, email, phone: fone, state: uf, city: cidade, has_driver_license: a.hasDriverLicense },
    vehicle,
    terms: { asset_value_cents: valor, down_payment_cents: entrada, installments: parcelas },
  };
}

// --- saneamento do retorno dos bancos ------------------------------------
const int = (x) => (Number.isSafeInteger(x) ? x : null);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : null);

function sanitizeError(e) {
  if (!e || typeof e !== 'object') return null;
  return { code: str(e.code, 80), message: str(e.message, 300), retryable: typeof e.retryable === 'boolean' ? e.retryable : null };
}

function sanitizeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, 60).filter((r) => r && typeof r === 'object').map((r) => ({
    bank: str(r.bank, 80) || 'desconhecido',
    status: BANK_STATUSES.has(r.status) ? r.status : 'unknown',
    // Todas as condicoes sao preservadas: duas de 48x podem ter entrada,
    // valor financiado, taxa e condition_id diferentes.
    conditions: (Array.isArray(r.conditions) ? r.conditions : []).slice(0, 120).filter((c) => c && typeof c === 'object').map((c) => ({
      installments: int(c.installments),
      installment_value_cents: int(c.installment_value_cents),
      monthly_rate: num(c.monthly_rate),
      monthly_rate_estimated: c.monthly_rate_estimated === true,
      down_payment_cents: int(c.down_payment_cents),
      financed_amount_cents: int(c.financed_amount_cents),
      condition_id: str(c.condition_id, 120),
    })),
    issues: (Array.isArray(r.issues) ? r.issues : []).slice(0, 60).filter((i) => i && typeof i === 'object').map((i) => ({
      code: str(i.code, 80),
      message: str(i.message, 300),
      status: ISSUE_STATUSES.has(i.status) ? i.status : null,
      installments: int(i.installments),
      down_payment_cents: int(i.down_payment_cents),
    })),
    error: sanitizeError(r.error),
  }));
}

function sanitizeProgress(p) {
  if (!p || typeof p !== 'object') return null;
  return { expected_banks: int(p.expected_banks), finished_banks: int(p.finished_banks), pending_banks: int(p.pending_banks) };
}

function sanitizeBillingCharge(c) {
  if (!c || typeof c !== 'object') return null;
  return { debited: c.debited === true, units: int(c.units), reason: str(c.reason, 40), balance_after: num(c.balance_after) };
}

// --- traducao de erro da Zinix para o vendedor ----------------------------
function traduzir(err) {
  if (err instanceof FinancingError) return err;
  if (!(err instanceof ZinixError)) {
    return new FinancingError(500, 'Não foi possível concluir a operação de financiamento.', { code: 'erro_interno' });
  }
  const base = { requestId: err.requestId, retryAfterMs: err.retryAfterMs };
  if (err.kind === 'config') return new FinancingError(503, 'O financiamento ainda não está configurado no servidor.', { code: 'nao_configurado' });
  if (err.kind === 'validation') return new FinancingError(400, 'Dados inválidos para a consulta de financiamento.', { code: 'dados_invalidos', ...base });
  if (err.kind === 'timeout') return new FinancingError(504, 'A plataforma de financiamento não respondeu a tempo.', { code: 'timeout', ...base });
  if (err.kind === 'network') return new FinancingError(502, 'Não foi possível acessar a plataforma de financiamento.', { code: 'rede', ...base });
  if (err.kind === 'protocol') return new FinancingError(502, 'Resposta inesperada da plataforma de financiamento.', { code: 'resposta_invalida', ...base });
  switch (err.status) {
    case 400: return new FinancingError(400, 'A plataforma não aceitou os dados enviados. Confira cliente, veículo e condições.', { code: 'zinix_400', ...base });
    // 401 da Zinix NAO vira 401 para o navegador: o CRM interpretaria como
    // sessao expirada e deslogaria o vendedor.
    case 401: return new FinancingError(502, 'Integração de financiamento indisponível (credencial). Avise o administrador.', { code: 'zinix_401', ...base });
    case 402: return new FinancingError(402, 'Não há saldo disponível para uma nova consulta.', { code: 'sem_saldo', ...base });
    case 403: return new FinancingError(403, 'Esta empresa não está autorizada para esta operação na plataforma de financiamento.', { code: 'zinix_403', ...base });
    case 404: return new FinancingError(404, 'Simulação ou recurso não encontrado na plataforma de financiamento.', { code: 'zinix_404', ...base });
    case 409: return new FinancingError(409, 'Conflito na identificação da simulação. Nada foi reenviado, para evitar duplicidade.', { code: 'zinix_409', ...base });
    case 422: return new FinancingError(422, 'Não foi possível processar esta simulação com os bancos habilitados.', { code: 'zinix_422', ...base });
    case 429: return new FinancingError(429, 'Muitas consultas em sequência. Aguarde alguns instantes.', { code: 'limite', ...base });
    default:
      if (err.status >= 500) return new FinancingError(503, 'O serviço de financiamento está temporariamente indisponível.', { code: 'indisponivel', ...base });
      return new FinancingError(502, 'A plataforma de financiamento recusou a operação.', { code: `zinix_${err.status}`, ...base });
  }
}

// Envio "incerto": a Zinix pode ou nao ter recebido. Reenviar com a MESMA
// chave e seguro (replay idempotente). Os demais erros sao definitivos.
function envioIncerto(err) {
  if (!(err instanceof ZinixError)) return false;
  if (['timeout', 'network', 'protocol'].includes(err.kind)) return true;
  return err.kind === 'api' && (err.status === 429 || err.status >= 500);
}

function createFinancingService({ adapter, repository, store, audit = defaultAudit, now = () => new Date() }) {
  const cache = new Map();
  const createHits = new Map();
  let entityCache = null;

  async function cached(key, ttl, loader) {
    const hit = cache.get(key);
    const t = now().getTime();
    if (hit && hit.exp > t) return hit.value;
    const value = await loader();
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    cache.set(key, { value, exp: t + ttl });
    return value;
  }

  async function legalEntityId() {
    const t = now().getTime();
    if (entityCache && entityCache.exp > t) return entityCache.id;
    let id = null;
    const fromEnv = (process.env.ZINIX_LEGAL_ENTITY_ID || '').trim();
    if (fromEnv) {
      if (!UUID.test(fromEnv)) throw new FinancingError(503, 'Empresa de financiamento configurada incorretamente.', { code: 'empresa_invalida' });
      id = fromEnv;
    } else {
      const ativas = (await adapter.listLegalEntities()).filter((e) => e && e.status === 'active' && typeof e.id === 'string');
      const escolhida = ativas.find((e) => e.is_primary) || (ativas.length === 1 ? ativas[0] : null);
      if (!escolhida) {
        throw new FinancingError(503, ativas.length ? 'Há mais de uma empresa ativa na Zinix; defina a empresa padrão.' : 'Nenhuma empresa ativa na conta de financiamento.', { code: 'empresa_indefinida' });
      }
      id = escolhida.id;
    }
    entityCache = { id, exp: t + ENTITY_TTL_MS };
    return id;
  }

  async function bancosPorCodigo(entity) {
    try {
      const lista = await cached(`banks|${entity}`, ENTITY_TTL_MS, () => adapter.listBanks(entity));
      return new Map(lista.filter((b) => b && b.code).map((b) => [String(b.code), String(b.name || b.code)]));
    } catch (_) {
      return new Map(); // nome do banco e cosmetico; nunca derruba a consulta
    }
  }

  function podeAcessar(lead, usuario) {
    return !!lead && lead.recordType === 'opportunity' && store.podeVerLead(lead, usuario)
      && (usuario.papel === 'gerente' || lead.ownerId === usuario.id);
  }

  function oportunidade(id, usuario) {
    const lead = typeof id === 'string' && id ? store.getLeadById(id) : null;
    if (!lead || !store.podeVerLead(lead, usuario)) throw new FinancingError(404, 'Oportunidade não encontrada.', { code: 'nao_encontrada' });
    if (lead.recordType !== 'opportunity') throw new FinancingError(400, 'O financiamento está disponível apenas para oportunidades.', { code: 'nao_oportunidade' });
    if (!podeAcessar(lead, usuario)) throw new FinancingError(403, 'Somente o responsável ou um gerente pode simular financiamento.', { code: 'sem_permissao' });
    return lead;
  }

  function view(r, nomes = new Map()) {
    const t = now().getTime();
    const terminal = TERMINAL.has(r.status);
    const nextPollAt = r.nextPollAt ? Date.parse(r.nextPollAt) : null;
    return {
      id: r.id,
      opportunityId: r.opportunityId,
      status: r.status,
      terminal,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      submittedAt: r.submittedAt || null,
      completedAt: r.completedAt || null,
      createdByName: r.userName || null,
      requestId: r.requestId || null,
      vehicle: r.vehicle,
      vehicleInterest: r.vehicleInterest ?? null,
      terms: r.terms,
      progress: r.progress || null,
      results: (r.results || []).map((b) => ({ ...b, bankName: nomes.get(b.bank) || b.bank })),
      error: r.error || null,
      lastError: r.lastError ? { code: r.lastError.code, requestId: r.lastError.requestId || null } : null,
      billingCharge: r.billingCharge ? { debited: r.billingCharge.debited, reason: r.billingCharge.reason } : null,
      canRetry: r.status === 'envio_incerto',
      nextPollInMs: !terminal && r.zinixSimulationId && nextPollAt ? Math.max(0, nextPollAt - t) : null,
    };
  }

  // ZINIX-MVP-002A: a simulação usa os dados do CRM no momento do POST. O que
  // vier no corpo prevalece (compatibilidade com a tela da MVP-002); o que
  // faltar vem do registro. O veículo, se omitido, vem da estrutura salva na
  // oportunidade — e nunca de uma estrutura pendente de revalidação.
  function completarComCrm(body, lead) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const a = b.applicant && typeof b.applicant === 'object' ? b.applicant : {};
    const crm = store.getFinancingCustomer(lead.id) || {};
    const ou = (x, y) => (x === undefined || x === null || x === '' ? y : x);
    const applicant = {
      name: ou(a.name, lead.name), phone: ou(a.phone, lead.phone), email: ou(a.email, lead.email),
      document: ou(a.document, crm.document), birthDate: ou(a.birthDate, crm.birthDate), gender: ou(a.gender, crm.gender),
      state: ou(a.state, crm.state), city: ou(a.city, crm.city), hasDriverLicense: ou(a.hasDriverLicense, crm.hasDriverLicense),
    };
    let vehicle = b.vehicle;
    if (!vehicle && lead.vehicleVersionCode != null) {
      if (lead.vehicleCatalogNeedsReview) {
        throw new FinancingError(409, 'O veículo de interesse foi alterado. Confirme novamente os dados do veículo antes de uma nova simulação.', { code: 'veiculo_revalidar' });
      }
      vehicle = { type: lead.vehicleType, brandCode: lead.vehicleBrandCode, modelCode: lead.vehicleModelCode, versionCode: lead.vehicleVersionCode,
        manufactureYear: lead.vehicleManufactureYear, modelYear: lead.vehicleModelYear, zeroKm: lead.vehicleZeroKm };
    }
    return { ...b, applicant, vehicle };
  }

  function limitarCriacao(userId) {
    const t = now().getTime();
    const hits = (createHits.get(userId) || []).filter((x) => t - x < CREATE_LIMIT.windowMs);
    if (hits.length >= CREATE_LIMIT.max) {
      throw new FinancingError(429, 'Muitas simulações em sequência. Aguarde alguns minutos.', { code: 'limite_local', retryAfterMs: CREATE_LIMIT.windowMs - (t - hits[0]) });
    }
    hits.push(t);
    createHits.set(userId, hits);
  }

  const hmac = (salt, texto) => crypto.createHmac('sha256', salt).update(texto).digest('hex');

  async function catalogo(level, q) {
    const entity = await legalEntityId();
    const key = ['cat', level, entity, q.type, q.brandCode || '', q.modelCode || '', q.manufactureYear || '', q.modelYear || ''].join('|');
    const loader = { brands: adapter.brands, models: adapter.models, versions: adapter.versions }[level];
    const itens = await cached(key, CACHE_TTL_MS, () => loader({ legalEntityId: entity, ...q }));
    return itens.filter((i) => i && i.code != null && i.name != null).map((i) => ({ code: String(i.code), name: String(i.name) }));
  }

  // Codigos e nomes do veiculo sempre conferidos contra o catalogo da Zinix
  // (cacheado). Nunca se envia codigo inventado nem nome digitado.
  async function veiculoDoCatalogo(v) {
    const base = { type: v.type };
    const achar = (lista, code, msg, campo) => {
      const item = lista.find((i) => i.code === code);
      if (!item) throw new FinancingError(400, msg, { code: 'fora_do_catalogo', fields: { [campo]: msg } });
      return item;
    };
    const marca = achar(await catalogo('brands', base), v.brandCode, 'Marca não encontrada no catálogo.', 'vehicle.brandCode');
    const modelo = achar(await catalogo('models', { ...base, brandCode: v.brandCode }), v.modelCode, 'Modelo não encontrado no catálogo.', 'vehicle.modelCode');
    const versao = achar(await catalogo('versions', { ...base, brandCode: v.brandCode, modelCode: v.modelCode, manufactureYear: v.manufactureYear, modelYear: v.modelYear }),
      v.versionCode, 'Versão não encontrada no catálogo para esses anos.', 'vehicle.versionCode');
    return {
      type: v.type, brand_code: marca.code, brand_name: marca.name, model_code: modelo.code, model_name: modelo.name,
      version_code: versao.code, version_name: versao.name, manufacture_year: v.manufactureYear, model_year: v.modelYear, zero_km: v.zeroKm,
    };
  }

  async function enviar(record, payload, usuario) {
    record = repository.update(record.id, { status: 'enviando', attempts: (record.attempts || 0) + 1, lastAttemptAt: now().toISOString() });
    try {
      const res = await adapter.createSimulation(payload, record.idempotencyKey);
      const d = res.data;
      const espera = Math.max(MIN_POLL_MS, num(d.retry_after_ms) || 0, res.retryAfterMs || 0);
      const terminal = TERMINAL.has(d.status);
      record = repository.update(record.id, {
        status: d.status,
        zinixSimulationId: d.id,
        requestId: res.requestId,
        idempotentReplay: d.idempotent_replay === true,
        billingCharge: sanitizeBillingCharge(d.billing_charge),
        progress: sanitizeProgress(d.progress) || record.progress || null,
        results: d.results ? sanitizeResults(d.results) : record.results || [],
        submittedAt: record.submittedAt || now().toISOString(),
        completedAt: terminal ? now().toISOString() : null,
        nextPollAt: new Date(now().getTime() + espera).toISOString(),
        lastError: null,
      });
      audit('simulation.submitted', { userId: usuario.id, opportunityId: record.opportunityId, simulationId: record.id, zinixSimulationId: d.id, requestId: res.requestId, status: d.status, httpStatus: res.httpStatus, replay: d.idempotent_replay === true });
      return record;
    } catch (err) {
      const incerto = envioIncerto(err);
      const fe = traduzir(err);
      const lastError = { code: fe.code, httpStatus: err instanceof ZinixError ? err.status : null, requestId: fe.requestId, at: now().toISOString() };
      record = repository.update(record.id, { status: incerto ? 'envio_incerto' : 'erro_envio', lastError });
      audit('simulation.submit_failed', { userId: usuario.id, opportunityId: record.opportunityId, simulationId: record.id, requestId: fe.requestId, status: record.status, httpStatus: lastError.httpStatus, errorCode: fe.code });
      fe.simulation = view(record);
      if (incerto && fe.code === 'timeout') fe.message = 'A plataforma de financiamento não respondeu a tempo. Use "Tentar novamente": o reenvio usa a mesma identificação e não duplica a consulta.';
      throw fe;
    }
  }

  return {
    async empresas() {
      try {
        const selecionada = await legalEntityId();
        const lista = await cached('entities', ENTITY_TTL_MS, () => adapter.listLegalEntities());
        return lista.filter((e) => e && e.id).map((e) => ({
          id: e.id, nome: e.trade_name || e.legal_name || 'Empresa', cnpjMascarado: str(e.cnpj_masked, 30),
          ativa: e.status === 'active', principal: e.is_primary === true, selecionada: e.id === selecionada,
        }));
      } catch (err) { throw traduzir(err); }
    },
    async bancos() {
      try {
        const entity = await legalEntityId();
        const lista = await cached(`banks|${entity}`, ENTITY_TTL_MS, () => adapter.listBanks(entity));
        return lista.filter((b) => b && b.code).map((b) => ({ code: String(b.code), name: String(b.name || b.code), status: str(b.status, 30), habilitado: b.enabled_for_simulation === true }));
      } catch (err) { throw traduzir(err); }
    },
    async billing() {
      try {
        const b = await adapter.getBilling();
        return {
          modo: b.mode === 'unlimited' ? 'ilimitado' : 'pre_pago',
          podeEnviar: b.can_submit === true,
          podeConsultarNovoCpf: b.can_submit_new_cpf === true,
          saldo: num(b.balance),
          restanteNoMes: num(b.monthly_quota_remaining),
          periodo: str(b.current_period, 20),
        };
      } catch (err) { throw traduzir(err); }
    },
    async marcas(type) {
      if (!['car', 'motorcycle'].includes(type)) throw new FinancingError(400, 'Tipo de veículo inválido.', { code: 'tipo_invalido' });
      try { return await catalogo('brands', { type }); } catch (err) { throw traduzir(err); }
    },
    async modelos(type, brandCode) {
      if (!['car', 'motorcycle'].includes(type) || !brandCode) throw new FinancingError(400, 'Selecione tipo e marca.', { code: 'parametros' });
      try { return await catalogo('models', { type, brandCode }); } catch (err) { throw traduzir(err); }
    },
    async versoes(type, brandCode, modelCode, manufactureYear, modelYear) {
      if (!['car', 'motorcycle'].includes(type) || !brandCode || !modelCode || !Number.isSafeInteger(manufactureYear) || !Number.isSafeInteger(modelYear) || modelYear < manufactureYear) {
        throw new FinancingError(400, 'Selecione tipo, marca, modelo e anos válidos.', { code: 'parametros' });
      }
      try { return await catalogo('versions', { type, brandCode, modelCode, manufactureYear, modelYear }); } catch (err) { throw traduzir(err); }
    },

    // ZINIX-MVP-002A: grava/edita dados do cliente no próprio registro da oportunidade.
    async salvarCliente(usuario, opportunityId, body) {
      const lead = oportunidade(opportunityId, usuario);
      const patch = validarCliente(body, now());
      const atualizado = store.updateFinancingData(lead.id, patch);
      audit('customer.updated', { userId: usuario.id, opportunityId: lead.id });
      return atualizado;
    },

    // ZINIX-MVP-002A: estrutura técnica do MESMO veículo da oportunidade.
    // Códigos e nomes conferidos no catálogo (nada digitado/inventado), e a
    // confirmação fica amarrada ao texto atual de vehicleInterest.
    async salvarVeiculo(usuario, opportunityId, body) {
      const lead = oportunidade(opportunityId, usuario);
      const erros = {};
      const v = validarVeiculo(body && typeof body === 'object' && !Array.isArray(body) ? body : {}, now(), erros);
      if (Object.keys(erros).length) throw new FinancingError(400, 'Confira os campos destacados.', { code: 'dados_invalidos', fields: erros });
      let c;
      try { c = await veiculoDoCatalogo(v); } catch (err) { throw traduzir(err); }
      const atualizado = store.updateFinancingData(lead.id, {
        vehicleType: c.type, vehicleBrandCode: c.brand_code, vehicleBrandName: c.brand_name, vehicleModelCode: c.model_code, vehicleModelName: c.model_name,
        vehicleVersionCode: c.version_code, vehicleVersionName: c.version_name, vehicleManufactureYear: c.manufacture_year, vehicleModelYear: c.model_year,
        vehicleZeroKm: c.zero_km, vehicleCatalogInterest: String(lead.vehicleInterest || '').trim(), vehicleCatalogConfirmedAt: now().toISOString(),
      });
      audit('vehicle.confirmed', { userId: usuario.id, opportunityId: lead.id });
      return atualizado;
    },

    async criarSimulacao(usuario, body) {
      const lead = oportunidade(body && body.opportunityId, usuario);
      const dados = validarEntrada(completarComCrm(body, lead), now());
      limitarCriacao(usuario.id);
      let payload;
      try {
        const entity = await legalEntityId();
        payload = { legal_entity_id: entity, applicant: dados.applicant, vehicle: await veiculoDoCatalogo(dados.vehicle), terms: dados.terms };
      } catch (err) { throw traduzir(err); }
      const canonico = JSON.stringify(payload);
      const t = now().getTime();

      // Mesma intencao recente do mesmo usuario? (duplo clique, reenvio apos timeout)
      for (const r of repository.listByOpportunity(lead.id)) {
        if (r.userId !== usuario.id || !r.hashSalt || t - Date.parse(r.createdAt) > RETRY_WINDOW_MS) continue;
        if (hmac(r.hashSalt, canonico) !== r.payloadHash) continue;
        if (['enviando', 'envio_incerto'].includes(r.status)) {
          audit('simulation.retry_same_key', { userId: usuario.id, opportunityId: lead.id, simulationId: r.id });
          return view(await enviar(r, payload, usuario), await bancosPorCodigo(payload.legal_entity_id));
        }
        if (r.zinixSimulationId && !TERMINAL.has(r.status) && t - Date.parse(r.createdAt) < DUPLICATE_WINDOW_MS) {
          audit('simulation.duplicate_ignored', { userId: usuario.id, opportunityId: lead.id, simulationId: r.id });
          return view(r, await bancosPorCodigo(payload.legal_entity_id));
        }
      }

      // Nova intencao: chave gerada e PERSISTIDA antes do POST.
      const salt = crypto.randomBytes(16).toString('hex');
      const agoraIso = now().toISOString();
      const record = repository.create({
        id: crypto.randomUUID(),
        opportunityId: lead.id,
        userId: usuario.id,
        userName: usuario.nome || null,
        legalEntityId: payload.legal_entity_id,
        idempotencyKey: `vtcar.${crypto.randomUUID()}`,
        hashSalt: salt,
        payloadHash: hmac(salt, canonico),
        status: 'enviando',
        vehicle: { ...payload.vehicle },
        // Referência comercial da oportunidade no momento da simulação (texto do
        // veículo de interesse, sem dado pessoal). Permite à tela avisar quando o
        // veículo de interesse mudou depois e a identificação precisa ser revalidada.
        vehicleInterest: str(lead.vehicleInterest, 120) || null,
        terms: { ...payload.terms },
        attempts: 0,
        zinixSimulationId: null,
        requestId: null,
        progress: null,
        results: [],
        error: null,
        createdAt: agoraIso,
        updatedAt: agoraIso,
      });
      audit('simulation.intent_saved', { userId: usuario.id, opportunityId: lead.id, simulationId: record.id });
      return view(await enviar(record, payload, usuario), await bancosPorCodigo(payload.legal_entity_id));
    },

    async consultarSimulacao(usuario, id) {
      let r = typeof id === 'string' ? repository.getById(id) : null;
      // UUID nao e autorizacao: a leitura exige acesso a oportunidade dona.
      if (!r || !podeAcessar(store.getLeadById(r.opportunityId), usuario)) {
        throw new FinancingError(404, 'Simulação não encontrada.', { code: 'nao_encontrada' });
      }
      const nomes = await bancosPorCodigo(r.legalEntityId);
      const t = now().getTime();
      if (TERMINAL.has(r.status) || !r.zinixSimulationId || (r.nextPollAt && Date.parse(r.nextPollAt) > t)) return view(r, nomes);
      try {
        const res = await adapter.getSimulation(r.zinixSimulationId);
        const d = res.data;
        const espera = Math.max(MIN_POLL_MS, num(d.retry_after_ms) || 0, res.retryAfterMs || 0);
        const terminal = TERMINAL.has(d.status);
        r = repository.update(r.id, {
          status: d.status,
          progress: sanitizeProgress(d.progress),
          results: sanitizeResults(d.results),
          error: sanitizeError(d.error),
          requestId: res.requestId || r.requestId,
          lastPolledAt: now().toISOString(),
          nextPollAt: new Date(t + espera).toISOString(),
          completedAt: terminal ? now().toISOString() : null,
        });
        if (terminal) audit('simulation.finished', { userId: usuario.id, opportunityId: r.opportunityId, simulationId: r.id, zinixSimulationId: r.zinixSimulationId, requestId: res.requestId, status: d.status });
        return view(r, nomes);
      } catch (err) {
        const fe = traduzir(err);
        const espera = Math.max(MIN_POLL_MS, fe.retryAfterMs || 0);
        r = repository.update(r.id, { nextPollAt: new Date(t + espera).toISOString(), lastError: { code: fe.code, httpStatus: err.status || null, requestId: fe.requestId, at: now().toISOString() } });
        audit('simulation.poll_failed', { userId: usuario.id, opportunityId: r.opportunityId, simulationId: r.id, requestId: fe.requestId, httpStatus: err.status || null, errorCode: fe.code });
        // A tela continua mostrando o ultimo estado conhecido + aviso.
        return { ...view(r, nomes), aviso: fe.message };
      }
    },

    async listarDaOportunidade(usuario, opportunityId) {
      const lead = oportunidade(opportunityId, usuario);
      const lista = repository.listByOpportunity(lead.id).slice(0, 20);
      const nomes = lista.length ? await bancosPorCodigo(lista[0].legalEntityId) : new Map();
      return lista.map((r) => view(r, nomes));
    },
  };
}

module.exports = { createFinancingService, FinancingError, validarEntrada, validarCliente, cpfValido, sanitizeResults, traduzir, MIN_POLL_MS };
