// ZINIX-MVP-002B — blindagem de dados pessoais e rollback seguro.
// Sobe o server.js REAL (com o middleware global e o tratador de erro) num
// diretório temporário com fixtures FICTÍCIAS. Sem ZINIX_API_KEY: nenhuma
// chamada à Zinix é possível. Nenhum arquivo real do CRM é aberto.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

process.env.JWT_SECRET = 'local-test-secret-002b';
const root = fs.mkdtempSync(path.join(__dirname, '../.test-002b-'));
fs.cpSync(path.join(__dirname, '../src'), path.join(root, 'src'), { recursive: true });
fs.cpSync(path.join(__dirname, '../scripts'), path.join(root, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(__dirname, '../server.js'), path.join(root, 'server.js'));
fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(root, 'node_modules'));
const DATA = path.join(root, 'data');
fs.mkdirSync(DATA);

const CPF = '52998224725'; // FICTÍCIO (dígitos verificadores válidos)
const CPF_FMT = '529.982.247-25';
const CPF2 = '11144477735'; // FICTÍCIO
const PESSOAIS = ['customerDocumentMasked', 'customerBirthDate', 'customerGender', 'customerState', 'customerCity', 'customerHasDriverLicense'];
const cli = (doc = CPF) => ({ customerDocument: doc, customerBirthDate: '1990-05-20', customerGender: 'male', customerState: 'PR', customerCity: 'Cidade Ficticia', customerHasDriverLicense: true });
const veic = { vehicleType: 'motorcycle', vehicleBrandCode: '80', vehicleBrandName: 'HONDA', vehicleModelCode: '8001', vehicleModelName: 'POP 100', vehicleVersionCode: '8001-ES',
  vehicleVersionName: 'POP 100 ES', vehicleManufactureYear: 2025, vehicleModelYear: 2026, vehicleZeroKm: false, vehicleCatalogInterest: 'POP 100', vehicleCatalogConfirmedAt: '2026-10-10T10:00:00Z' };
