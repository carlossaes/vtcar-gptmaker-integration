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
const { normalizeOpportunity, commercialPatch } = require('./opportunity');
const { leadDataPatch } = require('./leadData');

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

// `recordType` so existe fisicamente no JSON a partir da Entrega 003. Pra
// nao perder os 500+ registros ja assumidos antes desse campo existir (e
// SEM rodar migracao nenhuma no disco), o efetivo e calculado na leitura:
//
//   - se o campo existe fisicamente, o valor gravado manda;
//   - se nao existe, quem decide e ownerId: registro ja possuido vira
//     "opportunity" (e assim continua aparecendo no Pipeline de quem e
//     dono), registro sem dono vira "lead".
//
// Normalizado aqui, num unico lugar, pra todo mundo que ler
// getAllLeads()/getLeadById() ja receber o campo preenchido.
function getAllLeads() {
  return readJson(LEADS_FILE, []).map((l) => normalizeOpportunity({
    ...l,
    recordType: l.recordType || (l.ownerId ? 'opportunity' : 'lead'),
    contactNotes: l.contactNotes ?? '',
  }));
}

function updateOpportunity(id, fields) {
  // Read raw records so editing one opportunity does not migrate other records.
  const leads = readJson(LEADS_FILE, []);
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return null;
  const current = getLeadById(id);
  if (current.recordType !== 'opportunity') throw new Error('Registro não é uma oportunidade');
  const patch = commercialPatch(fields, current);
  // Interesse inicial é cadastral após a conversão (Entrega 005).
  delete patch.vehicleInterest;
  leads[index] = { ...leads[index], ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(LEADS_FILE, leads);
  return getLeadById(id);
}

function getLeadById(id) {
  return getAllLeads().find((lead) => lead.id === id) || null;
}

function updateLeadData(id, fields) {
  const leads = readJson(LEADS_FILE, []);
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return null;
  const current = leads[index];
  if ((current.recordType || (current.ownerId ? 'opportunity' : 'lead')) !== 'lead') {
    const err = new Error('Oportunidade não permite edição cadastral');
    err.status = 409; throw err;
  }
  const patch = leadDataPatch(fields, current);
  if (Object.hasOwn(patch, 'phone')) {
    patch.phone = normalizarTelefone(patch.phone);
    if (!patch.phone) throw new Error('Telefone inválido');
    if (leads.some((lead) => lead.id !== id && normalizarTelefone(lead.phone) === patch.phone)) {
      const err = new Error('Já existe um registro com este telefone.');
      err.status = 409; throw err;
    }
  }
  leads[index] = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(LEADS_FILE, leads);
  return getLeadById(id);
}

// Um lead "sem responsavel" e todo aquele com ownerId vazio -- inclusive os
// leads antigos, gravados antes desta entrega, que nunca tiveram o campo
// fisicamente no JSON. Nao fazemos migracao nenhuma: !lead.ownerId ja cobre
// null, undefined e string vazia da mesma forma.
function semResponsavel(lead) {
  return !lead.ownerId;
}

// Quem pode ver o lead: gerente ve tudo; vendedor ve o que e dele e o que
// ainda nao tem responsavel.
function podeVerLead(lead, usuario) {
  if (!usuario) return false;
  if (usuario.papel === 'gerente') return true;
  return semResponsavel(lead) || lead.ownerId === usuario.id;
}

// Cria ou atualiza um lead a partir de um identificador de origem estavel
// (o id do contato no GPT Maker, ou o telefone se o contato nao tiver id).
// Em criacoes novas aplica os campos default (estagio "novo" etc.), em
// atualizacoes so faz merge dos campos novos sem sobrescrever o estagio
// que o vendedor ja tiver movido manualmente no CRM.
function upsertLeadBySourceId(sourceId, fields) {
  const leads = readJson(LEADS_FILE, []);
  const now = new Date().toISOString();
  const existingIndex = leads.findIndex((lead) => lead.sourceId === sourceId);

  if (existingIndex === -1) {
    const newLead = {
      id: crypto.randomUUID(),
      sourceId,
      stage: 'novo',
      source: 'gptmaker',
      // "lead" e o padrao -- quem cria manualmente uma oportunidade
      // (routes/leads.js) sobrescreve os dois campos abaixo explicitamente.
      recordType: 'lead',
      origin: 'WhatsApp',
      createdAt: now,
      updatedAt: now,
      // O responsavel comercial nunca vem do atendente (GPT Maker) nem do
      // cadastro manual -- fica em aberto ate um vendedor assumir ou um
      // gerente atribuir. (Oportunidades manuais sao a excecao: sempre
      // nascem com dono, tambem definido explicitamente por quem chama.)
      ownerId: null,
      ownerName: null,
      ownerAssignedAt: null,
      ownerAssignedBy: null,
      ownershipHistory: [],
      ...fields,
    };
    leads.unshift(newLead);
    writeJsonAtomic(LEADS_FILE, leads);
    return { lead: getLeadById(newLead.id), created: true };
  }

  const current = leads[existingIndex];
  // O CRM controla identidade, carteira e pipeline. O upsert de entrada não
  // pode apagar esses campos nem atribuí-los em registros legados sem campo.
  const crmFields = new Set(['id', 'sourceId', 'ownerId', 'ownerName',
    'ownerAssignedAt', 'ownerAssignedBy', 'ownershipHistory', 'recordType', 'stage']);
  const isOpportunity = (current.recordType || (current.ownerId ? 'opportunity' : 'lead')) === 'opportunity';
  // Após conversão, somente vínculo de conversa e origem podem vir da integração.
  const conversationFields = new Set(['channel', 'origin', 'gptmakerContactId', 'gptmakerChatId']);
  // Ausência no GPT Maker não é pedido de limpeza. false e 0 são úteis.
  // Texto útil substitui o anterior; limpeza explícita continua na API comercial.
  const incoming = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
    !crmFields.has(key) && (!isOpportunity || conversationFields.has(key)) && value !== null && value !== undefined &&
    !(typeof value === 'string' && value.trim() === '')
  ));
  const updated = {
    ...current,
    ...incoming,
    stage: current.stage, // preserva o estagio do funil ja definido no CRM
    updatedAt: now,
  };
  leads[existingIndex] = updated;
  writeJsonAtomic(LEADS_FILE, leads);
  return { lead: getLeadById(updated.id), created: false };
}

