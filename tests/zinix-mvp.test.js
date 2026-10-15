// ZINIX-MVP-001 — testes do Financiamento com a Zinix SIMULADA.
// Nenhuma chamada real: o adapter recebe um fetch falso. Dados sinteticos.
// Tudo roda numa copia de src/ num diretorio temporario (nunca abre data/ real).
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(__dirname, '../.test-zinix-'));
fs.cpSync(path.join(__dirname, '../src'), path.join(root, 'src'), { recursive: true });
process.env.JWT_SECRET = 'local-test-secret-zinix';
delete process.env.CRM_API_KEY;
delete process.env.ZINIX_LEGAL_ENTITY_ID;
const DATA = path.join(root, 'data');
fs.mkdirSync(DATA, { recursive: true });

const store = require(path.join(root, 'src/store'));
const { gerarToken, exigirAuth } = require(path.join(root, 'src/auth/middleware'));
const { createZinixAdapter } = require(path.join(root, 'src/zinix/zinixAdapter'));
const { createFinancingRepository } = require(path.join(root, 'src/zinix/financingRepository'));
const { createFinancingService, MIN_POLL_MS } = require(path.join(root, 'src/zinix/financingService'));
const { createFinancingRouter } = require(path.join(root, 'src/routes/financiamento'));

const API_KEY = 'zx_test_FAKE_KEY_0123456789';
const ENTITY = '11111111-1111-4111-8111-111111111111';
const ENTITY2 = '22222222-2222-4222-8222-222222222222';
const SIM = '33333333-3333-4333-8333-333333333333';
const SIM2 = '44444444-4444-4444-8444-444444444444';
const CPF = '52998224725'; // sintetico, digitos verificadores validos
const PII = [CPF, '529.982.247-25', 'cliente.teste@example.invalid', '43999887766', '1990-05-20', 'Cliente Teste Financiamento'];

const users = [
  { id: 'v1', nome: 'Ana', papel: 'vendedor', ativo: true },
  { id: 'v2', nome: 'Bia', papel: 'vendedor', ativo: true },
  { id: 'g', nome: 'Gerente', papel: 'gerente', ativo: true },
];
const leads = [
  { id: 'opp1', sourceId: 'opp1', name: 'Cliente Teste Financiamento', stage: 'negociacao', ownerId: 'v1', recordType: 'opportunity', vehicleInterest: 'POP 100', createdAt: '2026-10-01T10:00:00Z' },
  { id: 'opp2', sourceId: 'opp2', name: 'Outro Cliente', stage: 'novo', ownerId: 'v2', recordType: 'opportunity', createdAt: '2026-10-01T10:00:00Z' },
  { id: 'free', sourceId: 'free', name: 'Lead Livre', stage: 'novo', createdAt: '2026-10-01T10:00:00Z' },
];
const EXISTENTES = {
  'usuarios.json': JSON.stringify(users), 'leads.json': JSON.stringify(leads, null, 2),
  'messages.json': JSON.stringify({ chat: [{ text: 'oi', direction: 'cliente', at: '2026-10-01T10:00:00Z' }] }),
  'coach.json': '{}', 'convites.json': '[]', 'last-webhook.json': 'null', 'jwt-secret.txt': 'nao-usado',
};

