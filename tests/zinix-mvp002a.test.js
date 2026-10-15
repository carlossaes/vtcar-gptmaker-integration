// ZINIX-MVP-002A — dados do cliente e veículo estruturado na oportunidade.
// Tudo em diretório temporário com fixtures FICTÍCIAS. Zinix SIMULADA (fetch
// falso). Nenhum arquivo real do CRM é aberto; nenhuma rede externa.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const root = fs.mkdtempSync(path.join(__dirname, '../.test-002a-'));
fs.cpSync(path.join(__dirname, '../src'), path.join(root, 'src'), { recursive: true });
process.env.JWT_SECRET = 'local-test-secret-002a';
delete process.env.CRM_API_KEY;
delete process.env.ZINIX_LEGAL_ENTITY_ID;
const DATA = path.join(root, 'data');
fs.mkdirSync(DATA, { recursive: true });

const store = require(path.join(root, 'src/store'));
const { publicFinancingFields } = require(path.join(root, 'src/opportunity'));
const { gerarToken, exigirAuth } = require(path.join(root, 'src/auth/middleware'));
const { createZinixAdapter } = require(path.join(root, 'src/zinix/zinixAdapter'));
const { createFinancingRepository } = require(path.join(root, 'src/zinix/financingRepository'));
const { createFinancingService } = require(path.join(root, 'src/zinix/financingService'));
const { createFinancingRouter } = require(path.join(root, 'src/routes/financiamento'));

// ---------------------------------------------------------------- fixtures fictícias
const CPF_FICTICIO = '52998224725'; // fictício, só dígitos verificadores válidos
const ENTITY = '11111111-1111-4111-8111-111111111111';
const SIM = '33333333-3333-4333-8333-333333333333';
const users = [
  { id: 'v1', nome: 'Ana', papel: 'vendedor', ativo: true },
  { id: 'v2', nome: 'Bia', papel: 'vendedor', ativo: true },
  { id: 'g', nome: 'Gerente', papel: 'gerente', ativo: true },
];
const base = { stage: 'negociacao', ownerId: 'v1', ownerName: 'Ana', recordType: 'opportunity', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z' };
// REGISTRO ANTIGO: nenhum campo novo.
const antigo = { ...base, id: 'opp-antigo', sourceId: 'opp-antigo', name: 'Cliente Antigo Ficticio', phone: '43911112222', vehicleInterest: 'Onix 2020', gptmakerChatId: 'chat-antigo', assetValue: 60000 };
// REGISTRO NOVO: com dados do cliente.
const novo = { ...base, id: 'opp-novo', sourceId: 'opp-novo', name: 'Carlos Teste', phone: '43999999999', email: 'teste@example.invalid', vehicleInterest: 'POP 100',
  gptmakerChatId: 'chat-novo', assetValue: 15990, downPayment: 3000,
  customerDocument: CPF_FICTICIO, customerBirthDate: '1990-05-20', customerGender: 'male', customerState: 'PR', customerCity: 'Cambé', customerHasDriverLicense: true };
// REGISTRO NOVO COMPLETO: cliente + veículo estruturado.
const completo = { ...novo, id: 'opp-completo', sourceId: 'opp-completo', phone: '43988887777', gptmakerChatId: 'chat-completo',
  vehicleType: 'motorcycle', vehicleBrandCode: '80', vehicleBrandName: 'HONDA', vehicleModelCode: '8001', vehicleModelName: 'POP 100',
  vehicleVersionCode: '8001-ES', vehicleVersionName: 'POP 100 ES', vehicleManufactureYear: 2025, vehicleModelYear: 2026, vehicleZeroKm: false,
  vehicleCatalogInterest: 'POP 100', vehicleCatalogConfirmedAt: '2026-10-10T10:00:00.000Z' };
const alheia = { ...base, id: 'opp-alheia', sourceId: 'opp-alheia', name: 'Cliente Da Bia', phone: '43977776666', ownerId: 'v2', ownerName: 'Bia' };
const livre = { id: 'lead-livre', sourceId: 'lead-livre', name: 'Lead Livre', phone: '43966665555', stage: 'novo', createdAt: '2026-10-01T10:00:00Z' };
const LEADS = [antigo, novo, completo, alheia, livre];
const OUTROS = {
  'usuarios.json': JSON.stringify(users),
  'messages.json': JSON.stringify({ 'chat-antigo': [{ text: 'oi', direction: 'cliente', at: '2026-10-01T10:00:00Z' }], 'chat-novo': [], 'chat-completo': [] }),
  'coach.json': JSON.stringify({ 'opp-antigo': { resumo: 'ficticio', generatedAt: '2026-10-01T10:00:00Z' } }),
  'convites.json': '[]', 'last-webhook.json': 'null', 'jwt-secret.txt': 'nao-usado',
};
const PII = [CPF_FICTICIO, '529.982.247-25', '1990-05-20', 'teste@example.invalid', '43999999999', '43988887777', 'Carlos Teste', 'Cambé'];

// ---------------------------------------------------------------- Zinix falsa
let calls = [];
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const routes = {
  'GET /legal-entities': () => json(200, { data: [{ id: ENTITY, legal_name: 'VT CAR LTDA', trade_name: 'VT Car', cnpj_masked: '**.***.***/0001-**', is_primary: true, status: 'active' }] }),
  [`GET /legal-entities/${ENTITY}/banks`]: () => json(200, { data: [{ code: 'banco-x', name: 'Banco X', status: 'active', enabled_for_simulation: true }] }),
  'GET /vehicles/brands': ({ url }) => json(200, { data: url.searchParams.get('type') === 'motorcycle' ? [{ code: '80', name: 'HONDA' }] : [{ code: '59', name: 'TOYOTA' }] }),
  'GET /vehicles/models': () => json(200, { data: [{ code: '8001', name: 'POP 100' }] }),
  'GET /vehicles/versions': () => json(200, { data: [{ code: '8001-ES', name: 'POP 100 ES' }, { code: '8001-STD', name: 'POP 100 STD' }] }),
  'POST /simulations': () => json(202, { id: SIM, status: 'queued', status_url: `/v1/simulations/${SIM}`, retry_after_ms: 20000, request_id: 'req-post', idempotent_replay: false,
    billing: {}, billing_charge: { debited: false, units: 0, period: '2026-10', unit: 'unique_cpf_month', reason: 'not_debited', balance_after: 10 } }),
};
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  assert.ok(u.href.startsWith('https://saas.zinix.com.br/v1/'), 'só a Zinix falsa');
  const p = u.pathname.replace(/^\/v1/, '');
  calls.push({ method: init.method, path: p, body: init.body ? JSON.parse(init.body) : undefined });
  const h = routes[`${init.method} ${p}`];
  return h ? h({ url: u }) : json(404, { error: { code: 'not_found', message: 'nada' } });
}

