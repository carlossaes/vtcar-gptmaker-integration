// ATENCAO: o formato exato do payload que o GPT Maker envia no webhook
// "onFirstInteraction" nao e documentado publicamente. Esta funcao tenta,
// de forma defensiva, achar os campos certos em varios formatos possiveis.
//
// Depois que o primeiro evento real chegar, confira em:
//   GET /api/debug/last-webhook
// o corpo exato recebido, e ajuste os caminhos abaixo se necessario.

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

function extractContactBlock(payload) {
  // Tenta achar um sub-objeto que pareca ser o contato/cliente.
  return payload.contact || payload.client || payload.customer || payload.chat || payload;
}

function extractChannelId(payload) {
  return firstDefined(
    payload.channelId,
    payload.channel && payload.channel.id,
    payload.chat && payload.chat.channelId,
    payload.chatChannelId,
  ) || null;
}

function extractChatId(payload) {
  return firstDefined(
    payload.chatId,
    payload.chat && payload.chat.id,
    payload.contextId,
  ) || null;
}

// Recebe o corpo bruto do webhook e devolve os campos ja no formato que o
// store.js espera para criar/atualizar um lead. Nao faz chamada de rede
// aqui (a resolucao do nome do canal fica por conta de quem chama).
function normalizeWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const contact = extractContactBlock(payload);
  const name = firstDefined(contact.name, contact.chatName, payload.chatName, 'Sem nome');
  const phone = firstDefined(contact.phone, contact.recipient, payload.recipient, null);
  const email = firstDefined(contact.email, null);
  const gptmakerContactId = firstDefined(contact.id, null);
  const gptmakerChatId = extractChatId(payload);
  const channelIdRaw = extractChannelId(payload);

  // Precisa de pelo menos um identificador util pra nao criar lead "vazio".
  const sourceId = gptmakerContactId || phone || gptmakerChatId;
  if (!sourceId) {
    return null;
  }

  return {
    sourceId,
    name,
    phone,
    email,
    gptmakerContactId,
    gptmakerChatId,
    channelIdRaw,
    vehicleInterest: null, // sem campo pronto na API; preencher manualmente ou via custom field
  };
}

module.exports = { normalizeWebhookPayload };
