import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '../data/db/monitor.db');

// ─── Abre (ou cria) o banco e garante o schema ────────────────────────────────
export function abrirBanco() {
  const db = new Database(DB_PATH);

  // WAL melhora concorrência leitura/escrita
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- ── Cadastro fixo de impressoras ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS impressoras (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      setor       TEXT    NOT NULL,
      modelo      TEXT    NOT NULL,
      serie       TEXT,
      ip_liberty  TEXT    NOT NULL UNIQUE,
      ip_prodam   TEXT,
      sghx        TEXT,
      serie_snmp  TEXT,
      criado_em   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ── Um registro por execução por impressora ────────────────────────────────
    -- Só é inserido quando a impressora RESPONDEU — falhas de rede são ignoradas.
    CREATE TABLE IF NOT EXISTS snapshots (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      impressora_id              INTEGER NOT NULL REFERENCES impressoras(id),
      coletado_em                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      total_paginas_dispositivo  INTEGER,   -- prtMarkerLifeCount (faces totais)
      total_duplex               INTEGER,   -- contador duplex Samsung proprietário
      alerta                     TEXT,      -- Samsung/408dn: OID alerta
      mensagem_tela              TEXT       -- Samsung/408dn: mensagem display
    );

    -- ── Estado de cada consumível naquele snapshot ─────────────────────────────
    CREATE TABLE IF NOT EXISTS consumiveis_snapshot (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id         INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
      nome                TEXT    NOT NULL,  -- ex: "Toner Preto", "Fusor"
      nominal             INTEGER,           -- capacidade nominal (unidades MIB)
      atual               INTEGER,           -- nível atual (unidades MIB)
      percentual          INTEGER,           -- calculado: round(atual/nominal*100)
      toner_serial        TEXT,              -- serial do cartucho (quando disponível)
      toner_pn            TEXT,              -- part number (HP)
      paginas_cartucho    INTEGER,           -- páginas impressas com este cartucho (HP)
      paginas_restantes   INTEGER,           -- estimativa remanescente fornecida pela HP
      capacidade          INTEGER,           -- capacidade declarada do cartucho (HP)
      data_instalacao     TEXT,              -- AAAAMMDD bruto da HP
      data_ultimo_uso     TEXT               -- AAAAMMDD bruto da HP
    );

    -- ── Tabela de preços (preenchimento manual) ────────────────────────────────
    -- Usada para calcular custo por setor cruzando com trocas de serial.
    CREATE TABLE IF NOT EXISTS catalogo_precos (
      pn            TEXT    PRIMARY KEY,     -- part number ex: W9008MC
      descricao     TEXT,
      modelo_ref    TEXT,                    -- modelo(s) compatível(eis) ex: "HP E52645"
      preco         REAL,                    -- valor unitário em R$
      atualizado_em TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ── Registro de trocas de insumos (detectado automaticamente) ──────────────
    CREATE TABLE IF NOT EXISTS trocas_insumo (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      impressora_id     INTEGER NOT NULL REFERENCES impressoras(id),
      nome              TEXT    NOT NULL,  -- ex: "Toner Preto", "Cartucho de Toner Preto"
      serial_anterior   TEXT,
      serial_novo       TEXT,
      pn_anterior       TEXT,
      pn_novo           TEXT,
      percentual_antes  INTEGER,           -- % no último snapshot do cartucho que saiu
      percentual_depois INTEGER,           -- % no snapshot que detectou a troca
      paginas_anterior  INTEGER,           -- páginas impressas com o cartucho que saiu
      ocorrido_em       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ── Índices para as queries mais frequentes ────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_snap_impressora  ON snapshots(impressora_id, coletado_em);
    CREATE INDEX IF NOT EXISTS idx_cons_snapshot    ON consumiveis_snapshot(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_cons_serial      ON consumiveis_snapshot(toner_serial) WHERE toner_serial IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_trocas_impressora ON trocas_insumo(impressora_id, ocorrido_em);
  `);

  // ─── Migration: adiciona serie_snmp em bancos existentes ──────────────────
  const cols = db.prepare('PRAGMA table_info(impressoras)').all();
  if (!cols.find(c => c.name === 'serie_snmp')) {
    db.exec('ALTER TABLE impressoras ADD COLUMN serie_snmp TEXT');
  }

  return db;
}

// ─── Garante que a impressora existe na tabela e retorna seu id ───────────────
export function upsertImpressora(db, impressora, serieDispositivo = null) {
  const row = db.prepare(`
    SELECT id FROM impressoras WHERE ip_liberty = ?
  `).get(impressora['IP Liberty']);

  if (row) {
    if (serieDispositivo != null) {
      db.prepare('UPDATE impressoras SET serie_snmp = ? WHERE id = ?').run(serieDispositivo, row.id);
    }
    return row.id;
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO impressoras (setor, modelo, serie, ip_liberty, ip_prodam, sghx, serie_snmp)
    VALUES (@setor, @modelo, @serie, @ip_liberty, @ip_prodam, @sghx, @serie_snmp)
  `).run({
    setor:      impressora.SETOR,
    modelo:     impressora.MODELO,
    serie:      impressora['SÉRIE']   ?? null,
    ip_liberty: impressora['IP Liberty'],
    ip_prodam:  impressora['IP Prodam'] ?? null,
    sghx:       impressora['SGHx']    ?? null,
    serie_snmp: serieDispositivo,
  });

  return lastInsertRowid;
}

// ─── Filtra apenas toners e fusores — o que interessa para análise de custo ──
function ehTonerOuFusor(nome) {
  const n = nome.toLowerCase();
  return n.includes('toner') || n.includes('fusor') || n.includes('cartucho');
}

// ─── Persiste um resultado bem-sucedido numa transação atômica ───────────────
// Só grava toners e fusores. Falhas de rede nunca chegam aqui — o caller
// só invoca esta função após receber um resultado válido.
export const salvarResultado = (db) => {
  const insertSnap = db.prepare(`
    INSERT INTO snapshots
      (impressora_id, total_paginas_dispositivo, total_duplex, alerta, mensagem_tela)
    VALUES
      (@impressora_id, @total_paginas_dispositivo, @total_duplex, @alerta, @mensagem_tela)
  `);

  // Último estado conhecido do consumível que tenha algum identificador
  const selectUltimoSerial = db.prepare(`
    SELECT cs.toner_serial, cs.toner_pn, cs.percentual, cs.paginas_cartucho
    FROM consumiveis_snapshot cs
    JOIN snapshots s ON cs.snapshot_id = s.id
    WHERE s.impressora_id = ? AND cs.nome = ?
      AND (cs.toner_serial IS NOT NULL OR cs.toner_pn IS NOT NULL)
    ORDER BY s.coletado_em DESC
    LIMIT 1
  `);

  const insertTroca = db.prepare(`
    INSERT INTO trocas_insumo
      (impressora_id, nome, serial_anterior, serial_novo,
       pn_anterior, pn_novo, percentual_antes, percentual_depois, paginas_anterior)
    VALUES
      (@impressora_id, @nome, @serial_anterior, @serial_novo,
       @pn_anterior, @pn_novo, @percentual_antes, @percentual_depois, @paginas_anterior)
  `);

  const insertCons = db.prepare(`
    INSERT INTO consumiveis_snapshot
      (snapshot_id, nome, nominal, atual, percentual,
       toner_serial, toner_pn, paginas_cartucho, paginas_restantes,
       capacidade, data_instalacao, data_ultimo_uso)
    VALUES
      (@snapshot_id, @nome, @nominal, @atual, @percentual,
       @toner_serial, @toner_pn, @paginas_cartucho, @paginas_restantes,
       @capacidade, @data_instalacao, @data_ultimo_uso)
  `);

  return db.transaction((impressoraId, resultado) => {
    const isHP        = resultado.modelo === 'HP E52645' || resultado.modelo === 'HP 408dn';
    const isHPColor   = resultado.modelo === 'HP E57540 Cor';
    const isHPColorA3 = resultado.modelo === 'HP E87660 A3';
    const isSamsung   = !isHP && !isHPColor && !isHPColorA3;

    const { lastInsertRowid: snapId } = insertSnap.run({
      impressora_id:             impressoraId,
      total_paginas_dispositivo: resultado.totalImpresso ?? null,
      total_duplex:              isSamsung ? (resultado.totalDuplex ?? null) : null,
      alerta:                    resultado.alerta        ?? null,
      mensagem_tela:             resultado.mensagemTela  ?? null,
    });

    // ── Mapa nome → dados ricos para HP coloridas (toners CMYK) ─────────────
    const tonerRico = new Map();
    if ((isHPColor || isHPColorA3) && resultado.toners) {
      for (let i = 0; i < resultado.toners.length; i++) {
        tonerRico.set(resultado.itens[i].nome, resultado.toners[i]);
      }
    }

    // ── Itera apenas toners e fusores ────────────────────────────────────────
    for (const item of resultado.itens.filter(it => ehTonerOuFusor(it.nome))) {
      const rico = tonerRico.get(item.nome);
      const nome  = item.nome.toLowerCase();
      const éToner = nome.includes('toner') || nome.includes('cartucho');

      let serial = null, pn = null, pagsCartucho = null, pagsRest = null,
          cap = null, install = null, lastUse = null;

      if (rico) {
        // HP colorida — dados ricos vindos do array resultado.toners
        serial      = rico.serial   ?? null;
        pn          = rico.pn       ?? null;
        pagsCartucho = rico.impresso ?? null;
        pagsRest    = rico.pagRest  ?? null;
        cap         = rico.capacid  ?? null;
        install     = rico.install  ?? null;
        lastUse     = rico.lastUse  ?? null;
      } else if (isHP && éToner) {
        // HP mono — dados ricos no resultado raiz
        serial      = resultado.tonerSerial   ?? null;
        pn          = resultado.tonerPN       ?? null;
        pagsCartucho = resultado.tonerImpresso ?? null;
        pagsRest    = resultado.paginasRest   ?? null;
        cap         = resultado.tonerCapacid  ?? null;
        install     = resultado.tonerInstall  ?? null;
        lastUse     = resultado.tonerLastUse  ?? null;
      } else if (isSamsung && éToner) {
        // Samsung — só tem serial (extraído via regex do campo nome MIB)
        serial = resultado.serialToner ?? null;
      }

      // ── Detectar troca de insumo ─────────────────────────────────────────────
      const identNovo = serial ?? pn;
      if (identNovo) {
        const ult = selectUltimoSerial.get(impressoraId, item.nome);
        const identAnt = ult?.toner_serial ?? ult?.toner_pn ?? null;
        if (ult && identAnt && identAnt !== identNovo) {
          insertTroca.run({
            impressora_id:    impressoraId,
            nome:             item.nome,
            serial_anterior:  ult.toner_serial ?? null,
            serial_novo:      serial,
            pn_anterior:      ult.toner_pn ?? null,
            pn_novo:          pn,
            percentual_antes: ult.percentual ?? null,
            percentual_depois: item.percentual ?? null,
            paginas_anterior: ult.paginas_cartucho ?? null,
          });
        }
      }

      insertCons.run({
        snapshot_id:       snapId,
        nome:              item.nome,
        nominal:           item.nominal    ?? null,
        atual:             item.atual      ?? null,
        percentual:        item.percentual ?? null,
        toner_serial:      serial,
        toner_pn:          pn,
        paginas_cartucho:  pagsCartucho,
        paginas_restantes: pagsRest,
        capacidade:        cap,
        data_instalacao:   install,
        data_ultimo_uso:   lastUse,
      });
    }

    return snapId;
  });
};