// ---------------------------------------------------------------- app de teste (rotas reais)
let server; let baseUrl; const logs = []; const respostas = [];
let clock = new Date('2026-10-15T15:00:00Z');
const repository = createFinancingRepository({ dataDir: DATA });
const adapter = createZinixAdapter({ fetch: fakeFetch, getApiKey: () => 'zx_test_FAKE_KEY_002A', timeoutMs: 300 });
const service = createFinancingService({ adapter, repository, store, now: () => clock, audit: (evt, f) => logs.push(JSON.stringify({ evt, ...f })) });
const orig = { log: console.log, error: console.error, warn: console.warn };
const leadsFile = path.join(DATA, 'leads.json');
const raw = () => JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
const rawById = (id) => raw().find((l) => l.id === id);

before(async () => {
  for (const [f, c] of Object.entries(OUTROS)) fs.writeFileSync(path.join(DATA, f), c);
  const app = express();
  app.use(express.json());
  app.use('/api/leads', exigirAuth, require(path.join(root, 'src/routes/leads')));
  app.use('/api/financiamento', exigirAuth, createFinancingRouter(service));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cap = () => (...a) => { logs.push(a.map(String).join(' ')); };
  console.log = cap(); console.error = cap(); console.warn = cap();
});
beforeEach(() => {
  calls = [];
  clock = new Date(clock.getTime() + 60 * 60 * 1000);
  fs.writeFileSync(leadsFile, JSON.stringify(LEADS, null, 2));
  fs.rmSync(path.join(DATA, 'zinix-simulations.json'), { force: true });
});
after(async () => {
  Object.assign(console, orig);
  if (server) await new Promise((r) => server.close(r));
  // Nenhum log, auditoria ou resposta carrega CPF ou outro dado pessoal.
  const tudo = logs.join('\n') + respostas.join('\n');
  for (const dado of [CPF_FICTICIO, '529.982.247-25', 'zx_test_FAKE_KEY_002A']) assert.ok(!tudo.includes(dado), `vazou ${dado.slice(0, 3)}…`);
  assert.ok(path.resolve(root).startsWith(path.resolve(__dirname, '..') + path.sep + '.test-002a-'));
  fs.rmSync(root, { recursive: true, force: true });
});

