/**
 * PM2 Ecosystem — Monitor de Impressoras
 * ─────────────────────────────────────────────────────────────────────────────
 * O scheduler.js já sobe o servidor Express internamente e reinicia em caso de
 * falha, portanto o PM2 gerencia apenas um processo raiz.
 *
 * Uso:
 *   pm2 start ecosystem.config.cjs        # inicia
 *   pm2 stop    printer-monitor           # para
 *   pm2 restart printer-monitor           # reinicia
 *   pm2 logs    printer-monitor           # acompanha logs em tempo real
 *   pm2 save                              # persiste a lista de processos
 *   pm2 startup                           # configura início automático no boot
 */

module.exports = {
  apps: [
    {
      name        : 'printer-monitor',
      script      : 'src/scheduler.js',

      // ESM nativo — sem flags extras necessárias no Node 18+
      interpreter : 'node',

      // Não monitorar arquivos: o scheduler gerencia seus próprios filhos
      watch       : false,

      // PM2 reinicia o scheduler automaticamente se ele encerrar
      autorestart : true,
      max_restarts: 10,
      restart_delay: 5000,        // 5 s entre tentativas

      // Logs separados por tipo
      out_file    : 'logs/scheduler-out.log',
      error_file  : 'logs/scheduler-err.log',
      log_date_format: 'DD/MM/YYYY HH:mm:ss',
      merge_logs  : true,

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
