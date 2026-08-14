const express = require('express');
const store = require('../store');
const { listAllChats } = require('../gptmakerClient');
const { isLidPhone } = require('../normalizeLead');
const { mapChannelTypeToLabel } = require('../gptmakerClient');

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

// POST /api/gptmaker/corrigir-telefones
// Conserta os leads que ficaram com o LID gravado no lugar do numero,
// puxando o telefone real do chat correspondente no GPT Maker.
// Use ?dryRun=1 pra so ver o que seria alterado, sem gravar nada.
router.post('/corrigir-telefones', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const chats = await listAllChats({
      workspaceId: process.env.GPTMAKER_WORKSPACE_ID,
      agentId: process.env.GPTMAKER_AGENT_ID,
    });
    const porId = new Map(chats.map((c) => [c.id, c]));

    const quebrados = store.getAllLeads().filter((l) => isLidPhone(l.phone));
    const corrigidos = [];
    const semSolucao = [];

    for (const lead of quebrados) {
      const chat = porId.get(lead.gptmakerChatId);
      const real = chat && chat.whatsappPhone ? String(chat.whatsappPhone) : null;

      // So aceita numero plausivel: 10 a 13 digitos e nada de "@".
      const digitos = real ? real.replace(/\D/g, '') : '';
      if (!real || isLidPhone(real) || digitos.length < 10 || digitos.length > 13) {
        semSolucao.push({ id: lead.id, name: lead.name, phone: lead.phone, encontrado: real });
        continue;
      }

      if (!dryRun) {
        // upsert pelo mesmo sourceId: atualiza o telefone e preserva o
        // estagio que o vendedor ja tiver definido no funil.
        store.upsertLeadBySourceId(lead.sourceId, { phone: real });
      }
      corrigidos.push({ id: lead.id, name: lead.name, de: lead.phone, para: real });
    }

    res.json({ dryRun, encontrados: quebrados.length, corrigidos, semSolucao });
  } catch (err) {
    console.error('[gptmaker] Falha ao corrigir telefones:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// POST /api/gptmaker/importar-antigos
// Traz pro CRM os atendimentos que existem no GPT Maker mas nunca viraram
// lead — os anteriores ao dia em que o webhook foi ligado.
// Use ?dryRun=1 pra ver o que entraria, sem gravar nada.
router.post('/importar-antigos', async (req, res) => {
  const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
  try {
    const brutos = await listAllChats({
      workspaceId: process.env.GPTMAKER_WORKSPACE_ID,
      agentId: process.env.GPTMAKER_AGENT_ID,
    });

    const leads = store.getAllLeads();
    const fonesCrm = new Set(leads.map((l) => soDigitos(l.phone)).filter(Boolean));
    const chatIdsCrm = new Set(leads.map((l) => l.gptmakerChatId).filter(Boolean));

    const importados = [];
    const ignorados = [];

    for (const chat of brutos) {
      const c = normalizarChat(chat);
      const jaExiste = (c.phone && fonesCrm.has(c.phone)) || (c.id && chatIdsCrm.has(c.id));
      if (jaExiste) continue;

      // Sem telefone nao da pra ligar nem deduplicar direito — melhor deixar
      // de fora e relatar do que encher o CRM de registro inutil.
      if (!c.phone) {
        ignorados.push({ id: c.id, name: c.name, motivo: 'sem telefone' });
        continue;
      }

      // Marca o telefone como visto ANTES do dryRun decidir gravar. Se dois
      // chats do GPT Maker tiverem o mesmo numero, o ensaio contaria dois e a
      // execucao real importaria um — e o numero prometido nao bateria.
      fonesCrm.add(c.phone);

      if (!dryRun) {
        store.upsertLeadBySourceId(c.phone, {
          name: c.name || 'Sem nome',
          phone: c.phone,
          email: null,
          channel: mapChannelTypeToLabel(c.channelType),
          gptmakerChatId: c.id,
          vehicleInterest: null,
          // Preserva a data real da conversa. Sem isso, os 162 entrariam
          // como se tivessem chegado hoje e o grafico do dashboard mentiria.
          createdAt: c.createdAt || new Date().toISOString(),
          source: 'gptmaker-historico',
        });
      }

      importados.push({ nome: c.name, telefone: c.phone, quando: c.createdAt });
    }

    const datas = importados.map((i) => i.quando).filter(Boolean).sort();
    res.json({
      dryRun,
      importados: importados.length,
      ignorados,
      periodoImportado: { do: datas[0] || null, ate: datas[datas.length - 1] || null },
      totalNoCrmDepois: dryRun ? store.getAllLeads().length + importados.length : store.getAllLeads().length,
      amostra: importados.slice(0, 5),
    });
  } catch (err) {
    console.error('[gptmaker] Falha ao importar antigos:', err.message);
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
