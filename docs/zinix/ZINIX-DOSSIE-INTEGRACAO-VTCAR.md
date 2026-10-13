# ZINIX — Dossiê de Integração com o VT Car CRM

**Status:** documento vivo de arquitetura, produto, segurança, LGPD e implementação  
**Data da consolidação:** 13/10/2026  
**Responsável técnico:** CTO / ChatGPT  
**Projeto:** VT Car CRM  
**Fornecedor:** Zinix / Beroli Tecnologia LTDA  
**Objetivo:** concentrar em um único documento tudo o que precisa ser conhecido e respeitado na integração do VT Car CRM com a API de financiamento da Zinix.

---

## 1. Fontes oficiais registradas

### Site e documentação pública

- Site principal: https://zinix.com.br/
- Guia da API: https://zinix.com.br/api/
- Swagger / contrato OpenAPI: https://zinix.com.br/api/swagger/
- SDK: https://zinix.com.br/api/#sdk
- SDK GitHub: https://github.com/pablorigueto/zinix-api-sdk
- Exemplos do SDK: https://github.com/pablorigueto/zinix-api-sdk/tree/main/examples
- Política de Privacidade: https://www.zinix.com.br/politica-de-privacidade/
- LGPD: https://zinix.com.br/lgpd/
- Termos de Uso: https://www.zinix.com.br/termos-de-uso/

### Painel autenticado Zinix

- Configuração da API / chave:
  https://app.zinix.com.br/configuracoes/api
- Configurações bancárias:
  https://app.zinix.com.br/configuracoes/bancarios

**Observação:** o conteúdo das telas autenticadas depende da conta do cliente e não deve ser copiado para documentação com credenciais. Nunca registrar token, senha ou chave de API neste repositório.

---

## 2. O que é a Zinix

A Zinix é uma plataforma SaaS para o mercado automotivo, com três frentes principais:

1. simulador de financiamento multibanco;
2. CRM automotivo;
3. API white label de financiamento para integração com SaaS, CRM, ERP e plataformas.

A empresa se apresenta como intermediária tecnológica entre lojistas e instituições financeiras. A aprovação, taxa e condição de crédito são definidas pelas instituições financeiras, não pela Zinix.

A API é white label: o VT Car CRM mantém sua própria interface e marca, enquanto a Zinix fornece catálogo, processamento e resultados financeiros.

---

## 3. Escopo da integração no VT Car CRM

### Objetivo de produto

Adicionar **Financiamento** como recurso nativo da oportunidade comercial do CRM, sem tirar o vendedor do VT Car.

A Zinix será tratada como **motor financeiro externo**.

O VT Car continuará sendo responsável por:

- autenticação do usuário;
- permissões;
- interface;
- vínculo com lead/oportunidade;
- histórico comercial;
- auditoria;
- consentimento/ciência;
- persistência da intenção e resultado;
- proteção LGPD;
- decisão humana sobre qual condição usar na negociação.

### Arquitetura alvo

```text
VENDEDOR
   ↓
VT CAR CRM — Frontend
   ↓
VT CAR Backend
   ↓
FinancingService
   ↓
ZinixAdapter
   ↓
@zinix/sdk
   ↓
API Zinix
   ↓
Bancos habilitados
```

### Regra arquitetural obrigatória

**Nunca:**

```text
Frontend → Zinix
```

**Sempre:**

```text
Frontend → backend VT Car → Zinix
```

A chave da API nunca pode ser exposta no navegador.

---

## 4. URL base e autenticação

URL oficial:

```text
https://saas.zinix.com.br/v1
```

Autenticação:

```http
Authorization: Bearer <API_KEY>
```

Variável esperada no backend do VT Car:

```text
ZINIX_API_KEY
```

### Regras

- chave somente no backend;
- nunca usar `VITE_ZINIX_API_KEY`;
- nunca usar `NEXT_PUBLIC_ZINIX_API_KEY`;
- HTTPS em produção;
- variável de ambiente/cofre;
- nunca registrar chave em logs;
- nunca registrar CPF ou payload completo em logs;
- revogar imediatamente uma chave exposta.

Todas as chaves são de produção. A documentação informa que não existe uma credencial adicional de homologação.

---

## 5. Endpoints públicos relevantes

### Empresa e bancos

```text
GET /legal-entities
GET /legal-entities/{id}/banks
```

Uso:

- listar CNPJs disponíveis para a chave;
- selecionar `legal_entity_id`;
- consultar bancos habilitados dinamicamente;
- nunca hardcodar bancos.

