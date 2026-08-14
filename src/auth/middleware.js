const jwt = require('jsonwebtoken');
const usuarios = require('./usuarios');

const VALIDADE_TOKEN = '12h';

function gerarToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, email: usuario.email, papel: usuario.papel },
    usuarios.segredoJwt(),
    { expiresIn: VALIDADE_TOKEN }
  );
}

// Le o "Authorization: Bearer <token>" e coloca o usuario em req.usuario.
// Confere no arquivo a cada requisicao de proposito: assim desativar alguem
// tem efeito imediato, sem esperar o token expirar.
function exigirAuth(req, res, next) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Faça login para continuar' });

  let payload;
  try {
    payload = jwt.verify(token, usuarios.segredoJwt());
  } catch (err) {
    const expirou = err.name === 'TokenExpiredError';
    return res.status(401).json({ error: expirou ? 'Sessão expirada, entre de novo' : 'Sessão inválida' });
  }

  const atual = usuarios.acharPorId(payload.sub);
  if (!atual || atual.ativo === false) {
    return res.status(401).json({ error: 'Conta desativada ou removida' });
  }

  req.usuario = usuarios.publico(atual);
  next();
}

function exigirGerente(req, res, next) {
  if (!req.usuario) return res.status(401).json({ error: 'Faça login para continuar' });
  if (req.usuario.papel !== 'gerente') {
    return res.status(403).json({ error: 'Só um gerente pode fazer isso' });
  }
  next();
}

// Trava simples contra tentativa de adivinhar senha. Em memoria: se o
// servico reiniciar, zera — o que e aceitavel aqui e evita dependencia nova.
const tentativas = new Map();
const JANELA_MS = 15 * 60 * 1000;
const LIMITE = 8;

function registrarFalha(chave) {
  const agora = Date.now();
  const atual = tentativas.get(chave);
  if (!atual || agora - atual.desde > JANELA_MS) {
    tentativas.set(chave, { contador: 1, desde: agora });
  } else {
    atual.contador += 1;
  }
}

function limparFalhas(chave) {
  tentativas.delete(chave);
}

function bloqueado(chave) {
  const atual = tentativas.get(chave);
  if (!atual) return false;
  if (Date.now() - atual.desde > JANELA_MS) {
    tentativas.delete(chave);
    return false;
  }
  return atual.contador >= LIMITE;
}

module.exports = { gerarToken, exigirAuth, exigirGerente, registrarFalha, limparFalhas, bloqueado };
