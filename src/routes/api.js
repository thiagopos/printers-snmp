import { Router } from 'express';import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Lookups para detecção de backup / impressora trocada ─────────────────────────
const _printers      = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/printers.json'), 'utf-8'));
const _backups       = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/backup.json'),   'utf-8'));
const expectedSerial = new Map(_printers.map(p => [p['IP Liberty'], p['SÉRIE']]));
const backupMap      = new Map(_backups.map(b  => [b['SÉRIE'],      b['BACKUPS']]));
// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Dias restantes estimados para um consumível com base no histórico completo.
 * Usa a taxa entre o primeiro e o último ponto com dado válido.
 */
function calcDiasRestantes(historico, nomeCons) {
  const pontos = historico
    .map(s => {
      const c = s.consumiveis.find(c => c.nome === nomeCons);
      return c?.percentual != null ? { t: new Date(s.coletado_em).getTime(), pct: c.percentual } : null;
    })
    .filter(Boolean);

  if (pontos.length < 2) return null;

  const first     = pontos[0];
  const last      = pontos[pontos.length - 1];
  const deltaDias = (last.t - first.t) / 86_400_000;
  const deltaPct  = first.pct - last.pct; // positivo = consumido

  if (deltaDias <= 0 || deltaPct <= 0) return null;

  return Math.round(last.pct / (deltaPct / deltaDias));
}

