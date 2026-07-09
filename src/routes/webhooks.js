const express = require('express');
const store = require('../store');
const { normalizeWebhookPayload } = require('../normalizeLead');
const { resolveChannelLabel } = require('../gptmakerClient');

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

  const workspaceId = process.env.GPTMAKER_WORKSPACE_ID;
  const channel = await resolveChannelLabel(workspaceId, normalized.channelIdRaw);

  const { lead, created } = store.upsertLeadBySourceId(normalized.sourceId, {
    name: normalized.name,
    phone: normalized.phone,
    email: normalized.email,
    channel,
    gptmakerContactId: normalized.gptmakerContactId,
    gptmakerChatId: normalized.gptmakerChatId,
    vehicleInterest: normalized.vehicleInterest,
  });

  console.log(`[webhooks] Lead ${created ? 'criado' : 'atualizado'}: ${lead.name} (${lead.phone || lead.email || lead.id})`);

  res.status(200).json({ received: true, leadId: lead.id, created });
});

module.exports = router;
