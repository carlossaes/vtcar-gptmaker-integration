const express = require('express');
const crypto = require('crypto');
const store = require('../store');

const router = express.Router();

// Se CRM_API_KEY estiver definida, exige o header x-api-key em todas as
// rotas deste arquivo. Se estiver vazia/ausente, fica aberto (bom pra
// testar rapido; recomendado preencher quando o CRM for usado por mais gente).
router.use((req, res, next) => {
  const expectedKey = process.env.CRM_API_KEY;
  if (!expectedKey) return next();
  if (req.header('x-api-key') === expectedKey) return next();
  return res.status(401).json({ error: 'x-api-key invalido ou ausente' });
});

// GET /api/leads
router.get('/', (req, res) => {
  const leads = store.getAllLeads().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(leads);
});

// POST /api/leads  { name, phone, email, channel, vehicleInterest }
// Usado pelo botao "Novo Lead" do CRM, pra cadastro manual (fora do fluxo
// automatico do GPT Maker).
router.post('/', (req, res) => {
  const { name, phone, email, channel, vehicleInterest, notes } = req.body || {};
  if (!name) {
    return res.status(400).json({ error: 'Campo "name" e obrigatorio' });
  }
  const sourceId = `manual-${crypto.randomUUID()}`;
  const { lead } = store.upsertLeadBySourceId(sourceId, {
    name,
    phone: phone || null,
    email: email || null,
    channel: channel || 'Outro',
    vehicleInterest: vehicleInterest || null,
    notes: notes || null,
    source: 'manual',
  });
  res.status(201).json(lead);
});

// PATCH /api/leads/:id  { "stage": "qualificado" }
router.patch('/:id', (req, res) => {
  const { stage } = req.body || {};
  if (!stage) {
    return res.status(400).json({ error: 'Campo "stage" e obrigatorio' });
  }
  try {
    const updated = store.updateLeadStage(req.params.id, stage);
    if (!updated) {
      return res.status(404).json({ error: 'Lead nao encontrado' });
    }
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