// ─── Rotas ────────────────────────────────────────────────────────────────────
export function criarRotasApi(db) {
  const router = Router();

  // ── GET /api/summary (?periodo=total|mes|semana  OU  ?de=YYYY-MM-DD&ate=YYYY-MM-DD) ────
  router.get('/summary', (req, res) => {
    const VALIDOS = ['total', 'mes', 'semana'];
    const periodo = VALIDOS.includes(req.query.periodo) ? req.query.periodo : null;
    // Filtro de data livre
    const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
    const de  = ISO_RE.test(req.query.de  ?? '') ? req.query.de  : null;
    const ate = ISO_RE.test(req.query.ate ?? '') ? req.query.ate : null;
    const usandoIntervalo = de && ate;

    const total = db.prepare('SELECT COUNT(*) as n FROM impressoras').get().n;

    const onlineHoje = db.prepare(`
      SELECT COUNT(DISTINCT impressora_id) as n
      FROM snapshots
      WHERE date(coletado_em) = date('now')
    `).get().n;

    // Nível de todos os toners no último snapshot de cada impressora
    const niveis = db.prepare(`
      WITH ultimos AS (
        SELECT impressora_id, MAX(id) as snap_id FROM snapshots GROUP BY impressora_id
      )
      SELECT c.percentual
      FROM consumiveis_snapshot c
      JOIN ultimos u ON c.snapshot_id = u.snap_id
      WHERE c.percentual IS NOT NULL
        AND (c.nome LIKE '%Toner%' OR c.nome LIKE '%Cartucho%')
        AND c.nome NOT LIKE '%Unidade%'
        AND c.nome NOT LIKE '%Coleta%'
    `).all();

    const criticos = niveis.filter(r => r.percentual < 10).length;
    const atencao  = niveis.filter(r => r.percentual >= 10 && r.percentual < 20).length;
    const ok       = niveis.filter(r => r.percentual >= 20).length;

    let topPaginas;

    if (!usandoIntervalo && periodo === 'total') {
      // Máximo histórico por impressora
      topPaginas = db.prepare(`
        WITH ultimos AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) as total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
          GROUP BY impressora_id
        )
        SELECT i.setor, SUM(u.total) as total_paginas
        FROM impressoras i
        JOIN ultimos u ON u.impressora_id = i.id
        GROUP BY i.setor
        ORDER BY total_paginas DESC
        LIMIT 10
      `).all();
    } else {
      // Janela de tempo: período fixo ou intervalo livre
      let dtInicio, dtFim;
      if (usandoIntervalo) {
        dtInicio = de;
        dtFim    = ate;
      } else {
        const dias = (periodo === 'mes') ? 30 : 7;   // default = semana
        const hoje    = new Date();
        const inicioD = new Date(hoje); inicioD.setDate(hoje.getDate() - dias);
        dtFim    = hoje.toISOString().slice(0, 10);
        dtInicio = inicioD.toISOString().slice(0, 10);
      }

      topPaginas = db.prepare(`
        WITH
        fim AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) AS total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) <= ?
            AND date(coletado_em) >= ?
          GROUP BY impressora_id
        ),
        inicio AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) AS total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) < ?
          GROUP BY impressora_id
        ),
        inicio_fallback AS (
          SELECT impressora_id, MIN(total_paginas_dispositivo) AS total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) >= ?
            AND date(coletado_em) <= ?
          GROUP BY impressora_id
        )
        SELECT i.setor,
               SUM(f.total - COALESCE(ini.total, ifb.total)) AS total_paginas
        FROM impressoras i
        JOIN fim f             ON f.impressora_id   = i.id
        LEFT JOIN inicio ini   ON ini.impressora_id = i.id
        LEFT JOIN inicio_fallback ifb ON ifb.impressora_id = i.id
        GROUP BY i.setor
        HAVING total_paginas > 0
        ORDER BY total_paginas DESC
        LIMIT 10
      `).all(dtFim, dtInicio, dtInicio, dtInicio, dtFim);
    }

    const modoAtivo = usandoIntervalo ? 'intervalo' : (periodo ?? 'semana');
    res.json({ total, online_hoje: onlineHoje, criticos, atencao, ok, top_paginas: topPaginas, periodo: modoAtivo, de, ate });
  });

  // ── GET /api/impressoras ────────────────────────────────────────────────────
  router.get('/impressoras', (req, res) => {
    const impressoras = db.prepare(`
      SELECT i.*,
             s.id           AS snap_id,
             s.coletado_em,
             s.total_paginas_dispositivo,
             s.total_duplex,
             s.alerta,
             s.mensagem_tela
      FROM impressoras i
      LEFT JOIN snapshots s ON s.id = (
        SELECT id FROM snapshots WHERE impressora_id = i.id ORDER BY coletado_em DESC LIMIT 1
      )
      ORDER BY i.setor
    `).all();

    const getConsums = db.prepare(
      'SELECT * FROM consumiveis_snapshot WHERE snapshot_id = ? ORDER BY nome'
    );

    // Previsão de dias restantes: regressão linear simples usando
    // o primeiro e o último ponto de cada consumível por impressora.
    const diasRows = db.prepare(`
      WITH ordered AS (
        SELECT s.impressora_id, cs.nome, cs.percentual, s.coletado_em,
          ROW_NUMBER() OVER (PARTITION BY s.impressora_id, cs.nome ORDER BY s.coletado_em ASC)  AS rn_asc,
          ROW_NUMBER() OVER (PARTITION BY s.impressora_id, cs.nome ORDER BY s.coletado_em DESC) AS rn_desc,
          COUNT(*)     OVER (PARTITION BY s.impressora_id, cs.nome)                             AS pts
        FROM consumiveis_snapshot cs
        JOIN snapshots s ON cs.snapshot_id = s.id
        WHERE cs.percentual IS NOT NULL
      ),
      fl AS (
        SELECT impressora_id, nome,
          MAX(CASE WHEN rn_asc  = 1 THEN percentual  END) AS pct_first,
          MAX(CASE WHEN rn_asc  = 1 THEN coletado_em END) AS t_first,
          MAX(CASE WHEN rn_desc = 1 THEN percentual  END) AS pct_last,
          MAX(CASE WHEN rn_desc = 1 THEN coletado_em END) AS t_last,
          MAX(pts) AS pts
        FROM ordered GROUP BY impressora_id, nome
      )
      SELECT impressora_id, nome,
        CASE
          WHEN pts >= 2
           AND pct_first > pct_last
           AND julianday(t_last) > julianday(t_first)
          THEN CAST(ROUND(
            pct_last / ((pct_first - pct_last) / (julianday(t_last) - julianday(t_first)))
          ) AS INTEGER)
          ELSE NULL
        END AS dias_restantes
      FROM fl
    `).all();

    // Monta lookup: impressora_id → { nome → dias_restantes }
    const diasMap = {};
    for (const row of diasRows) {
      if (!diasMap[row.impressora_id]) diasMap[row.impressora_id] = {};
      diasMap[row.impressora_id][row.nome] = row.dias_restantes;
    }

    const resultado = impressoras.map(({ snap_id, ...imp }) => {
      // ── Detecção de backup / impressora trocada ─────────────────────────────
      const esperada = expectedSerial.get(imp.ip_liberty) ?? null;
      const atual    = imp.serie_snmp ?? null;
      let status_serie = 'ok';
      let serie_info   = { esperada, atual };

      if (esperada && atual && atual !== esperada) {
        if (backupMap.has(atual)) {
          status_serie = 'backup';
          serie_info.backup_nome = backupMap.get(atual);
        } else {
          status_serie = 'trocada';
        }
      }

      return {
        ...imp,
        consumiveis:    snap_id ? getConsums.all(snap_id) : [],
        dias_restantes: diasMap[imp.id] ?? {},
        status_serie,
        serie_info,
      };
    });

    res.json(resultado);
  });

  // ── GET /api/impressora/:id ─────────────────────────────────────────────────
  router.get('/impressora/:id', (req, res) => {
    const id = parseInt(req.params.id);

    const impressora = db.prepare('SELECT * FROM impressoras WHERE id = ?').get(id);
    if (!impressora) return res.status(404).json({ erro: 'Não encontrada' });

    const snaps = db.prepare(`
      SELECT id, coletado_em, total_paginas_dispositivo, total_duplex, alerta, mensagem_tela
      FROM snapshots
      WHERE impressora_id = ?
      ORDER BY coletado_em ASC
    `).all(id);

    const getConsums = db.prepare(
      'SELECT * FROM consumiveis_snapshot WHERE snapshot_id = ? ORDER BY nome'
    );

    const historico = snaps.map(s => ({ ...s, consumiveis: getConsums.all(s.id) }));

    // Dias restantes por consumível
    const nomesConsums = [...new Set(historico.flatMap(s => s.consumiveis.map(c => c.nome)))];
    const diasRestantes = Object.fromEntries(
      nomesConsums.map(nome => [nome, calcDiasRestantes(historico, nome)])
    );

    // Histórico de cartuchos: seriais únicos encontrados
    const vistos    = new Set();
    const cartuchos = [];
    for (const snap of historico) {
      for (const c of snap.consumiveis) {
        if (!c.toner_serial && !c.toner_pn) continue;
        const chave = `${c.nome}|${c.toner_serial ?? c.toner_pn}`;
        if (!vistos.has(chave)) {
          vistos.add(chave);
          cartuchos.push({ ...c, primeiro_visto: snap.coletado_em });
        }
      }
    }

    res.json({ impressora, historico, dias_restantes: diasRestantes, cartuchos });
  });

  return router;
}
