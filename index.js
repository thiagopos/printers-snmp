import snmp from 'net-snmp';
import fs from 'fs';

const COMMUNITY = "public";

// ─── Carregar impressoras por modelo ────────────────────────────────────────
const impressoras  = JSON.parse(fs.readFileSync('./printers.json', 'utf-8'));
const samsungM4020 = impressoras.filter(p => p.MODELO === 'Samsung M4020');
const hpE52645     = impressoras.filter(p => p.MODELO === 'HP E52645');
const hp408dn      = impressoras.filter(p => p.MODELO === 'HP 408dn');      // testar com OIDs Samsung

// ─── OID comum ───────────────────────────────────────────────────────────────
const OID_INFO = '1.3.6.1.2.1.1.1.0';

// ═══════════════════════════════════════════════════════════════════════════════
// SAMSUNG M4020 — OIDs
// ═══════════════════════════════════════════════════════════════════════════════
const OID_ALERTA        = '1.3.6.1.2.1.43.18.1.1.8.1.1';
const OID_MENSAGEM_TELA = '1.3.6.1.4.1.236.11.5.1.1.9.20.0';

const NOMES_SAMSUNG = [
  'Cartucho de Toner Preto',   // índice 1
  'Fusor',                      // índice 2
  'Rolo de Transferência',      // índice 3
  'Rolo MP',                    // índice 4
  'Rolo de Retardo MP',         // índice 5
  'Rolo Bandeja 1',             // índice 6
  'Rolo de Retardo Bandeja 1',  // índice 7
];

const OID_SAMSUNG_NOMES   = NOMES_SAMSUNG.map((_, i) => `1.3.6.1.2.1.43.11.1.1.6.1.${i + 1}`);
const OID_SAMSUNG_NOMINAL = NOMES_SAMSUNG.map((_, i) => `1.3.6.1.2.1.43.11.1.1.8.1.${i + 1}`);
const OID_SAMSUNG_ATUAL   = NOMES_SAMSUNG.map((_, i) => `1.3.6.1.2.1.43.11.1.1.9.1.${i + 1}`);

const OIDS_SAMSUNG = [
  OID_INFO, OID_ALERTA, OID_MENSAGEM_TELA,
  ...OID_SAMSUNG_NOMES, ...OID_SAMSUNG_NOMINAL, ...OID_SAMSUNG_ATUAL,
];

// ═══════════════════════════════════════════════════════════════════════════════
// HP E52645 — OIDs
// ═══════════════════════════════════════════════════════════════════════════════
// prtGeneralPrinterName — nome do modelo via MIB padrão
const OID_HP_NOME_MOD  = '1.3.6.1.2.1.43.5.1.1.16.1';
// prtMarkerLifeCount — total de páginas impressas pelo dispositivo
const OID_HP_TOTAL_PAG = '1.3.6.1.2.1.43.10.2.1.4.1.1';

// ─── Branch HP proprietária: 1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.1.1.X.1.0 ──
// Todos os campos exibidos na página web da impressora
const HP_SUPPLY = '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.1.1';
const OID_HP_TONER_PN       = `${HP_SUPPLY}.56.1.0`;  // Part number (W9008MC)
const OID_HP_TONER_SERIAL   = `${HP_SUPPLY}.3.1.0`;   // Número de série do cartucho
const OID_HP_TONER_IMPRESSO = `${HP_SUPPLY}.12.1.0`;  // Páginas impressas com este consumível
const OID_HP_TONER_INSTALL  = `${HP_SUPPLY}.8.1.0`;   // Primeira data de instalação
const OID_HP_TONER_LASTUSE  = `${HP_SUPPLY}.9.1.0`;   // Última data de utilização
const OID_HP_TONER_CAPACID  = `${HP_SUPPLY}.1.1.0`;   // Capacidade declarada

// HP proprietária: páginas remanescentes estimadas (baseado na cobertura atual)
const OID_HP_PAG_REST = '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.5.1.1.1.0';

const NOMES_HP = [
  'Cartucho de Toner Preto',    // índice 1
  'Kit Alimentação Documentos', // índice 2
  'Cilindros Alimentação Doc.', // índice 3
];

