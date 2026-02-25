import snmp from 'net-snmp';
import fs from 'fs';

const COMMUNITY = "public";

// ─── Carregar impressoras por modelo ────────────────────────────────────────
const impressoras  = JSON.parse(fs.readFileSync('./printers.json', 'utf-8'));
const samsungM4020 = impressoras.filter(p => p.MODELO === 'Samsung M4020');
const hpE52645     = impressoras.filter(p => p.MODELO === 'HP E52645');
const hp408dn      = impressoras.filter(p => p.MODELO === 'HP 408dn');      // testar com OIDs Samsung
const hpE57540     = impressoras.filter(p => p.MODELO === 'HP E57540 Cor');
const hpE87660     = impressoras.filter(p => p.MODELO === 'HP E87660 A3');

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

// ═══════════════════════════════════════════════════════════════════════════════
// HP E57540 Cor — OIDs (4 cartuchos CMYK + fusor + coleta + alimentador)
// ═══════════════════════════════════════════════════════════════════════════════
const NOMES_E57540 = [
  'Toner Preto',              // índice 1 — W9060MC
  'Toner Ciano',              // índice 2 — W9061MC
  'Toner Magenta',            // índice 3 — W9063MC
  'Toner Amarelo',            // índice 4 — W9062MC
  'Kit do Fusor',             // índice 5
  'Unidade Coleta Toner',     // índice 6 — nominal=-2, sem percentual
  'Kit Alimentação Docs.',    // índice 7
  'Cilindros Alim. Docs.',    // índice 8
];

const NUM_TONERS_E57540 = 4;  // Preto, Ciano, Magenta, Amarelo

const OID_E57540_NOMES   = NOMES_E57540.map((_, i) => `1.3.6.1.2.1.43.11.1.1.6.1.${i + 1}`);
const OID_E57540_NOMINAL = NOMES_E57540.map((_, i) => `1.3.6.1.2.1.43.11.1.1.8.1.${i + 1}`);
const OID_E57540_ATUAL   = NOMES_E57540.map((_, i) => `1.3.6.1.2.1.43.11.1.1.9.1.${i + 1}`);

// Dados por cartucho (N = 1..4 → Preto, Ciano, Magenta, Amarelo)
const OID_E57540_PN       = Array.from({length: NUM_TONERS_E57540}, (_, i) => `${HP_SUPPLY}.56.${i+1}.0`);
const OID_E57540_SERIAL   = Array.from({length: NUM_TONERS_E57540}, (_, i) => `${HP_SUPPLY}.3.${i+1}.0`);
const OID_E57540_IMPRESSO = Array.from({length: NUM_TONERS_E57540}, (_, i) => `${HP_SUPPLY}.12.${i+1}.0`);
const OID_E57540_INSTALL  = Array.from({length: NUM_TONERS_E57540}, (_, i) => `${HP_SUPPLY}.8.${i+1}.0`);
const OID_E57540_LASTUSE  = Array.from({length: NUM_TONERS_E57540}, (_, i) => `${HP_SUPPLY}.9.${i+1}.0`);
const OID_E57540_PAG_REST = Array.from({length: NUM_TONERS_E57540}, (_, i) => `1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.5.1.1.${i+1}.0`);
const OID_E57540_CAPACID  = Array.from({length: NUM_TONERS_E57540}, (_, i) => `1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.5.1.4.${i+1}.0`);

const OIDS_E57540 = [
  OID_INFO, OID_HP_TOTAL_PAG,
  ...OID_E57540_NOMES, ...OID_E57540_NOMINAL, ...OID_E57540_ATUAL,
  ...OID_E57540_PN, ...OID_E57540_SERIAL, ...OID_E57540_IMPRESSO,
  ...OID_E57540_INSTALL, ...OID_E57540_LASTUSE,
  ...OID_E57540_PAG_REST, ...OID_E57540_CAPACID,
];

// ═══════════════════════════════════════════════════════════════════════════════
// HP E87660 A3 — OIDs (4 toners + 4 tambores + 4 reveladores + outros)
// Índices MIB não são sequenciais: 1-19, 23, 24, 25
// ═══════════════════════════════════════════════════════════════════════════════
const INDICES_E87660 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 23, 24, 25];