async function api(method, url, body, who = 'v1') {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${gerarToken(users.find((u) => u.id === who))}`;
  const r = await fetch(baseUrl + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  respostas.push(text);
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* vazio */ }
  return { status: r.status, body: parsed, text };
}
const lista = async (who = 'v1') => (await api('GET', '/api/leads', undefined, who)).body;
const doLista = async (id, who = 'v1') => (await lista(who)).find((l) => l.id === id);
const clienteOk = { document: '529.982.247-25', birthDate: '1990-05-20', gender: 'male', state: 'pr', city: '  Cambé ', hasDriverLicense: true };
const veiculoOk = { type: 'motorcycle', brandCode: '80', modelCode: '8001', versionCode: '8001-ES', manufactureYear: 2025, modelYear: 2026, zeroKm: false };
const termos = { assetValue: 15990, downPayment: 3000, installments: [24, 36] };
const NOVOS = /^(customer|vehicle(Type|Brand|Model|Version|ManufactureYear|ModelYear|ZeroKm|Catalog))/;

// ================================================================ compatibilidade
test('registro antigo: normalize/leitura sem campos novos, nenhuma chave nova aparece', async () => {
  const a = await doLista('opp-antigo');
  assert.ok(a);
  assert.deepEqual(Object.keys(a).filter((k) => NOVOS.test(k)), []);
  assert.equal(publicFinancingFields(antigo), antigo, 'sem campos novos, o objeto volta igual');
  assert.equal(publicFinancingFields(null), null);
  assert.deepEqual(store.getFinancingCustomer('opp-antigo'), { document: null, birthDate: null, gender: null, state: null, city: null, hasDriverLicense: null });
});

for (const fx of [antigo, novo, completo]) {
  test(`registro ${fx.id}: abre, salva negócio, move pipeline, follow-up, tarefa, mensagens e coach`, async () => {
    assert.ok(await doLista(fx.id));
    assert.equal((await api('GET', `/api/leads/${fx.id}/messages`)).status, 200);
    assert.equal((await api('GET', `/api/leads/${fx.id}/coach`)).status, 200);
    const neg = await api('PATCH', `/api/leads/${fx.id}/comercial`, { negotiatedValue: 15000, notes: 'nota ficticia' });
    assert.equal(neg.status, 200); assert.equal(neg.body.negotiatedValue, 15000);
    assert.equal((await api('PATCH', `/api/leads/${fx.id}`, { stage: 'proposta' })).status, 200);
    assert.equal((await api('PATCH', `/api/leads/${fx.id}/follow-up`, { nextAction: 'Ligar', nextFollowUpAt: '2026-10-20T13:00:00Z' })).status, 200);
    const t = await api('PATCH', `/api/leads/${fx.id}/task/complete`, {});
    assert.equal(t.status, 200); assert.equal(t.body.taskStatus, 'concluida');
    // Os campos novos (quando existem) sobrevivem a todas as operações; quando não existem, não surgem.
    const depois = rawById(fx.id);
    for (const k of Object.keys(fx).filter((k) => NOVOS.test(k))) assert.deepEqual(depois[k], fx[k], k);
    assert.deepEqual(Object.keys(depois).filter((k) => NOVOS.test(k)).sort(), Object.keys(fx).filter((k) => NOVOS.test(k)).sort());
    assert.equal(depois.stage, 'proposta');
  });
}

test('leitura não grava nada: leads.json e demais arquivos ficam byte a byte iguais', async () => {
  const antes = Object.fromEntries(['leads.json', ...Object.keys(OUTROS)].map((f) => [f, fs.readFileSync(path.join(DATA, f))]));
  await lista('g'); await lista('v1'); await api('GET', '/api/leads/opp-novo/messages'); await api('GET', '/api/financiamento/oportunidades/opp-novo/simulacoes');
  for (const [f, buf] of Object.entries(antes)) assert.ok(buf.equals(fs.readFileSync(path.join(DATA, f))), f);
});

test('salvar cliente muda só o registro alvo; demais registros e arquivos intactos', async () => {
  const antes = Object.fromEntries(Object.keys(OUTROS).map((f) => [f, fs.readFileSync(path.join(DATA, f))]));
  const rawAntes = raw();
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/opp-antigo/cliente', clienteOk)).status, 200);
  for (const [f, buf] of Object.entries(antes)) assert.ok(buf.equals(fs.readFileSync(path.join(DATA, f))), f);
  const rawDepois = raw();
  assert.equal(rawDepois.length, rawAntes.length);
  for (const r of rawAntes.filter((x) => x.id !== 'opp-antigo')) assert.deepEqual(rawDepois.find((x) => x.id === r.id), r, r.id);
  const alvo = rawDepois.find((x) => x.id === 'opp-antigo');
  const { updatedAt, ...resto } = alvo;
  assert.deepEqual(Object.fromEntries(Object.entries(resto).filter(([k]) => !NOVOS.test(k))), (({ updatedAt: _u, ...x }) => x)(antigo));
});

// ================================================================ dados do cliente
test('salvar dados do cliente: grava normalizado, resposta e lista só com CPF mascarado', async () => {
  const r = await api('PATCH', '/api/financiamento/oportunidades/opp-antigo/cliente', clienteOk);
  assert.equal(r.status, 200);
  assert.equal(r.body.customerDocument, undefined);
  assert.equal(r.body.customerDocumentMasked, '•••.•••.•••-25');
  assert.equal(r.body.customerState, 'PR'); assert.equal(r.body.customerCity, 'Cambé');
  assert.ok(!r.text.includes(CPF_FICTICIO));
  const g = rawById('opp-antigo');
  assert.equal(g.customerDocument, CPF_FICTICIO);
  assert.deepEqual([g.customerBirthDate, g.customerGender, g.customerState, g.customerCity, g.customerHasDriverLicense], ['1990-05-20', 'male', 'PR', 'Cambé', true]);
  for (const who of ['v1', 'g']) {
    const l = await api('GET', '/api/leads', undefined, who);
    assert.ok(!l.text.includes(CPF_FICTICIO), `lista do ${who} sem CPF inteiro`);
  }
});

test('editar dados do cliente: altera só o enviado; null limpa o campo', async () => {
  const r = await api('PATCH', '/api/financiamento/oportunidades/opp-novo/cliente', { city: 'Londrina' });
  assert.equal(r.status, 200);
  const g = rawById('opp-novo');
  assert.equal(g.customerCity, 'Londrina'); assert.equal(g.customerDocument, CPF_FICTICIO); assert.equal(g.customerBirthDate, '1990-05-20');
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/opp-novo/cliente', { hasDriverLicense: null })).status, 200);
  assert.equal(Object.hasOwn(rawById('opp-novo'), 'customerHasDriverLicense'), false);
});

test('permissões: dono e gerente editam; vendedor alheio, lead livre e sem login bloqueados', async () => {
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/opp-novo/cliente', { city: 'Cambé' }, 'g')).status, 200);
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/opp-alheia/cliente', clienteOk, 'v1')).status, 404);
  assert.equal((await api('PUT', '/api/financiamento/oportunidades/opp-alheia/veiculo', veiculoOk, 'v1')).status, 404);
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/opp-novo/cliente', { city: 'Cambé' }, 'v2')).status, 404);
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/lead-livre/cliente', clienteOk, 'g')).status, 400);
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/opp-novo/cliente', { city: 'X' }, null)).status, 401);
  assert.equal(rawById('opp-alheia').customerDocument, undefined);
  assert.equal(rawById('lead-livre').customerDocument, undefined);
});

test('allowlist: campo estranho, vazio ou tentativa de mexer em dono/estágio é recusada sem gravar', async () => {
  const antes = fs.readFileSync(leadsFile);
  for (const body of [{ ownerId: 'v2' }, { stage: 'fechado' }, { customerDocument: CPF_FICTICIO }, { city: 'Cambé', recordType: 'lead' }, {}, [], 'x']) {
    const r = await api('PATCH', '/api/financiamento/oportunidades/opp-novo/cliente', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.ok(antes.equals(fs.readFileSync(leadsFile)));
  assert.throws(() => store.updateFinancingData('opp-novo', { ownerId: 'v2' }), /não permitido/);
});

test('CPF inválido é bloqueado e não volta na resposta', async () => {
  const antes = fs.readFileSync(leadsFile);
  for (const doc of ['529.982.247-24', '111.111.111-11', '123', 52998224725]) {
    const r = await api('PATCH', '/api/financiamento/oportunidades/opp-antigo/cliente', { document: doc });
    assert.equal(r.status, 400); assert.ok(r.body.fields.document);
    assert.ok(!r.text.includes('52998224724') && !r.text.includes('529.982.247-24'), 'valor recebido não é ecoado');
  }
  assert.ok(antes.equals(fs.readFileSync(leadsFile)));
});

test('nascimento inválido bloqueado (data inexistente, menor de idade, mais de 100 anos)', async () => {
  for (const d of ['1990-02-30', '20/05/1990', '2012-01-01', '1900-01-01']) {
    const r = await api('PATCH', '/api/financiamento/oportunidades/opp-antigo/cliente', { birthDate: d });
    assert.equal(r.status, 400, d); assert.ok(r.body.fields.birthDate);
  }
  for (const [k, v] of [['gender', 'x'], ['state', 'XX'], ['city', '1'], ['hasDriverLicense', 'sim']]) {
    assert.equal((await api('PATCH', '/api/financiamento/oportunidades/opp-antigo/cliente', { [k]: v })).status, 400, k);
  }
  assert.equal(rawById('opp-antigo').customerBirthDate, undefined);
});

// ================================================================ veículo estruturado
test('salvar veículo estruturado: nomes vêm do catálogo e a confirmação fica amarrada ao vehicleInterest', async () => {
  const r = await api('PUT', '/api/financiamento/oportunidades/opp-novo/veiculo', { ...veiculoOk, brandName: 'INVENTADA', versionName: 'X' });
  assert.equal(r.status, 200);
  assert.equal(r.body.vehicleCatalogNeedsReview, false);
  const g = rawById('opp-novo');
  assert.deepEqual([g.vehicleType, g.vehicleBrandCode, g.vehicleBrandName, g.vehicleModelName, g.vehicleVersionCode, g.vehicleVersionName, g.vehicleManufactureYear, g.vehicleModelYear, g.vehicleZeroKm, g.vehicleCatalogInterest],
    ['motorcycle', '80', 'HONDA', 'POP 100', '8001-ES', 'POP 100 ES', 2025, 2026, false, 'POP 100']);
  assert.equal(g.vehicleInterest, 'POP 100', 'texto comercial preservado');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('veículo fora do catálogo ou inválido não é gravado', async () => {
  const antes = fs.readFileSync(leadsFile);
  assert.equal((await api('PUT', '/api/financiamento/oportunidades/opp-novo/veiculo', { ...veiculoOk, versionCode: 'INVENTADO' })).body.code, 'fora_do_catalogo');
  assert.equal((await api('PUT', '/api/financiamento/oportunidades/opp-novo/veiculo', { ...veiculoOk, modelYear: 2020 })).status, 400);
  assert.equal((await api('PUT', '/api/financiamento/oportunidades/opp-novo/veiculo', { ...veiculoOk, type: 'barco' })).status, 400);
  assert.ok(antes.equals(fs.readFileSync(leadsFile)));
});

test('alterar vehicleInterest marca o veículo para revalidar, sem apagar a estrutura nem simular com ela', async () => {
  const r = await api('PATCH', '/api/leads/opp-completo/comercial', { vehicleInterest: 'CG 160 Titan' });
  assert.equal(r.status, 200);
  assert.equal(r.body.vehicleCatalogNeedsReview, true);
  assert.equal((await doLista('opp-completo')).vehicleCatalogNeedsReview, true);
  assert.equal(rawById('opp-completo').vehicleVersionCode, '8001-ES', 'estrutura antiga não é apagada');
  const s = await api('POST', '/api/financiamento/simulacoes', { opportunityId: 'opp-completo', terms: termos });
  assert.equal(s.status, 409); assert.equal(s.body.code, 'veiculo_revalidar');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
  // Espaços a mais não contam como alteração.
  assert.equal((await api('PATCH', '/api/leads/opp-completo/comercial', { vehicleInterest: '  POP   100 ' })).body.vehicleCatalogNeedsReview, false);
});

test('revalidar o veículo remove o alerta', async () => {
  await api('PATCH', '/api/leads/opp-completo/comercial', { vehicleInterest: 'POP 100 ES 2026' });
  const r = await api('PUT', '/api/financiamento/oportunidades/opp-completo/veiculo', { ...veiculoOk, versionCode: '8001-STD' });
  assert.equal(r.status, 200);
  assert.equal(r.body.vehicleCatalogNeedsReview, false);
  assert.equal(rawById('opp-completo').vehicleCatalogInterest, 'POP 100 ES 2026');
  assert.equal(rawById('opp-completo').vehicleVersionName, 'POP 100 STD');
});

// ================================================================ simulação
test('simulação usa dados do cliente e veículo estruturado salvos no CRM (corpo só com termos)', async () => {
  const r = await api('POST', '/api/financiamento/simulacoes', { opportunityId: 'opp-completo', terms: termos });
  assert.equal(r.status, 202, r.text);
  const enviado = calls.find((c) => c.method === 'POST').body;
  assert.deepEqual(enviado.applicant, { document: CPF_FICTICIO, gender: 'male', name: 'Carlos Teste', birth_date: '1990-05-20', email: 'teste@example.invalid',
    phone: '43988887777', state: 'PR', city: 'Cambé', has_driver_license: true });
  assert.deepEqual(enviado.vehicle, { type: 'motorcycle', brand_code: '80', brand_name: 'HONDA', model_code: '8001', model_name: 'POP 100',
    version_code: '8001-ES', version_name: 'POP 100 ES', manufacture_year: 2025, model_year: 2026, zero_km: false });
  assert.deepEqual(enviado.terms, { asset_value_cents: 1599000, down_payment_cents: 300000, installments: [24, 36] });
});

test('sem dados no CRM e sem corpo: validação lista o que falta e nada é enviado', async () => {
  const r = await api('POST', '/api/financiamento/simulacoes', { opportunityId: 'opp-antigo', terms: termos });
  assert.equal(r.status, 400);
  for (const k of ['applicant.document', 'applicant.birthDate', 'applicant.email', 'vehicle.versionCode']) assert.ok(r.body.fields[k], k);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('zinix-simulations.json NÃO contém dados pessoais nem campos do cliente', async () => {
  assert.equal((await api('POST', '/api/financiamento/simulacoes', { opportunityId: 'opp-completo', terms: termos })).status, 202);
  const arquivo = fs.readFileSync(path.join(DATA, 'zinix-simulations.json'), 'utf8');
  for (const dado of PII) assert.ok(!arquivo.includes(dado), `arquivo de simulações sem ${dado.slice(0, 4)}…`);
  assert.ok(!/customer|applicant|"state"|birth/.test(arquivo));
  const rec = JSON.parse(arquivo)[0];
  assert.equal(rec.vehicleInterest, 'POP 100'); assert.equal(rec.vehicle.version_code, '8001-ES');
});

test('nenhuma chamada fora da Zinix falsa; auditoria só com ids', async () => {
  await api('PATCH', '/api/financiamento/oportunidades/opp-novo/cliente', clienteOk);
  await api('PUT', '/api/financiamento/oportunidades/opp-novo/veiculo', veiculoOk);
  const aud = logs.filter((l) => l.includes('customer.updated') || l.includes('vehicle.confirmed'));
  assert.ok(aud.length >= 2);
  for (const l of aud) { const o = JSON.parse(l); assert.deepEqual(Object.keys(o).sort(), ['evt', 'opportunityId', 'userId']); }
});
