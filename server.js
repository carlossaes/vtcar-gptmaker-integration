require('dotenv').config();

const express = require('express');
const cors = require('cors');

const webhooksRouter = require('./src/routes/webhooks');
const leadsRouter = require('./src/routes/leads');
const debugRouter = require('./src/routes/debug');
const gptmakerRouter = require('./src/routes/gptmaker');
const authRouter = require('./src/routes/auth');
const usuariosRouter = require('./src/routes/usuarios');
const { defaultFinancingRouter } = require('./src/routes/financiamento');
const { exigirAuth } = require('./src/auth/middleware');
const { protegerDadosPessoais } = require('./src/publicLead');

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
// ZINIX-MVP-002B: TODA resposta JSON passa pela visão pública (CPF nunca sai inteiro).
app.use(protegerDadosPessoais);

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vtcar-gptmaker-integration' });
});

// Webhooks continuam abertos: quem chama e o GPT Maker, que nao faz login.
// A protecao deles e a chave secreta na URL (WEBHOOK_SECRET).
app.use('/webhooks', webhooksRouter);

app.use('/api/auth', authRouter);
app.use('/api/usuarios', usuariosRouter);

// Daqui pra baixo, so com login.
app.use('/api/leads', exigirAuth, leadsRouter);
app.use('/api/debug', exigirAuth, debugRouter);
app.use('/api/gptmaker', exigirAuth, gptmakerRouter);
app.use('/api/financiamento', exigirAuth, defaultFinancingRouter());

app.use((req, res) => {
  res.status(404).json({ error: 'Rota nao encontrada' });
});

// eslint-disable-next-line no-unused-vars
// ZINIX-MVP-002B: nunca logar o objeto de erro inteiro. O erro de JSON
// malformado do express.json traz o corpo bruto em err.body (pode conter CPF).
app.use((err, req, res, next) => {
  console.error('[server] Erro nao tratado:', (err && (err.type || err.name)) || 'erro');
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição muito grande' });
  res.status(500).json({ error: 'Erro interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`vtcar-gptmaker-integration rodando na porta ${PORT}`);
});