A API não entrega ao integrador as credenciais bancárias configuradas pela loja.

### Catálogo de veículos

```text
GET /vehicles/brands
GET /vehicles/models
GET /vehicles/versions
```

Fluxo:

```text
Marca → Modelo → Anos → Versão
```

Os códigos devem vir do catálogo Zinix.

Persistir sempre:

- brand_code;
- brand_name;
- model_code;
- model_name;
- version_code;
- version_name.

Não inventar códigos.

### Simulação

```text
POST /simulations
GET /simulations/{id}
```

### Uso e cobrança

```text
GET /billing
GET /usage
```

---

## 6. Dados obrigatórios da simulação

O request possui:

1. `legal_entity_id`;
2. `applicant`;
3. `vehicle`;
4. `terms`.

### Applicant

```text
document
gender
name
birth_date
email
phone
state
city
has_driver_license
```

Regras documentadas:

- CPF: 11 dígitos válidos;
- gender: male | female;
- birth_date: YYYY-MM-DD;
- idade: 18 a 100 anos;
- phone: 10 a 13 dígitos;
- state: UF com duas letras maiúsculas;
- has_driver_license: boolean.

### Vehicle

```text
type
brand_code
brand_name
model_code
model_name
version_code
version_name
manufacture_year
model_year
zero_km
```

Valores de `type`:

```text
car
motorcycle
```

`model_year` deve ser igual ou posterior ao ano de fabricação.

### Terms

```text
asset_value_cents
down_payment_cents
installments[]
```

Regras:

- valores monetários em centavos inteiros;
- entrada menor que valor do bem;
- 1 a 12 opções de prazo;
- cada prazo entre 1 e 84 parcelas.

---

## 7. Idempotência — regra crítica

Toda nova intenção de simulação deve receber uma chave de idempotência.

Sequência obrigatória:

```text
Gerar chave
   ↓
Persistir no VT Car
   ↓
POST /simulations
```

Se houver timeout ou falha de rede:

```text
MESMO PAYLOAD
+
MESMA IDEMPOTENCY-KEY
```

Nunca gerar uma nova chave para recuperar a mesma intenção.

O SDK valida a chave com 8 a 128 caracteres permitidos.

Reutilizar a mesma chave com payload diferente produz HTTP 409.

### O que persistir antes/depois do POST

Antes:

- opportunityId;
- usuário responsável;
- idempotencyKey;
- payload hash / versão da intenção;
- data/hora.

Após resposta aceita:

- simulation id;
- request_id;
- status;
- billing_charge;
- timestamps.

---

## 8. Processamento assíncrono

`POST /simulations` retorna HTTP 202.

Isso significa:

**aceito e enfileirado**, não finalizado.

A resposta pode incluir:

- id;
- status;
- status_url;
- retry_after_ms;
- request_id;
- idempotent_replay;
- billing;
- billing_charge.

### Polling

Regra oficial:

- primeiro GET após 20 segundos;
- respeitar Retry-After;
- janela padrão máxima: 3 minutos;
- no fluxo público, até 9 consultas em 20, 40, 60... 180 segundos;
- não manter uma requisição do navegador aberta por 3 minutos.

### Arquitetura recomendada no VT Car

```text
Frontend → POST VT Car
             ↓
        Backend cria operação
             ↓
        POST Zinix
             ↓
     retorna UUID rapidamente

Frontend → GET VT Car /financiamentos/:id
             ↓
        Backend consulta Zinix
```

O vendedor pode continuar trabalhando enquanto os bancos processam.

---

## 9. Status da simulação

```text
queued
processing
completed
partial
failed
expired
```

Estados finais:

```text
completed
partial
failed
expired
```

### Interpretação importante

`completed` significa que todos os bancos chegaram a algum estado final.

**Não significa que todos aprovaram.**

`partial` pode conter condições válidas de alguns bancos e falhas/pendências de outros.

Progresso:

```text
progress.expected_banks
progress.finished_banks
progress.pending_banks
```

---

## 10. Status dos bancos

O SDK tipa:

```text
queued
pending
processing
completed
rejected
unavailable
failed
timed_out
```

Cada banco pode retornar:

- status;
- conditions[];
- issues[];
- error.

---

## 11. Condições financeiras

Cada condição pode conter:

```text
installments
installment_value_cents
monthly_rate
monthly_rate_estimated
down_payment_cents
financed_amount_cents
condition_id
```

