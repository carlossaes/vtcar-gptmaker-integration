const express = require('express');
const store = require('../store');
const { normalizeWebhookPayload, isLidPhone } = require('../normalizeLead');
const { normalizeMessagePayload } = require('../normalizeMessage');
const { resolveChannelLabel, mapChannelTypeToLabel, findChatById } = require('../gptmakerClient');

const router = express.Router();

// POST /webhooks/gptmaker?key=WEBHOOK_SECRET
// Configurado no GPT Maker como o webhook "onFirstInteraction" do agente.
router.post('/gptmaker', async (req, res) => {
  // Sempre guarda o ultimo payload bruto recebido, ANTES de checar a chave
  // secreta -- assim da pra diagnosticar tanto "chave errada" quanto
  // "o GPT Maker nunca chamou o webhook" olhando /api/debug/last-webhook.
  store.setLastWebhookDebug({ query: req.query, body: req.body });

  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && req.query.key !== expectedSecret) {
    return res.status(403).json({ error: 'Chave de webhook invalida' });
  }

  const normalized = normalizeWebhookPayload(req.body);
  if (!normalized) {
    console.warn('[webhooks] Payload recebido sem campos reconheciveis. Veja /api/debug/last-webhook');
    return res.status(200).json({
      received: true,
      warning: 'Payload sem campos reconheciveis, verifique /api/debug/last-webhook',
    });
  }

  // O payload ja costuma trazer o tipo do canal pronto (ex: "WHATSAPP"),
  // entao so caimos na chamada a API (mais lenta) se isso nao vier.
  let channel;
  if (normalized.channelTypeRaw) {
    channel = mapChannelTypeToLabel(normalized.channelTypeRaw);
  } else {
    const workspaceId = process.env.GPTMAKER_WORKSPACE_ID;
    channel = await resolveChannelLabel(workspaceId, normalized.channelIdRaw);
  }

  // Contato identificado por LID nao traz telefone no webhook. Buscamos o
  // numero real no chat correspondente. Se falhar, o lead entra do mesmo
  // jeito (com o LID) — melhor um lead com telefone ruim do que lead nenhum.
  let phone = normalized.phone;
  if (isLidPhone(phone)) {
    try {
      const chat = await findChatById({
        workspaceId: process.env.GPTMAKER_WORKSPACE_ID,
        chatId: normalized.gptmakerChatId,
        agentId: process.env.GPTMAKER_AGENT_ID,
      });
      if (chat && chat.whatsappPhone) {
        phone = String(chat.whatsappPhone);
        console.log(`[webhooks] Telefone recuperado do LID: ${normalized.phone} -> ${phone}`);
      } else {
        console.warn(`[webhooks] Nao achei telefone real para o LID ${normalized.phone}`);
      }
    } catch (err) {
      console.error('[webhooks] Falha ao resolver LID:', err.message);
    }
  }

  // sourceId continua sendo o LID de proposito: e a chave de deduplicacao e
  // mexer nela criaria lead duplicado pra quem ja esta gravado.
  const { lead, created } = store.upsertLeadBySourceId(normalized.sourceId, {
    name: normalized.name,
    phone,
    email: normalized.email,
    channel,
    gptmakerContactId: normalized.gptmakerContactId,
    gptmakerChatId: normalized.gptmakerChatId,
    vehicleInterest: normalized.vehicleInterest,
  });

  console.log(`[webhooks] Lead ${created ? 'criado' : 'atualizado'}: ${lead.name} (${lead.phone || lead.email || lead.id})`);

  res.status(200).json({ received: true, leadId: lead.id, created });
});

// POST /webhooks/gptmaker/message?key=WEBHOOK_SECRET
// Configurado no GPT Maker como o webhook "onNewMessage" do agente.
// Dispara a cada mensagem nova (cliente ou equipe) em qualquer atendimento.
router.post('/gptmaker/message', async (req, res) => {
  store.setLastWebhookDebug({ type: 'message', query: req.query, body: req.body });

  const expectedSecret = process.env.WEBHOOK_SECRET;
  if (expectedSecret && req.query.key !== expectedSecret) {
    return res.status(403).json({ error: 'Chave de webhook invalida' });
  }

  const normalized = normalizeMessagePayload(req.body);
  if (!normalized) {
    console.warn('[webhooks] Mensagem sem chatId/texto reconhecivel. Veja /api/debug/last-webhook');
    return res.status(200).json({
      received: true,
      warning: 'Payload sem chatId/texto reconhecivel, verifique /api/debug/last-webhook',
    });
  }

  store.appendMessage(normalized.chatId, {
    text: normalized.text,
    direction: normalized.direction,
    at: normalized.at,
  });

  res.status(200).json({ received: true });
});

module.exports = router;
