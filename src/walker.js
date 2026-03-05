import snmp from 'net-snmp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Ajuda ────────────────────────────────────────────────────────────────────
const AJUDA = `
Uso: node src/walker.js <IP> [opções]

Argumentos:
  <IP>                  IP da impressora (obrigatório)

Opções:
  --oid=<OID>           OID raiz para o walk        (padrão: 1.3.6.1)
  --community=<str>     Community SNMP              (padrão: public)
  --filter=<texto>      Exibe apenas linhas cujo OID ou valor contenha o texto
                        Suporta múltiplos: --filter=duplex --filter=copy
  --no-csv              Não salva arquivo CSV, apenas exibe no console
  --help                Exibe esta ajuda

Exemplos:
  # Walk completo — Samsung Egressos Sala 1
  node src/walker.js 192.168.49.9

  # Branch proprietária Samsung
  node src/walker.js 192.168.49.9 --oid=1.3.6.1.4.1.236

  # Branch proprietária HP
  node src/walker.js 192.168.49.67 --oid=1.3.6.1.4.1.11

  # Filtrar por palavra-chave (case-insensitive)
  node src/walker.js 192.168.49.9 --filter=duplex

  # Walk estreito + filtro + sem CSV
  node src/walker.js 192.168.49.9 --oid=1.3.6.1.4.1.236.11.5.11 --filter=copy --no-csv
`;

// ─── Parse de argumentos ──────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log(AJUDA);
  process.exit(0);
}

const TARGET_IP = rawArgs.find(a => !a.startsWith('--')) ?? null;

if (!TARGET_IP) {
  console.error('Erro: IP da impressora é obrigatório.\n');
  console.error(AJUDA);
  process.exit(1);
}

function getParam(name) {
  const found = rawArgs.find(a => a.startsWith(`--${name}=`));
  return found ? found.slice(`--${name}=`.length) : null;
}

const COMMUNITY = getParam('community') ?? 'public';
const ROOT_OID  = getParam('oid')       ?? '1.3.6.1';
const NO_CSV    = rawArgs.includes('--no-csv');

// Múltiplos --filter são aceitos
const FILTROS = rawArgs
  .filter(a => a.startsWith('--filter='))
  .map(a => a.slice('--filter='.length).toLowerCase());

// ─── Destino do CSV ───────────────────────────────────────────────────────────
const CSV_DIR = path.join(__dirname, '../data/csv');
if (!NO_CSV) fs.mkdirSync(CSV_DIR, { recursive: true });

const today      = new Date().toISOString().slice(0, 10);
const safeIp     = TARGET_IP.replace(/\./g, '-');
const safeOid    = ROOT_OID.replace(/\./g, '-');
const OUTPUT_CSV = NO_CSV ? null
  : path.join(CSV_DIR, `walk_${safeIp}_oid${safeOid}_${today}.csv`);

// ─── Cabeçalho ────────────────────────────────────────────────────────────────
console.log('═'.repeat(65));
console.log(`  IP        : ${TARGET_IP}`);
console.log(`  OID raiz  : ${ROOT_OID}`);
console.log(`  Community : ${COMMUNITY}`);
if (FILTROS.length) console.log(`  Filtros   : ${FILTROS.join(', ')}`);
if (NO_CSV)         console.log(`  Saída     : somente console (--no-csv)`);
else                console.log(`  Saída CSV : ${OUTPUT_CSV}`);
console.log('═'.repeat(65));

// ─── SNMP Walk ────────────────────────────────────────────────────────────────
const session = snmp.createSession(TARGET_IP, COMMUNITY, {
  timeout: 5000,
  retries: 3,
  version: snmp.Version2c,
});

const csvRows  = [['oid', 'type', 'value']];
let   total    = 0;   // total coletado
let   exibidos = 0;   // total após filtro

console.log(`\nIniciando walk...\n`);

session.walk(ROOT_OID, 20, (varbinds) => {
  for (const vb of varbinds) {
    if (snmp.isVarbindError(vb)) {
      console.warn(`  ⚠ Erro em ${vb.oid}: ${snmp.varbindError(vb)}`);
      continue;
    }
    const type  = snmp.ObjectType[vb.type] ?? vb.type;
    const value = vb.value?.toString() ?? '';

    total++;

    // Aplica filtros (OR entre múltiplos --filter)
    const linha = `${vb.oid}|${value}`.toLowerCase();
    const passa = FILTROS.length === 0 || FILTROS.some(f => linha.includes(f));

    if (!NO_CSV) {
      csvRows.push([vb.oid, type, `"${value.replace(/"/g, '""')}"`]);
    }

    if (passa) {
      // Exibe no console sempre que passa pelo filtro
      console.log(`  ${vb.oid}`);
      console.log(`    tipo  : ${type}`);
      console.log(`    valor : ${value || '(vazio)'}`);
      console.log();
      exibidos++;
    }

    if (!FILTROS.length) {
      // Sem filtro: mostra progresso compacto na mesma linha
      process.stdout.write(`\r  ${total} OIDs coletados...`);
    }
  }
}, (err) => {
  session.close();

  if (!FILTROS.length) process.stdout.write('\n');

  if (err) {
    console.error('\nErro durante o walk:', err.toString());
    process.exit(1);
  }

  console.log('─'.repeat(65));
  if (FILTROS.length) {
    console.log(`  Total coletado : ${total} OIDs`);
    console.log(`  Após filtro    : ${exibidos} OIDs`);
  } else {
    console.log(`  Walk concluído : ${total} OIDs encontrados`);
  }

  if (!NO_CSV && csvRows.length > 1) {
    const csv = csvRows.map(r => r.join(',')).join('\n');
    fs.writeFileSync(OUTPUT_CSV, csv, 'utf-8');
    console.log(`  CSV salvo em   : ${OUTPUT_CSV}`);
  }

  console.log('═'.repeat(65));
});
