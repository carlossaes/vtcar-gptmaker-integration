// ATENCAO: o formato exato do payload do webhook "onNewMessage" ainda nao
// foi confirmado (diferente do onFirstInteraction, que ja confirmamos via
// /api/debug/last-webhook). Esta extracao e defensiva por enquanto -- depois
// do primeiro evento real, confira o debug e ajuste os caminhos abaixo se
// necessario, do mesmo jeito que fizemos com normalizeLead.js.

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

function extractChatId(payload) {
  return firstDefined(
    payload.contextId,
    payload.chatId,
    payload.chat && payload.chat.id,
  ) || null;
}

function extractText(payload) {
  const raw = firstDefined(
    payload.message,
    payload.text,
    payload.content,
    payload.body,
  );
  if (raw == null) return '';
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

// Tenta descobrir se a mensagem veio do cliente ou da equipe (agente/humano).
// Por padrao assume "cliente" se nao conseguir identificar, pra nao perder o
// registro -- o importante e nao travar a sincronizacao.
function extractDirection(payload) {
  if (payload.fromMe === true) return 'equipe';
  if (payload.fromMe === false) return 'cliente';
  if (payload.role === 'assistant' || payload.role === 'agent') return 'equipe';
  if (payload.role === 'user' || payload.role === 'client') return 'cliente';
  if (payload.sender === 'agent' || payload.sender === 'bot') return 'equipe';
  if (payload.direction === 'out' || payload.direction === 'outbound') return 'equipe';
  return 'cliente';
}

function normalizeMessagePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const chatId = extractChatId(payload);
  const text = extractText(payload);
  if (!chatId || !text) return null;

  return {
    chatId,
    text,
    direction: extractDirection(payload),
    at: new Date().toISOString(),
  };
}

module.exports = { normalizeMessagePayload };
