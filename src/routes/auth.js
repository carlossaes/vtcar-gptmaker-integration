const express = require('express');
const usuarios = require('../auth/usuarios');
const mailer = require('../mailer');
const convites = require('../auth/convites');
const { gerarToken, exigirAuth, registrarFalha, limparFalhas, bloqueado } = require('../auth/middleware');

const router = express.Router();

const SENHA_MINIMA = 8;

function validarSenha(senha) {
  if (!senha || String(senha).length < SENHA_MINIMA) {
    return `A senha precisa ter pelo menos ${SENHA_MINIMA} caracteres`;
  }
  return null;
}

// GET /api/auth/precisa-configurar
// O front usa isso pra saber se mostra a tela de primeiro acesso.
router.get('/precisa-configurar', (req, res) => {
  res.json({ precisaConfigurar: usuarios.contar() === 0 || usuarios.setupAbandonado() });
});

// POST /api/auth/primeiro-acesso  { nome, email }
// Cria a PRIMEIRA conta de gerente. Só funciona enquanto o sistema estiver
// sem nenhum usuário — depois disso a rota se fecha sozinha e novas contas
// passam a ser criadas apenas por um gerente logado.
router.post('/primeiro-acesso', async (req, res) => {
  const vazio = usuarios.contar() === 0;
  const abandonado = usuarios.setupAbandonado();
  if (!vazio && !abandonado) {
    return res.status(403).json({ error: 'O CRM já está configurado. Peça um link de convite a um gerente.' });
  }
  // Refazendo um setup que ficou pela metade: apaga a conta que nunca foi
  // usada pra nao deixar um acesso órfão pendurado.
  if (abandonado) {
    usuarios.limparTudo();
    console.log('[auth] Setup abandonado detectado — conta anterior (nunca usada) removida.');
  }

  const { nome, email, senha } = req.body || {};
  try {
    // Agora a pessoa escolhe a própria senha já na criação — ninguém precisa
    // decorar senha gerada nem depender de e-mail configurado.
    const erroSenha = validarSenha(senha);
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const { usuario } = usuarios.criar({ nome, email, papel: 'gerente', senha, jaDefiniuSenha: true });
    console.log(`[auth] Primeiro gerente criado: ${usuario.email}`);

    const completo = usuarios.acharPorEmail(usuario.email);
    res.status(201).json({ usuario, token: gerarToken(completo) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login  { email, senha }
router.post('/login', (req, res) => {
  const { email, senha } = req.body || {};
  const chave = String(email || '').trim().toLowerCase();

  if (!chave || !senha) {
    return res.status(400).json({ error: 'Informe e-mail e senha' });
  }
  if (bloqueado(chave)) {
    return res.status(429).json({ error: 'Muitas tentativas. Espere alguns minutos e tente de novo.' });
  }

  const usuario = usuarios.acharPorEmail(chave);
  // Mesma resposta para e-mail inexistente e senha errada: nao entregamos
  // de bandeja quais e-mails existem no sistema.
  if (!usuario || !usuarios.conferirSenha(usuario, senha)) {
    registrarFalha(chave);
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  }
  if (usuario.ativo === false) {
    return res.status(403).json({ error: 'Esta conta está desativada. Fale com o gerente.' });
  }

  limparFalhas(chave);
  usuarios.registrarAcesso(usuario.id);
  res.json({ token: gerarToken(usuario), usuario: usuarios.publico(usuario) });
});

// GET /api/auth/eu — quem esta logado (usado pra revalidar o token ao abrir)
router.get('/eu', exigirAuth, (req, res) => {
  res.json({ usuario: req.usuario });
});

// POST /api/auth/trocar-senha  { senhaAtual, novaSenha }
router.post('/trocar-senha', exigirAuth, (req, res) => {
  const { senhaAtual, novaSenha } = req.body || {};
  const erro = validarSenha(novaSenha);
  if (erro) return res.status(400).json({ error: erro });

  const completo = usuarios.acharPorId(req.usuario.id);
  if (!usuarios.conferirSenha(completo, senhaAtual)) {
    return res.status(401).json({ error: 'A senha atual está incorreta' });
  }

  usuarios.definirSenha(req.usuario.id, novaSenha);
  res.json({ ok: true, usuario: usuarios.acharPorId(req.usuario.id) && usuarios.publico(usuarios.acharPorId(req.usuario.id)) });
});

// POST /api/auth/esqueci-senha  { email }
// Responde sempre a mesma coisa, exista o e-mail ou nao — senao isso vira um
// jeito de descobrir quem tem conta.
router.post('/esqueci-senha', async (req, res) => {
  const { email } = req.body || {};
  const resposta = { ok: true, mensagem: 'Se esse e-mail estiver cadastrado, o link de recuperação chegará em instantes.' };

  if (!email) return res.json(resposta);

  try {
    const criado = usuarios.criarTokenReset(email);
    if (criado) {
      await mailer.enviarRecuperacao({
        nome: criado.usuario.nome,
        email: criado.usuario.email,
        token: criado.token,
      });
    }
  } catch (err) {
    console.error('[auth] Falha na recuperacao de senha:', err.message);
  }

  res.json(resposta);
});

// POST /api/auth/redefinir-senha  { token, novaSenha }
router.post('/redefinir-senha', (req, res) => {
  const { token, novaSenha } = req.body || {};
  const erro = validarSenha(novaSenha);
  if (erro) return res.status(400).json({ error: erro });

  const r = usuarios.usarTokenReset(token, novaSenha);
  if (!r.ok) {
    const mensagens = {
      'token-invalido': 'Esse link não é válido. Pode já ter sido usado — peça um novo.',
      'token-expirado': 'Esse link expirou. Peça um novo pelo "Esqueci minha senha".',
      'dados-incompletos': 'Link incompleto. Peça um novo.',
    };
    return res.status(400).json({ error: mensagens[r.motivo] || 'Não foi possível redefinir a senha' });
  }

  const completo = usuarios.acharPorEmail(r.usuario.email);
  res.json({ ok: true, token: gerarToken(completo), usuario: r.usuario });
});

// GET /api/auth/convite/:token — o front confere o link antes de mostrar o
// formulário, pra não deixar a pessoa preencher tudo e só então descobrir
// que o convite venceu.
router.get('/convite/:token', (req, res) => {
  const r = convites.conferir(req.params.token);
  if (r.valido) {
    return res.json({ valido: true, papel: r.convite.papel, emailSugerido: r.convite.emailSugerido });
  }
  const mensagens = {
    inexistente: 'Este link de convite não é válido. Peça um novo ao gerente.',
    usado: 'Este convite já foi usado. Se a conta é sua, entre normalmente; senão peça um novo link.',
    expirado: 'Este convite expirou. Peça um novo ao gerente.',
  };
  res.status(400).json({ valido: false, error: mensagens[r.motivo] });
});

// POST /api/auth/aceitar-convite  { token, nome, email, senha }
// A pessoa cria a própria conta a partir do link. Já entra logada.
router.post('/aceitar-convite', (req, res) => {
  const { token, nome, email, senha } = req.body || {};

  const r = convites.conferir(token);
  if (!r.valido) {
    const mensagens = {
      inexistente: 'Este link de convite não é válido. Peça um novo ao gerente.',
      usado: 'Este convite já foi usado.',
      expirado: 'Este convite expirou. Peça um novo ao gerente.',
    };
    return res.status(400).json({ error: mensagens[r.motivo] });
  }

  const erroSenha = validarSenha(senha);
  if (erroSenha) return res.status(400).json({ error: erroSenha });

  try {
    const { usuario } = usuarios.criar({
      nome,
      email,
      papel: r.convite.papel,
      senha,
      jaDefiniuSenha: true,
    });
    convites.marcarUsado(token, usuario.id);
    console.log(`[auth] Convite usado: ${usuario.email} entrou como ${usuario.papel}`);

    const completo = usuarios.acharPorEmail(usuario.email);
    res.status(201).json({ usuario, token: gerarToken(completo) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
