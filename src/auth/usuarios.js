// Cadastro de usuarios do CRM: quem entra, com que senha e com que papel.
// Guardado em arquivo, do mesmo jeito que os leads. A senha NUNCA e gravada
// em texto puro — so o hash bcrypt.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'usuarios.json');
const SECRET_FILE = path.join(DATA_DIR, 'jwt-secret.txt');

const PAPEIS = ['gerente', 'vendedor'];
const CUSTO_BCRYPT = 10;
const VALIDADE_RESET_MS = 60 * 60 * 1000; // 1 hora

function garantirDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ler() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    return [];
  }
}

function gravar(lista) {
  garantirDir();
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// O segredo que assina os tokens precisa sobreviver a reinicio, senao todo
// mundo e deslogado a cada deploy. Preferimos a variavel de ambiente; se ela
// nao existir, geramos um e guardamos junto dos dados.
function segredoJwt() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch (err) {
    garantirDir();
    const novo = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, novo);
    console.warn('[auth] JWT_SECRET nao definido — gerei um e guardei em data/. Defina a variavel no Railway para algo mais estavel.');
    return novo;
  }
}

const normalizarEmail = (email) => String(email || '').trim().toLowerCase();

// Senha inicial legivel: 3 blocos de 4 caracteres, sem letras que confundem
// (0/O, 1/l/I). E pra pessoa conseguir digitar do e-mail sem errar.
function gerarSenha() {
  const alfabeto = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const cs = [...bytes].map((b) => alfabeto[b % alfabeto.length]);
  return `${cs.slice(0, 4).join('')}-${cs.slice(4, 8).join('')}-${cs.slice(8, 12).join('')}`;
}

// O que pode sair pra fora: nunca o hash, nunca o token de recuperacao.
function publico(u) {
  if (!u) return null;
  return {
    id: u.id,
    nome: u.nome,
    email: u.email,
    papel: u.papel,
    ativo: u.ativo !== false,
    precisaTrocarSenha: u.precisaTrocarSenha === true,
    criadoEm: u.criadoEm,
    ultimoAcesso: u.ultimoAcesso || null,
  };
}

function listar() {
  return ler().map(publico);
}

function contar() {
  return ler().length;
}

function acharPorEmail(email) {
  const alvo = normalizarEmail(email);
  return ler().find((u) => u.email === alvo) || null;
}

function acharPorId(id) {
  return ler().find((u) => u.id === id) || null;
}

// Cria o usuario e devolve a senha gerada UMA unica vez, pra quem chamou
// mandar por e-mail. Ela nao fica guardada em lugar nenhum.
function criar({ nome, email, papel = 'vendedor', senha = null }) {
  const emailLimpo = normalizarEmail(email);
  if (!nome || !String(nome).trim()) throw new Error('Nome e obrigatorio');
  if (!emailLimpo || !emailLimpo.includes('@')) throw new Error('E-mail invalido');
  if (!PAPEIS.includes(papel)) throw new Error(`Papel invalido: ${papel}`);
  if (acharPorEmail(emailLimpo)) throw new Error('Ja existe usuario com esse e-mail');

  const senhaGerada = senha || gerarSenha();
  const usuario = {
    id: crypto.randomUUID(),
    nome: String(nome).trim(),
    email: emailLimpo,
    papel,
    ativo: true,
    senhaHash: bcrypt.hashSync(senhaGerada, CUSTO_BCRYPT),
    precisaTrocarSenha: true,
    criadoEm: new Date().toISOString(),
    ultimoAcesso: null,
  };

  const lista = ler();
  lista.push(usuario);
  gravar(lista);
  return { usuario: publico(usuario), senha: senhaGerada };
}

function atualizar(id, campos) {
  const lista = ler();
  const i = lista.findIndex((u) => u.id === id);
  if (i === -1) return null;

  if (campos.papel !== undefined) {
    if (!PAPEIS.includes(campos.papel)) throw new Error(`Papel invalido: ${campos.papel}`);
    lista[i].papel = campos.papel;
  }
  if (campos.ativo !== undefined) lista[i].ativo = campos.ativo === true;
  if (campos.nome !== undefined && String(campos.nome).trim()) lista[i].nome = String(campos.nome).trim();

  gravar(lista);
  return publico(lista[i]);
}

function remover(id) {
  const lista = ler();
  const restante = lista.filter((u) => u.id !== id);
  if (restante.length === lista.length) return false;
  gravar(restante);
  return true;
}

function conferirSenha(usuario, senha) {
  if (!usuario || !usuario.senhaHash) return false;
  return bcrypt.compareSync(String(senha || ''), usuario.senhaHash);
}

function definirSenha(id, novaSenha) {
  const lista = ler();
  const i = lista.findIndex((u) => u.id === id);
  if (i === -1) return false;
  lista[i].senhaHash = bcrypt.hashSync(String(novaSenha), CUSTO_BCRYPT);
  lista[i].precisaTrocarSenha = false;
  // Trocar a senha invalida qualquer link de recuperacao pendente.
  delete lista[i].resetHash;
  delete lista[i].resetExpiraEm;
  gravar(lista);
  return true;
}

function registrarAcesso(id) {
  const lista = ler();
  const i = lista.findIndex((u) => u.id === id);
  if (i === -1) return;
  lista[i].ultimoAcesso = new Date().toISOString();
  gravar(lista);
}

// --- recuperacao de senha ---
// O token vai por e-mail em texto puro, mas no arquivo guardamos so o hash.
// Se alguem ler o arquivo, nao consegue montar o link de recuperacao.
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function criarTokenReset(email) {
  const lista = ler();
  const i = lista.findIndex((u) => u.email === normalizarEmail(email));
  if (i === -1 || lista[i].ativo === false) return null;

  const token = crypto.randomBytes(32).toString('hex');
  lista[i].resetHash = hashToken(token);
  lista[i].resetExpiraEm = new Date(Date.now() + VALIDADE_RESET_MS).toISOString();
  gravar(lista);
  return { token, usuario: publico(lista[i]) };
}

function usarTokenReset(token, novaSenha) {
  if (!token || !novaSenha) return { ok: false, motivo: 'dados-incompletos' };
  const alvo = hashToken(token);
  const lista = ler();
  const i = lista.findIndex((u) => u.resetHash === alvo);
  if (i === -1) return { ok: false, motivo: 'token-invalido' };
  if (!lista[i].resetExpiraEm || new Date(lista[i].resetExpiraEm) < new Date()) {
    return { ok: false, motivo: 'token-expirado' };
  }

  lista[i].senhaHash = bcrypt.hashSync(String(novaSenha), CUSTO_BCRYPT);
  lista[i].precisaTrocarSenha = false;
  delete lista[i].resetHash; // uso unico
  delete lista[i].resetExpiraEm;
  gravar(lista);
  return { ok: true, usuario: publico(lista[i]) };
}

module.exports = {
  PAPEIS,
  segredoJwt,
  gerarSenha,
  publico,
  listar,
  contar,
  acharPorEmail,
  acharPorId,
  criar,
  atualizar,
  remover,
  conferirSenha,
  definirSenha,
  registrarAcesso,
  criarTokenReset,
  usarTokenReset,
};
