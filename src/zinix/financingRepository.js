// Persistencia das simulacoes de financiamento (Zinix).
//
// Arquivo NOVO e ISOLADO: data/zinix-simulations.json. Nenhum JSON existente
// do CRM (leads, messages, usuarios, coach, convites) e lido ou escrito aqui.
// Em producao, data/ e o volume persistente do Railway (/app/data).
//
// O arquivo so e criado na primeira gravacao: enquanto ninguem simular nada,
// o volume continua exatamente como esta.
//
// Gravacao atomica (temporario + rename), no mesmo padrao do store.js.
//
// Interface pequena e estavel (create/update/getById/listByOpportunity/
// findRecent) pra permitir trocar JSON por PostgreSQL depois sem mexer no
// FinancingService.

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE_NAME = 'zinix-simulations.json';

function createFinancingRepository(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const file = path.join(dataDir, FILE_NAME);

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      // Arquivo corrompido: NAO sobrescrever silenciosamente (perderia historico).
      const e = new Error('Armazenamento de simulações ilegível.');
      e.code = 'repository_unreadable';
      throw e;
    }
  }

  function writeAll(list) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    file,
    create(record) {
      const list = readAll();
      list.push(record);
      writeAll(list);
      return record;
    },
    update(id, patch) {
      const list = readAll();
      const i = list.findIndex((r) => r.id === id);
      if (i === -1) return null;
      list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
      writeAll(list);
      return list[i];
    },
    getById(id) {
      return readAll().find((r) => r.id === id) || null;
    },
    listByOpportunity(opportunityId) {
      return readAll()
        .filter((r) => r.opportunityId === opportunityId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
  };
}

module.exports = { createFinancingRepository, FILE_NAME };
