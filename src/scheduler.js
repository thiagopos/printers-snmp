/**
 * scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Inicia o servidor Express e agenda a coleta SNMP 3×/dia.
 * Horários: 08:00 · 13:00 · 18:00
 *
 * Uso:  node src/scheduler.js
 *       npm run schedule
 */

import { spawn }        from 'child_process';
import { fileURLToPath } from 'url';
import path              from 'path';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ROOT         = path.join(__dirname, '..');
const HORAS_COLETA = [8, 13, 18];

// ─── Logger ───────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  console.log(`[${ts}]  ${msg}`);
}

// ─── Servidor ─────────────────────────────────────────────────────────────────
function iniciarServidor() {
  log('🖥️  Iniciando servidor Express…');
  const srv = spawn('node', ['src/server.js'], {
    cwd:   ROOT,
    stdio: 'inherit',
  });

  srv.on('exit', code => {
    log(`⚠️  Servidor encerrado (code ${code ?? '?'}). Reiniciando em 5s…`);
    setTimeout(iniciarServidor, 5_000);
  });
}

// ─── Coleta ───────────────────────────────────────────────────────────────────
function executarColeta() {
  log('📡 Iniciando coleta SNMP (todos os modelos)…');
  const proc = spawn('node', ['src/index.js'], {
    cwd:   ROOT,
    stdio: 'inherit',
  });
  proc.on('exit', code => {
    log(code === 0
      ? '✅ Coleta concluída com sucesso.'
      : `⚠️  Coleta encerrada com code ${code}.`);
  });
}

// ─── Agendador ────────────────────────────────────────────────────────────────
function msAteProxima() {
  const agora = new Date();

  // Candidatos: próxima ocorrência de cada hora (hoje ou amanhã)
  const candidatos = HORAS_COLETA.map(h => {
    const d = new Date(agora);
    d.setHours(h, 0, 0, 0);
    if (d <= agora) d.setDate(d.getDate() + 1);
    return d;
  }).sort((a, b) => a - b);

  const proxima = candidatos[0];
  const diff    = proxima - agora;
  const hh      = String(Math.floor(diff / 3_600_000)).padStart(2, '0');
  const mm      = String(Math.floor((diff % 3_600_000) / 60_000)).padStart(2, '0');

  log(`⏰ Próxima coleta: ${proxima.toLocaleString('pt-BR')}  (em ${hh}h${mm}m)`);
  return diff;
}

function agendarProxima() {
  const ms = msAteProxima();
  setTimeout(() => {
    executarColeta();
    agendarProxima();         // reagenda após disparar
  }, ms);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
log('═══════════════════════════════════════════════════════');
log('  Monitor de Impressoras — Scheduler');
log(`  Coletas agendadas: ${HORAS_COLETA.map(h => `${String(h).padStart(2,'0')}:00`).join(' · ')}`);
log('═══════════════════════════════════════════════════════');

iniciarServidor();
agendarProxima();