const NOMES_E87660 = [
  'Toner Preto',               // 1  — W9050MC
  'Toner Ciano',               // 2  — W9051MC
  'Toner Magenta',             // 3  — W9053MC
  'Toner Amarelo',             // 4  — W9052MC
  'Tambor Preto',              // 5  — W9054MC
  'Tambor Ciano',              // 6  — W9055MC
  'Tambor Magenta',            // 7  — W9055MC
  'Tambor Amarelo',            // 8  — W9055MC
  'Revelador Preto',           // 9  — Z7Y68A
  'Revelador Ciano',           // 10 — Z7Y69A
  'Revelador Magenta',         // 11 — Z7Y72A
  'Revelador Amarelo',         // 12 — Z7Y73A
  'Correia Transferência',     // 13 — Z7Y78A
  'Unidade Limpeza Transf.',   // 14 — Z7Y80A
  'Roletes Transferência',     // 15 — Z7Y90A
  'Kit do Fusor',              // 16 — Z7Y75A/76A
  'Unidade Coleta Toner',      // 17 — W9058MC (nominal=-2, sem percentual)
  'Rolete Coletor ADF',        // 18 — Z8W50A
  'Rolete Separador ADF',      // 19 — Z8W51A
  'Rolo Bandeja 1',            // 23 — Z7Y88A
  'Rolo Bandeja 2',            // 24 — Z9M01A
  'Rolo Bandeja 3',            // 25 — Z9M01A
];

const NUM_TONERS_E87660 = 4;  // Preto, Ciano, Magenta, Amarelo (índices 1–4)

const OID_E87660_NOMES   = INDICES_E87660.map(i => `1.3.6.1.2.1.43.11.1.1.6.1.${i}`);
const OID_E87660_NOMINAL = INDICES_E87660.map(i => `1.3.6.1.2.1.43.11.1.1.8.1.${i}`);
const OID_E87660_ATUAL   = INDICES_E87660.map(i => `1.3.6.1.2.1.43.11.1.1.9.1.${i}`);

// Dados por cartucho (N = 1..4 → Preto, Ciano, Magenta, Amarelo)
const OID_E87660_PN       = Array.from({length: NUM_TONERS_E87660}, (_, i) => `${HP_SUPPLY}.56.${i+1}.0`);
const OID_E87660_SERIAL   = Array.from({length: NUM_TONERS_E87660}, (_, i) => `${HP_SUPPLY}.3.${i+1}.0`);
const OID_E87660_IMPRESSO = Array.from({length: NUM_TONERS_E87660}, (_, i) => `${HP_SUPPLY}.12.${i+1}.0`);
const OID_E87660_INSTALL  = Array.from({length: NUM_TONERS_E87660}, (_, i) => `${HP_SUPPLY}.8.${i+1}.0`);
const OID_E87660_LASTUSE  = Array.from({length: NUM_TONERS_E87660}, (_, i) => `${HP_SUPPLY}.9.${i+1}.0`);
const OID_E87660_PAG_REST = Array.from({length: NUM_TONERS_E87660}, (_, i) => `1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.5.1.1.${i+1}.0`);
const OID_E87660_CAPACID  = Array.from({length: NUM_TONERS_E87660}, (_, i) => `1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.10.5.1.4.${i+1}.0`);

const OIDS_E87660 = [
  OID_INFO, OID_HP_TOTAL_PAG,
  ...OID_E87660_NOMES, ...OID_E87660_NOMINAL, ...OID_E87660_ATUAL,
  ...OID_E87660_PN, ...OID_E87660_SERIAL, ...OID_E87660_IMPRESSO,
  ...OID_E87660_INSTALL, ...OID_E87660_LASTUSE,
  ...OID_E87660_PAG_REST, ...OID_E87660_CAPACID,
];

// ─── SNMP GET com batching: evita erro TooBig em requisições grandes ───────────
function snmpGetChunked(session, oids, chunkSize = 20) {
  const chunks = [];
  for (let i = 0; i < oids.length; i += chunkSize) chunks.push(oids.slice(i, i + chunkSize));
  return chunks.reduce(
    (p, chunk) => p.then(all => new Promise((ok, fail) =>
      session.get(chunk, (err, vbs) => err ? fail(err) : ok([...all, ...vbs]))
    )),
    Promise.resolve([])
  );
}

