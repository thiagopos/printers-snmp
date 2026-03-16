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

function calcMetricasImpressao(totalImpressoes, totalDuplex) {
  const total = Number.isFinite(totalImpressoes) ? totalImpressoes : null;
  const duplex = Number.isFinite(totalDuplex)
    ? Math.max(0, total != null ? Math.min(totalDuplex, total) : totalDuplex)
    : null;

  return {
    total,
    duplex,
    frente: total != null && duplex != null ? Math.max(0, total - duplex) : null,
    folhas: total != null && duplex != null ? Math.max(0, total - (duplex / 2)) : total,
  };
}

// Teto de delta por coleta: Samsung M4020 = 40 ppm, HP E52645 = 45 ppm → máx ~1.950 pág em 30 min.
// Qualquer delta individual acima deste valor é um glitch de firmware do contador SNMP e é ignorado.
const MAX_DELTA_PAGINAS = 2000;

// ─── Rotas ────────────────────────────────────────────────────────────────────
export function criarRotasApi(db) {
  const router = Router();

  // ── Detecção de backup / impressora trocada (carregado do banco) ────────────
  // expectedSerial: ip_liberty → serie cadastrada (esperada)
  const expectedSerial = new Map(
    db.prepare('SELECT ip_liberty, serie FROM impressoras WHERE serie IS NOT NULL').all()
      .map(r => [r.ip_liberty, r.serie])
  );
  // backupMap: serie → backup_nome
  const backupMap = new Map(
    db.prepare('SELECT serie, backup_nome FROM equipamentos WHERE is_backup = 1').all()
      .map(r => [r.serie, r.backup_nome])
  );
  // Total de equipamentos configurados (ativos + backups)
  const totalConfig = db.prepare('SELECT COUNT(*) AS n FROM impressoras').get().n
                    + db.prepare('SELECT COUNT(*) AS n FROM equipamentos WHERE is_backup = 1').get().n;

  // Helper: re-sync backupMap quando equipamentos mudam via API
  function syncBackupMap() {
    backupMap.clear();
    db.prepare('SELECT serie, backup_nome FROM equipamentos WHERE is_backup = 1').all()
      .forEach(r => backupMap.set(r.serie, r.backup_nome));
  }

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

    const criticos = niveis.filter(r => r.percentual <  5).length;
    const atencao  = niveis.filter(r => r.percentual >=  5 && r.percentual < 20).length;
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
        SELECT i.id, i.setor, i.modelo, u.total as total_paginas,
               l.nome_setor, l.local_instalacao, l.predio, l.andar
        FROM impressoras i
        JOIN ultimos u ON u.impressora_id = i.id
        LEFT JOIN locais l ON l.id = i.local_id
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
        -- Baseline: último snapshot ANTES do período (por impressora)
        pre_periodo AS (
          SELECT impressora_id, total_paginas_dispositivo AS pag
          FROM snapshots WHERE id IN (
            SELECT MAX(id) FROM snapshots
            WHERE total_paginas_dispositivo IS NOT NULL AND date(coletado_em) < ?
            GROUP BY impressora_id
          )
        ),
        -- Snapshots dentro do período com valor anterior (LAG)
        snaps_periodo AS (
          SELECT impressora_id,
                 total_paginas_dispositivo AS pag,
                 LAG(total_paginas_dispositivo) OVER (PARTITION BY impressora_id ORDER BY id) AS pag_ant
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) >= ? AND date(coletado_em) <= ?
        ),
        -- Soma apenas deltas positivos e abaixo do teto anti-spike (ignora resets e glitches de firmware)
        delta AS (
          SELECT sp.impressora_id,
            SUM(CASE WHEN sp.pag > COALESCE(sp.pag_ant, pp.pag)
                          AND sp.pag - COALESCE(sp.pag_ant, pp.pag) <= ${MAX_DELTA_PAGINAS}
                     THEN sp.pag - COALESCE(sp.pag_ant, pp.pag) ELSE 0 END) AS total_paginas
          FROM snaps_periodo sp
          LEFT JOIN pre_periodo pp ON pp.impressora_id = sp.impressora_id
          WHERE COALESCE(sp.pag_ant, pp.pag) IS NOT NULL
          GROUP BY sp.impressora_id
        )
        SELECT i.id, i.setor, i.modelo, d.total_paginas,
               l.nome_setor, l.local_instalacao, l.predio, l.andar
        FROM impressoras i
        JOIN delta d ON d.impressora_id = i.id
        LEFT JOIN locais l ON l.id = i.local_id
        WHERE d.total_paginas > 0
        ORDER BY d.total_paginas DESC
        LIMIT 10
      `).all(dtInicio, dtInicio, dtFim);
    }

    // ── Resmas por semana (janela fixa de 7 dias, independente do período selecionado) ──
    const hoje7    = new Date();
    const inicio7  = new Date(hoje7); inicio7.setDate(hoje7.getDate() - 7);
    const dtFim7   = hoje7.toISOString().slice(0, 10);
    const dtIni7   = inicio7.toISOString().slice(0, 10);

    const semanaRow = db.prepare(`
      WITH
      -- Páginas: baseline pré-período
      pre_p AS (
        SELECT impressora_id, total_paginas_dispositivo AS pag
        FROM snapshots WHERE id IN (
          SELECT MAX(id) FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL AND date(coletado_em) < ?
          GROUP BY impressora_id
        )
      ),
      snaps_p AS (
        SELECT impressora_id,
               total_paginas_dispositivo AS pag,
               LAG(total_paginas_dispositivo) OVER (PARTITION BY impressora_id ORDER BY id) AS pag_ant
        FROM snapshots
        WHERE total_paginas_dispositivo IS NOT NULL
          AND date(coletado_em) >= ? AND date(coletado_em) <= ?
      ),
      delta_p AS (
        SELECT sp.impressora_id,
          SUM(CASE WHEN sp.pag > COALESCE(sp.pag_ant, pp.pag)
                        AND sp.pag - COALESCE(sp.pag_ant, pp.pag) <= ${MAX_DELTA_PAGINAS}
                   THEN sp.pag - COALESCE(sp.pag_ant, pp.pag) ELSE 0 END) AS delta
        FROM snaps_p sp LEFT JOIN pre_p pp ON pp.impressora_id = sp.impressora_id
        WHERE COALESCE(sp.pag_ant, pp.pag) IS NOT NULL
        GROUP BY sp.impressora_id
      ),
      -- Duplex: baseline pré-período
      pre_d AS (
        SELECT impressora_id, total_duplex AS dup
        FROM snapshots WHERE id IN (
          SELECT MAX(id) FROM snapshots
          WHERE total_duplex IS NOT NULL AND date(coletado_em) < ?
          GROUP BY impressora_id
        )
      ),
      snaps_d AS (
        SELECT impressora_id,
               total_duplex AS dup,
               LAG(total_duplex) OVER (PARTITION BY impressora_id ORDER BY id) AS dup_ant
        FROM snapshots
        WHERE total_duplex IS NOT NULL
          AND date(coletado_em) >= ? AND date(coletado_em) <= ?
      ),
      delta_d AS (
        SELECT sd.impressora_id,
          SUM(CASE WHEN sd.dup > COALESCE(sd.dup_ant, pd.dup)
                   THEN sd.dup - COALESCE(sd.dup_ant, pd.dup) ELSE 0 END) AS delta
        FROM snaps_d sd LEFT JOIN pre_d pd ON pd.impressora_id = sd.impressora_id
        WHERE COALESCE(sd.dup_ant, pd.dup) IS NOT NULL
        GROUP BY sd.impressora_id
      )
      SELECT
        (SELECT COALESCE(SUM(delta), 0) FROM delta_p) AS paginas,
        (SELECT COALESCE(SUM(delta), 0) FROM delta_d) AS duplex
    `).get(dtIni7, dtIni7, dtFim7, dtIni7, dtIni7, dtFim7);

    const folhasSemana = Math.max(0, (semanaRow.paginas ?? 0) - ((semanaRow.duplex ?? 0) / 2));
    const resmasSemana = Math.ceil(folhasSemana / 500);

    const modoAtivo = usandoIntervalo ? 'intervalo' : (periodo ?? 'semana');
    res.json({ total, total_config: totalConfig, online_hoje: onlineHoje, criticos, atencao, ok, top_paginas: topPaginas, resmas_semana: resmasSemana, periodo: modoAtivo, de, ate });
  });

  // ── GET /api/impressoras/consumo  (?setor=...&periodo=total|mes|semana  OU  ?setor=...&de=&ate=) ──
  router.get('/impressoras/consumo', (req, res) => {
    const setor = req.query.setor ?? null;
    if (!setor) return res.status(400).json({ erro: 'Parâmetro setor obrigatório' });

    const VALIDOS = ['total', 'mes', 'semana'];
    const periodo = VALIDOS.includes(req.query.periodo) ? req.query.periodo : null;
    const ISO_RE  = /^\d{4}-\d{2}-\d{2}$/;
    const de  = ISO_RE.test(req.query.de  ?? '') ? req.query.de  : null;
    const ate = ISO_RE.test(req.query.ate ?? '') ? req.query.ate : null;
    const usandoIntervalo = de && ate;

    let rows;

    if (!usandoIntervalo && periodo === 'total') {
      rows = db.prepare(`
        WITH ultimos_p AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) AS total_pag
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
          GROUP BY impressora_id
        ),
        ultimos_d AS (
          SELECT impressora_id, MAX(total_duplex) AS total_dup
          FROM snapshots
          WHERE total_duplex IS NOT NULL
          GROUP BY impressora_id
        )
        SELECT i.id AS impressora_id, i.modelo,
               COALESCE(up.total_pag, 0) AS faces,
               COALESCE(ud.total_dup, 0) AS duplex
        FROM impressoras i
        JOIN ultimos_p up ON up.impressora_id = i.id
        LEFT JOIN ultimos_d ud ON ud.impressora_id = i.id
        WHERE i.setor = ?
        ORDER BY faces DESC
      `).all(setor);
    } else {
      let dtInicio, dtFim;
      if (usandoIntervalo) {
        dtInicio = de;
        dtFim    = ate;
      } else {
        const dias   = (periodo === 'mes') ? 30 : 7;
        const hoje   = new Date();
        const inicio = new Date(hoje); inicio.setDate(hoje.getDate() - dias);
        dtFim    = hoje.toISOString().slice(0, 10);
        dtInicio = inicio.toISOString().slice(0, 10);
      }

      rows = db.prepare(`
        WITH
        pre_p AS (
          SELECT impressora_id, total_paginas_dispositivo AS pag
          FROM snapshots WHERE id IN (
            SELECT MAX(id) FROM snapshots
            WHERE total_paginas_dispositivo IS NOT NULL AND date(coletado_em) < ?
            GROUP BY impressora_id
          )
        ),
        snaps_p AS (
          SELECT impressora_id,
                 total_paginas_dispositivo AS pag,
                 LAG(total_paginas_dispositivo) OVER (PARTITION BY impressora_id ORDER BY id) AS pag_ant
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) >= ? AND date(coletado_em) <= ?
        ),
        delta_p AS (
          SELECT sp.impressora_id,
            SUM(CASE WHEN sp.pag > COALESCE(sp.pag_ant, pp.pag)
                          AND sp.pag - COALESCE(sp.pag_ant, pp.pag) <= ${MAX_DELTA_PAGINAS}
                     THEN sp.pag - COALESCE(sp.pag_ant, pp.pag) ELSE 0 END) AS faces
          FROM snaps_p sp LEFT JOIN pre_p pp ON pp.impressora_id = sp.impressora_id
          WHERE COALESCE(sp.pag_ant, pp.pag) IS NOT NULL
          GROUP BY sp.impressora_id
        ),
        pre_d AS (
          SELECT impressora_id, total_duplex AS dup
          FROM snapshots WHERE id IN (
            SELECT MAX(id) FROM snapshots
            WHERE total_duplex IS NOT NULL AND date(coletado_em) < ?
            GROUP BY impressora_id
          )
        ),
        snaps_d AS (
          SELECT impressora_id,
                 total_duplex AS dup,
                 LAG(total_duplex) OVER (PARTITION BY impressora_id ORDER BY id) AS dup_ant
          FROM snapshots
          WHERE total_duplex IS NOT NULL
            AND date(coletado_em) >= ? AND date(coletado_em) <= ?
        ),
        delta_d AS (
          SELECT sd.impressora_id,
            SUM(CASE WHEN sd.dup > COALESCE(sd.dup_ant, pd.dup)
                     THEN sd.dup - COALESCE(sd.dup_ant, pd.dup) ELSE 0 END) AS duplex
          FROM snaps_d sd LEFT JOIN pre_d pd ON pd.impressora_id = sd.impressora_id
          WHERE COALESCE(sd.dup_ant, pd.dup) IS NOT NULL
          GROUP BY sd.impressora_id
        )
        SELECT i.id AS impressora_id, i.modelo,
               COALESCE(dp.faces, 0) AS faces,
               COALESCE(dd.duplex, 0) AS duplex
        FROM impressoras i
        JOIN delta_p dp ON dp.impressora_id = i.id
        LEFT JOIN delta_d dd ON dd.impressora_id = i.id
        WHERE i.setor = ?
        ORDER BY faces DESC
      `).all(dtInicio, dtInicio, dtFim, dtInicio, dtInicio, dtFim, setor);
    }

    const data = rows.map(r => {
      const metricas = calcMetricasImpressao(r.faces, r.duplex);
      const folhas = metricas.folhas ?? 0;
      const resmas = Math.ceil(folhas / 500);
      return {
        impressora_id: r.impressora_id,
        modelo: r.modelo,
        faces: metricas.total ?? 0,
        duplex: metricas.duplex ?? 0,
        frente: metricas.frente ?? 0,
        folhas,
        resmas,
      };
    });

    res.json({ data });
  });

  // ── GET /api/impressoras ────────────────────────────────────────────────────
  router.get('/impressoras', (req, res) => {
    const impressoras = db.prepare(`
      SELECT i.*,
             l.nome_setor, l.local_instalacao, l.predio, l.andar AS local_andar,
             e.modelo AS equip_modelo, e.serie AS equip_serie,
             e.is_backup AS equip_is_backup, e.backup_nome AS equip_backup_nome,
             s.id           AS snap_id,
             s.coletado_em,
             s.total_paginas_dispositivo,
             s.total_duplex,
             s.alerta,
             s.mensagem_tela
      FROM impressoras i
      LEFT JOIN locais      l ON l.id = i.local_id
      LEFT JOIN equipamentos e ON e.id = i.equipamento_id
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

    const resultado = impressoras.map(({ snap_id,
        nome_setor, local_instalacao, predio, local_andar,
        equip_modelo, equip_serie, equip_is_backup, equip_backup_nome,
        ...imp }) => {
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
        // Campos estruturados novos:
        local: imp.local_id ? {
          id: imp.local_id, nome_setor, local_instalacao, predio, andar: local_andar,
        } : null,
        equipamento: imp.equipamento_id ? {
          id: imp.equipamento_id, modelo: equip_modelo, serie: equip_serie,
          is_backup: equip_is_backup, backup_nome: equip_backup_nome,
        } : null,
      };
    });

    res.json(resultado);
  });

  // ── GET /api/impressora/:id ─────────────────────────────────────────────────
  router.get('/impressora/:id', (req, res) => {
    const id = parseInt(req.params.id);

    const row = db.prepare(`
      SELECT i.*,
             l.nome_setor, l.local_instalacao, l.predio, l.andar AS local_andar,
             e.modelo AS equip_modelo, e.serie AS equip_serie,
             e.is_backup AS equip_is_backup, e.backup_nome AS equip_backup_nome
      FROM impressoras i
      LEFT JOIN locais       l ON l.id = i.local_id
      LEFT JOIN equipamentos e ON e.id = i.equipamento_id
      WHERE i.id = ?
    `).get(id);
    if (!row) return res.status(404).json({ erro: 'Não encontrada' });

    const { nome_setor, local_instalacao, predio, local_andar,
            equip_modelo, equip_serie, equip_is_backup, equip_backup_nome,
            ...impressora } = row;

    const local = row.local_id ? {
      id: row.local_id, nome_setor, local_instalacao, predio, andar: local_andar,
    } : null;
    const equipamento = row.equipamento_id ? {
      id: row.equipamento_id, modelo: equip_modelo, serie: equip_serie,
      is_backup: equip_is_backup, backup_nome: equip_backup_nome,
    } : null;

    // ── Detecção de backup / impressora trocada ──────────────────────────────
    const esperadaSingle = expectedSerial.get(impressora.ip_liberty) ?? null;
    const atualSingle    = impressora.serie_snmp ?? null;
    let status_serie = 'ok';
    let serie_info   = { esperada: esperadaSingle, atual: atualSingle };
    if (esperadaSingle && atualSingle && atualSingle !== esperadaSingle) {
      if (backupMap.has(atualSingle)) {
        status_serie = 'backup';
        serie_info.backup_nome = backupMap.get(atualSingle);
      } else {
        status_serie = 'trocada';
      }
    }
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

    const trocas = db.prepare(`
      SELECT * FROM trocas_insumo
      WHERE impressora_id = ?
      ORDER BY ocorrido_em DESC
    `).all(id);

    res.json({ impressora, local, equipamento, historico, dias_restantes: diasRestantes, cartuchos, status_serie, serie_info, trocas });
  });

  // ── GET /api/setores-paginas  (?periodo=total|mes|semana  OU  ?de=&ate=  OU  ?predio=) ──
  // Igual ao top_paginas do /summary mas sem LIMIT (todos os setores)
  router.get('/setores-paginas', (req, res) => {
    const VALIDOS = ['total', 'mes', 'semana'];
    const periodo = VALIDOS.includes(req.query.periodo) ? req.query.periodo : null;
    const ISO_RE  = /^\d{4}-\d{2}-\d{2}$/;
    const de  = ISO_RE.test(req.query.de  ?? '') ? req.query.de  : null;
    const ate = ISO_RE.test(req.query.ate ?? '') ? req.query.ate : null;
    const usandoIntervalo = de && ate;
    const predio = req.query.predio ?? null; // filtro opcional por prédio

    let setores;

    if (!usandoIntervalo && periodo === 'total') {
      setores = db.prepare(`
        WITH ultimos AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) as total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
          GROUP BY impressora_id
        )
        SELECT i.id, i.setor, i.modelo, u.total as total_paginas,
               l.nome_setor, l.local_instalacao, l.predio, l.andar
        FROM impressoras i
        JOIN ultimos u ON u.impressora_id = i.id
        LEFT JOIN locais l ON l.id = i.local_id
        WHERE (@predio IS NULL OR l.predio = @predio)
        ORDER BY total_paginas DESC
      `).all({ predio });
    } else {
      let dtInicio, dtFim;
      if (usandoIntervalo) {
        dtInicio = de;
        dtFim    = ate;
      } else {
        const dias  = (periodo === 'mes') ? 30 : 7;
        const hoje  = new Date();
        const inicio = new Date(hoje); inicio.setDate(hoje.getDate() - dias);
        dtFim    = hoje.toISOString().slice(0, 10);
        dtInicio = inicio.toISOString().slice(0, 10);
      }

      setores = db.prepare(`
        WITH
        pre_periodo AS (
          SELECT impressora_id, total_paginas_dispositivo AS pag
          FROM snapshots WHERE id IN (
            SELECT MAX(id) FROM snapshots
            WHERE total_paginas_dispositivo IS NOT NULL AND date(coletado_em) < @dtInicio
            GROUP BY impressora_id
          )
        ),
        snaps_periodo AS (
          SELECT impressora_id,
                 total_paginas_dispositivo AS pag,
                 LAG(total_paginas_dispositivo) OVER (PARTITION BY impressora_id ORDER BY id) AS pag_ant
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) >= @dtInicio AND date(coletado_em) <= @dtFim
        ),
        delta AS (
          SELECT sp.impressora_id,
            SUM(CASE WHEN sp.pag > COALESCE(sp.pag_ant, pp.pag)
                          AND sp.pag - COALESCE(sp.pag_ant, pp.pag) <= ${MAX_DELTA_PAGINAS}
                     THEN sp.pag - COALESCE(sp.pag_ant, pp.pag) ELSE 0 END) AS total_paginas
          FROM snaps_periodo sp
          LEFT JOIN pre_periodo pp ON pp.impressora_id = sp.impressora_id
          WHERE COALESCE(sp.pag_ant, pp.pag) IS NOT NULL
          GROUP BY sp.impressora_id
        )
        SELECT i.id, i.setor, i.modelo, d.total_paginas,
               l.nome_setor, l.local_instalacao, l.predio, l.andar
        FROM impressoras i
        JOIN delta d ON d.impressora_id = i.id
        LEFT JOIN locais l ON l.id = i.local_id
        WHERE d.total_paginas > 0
          AND (@predio IS NULL OR l.predio = @predio)
        ORDER BY total_paginas DESC
      `).all({ dtFim, dtInicio, predio });
    }

    const modoAtivo = usandoIntervalo ? 'intervalo' : (periodo ?? 'semana');
    res.json({ impressoras: setores, periodo: modoAtivo, de: de ?? null, ate: ate ?? null, predio: predio ?? null });
  });

  // ── GET /api/locais ─────────────────────────────────────────────────────────
  // Lista todos os pontos de rede com sua impressora atual
  router.get('/locais', (req, res) => {
    const predio = req.query.predio ?? null;
    const rows = db.prepare(`
      SELECT l.*,
             i.id         AS impressora_id,
             i.modelo,
             i.serie_snmp,
             i.serie      AS serie_cadastrada,
             e.is_backup  AS equip_is_backup
      FROM locais l
      LEFT JOIN impressoras  i ON i.local_id      = l.id
      LEFT JOIN equipamentos e ON e.id            = i.equipamento_id
      WHERE (@predio IS NULL OR l.predio = @predio)
      ORDER BY l.andar, l.nome_setor, l.local_instalacao
    `).all({ predio });
    res.json(rows);
  });

  // ── PUT /api/locais/:id ─────────────────────────────────────────────────────
  // Atualiza campos de um local (principalmente predio, nome_setor, local_instalacao)
  router.put('/locais/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { predio, nome_setor, local_instalacao, andar, ativo } = req.body ?? {};

    const fields = [], values = [];
    if (predio           !== undefined) { fields.push('predio = ?');           values.push(predio); }
    if (nome_setor       !== undefined) { fields.push('nome_setor = ?');       values.push(nome_setor); }
    if (local_instalacao !== undefined) { fields.push('local_instalacao = ?'); values.push(local_instalacao); }
    if (andar            !== undefined) { fields.push('andar = ?');            values.push(andar); }
    if (ativo            !== undefined) { fields.push('ativo = ?');            values.push(ativo ? 1 : 0); }

    if (!fields.length) return res.status(400).json({ erro: 'Nenhum campo para atualizar' });

    const result = db.prepare(`UPDATE locais SET ${fields.join(', ')} WHERE id = ?`)
                     .run(...values, id);
    if (!result.changes) return res.status(404).json({ erro: 'Local não encontrado' });

    res.json(db.prepare('SELECT * FROM locais WHERE id = ?').get(id));
  });

  // ── GET /api/equipamentos ───────────────────────────────────────────────────
  // Lista todos os equipamentos (ativos e backups) com local atual
  router.get('/equipamentos', (req, res) => {
    const soBackups = req.query.backup === '1';
    const rows = db.prepare(`
      SELECT e.*,
             i.id    AS impressora_id,
             i.setor AS impressora_setor,
             i.ip_liberty,
             l.nome_setor, l.local_instalacao, l.predio
      FROM equipamentos e
      LEFT JOIN impressoras  i ON i.equipamento_id = e.id
      LEFT JOIN locais       l ON l.id             = i.local_id
      WHERE (@soBackups = 0 OR e.is_backup = 1)
      ORDER BY e.is_backup, e.modelo, e.serie
    `).all({ soBackups: soBackups ? 1 : 0 });
    res.json(rows);
  });

  // ── GET /api/equipamentos/:id ───────────────────────────────────────────────
  router.get('/equipamentos/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const row = db.prepare(`
      SELECT e.*,
             i.id    AS impressora_id,
             i.setor AS impressora_setor,
             i.ip_liberty,
             l.nome_setor, l.local_instalacao, l.predio
      FROM equipamentos e
      LEFT JOIN impressoras  i ON i.equipamento_id = e.id
      LEFT JOIN locais       l ON l.id             = i.local_id
      WHERE e.id = ?
    `).get(id);
    if (!row) return res.status(404).json({ erro: 'Equipamento não encontrado' });
    res.json(row);
  });

  // ── PUT /api/equipamentos/:id ───────────────────────────────────────────────
  // Atualiza campos de um equipamento (is_backup, backup_nome, notas, etc.)
  router.put('/equipamentos/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { modelo, serie, is_backup, backup_nome, notas } = req.body ?? {};

    const fields = [], values = [];
    if (modelo      !== undefined) { fields.push('modelo = ?');      values.push(modelo); }
    if (serie       !== undefined) { fields.push('serie = ?');       values.push(serie); }
    if (is_backup   !== undefined) { fields.push('is_backup = ?');   values.push(is_backup ? 1 : 0); }
    if (backup_nome !== undefined) { fields.push('backup_nome = ?'); values.push(backup_nome); }
    if (notas       !== undefined) { fields.push('notas = ?');       values.push(notas); }

    if (!fields.length) return res.status(400).json({ erro: 'Nenhum campo para atualizar' });

    const result = db.prepare(`UPDATE equipamentos SET ${fields.join(', ')} WHERE id = ?`)
                     .run(...values, id);
    if (!result.changes) return res.status(404).json({ erro: 'Equipamento não encontrado' });

    // Re-sincroniza o mapa de backup em memória
    syncBackupMap();

    res.json(db.prepare('SELECT * FROM equipamentos WHERE id = ?').get(id));
  });

  return router;
}
