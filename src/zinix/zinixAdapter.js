// Adaptador REST da API Zinix (https://saas.zinix.com.br/v1).
//
// E o UNICO lugar do backend que conhece HTTP, URL, cabecalhos e formato de
// erro da Zinix. O resto do sistema chama os metodos abaixo e recebe dados
// ou um ZinixError ja traduzido.
//
// Por que REST e nao o SDK oficial (@zinix/sdk): o SDK exige Node >= 22 e e
// ESM; a producao ainda roda Node 18 (decisao CTO, ZINIX-MVP-001). O contrato
// seguido aqui e o mesmo do SDK 0.1.0 (src/client.ts): listas vem em
// { data: [...] }, a simulacao vem direta com { id, status }, erros vem em
// { error: { code, message, ... } } e o request id vem no header X-Request-Id
// ou no corpo. Trocar este arquivo pelo SDK depois nao muda quem o usa.
//
// Seguranca:
// - a chave (ZINIX_API_KEY) so e lida aqui, so vai no header Authorization e
//   nunca entra em mensagem de erro, log ou resposta;
// - nenhum corpo de requisicao ou resposta e registrado em log;
// - ids que vao para a URL sao validados (UUID), pra nao abrir caminho
//   arbitrario na API do fornecedor;
// - sem retry automatico: o POST de simulacao NUNCA e repetido por aqui.

const DEFAULT_BASE_URL = 'https://saas.zinix.com.br/v1';
const DEFAULT_TIMEOUT_MS = 20000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const SIMULATION_STATUSES = new Set(['queued', 'processing', 'completed', 'partial', 'failed', 'expired']);

class ZinixError extends Error {
  // kind: 'config' | 'validation' | 'api' | 'timeout' | 'network' | 'protocol'
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ZinixError';
    this.kind = kind;
    this.status = extra.status ?? null; // HTTP status da Zinix (so em kind 'api')
    this.code = extra.code || kind;
    this.requestId = extra.requestId || null;
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.retryable = extra.retryable ?? null;
  }
}

function parseRetryAfter(value) {
  if (!value) return null;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null;
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ZinixError('validation', `${name} inválido.`, { code: 'invalid_id' });
  }
  return value;
}