### Regra de produto obrigatória

**Nunca agrupar somente por quantidade de parcelas.**

Duas condições de 48 parcelas podem possuir:

- entradas diferentes;
- valor financiado diferente;
- taxa diferente;
- condition_id diferente.

Preservar o snapshot integral.

### Taxa

`monthly_rate_estimated=true` significa taxa calculada/estimada e não necessariamente informada diretamente pelo banco.

Não apresentar como taxa oficial do banco sem distinção.

---

## 12. Issues e erros bancários

### BankIssue

Pode conter:

```text
code
message
status
installments
down_payment_cents
```

Status tipados:

```text
rejected
failed
unavailable
```

### SimulationError

Pode conter:

```text
code
message
stage
provider_status
retryable
details[]
```

Não transformar erro técnico em “crédito recusado” sem suporte do resultado.

---

## 13. Erros HTTP relevantes

```text
400 — dados/parâmetros inválidos
401 — chave ausente, inválida, expirada ou revogada
402 — sem saldo para CPF novo
403 — acesso suspenso/escopo/CNPJ não autorizado
404 — recurso inexistente ou de outro cliente
409 — mesma idempotency-key com corpo diferente
422 — CNPJ sem bancos ativos ou operação não processável
429 — rate limit; respeitar Retry-After
503 — indisponibilidade temporária
```

### Regra de diagnóstico

Guardar `request_id` para suporte.

Nunca enviar ao suporte:

- senha;
- chave;
- CPF em texto aberto;
- corpo completo desnecessário.

---

## 14. Billing e consumo

### Billing

O SDK expõe informações como:

- mode;
- balance;
- can_submit;
- can_submit_new_cpf;
- current_period;
- monthly_quota;
- monthly_unique_cpfs_used;
- monthly_quota_remaining;
- carried_over_credits;
- timezone.

Modos:

```text
prepaid
unlimited
```

### Regra de cobrança

A documentação pública informa cobrança por **CPF único por competência/mês**, e não por polling.

O mesmo CPF reconsultado no mesmo mês não consome uma nova unidade, segundo a documentação atual.

O consumo é considerado entre chaves e CNPJs do mesmo cliente.

### BillingCharge

Reasons tipados:

```text
new_cpf_this_month
cpf_already_counted
unlimited
idempotent_replay
not_debited
```

Sempre tratar HTTP 402 no POST, mesmo que `GET /billing` tenha retornado saldo imediatamente antes, por risco de concorrência.

### Usage

`GET /usage` permite período de até 366 dias, com detalhamento por:

- dia;
- CNPJ;
- origem;
- consultas;
- CPFs únicos;
- consultas repetidas.

---

## 15. SDK oficial

Repositório:

```text
https://github.com/pablorigueto/zinix-api-sdk
```

Pacote:

```text
@zinix/sdk
```

Versão auditada:

```text
0.1.0
```

Licença:

```text
MIT
```

Runtime:

```text
Node.js >= 22
```

Estado atual:

- TypeScript;
- JavaScript ESM;
- sem dependências de runtime;
- ainda não publicado no npm na versão auditada;
- instalação recomendada via clone + npm pack;
- CI preparada para Node 22 e 24.

### Métodos

```text
legalEntities.list()
legalEntities.banks(legalEntityId)

vehicles.brands()
vehicles.models()
vehicles.versions()

simulations.create()
simulations.get()
simulations.wait()

billing.get()
usage.get()
```

Todos retornam:

```text
{ data, meta }
```

Meta pode conter:

- status;
- requestId;
- retryAfterMs;
- etag;
- rateLimit.

---

## 16. Compatibilidade com o backend VT Car

O backend atual do VT Car é CommonJS.

O SDK é ESM e exporta somente a condição `import`.

Decisão de arquitetura:

```text
Backend VT Car permanece CommonJS
        ↓
src/zinix/zinixAdapter.js
        ↓
await import('@zinix/sdk')
```

Não converter o backend inteiro para ESM somente para a Zinix.

O adapter será o único ponto de acoplamento ao SDK.

---

## 17. Serviços internos propostos

### ZinixAdapter

Responsabilidade:

- carregar SDK;
- autenticar;
- traduzir erros técnicos;
- executar chamadas de baixo nível;
- não conhecer UI.

### FinancingService

Responsabilidade:

