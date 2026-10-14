// Rotas internas do Financiamento (ZINIX-MVP-001).
// Montadas em /api/financiamento ATRAS do exigirAuth existente (server.js):
// nao ha segundo sistema de autenticacao. O navegador nunca fala com a Zinix.

const express = require('express');
const { FinancingError } = require('../zinix/financingService');

const TIPOS = { car: 'car', carro: 'car', motorcycle: 'motorcycle', moto: 'motorcycle' };

function createFinancingRouter(service) {
  const router = express.Router();

  // Respostas com dado financeiro nunca devem ficar em cache intermediario.
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const handle = (fn) => async (req, res) => {
    try {
      const out = await fn(req);
      res.status(out && out.__status ? out.__status : 200).json(out && out.__status ? out.body : out);
    } catch (err) {
      const fe = err instanceof FinancingError ? err : new FinancingError(500, 'Não foi possível concluir a operação de financiamento.', { code: 'erro_interno' });
      if (!(err instanceof FinancingError)) console.error('[financiamento] erro inesperado:', err && err.name); // sem mensagem/stack: podem carregar dados
      if (fe.retryAfterMs) res.set('Retry-After', String(Math.ceil(fe.retryAfterMs / 1000)));
      res.status(fe.httpStatus).json({
        error: fe.message,
        code: fe.code,
        ...(fe.fields ? { fields: fe.fields } : {}),
        ...(fe.requestId ? { requestId: fe.requestId } : {}),
        ...(fe.retryAfterMs ? { retryAfterMs: fe.retryAfterMs } : {}),
        ...(fe.simulation ? { simulation: fe.simulation } : {}),
      });
    }
  };

  const tipo = (req) => TIPOS[String(req.query.tipo || '').toLowerCase()];
  const ano = (v) => (/^\d{4}$/.test(String(v || '')) ? Number(v) : NaN);

  router.get('/empresas', handle(() => service.empresas()));
  router.get('/bancos', handle(() => service.bancos()));
  router.get('/billing', handle(() => service.billing()));
  router.get('/veiculos/marcas', handle((req) => service.marcas(tipo(req))));
  router.get('/veiculos/modelos', handle((req) => service.modelos(tipo(req), String(req.query.marca || ''))));
  router.get('/veiculos/versoes', handle((req) => service.versoes(tipo(req), String(req.query.marca || ''), String(req.query.modelo || ''),
    ano(req.query.anoFabricacao), ano(req.query.anoModelo))));

  router.post('/simulacoes', handle(async (req) => ({ __status: 202, body: await service.criarSimulacao(req.usuario, req.body) })));
  router.get('/simulacoes/:id', handle((req) => service.consultarSimulacao(req.usuario, req.params.id)));
  router.get('/oportunidades/:id/simulacoes', handle((req) => service.listarDaOportunidade(req.usuario, req.params.id)));

  return router;
}

// Instancia padrao usada pelo server.js (adapter REST real + arquivo isolado).
function defaultFinancingRouter() {
  const store = require('../store');
  const { createZinixAdapter } = require('../zinix/zinixAdapter');
  const { createFinancingRepository } = require('../zinix/financingRepository');
  const { createFinancingService } = require('../zinix/financingService');
  return createFinancingRouter(createFinancingService({
    adapter: createZinixAdapter(),
    repository: createFinancingRepository(),
    store,
  }));
}

module.exports = { createFinancingRouter, defaultFinancingRouter };