function createZinixAdapter(options = {}) {
  const fetchImpl = options.fetch || ((...args) => globalThis.fetch(...args));
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  // Lida a cada chamada: permite configurar a variavel no Railway sem
  // depender da ordem de carregamento dos modulos.
  const getApiKey = options.getApiKey || (() => process.env.ZINIX_API_KEY);

  function configured() {
    const key = getApiKey();
    return typeof key === 'string' && key.trim() !== '' && !/\s/.test(key.trim());
  }

  async function request(method, path, { query, body, idempotencyKey } = {}) {
    const apiKey = (getApiKey() || '').trim();
    if (!apiKey || /\s/.test(apiKey)) {
      throw new ZinixError('config', 'Integração de financiamento não configurada.', { code: 'not_configured' });
    }
    let url = `${baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.set(k, String(v));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const headers = { Accept: 'application/json', Authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      text = await response.text();
    } catch (_) {
      // O erro original do fetch nao e propagado: pode carregar URL/headers.
      if (timedOut) {
        throw new ZinixError('timeout', 'A Zinix não respondeu a tempo.', { code: 'timeout' });
      }
      throw new ZinixError('network', 'Não foi possível acessar a Zinix.', { code: 'network_error' });
    } finally {
      clearTimeout(timer);
    }

    let decoded;
    try { decoded = JSON.parse(text.split(apiKey).join('[REDACTED]')); } catch (_) { decoded = undefined; }
    const requestId = response.headers.get('x-request-id')
      || (isRecord(decoded) && typeof decoded.request_id === 'string' ? decoded.request_id : null);
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

    if (!response.ok) {
      const err = isRecord(decoded) && isRecord(decoded.error) ? decoded.error : {};
      throw new ZinixError('api', `Zinix respondeu HTTP ${response.status}.`, {
        status: response.status,
        code: typeof err.code === 'string' ? err.code.slice(0, 80) : `http_${response.status}`,
        requestId,
        retryAfterMs,
        retryable: typeof err.retryable === 'boolean' ? err.retryable : null,
      });
    }
    if (!isRecord(decoded)) {
      throw new ZinixError('protocol', 'Resposta inesperada da Zinix.', { code: 'protocol_error', requestId });
    }
    return { data: decoded, requestId, retryAfterMs, status: response.status };
  }

  async function list(path, query) {
    const res = await request('GET', path, { query });
    if (!Array.isArray(res.data.data)) {
      throw new ZinixError('protocol', 'Lista esperada na resposta da Zinix.', { code: 'protocol_error', requestId: res.requestId });
    }
    return res.data.data;
  }

  function checkSimulation(res) {
    const sim = res.data;
    if (typeof sim.id !== 'string' || !UUID.test(sim.id) || !SIMULATION_STATUSES.has(String(sim.status))) {
      throw new ZinixError('protocol', 'Resposta de simulação inválida.', { code: 'protocol_error', requestId: res.requestId });
    }
    return {
      data: sim,
      requestId: res.requestId || (typeof sim.request_id === 'string' ? sim.request_id : null),
      retryAfterMs: res.retryAfterMs,
      httpStatus: res.status,
    };
  }

  function catalogQuery(q, level) {
    requireUuid(q.legalEntityId, 'legal_entity_id');
    if (!['car', 'motorcycle'].includes(q.type)) throw new ZinixError('validation', 'Tipo de veículo inválido.', { code: 'invalid_type' });
    const query = { legal_entity_id: q.legalEntityId, type: q.type };
    if (level >= 2) {
      if (!q.brandCode) throw new ZinixError('validation', 'Marca obrigatória.', { code: 'brand_required' });
      query.brand_code = q.brandCode;
    }
    if (level >= 3) {
      if (!q.modelCode) throw new ZinixError('validation', 'Modelo obrigatório.', { code: 'model_required' });
      query.model_code = q.modelCode;
      query.manufacture_year = q.manufactureYear;
      query.model_year = q.modelYear;
    }
    return query;
  }

  return {
    configured,
    // Todos os metodos sao async: erro de validacao vira promise rejeitada,
    // nunca excecao sincrona (mesmo comportamento para quem chama).
    listLegalEntities: async () => list('/legal-entities'),
    listBanks: async (legalEntityId) => list(`/legal-entities/${requireUuid(legalEntityId, 'legal_entity_id')}/banks`),
    async getBilling() {
      const res = await request('GET', '/billing');
      if (!isRecord(res.data.data)) throw new ZinixError('protocol', 'Resposta de billing inválida.', { code: 'protocol_error', requestId: res.requestId });
      return res.data.data;
    },
    brands: async (q) => list('/vehicles/brands', catalogQuery(q, 1)),
    models: async (q) => list('/vehicles/models', catalogQuery(q, 2)),
    versions: async (q) => list('/vehicles/versions', catalogQuery(q, 3)),
    async createSimulation(payload, idempotencyKey) {
      if (!IDEMPOTENCY_KEY.test(String(idempotencyKey || ''))) {
        throw new ZinixError('validation', 'Chave de idempotência inválida.', { code: 'invalid_idempotency_key' });
      }
      requireUuid(payload && payload.legal_entity_id, 'legal_entity_id');
      return checkSimulation(await request('POST', '/simulations', { body: payload, idempotencyKey }));
    },
    async getSimulation(id) {
      return checkSimulation(await request('GET', `/simulations/${requireUuid(id, 'simulation id')}`));
    },
  };
}

module.exports = { createZinixAdapter, ZinixError, UUID, IDEMPOTENCY_KEY, SIMULATION_STATUSES };