- regras de negócio do VT Car;
- autorização;
- CNPJ selecionado;
- idempotência;
- persistência;
- ownership;
- vínculo com opportunity;
- validação;
- histórico;
- atualização de status;
- seleção de condição;
- auditoria.

### Repositório

Criar abstração:

```text
FinancingRepository
```

Mesmo que inicialmente persistido em JSON, a interface deve permitir migração posterior para PostgreSQL sem reescrever a integração.

---

## 18. Modelo de persistência recomendado

Uma oportunidade pode ter várias simulações.

Estrutura lógica mínima:

### financingSimulation

- id interno;
- opportunityId;
- sellerUserId;
- legalEntityId;
- zinixSimulationId;
- requestId;
- idempotencyKey;
- status;
- applicantSnapshot protegido;
- vehicleSnapshot;
- termsSnapshot;
- progress;
- billingCharge;
- createdAt;
- updatedAt;
- completedAt;
- selectedConditionId;
- selectedAt;
- selectedBy.

### financingBankResult

- simulationId;
- bank;
- status;
- conditions[];
- issues[];
- error resumido;
- updatedAt.

### condição selecionada

Persistir snapshot completo:

- bank;
- condition_id;
- installments;
- installment_value_cents;
- down_payment_cents;
- financed_amount_cents;
- monthly_rate;
- monthly_rate_estimated.

Não depender de nova consulta para reconstruir uma negociação já apresentada ao cliente.

---

## 19. UX proposta no VT Car

Dentro da oportunidade:

```text
Dados comerciais
Financiamento
Tarefas
Histórico
```

### Etapa 1 — Cliente

Exibir/preencher os dados obrigatórios.

Evitar duplicar informação que já existe no lead/oportunidade.

### Etapa 2 — Veículo

Selecionar:

```text
tipo
marca
modelo
ano fabricação
ano modelo
versão
```

Usar catálogo Zinix.

### Etapa 3 — Condições desejadas

```text
valor do bem
entrada
prazos
```

### Etapa 4 — Simulação

Botão:

```text
SIMULAR FINANCIAMENTO
```

Antes de enviar:

- confirmação humana;
- validações;
- ciência do tratamento de dados;
- idempotencyKey persistida.

### Etapa 5 — Progresso

Mostrar, por exemplo:

```text
5 de 8 bancos processados
```

Não travar interface.

### Etapa 6 — Resultados

Cards por banco e condição.

Não exibir como “aprovado” quando o contrato não disser isso.

### Etapa 7 — Uso na negociação

Botão:

```text
USAR ESTA CONDIÇÃO
```

Somente após confirmação do vendedor, sugerir atualização de:

- downPayment;
- financingAmount;
- installmentsCount;
- installmentValue;
- paymentComposition.

Não sobrescrever dados comerciais automaticamente.

---

## 20. Performance

### Não manter POST aberto

A criação deve ser curta.

Polling pelo frontend deve consultar o backend VT Car.

### Cache de catálogo

Pode-se aplicar cache curto no backend para:

- marcas;
- modelos;
- versões.

Chave do cache deve incluir:

- legal_entity_id;
- tipo;
- marca;
- modelo;
- anos quando aplicável.

Não cachear resultados financeiros como catálogo.

### Concorrência

Impedir duplo clique/duplicidade de simulação com:

- estado da UI;
- idempotência;
- persistência atômica da intenção.

---

## 21. Segurança

### Segredos

- `ZINIX_API_KEY` apenas no Railway/backend;
- nunca no frontend;
- nunca no Git;
- nunca em screenshots/documentação.

### Logs

Proibido registrar:

- chave;
- CPF completo;
- telefone;
- e-mail;
- payload completo;
- Authorization header.

Pode registrar:

- opportunityId;
- simulationId;
- request_id;
- status;
- banco;
- código de erro;
- timings;
- usuário interno;
- correlation id.

### Autorização

Um UUID de simulação não comprova propriedade.

Toda leitura deve validar:

```text
usuário autenticado
+
permissão
+
ownership da opportunity/simulação
```

### Antiabuso

Se no futuro existir formulário público:

- sessão assinada;
- CSRF/origin;
- CAPTCHA quando aplicável;
- rate limit por IP/sessão;
- limite de body;
- nenhum CNPJ arbitrário vindo do browser.

---

## 22. LGPD

A integração envolve dados pessoais utilizados em processo de financiamento, incluindo:

- CPF;
- nome;
- nascimento;
- gênero;
- e-mail;
- telefone;
- UF;
- cidade;
- informação sobre CNH.

