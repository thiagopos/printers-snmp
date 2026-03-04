/**
 * scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Inicia o servidor Express e agenda a coleta SNMP a cada 30 minutos
 * entre 07:00 e 19:00 (slots: :00 e :30 de cada hora).
 *
 * Uso:  node src/scheduler.js
 *       npm run schedule
 */

import { spawn }        from 'child_process';
import { fileURLToPath } from 'url';
import path              from 'path';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '..');
const HORA_INICIO = 7;   // 07:00 — primeiro slot do dia
const HORA_FIM    = 19;  // 19:00 — último slot permitido (inclusive)

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
    cwd:         ROOT,
    stdio:       'inherit',
    windowsHide: true,
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
    cwd:         ROOT,
    stdio:       'inherit',
    windowsHide: true,
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

  // Próximo slot de 30 min (minuto 0 ou 30) estritamente após agora
  const proxima = new Date(agora);
  proxima.setSeconds(0, 0);
  proxima.setMinutes(proxima.getMinutes() < 30 ? 30 : 0);
  if (proxima.getMinutes() === 0) proxima.setHours(proxima.getHours() + 1);
  if (proxima <= agora) proxima.setMinutes(proxima.getMinutes() + 30); // segurança

  // Se o slot calculado está fora da janela, avança para 07:00 do próximo dia útil
  if (proxima.getHours() > HORA_FIM
      || (proxima.getHours() === HORA_FIM && proxima.getMinutes() > 0)
      || proxima.getHours() < HORA_INICIO) {
    proxima.setDate(proxima.getDate() + (proxima.getHours() >= HORA_FIM ? 1 : 0));
    proxima.setHours(HORA_INICIO, 0, 0, 0);
  }

  const diff = proxima - agora;
  const hh   = String(Math.floor(diff / 3_600_000)).padStart(2, '0');
  const mm   = String(Math.floor((diff % 3_600_000) / 60_000)).padStart(2, '0');

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
log(`  Coletas: a cada 30 min · ${String(HORA_INICIO).padStart(2,'0')}:00 – ${String(HORA_FIM).padStart(2,'0')}:00`);
log('═══════════════════════════════════════════════════════');

iniciarServidor();
agendarProxima();
