#!/usr/bin/env node
// ZINIX-MVP-002B — remove os dados pessoais de financiamento de um leads.json.
//
// PARA QUÊ: rollback SEGURO. O backend antigo (anterior à MVP-002A) devolve o
// registro cru na API; se algum CPF já tiver sido salvo, ele apareceria
// inteiro. Antes de voltar para o código antigo, rode este script no arquivo.
//
// SEGURANÇA DO PRÓPRIO SCRIPT
// - Sem dependências externas (só Node).
// - Caminho do ARQUIVO obrigatório e explícito (--file). Nenhum padrão, nunca
//   procura em diretório, recusa diretório e recusa arquivo que não seja .json.
// - Padrão é SIMULAÇÃO (dry-run): só relata, não escreve nada.
// - Escrever exige --apply. Arquivo sob /app/data (volume de produção) exige
//   também --confirm-production.
// - Ao aplicar: backup exclusivo ao lado do arquivo (nunca sobrescreve um
//   backup existente) + SHA-256; grava atomicamente (temporário + rename);
//   relê e valida o JSON final; confere que nenhum campo removido sobrou.
// - Nunca imprime valores pessoais: só contagens, nomes de campos, caminhos e hashes.
//
// USO
//   node scripts/sanitize-zinix-personal-data.js --file <caminho/leads.json>            (simulação)
//   node scripts/sanitize-zinix-personal-data.js --file <caminho/leads.json> --apply    (aplica)
//   opções: --also-vehicle  remove também a estrutura técnica do veículo (vehicleType…vehicleCatalogConfirmedAt)
//           --json          relatório em JSON
//
// Saída: 0 ok; 1 erro de uso/arquivo; 2 JSON inválido; 3 falha na verificação final.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PERSONAL_FIELDS = ['customerDocument', 'customerBirthDate', 'customerGender', 'customerState', 'customerCity', 'customerHasDriverLicense'];
const VEHICLE_FIELDS = ['vehicleType', 'vehicleBrandCode', 'vehicleBrandName', 'vehicleModelCode', 'vehicleModelName', 'vehicleVersionCode',
  'vehicleVersionName', 'vehicleManufactureYear', 'vehicleModelYear', 'vehicleZeroKm', 'vehicleCatalogInterest', 'vehicleCatalogConfirmedAt'];
const PRODUCAO = path.resolve('/app/data');

class UsoError extends Error { constructor(msg, code = 1) { super(msg); this.code = code; } }

