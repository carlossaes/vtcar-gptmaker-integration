// Armazenamento simples em arquivo JSON.
//
// AVISO: no plano free do Render o disco local NAO e garantido como
// persistente entre deploys/reinicios do servico. Isso funciona bem pra
// validar a integracao ponta a ponta, mas se voce for depender disso em
// producao por muito tempo, vale migrar pra um banco de verdade (Render
// Postgres, Supabase, etc). O modulo abaixo foi escrito como uma classe
// isolada exatamente pra facilitar essa troca depois.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const DEBUG_FILE = path.join(DATA_DIR, 'last-webhook.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const COACH_FILE = path.join(DATA_DIR, 'coach.json');

function ensureFile(filePath, defaultContent) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2));
  }
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

// Escrita atomica: escreve num arquivo temporario e so entao renomeia,
// pra evitar corromper o JSON se o processo cair no meio da escrita.
function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

ensureFile(LEADS_FILE, []);
ensureFile(DEBUG_FILE, null);
ensureFile(MESSAGES_FILE, {});
ensureFile(COACH_FILE, {});

const ALLOWED_STAGES = ['novo', 'qualificado', 'proposta', 'negociacao', 'fechado', 'perdido'];

function getAllLeads() {
  return readJson(LEADS_FILE, []);
}

function getLeadById(id) {
  return getAllLeads().find((lead) => lead.id === id) || null;
}

// Cria ou atualiza um lead a partir de um identificador de origem estavel
// (o id do contato no GPT Maker, ou o telefone se o contato nao tiver id).
// Em criacoes novas aplica os campos default (estagio "novo" etc.), em
// atualizacoes so faz merge dos campos novos sem sobrescrever o estagio
// que o vendedor ja tiver movido manualmente no CRM.
function upsertLeadBySourceId(sourceId, fields) {
  const leads = getAllLeads();
  const now = new Date().toISOString();
  const existingIndex = leads.findIndex((lead) => lead.sourceId === sourceId);

  if (existingIndex === -1) {
    const newLead = {
      id: crypto.randomUUID(),
      sourceId,
      stage: 'novo',
      source: 'gptmaker',
      createdAt: now,
      updatedAt: now,
      ...fields,
    };
    leads.unshift(newLead);
    writeJsonAtomic(LEADS_FILE, leads);
    return { lead: newLead, created: true };
  }

  const current = leads[existingIndex];
  const updated = {
    ...current,
    ...fields,
    stage: current.stage, // preserva o estagio do funil ja definido no CRM
    updatedAt: now,
  };
  leads[existingIndex] = updated;
  writeJsonAtomic(LEADS_FILE, leads);
  return { lead: updated, created: false };
}

function updateLeadStage(id, stage) {
  if (!ALLOWED_STAGES.includes(stage)) {
    throw new Error(`Estagio invalido: ${stage}`);
  }
  const leads = getAllLeads();
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return null;

  leads[index] = {
    ...leads[index],
    stage,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(LEADS_FILE, leads);
  return leads[index];
}

// Mensagens sincronizadas de cada atendimento, guardadas por gptmakerChatId
// (o mesmo "contextId" que o GPT Maker manda nos webhooks).
function getMessages(chatId) {
  if (!chatId) return [];
  const all = readJson(MESSAGES_FILE, {});
  return all[chatId] || [];
}

function appendMessage(chatId, message) {
  if (!chatId) return [];
  const all = readJson(MESSAGES_FILE, {});
  if (!all[chatId]) all[chatId] = [];
  all[chatId].push(message);
  writeJsonAtomic(MESSAGES_FILE, all);
  return all[chatId];
}

// Cache da ultima analise do Coach de Vendas (IA) por lead, pra nao precisar
// chamar a OpenAI de novo toda vez que o vendedor so quer reabrir o card.
function getCoachAnalysis(leadId) {
  const all = readJson(COACH_FILE, {});
  return all[leadId] || null;
}

function setCoachAnalysis(leadId, analysis) {
  const all = readJson(COACH_FILE, {});
  all[leadId] = analysis;
  writeJsonAtomic(COACH_FILE, all);
}

function setLastWebhookDebug(payload) {
  writeJsonAtomic(DEBUG_FILE, {
    receivedAt: new Date().toISOString(),
    payload,
  });
}

function getLastWebhookDebug() {
  return readJson(DEBUG_FILE, null);
}

module.exports = {
  ALLOWED_STAGES,
  getAllLeads,
  getLeadById,
  upsertLeadBySourceId,
  updateLeadStage,
  setLastWebhookDebug,
  getLastWebhookDebug,
  getMessages,
  appendMessage,
  getCoachAnalysis,
  setCoachAnalysis,
};
