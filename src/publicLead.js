// ZINIX-MVP-002B — visão pública ÚNICA de lead/oportunidade.
//
// Regra principal: nenhuma resposta da API devolve `customerDocument` (CPF
// completo). O CPF inteiro só é lido dentro do backend, pelo
// store.getFinancingCustomer(), no momento da simulação Zinix.
//
// Visibilidade dos demais dados pessoais do cliente (nascimento, sexo, UF,
// cidade, CNH e o CPF mascarado):
//   - gerente: vê (CPF sempre mascarado);
//   - vendedor responsável pela oportunidade: vê (CPF sempre mascarado);
//   - qualquer outro (vendedor comum vendo oportunidade SEM responsável, ou
//     chamada sem usuário, como webhooks): NÃO vê — os campos são omitidos e
//     a resposta traz `customerDataRestricted: true`.
// Vendedor alheio já nem recebe a oportunidade (ownership atual, intacto).
//
// Aplicada em um só lugar: o middleware `protegerDadosPessoais` embrulha
// res.json e sanitiza QUALQUER corpo de resposta (lista, objeto, aninhado).
// Assim nenhuma rota precisa lembrar de chamar a função.
const { publicFinancingFields } = require('./opportunity');

// Campos pessoais como chegam ao frontend (CPF já mascarado por publicFinancingFields).
const PERSONAL_PUBLIC_FIELDS = ['customerDocumentMasked', 'customerBirthDate', 'customerGender', 'customerState', 'customerCity', 'customerHasDriverLicense'];
const PROFUNDIDADE_MAX = 8;

function podeVerDadosPessoais(record, principal) {
  if (!principal) return false;
  if (principal.papel === 'gerente') return true;
  return principal.papel === 'vendedor' && !!record.ownerId && record.ownerId === principal.id;
}

// Um objeto com cara de lead/oportunidade (o registro de leads.json).
function pareceLead(obj) {
  return typeof obj.id === 'string' && ('recordType' in obj || 'sourceId' in obj || 'ownerId' in obj || 'customerDocument' in obj);
}

function publicLeadView(record, principal) {
  if (!record || typeof record !== 'object') return record;
  const base = publicFinancingFields(record); // remove customerDocument e mascara
  const out = base === record ? { ...record } : base;
  delete out.customerDocument; // defesa extra, mesmo se a função acima mudar
  if (!podeVerDadosPessoais(out, principal)) {
    let tinha = false;
    for (const k of PERSONAL_PUBLIC_FIELDS) if (k in out) { tinha = true; delete out[k]; }
    if (tinha) out.customerDataRestricted = true;
  }
  return out;
}

// Percorre o corpo da resposta: todo lead vira visão pública e nenhuma chave
// `customerDocument` sobrevive em nível nenhum.
function sanitizarResposta(body, principal, nivel = 0) {
  if (body === null || typeof body !== 'object' || nivel > PROFUNDIDADE_MAX) return body;
  if (Array.isArray(body)) return body.map((x) => sanitizarResposta(x, principal, nivel + 1));
  if (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null) return body; // Date etc.
  const obj = pareceLead(body) ? publicLeadView(body, principal) : body;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'customerDocument') continue;
    out[k] = sanitizarResposta(v, principal, nivel + 1);
  }
  return out;
}

// Middleware: instalado no servidor (todas as rotas) e nos routers que
// devolvem leads (idempotente se aplicado duas vezes).
function protegerDadosPessoais(req, res, next) {
  if (!res.__dadosPessoaisProtegidos) {
    const json = res.json.bind(res);
    res.json = (body) => json(sanitizarResposta(body, req.usuario || null));
    res.__dadosPessoaisProtegidos = true;
  }
  next();
}

module.exports = { publicLeadView, sanitizarResposta, protegerDadosPessoais, podeVerDadosPessoais, PERSONAL_PUBLIC_FIELDS };