const OID_HP_NOMES   = NOMES_HP.map((_, i) => `1.3.6.1.2.1.43.11.1.1.6.1.${i + 1}`);
const OID_HP_NOMINAL = NOMES_HP.map((_, i) => `1.3.6.1.2.1.43.11.1.1.8.1.${i + 1}`);
const OID_HP_ATUAL   = NOMES_HP.map((_, i) => `1.3.6.1.2.1.43.11.1.1.9.1.${i + 1}`);

const OIDS_HP = [
  OID_INFO, OID_HP_NOME_MOD, OID_HP_PAG_REST, OID_HP_TOTAL_PAG,
  OID_HP_TONER_PN, OID_HP_TONER_SERIAL, OID_HP_TONER_IMPRESSO,
  OID_HP_TONER_INSTALL, OID_HP_TONER_LASTUSE, OID_HP_TONER_CAPACID,
  ...OID_HP_NOMES, ...OID_HP_NOMINAL, ...OID_HP_ATUAL,
];

// ─── Consulta SNMP genérica (detecta modelo automaticamente) ─────────────────
function consultarImpressora(impressora) {
  const isHP      = impressora.MODELO === 'HP E52645';  // 408dn usa path Samsung intencionalmente
  const oids      = isHP ? OIDS_HP      : OIDS_SAMSUNG;
  const nomesItens = isHP ? NOMES_HP     : NOMES_SAMSUNG;
  const oidNomes   = isHP ? OID_HP_NOMES   : OID_SAMSUNG_NOMES;
  const oidNominal = isHP ? OID_HP_NOMINAL : OID_SAMSUNG_NOMINAL;
  const oidAtual   = isHP ? OID_HP_ATUAL   : OID_SAMSUNG_ATUAL;

  return new Promise((resolve, reject) => {
    const ip = impressora['IP Liberty'];

    const session = snmp.createSession(ip, COMMUNITY, {
      timeout: 1000,
      retries: 1,
      version: snmp.Version2c,
    });

    session.get(oids, (err, varbinds) => {
      session.close();
      if (err) return reject(err);

      const obterValor = (oid) => {
        const vb = varbinds.find(v => v.oid === oid);
        if (!vb || snmp.isVarbindError(vb)) return null;
        return vb.value?.toString() ?? null;
      };

      const itens = nomesItens.map((nome, i) => {
        const nominal    = parseInt(obterValor(oidNominal[i])) || 0;
        const atual      = parseInt(obterValor(oidAtual[i]))   || 0;
        const percentual = nominal > 0 ? Math.round((atual / nominal) * 100) : null;
        return { nome, nominal, atual, percentual };
      });

      const resultado = {
        setor:       impressora.SETOR,
        modelo:      impressora.MODELO,
        serie:       impressora['SÉRIE'],
        ip,
        modeloSerie: obterValor(OID_INFO),
        itens,
      };

      if (isHP) {
        resultado.nomeModelo    = obterValor(OID_HP_NOME_MOD);
        resultado.paginasRest   = parseInt(obterValor(OID_HP_PAG_REST))       || null;
        resultado.totalImpresso = parseInt(obterValor(OID_HP_TOTAL_PAG))      || null;
        resultado.tonerPN       = limparStr(obterValor(OID_HP_TONER_PN));
        resultado.tonerSerial   = limparStr(obterValor(OID_HP_TONER_SERIAL));
        resultado.tonerImpresso = parseInt(obterValor(OID_HP_TONER_IMPRESSO)) || null;
        resultado.tonerInstall  = limparStr(obterValor(OID_HP_TONER_INSTALL));
        resultado.tonerLastUse  = limparStr(obterValor(OID_HP_TONER_LASTUSE));
        resultado.tonerCapacid  = limparStr(obterValor(OID_HP_TONER_CAPACID));
      } else {
        resultado.alerta       = obterValor(OID_ALERTA);
        resultado.mensagemTela = obterValor(OID_MENSAGEM_TELA);
        resultado.serialToner  = obterValor(OID_SAMSUNG_NOMES[0]);
      }

      resolve(resultado);
    });
  });
}

// ─── Remove bytes não-ASCII que a HP inclui como prefixo nos OctetStrings ────
function limparStr(v) {
  return v ? v.replace(/[^\x20-\x7E]/g, '').trim() : null;
}

