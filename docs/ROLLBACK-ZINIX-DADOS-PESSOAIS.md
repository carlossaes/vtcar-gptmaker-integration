# Rollback seguro depois de dados pessoais salvos (ZINIX-MVP-002A/002B)

## Por que existe

A partir da ZINIX-MVP-002A, a oportunidade pode guardar dados pessoais do cliente em `leads.json`:
`customerDocument` (CPF), `customerBirthDate`, `customerGender`, `customerState`, `customerCity` e `customerHasDriverLicense`.

O código novo nunca devolve o CPF inteiro, e a visão pública controla quem vê o quê.

O backend **antigo** (anterior à 002A) devolve o registro cru. Se ele voltar ao ar com esses campos no arquivo, o CPF aparece inteiro na API.

**Regra:** com dados pessoais salvos, **NUNCA** fazer redeploy direto de um commit anterior à 002A. Primeiro sanitizar.

## Pré-requisitos

- Acesso ao volume do serviço (`/app/data`), feito por quem opera o Railway.
- Janela de manutenção. O serviço não pode gravar `leads.json` durante a limpeza: pare ou pause o serviço (ou coloque-o em manutenção) antes do passo 2. O script grava de forma atômica, mas uma gravação concorrente do CRM poderia trazer de volta uma versão anterior.
- O script `scripts/sanitize-zinix-personal-data.js` presente no deploy atual (o novo).

## Procedimento (na ordem)

1. **Backup do `leads.json`.** Copie o arquivo para fora do volume (ou para um nome datado) e anote o SHA-256:

   ```
   sha256sum /app/data/leads.json
   cp /app/data/leads.json /app/data/leads.json.antes-rollback-AAAAMMDD-HHMM
   sha256sum /app/data/leads.json.antes-rollback-AAAAMMDD-HHMM
   ```

   Os dois hashes precisam ser iguais.

2. **Simulação (dry-run).** Nada é escrito. O relatório traz só contagens, sem valores:

   ```
   node scripts/sanitize-zinix-personal-data.js --file /app/data/leads.json
   ```

   Confira o total de registros e quantos têm os campos.

3. **Aplicar:**

   ```
   node scripts/sanitize-zinix-personal-data.js --file /app/data/leads.json --apply --confirm-production
   ```

   O script:
   - cria um backup próprio ao lado (`leads.json.bak-zinix-<data>-<pid>`) e confere o hash dele;
   - grava o arquivo de forma atômica;
   - relê o arquivo, valida o JSON, confere a quantidade de registros e confirma que restam **0** campos pessoais.

   Opcional: `--also-vehicle` remove também a estrutura técnica do veículo. Não é dado pessoal e o código antigo a ignora, por isso o padrão é manter.

4. **Validar:**

   ```
   node scripts/sanitize-zinix-personal-data.js --file /app/data/leads.json
   grep -c customerDocument /app/data/leads.json
   ```

   O primeiro comando deve mostrar "Registros com os campos: 0". O `grep` deve retornar 0.

5. **Só então** fazer o rollback do backend para o commit anterior e religar o serviço.

6. **Depois do rollback:**
   - conferir `/health`;
   - fazer um `GET /api/leads` com um gerente e confirmar que não há nenhuma chave `customer*`.

7. **Backups com CPF** (o do passo 1 e o `.bak-zinix-*`):
   - guardá-los com acesso restrito, pelo prazo definido pela política de retenção;
   - depois, apagá-los;
   - nunca deixá-los num caminho servido pela aplicação.

## Se algo der errado

- **Script terminou com erro antes de gravar** (código 1 ou 2): nada foi alterado.
- **Erro na verificação final** (código 3): restaure o backup indicado pelo script (`cp <backup> /app/data/leads.json`) e investigue antes de qualquer rollback.
- **Rollback já feito sem sanitizar:** sanitize imediatamente (passos 1 a 4) e trate o ocorrido como possível exposição de dado pessoal (LGPD).
