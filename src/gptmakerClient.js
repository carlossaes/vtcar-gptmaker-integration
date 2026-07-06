// Cliente fino pra API do GPT Maker (https://developer.gptmaker.ai).
// Usa o "fetch" global do Node 18+, sem dependencias extras.

const API_BASE = 'https://api.gptmaker.ai';

function authHeaders() {
  const token = process.env.GPTMAKER_TOKEN;
  if (!token) {
    throw new Error('GPTMAKER_TOKEN nao configurado nas variaveis de ambiente');
  }
  return { Authorization: `Bearer ${token}` };
}

// Mapeia o "type" de canal do GPT Maker pro rotulo usado no CRM.
function mapChannelTypeToLabel(type) {
  const map = {
    WHATSAPP: 'WhatsApp',
    Z_API: 'WhatsApp',
    CLOUD_API: 'WhatsApp',
    INSTAGRAM: 'Instagram',
    MESSENGER: 'Facebook',
    WIDGET: 'Site',
    TELEGRAM: 'Telegram',
    MERCADO_LIVRE: 'Mercado Livre',
    TWILIO_SMS: 'SMS',
  };
  return map[type] || 'Outro';
}

// Cache simples em memoria da lista de canais, pra nao bater na API do
// GPT Maker a cada webhook recebido (canais mudam raramente).
let channelsCache = { data: null, fetchedAt: 0 };
const CHANNELS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

async function listChannels(workspaceId) {
  const now = Date.now();
  if (channelsCache.data && now - channelsCache.fetchedAt < CHANNELS_CACHE_TTL_MS) {
    return channelsCache.data;
  }

  const url = `${API_BASE}/v2/workspace/${workspaceId}/channels?pageSize=100`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Erro ao listar canais do GPT Maker: ${res.status}`);
  }
  const json = await res.json();
  const channels = Array.isArray(json) ? json : json.data || [];
  channelsCache = { data: channels, fetchedAt: now };
  return channels;
}

// Dado um channelId (quando o webhook informar) tenta descobrir o rotulo
// de canal pra exibir no CRM. Se nao achar, cai no fallback "Desconhecido".
async function resolveChannelLabel(workspaceId, channelId) {
  if (!channelId) return 'Desconhecido';
  try {
    const channels = await listChannels(workspaceId);
    const found = channels.find((c) => c.id === channelId);
    return found ? mapChannelTypeToLabel(found.type) : 'Desconhecido';
  } catch (err) {
    console.error('[gptmakerClient] Falha ao resolver canal:', err.message);
    return 'Desconhecido';
  }
}

module.exports = {
  mapChannelTypeToLabel,
  listChannels,
  resolveChannelLabel,
};
