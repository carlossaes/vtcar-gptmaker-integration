# VT Car - Integracao GPT Maker -> CRM

Backend pequeno que recebe leads do GPT Maker (WhatsApp da Vitoria) em tempo
real via webhook e expoe eles pro CRM (`crm-vtcar.html`) consumir.

## Como funciona

1. Um cliente manda a primeira mensagem no WhatsApp da Vitoria.
2. O GPT Maker dispara o webhook `onFirstInteraction` pra este backend.
3. O backend guarda o lead (nome, telefone, email, canal) com estagio "novo".
4. O CRM busca `GET /api/leads` e mostra os leads na aba Leads.

Estagios do funil (Novo, Qualificado, Proposta, Negociacao, Fechado) sao
sempre geridos manualmente no CRM - o GPT Maker nao tem esse conceito.

## Rodando local

```bash
npm install
cp .env.example .env
# edite o .env com o token, os IDs e uma senha pro WEBHOOK_SECRET
npm start
```

Servidor sobe em `http://localhost:3000`. Teste com `curl http://localhost:3000/health`.

## Deploy no Render

1. Suba esta pasta (`gptmaker-integration/`) num repositorio Git (GitHub, por exemplo).
2. No Render: **New > Web Service**, conecte o repositorio.
3. Configuracoes do servico:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Runtime: Node
4. Em **Environment**, adicione as variaveis (mesmos nomes do `.env.example`):
   - `GPTMAKER_TOKEN`
   - `GPTMAKER_WORKSPACE_ID` = `3F4011E7588090B99974DA7287C56AD2`
   - `GPTMAKER_AGENT_ID` = `3F40156AC46CC07F90E566CB6A944837`
   - `WEBHOOK_SECRET` = escolha uma senha aleatoria
   - `CRM_API_KEY` = opcional, deixe vazio por enquanto
5. Deploy. Anote a URL publica que o Render vai gerar (algo como
   `https://vtcar-gptmaker-integration.onrender.com`).

> Aviso: no plano free do Render o disco local do servico nao e garantido
> como persistente entre deploys. Os leads ficam guardados num arquivo JSON
> (`data/leads.json`) - bom pra validar tudo funcionando, mas se for usar
> por muito tempo em producao, migrar pra um banco de verdade (Postgres,
> por exemplo) evita perder dados num redeploy.

## Registrando o webhook no GPT Maker

Depois que o deploy estiver no ar, rode uma vez (local, na sua maquina):

```bash
GPTMAKER_TOKEN=seu_token \
GPTMAKER_AGENT_ID=3F40156AC46CC07F90E566CB6A944837 \
WEBHOOK_SECRET=a_mesma_senha_que_voce_colocou_no_Render \
BACKEND_URL=https://vtcar-gptmaker-integration.onrender.com \
node scripts/register-webhook.js
```

Isso chama a API do GPT Maker e configura o webhook `onFirstInteraction`
apontando pro seu backend.

## Validando o primeiro lead real

O formato exato do payload que o GPT Maker envia no webhook nao e
documentado publicamente. Depois de mandar uma mensagem de teste pro
WhatsApp da Vitoria (de outro numero), confira:

```
GET https://SEU-BACKEND.onrender.com/api/debug/last-webhook
```

Isso mostra o corpo bruto recebido. Se o lead nao aparecer certo em
`GET /api/leads`, o ajuste fica todo concentrado em
`src/normalizeLead.js` - so precisa alinhar os nomes dos campos com o que
realmente chegou.

## Endpoints

| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/health` | Checagem simples de que o servico esta de pe |
| POST | `/webhooks/gptmaker?key=...` | Recebido do GPT Maker a cada novo contato |
| GET | `/api/leads` | Lista todos os leads (usado pelo CRM) |
| PATCH | `/api/leads/:id` | Atualiza o estagio do funil de um lead |
| GET | `/api/debug/last-webhook` | Ultimo payload bruto recebido, pra depuracao |