A política pública da Zinix informa tratamento para cadastro, simulação junto a bancos, suporte e obrigações legais, com HTTPS/TLS e acesso restrito.

### Responsabilidade do VT Car

A conformidade do fornecedor não elimina a responsabilidade da VT Car pelo tratamento que ocorre no CRM.

Antes de produção, precisamos documentar:

- finalidade;
- base legal adequada;
- aviso de privacidade;
- compartilhamento com Zinix e bancos;
- retenção;
- acesso;
- correção;
- eliminação quando aplicável;
- atendimento ao titular;
- trilha de auditoria.

### Princípios obrigatórios no produto

- finalidade;
- adequação;
- necessidade/minimização;
- segurança;
- prevenção;
- transparência;
- responsabilização.

### Consentimento

Não assumir automaticamente que todo tratamento deve usar consentimento.

A base legal deve ser definida conforme a finalidade concreta e, quando necessário, validada pelo jurídico/DPO.

---

## 23. Bancos

A home pública da Zinix informa integração com 12+ bancos e exibe nomes como:

- Banco Pan;
- C6 Bank;
- Itaú;
- Bradesco;
- Santander;
- BV;
- Creditas;
- Safra;
- Omni;
- Autobanking;
- Carbank;
- Fontecred;
- Honda.

**Regra de integração:** não assumir que todos estarão disponíveis para a VT Car.

A lista válida para operação vem de:

```text
GET /legal-entities/{id}/banks
```

e da configuração bancária da conta.

---

## 24. Configurações bancárias

Link do fornecedor:

https://app.zinix.com.br/configuracoes/bancarios

Esse painel autenticado deve ser usado pela equipe autorizada da loja/Zinix para configuração bancária.

O VT Car CRM não deve:

- copiar credenciais bancárias;
- receber senha bancária;
- persistir códigos sigilosos da loja;
- tentar configurar bancos por APIs não documentadas.

---

## 25. Painel de API

Link:

https://app.zinix.com.br/configuracoes/api

Usar para:

- visualizar/administrar credencial conforme permissões da conta;
- nunca copiar a chave para documentação;
- nunca enviar chave por chat;
- cadastrar somente no segredo do backend.

---

## 26. Custos públicos observados em 13/10/2026

A documentação pública exibia:

### 200 consultas/mês

```text
R$ 400/mês
R$ 2,00 por CPF
```

### 300 consultas/mês

```text
R$ 450/mês
R$ 1,50 por CPF
```

A documentação informa acúmulo de consultas não utilizadas enquanto a assinatura estiver ativa.

**Importante:** preço é informação comercial mutável. Antes de fechar orçamento ou contrato, confirmar no painel/equipe Zinix.

---

## 27. Observabilidade e auditoria

Registrar internamente:

- usuário que iniciou;
- oportunidade;
- CNPJ;
- simulationId;
- request_id;
- idempotencyKey;
- timestamps;
- progresso;
- banco;
- status;
- condição escolhida;
- ação “usar na negociação”.

Não registrar payload sensível em logs técnicos.

Idealmente separar:

- log de auditoria de negócio;
- log técnico;
- dados pessoais persistidos.

---

## 28. Testes

### Antes de consumir crédito real

Usar mocks.

Testar:

- legalEntities;
- banks;
- catálogo;
- create 202;
- idempotent replay;
- 409;
- 400;
- 401;
- 402;
- 403;
- 404;
- 422;
- 429;
- 503;
- timeout;
- partial;
- failed;
- expired;
- múltiplas condições com mesmo número de parcelas;
- taxa estimada;
- ownership;
- permissão gerente/vendedor;
- logs sem PII;
- retry sem duplicidade.

### Primeira chamada real

Preferir primeiro endpoints de leitura:

```text
GET /legal-entities
GET /legal-entities/{id}/banks
GET /billing
```

Depois catálogo.

Somente depois realizar primeira simulação real controlada.

---

## 29. Plano de implantação

### Fase 0 — proteger produção

Antes de instalar SDK ou mudar runtime:

- confirmar persistência;
- confirmar JWT;
- backup atual;
- contagens;
- rollback.

### Fase 1 — runtime Node 22

- migrar controladamente;
- 89/89 testes atuais;
- health;
- login;
- dados;
- webhook.

### Fase 2 — fundação Zinix

- instalar SDK;
- adapter;
- service;
- env;
- mocks;
- testes;
- nenhuma simulação real.