// ─── Formata data AAAAMMDD → DD/MM/AAAA ─────────────────────────────────────
function formatarData(s) {
  if (!s || s.length !== 8) return s ?? 'N/D';
  return `${s.slice(6)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
}

// ─── Barra de progresso visual ───────────────────────────────────────────────
function gerarBarra(percentual) {
  const total  = 20;
  const cheios = Math.round((percentual / 100) * total);
  return '[' + '█'.repeat(cheios) + '░'.repeat(total - cheios) + ']';
}

// ─── Exibição dos resultados no console ─────────────────────────────────────
function exibirResultado(resultado) {
  const isHP = resultado.modelo === 'HP E52645';

  console.log('\n' + '═'.repeat(65));
  console.log(`  Setor      : ${resultado.setor}`);
  console.log(`  Modelo     : ${resultado.modelo}`);
  console.log(`  Série      : ${resultado.serie}`);
  console.log(`  IP         : ${resultado.ip}`);
  console.log(`  Informação : ${resultado.modeloSerie ?? 'Não disponível'}`);

  if (isHP) {
    const pag  = resultado.paginasRest   != null ? resultado.paginasRest.toLocaleString('pt-BR')   : 'N/D';
    const imp  = resultado.tonerImpresso != null ? resultado.tonerImpresso.toLocaleString('pt-BR') : 'N/D';
    const tot  = resultado.totalImpresso != null ? resultado.totalImpresso.toLocaleString('pt-BR') : 'N/D';
    const cap  = resultado.tonerCapacid  ?? 'N/D';
    console.log(`  Cartucho   : ${resultado.tonerPN      ?? 'N/D'}`);
    console.log(`  Ser.Cartu. : ${resultado.tonerSerial  ?? 'N/D'}`);
    console.log(`  Pág. Rest. : ${pag}`);
    console.log(`  Pág. Impr. : ${imp}  (capacidade: ${cap})`);
    console.log(`  Total Disp.: ${tot}`);
    console.log(`  Instalado  : ${formatarData(resultado.tonerInstall)}`);
    console.log(`  Últ. Uso   : ${formatarData(resultado.tonerLastUse)}`);
  } else {
    console.log(`  Alerta     : ${resultado.alerta       ?? 'Nenhum'}`);
    console.log(`  Mensagem   : ${resultado.mensagemTela ?? 'Não disponível'}`);
    console.log(`  Serial Ton.: ${resultado.serialToner  ?? 'Não disponível'}`);
  }

  console.log('─'.repeat(65));
  console.log('  Consumíveis:');

  for (const item of resultado.itens) {
    const pct   = item.percentual !== null ? `${item.percentual}%` : 'N/D';
    const barra = item.percentual !== null ? gerarBarra(item.percentual) : '';
    console.log(`    ${item.nome.padEnd(32)} ${pct.padStart(5)}  ${barra}`);
  }

  console.log('═'.repeat(65));
}

// ─── Principal ───────────────────────────────────────────────────────────────
async function main() {
  const inicio = Date.now();

  const grupos = [
    { nome: 'Samsung M4020', lista: samsungM4020 },
    { nome: 'HP E52645',     lista: hpE52645     },
    { nome: 'HP 408dn',      lista: hp408dn      },
  ];

  let sucesso    = 0;
  let total      = 0;
  const falhas   = [];

  for (const { nome, lista } of grupos) {
    if (lista.length === 0) continue;
    console.log(`\nConsultando ${lista.length} impressora(s) ${nome}...\n`);
    total += lista.length;

    for (const impressora of lista) {
      console.log(`Consultando: ${impressora.SETOR} (${impressora['IP Liberty']})...`);
      try {
        const resultado = await consultarImpressora(impressora);
        exibirResultado(resultado);
        sucesso++;
      } catch (err) {
        falhas.push({ impressora, motivo: err.message });
      }
    }
  }

  const segundos = ((Date.now() - inicio) / 1000).toFixed(2);
  console.log(`\nConsulta finalizada em ${segundos}s — ${sucesso}/${total} impressora(s) responderam.\n`);

  if (falhas.length > 0) {
    console.log('═'.repeat(65));
    console.log(`  ⚠  ${falhas.length} impressora(s) NÃO responderam:`);
    console.log('─'.repeat(65));
    for (const { impressora, motivo } of falhas) {
      const ip = impressora['IP Liberty'];
      console.log(`  • ${impressora.SETOR.padEnd(40)} ${ip.padEnd(18)} (${motivo})`);
    }
    console.log('═'.repeat(65) + '\n');
  }
}

main();
