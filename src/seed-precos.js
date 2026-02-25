/**
 * Popula/atualiza a tabela catalogo_precos.
 *
 * Para modelos onde o PN não é capturado via SNMP (Samsung M4020, HP 408dn),
 * usamos uma chave sintética por modelo. Para as HPs que expõem o PN, usamos
 * o part number real — assim o cruzamento com consumiveis_snapshot funciona
 * tanto por modelo quanto por PN capturado.
 *
 * Execute:  npm run seed-precos
 * Pode ser rodado múltiplas vezes sem duplicar — usa INSERT OR REPLACE.
 */

import { abrirBanco } from './db.js';

const db = abrirBanco();

const upsert = db.prepare(`
  INSERT OR REPLACE INTO catalogo_precos (pn, descricao, modelo_ref, preco)
  VALUES (@pn, @descricao, @modelo_ref, @preco)
`);

const precos = [
  // ── Samsung M4020 ─────────────────────────────────────────────────────────
  // PN não é exposto via SNMP — chave sintética por modelo
  {
    pn:         'samsung-m4020-toner',
    descricao:  'Cartucho de Toner Preto Samsung M4020',
    modelo_ref: 'Samsung M4020',
    preco:      128.00,
  },

  // ── HP 408dn ──────────────────────────────────────────────────────────────
  // Usa OIDs Samsung internamente — PN também não é capturado
  {
    pn:         'hp-408dn-toner',
    descricao:  'Cartucho de Toner Preto HP 408dn',
    modelo_ref: 'HP 408dn',
    preco:      128.00,
  },

  // ── HP E52645 ─────────────────────────────────────────────────────────────
  // PN real capturado via SNMP: W9008MC
  {
    pn:         'W9008MC',
    descricao:  'Cartucho de Toner Preto HP E52645 (W9008MC)',
    modelo_ref: 'HP E52645',
    preco:      340.00,
  },

  // ── HP E57540 Cor ─────────────────────────────────────────────────────────
  // Kit com 4 cores, preço médio por toner = R$ 1.049,00
  // PNs reais capturados via SNMP
  {
    pn:         'W9060MC',
    descricao:  'Toner Preto HP E57540 Cor (W9060MC)',
    modelo_ref: 'HP E57540 Cor',
    preco:      1049.00,
  },
  {
    pn:         'W9061MC',
    descricao:  'Toner Ciano HP E57540 Cor (W9061MC)',
    modelo_ref: 'HP E57540 Cor',
    preco:      1049.00,
  },
  {
    pn:         'W9063MC',
    descricao:  'Toner Magenta HP E57540 Cor (W9063MC)',
    modelo_ref: 'HP E57540 Cor',
    preco:      1049.00,
  },
  {
    pn:         'W9062MC',
    descricao:  'Toner Amarelo HP E57540 Cor (W9062MC)',
    modelo_ref: 'HP E57540 Cor',
    preco:      1049.00,
  },

  // ── HP E87660 A3 ──────────────────────────────────────────────────────────
  // Kit com 4 cores, preço médio por toner = R$ 1.075,00
  // PNs reais capturados via SNMP
  {
    pn:         'W9050MC',
    descricao:  'Toner Preto HP E87660 A3 (W9050MC)',
    modelo_ref: 'HP E87660 A3',
    preco:      1075.00,
  },
  {
    pn:         'W9051MC',
    descricao:  'Toner Ciano HP E87660 A3 (W9051MC)',
    modelo_ref: 'HP E87660 A3',
    preco:      1075.00,
  },
  {
    pn:         'W9053MC',
    descricao:  'Toner Magenta HP E87660 A3 (W9053MC)',
    modelo_ref: 'HP E87660 A3',
    preco:      1075.00,
  },
  {
    pn:         'W9052MC',
    descricao:  'Toner Amarelo HP E87660 A3 (W9052MC)',
    modelo_ref: 'HP E87660 A3',
    preco:      1075.00,
  },
];

const inserirTodos = db.transaction(() => {
  for (const item of precos) {
    upsert.run(item);
    console.log(`  ✔ ${item.pn.padEnd(25)} R$ ${item.preco.toFixed(2).padStart(8)}  — ${item.descricao}`);
  }
});

console.log('\nPopulando catálogo de preços...\n');
inserirTodos();
console.log(`\n${precos.length} registros inseridos/atualizados.\n`);

// Exibe o catálogo completo como confirmação
const catalogo = db.prepare('SELECT pn, modelo_ref, preco FROM catalogo_precos ORDER BY modelo_ref, pn').all();
console.log('Catálogo atual:');
console.table(catalogo);