### Fase 3 — leitura real

- legal entities;
- banks;
- billing;
- usage;
- catálogo.

### Fase 4 — UX

- aba Financiamento;
- formulários;
- validação;
- status/progresso.

### Fase 5 — primeira simulação real

- uma operação controlada;
- acompanhar cobrança;
- conferir resultado;
- auditar logs.

### Fase 6 — condições na negociação

- comparação;
- seleção;
- atualização comercial confirmada.

### Fase 7 — gestão

- histórico;
- relatórios;
- uso;
- conversão por vendedor;
- conversão simulação → venda.

---

## 30. Pendências para perguntar/confirmar com a Zinix

Mesmo com a documentação atual, manter uma lista de dúvidas formais:

1. política exata de retenção dos resultados de simulação;
2. rate limits oficiais por endpoint/chave;
3. existência futura de webhooks;
4. SLA/uptime e canal de incidente;
5. catálogo: TTL/atualização recomendada;
6. eventual ambiente de homologação futuro;
7. política de rotação de chave;
8. prazo de revogação;
9. DPA / contrato de operador-controlador aplicável à API;
10. suboperadores relevantes para a API;
11. procedimentos para solicitação LGPD relacionada a dados trafegados pela API;
12. tratamento esperado para CPF em ambientes de suporte;
13. semântica detalhada dos códigos de `issues` bancárias;
14. política de mudança/versionamento do contrato OpenAPI.

---

## 31. Estado atual do projeto VT Car antes da integração

### Backend

- produção no Railway;
- builder Railpack;
- persistência em arquivos JSON;
- volume persistente configurado;
- backend CommonJS;
- migração para Node 22 já auditada/testada, mas a publicação controlada ainda precisa respeitar backup e confirmação de persistência/JWT.

### Regra de segurança

**Não iniciar SDK Zinix em produção antes de concluir a proteção da base atual.**

A integração financeira nunca deve ser usada como motivo para arriscar:

- leads;
- mensagens;
- usuários;
- ownership;
- pipeline;
- tarefas;
- histórico.

---

## 32. Decisões do conselho / CTO

### GO

A integração Zinix é tecnicamente aprovada.

### Princípios

1. Zinix = motor financeiro.
2. VT Car = cérebro comercial.
3. Chave = backend only.
4. Interface = 100% VT Car.
5. Persistência da intenção antes do POST.
6. Idempotência obrigatória.
7. Polling não bloqueante.
8. Múltiplas simulações por opportunity.
9. Snapshot integral da condição.
10. Nenhuma atualização comercial automática sem confirmação humana.
11. LGPD by design.
12. Não perder dados atuais para implantar recurso novo.
13. Adapter isolado para reduzir vendor lock-in.
14. Banco dinâmico, nunca hardcoded.
15. Mocks antes de consulta real.

---

## 33. Arquivos de documentação relacionados

Manter junto deste dossiê:

```text
docs/zinix/ZINIX-REFERENCIAS-OFICIAIS.md
docs/zinix/ZINIX-DOSSIE-INTEGRACAO-VTCAR.md
```

Também existem documentos de arquitetura/auditoria produzidos no projeto local:

```text
ZINIX-001-ARQUITETURA-VTCAR.md
ZINIX-001A-AUDITORIA-TECNICA.md
RETORNO-ZINIX-001R-...
RETORNO-ZINIX-001R2-...
RETORNO-ZINIX-001R3-...
```

Quando apropriado, incorporar os documentos aprovados ao repositório sem misturar credenciais ou backups.

---

## 34. Controle de atualização deste documento

Atualizar este dossiê quando houver:

- nova versão do SDK;
- mudança de OpenAPI;
- alteração de pricing;
- novo endpoint;
- webhook;
- mudança de status;
- nova regra de billing;
- alteração de LGPD/privacidade;
- alteração da arquitetura VT Car;
- migração para PostgreSQL;
- mudança de runtime Node;
- novo contrato com Zinix.

Nunca sobrescrever uma decisão sem registrar a mudança.

---

## 35. Conclusão

A integração deve transformar o financiamento em parte nativa do processo comercial da VT Car, e não apenas “chamar uma API”.

O resultado esperado é:

```text
Lead
→ Opportunity
→ Negociação
→ Financiamento
→ Comparação multibanco
→ Condição escolhida
→ Atualização comercial confirmada
→ Fechamento
```

com segurança, rastreabilidade, boa UX, performance, LGPD e independência arquitetural.
