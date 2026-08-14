// Convites de acesso: o gerente gera um link, manda pra pessoa (WhatsApp,
// e-mail, o que for) e ela mesma define nome e senha.
//
// O link vai com o token em texto; aqui guardamos so o hash. Se alguem ler
// o arquivo, nao consegue remontar nenhum convite valido.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'convites.json');

const VALIDADE_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const PAPEIS = ['gerente', 'vendedor'];

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function ler() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

function gravar(lista) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2));
  fs.renameSync(tmp, FILE);
}

const expirado = (c) => new Date(c.expiraEm) < new Date();
const pendente = (c) => !c.usadoEm && !expirado(c);

// O que pode aparecer na tela do gerente. O token NAO volta aqui — ele so
// existe no momento da criacao, dentro do link.
function publico(c) {
  return {
    id: c.id,
    papel: c.papel,
    emailSugerido: c.emailSugerido || null,
    observacao: c.observacao || null,
    criadoEm: c.criadoEm,
    expiraEm: c.expiraEm,
    usadoEm: c.usadoEm || null,
    usadoPor: c.usadoPor || null,
    situacao: c.usadoEm ? 'usado' : expirado(c) ? 'expirado' : 'pendente',
  };
}

function criar({ papel = 'vendedor', emailSugerido = null, observacao = null, criadoPor = null }) {
  if (!PAPEIS.includes(papel)) throw new Error(`Papel invalido: ${papel}`);

  const token = crypto.randomBytes(32).toString('hex');
  const convite = {
    id: crypto.randomUUID(),
    tokenHash: hash(token),
    papel,
    emailSugerido: emailSugerido ? String(emailSugerido).trim().toLowerCase() : null,
    observacao: observacao ? String(observacao).trim().slice(0, 80) : null,
    criadoPor,
    criadoEm: new Date().toISOString(),
    expiraEm: new Date(Date.now() + VALIDADE_MS).toISOString(),
    usadoEm: null,
    usadoPor: null,
  };

  const lista = ler();
  lista.push(convite);
  gravar(lista);
  return { convite: publico(convite), token };
}

function acharPorToken(token) {
  if (!token) return null;
  return ler().find((c) => c.tokenHash === hash(token)) || null;
}

// Diz se o link ainda vale, e por que nao vale quando for o caso.
function conferir(token) {
  const c = acharPorToken(token);
  if (!c) return { valido: false, motivo: 'inexistente' };
  if (c.usadoEm) return { valido: false, motivo: 'usado' };
  if (expirado(c)) return { valido: false, motivo: 'expirado' };
  return { valido: true, convite: publico(c) };
}

function marcarUsado(token, usuarioId) {
  const alvo = hash(token);
  const lista = ler();
  const i = lista.findIndex((c) => c.tokenHash === alvo);
  if (i === -1) return false;
  lista[i].usadoEm = new Date().toISOString();
  lista[i].usadoPor = usuarioId;
  gravar(lista);
  return true;
}

function listar() {
  return ler()
    .map(publico)
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

function revogar(id) {
  const lista = ler();
  const restante = lista.filter((c) => c.id !== id);
  if (restante.length === lista.length) return false;
  gravar(restante);
  return true;
}

module.exports = { PAPEIS, criar, conferir, marcarUsado, listar, revogar, pendente };