// ─── Consulta SNMP genérica (detecta modelo automaticamente) ─────────────────
function consultarImpressora(impressora) {
  const isHP        = impressora.MODELO === 'HP E52645';  // 408dn usa path Samsung intencionalmente
  const isHPColor   = impressora.MODELO === 'HP E57540 Cor';
  const isHPColorA3 = impressora.MODELO === 'HP E87660 A3';

  let oids, nomesItens, oidNomes, oidNominal, oidAtual;
  if (isHPColorA3) {
    oids = OIDS_E87660; nomesItens = NOMES_E87660;
    oidNomes = OID_E87660_NOMES; oidNominal = OID_E87660_NOMINAL; oidAtual = OID_E87660_ATUAL;
  } else if (isHPColor) {
    oids = OIDS_E57540; nomesItens = NOMES_E57540;
    oidNomes = OID_E57540_NOMES; oidNominal = OID_E57540_NOMINAL; oidAtual = OID_E57540_ATUAL;
  } else if (isHP) {
    oids = OIDS_HP; nomesItens = NOMES_HP;
    oidNomes = OID_HP_NOMES; oidNominal = OID_HP_NOMINAL; oidAtual = OID_HP_ATUAL;
  } else {
    oids = OIDS_SAMSUNG; nomesItens = NOMES_SAMSUNG;
    oidNomes = OID_SAMSUNG_NOMES; oidNominal = OID_SAMSUNG_NOMINAL; oidAtual = OID_SAMSUNG_ATUAL;
  }

  return new Promise((resolve, reject) => {
    const ip = impressora['IP Liberty'];

    const session = snmp.createSession(ip, COMMUNITY, {
      timeout: 800,
      retries: 0,
      version: snmp.Version2c,
    });

    snmpGetChunked(session, oids)
      .then(varbinds => {
      session.close();

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

      if (isHPColorA3) {
        resultado.totalImpresso = parseInt(obterValor(OID_HP_TOTAL_PAG)) || null;
        resultado.toners = Array.from({length: NUM_TONERS_E87660}, (_, i) => ({
          nome:     ['Preto', 'Ciano', 'Magenta', 'Amarelo'][i],
          pn:       limparStr(obterValor(OID_E87660_PN[i])),
          serial:   limparStr(obterValor(OID_E87660_SERIAL[i])),
          impresso: parseInt(obterValor(OID_E87660_IMPRESSO[i])) || null,
          install:  limparStr(obterValor(OID_E87660_INSTALL[i])),
          lastUse:  limparStr(obterValor(OID_E87660_LASTUSE[i])),
          pagRest:  parseInt(obterValor(OID_E87660_PAG_REST[i])) || null,
          capacid:  parseInt(obterValor(OID_E87660_CAPACID[i])) || null,
        }));
      } else if (isHPColor) {
        resultado.totalImpresso = parseInt(obterValor(OID_HP_TOTAL_PAG)) || null;
        resultado.toners = Array.from({length: NUM_TONERS_E57540}, (_, i) => ({
          nome:     ['Preto', 'Ciano', 'Magenta', 'Amarelo'][i],
          pn:       limparStr(obterValor(OID_E57540_PN[i])),
          serial:   limparStr(obterValor(OID_E57540_SERIAL[i])),
          impresso: parseInt(obterValor(OID_E57540_IMPRESSO[i])) || null,
          install:  limparStr(obterValor(OID_E57540_INSTALL[i])),
          lastUse:  limparStr(obterValor(OID_E57540_LASTUSE[i])),
          pagRest:  parseInt(obterValor(OID_E57540_PAG_REST[i])) || null,
          capacid:  parseInt(obterValor(OID_E57540_CAPACID[i])) || null,
        }));
      } else if (isHP) {
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
        const _rawSerial = obterValor(OID_SAMSUNG_NOMES[0]);
        resultado.serialToner = _rawSerial?.match(/S\/N:(\S+)/)?.[1] ?? _rawSerial;
      }

      resolve(resultado);
    })
      .catch(err => {
        session.close();
        reject(err);
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
  const isHP        = resultado.modelo === 'HP E52645';
  const isHPColor   = resultado.modelo === 'HP E57540 Cor';
  const isHPColorA3 = resultado.modelo === 'HP E87660 A3';

  console.log('\n' + '═'.repeat(65));
  console.log(`  Setor      : ${resultado.setor}`);
  console.log(`  Modelo     : ${resultado.modelo}`);
  console.log(`  Série      : ${resultado.serie}`);
  console.log(`  IP         : ${resultado.ip}`);
  console.log(`  Informação : ${resultado.modeloSerie ?? 'Não disponível'}`);

  if (isHPColorA3 || isHPColor) {
    const tot = resultado.totalImpresso != null ? resultado.totalImpresso.toLocaleString('pt-BR') : 'N/D';
    console.log(`  Total Disp.: ${tot}`);
  } else if (isHP) {
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

  if ((isHPColorA3 || isHPColor) && resultado.toners?.length) {
    console.log('─'.repeat(65));
    console.log('  Cartuchos de Toner:');
    for (const t of resultado.toners) {
      const pag  = t.impresso != null ? t.impresso.toLocaleString('pt-BR') : 'N/D';
      const rest = t.pagRest  != null ? t.pagRest.toLocaleString('pt-BR')  : 'N/D';
      const cap  = t.capacid  != null ? t.capacid.toLocaleString('pt-BR')  : 'N/D';
      console.log(`    ── ${t.nome}`);
      console.log(`       PN       : ${t.pn      ?? 'N/D'}`);
      console.log(`       Serial   : ${t.serial  ?? 'N/D'}`);
      console.log(`       Instalado: ${formatarData(t.install)}   Últ.Uso: ${formatarData(t.lastUse)}`);
      console.log(`       Pág.Impr.: ${pag.padStart(7)}   Pág.Rest: ${rest.padStart(7)}   Cap: ${cap}`);
    }
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
    { nome: 'HP E57540 Cor', lista: hpE57540     },
    { nome: 'HP E87660 A3',  lista: hpE87660     },
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
