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
        SELECT i.id, i.setor, i.modelo, u.total as total_paginas
        FROM impressoras i
        JOIN ultimos u ON u.impressora_id = i.id
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
        SELECT i.id, i.setor, i.modelo,
               (f.total - COALESCE(ini.total, ifb.total)) AS total_paginas
        FROM impressoras i
        JOIN fim f             ON f.impressora_id   = i.id
        LEFT JOIN inicio ini   ON ini.impressora_id = i.id
        LEFT JOIN inicio_fallback ifb ON ifb.impressora_id = i.id
        WHERE (f.total - COALESCE(ini.total, ifb.total)) > 0
        ORDER BY total_paginas DESC
        LIMIT 10
      `).all(dtFim, dtInicio, dtInicio, dtInicio, dtFim);
    }

    // ── Resmas por semana (janela fixa de 7 dias, independente do período selecionado) ──
    const hoje7    = new Date();
    const inicio7  = new Date(hoje7); inicio7.setDate(hoje7.getDate() - 7);
    const dtFim7   = hoje7.toISOString().slice(0, 10);
    const dtIni7   = inicio7.toISOString().slice(0, 10);

    const semanaRow = db.prepare(`
      WITH
      fim_p AS (
        SELECT impressora_id, MAX(total_paginas_dispositivo) AS total
        FROM snapshots
        WHERE total_paginas_dispositivo IS NOT NULL
          AND date(coletado_em) <= ? AND date(coletado_em) >= ?
        GROUP BY impressora_id
      ),
      ini_p AS (
        SELECT impressora_id, MAX(total_paginas_dispositivo) AS total
        FROM snapshots
        WHERE total_paginas_dispositivo IS NOT NULL AND date(coletado_em) < ?
        GROUP BY impressora_id
      ),
      ini_p_fb AS (
        SELECT impressora_id, MIN(total_paginas_dispositivo) AS total
        FROM snapshots
        WHERE total_paginas_dispositivo IS NOT NULL
          AND date(coletado_em) >= ? AND date(coletado_em) <= ?
        GROUP BY impressora_id
      ),
      fim_d AS (
        SELECT impressora_id, MAX(total_duplex) AS total
        FROM snapshots
        WHERE total_duplex IS NOT NULL
          AND date(coletado_em) <= ? AND date(coletado_em) >= ?
        GROUP BY impressora_id
      ),
      ini_d AS (
        SELECT impressora_id, MAX(total_duplex) AS total
        FROM snapshots
        WHERE total_duplex IS NOT NULL AND date(coletado_em) < ?
        GROUP BY impressora_id
      ),
      ini_d_fb AS (
        SELECT impressora_id, MIN(total_duplex) AS total
        FROM snapshots
        WHERE total_duplex IS NOT NULL
          AND date(coletado_em) >= ? AND date(coletado_em) <= ?
        GROUP BY impressora_id
      ),
      delta AS (
        SELECT
          fp.impressora_id,
          CASE WHEN fp.total - COALESCE(ip.total, ipfb.total) > 0
               THEN fp.total - COALESCE(ip.total, ipfb.total) ELSE 0 END AS delta_pag,
          CASE WHEN fd.total IS NOT NULL AND COALESCE(id_.total, idfb.total) IS NOT NULL
                    AND fd.total - COALESCE(id_.total, idfb.total) > 0
               THEN fd.total - COALESCE(id_.total, idfb.total) ELSE 0 END AS delta_dup
        FROM fim_p fp
        LEFT JOIN ini_p   ip   ON ip.impressora_id   = fp.impressora_id
        LEFT JOIN ini_p_fb ipfb ON ipfb.impressora_id = fp.impressora_id
        LEFT JOIN fim_d   fd   ON fd.impressora_id   = fp.impressora_id
        LEFT JOIN ini_d   id_  ON id_.impressora_id  = fp.impressora_id
        LEFT JOIN ini_d_fb idfb ON idfb.impressora_id = fp.impressora_id
      )
      SELECT SUM(delta_pag) AS paginas, SUM(delta_dup) AS duplex FROM delta
    `).get(dtFim7, dtIni7, dtIni7, dtIni7, dtFim7,
           dtFim7, dtIni7, dtIni7, dtIni7, dtFim7);

    const folhasSemana = Math.max(0, (semanaRow.paginas ?? 0) - (semanaRow.duplex ?? 0));
    const resmasSemana = Math.ceil(folhasSemana / 500);

    const totalConfig = _printers.length + _backups.length;
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
        fim_p AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) AS total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) <= ? AND date(coletado_em) >= ?
          GROUP BY impressora_id
        ),
        ini_p AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) AS total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL AND date(coletado_em) < ?
          GROUP BY impressora_id
        ),
        ini_p_fb AS (
          SELECT impressora_id, MIN(total_paginas_dispositivo) AS total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
            AND date(coletado_em) >= ? AND date(coletado_em) <= ?
          GROUP BY impressora_id
        ),
        fim_d AS (
          SELECT impressora_id, MAX(total_duplex) AS total
          FROM snapshots
          WHERE total_duplex IS NOT NULL
            AND date(coletado_em) <= ? AND date(coletado_em) >= ?
          GROUP BY impressora_id
        ),
        ini_d AS (
          SELECT impressora_id, MAX(total_duplex) AS total
          FROM snapshots
          WHERE total_duplex IS NOT NULL AND date(coletado_em) < ?
          GROUP BY impressora_id
        ),
        ini_d_fb AS (
          SELECT impressora_id, MIN(total_duplex) AS total
          FROM snapshots
          WHERE total_duplex IS NOT NULL
            AND date(coletado_em) >= ? AND date(coletado_em) <= ?
          GROUP BY impressora_id
        ),
        delta AS (
          SELECT fp.impressora_id,
            CASE WHEN fp.total - COALESCE(ip.total, ipfb.total) > 0
                 THEN fp.total - COALESCE(ip.total, ipfb.total) ELSE 0 END AS faces,
            CASE WHEN fd.total IS NOT NULL AND COALESCE(id_.total, idfb.total) IS NOT NULL
                      AND fd.total - COALESCE(id_.total, idfb.total) > 0
                 THEN fd.total - COALESCE(id_.total, idfb.total) ELSE 0 END AS duplex
          FROM fim_p fp
          LEFT JOIN ini_p    ip   ON ip.impressora_id   = fp.impressora_id
          LEFT JOIN ini_p_fb ipfb ON ipfb.impressora_id = fp.impressora_id
          LEFT JOIN fim_d    fd   ON fd.impressora_id   = fp.impressora_id
          LEFT JOIN ini_d    id_  ON id_.impressora_id  = fp.impressora_id
          LEFT JOIN ini_d_fb idfb ON idfb.impressora_id = fp.impressora_id
        )
        SELECT i.id AS impressora_id, i.modelo, d.faces, COALESCE(d.duplex, 0) AS duplex
        FROM impressoras i
        JOIN delta d ON d.impressora_id = i.id
        WHERE i.setor = ?
        ORDER BY d.faces DESC
      `).all(dtFim, dtInicio, dtInicio, dtInicio, dtFim,
             dtFim, dtInicio, dtInicio, dtInicio, dtFim,
             setor);
    }

    const data = rows.map(r => {
      const folhas = Math.max(0, r.faces - r.duplex);
      const resmas = Math.ceil(folhas / 500);
      return { impressora_id: r.impressora_id, modelo: r.modelo, faces: r.faces, duplex: r.duplex, folhas, resmas };
    });

    res.json({ data });
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

    res.json({ impressora, historico, dias_restantes: diasRestantes, cartuchos, status_serie, serie_info, trocas });
  });

  // ── GET /api/setores-paginas  (?periodo=total|mes|semana  OU  ?de=&ate=) ──────
  // Igual ao top_paginas do /summary mas sem LIMIT (todos os setores)
  router.get('/setores-paginas', (req, res) => {
    const VALIDOS = ['total', 'mes', 'semana'];
    const periodo = VALIDOS.includes(req.query.periodo) ? req.query.periodo : null;
    const ISO_RE  = /^\d{4}-\d{2}-\d{2}$/;
    const de  = ISO_RE.test(req.query.de  ?? '') ? req.query.de  : null;
    const ate = ISO_RE.test(req.query.ate ?? '') ? req.query.ate : null;
    const usandoIntervalo = de && ate;

    let setores;

    if (!usandoIntervalo && periodo === 'total') {
      setores = db.prepare(`
        WITH ultimos AS (
          SELECT impressora_id, MAX(total_paginas_dispositivo) as total
          FROM snapshots
          WHERE total_paginas_dispositivo IS NOT NULL
          GROUP BY impressora_id
        )
        SELECT i.id, i.setor, i.modelo, u.total as total_paginas
        FROM impressoras i
        JOIN ultimos u ON u.impressora_id = i.id
        ORDER BY total_paginas DESC
      `).all();
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
        SELECT i.id, i.setor, i.modelo,
               (f.total - COALESCE(ini.total, ifb.total)) AS total_paginas
        FROM impressoras i
        JOIN fim f             ON f.impressora_id   = i.id
        LEFT JOIN inicio ini   ON ini.impressora_id = i.id
        LEFT JOIN inicio_fallback ifb ON ifb.impressora_id = i.id
        WHERE (f.total - COALESCE(ini.total, ifb.total)) > 0
        ORDER BY total_paginas DESC
      `).all(dtFim, dtInicio, dtInicio, dtInicio, dtFim);
    }

    const modoAtivo = usandoIntervalo ? 'intervalo' : (periodo ?? 'semana');
    res.json({ impressoras: setores, periodo: modoAtivo, de: de ?? null, ate: ate ?? null });
  });

  return router;
}
