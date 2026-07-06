// Rode isso UMA VEZ, depois que o backend estiver no ar no Render, pra
// avisar o GPT Maker onde mandar o evento "onFirstInteraction".
//
// Uso:
//   GPTMAKER_TOKEN=... GPTMAKER_AGENT_ID=... WEBHOOK_SECRET=... BACKEND_URL=https://seu-servico.onrender.com node scripts/register-webhook.js
//
// Ou, se voce tiver um arquivo .env preenchido na raiz do projeto, so rode:
//   npm run register-webhook

require('dotenv').config();

async function main() {
  const token = process.env.GPTMAKER_TOKEN;
  const agentId = process.env.GPTMAKER_AGENT_ID;
  const backendUrl = process.env.BACKEND_URL;
  const secret = process.env.WEBHOOK_SECRET || '';

  if (!token || !agentId || !backendUrl) {
    console.error('Faltam variaveis: GPTMAKER_TOKEN, GPTMAKER_AGENT_ID e BACKEND_URL sao obrigatorias.');
    process.exit(1);
  }

  const webhookUrl = `${backendUrl.replace(/\/$/, '')}/webhooks/gptmaker${secret ? `?key=${encodeURIComponent(secret)}` : ''}`;

  console.log(`Registrando webhook onFirstInteraction -> ${webhookUrl}`);

  const res = await fetch(`https://api.gptmaker.ai/v2/agent/${agentId}/webhooks`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ onFirstInteraction: webhookUrl }),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(`Falha (${res.status}):`, json);
    process.exit(1);
  }

  console.log('Webhook registrado com sucesso:', json);
}

main().catch((err) => {
  console.error('Erro ao registrar webhook:', err);
  process.exit(1);
});
