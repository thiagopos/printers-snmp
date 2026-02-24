import snmp from 'net-snmp';
import fs from 'fs';

const COMMUNITY = "public";

// ─── Carregar e filtrar impressoras Samsung M4020 ───────────────────────────
const impressoras = JSON.parse(fs.readFileSync('./printers.json', 'utf-8'));
const samsungM4020 = impressoras.filter(p => p.MODELO === 'Samsung M4020');

// ─── OIDs Gerais ────────────────────────────────────────────────────────────
const OID_MODELO_SERIE  = '1.3.6.1.2.1.1.1.0';
const OID_ALERTA        = '1.3.6.1.2.1.43.18.1.1.8.1.1';
const OID_MENSAGEM_TELA = '1.3.6.1.4.1.236.11.5.1.1.9.20.0';

// ─── Nomes dos itens consumíveis (em português) ─────────────────────────────
const NOMES_ITENS = [
  'Cartucho de Toner Preto',  // índice 1
  'Fusor',                    // índice 2
  'Rolo de Transferência',    // índice 3
  'Rolo MP',                  // índice 4
  'Rolo de Retardo MP',       // índice 5
  'Rolo Bandeja 1',           // índice 6
  'Rolo de Retardo Bandeja 1' // índice 7
];

// ─── Geração dos OIDs por bloco ──────────────────────────────────────────────
const OID_NOMES    = NOMES_ITENS.map((_, i) => `1.3.6.1.2.1.43.11.1.1.6.1.${i + 1}`);
const OID_NOMINAL  = NOMES_ITENS.map((_, i) => `1.3.6.1.2.1.43.11.1.1.8.1.${i + 1}`);
const OID_ATUAL    = NOMES_ITENS.map((_, i) => `1.3.6.1.2.1.43.11.1.1.9.1.${i + 1}`);

const TODOS_OIDs = [
  OID_MODELO_SERIE,
  OID_ALERTA,
  OID_MENSAGEM_TELA,
  ...OID_NOMES,
  ...OID_NOMINAL,
  ...OID_ATUAL,
];

// ─── Consulta SNMP de uma impressora ────────────────────────────────────────
function consultarImpressora(impressora) {
  return new Promise((resolve, reject) => {
    const ip = impressora['IP Liberty'];

    const session = snmp.createSession(ip, COMMUNITY, {
      timeout: 1000,
      retries: 1,
      version: snmp.Version2c,
    });

    session.get(TODOS_OIDs, (err, varbinds) => {
      session.close();

      if (err) return reject(err);

      // Helper: busca valor pelo OID
      const obterValor = (oid) => {
        const vb = varbinds.find(v => v.oid === oid);
        if (!vb || snmp.isVarbindError(vb)) return null;
        return vb.value?.toString() ?? null;
      };

      const itens = NOMES_ITENS.map((nome, i) => {
        const nominal    = parseInt(obterValor(OID_NOMINAL[i])) || 0;
        const atual      = parseInt(obterValor(OID_ATUAL[i]))   || 0;
        const percentual = nominal > 0 ? Math.round((atual / nominal) * 100) : null;
        return { nome, nominal, atual, percentual };
      });

      resolve({
        setor:        impressora.SETOR,
        modelo:       impressora.MODELO,
        serie:        impressora['SÉRIE'],
        ip,
        modeloSerie:  obterValor(OID_MODELO_SERIE),
        alerta:       obterValor(OID_ALERTA),
        mensagemTela: obterValor(OID_MENSAGEM_TELA),
        serialToner:  obterValor(OID_NOMES[0]),
        itens,
      });
    });
  });
}

// ─── Barra de progresso visual ───────────────────────────────────────────────
function gerarBarra(percentual) {
  const total  = 20;
  const cheios = Math.round((percentual / 100) * total);
  return '[' + '█'.repeat(cheios) + '░'.repeat(total - cheios) + ']';
}

// ─── Exibição dos resultados no console ─────────────────────────────────────
function exibirResultado(resultado) {
  console.log('\n' + '═'.repeat(65));
  console.log(`  Setor      : ${resultado.setor}`);
  console.log(`  Modelo     : ${resultado.modelo}`);
  console.log(`  Série      : ${resultado.serie}`);
  console.log(`  IP         : ${resultado.ip}`);
  console.log(`  Informação : ${resultado.modeloSerie  ?? 'Não disponível'}`);
  console.log(`  Alerta     : ${resultado.alerta       ?? 'Nenhum'}`);
  console.log(`  Mensagem   : ${resultado.mensagemTela ?? 'Não disponível'}`);
  console.log(`  Serial Ton.: ${resultado.serialToner  ?? 'Não disponível'}`);
  console.log('─'.repeat(65));
  console.log('  Consumíveis:');

  for (const [i, item] of resultado.itens.entries()) {
    const pct   = item.percentual !== null ? `${item.percentual}%` : 'N/D';
    const barra = item.percentual !== null ? gerarBarra(item.percentual) : '';
    console.log(`    ${item.nome.padEnd(32)} ${pct.padStart(5)}  ${barra}`);
  }

  console.log('═'.repeat(65));
}

// ─── Principal ───────────────────────────────────────────────────────────────
async function main() {
  const inicio = Date.now();
  console.log(`\nConsultando ${samsungM4020.length} impressora(s) Samsung M4020...\n`);

  let sucesso = 0;
  const total = samsungM4020.length;

  for (const impressora of samsungM4020) {
    console.log(`Consultando: ${impressora.SETOR} (${impressora['IP Liberty']})...`);

    try {
      const resultado = await consultarImpressora(impressora);
      exibirResultado(resultado);
      sucesso++;
    } catch (err) {
      console.error(`  ERRO em ${impressora.SETOR} (${impressora['IP Liberty']}): ${err.message}`);
    }
  }

  const segundos = ((Date.now() - inicio) / 1000).toFixed(2);
  console.log(`\nConsulta finalizada em ${segundos}s — ${sucesso}/${total} impressora(s) responderam.\n`);
}

main();
