// Cliente fino pra API da OpenAI, usado pelo "Coach de Vendas": resume a
// conversa, estima a intencao de compra e sugere a proxima mensagem usando
// tecnicas de vendas consultivas reconhecidas (SPIN Selling, Challenger
// Sale, negociacao no estilo Chris Voss). A IA so sugere -- quem manda a
// mensagem pro cliente e sempre o vendedor, revisando antes.

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `Voce e um coach de vendas especializado em concessionarias de veiculos, atendendo clientes por WhatsApp.

Analise a conversa entre um cliente e a equipe de vendas (que pode ser a assistente virtual Vitoria ou um vendedor humano) e responda SOMENTE com um JSON valido, sem nenhum texto fora do JSON, no formato exato abaixo:

{
  "summary": "resumo objetivo em 2-3 frases do que ja foi conversado",
  "intentLevel": "frio" | "morno" | "quente",
  "intentScore": numero de 0 a 100,
  "objections": ["lista curta das objecoes ou preocupacoes que o cliente demonstrou; pode ser uma lista vazia"],
  "suggestedMessage": "uma mensagem pronta, em portugues do Brasil, que o vendedor pode revisar e mandar pro cliente",
  "technique": "nome curto da tecnica usada na mensagem sugerida, ex: 'SPIN - pergunta de implicacao', 'Challenger - insight de mercado', 'Mirroring (Chris Voss)'"
}

Como avaliar a intencao de compra em texto (sem linguagem corporal, so o que foi escrito):
- Sinais de interesse alto: perguntar sobre financiamento, entrada, parcelas, prazo de entrega, agendar test drive, mencionar troca do carro atual, respostas rapidas e diretas.
- Sinais de interesse baixo: respostas vagas, demora grande entre mensagens, "so estou pesquisando", sumico apos receber preco.

Como escolher a tecnica da mensagem sugerida:
- Fase de descoberta (pouca informacao sobre a necessidade do cliente): use perguntas no estilo SPIN Selling (Situacao, Problema, Implicacao, Necessidade de solucao).
- Cliente comparando opcoes ou indeciso: use uma abordagem Challenger, trazendo um insight ou dado que o cliente talvez nao tenha considerado.
- Cliente com objecao clara (preco, prazo, duvida): use tecnicas de negociacao ao estilo Chris Voss, como mirroring (repetir a ultima palavra-chave da objecao para o cliente elaborar) ou nomear a emocao ("parece que o prazo esta pesando pra voce").

Regras importantes:
- Nunca invente informacoes que o cliente nao mencionou.
- A mensagem sugerida deve ser consultiva, honesta e respeitosa -- nunca manipuladora, nunca pressao agressiva, nunca promessa que nao pode ser cumprida.
- Se a conversa for muito curta pra avaliar direito, diga isso no summary e ainda assim de o melhor palpite possivel pros outros campos.`;

async function generateCoachAnalysis(transcriptText, leadContext) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY nao configurado nas variaveis de ambiente');
  }

  const userContent = `Dados do lead: ${JSON.stringify(leadContext)}

Conversa (da mensagem mais antiga pra mais recente):
${transcriptText}`;

  const res = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Erro da OpenAI (${res.status}): ${text}`);
  }

  const json = await res.json();
  const raw = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!raw) {
    throw new Error('Resposta vazia da OpenAI');
  }

  return JSON.parse(raw);
}

module.exports = { generateCoachAnalysis };
