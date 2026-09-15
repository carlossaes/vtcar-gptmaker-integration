const express = require('express');
const crypto = require('crypto');
const store = require('../store');
const usuarios = require('../auth/usuarios');
const { exigirGerente } = require('../auth/middleware');
const { generateCoachAnalysis } = require('../openaiClient');

const router = express.Router();

// Se CRM_API_KEY estiver definida, exige o header x-api-key em todas as
// rotas deste arquivo. Se estiver vazia/ausente, fica aberto (bom pra
// testar rapido; recomendado preencher quando o CRM for usado por mais gente).
router.use((req, res, next) => {
  const expectedKey = process.env.CRM_API_KEY;
  if (!expectedKey) return next();
  if (req.header('x-api-key') === expectedKey) return next();
  return res.status(401).json({ error: 'x-api-key invalido ou ausente' });
});

// Busca o lead e confere, antes de mais nada, se quem esta logado pode ve-lo.
// Devolve 404 tanto pra lead inexistente quanto pra lead de outro vendedor --
// de proposito: um vendedor comum nao tem como distinguir "nao existe" de
// "existe mas nao e seu" so pela resposta.
function acharLeadVisivel(req, res) {
  const lead = store.getLeadById(req.params.id);
  if (!lead || !store.podeVerLead(lead, req.usuario)) {
    res.status(404).json({ error: 'Lead nao encontrado' });
    return null;
  }
  return lead;
}

// GET /api/leads
router.get('/', (req, res) => {
  const leads = store
    .getAllLeads()
    .filter((lead) => store.podeVerLead(lead, req.usuario))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(leads);
});

// POST /api/leads { name, phone, email, channel, vehicleInterest }
// Usado pelo botao "Novo Lead" do CRM, pra cadastro manual (fora do fluxo
// automatico do GPT Maker).
//
// Regra operacional: se quem cadastra e vendedor, o lead nasce ja atribuido
// a ele -- nao faz sentido um vendedor digitar o proprio cliente e o lead
// cair na fila sem dono. Se quem cadastra e gerente, o lead nasce sem
// responsavel, igual a um lead vindo da Vitoria (o gerente atribui depois).
// O corpo da requisicao nunca e usado pra decidir o dono -- so o usuario da
// sessao, do mesmo jeito que em /assumir.
router.post('/', (req, res) => {
  const { name, phone, email, channel, vehicleInterest, notes, gptmakerChatId } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'Campo "name" e obrigatorio' });
  }
  const sourceId = `manual-${crypto.randomUUID()}`;
  const campos = {
    name,
    phone: phone || null,
    email: email || null,
    channel: channel || 'Outro',
    vehicleInterest: vehicleInterest || null,
    notes: notes || null,
    // Permite vincular esse lead a uma conversa ja existente no GPT Maker
    // (contextId), pra quando o contato ja existia antes de virar lead no
    // CRM e por isso o onFirstInteraction nao disparou de novo pra ele.
    gptmakerChatId: gptmakerChatId || null,
    source: 'manual',
  };

  if (req.usuario.papel === 'vendedor') {
    const agora = new Date().toISOString();
    campos.ownerId = req.usuario.id;
    campos.ownerName = req.usuario.nome;
    campos.ownerAssignedAt = agora;
    campos.ownerAssignedBy = req.usuario.id;
    campos.ownershipHistory = [
      {
        action: 'assigned',
        fromUserId: null,
        fromUserName: null,
        toUserId: req.usuario.id,
        toUserName: req.usuario.nome,
        byUserId: req.usuario.id,
        byUserName: req.usuario.nome,
        at: agora,
      },
    ];
  }

  const { lead } = store.upsertLeadBySourceId(sourceId, campos);
  res.status(201).json(lead);
});