function updateLeadStage(id, stage) {
  if (!ALLOWED_STAGES.includes(stage)) {
    throw new Error(`Estagio invalido: ${stage}`);
  }
  const leads = readJson(LEADS_FILE, []);
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return null;

  leads[index] = {
    ...leads[index],
    stage,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(LEADS_FILE, leads);
  return getLeadById(id);
}

// Um vendedor assume, para si mesmo, um lead que ainda nao tem responsavel.
// Recusa se ja houver dono -- nao importa se e o proprio "usuario" repetindo
// a chamada ou outro vendedor: o caminho pra reatribuir e o gerente.
//
// Desde o ajuste de regra de 15/09/2026: assumir NAO e so atribuir dono --
// e CONVERTER o registro de lead pra oportunidade. A partir daqui ele sai
// da caixa de entrada (Leads) e entra na carteira do vendedor (Pipeline).
// O estagio so e forcado pra "novo" se o que estiver la nao for um estagio
// valido -- na pratica isso nunca deveria acontecer (upsert sempre grava um
// estagio valido), mas e a regra pedida pra registro antigo/estranho.
function assumirLead(id, usuario) {
  const leads = readJson(LEADS_FILE, []);
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return { erro: 'nao-encontrado' };

  const atual = leads[index];
  if (!semResponsavel(atual)) return { erro: 'ja-tem-responsavel', lead: atual };

  const now = new Date().toISOString();
  const historico = Array.isArray(atual.ownershipHistory) ? atual.ownershipHistory : [];
  const atualizado = {
    ...atual,
    recordType: 'opportunity',
    stage: ALLOWED_STAGES.includes(atual.stage) ? atual.stage : 'novo',
    ownerId: usuario.id,
    ownerName: usuario.nome,
    ownerAssignedAt: now,
    ownerAssignedBy: usuario.id,
    ownershipHistory: [
      ...historico,
      {
        action: 'assigned',
        fromUserId: null,
        fromUserName: null,
        toUserId: usuario.id,
        toUserName: usuario.nome,
        byUserId: usuario.id,
        byUserName: usuario.nome,
        at: now,
      },
    ],
    updatedAt: now,
  };
  leads[index] = atualizado;
  writeJsonAtomic(LEADS_FILE, leads);
  return { lead: getLeadById(id) };
}

// So o gerente chama isso: atribuir (lead sem dono), transferir (lead com
// dono indo pra outro vendedor) ou remover (volta pra fila sem responsavel).
// `novoDono` e { id, nome } ou null pra remover. `ator` e o gerente logado.
// Desde o ajuste de regra de 15/09/2026, esta funcao tambem decide
// recordType -- nao so ownerId. Invariante que ela garante sempre: uma
// "opportunity" tem dono; quem nao tem dono e "lead".
//
//   - Atribuir (de sem dono pra com dono): vira opportunity. Estagio so e
//     forcado pra "novo" se o que estiver la nao for valido.
//   - Transferir (de um vendedor pra outro): continua opportunity, estagio
//     NAO muda -- a negociacao segue de onde estava.
//   - Remover (de com dono pra sem dono): a negociacao volta pra fila de
//     triagem -- vira lead e o estagio reseta pra "novo", sempre.
function definirResponsavel(id, novoDono, ator) {
  const leads = readJson(LEADS_FILE, []);
  const index = leads.findIndex((lead) => lead.id === id);
  if (index === -1) return { erro: 'nao-encontrado' };

  const atual = leads[index];
  const now = new Date().toISOString();
  const historico = Array.isArray(atual.ownershipHistory) ? atual.ownershipHistory : [];
  const de = { id: atual.ownerId || null, nome: atual.ownerName || null };
  const action = !de.id ? 'assigned' : !novoDono ? 'unassigned' : 'transferred';

  let stage;
  if (!novoDono) {
    stage = 'novo';
  } else if (!de.id) {
    stage = ALLOWED_STAGES.includes(atual.stage) ? atual.stage : 'novo';
  } else {
    stage = atual.stage;
  }

  const atualizado = {
    ...atual,
    recordType: novoDono ? 'opportunity' : 'lead',
    stage,
    ownerId: novoDono ? novoDono.id : null,
    ownerName: novoDono ? novoDono.nome : null,
    ownerAssignedAt: novoDono ? now : null,
    ownerAssignedBy: novoDono ? ator.id : null,
    ownershipHistory: [
      ...historico,
      {
        action,
        fromUserId: de.id,
        fromUserName: de.nome,
        toUserId: novoDono ? novoDono.id : null,
        toUserName: novoDono ? novoDono.nome : null,
        byUserId: ator.id,
        byUserName: ator.nome,
        at: now,
      },
    ],
    updatedAt: now,
  };
  leads[index] = atualizado;
  writeJsonAtomic(LEADS_FILE, leads);
  return { lead: getLeadById(id) };
}

// Digitos apenas, sem o DDI (55) quando presente -- pra "11999999999" e
// "5511999999999" contarem como o mesmo numero na checagem de duplicidade.
function normalizarTelefone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) {
    const semDDI = d.slice(2);
    if (semDDI.length === 10 || semDDI.length === 11) return semDDI;
  }
  return d;
}

// Usado antes de criar uma oportunidade manual: existe lead ou oportunidade
// com esse telefone? Compara em todos os registros, sem distincao de
// recordType -- duplicidade e por pessoa, nao por tipo de registro.
function acharPorTelefoneNormalizado(telefoneNormalizado) {
  if (!telefoneNormalizado) return null;
  return getAllLeads().find((l) => normalizarTelefone(l.phone) === telefoneNormalizado) || null;
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
  updateLeadData,
  updateOpportunity,
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
  semResponsavel,
  podeVerLead,
  assumirLead,
  definirResponsavel,
  normalizarTelefone,
  acharPorTelefoneNormalizado,
};
