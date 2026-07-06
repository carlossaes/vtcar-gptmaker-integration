const express = require('express');
const store = require('../store');

const router = express.Router();

router.use((req, res, next) => {
  const expectedKey = process.env.CRM_API_KEY;
  if (!expectedKey) return next();
  if (req.header('x-api-key') === expectedKey) return next();
  return res.status(401).json({ error: 'x-api-key invalido ou ausente' });
});

// GET /api/debug/last-webhook
// Mostra o ultimo payload bruto recebido do GPT Maker. Use isso pra
// confirmar o formato real do evento e ajustar src/normalizeLead.js.
router.get('/last-webhook', (req, res) => {
  const last = store.getLastWebhookDebug();
  if (!last) {
    return res.json({ message: 'Nenhum webhook recebido ainda' });
  }
  res.json(last);
});

module.exports = router;
