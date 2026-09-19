const LOST_REASONS = ['preco', 'financiamento_nao_aprovado', 'sem_entrada', 'desistiu', 'comprou_concorrente', 'veiculo_indisponivel', 'troca_nao_aprovada', 'sem_retorno', 'contato_invalido', 'outro'];
const TASK_TYPES = ['ligacao', 'whatsapp', 'visita', 'proposta', 'follow_up', 'outro'];
const TASK_PRIORITIES = ['baixa', 'media', 'alta', 'urgente'];
const FOLLOW_UP_FIELDS = ['nextAction', 'nextFollowUpAt', 'firstHumanActionAt', 'lostReason', 'lostAt',
  'taskType', 'taskPriority', 'taskStatus', 'taskCompletedAt'];

function normalizeFollowUp(lead) {
  return { ...lead,
    ...(lead.recordType === 'opportunity' ? {
      taskType: lead.taskType || 'follow_up', taskPriority: lead.taskPriority || 'media',
      taskStatus: lead.taskStatus || 'pendente', taskCompletedAt: lead.taskCompletedAt ?? null,
    } : {}),
    nextAction: lead.nextAction ?? '', nextFollowUpAt: lead.nextFollowUpAt ?? null,
    firstHumanActionAt: lead.firstHumanActionAt ?? null, lostReason: lead.lostReason ?? '', lostAt: lead.lostAt ?? null };
}

// Require an explicit offset: an unqualified local datetime is ambiguous on the server.
function validISO(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return +month >= 1 && +month <= 12 && +day >= 1 && +day <= days && +hour < 24 && +minute < 60 && +(second || 0) < 60
    && (offset === 'Z' || (+offset.slice(1, 3) <= 14 && +offset.slice(4) < 60 && (+offset.slice(1, 3) !== 14 || +offset.slice(4) === 0)));
}

function followUpPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Dados de follow-up inválidos.');
  const patch = {};
  if (Object.hasOwn(body, 'nextAction')) {
    if (body.nextAction !== null && typeof body.nextAction !== 'string') throw new Error('A próxima ação deve ser um texto.');
    patch.nextAction = (body.nextAction || '').trim();
  }
  if (Object.hasOwn(body, 'nextFollowUpAt')) {
    if (body.nextFollowUpAt !== null && !validISO(body.nextFollowUpAt)) throw new Error('Informe uma data/hora válida com fuso horário para o follow-up.');
    patch.nextFollowUpAt = body.nextFollowUpAt === null ? null : new Date(body.nextFollowUpAt).toISOString();
  }
  for (const [field, values, label] of [['taskType', TASK_TYPES, 'Tipo'], ['taskPriority', TASK_PRIORITIES, 'Prioridade']]) {
    if (!Object.hasOwn(body, field)) continue;
    if (!values.includes(body[field])) throw new Error(`${label} de tarefa inválido.`);
    patch[field] = body[field];
  }
  // Only editing an allowed field reopens a task; injected control fields do not.
  if (Object.keys(patch).length) {
    patch.taskStatus = 'pendente';
    patch.taskCompletedAt = null;
  }
  return patch;
}

function lossPatch(current, stage, reason) {
  if (stage === 'perdido') {
    if (!LOST_REASONS.includes(reason)) throw new Error('Selecione um motivo válido para confirmar a perda.');
    return { lostReason: reason, lostAt: new Date().toISOString() };
  }
  return current.stage === 'perdido' ? { lostReason: '', lostAt: null } : {};
}

module.exports = { LOST_REASONS, FOLLOW_UP_FIELDS, normalizeFollowUp, followUpPatch, lossPatch, validISO };
