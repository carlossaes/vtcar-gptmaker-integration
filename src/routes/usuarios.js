const express = require('express');
const usuarios = require('../auth/usuarios');
const mailer = require('../mailer');
const convites = require('../auth/convites');
const { exigirAuth, exigirGerente } = require('../auth/middleware');

const router = express.Router();

// Tudo aqui e area de gerente.
router.use(exigirAuth, exigirGerente);

// GET /api/usuarios
router.get('/', (req, res) => {
  res.json(usuarios.listar().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));
});

// POST /api/usuarios  { nome, email, papel }
// Cria a conta, gera a senha e manda por e-mail. A senha so aparece na
// resposta se o e-mail NAO tiver saido — assim o gerente consegue repassar
// na mao em vez de ficar com um usuario inacessivel.
router.post('/', async (req, res) => {
  const { nome, email, papel } = req.body || {};
  try {
    const { usuario, senha } = usuarios.criar({ nome, email, papel: papel || 'vendedor' });
    const envio = await mailer.enviarBoasVindas({ nome: usuario.nome, email: usuario.email, senha });

    res.status(201).json({
      usuario,
      emailEnviado: envio.enviado,
      // Só devolvemos a senha em texto quando não deu pra enviar o e-mail.
      senhaProvisoria: envio.enviado ? undefined : senha,
      aviso: envio.enviado
        ? undefined
        : 'O e-mail não pôde ser enviado. Repasse a senha provisória para a pessoa por um canal seguro.',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/usuarios/:id  { papel, ativo, nome }
router.patch('/:id', (req, res) => {
  // Trava contra tiro no pé: o gerente não pode se rebaixar nem se desativar
  // se for o único gerente ativo — o CRM ficaria sem quem administra.
  if (req.params.id === req.usuario.id) {
    const virandoVendedor = req.body.papel && req.body.papel !== 'gerente';
    const desativando = req.body.ativo === false;
    if (virandoVendedor || desativando) {
      const outrosGerentes = usuarios
        .listar()
        .filter((u) => u.papel === 'gerente' && u.ativo && u.id !== req.usuario.id);
      if (outrosGerentes.length === 0) {
        return res.status(400).json({
          error: 'Você é o único gerente ativo. Promova outra pessoa a gerente antes de mudar sua própria conta.',
        });
      }
    }
  }

  try {
    const atualizado = usuarios.atualizar(req.params.id, req.body || {});
    if (!atualizado) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(atualizado);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/usuarios/:id
router.delete('/:id', (req, res) => {
  if (req.params.id === req.usuario.id) {
    return res.status(400).json({ error: 'Você não pode remover a própria conta' });
  }
  const alvo = usuarios.acharPorId(req.params.id);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado' });

  if (alvo.papel === 'gerente') {
    const outrosGerentes = usuarios.listar().filter((u) => u.papel === 'gerente' && u.ativo && u.id !== alvo.id);
    if (outrosGerentes.length === 0) {
      return res.status(400).json({ error: 'Não dá pra remover o último gerente ativo' });
    }
  }

  usuarios.remover(req.params.id);
  res.status(204).end();
});

// POST /api/usuarios/:id/reenviar-senha
// Gera uma senha nova e manda por e-mail. Util quando alguem some com o
// acesso e nao consegue usar o "esqueci minha senha".
router.post('/:id/reenviar-senha', async (req, res) => {
  const alvo = usuarios.acharPorId(req.params.id);
  if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado' });

  const senha = usuarios.gerarSenha();
  usuarios.definirSenha(alvo.id, senha);
  // definirSenha limpa a marca; aqui queremos que a pessoa troque de novo.
  usuarios.atualizar(alvo.id, {});
  const lista = usuarios.acharPorId(alvo.id);
  const envio = await mailer.enviarBoasVindas({ nome: lista.nome, email: lista.email, senha });

  res.json({
    ok: true,
    emailEnviado: envio.enviado,
    senhaProvisoria: envio.enviado ? undefined : senha,
  });
});

/* ---------------- convites ---------------- */

// GET /api/usuarios/convites
router.get('/convites', (req, res) => {
  res.json(convites.listar());
});

// POST /api/usuarios/convites  { papel, emailSugerido?, observacao? }
// Devolve o LINK pronto. O token só existe aqui e dentro do link — nem eu
// consigo recuperá-lo depois; se a pessoa perder, o gerente gera outro.
router.post('/convites', (req, res) => {
  const { papel, emailSugerido, observacao } = req.body || {};
  try {
    const { convite, token } = convites.criar({
      papel: papel || 'vendedor',
      emailSugerido,
      observacao,
      criadoPor: req.usuario.id,
    });
    const base = mailer.appUrl();
    res.status(201).json({ convite, link: `${base}/?convite=${token}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/usuarios/convites/:id — cancela um convite ainda não usado
router.delete('/convites/:id', (req, res) => {
  const removido = convites.revogar(req.params.id);
  if (!removido) return res.status(404).json({ error: 'Convite não encontrado' });
  res.status(204).end();
});

module.exports = router;
