import { Router } from 'express';

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

  // ── GET /api/summary ────────────────────────────────────────────────────────
  router.get('/summary', (req, res) => {
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
    `).all();

    const criticos = niveis.filter(r => r.percentual < 10).length;
    const atencao  = niveis.filter(r => r.percentual >= 10 && r.percentual < 20).length;
    const ok       = niveis.filter(r => r.percentual >= 20).length;

    const topPaginas = db.prepare(`
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

    res.json({ total, online_hoje: onlineHoje, criticos, atencao, ok, top_paginas: topPaginas });
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

    const resultado = impressoras.map(({ snap_id, ...imp }) => ({
      ...imp,
      consumiveis:    snap_id ? getConsums.all(snap_id) : [],
      dias_restantes: diasMap[imp.id] ?? {},
    }));

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
