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

// Percorre TODAS as paginas de chats do workspace e devolve a lista inteira.
// A API entrega no maximo 100 por vez; aqui a paginacao fica escondida de
// quem chama. O limite de 200 paginas e so uma trava de seguranca pra nunca
// entrar em laco infinito se a API mudar o formato da resposta.
async function listAllChats({ workspaceId, agentId, pageSize = 100, maxPages = 200 }) {
  if (!workspaceId) {
    throw new Error('GPTMAKER_WORKSPACE_ID nao configurado nas variaveis de ambiente');
  }

  const todos = [];
  const vistos = new Set();

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${API_BASE}/v2/workspace/${workspaceId}/chats`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    if (agentId) url.searchParams.set('agentId', agentId);

    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const corpo = await res.text().catch(() => '');
      throw new Error(`Erro ao listar chats do GPT Maker: ${res.status} ${corpo.slice(0, 200)}`);
    }

    const json = await res.json();
    // A API ora devolve array puro, ora um objeto com "data" — aceita os dois.
    const lote = Array.isArray(json) ? json : json.data || [];
    if (!lote.length) break;

    let novos = 0;
    for (const chat of lote) {
      const chave = chat.id || `${chat.whatsappPhone}-${chat.createdAt}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      todos.push(chat);
      novos++;
    }

    // Pagina repetida ou menor que o tamanho pedido significa que acabou.
    // O teste de "novos" protege contra API que ignora o parametro page e
    // devolve sempre a mesma pagina — sem isso, o laco iria ate o maxPages.
    if (novos === 0 || lote.length < pageSize) break;
  }

  return todos;
}

// Procura UM chat pelo id, varrendo as paginas ate achar. Usado so quando o
// webhook chega com identificador "@lid" em vez de telefone — situacao rara,
// entao o custo de paginar compensa nao manter cache de tudo.
async function findChatById({ workspaceId, chatId, agentId, maxPages = 30 }) {
  if (!chatId) return null;
  const pageSize = 100;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${API_BASE}/v2/workspace/${workspaceId}/chats`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    if (agentId) url.searchParams.set('agentId', agentId);

    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Erro ao buscar chat no GPT Maker: ${res.status}`);

    const json = await res.json();
    const lote = Array.isArray(json) ? json : json.data || [];
    if (!lote.length) return null;

    const achado = lote.find((c) => c.id === chatId);
    if (achado) return achado;
    if (lote.length < pageSize) return null;
  }
  return null;
}

module.exports = {
  mapChannelTypeToLabel,
  listChannels,
  resolveChannelLabel,
  listAllChats,
  findChatById,
};