function parseArgs(argv) {
  const a = { file: null, apply: false, dryRun: false, alsoVehicle: false, json: false, confirmProduction: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--file') { a.file = argv[++i] ?? null; continue; }
    if (x.startsWith('--file=')) { a.file = x.slice(7); continue; }
    if (x === '--apply') a.apply = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--also-vehicle') a.alsoVehicle = true;
    else if (x === '--json') a.json = true;
    else if (x === '--confirm-production') a.confirmProduction = true;
    else throw new UsoError(`Opção desconhecida: ${x}`);
  }
  if (!a.file) throw new UsoError('Informe o arquivo: --file <caminho/leads.json>');
  if (a.apply && a.dryRun) throw new UsoError('Use --apply OU --dry-run, não os dois.');
  return a;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const carimbo = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

function lerJson(buf) {
  let dados;
  try { dados = JSON.parse(buf.toString('utf8')); } catch { throw new UsoError('O arquivo não é um JSON válido. Nada foi alterado.', 2); }
  if (!Array.isArray(dados)) throw new UsoError('O arquivo não é uma lista de registros (leads.json). Nada foi alterado.', 2);
  return dados;
}

function analisar(registros, campos) {
  const porCampo = Object.fromEntries(campos.map((c) => [c, 0]));
  let comCampos = 0;
  for (const r of registros) {
    if (!r || typeof r !== 'object') continue;
    let tem = false;
    for (const c of campos) if (Object.hasOwn(r, c)) { porCampo[c] += 1; tem = true; }
    if (tem) comCampos += 1;
  }
  return { total: registros.length, comCampos, porCampo };
}

function limpar(registros, campos) {
  return registros.map((r) => {
    if (!r || typeof r !== 'object' || !campos.some((c) => Object.hasOwn(r, c))) return r;
    const novo = { ...r };
    for (const c of campos) delete novo[c];
    return novo;
  });
}

function run(argv, out = (s) => process.stdout.write(`${s}\n`)) {
  const a = parseArgs(argv);
  const arquivo = path.resolve(a.file);
  const emProducao = arquivo === PRODUCAO || arquivo.startsWith(PRODUCAO + path.sep);
  if (a.apply && emProducao && !a.confirmProduction) {
    throw new UsoError('Arquivo no volume de produção (/app/data): para aplicar, siga o procedimento de rollback e acrescente --confirm-production.');
  }
  let st;
  try { st = fs.lstatSync(arquivo); } catch { throw new UsoError('Arquivo não encontrado.'); }
  if (st.isDirectory()) throw new UsoError('Informe um ARQUIVO .json, não um diretório.');
  if (st.isSymbolicLink() || !st.isFile()) throw new UsoError('O caminho precisa ser um arquivo comum (não link).');
  if (path.extname(arquivo).toLowerCase() !== '.json') throw new UsoError('O arquivo precisa ter extensão .json.');

  const campos = a.alsoVehicle ? [...PERSONAL_FIELDS, ...VEHICLE_FIELDS] : PERSONAL_FIELDS;
  const original = fs.readFileSync(arquivo);
  const registros = lerJson(original);
  const antes = analisar(registros, campos);
  const relatorio = {
    modo: a.apply ? 'APLICAR' : 'SIMULAÇÃO (dry-run): nada foi escrito',
    arquivo, emProducao, campos,
    totalRegistros: antes.total,
    registrosComCampos: antes.comCampos,
    registrosQueSeriamAlterados: antes.comCampos,
    ocorrenciasPorCampo: antes.porCampo,
    sha256Antes: sha256(original),
    backup: null, sha256Backup: null, sha256Depois: null, verificacao: null,
  };

  if (a.apply && antes.comCampos > 0) {
    // 1. backup exclusivo (falha se já existir; nunca sobrescreve)
    const backup = `${arquivo}.bak-zinix-${carimbo()}-${process.pid}`;
    fs.writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    const lido = fs.readFileSync(backup);
    if (sha256(lido) !== relatorio.sha256Antes) throw new UsoError('Backup não confere com o original. Nada foi alterado.', 3);
    relatorio.backup = backup; relatorio.sha256Backup = sha256(lido);

    // 2. gravação atômica (mesmo formato do store.js)
    const limpo = limpar(registros, campos);
    const tmp = `${arquivo}.tmp-sanitize-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(limpo, null, 2), { flag: 'wx', mode: st.mode & 0o777 });
    fs.renameSync(tmp, arquivo);

    // 3. verificação: JSON válido, mesma quantidade, nenhum campo restante
    const final = fs.readFileSync(arquivo);
    const depois = analisar(lerJson(final), campos);
    relatorio.sha256Depois = sha256(final);
    relatorio.verificacao = { jsonValido: true, mesmaQuantidade: depois.total === antes.total, camposRestantes: depois.comCampos };
    if (depois.total !== antes.total || depois.comCampos !== 0) throw new UsoError('Verificação final falhou: restaure o backup indicado acima.', 3);
    relatorio.modo = 'APLICADO';
  } else if (a.apply) {
    relatorio.modo = 'APLICAR: nenhum registro tinha os campos; nada foi escrito';
  }

  if (a.json) out(JSON.stringify(relatorio, null, 2));
  else {
    out(`Sanitização Zinix: ${relatorio.modo}`);
    out(`Arquivo: ${arquivo}${emProducao ? ' (VOLUME DE PRODUÇÃO)' : ''}`);
    out(`Campos removidos: ${campos.join(', ')}`);
    out(`Total de registros: ${relatorio.totalRegistros}`);
    out(`Registros com os campos: ${relatorio.registrosComCampos}`);
    out(`Registros que ${a.apply ? 'foram' : 'seriam'} alterados: ${relatorio.registrosQueSeriamAlterados}`);
    for (const [c, n] of Object.entries(relatorio.ocorrenciasPorCampo)) out(`  ${c}: ${n}`);
    out(`SHA-256 antes: ${relatorio.sha256Antes}`);
    if (relatorio.backup) {
      out(`Backup: ${relatorio.backup}`);
      out(`SHA-256 backup: ${relatorio.sha256Backup}`);
      out(`SHA-256 depois: ${relatorio.sha256Depois}`);
      out(`Verificação: JSON válido, ${relatorio.verificacao.mesmaQuantidade ? 'mesma quantidade de registros' : 'QUANTIDADE DIFERENTE'}, campos restantes: ${relatorio.verificacao.camposRestantes}`);
    }
  }
  return relatorio;
}

if (require.main === module) {
  try { run(process.argv.slice(2)); } catch (err) {
    // Nunca imprime stack nem conteúdo do arquivo.
    process.stderr.write(`Erro: ${err instanceof UsoError ? err.message : (err && err.code) || 'falha inesperada'}\n`);
    process.exit(err instanceof UsoError ? err.code : 1);
  }
}

module.exports = { run, PERSONAL_FIELDS, VEHICLE_FIELDS };