const base = { stage: 'negociacao', recordType: 'opportunity', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', vehicleInterest: 'POP 100' };
const users = [
  { id: 'v1', nome: 'Ana', papel: 'vendedor', ativo: true },
  { id: 'v2', nome: 'Bia', papel: 'vendedor', ativo: true },
  { id: 'g', nome: 'Gerente', papel: 'gerente', ativo: true },
];
const LEADS = [
  { ...base, id: 'antigo', sourceId: 'antigo', name: 'Antigo Ficticio', phone: '43911110001', ownerId: 'v1', ownerName: 'Ana' },
  { ...base, id: 'com-cliente', sourceId: 'com-cliente', name: 'Cliente Ficticio', phone: '43911110002', ownerId: 'v1', ownerName: 'Ana', gptmakerChatId: 'c2', ...cli() },
  { ...base, id: 'completo', sourceId: 'completo', name: 'Completo Ficticio', phone: '43911110003', ownerId: 'v1', ownerName: 'Ana', ...cli(), ...veic },
  { ...base, id: 'sem-dono', sourceId: 'sem-dono', name: 'Sem Dono Ficticio', phone: '43911110004', ownerId: null, ownerName: null, ...cli(CPF2), ...veic },
  { ...base, id: 'alheia', sourceId: 'alheia', name: 'Da Bia Ficticio', phone: '43911110005', ownerId: 'v2', ownerName: 'Bia', ...cli() },
  // registro estranho/legado: lead livre que por algum motivo tem dados pessoais
  { id: 'livre', sourceId: 'livre', name: 'Livre Ficticio', phone: '43911110006', stage: 'novo', createdAt: '2026-10-01T10:00:00Z', ...cli() },
];
for (const [f, c] of Object.entries({ 'usuarios.json': users, 'leads.json': LEADS, 'messages.json': { c2: [{ text: 'oi', direction: 'cliente', at: '2026-10-01T10:00:00Z' }] },
  'coach.json': {}, 'convites.json': [], 'last-webhook.json': null })) fs.writeFileSync(path.join(DATA, f), JSON.stringify(c, null, 2));

const SECRET = 'local-test-secret-002b';
let child; let baseUrl; let saida = '';
const respostas = [];
before(async () => {
  const env = { ...process.env, PORT: '0', JWT_SECRET: SECRET, NODE_OPTIONS: process.env.NODE_OPTIONS || '' };
  for (const k of ['ZINIX_API_KEY', 'ZINIX_LEGAL_ENTITY_ID', 'CRM_API_KEY', 'WEBHOOK_SECRET', 'GPTMAKER_TOKEN', 'OPENAI_API_KEY']) delete env[k];
  // PORT=0 não é anunciado pelo server.js; escolhemos uma porta livre.
  const net = require('node:net');
  const porta = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  env.PORT = String(porta);
  child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { saida += d; });
  child.stderr.on('data', (d) => { saida += d; });
  baseUrl = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 100 && !saida.includes('rodando na porta'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(saida.includes('rodando na porta'), 'server.js subiu');
});
after(() => {
  if (child) child.kill();
  // Nenhum log do servidor contém o CPF (nem formatado) ou outro dado pessoal das fixtures.
  for (const dado of [CPF, CPF_FMT, CPF2, '1990-05-20', 'Cidade Ficticia']) assert.ok(!saida.includes(dado), `log do servidor sem ${dado.slice(0, 3)}…`);
  assert.ok(path.resolve(root).startsWith(path.resolve(__dirname, '..') + path.sep + '.test-002b-'));
  fs.rmSync(root, { recursive: true, force: true });
});

async function api(method, url, body, who = 'v1', rawBody) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tokenDe(who)}`;
  const r = await fetch(baseUrl + url, { method, headers, ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  respostas.push(text);
  semCpf(text, `${method} ${url}`);
  let json = null; try { json = JSON.parse(text); } catch { /* vazio */ }
  return { status: r.status, body: json, text };
}
// O middleware de auth do projeto define o formato do token; usamos o gerador real.
const { gerarToken } = require(path.join(root, 'src/auth/middleware'));
const tokenDe = (id) => gerarToken(users.find((u) => u.id === id));

// Busca recursiva: nenhuma chave customerDocument e nenhum CPF completo em lugar nenhum.
function semCpf(text, onde) {
  for (const d of [CPF, CPF_FMT, CPF2, '111.444.777-35']) assert.ok(!text.includes(d), `${onde}: CPF completo na resposta`);
  let json; try { json = JSON.parse(text); } catch { return; }
  (function walk(v, p) {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.notEqual(k, 'customerDocument', `${onde}: chave customerDocument em ${p}`); walk(x, `${p}.${k}`); }
  })(json, '$');
}
const lista = async (who) => (await api('GET', '/api/leads', undefined, who)).body;
const doId = (arr, id) => arr.find((l) => l.id === id);
const pessoais = (l) => PESSOAIS.filter((k) => k in l);

// ================================================================ não exposição + visibilidade
test('GET lista (pipeline): nenhum CPF completo para gerente, dono ou outro vendedor', async () => {
  for (const who of ['g', 'v1', 'v2']) assert.ok((await lista(who)).length > 0);
});

test('gerente vê dados pessoais com CPF mascarado em todas, inclusive sem dono', async () => {
  const l = await lista('g');
  for (const id of ['com-cliente', 'completo', 'sem-dono', 'alheia']) {
    const r = doId(l, id);
    assert.deepEqual(pessoais(r), PESSOAIS, id);
    assert.match(r.customerDocumentMasked, /^•••\.•••\.•••-\d\d$/);
    assert.equal(r.customerDataRestricted, undefined);
  }
  assert.equal(doId(l, 'sem-dono').customerDocumentMasked, '•••.•••.•••-35');
});

test('vendedor dono vê os dados da própria oportunidade (CPF mascarado); vendedor alheio não recebe a oportunidade', async () => {
  const l = await lista('v1');
  assert.deepEqual(pessoais(doId(l, 'completo')), PESSOAIS);
  assert.equal(doId(l, 'completo').customerBirthDate, '1990-05-20');
  assert.equal(doId(l, 'alheia'), undefined, 'oportunidade da Bia não aparece para Ana');
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/alheia/cliente', { city: 'X Y' }, 'v1')).status, 404);
  assert.equal((await api('GET', '/api/leads/alheia/messages', undefined, 'v1')).status, 404);
});

test('oportunidade SEM responsável: vendedor comum não recebe nascimento, sexo, UF, cidade, CNH nem CPF mascarado', async () => {
  for (const who of ['v1', 'v2']) {
    const r = doId(await lista(who), 'sem-dono');
    assert.ok(r, 'continua visível para o fluxo comercial (regra atual)');
    assert.deepEqual(pessoais(r), [], who);
    assert.equal(r.customerDataRestricted, true);
    // campos comerciais e o veículo continuam
    assert.equal(r.name, 'Sem Dono Ficticio'); assert.equal(r.vehicleInterest, 'POP 100'); assert.equal(r.vehicleVersionCode, '8001-ES');
  }
  // lead livre legado com dados pessoais: idem
  assert.deepEqual(pessoais(doId(await lista('v1'), 'livre')), []);
  // e o vendedor também não consegue editar/ler pelo financiamento
  assert.equal((await api('PATCH', '/api/financiamento/oportunidades/sem-dono/cliente', { city: 'Outra' }, 'v1')).status, 403);
});

test('registro antigo sem campos novos continua igual (sem chaves pessoais nem flag)', async () => {
  for (const who of ['g', 'v1']) {
    const r = doId(await lista(who), 'antigo');
    assert.deepEqual(Object.keys(r).filter((k) => /^customer/.test(k)), []);
  }
});

test('não existe GET de lead individual: documentado (404) e sem vazamento', async () => {
  const r = await api('GET', '/api/leads/completo', undefined, 'g');
  assert.equal(r.status, 404);
  assert.equal((await api('GET', '/api/leads/com-cliente/messages')).status, 200);
  assert.equal((await api('GET', '/api/leads/com-cliente/coach')).status, 200);
});

test('PATCH comercial, follow-up, tarefa, estágio e lead-data: respostas sem CPF completo', async () => {
  assert.equal((await api('PATCH', '/api/leads/completo/comercial', { negotiatedValue: 15000 })).status, 200);
  assert.equal((await api('PATCH', '/api/leads/completo/follow-up', { nextAction: 'Ligar', nextFollowUpAt: '2026-10-20T13:00:00Z' })).status, 200);
  assert.equal((await api('PATCH', '/api/leads/completo/task/complete', {})).status, 200);
  const st = await api('PATCH', '/api/leads/completo', { stage: 'proposta' });
  assert.equal(st.status, 200); assert.equal(st.body.customerDocumentMasked, '•••.•••.•••-25');
  assert.equal((await api('PATCH', '/api/leads/completo/lead-data', { email: 'x@example.invalid' })).status, 409);
});

test('PATCH cliente e PUT veículo: respostas e erros sem CPF', async () => {
  const ok = await api('PATCH', '/api/financiamento/oportunidades/com-cliente/cliente', { document: CPF2, city: 'Nova Cidade' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.customerDocumentMasked, '•••.•••.•••-35');
  assert.equal(ok.body.customerCity, 'Nova Cidade');
  const inv = await api('PATCH', '/api/financiamento/oportunidades/com-cliente/cliente', { document: '529.982.247-24' });
  assert.equal(inv.status, 400); assert.ok(!inv.text.includes('529.982.247-24') && !inv.text.includes('52998224724'));
  const tipo = await api('PATCH', '/api/financiamento/oportunidades/com-cliente/cliente', { document: 52998224725 });
  assert.equal(tipo.status, 400);
  // Sem ZINIX_API_KEY o catálogo não responde: 503 claro, sem dados.
  const v = await api('PUT', '/api/financiamento/oportunidades/completo/veiculo', { type: 'motorcycle', brandCode: '80', modelCode: '8001', versionCode: '8001-ES', manufactureYear: 2025, modelYear: 2026, zeroKm: false });
  assert.equal(v.status, 503);
  const s = await api('POST', '/api/financiamento/simulacoes', { opportunityId: 'completo', terms: { assetValue: 15990, downPayment: 3000, installments: [24] } });
  assert.ok([400, 409, 503].includes(s.status));
});

test('JSON malformado com CPF: 400 genérico, sem eco e sem log do corpo', async () => {
  const r = await api('PATCH', '/api/financiamento/oportunidades/com-cliente/cliente', undefined, 'v1', `{"document":"${CPF_FMT}", quebrado`);
  assert.equal(r.status, 400); assert.equal(r.body.error, 'JSON inválido');
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(saida.includes('entity.parse.failed'), 'só o tipo do erro é logado');
  assert.ok(!saida.includes(CPF_FMT));
});

test('ownership: assumir, transferir e remover responsável respondem sem CPF e com visibilidade correta', async () => {
  const as = await api('POST', '/api/leads/livre/assumir', {}, 'v1');
  assert.equal(as.status, 200); assert.equal(as.body.customerDocumentMasked, '•••.•••.•••-25'); // agora é dono
  const tr = await api('PATCH', '/api/leads/livre/responsavel', { ownerId: 'v2' }, 'g');
  assert.equal(tr.status, 200); assert.equal(tr.body.ownerId, 'v2');
  assert.deepEqual(pessoais(doId(await lista('v2'), 'livre')), PESSOAIS, 'novo dono vê');
  assert.equal(doId(await lista('v1'), 'livre'), undefined, 'antigo dono perde o acesso');
  const rm = await api('PATCH', '/api/leads/livre/responsavel', { ownerId: null }, 'g');
  assert.equal(rm.status, 200); assert.deepEqual(pessoais(rm.body), PESSOAIS, 'gerente continua vendo (mascarado)');
  assert.deepEqual(pessoais(doId(await lista('v2'), 'livre')), [], 'sem dono: vendedor deixa de ver dados pessoais');
  const dup = await api('POST', '/api/leads', { name: 'Duplicado', phone: '43911110003', origin: 'Loja', vehicleInterest: 'X' }, 'v2');
  assert.equal(dup.status, 409); assert.deepEqual(pessoais(dup.body.existente || {}), []);
});

test('resumo: nenhuma resposta coletada tem customerDocument ou CPF completo', () => {
  assert.ok(respostas.length >= 25);
  for (const t of respostas) semCpf(t, 'resposta');
});

// ================================================================ função única
test('publicLeadView/sanitizarResposta: remove customerDocument em qualquer nível e respeita o perfil', () => {
  const { publicLeadView, sanitizarResposta } = require(path.join(root, 'src/publicLead'));
  const cru = { id: 'x', recordType: 'opportunity', ownerId: 'v1', ...cli() };
  assert.equal(publicLeadView(cru, users[0]).customerDocumentMasked, '•••.•••.•••-25');
  assert.equal('customerDocument' in publicLeadView(cru, users[0]), false);
  assert.equal(publicLeadView(cru, users[1]).customerDataRestricted, true);
  assert.equal(publicLeadView(cru, null).customerBirthDate, undefined);
  const corpo = sanitizarResposta({ a: [{ b: { customerDocument: CPF } }], lead: cru, lista: [cru] }, users[2]);
  assert.ok(!JSON.stringify(corpo).includes(CPF));
  assert.equal(corpo.lead.customerDocumentMasked, '•••.•••.•••-25');
  assert.equal(cru.customerDocument, CPF, 'o registro original não é alterado');
});

// ================================================================ script de sanitização
const SCRIPT = path.join(root, 'scripts/sanitize-zinix-personal-data.js');
function fixtureArquivo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'san-002b-'));
  const f = path.join(dir, 'leads.json');
  fs.writeFileSync(f, JSON.stringify(LEADS, null, 2));
  return { dir, f };
}
const rodar = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const semPII = (txt) => { for (const d of [CPF, CPF_FMT, CPF2, '1990-05-20', 'Cidade Ficticia', 'Ficticio']) assert.ok(!txt.includes(d), `saída do script sem ${d.slice(0, 4)}…`); };

test('script: dry-run é o padrão, relata e não altera nada', () => {
  const { dir, f } = fixtureArquivo();
  const antes = fs.readFileSync(f);
  for (const args of [['--file', f], ['--file', f, '--dry-run']]) {
    const r = rodar(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SIMULAÇÃO/); assert.match(r.stdout, /Total de registros: 6/); assert.match(r.stdout, /Registros com os campos: 5/);
    assert.match(r.stdout, /customerDocument: 5/);
    semPII(r.stdout + r.stderr);
  }
  assert.ok(antes.equals(fs.readFileSync(f)), 'arquivo intacto');
  assert.deepEqual(fs.readdirSync(dir), ['leads.json'], 'nenhum backup/temporário criado');
});

test('script: exige caminho explícito de arquivo .json e recusa diretório, link, opção estranha e /app/data sem confirmação', () => {
  const { dir, f } = fixtureArquivo();
  assert.equal(rodar().status, 1);
  assert.equal(rodar('--file', dir).status, 1);
  const txt = path.join(dir, 'leads.txt'); fs.writeFileSync(txt, '[]'); assert.equal(rodar('--file', txt).status, 1);
  const link = path.join(dir, 'link.json'); fs.symlinkSync(f, link); assert.equal(rodar('--file', link, '--apply').status, 1);
  assert.equal(rodar('--file', f, '--apply', '--dry-run').status, 1);
  assert.equal(rodar('--file', f, '--xyz').status, 1);
  const prod = rodar('--file', '/app/data/leads.json', '--apply');
  assert.equal(prod.status, 1); assert.match(prod.stderr, /confirm-production/);
  const quebrado = path.join(dir, 'q.json'); fs.writeFileSync(quebrado, `[{"customerDocument":"${CPF}"`);
  const rq = rodar('--file', quebrado, '--apply');
  assert.equal(rq.status, 2); semPII(rq.stdout + rq.stderr);
  assert.equal(fs.readFileSync(quebrado, 'utf8').includes(CPF), true, 'arquivo inválido não é tocado');
});

test('script: --apply em fixture faz backup idêntico, grava JSON válido sem dados pessoais e preserva o resto', () => {
  const { dir, f } = fixtureArquivo();
  const original = fs.readFileSync(f);
  const r = rodar('--file', f, '--apply');
  assert.equal(r.status, 0, r.stderr);
  semPII(r.stdout + r.stderr);
  assert.match(r.stdout, /APLICADO/); assert.match(r.stdout, /campos restantes: 0/);
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('leads.json.bak-zinix-'));
  assert.equal(backups.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, backups[0])).equals(original), 'backup byte a byte igual ao original');
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')).length, 0);
  const final = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(final.length, LEADS.length);
  assert.ok(!fs.readFileSync(f, 'utf8').includes(CPF));
  LEADS.forEach((orig, i) => {
    const esperado = Object.fromEntries(Object.entries(orig).filter(([k]) => !/^customer/.test(k)));
    assert.deepEqual(final[i], esperado, orig.id);
  });
  assert.equal(final[2].vehicleVersionCode, '8001-ES', 'veículo (não sensível) preservado por padrão');
  // segunda execução: nada a fazer, nenhum backup novo
  const r2 = rodar('--file', f, '--apply');
  assert.equal(r2.status, 0); assert.match(r2.stdout, /nada foi escrito/);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('leads.json.bak-zinix-')).length, 1);
});

test('script: --also-vehicle remove também a estrutura do veículo; --json não imprime valores', () => {
  const { f } = fixtureArquivo();
  const r = rodar('--file', f, '--apply', '--also-vehicle', '--json');
  assert.equal(r.status, 0, r.stderr);
  const rel = JSON.parse(r.stdout);
  assert.equal(rel.totalRegistros, 6); assert.equal(rel.verificacao.camposRestantes, 0); assert.ok(rel.backup);
  semPII(r.stdout);
  assert.ok(!/vehicle(Type|BrandCode|VersionCode)/.test(fs.readFileSync(f, 'utf8')));
  assert.match(fs.readFileSync(f, 'utf8'), /"vehicleInterest": "POP 100"/, 'texto comercial preservado');
});

test('script + código antigo: depois da sanitização o registro cru não tem mais o que vazar', () => {
  const { f } = fixtureArquivo();
  assert.equal(rodar('--file', f, '--apply').status, 0);
  // O backend antigo devolve o registro cru: simulamos isso lendo o arquivo como ele leria.
  const comoAntigoDevolveria = JSON.stringify(JSON.parse(fs.readFileSync(f, 'utf8')));
  for (const d of [CPF, CPF2, 'customerDocument', 'customerBirthDate', 'Cidade Ficticia']) assert.ok(!comoAntigoDevolveria.includes(d), d);
});
