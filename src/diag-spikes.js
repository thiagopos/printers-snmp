/**
 * diag-spikes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnóstico de leituras anômalas no contador total_paginas_dispositivo.
 *
 * Uso:
 *   node src/diag-spikes.js                     # últimos 7 dias (padrão)
 *   node src/diag-spikes.js --dias=30            # últimos 30 dias
 *   node src/diag-spikes.js --de=2026-03-06 --ate=2026-03-13
 *   node src/diag-spikes.js --max-delta=5000     # threshold de spike (pág/coleta)
 *
 * O que ele faz:
 *   1. Lista todos os deltas individuais (snapshot N vs N-1) por impressora no período.
 *   2. Destaca spikes (delta > threshold — padrão: 2000 pág por coleta de 30 min).
 *   3. Mostra a série histórica completa de cada impressora com spike.
 *   4. Calcula o total "oficial" (algoritmo atual) e o total "corrigido" (ignorando spikes).
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '../data/db/monitor.db');

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v]; })
);

const dias      = parseInt(args.dias ?? '7');
const maxDelta  = parseInt(args['max-delta'] ?? '2000');   // pág por coleta (30 min)

const hoje   = new Date();
const inicio = new Date(hoje); inicio.setDate(hoje.getDate() - dias);
const dtFim  = args.ate  ?? hoje.toISOString().slice(0, 10);
const dtIni  = args.de   ?? inicio.toISOString().slice(0, 10);

console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(`  Diagnóstico de Spikes — ${dtIni} → ${dtFim}`);
console.log(`  Threshold de spike: ${maxDelta.toLocaleString('pt-BR')} páginas por coleta`);
console.log('══════════════════════════════════════════════════════════');
console.log('');

const db = new Database(DB_PATH, { readonly: true });

// ─── 1. Todos os snapshots do período + baseline pré-período ──────────────────
const rows = db.prepare(`
  WITH
  pre AS (
    SELECT impressora_id, total_paginas_dispositivo AS pag
    FROM snapshots WHERE id IN (
      SELECT MAX(id) FROM snapshots
      WHERE total_paginas_dispositivo IS NOT NULL AND date(coletado_em) < ?
      GROUP BY impressora_id
    )
  ),
  snaps AS (
    SELECT
      s.id,
      s.impressora_id,
      s.coletado_em,
      s.total_paginas_dispositivo AS pag,
      LAG(s.total_paginas_dispositivo) OVER (
        PARTITION BY s.impressora_id ORDER BY s.id
      ) AS pag_ant_periodo
    FROM snapshots s
    WHERE s.total_paginas_dispositivo IS NOT NULL
      AND date(s.coletado_em) >= ? AND date(s.coletado_em) <= ?
  )
  SELECT
    sn.id          AS snap_id,
    sn.impressora_id,
    i.setor,
    i.modelo,
    i.serie,
    sn.coletado_em,
    sn.pag,
    COALESCE(sn.pag_ant_periodo, pr.pag) AS pag_ref,
    sn.pag - COALESCE(sn.pag_ant_periodo, pr.pag) AS delta_raw
  FROM snaps sn
  JOIN impressoras i ON i.id = sn.impressora_id
  LEFT JOIN pre pr ON pr.impressora_id = sn.impressora_id
  WHERE COALESCE(sn.pag_ant_periodo, pr.pag) IS NOT NULL
  ORDER BY sn.impressora_id, sn.id
`).all(dtIni, dtIni, dtFim);

if (rows.length === 0) {
  console.log('Nenhum snapshot encontrado no período.');
  process.exit(0);
}

// ─── 2. Agrupa por impressora ─────────────────────────────────────────────────
const porImpressora = new Map();
for (const r of rows) {
  if (!porImpressora.has(r.impressora_id)) {
    porImpressora.set(r.impressora_id, {
      id:     r.impressora_id,
      setor:  r.setor,
      modelo: r.modelo,
      serie:  r.serie,
      snaps:  [],
    });
  }
  porImpressora.get(r.impressora_id).snaps.push(r);
}

// ─── 3. Calcula totais oficial vs corrigido ───────────────────────────────────
const resumo = [];

for (const imp of porImpressora.values()) {
  let totalOficial   = 0;
  let totalCorrigido = 0;
  const spikes = [];

  for (const s of imp.snaps) {
    const delta = s.delta_raw ?? 0;
    if (delta > 0) {
      totalOficial += delta;
      if (delta > maxDelta) {
        spikes.push(s);
        // Não soma ao total corrigido
      } else {
        totalCorrigido += delta;
      }
    }
    // delta ≤ 0 → ignorado pelos dois métodos (já era comportamento atual)
  }

  if (totalOficial > 0 || spikes.length > 0) {
    resumo.push({ imp, totalOficial, totalCorrigido, spikes });
  }
}

// ─── 4. Ordena pelo total oficial decrescente ──────────────────────────────────
resumo.sort((a, b) => b.totalOficial - a.totalOficial);

// ─── 5. Exibe resumo geral ────────────────────────────────────────────────────
console.log('┌─ RESUMO POR IMPRESSORA (top 20, ordenado por total oficial) ───────────────┐');
console.log(`  ${'Impressora'.padEnd(45)} ${'Oficial'.padStart(10)} ${'Corrigido'.padStart(10)} ${'Spikes'.padStart(7)}`);
console.log('─'.repeat(80));

for (const { imp, totalOficial, totalCorrigido, spikes } of resumo.slice(0, 20)) {
  const nome    = `${imp.modelo} (${imp.setor ?? 'sem setor'})`.slice(0, 44);
  const marcar  = spikes.length > 0 ? ' ◄ SPIKE' : '';
  console.log(
    `  ${nome.padEnd(45)} `
    + `${totalOficial.toLocaleString('pt-BR').padStart(10)} `
    + `${totalCorrigido.toLocaleString('pt-BR').padStart(10)} `
    + `${String(spikes.length).padStart(7)}`
    + marcar
  );
}
console.log('');

// ─── 6. Detalha cada impressora com spikes ────────────────────────────────────
const comSpikes = resumo.filter(r => r.spikes.length > 0);

if (comSpikes.length === 0) {
  console.log('✅ Nenhum spike encontrado acima do threshold no período.');
} else {
  console.log(`⚠️  ${comSpikes.length} impressora(s) com spike(s) detectado(s):`);
  console.log('');

  for (const { imp, totalOficial, totalCorrigido, spikes } of comSpikes) {
    console.log(`╔══ #${imp.id} ${imp.modelo}  |  Setor: ${imp.setor ?? 'N/A'}  |  Série: ${imp.serie ?? 'N/A'}`);
    console.log(`║   Total oficial: ${totalOficial.toLocaleString('pt-BR')} pág  →  Corrigido: ${totalCorrigido.toLocaleString('pt-BR')} pág  (removidos: ${(totalOficial - totalCorrigido).toLocaleString('pt-BR')})`);
    console.log('║');
    console.log('║   Snapshots com spike:');
    for (const s of spikes) {
      console.log(`║     snap_id=${s.snap_id}  ${s.coletado_em.slice(0, 16)}  pag=${s.pag.toLocaleString('pt-BR')}  ref=${s.pag_ref.toLocaleString('pt-BR')}  delta=+${s.delta_raw.toLocaleString('pt-BR')}`);
    }
    console.log('║');

    // Série histórica completa no período
    console.log('║   Série histórica completa no período:');
    for (const s of imp.snaps) {
      const delta   = s.delta_raw ?? 0;
      const marker  = delta > maxDelta ? '  ◄ SPIKE' : (delta < 0 ? '  ◄ reset' : '');
      console.log(`║     ${s.coletado_em.slice(0, 16)}  pag=${s.pag.toLocaleString('pt-BR').padStart(9)}  Δ=${String(delta >= 0 ? '+' + delta.toLocaleString('pt-BR') : delta.toLocaleString('pt-BR')).padStart(8)}${marker}`);
    }
    console.log('╚' + '═'.repeat(78));
    console.log('');
  }
}

// ─── 7. Calcula threshold sugerido────────────────────────────────────────────
// Máximo de páginas que uma impressora pode fazer em 30 min:
// Impressora rápida: ~70 ppm × 30 min = 2100 páginas.
// Para ser conservador, 3000 é um teto razoável para parque corporativo médio.
console.log('');
console.log('── Referência ───────────────────────────────────────────────────────────────');
console.log('   Impressoras de escritório típicas: 25–65 ppm');
console.log('   Máximo teórico (65 ppm × 30 min): 1.950 páginas/coleta');
console.log('   Threshold usado neste diagnóstico: ' + maxDelta.toLocaleString('pt-BR'));
console.log('   Para ajustar: node src/diag-spikes.js --max-delta=3000');
console.log('');

db.close();
