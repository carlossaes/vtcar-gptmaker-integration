const express = require('express');
const store = require('../store');
const { listAllChats } = require('../gptmakerClient');

const router = express.Router();

// Mesma protecao das outras rotas do CRM: se CRM_API_KEY estiver definida,
// exige o header x-api-key. O token do GPT Maker nunca sai daqui — ele fica
// so nas variaveis de ambiente e e usado do lado do servidor.
router.use((req, res, next) => {
  const expectedKey = process.env.CRM_API_KEY;
  if (!expectedKey) return next();
  if (req.header('x-api-key') === expectedKey) return next();
  return res.status(401).json({ error: 'x-api-key invalido ou ausente' });
});

const soDigitos = (v) => String(v || '').replace(/\D/g, '');

// Chat do GPT Maker no formato enxuto que o CRM precisa.
function normalizarChat(chat) {
  const phone = soDigitos(chat.whatsappPhone || chat.recipient || chat.name);
  return {
    id: chat.id || null,
    name: chat.name || chat.userName || null,
    phone: phone || null,
    createdAt: chat.createdAt ? new Date(chat.createdAt).toISOString() : null,
    channelType: chat.type || null,
    agentId: chat.agentId || null,
    finished: chat.finished === true,
  };
}

// GET /api/gptmaker/chats
// Lista TODOS os atendimentos do workspace, desde o primeiro — paginando por
// baixo dos panos. E a fonte da verdade sobre quem falou com o WhatsApp.
router.get('/chats', async (req, res) => {
  try {
    const brutos = await listAllChats({
      workspaceId: process.env.GPTMAKER_WORKSPACE_ID,
      agentId: req.query.agentId || process.env.GPTMAKER_AGENT_ID,
    });
    const chats = brutos.map(normalizarChat);
    const datas = chats.map((c) => c.createdAt).filter(Boolean).sort();
    res.json({
      total: chats.length,
      primeiro: datas[0] || null,
      ultimo: datas[datas.length - 1] || null,
      chats,
    });
  } catch (err) {
    console.error('[gptmaker] Falha ao listar chats:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/gptmaker/reconciliacao
// Responde a pergunta que interessa: o que existe no GPT Maker e nao virou
// lead no CRM? Compara pelo telefone (so digitos), com o id do chat como
// segunda chance.
router.get('/reconciliacao', async (req, res) => {
  try {
    const brutos = await listAllChats({
      workspaceId: process.env.GPTMAKER_WORKSPACE_ID,
      agentId: req.query.agentId || process.env.GPTMAKER_AGENT_ID,
    });
    const chats = brutos.map(normalizarChat);
    const leads = store.getAllLeads();

    const fonesCrm = new Set(leads.map((l) => soDigitos(l.phone)).filter(Boolean));
    const chatIdsCrm = new Set(leads.map((l) => l.gptmakerChatId).filter(Boolean));

    const noCrm = (c) =>
      (c.phone && fonesCrm.has(c.phone)) || (c.id && chatIdsCrm.has(c.id));

    const ausentesNoCrm = chats.filter((c) => !noCrm(c));

    const fonesGpt = new Set(chats.map((c) => c.phone).filter(Boolean));
    const idsGpt = new Set(chats.map((c) => c.id).filter(Boolean));
    const semCorrespondencia = leads.filter((l) => {
      const f = soDigitos(l.phone);
      return !(f && fonesGpt.has(f)) && !(l.gptmakerChatId && idsGpt.has(l.gptmakerChatId));
    });

    const datasGpt = chats.map((c) => c.createdAt).filter(Boolean).sort();
    const datasCrm = leads.map((l) => l.createdAt).filter(Boolean).sort();

    res.json({
      resumo: {
        totalNoGptMaker: chats.length,
        totalNoCrm: leads.length,
        batem: chats.length - ausentesNoCrm.length,
        faltandoNoCrm: ausentesNoCrm.length,
        noCrmSemChatNoGptMaker: semCorrespondencia.length,
        primeiroAtendimentoGptMaker: datasGpt[0] || null,
        primeiroLeadCrm: datasCrm[0] || null,
      },
      // Ordenado do mais antigo pro mais novo: os primeiros da lista sao os
      // que provavelmente vieram de antes do webhook existir.
      ausentesNoCrm: ausentesNoCrm.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
      noCrmSemChatNoGptMaker: semCorrespondencia.map((l) => ({
        id: l.id,
        name: l.name,
        phone: l.phone,
        createdAt: l.createdAt,
        source: l.source,
      })),
    });
  } catch (err) {
    console.error('[gptmaker] Falha na reconciliacao:', err.message);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
