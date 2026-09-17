const express = require('express');
const crypto = require('crypto');
const store = require('../store');
const { commercialPatch, normalizeOpportunity } = require('../opportunity');
const usuarios = require('../auth/usuarios');
const { exigirGerente } = require('../auth/middleware');
const { generateCoachAnalysis } = require('../openaiClient');

const router = express.Router();

// Lista fixa nesta entrega -- virar cadastro configuravel fica pra depois.
const ORIGENS = ['Webmotors', 'OLX', 'iCarros', 'Indicação', 'Loja', 'Telefone', 'Instagram', 'Outro'];

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

// POST /api/leads { name, phone, email, vehicleInterest, notes, origin, ownerId? }
// Usado pelo botao "+ Nova oportunidade" do CRM, pra cadastro manual (fora
// do fluxo automatico do GPT Maker). Desde a Entrega 003, todo cadastro
// manual por aqui e uma OPORTUNIDADE -- nasce sempre com responsavel e
// nunca passa pela fila "sem responsavel" (isso substitui o comportamento
// da Entrega 002, onde um gerente podia criar lead manual sem dono).
//
// Responsavel:
// - vendedor: e sempre quem esta logado -- ownerId do corpo e ignorado.
// - gerente: obrigatorio escolher um vendedor ativo pelo ownerId.
//
// Duplicidade: telefone e normalizado (DDI opcional) e comparado contra
// TODOS os leads/oportunidades existentes, antes de criar. Se already
// existir, devolve 409 com o minimo pro frontend oferecer abrir o registro
// -- nunca cria duplicado silenciosamente.
router.post('/', (req, res) => {
  const { name, phone, email, vehicleInterest, notes, origin, ownerId, gptmakerChatId } = req.body || {};

  if (!name) return res.status(400).json({ error: 'Campo "name" e obrigatorio' });
  if (!phone) return res.status(400).json({ error: 'Campo "phone" e obrigatorio' });
  if (typeof vehicleInterest !== 'string' || !vehicleInterest.trim()) return res.status(400).json({ error: 'Veículo de interesse é obrigatório' });
  let commercial;
  try { commercial = commercialPatch(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  if (!origin || !ORIGENS.includes(origin)) {
    return res.status(400).json({ error: `Campo "origin" e obrigatorio e deve ser um de: ${ORIGENS.join(', ')}` });
  }

  const telefoneNormalizado = store.normalizarTelefone(phone);
  const existente = store.acharPorTelefoneNormalizado(telefoneNormalizado);
  if (existente) {
    return res.status(409).json({
      error: 'Ja existe um registro com este telefone.',
      existente: {
        id: existente.id,
        name: existente.name,
        ownerName: existente.ownerName || null,
        stage: existente.stage,
        recordType: existente.recordType,
      },
    });
  }

  // Nunca confia no ownerId do corpo pra um vendedor -- so pra gerente, e
  // ainda assim so depois de validar quem e.
  let dono;
  if (req.usuario.papel === 'vendedor') {
    dono = { id: req.usuario.id, nome: req.usuario.nome };
  } else {
    if (!ownerId) return res.status(400).json({ error: 'Escolha um vendedor responsavel' });
    const alvo = usuarios.acharPorId(ownerId);
    if (!alvo || alvo.ativo === false || alvo.papel !== 'vendedor') {
      return res.status(400).json({ error: 'O responsavel precisa ser um vendedor ativo' });
    }
    dono = { id: alvo.id, nome: alvo.nome };
  }

  const agora = new Date().toISOString();
  const sourceId = `manual-${crypto.randomUUID()}`;
  const { lead } = store.upsertLeadBySourceId(sourceId, {
    name,
    phone,
    email: email || null,
    // Sem campo de canal no formulario novo -- a origem escolhida ja
    // aparece na mesma coluna que os leads do GPT Maker usam pro canal.
    channel: origin,
    origin,
    vehicleInterest: vehicleInterest || null,
    notes: notes || null,
    gptmakerChatId: gptmakerChatId || null,
    source: 'manual',
    ...commercial,
    recordType: 'opportunity',
    ownerId: dono.id,
    ownerName: dono.nome,
    ownerAssignedAt: agora,
    ownerAssignedBy: req.usuario.id,
    ownershipHistory: [
      {
        action: 'assigned',
        fromUserId: null,
        fromUserName: null,
        toUserId: dono.id,
        toUserName: dono.nome,
        byUserId: req.usuario.id,
        byUserName: req.usuario.nome,
        at: agora,
      },
    ],
  });
  res.status(201).json(normalizeOpportunity(lead));
});

router.patch('/:id/comercial', (req, res) => {
  const lead = acharLeadVisivel(req, res);
  if (!lead) return;
  if (req.usuario.papel !== 'gerente' && !(req.usuario.papel === 'vendedor' && lead.ownerId === req.usuario.id)) {
    return res.status(403).json({ error: 'Somente o responsável ou gerente pode editar' });
  }
  if (lead.recordType !== 'opportunity') return res.status(400).json({ error: 'Registro não é uma oportunidade' });
  try { res.json(store.updateOpportunity(lead.id, req.body)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/:id/lead-data', (req, res) => {
  const lead = acharLeadVisivel(req, res);
  if (!lead) return;
  if (lead.recordType !== 'lead') return res.status(409).json({ error: 'Oportunidade não permite edição cadastral' });
  if (req.usuario.papel !== 'gerente' && !(req.usuario.papel === 'vendedor' && store.semResponsavel(lead))) {
    return res.status(403).json({ error: 'Somente gerente ou vendedor em lead livre pode editar' });
  }
  try { res.json(store.updateLeadData(lead.id, req.body)); }
  catch (err) { res.status(err.status || 400).json({ error: err.message }); }
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