// ---------------------------------------------------------------- Zinix falsa
let calls = [];
let routes = {};
let clock = new Date('2026-10-14T15:00:00Z');
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function defaultRoutes() {
  return {
    'GET /legal-entities': () => json(200, { data: [
      { id: ENTITY2, legal_name: 'Filial', trade_name: null, cnpj_masked: '**.***.***/0002-**', is_primary: false, status: 'active' },
      { id: ENTITY, legal_name: 'VT CAR LTDA', trade_name: 'VT Car', cnpj_masked: '**.***.***/0001-**', is_primary: true, status: 'active' },
    ] }, { 'x-request-id': 'req-le' }),
    [`GET /legal-entities/${ENTITY}/banks`]: () => json(200, { data: [
      { code: 'bv', name: 'BV', status: 'active', enabled_for_simulation: true },
      { code: 'santander', name: 'Santander', status: 'active', enabled_for_simulation: true },
    ] }),
    'GET /billing': () => json(200, { data: { mode: 'prepaid', balance: 48, can_submit: true, can_submit_new_cpf: true, current_period: '2026-10', monthly_quota: 50, monthly_topup_credits: 0, monthly_unique_cpfs_used: 2, monthly_quota_remaining: 48, unit: 'unique_cpf_month', timezone: 'America/Sao_Paulo' } }),
    'GET /vehicles/brands': () => json(200, { data: [{ code: '59', name: 'TOYOTA' }, { code: '23', name: 'HONDA' }] }),
    'GET /vehicles/models': () => json(200, { data: [{ code: '5001', name: 'COROLLA' }] }),
    'GET /vehicles/versions': () => json(200, { data: [{ code: '5001-24-XEI', name: 'COROLLA XEI 2.0 FLEX' }] }),
    'POST /simulations': () => json(202, { id: SIM, status: 'queued', status_url: `/v1/simulations/${SIM}`, retry_after_ms: 20000, request_id: 'req-post', idempotent_replay: false,
      billing: {}, billing_charge: { debited: true, units: 1, period: '2026-10', unit: 'unique_cpf_month', reason: 'new_cpf_this_month', balance_after: 47 } }, { 'x-request-id': 'req-post' }),
    [`GET /simulations/${SIM}`]: () => simulation('processing', 3, 8, []),
  };
}
function simulation(status, finished, expected, results, extra = {}) {
  return json(200, { id: SIM, legal_entity_id: ENTITY, status, progress: { expected_banks: expected, finished_banks: finished, pending_banks: expected - finished },
    results, status_url: `/v1/simulations/${SIM}`, retry_after_ms: 20000, created_at: '2026-10-14T15:00:00Z', updated_at: '2026-10-14T15:00:20Z', request_id: 'req-get', ...extra });
}
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  assert.ok(u.href.startsWith('https://saas.zinix.com.br/v1/'), u.href);
  const p = u.pathname.replace(/^\/v1/, '');
  calls.push({ method: init.method, path: p, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
  const h = routes[`${init.method} ${p}`];
  if (!h) return json(404, { error: { code: 'not_found', message: 'nada' } });
  return h({ url: u, init, body: init.body ? JSON.parse(init.body) : undefined });
}

// ---------------------------------------------------------------- app de teste
let server; let base; let logs = [];
const auditLines = [];
const repository = createFinancingRepository({ dataDir: DATA });
let apiKey = API_KEY;
const adapter = createZinixAdapter({ fetch: fakeFetch, getApiKey: () => apiKey, timeoutMs: 300 });
const service = createFinancingService({ adapter, repository, store, now: () => clock,
  audit: (evt, f) => { auditLines.push({ evt, ...f }); } });
const origLog = console.log; const origErr = console.error; const origWarn = console.warn;

before(async () => {
  for (const [f, c] of Object.entries(EXISTENTES)) fs.writeFileSync(path.join(DATA, f), c);
  const app = express();
  app.use(express.json());
  app.use('/api/financiamento', exigirAuth, createFinancingRouter(service));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const cap = (orig) => (...a) => { logs.push(a.map(String).join(' ')); };
  console.log = cap(origLog); console.error = cap(origErr); console.warn = cap(origWarn);
});
beforeEach(() => {
  calls = []; routes = defaultRoutes(); apiKey = API_KEY;
  clock = new Date(clock.getTime() + 60 * 60 * 1000); // isola janelas de reenvio/limite entre testes
});
after(async () => {
  console.log = origLog; console.error = origErr; console.warn = origWarn;
  if (server) await new Promise((r) => server.close(r));
  assert.ok(path.resolve(root).startsWith(path.resolve(__dirname, '..') + path.sep + '.test-zinix-'));
  fs.rmSync(root, { recursive: true, force: true });
});

const token = (id) => gerarToken(users.find((u) => u.id === id));
async function api(method, url, body, who = 'v1') {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${token(who)}`;
  const r = await fetch(base + '/api/financiamento' + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
}
const form = (over = {}) => ({
  opportunityId: 'opp1',
  applicant: { document: '529.982.247-25', name: 'Cliente Teste Financiamento', birthDate: '1990-05-20', gender: 'female', email: 'cliente.teste@example.invalid',
    phone: '(43) 99988-7766', state: 'PR', city: 'Londrina', hasDriverLicense: true, ...(over.applicant || {}) },
  vehicle: { type: 'car', brandCode: '59', modelCode: '5001', versionCode: '5001-24-XEI', manufactureYear: 2024, modelYear: 2025, zeroKm: false, ...(over.vehicle || {}) },
  terms: { assetValue: 129900, downPayment: 30000, installments: [60, 24, 48, 36], ...(over.terms || {}) },
  ...(over.root || {}),
});
const posts = () => calls.filter((c) => c.method === 'POST');
const tick = (ms) => { clock = new Date(clock.getTime() + ms); };
const zinixFile = () => path.join(DATA, 'zinix-simulations.json');

// ============================================================== leitura
test('sem login: todas as rotas respondem 401', async () => {
  for (const u of ['/empresas', '/bancos', '/billing', '/veiculos/marcas?tipo=car', '/simulacoes/x', '/oportunidades/opp1/simulacoes']) {
    assert.equal((await api('GET', u, undefined, null)).status, 401, u);
  }
  assert.equal((await api('POST', '/simulacoes', form(), null)).status, 401);
  assert.equal(calls.length, 0);
});

test('legal entities: Authorization Bearer só no servidor, empresa principal selecionada, resposta minimizada', async () => {
  const r = await api('GET', '/empresas');
  assert.equal(r.status, 200);
  const c = calls.find((x) => x.path === '/legal-entities');
  assert.equal(c.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(c.headers.Accept, 'application/json');
  assert.deepEqual(r.body.find((e) => e.selecionada).id, ENTITY);
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['ativa', 'cnpjMascarado', 'id', 'nome', 'principal', 'selecionada']);
  assert.ok(!JSON.stringify(r.body).includes(API_KEY));
});

test('banks da empresa selecionada', async () => {
  const r = await api('GET', '/bancos');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((b) => b.name), ['BV', 'Santander']);
  assert.ok(calls.some((c) => c.path === `/legal-entities/${ENTITY}/banks`));
});

test('billing minimizado', async () => {
  const r = await api('GET', '/billing');
  assert.deepEqual(r.body, { modo: 'pre_pago', podeEnviar: true, podeConsultarNovoCpf: true, saldo: 48, restanteNoMes: 48, periodo: '2026-10' });
});

test('catálogo: marcas, modelos e versões com parâmetros do contrato e cache', async () => {
  assert.deepEqual((await api('GET', '/veiculos/marcas?tipo=car')).body, [{ code: '59', name: 'TOYOTA' }, { code: '23', name: 'HONDA' }]);
  assert.deepEqual((await api('GET', '/veiculos/modelos?tipo=car&marca=59')).body, [{ code: '5001', name: 'COROLLA' }]);
  assert.deepEqual((await api('GET', '/veiculos/versoes?tipo=car&marca=59&modelo=5001&anoFabricacao=2024&anoModelo=2025')).body, [{ code: '5001-24-XEI', name: 'COROLLA XEI 2.0 FLEX' }]);
  assert.deepEqual(calls.find((c) => c.path === '/vehicles/models').query, { legal_entity_id: ENTITY, type: 'car', brand_code: '59' });
  assert.deepEqual(calls.find((c) => c.path === '/vehicles/versions').query, { legal_entity_id: ENTITY, type: 'car', brand_code: '59', model_code: '5001', manufacture_year: '2024', model_year: '2025' });
  const antes = calls.length;
  await api('GET', '/veiculos/marcas?tipo=car');
  assert.equal(calls.length, antes, 'segunda consulta vem do cache');
  assert.equal((await api('GET', '/veiculos/versoes?tipo=car&marca=59&modelo=5001&anoFabricacao=2025&anoModelo=2024')).status, 400, 'ano modelo < fabricação');
  assert.equal((await api('GET', '/veiculos/marcas?tipo=aviao')).status, 400);
});

// ============================================================== criação
test('POST 202: intenção persistida ANTES do POST, mesma chave no header, CPF fora do arquivo', async () => {
  let gravadoNoMomentoDoPost = null;
  routes['POST /simulations'] = ({ init }) => {
    gravadoNoMomentoDoPost = JSON.parse(fs.readFileSync(zinixFile(), 'utf8')).at(-1);
    assert.equal(init.headers['Idempotency-Key'], gravadoNoMomentoDoPost.idempotencyKey);
    return defaultRoutes()['POST /simulations']();
  };
  const r = await api('POST', '/simulacoes', form());
  assert.equal(r.status, 202);
  assert.equal(gravadoNoMomentoDoPost.status, 'enviando');
  assert.match(gravadoNoMomentoDoPost.idempotencyKey, /^[A-Za-z0-9._:-]{8,128}$/);
  assert.equal(r.body.status, 'queued');
  assert.equal(r.body.terminal, false);
  assert.ok(r.body.nextPollInMs >= MIN_POLL_MS);
  assert.equal(r.body.idempotencyKey, undefined); assert.equal(r.body.payloadHash, undefined); assert.equal(r.body.hashSalt, undefined);
  const enviado = posts()[0].body;
  assert.deepEqual(enviado.applicant, { document: CPF, gender: 'female', name: 'Cliente Teste Financiamento', birth_date: '1990-05-20', email: 'cliente.teste@example.invalid', phone: '43999887766', state: 'PR', city: 'Londrina', has_driver_license: true });
  assert.deepEqual(enviado.vehicle, { type: 'car', brand_code: '59', brand_name: 'TOYOTA', model_code: '5001', model_name: 'COROLLA', version_code: '5001-24-XEI', version_name: 'COROLLA XEI 2.0 FLEX', manufacture_year: 2024, model_year: 2025, zero_km: false });
  assert.deepEqual(enviado.terms, { asset_value_cents: 12990000, down_payment_cents: 3000000, installments: [24, 36, 48, 60] });
  assert.equal(enviado.legal_entity_id, ENTITY);
  const arquivo = fs.readFileSync(zinixFile(), 'utf8');
  for (const dado of PII) assert.ok(!arquivo.includes(dado), `arquivo não guarda ${dado}`);
  const rec = JSON.parse(arquivo).find((x) => x.id === r.body.id);
  assert.equal(rec.zinixSimulationId, SIM); assert.equal(rec.requestId, 'req-post'); assert.equal(rec.userId, 'v1'); assert.equal(rec.opportunityId, 'opp1');
  assert.deepEqual(rec.billingCharge, { debited: true, units: 1, reason: 'new_cpf_this_month', balance_after: 47 });
});

test('MVP-002: registro guarda o veículo de interesse da oportunidade (referência), nunca dados pessoais do cliente', async () => {
  const r = await api('POST', '/simulacoes', form());
  assert.equal(r.status, 202);
  assert.equal(r.body.vehicleInterest, 'POP 100');
  const rec = JSON.parse(fs.readFileSync(zinixFile(), 'utf8')).find((x) => x.id === r.body.id);
  assert.equal(rec.vehicleInterest, 'POP 100');
  assert.equal(rec.applicant, undefined);
  const arquivo = fs.readFileSync(zinixFile(), 'utf8');
  for (const dado of [...PII, 'Londrina']) assert.ok(!arquivo.includes(dado), `arquivo não guarda ${dado}`);
  assert.ok(!posts()[0].body.vehicleInterest, 'referência comercial não vai para a Zinix');
  const lista = await api('GET', '/oportunidades/opp1/simulacoes');
  assert.equal(lista.body.find((x) => x.id === r.body.id).vehicleInterest, 'POP 100');
});

test('nomes do veículo vêm do catálogo; código fora do catálogo não é enviado', async () => {
  const r = await api('POST', '/simulacoes', form({ vehicle: { versionCode: 'INVENTADO' } }));
  assert.equal(r.status, 400); assert.ok(r.body.fields['vehicle.versionCode']);
  assert.equal(posts().length, 0);
});

test('validações: nada manifestamente inválido chega à Zinix', async () => {
  const casos = [
    [{ applicant: { document: '111.111.111-11' } }, 'applicant.document'],
    [{ applicant: { document: '529.982.247-24' } }, 'applicant.document'],
    [{ applicant: { birthDate: '2015-01-01' } }, 'applicant.birthDate'],
    [{ applicant: { birthDate: '1990-02-30' } }, 'applicant.birthDate'],
    [{ applicant: { gender: 'x' } }, 'applicant.gender'],
    [{ applicant: { email: 'sem-arroba' } }, 'applicant.email'],
    [{ applicant: { phone: '1234' } }, 'applicant.phone'],
    [{ applicant: { state: 'XX' } }, 'applicant.state'],
    [{ applicant: { city: '' } }, 'applicant.city'],
    [{ applicant: { hasDriverLicense: 'sim' } }, 'applicant.hasDriverLicense'],
    [{ vehicle: { modelYear: 2023 } }, 'vehicle.modelYear'],
    [{ vehicle: { type: 'truck' } }, 'vehicle.type'],
    [{ terms: { downPayment: 129900 } }, 'terms.downPayment'],
    [{ terms: { assetValue: 0 } }, 'terms.assetValue'],
    [{ terms: { assetValue: 100.555 } }, 'terms.assetValue'],
    [{ terms: { installments: [] } }, 'terms.installments'],
    [{ terms: { installments: [85] } }, 'terms.installments'],
    [{ terms: { installments: [12, 12] } }, 'terms.installments'],
    [{ terms: { installments: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] } }, 'terms.installments'],
  ];
  for (const [over, campo] of casos) {
    const r = await api('POST', '/simulacoes', form(over));
    assert.equal(r.status, 400, campo); assert.ok(r.body.fields[campo], campo);
  }
  assert.equal(posts().length, 0);
  // Prazos aceitos fora da lista "comum": 1 e 84, até 12 opções.
  assert.equal((await api('POST', '/simulacoes', form({ terms: { installments: [1, 84, 7, 13, 18, 30, 42, 54, 66, 72, 78, 6] } }))).status, 202);
});

test('ownership: vendedor só na própria oportunidade; lead livre não simula', async () => {
  assert.equal((await api('POST', '/simulacoes', form({ root: { opportunityId: 'opp2' } }), 'v1')).status, 404);
  assert.equal((await api('POST', '/simulacoes', form({ root: { opportunityId: 'free' } }), 'v1')).status, 400);
  assert.equal((await api('POST', '/simulacoes', form({ root: { opportunityId: 'nao-existe' } }), 'v1')).status, 404);
  assert.equal(posts().length, 0);
});

test('UUID não é autorização: vendedor alheio não lê; dono e gerente leem', async () => {
  const criado = (await api('POST', '/simulacoes', form())).body;
  assert.equal((await api('GET', `/simulacoes/${criado.id}`, undefined, 'v2')).status, 404);
  assert.equal((await api('GET', '/oportunidades/opp1/simulacoes', undefined, 'v2')).status, 404);
  assert.equal((await api('GET', `/simulacoes/${criado.id}`, undefined, 'v1')).status, 200);
  assert.equal((await api('GET', `/simulacoes/${criado.id}`, undefined, 'g')).status, 200);
  const lista = await api('GET', '/oportunidades/opp1/simulacoes', undefined, 'g');
  assert.ok(lista.body.some((s) => s.id === criado.id));
  // gerente cria em oportunidade de vendedor (regra existente de edição comercial)
  assert.equal((await api('POST', '/simulacoes', form({ root: { opportunityId: 'opp2' }, applicant: { document: '153.509.460-56' } }), 'g')).status, 202);
});

// ============================================================== polling e status
test('polling: nunca consulta a Zinix antes de 20s nem antes do retry_after; segue até status terminal', async () => {
  const criado = (await api('POST', '/simulacoes', form())).body;
  const gets = () => calls.filter((c) => c.path === `/simulations/${SIM}`).length;
  await api('GET', `/simulacoes/${criado.id}`);
  assert.equal(gets(), 0, 'antes de 20s devolve o estado guardado');
  tick(MIN_POLL_MS);
  routes[`GET /simulations/${SIM}`] = () => simulation('processing', 5, 8, [], { retry_after_ms: 40000 });
  let r = await api('GET', `/simulacoes/${criado.id}`);
  assert.equal(gets(), 1);
  assert.deepEqual(r.body.progress, { expected_banks: 8, finished_banks: 5, pending_banks: 3 });
  assert.ok(r.body.nextPollInMs >= 40000 - 1, 'retry_after_ms maior que 20s é respeitado');
  tick(25000); await api('GET', `/simulacoes/${criado.id}`); assert.equal(gets(), 1);
  tick(15000);
  routes[`GET /simulations/${SIM}`] = () => simulation('completed', 8, 8, [{ bank: 'bv', status: 'completed', conditions: [] }]);
  r = await api('GET', `/simulacoes/${criado.id}`);
  assert.equal(r.body.status, 'completed'); assert.equal(r.body.terminal, true); assert.equal(r.body.nextPollInMs, null);
  tick(MIN_POLL_MS); await api('GET', `/simulacoes/${criado.id}`);
  assert.equal(gets(), 2, 'status terminal não consulta mais a Zinix');
});

for (const status of ['queued', 'processing', 'completed', 'partial', 'failed', 'expired']) {
  test(`status da simulação: ${status}`, async () => {
    const criado = (await api('POST', '/simulacoes', form())).body;
    tick(MIN_POLL_MS);
    routes[`GET /simulations/${SIM}`] = () => simulation(status, status === 'queued' ? 0 : 4, 8,
      status === 'partial' ? [{ bank: 'bv', status: 'completed', conditions: [{ installments: 48, installment_value_cents: 284900, monthly_rate: 1.49, down_payment_cents: 3000000, financed_amount_cents: 9990000, condition_id: 'c1' }] },
        { bank: 'santander', status: 'timed_out', conditions: [], error: { code: 'provider_timeout', message: 'Sem resposta', stage: 'bank', provider_status: null, retryable: true, details: [] } }] : [],
      status === 'failed' ? { error: { code: 'no_banks', message: 'Nenhum banco respondeu', stage: 'x', provider_status: null, retryable: false, details: [] } } : {});
    const r = await api('GET', `/simulacoes/${criado.id}`);
    assert.equal(r.body.status, status);
    assert.equal(r.body.terminal, ['completed', 'partial', 'failed', 'expired'].includes(status));
    if (status === 'partial') {
      assert.equal(r.body.results[0].bankName, 'BV'); assert.equal(r.body.results[0].conditions.length, 1);
      assert.equal(r.body.results[1].status, 'timed_out'); assert.equal(r.body.results[1].conditions.length, 0);
      assert.equal(r.body.results[1].error.code, 'provider_timeout');
    }
    if (status === 'failed') assert.equal(r.body.error.code, 'no_banks');
  });
}

test('condições com o mesmo prazo são todas preservadas e taxa estimada é sinalizada', async () => {
  const criado = (await api('POST', '/simulacoes', form())).body;
  tick(MIN_POLL_MS);
  routes[`GET /simulations/${SIM}`] = () => simulation('completed', 2, 2, [
    { bank: 'bv', status: 'completed', conditions: [
      { installments: 48, installment_value_cents: 284900, monthly_rate: 1.49, monthly_rate_estimated: false, down_payment_cents: 3000000, financed_amount_cents: 9990000, condition_id: 'bv-48-a' },
      { installments: 48, installment_value_cents: 251000, monthly_rate: 1.39, monthly_rate_estimated: true, down_payment_cents: 4500000, financed_amount_cents: 8490000, condition_id: 'bv-48-b' },
      { installments: 60, installment_value_cents: 249200, monthly_rate: 1.52, down_payment_cents: null, financed_amount_cents: null } ],
      issues: [{ code: 'term_not_allowed', message: 'Prazo 24 indisponível', status: 'rejected', installments: 24, down_payment_cents: 3000000 }] },
    { bank: 'santander', status: 'rejected', conditions: [], campo_desconhecido: 'descartado' },
  ]);
  const r = await api('GET', `/simulacoes/${criado.id}`);
  const bv = r.body.results[0];
  assert.equal(bv.conditions.filter((c) => c.installments === 48).length, 2);
  assert.deepEqual(bv.conditions.map((c) => c.condition_id), ['bv-48-a', 'bv-48-b', null]);
  assert.deepEqual(bv.conditions.map((c) => c.monthly_rate_estimated), [false, true, false]);
  assert.equal(bv.issues[0].installments, 24);
  assert.equal(r.body.results[1].campo_desconhecido, undefined);
});

// ============================================================== erros e idempotência
const erros = [
  [400, 400, 'zinix_400', 'erro_envio'], [401, 502, 'zinix_401', 'erro_envio'], [402, 402, 'sem_saldo', 'erro_envio'],
  [403, 403, 'zinix_403', 'erro_envio'], [404, 404, 'zinix_404', 'erro_envio'], [409, 409, 'zinix_409', 'erro_envio'],
  [422, 422, 'zinix_422', 'erro_envio'], [429, 429, 'limite', 'envio_incerto'], [503, 503, 'indisponivel', 'envio_incerto'],
];
for (const [zx, http, code, estado] of erros) {
  test(`erro Zinix ${zx} no POST → HTTP ${http} (${code}), registro ${estado}, sem vazar detalhes`, async () => {
    routes['POST /simulations'] = () => json(zx, { error: { code: 'x_code', message: `detalhe interno com ${API_KEY} e ${CPF}`, details: [{ field: 'applicant.document', code: 'invalid', message: CPF }] }, request_id: `req-${zx}` }, zx === 429 ? { 'retry-after': '7' } : {});
    const r = await api('POST', '/simulacoes', form());
    assert.equal(r.status, http);
    assert.equal(r.body.code, code);
    assert.equal(r.body.requestId, `req-${zx}`);
    assert.equal(r.body.simulation.status, estado);
    assert.equal(r.body.simulation.canRetry, estado === 'envio_incerto');
    const texto = JSON.stringify(r.body);
    assert.ok(!texto.includes(API_KEY) && !texto.includes(CPF) && !texto.includes('detalhe interno'));
    if (zx === 429) { assert.equal(r.body.retryAfterMs, 7000); assert.equal(r.headers.get('retry-after'), '7'); }
    if (zx === 402) assert.equal(r.body.error, 'Não há saldo disponível para uma nova consulta.');
    if (zx === 422) assert.equal(r.body.error, 'Não foi possível processar esta simulação com os bancos habilitados.');
  });
}

test('timeout: mesma Idempotency-Key e mesmo payload no reenvio; payload diferente gera nova chave', async () => {
  // nunca responde; so termina quando o adapter aborta pelo timeout
  routes['POST /simulations'] = ({ init }) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const r1 = await api('POST', '/simulacoes', form());
  assert.equal(r1.status, 504); assert.equal(r1.body.code, 'timeout'); assert.equal(r1.body.simulation.canRetry, true);
  routes['POST /simulations'] = () => json(200, { id: SIM, status: 'queued', status_url: 'x', retry_after_ms: 20000, request_id: 'req-replay', idempotent_replay: true, billing: {}, billing_charge: { debited: false, units: 0, reason: 'idempotent_replay', balance_after: 47 } });
  const r2 = await api('POST', '/simulacoes', form());
  assert.equal(r2.status, 202);
  assert.equal(r2.body.id, r1.body.simulation.id, 'mesma intenção local');
  const [p1, p2] = posts();
  assert.equal(p2.headers['Idempotency-Key'], p1.headers['Idempotency-Key']);
  assert.deepEqual(p2.body, p1.body);
  assert.equal(r2.body.billingCharge.reason, 'idempotent_replay');
  routes['POST /simulations'] = () => json(202, { id: SIM2, status: 'queued', status_url: 'x', retry_after_ms: 20000, request_id: 'req-novo', idempotent_replay: false, billing: {}, billing_charge: null });
  const r3 = await api('POST', '/simulacoes', form({ terms: { downPayment: 35000 } }));
  assert.equal(r3.status, 202); assert.notEqual(r3.body.id, r2.body.id);
  assert.notEqual(posts()[2].headers['Idempotency-Key'], p1.headers['Idempotency-Key']);
});

test('falha de rede: envio incerto, nenhum reenvio automático', async () => {
  routes['POST /simulations'] = () => { throw new TypeError('fetch failed'); };
  const r = await api('POST', '/simulacoes', form());
  assert.equal(r.status, 502); assert.equal(r.body.simulation.status, 'envio_incerto');
  assert.equal(posts().length, 1);
});

test('duplo clique com simulação em andamento não dispara segundo POST', async () => {
  const a = (await api('POST', '/simulacoes', form())).body;
  const b = await api('POST', '/simulacoes', form());
  assert.equal(b.status, 202); assert.equal(b.body.id, a.id);
  assert.equal(posts().length, 1);
});

test('erro no polling (429/503) mantém último estado e respeita Retry-After', async () => {
  const criado = (await api('POST', '/simulacoes', form())).body;
  tick(MIN_POLL_MS);
  routes[`GET /simulations/${SIM}`] = () => json(429, { error: { code: 'rate_limited', message: 'x' } }, { 'retry-after': '45' });
  const r = await api('GET', `/simulacoes/${criado.id}`);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'queued'); assert.ok(r.body.aviso);
  assert.ok(r.body.nextPollInMs >= 45000 - 1);
  routes[`GET /simulations/${SIM}`] = () => json(503, { error: { code: 'down', message: 'x' } });
  tick(45000);
  assert.equal((await api('GET', `/simulacoes/${criado.id}`)).body.aviso, 'O serviço de financiamento está temporariamente indisponível.');
});

test('sem ZINIX_API_KEY: 503 claro, nada é gravado nem enviado', async () => {
  const antes = fs.existsSync(zinixFile()) ? fs.readFileSync(zinixFile(), 'utf8') : null;
  apiKey = '';
  const service2 = createFinancingService({ adapter, repository, store, now: () => clock, audit: () => {} });
  await assert.rejects(service2.marcas('car'), (e) => e.httpStatus === 503 && e.code === 'nao_configurado');
  await assert.rejects(service2.criarSimulacao(users[0], form()), (e) => e.httpStatus === 503 && e.code === 'nao_configurado');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(zinixFile()) ? fs.readFileSync(zinixFile(), 'utf8') : null, antes);
});

test('limite local de criação por vendedor', async () => {
  const service3 = createFinancingService({ adapter, repository, store, now: () => clock, audit: () => {} });
  let ultimo;
  for (let i = 0; i < 9; i++) {
    try { await service3.criarSimulacao(users[0], form({ terms: { downPayment: 1000 + i } })); } catch (e) { ultimo = e; }
  }
  assert.equal(ultimo.httpStatus, 429); assert.equal(ultimo.code, 'limite_local');
});

// ============================================================== LGPD / isolamento
test('logs e auditoria sem PII nem chave', async () => {
  routes['POST /simulations'] = () => json(422, { error: { code: 'no_banks', message: `CPF ${CPF}` } });
  await api('POST', '/simulacoes', form());
  routes['POST /simulations'] = defaultRoutes()['POST /simulations'];
  const ok = (await api('POST', '/simulacoes', form({ terms: { downPayment: 31000 } }))).body;
  tick(MIN_POLL_MS); await api('GET', `/simulacoes/${ok.id}`);
  const tudo = JSON.stringify(auditLines) + logs.join('\n');
  for (const dado of [...PII, API_KEY]) assert.ok(!tudo.includes(dado), `log contém ${dado}`);
  const permitidos = new Set(['evt', 'userId', 'opportunityId', 'simulationId', 'zinixSimulationId', 'requestId', 'status', 'httpStatus', 'errorCode', 'bank', 'replay']);
  for (const l of auditLines) for (const k of Object.keys(l)) assert.ok(permitidos.has(k), k);
  assert.ok(auditLines.some((l) => l.evt === 'simulation.intent_saved'));
});

test('auditoria padrão (console) só emite campos permitidos', async () => {
  const { createFinancingService: fresh } = require(path.join(root, 'src/zinix/financingService'));
  const s = fresh({ adapter, repository, store, now: () => clock });
  logs = [];
  await s.criarSimulacao(users[0], form({ terms: { downPayment: 32000 } }));
  const linhas = logs.filter((l) => l.startsWith('[zinix] '));
  assert.ok(linhas.length >= 2);
  for (const dado of [...PII, API_KEY]) assert.ok(!logs.join('\n').includes(dado));
});

test('persistência isolada: só zinix-simulations.json é criado; arquivos atuais intactos byte a byte', () => {
  for (const [f, c] of Object.entries(EXISTENTES)) assert.equal(fs.readFileSync(path.join(DATA, f), 'utf8'), c, f);
  const novos = fs.readdirSync(DATA).filter((f) => !(f in EXISTENTES));
  assert.deepEqual(novos, ['zinix-simulations.json']);
  const lista = JSON.parse(fs.readFileSync(zinixFile(), 'utf8'));
  assert.ok(lista.length > 0);
  const texto = JSON.stringify(lista);
  for (const dado of [...PII, API_KEY]) assert.ok(!texto.includes(dado));
});

test('adapter: rejeita id fora de UUID antes de chamar a Zinix e nunca segue redirect', async () => {
  await assert.rejects(adapter.getSimulation('../billing'), (e) => e.kind === 'validation');
  await assert.rejects(adapter.listBanks('x/../../y'), (e) => e.kind === 'validation');
  assert.equal(calls.length, 0);
  let init;
  const a2 = createZinixAdapter({ fetch: async (u, i) => { init = i; return json(200, { data: [] }); }, getApiKey: () => API_KEY });
  await a2.listLegalEntities();
  assert.equal(init.redirect, 'error');
});