// PATCH /api/leads/:id { "stage": "qualificado" }
router.patch('/:id', (req, res) => {
  const lead = acharLeadVisivel(req, res);
  if (!lead) return;

  const { stage } = req.body || {};
  if (!stage) {
    return res.status(400).json({ error: 'Campo "stage" e obrigatorio' });
  }
  try {
    const updated = store.updateLeadStage(lead.id, stage);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/leads/:id/assumir
// O vendedor logado assume, pra si, um lead que ainda nao tem responsavel.
// Nao aceita ownerId no corpo -- quem assume e sempre o usuario da sessao.
//
// De proposito NAO usa acharLeadVisivel aqui: um lead que ja tem responsavel
// fica invisivel pro vendedor no GET /api/leads, mas se ele tentar assumir
// mesmo assim (ex: por um link salvo antes de outro vendedor assumir), a
// resposta certa e 409 "ja tem responsavel" -- sem revelar quem e -- e nao
// um 404 que faria a pessoa achar que o lead sumiu.
router.post('/:id/assumir', (req, res) => {
  const lead = store.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' });

  const r = store.assumirLead(lead.id, { id: req.usuario.id, nome: req.usuario.nome });
  if (r.erro === 'ja-tem-responsavel') {
    return res.status(409).json({ error: 'Este lead ja tem um responsavel' });
  }
  res.json(r.lead);
});

// PATCH /api/leads/:id/responsavel { ownerId }
// So gerente. ownerId precisa ser de um usuario existente, ATIVO e com
// papel "vendedor" -- responsavel comercial e sempre um vendedor, nunca um
// gerente, mesmo que o gerente queira se colocar como dono de um lead.
// ownerId ausente/nulo devolve o lead pra fila sem responsavel.
router.patch('/:id/responsavel', exigirGerente, (req, res) => {
  const lead = store.getLeadById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead nao encontrado' });

  const { ownerId } = req.body || {};
  if (!ownerId) {
    const r = store.definirResponsavel(lead.id, null, req.usuario);
    return res.json(r.lead);
  }

  const alvo = usuarios.acharPorId(ownerId);
  if (!alvo || alvo.ativo === false || alvo.papel !== 'vendedor') {
    return res.status(400).json({ error: 'O responsavel precisa ser um vendedor ativo' });
  }

  const r = store.definirResponsavel(lead.id, { id: alvo.id, nome: alvo.nome }, req.usuario);
  res.json(r.lead);
});

// GET /api/leads/:id/messages
// Historico de mensagens sincronizado via webhook onNewMessage.
router.get('/:id/messages', (req, res) => {
  const lead = acharLeadVisivel(req, res);
  if (!lead) return;
  const messages = store.getMessages(lead.gptmakerChatId);
  res.json(messages);
});

// GET /api/leads/:id/coach
// Retorna a ultima analise do Coach de Vendas ja calculada (ou null se
// ainda nao foi gerada nenhuma vez). Nao chama a OpenAI -- so le o cache.
router.get('/:id/coach', (req, res) => {
  const lead = acharLeadVisivel(req, res);
  if (!lead) return;
  res.json(store.getCoachAnalysis(lead.id));
});

// POST /api/leads/:id/coach
// Forca o calculo de uma analise nova com base nas mensagens atuais.
router.post('/:id/coach', async (req, res) => {
  const lead = acharLeadVisivel(req, res);
  if (!lead) return;

  const messages = store.getMessages(lead.gptmakerChatId);
  if (!messages.length) {
    return res.status(400).json({ error: 'Ainda nao ha mensagens sincronizadas pra esse lead' });
  }

  const transcript = messages
    .map((m) => `${m.direction === 'cliente' ? 'Cliente' : 'Equipe'}: ${m.text}`)
    .join('\n');

  try {
    const analysis = await generateCoachAnalysis(transcript, {
      name: lead.name,
      channel: lead.channel,
      vehicleInterest: lead.vehicleInterest,
      stage: lead.stage,
    });
    const record = {
      ...analysis,
      generatedAt: new Date().toISOString(),
      messageCount: messages.length,
    };
    store.setCoachAnalysis(lead.id, record);
    res.json(record);
  } catch (err) {
    console.error('[coach] Falha ao gerar analise:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
