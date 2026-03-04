/**
 * migrate-v2.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Refatoração estrutural v2:
 *   • Cria tabela  locais       (ponto de rede fixo: IP, prédio, andar)
 *   • Cria tabela  equipamentos (hardware físico: modelo + serial)
 *   • Adiciona FK  local_id / equipamento_id / ativo  em impressoras
 *   • Popula tudo automaticamente a partir dos dados existentes
 *
 * Execute UMA VEZ:  npm run migrate
 * É idempotente — pode ser reexecutado sem duplicar registros.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH       = path.join(__dirname, '../data/db/monitor.db');
const PRINTERS_PATH = path.join(__dirname, '../data/printers.json');
const BACKUP_PATH   = path.join(__dirname, '../data/backup.json');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Parser de setor ──────────────────────────────────────────────────────────
// Formato atual: "{andar} - {NOME_SETOR} {local_instalacao}"
// Heurística: palavras com > 1 letra minúscula ASCII iniciam o local_instalacao
// (lida corretamente com CAPS acentuado tipo EMERGÊNCIA, e typos como ClÍNICA)
function parseSetor(setor = '') {
  const match = setor.match(/^(\d+)\s*-\s*(.+)$/);
  if (!match) return { andar: null, nome_setor: setor, local_instalacao: setor };

  const andar    = parseInt(match[1]);
  const resto    = match[2].trim();
  const palavras = resto.split(' ');

  let splitIdx = palavras.length; // padrão: tudo é nome_setor
  for (let i = 0; i < palavras.length; i++) {
    if ((palavras[i].match(/[a-z]/g) || []).length > 1) { splitIdx = i; break; }
  }

  const nome_setor       = palavras.slice(0, splitIdx).join(' ');
  const local_instalacao = palavras.slice(splitIdx).join(' ');
  return {
    andar,
    nome_setor:       nome_setor       || resto,
    local_instalacao: local_instalacao || nome_setor || resto,
  };
}

const printers = JSON.parse(fs.readFileSync(PRINTERS_PATH, 'utf-8'));
const backups  = JSON.parse(fs.readFileSync(BACKUP_PATH,   'utf-8'));

// ─── Migração em transação única ──────────────────────────────────────────────
const migrar = db.transaction(() => {

  // ── 1. Criar tabelas novas ─────────────────────────────────────────────────
  db.exec(`
    -- Ponto de rede fixo (o IP nunca muda, independe do hardware instalado)
    CREATE TABLE IF NOT EXISTS locais (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_setor       TEXT    NOT NULL,        -- ex: "AMBULATÓRIO", "UTI ADULTO"
      local_instalacao TEXT    NOT NULL,        -- ex: "Egressos Sala 1", "Coordenação"
      predio           TEXT,                    -- 'hmacn_internacao' | 'hmacn_ambulatorio'
      andar            INTEGER,                 -- 0..6
      ip_liberty       TEXT    NOT NULL UNIQUE,
      ip_prodam        TEXT,
      sghx             TEXT,
      ativo            INTEGER NOT NULL DEFAULT 1,
      criado_em        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Hardware físico (modelo + serial identifica univocamente a impressora)
    CREATE TABLE IF NOT EXISTS equipamentos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      modelo      TEXT    NOT NULL,
      serie       TEXT    NOT NULL UNIQUE,      -- serial oficial/cadastrado
      is_backup   INTEGER NOT NULL DEFAULT 0,   -- 1 = equipamento reserva (DTI)
      backup_nome TEXT,                         -- ex: "DTI Backup 1 HP"
      notas       TEXT,
      criado_em   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_locais_ip    ON locais(ip_liberty);
    CREATE INDEX IF NOT EXISTS idx_equip_serie  ON equipamentos(serie);
    CREATE INDEX IF NOT EXISTS idx_equip_backup ON equipamentos(is_backup);
  `);
  console.log('✓ tabelas locais e equipamentos criadas (ou já existiam)');

  // ── 2. Popular locais a partir de impressoras ──────────────────────────────
  const insertLocal = db.prepare(`
    INSERT OR IGNORE INTO locais
      (nome_setor, local_instalacao, andar, ip_liberty, ip_prodam, sghx)
    VALUES
      (@nome_setor, @local_instalacao, @andar, @ip_liberty, @ip_prodam, @sghx)
  `);

  const todasImpressoras = db.prepare('SELECT * FROM impressoras').all();
  let locaisInseridos = 0;
  for (const imp of todasImpressoras) {
    const { andar, nome_setor, local_instalacao } = parseSetor(imp.setor);
    locaisInseridos += insertLocal.run({
      nome_setor, local_instalacao, andar,
      ip_liberty: imp.ip_liberty,
      ip_prodam:  imp.ip_prodam ?? null,
      sghx:       imp.sghx     ?? null,
    }).changes;
  }
  const totalLocais = db.prepare('SELECT COUNT(*) AS n FROM locais').get().n;
  console.log(`✓ locais: ${locaisInseridos} inseridos (total: ${totalLocais})`);

  // ── 3. Popular equipamentos a partir de printers.json ─────────────────────
  const insertEquip = db.prepare(`
    INSERT OR IGNORE INTO equipamentos (modelo, serie, is_backup, backup_nome)
    VALUES (@modelo, @serie, @is_backup, @backup_nome)
  `);

  let equipInseridos = 0;
  for (const p of printers) {
    equipInseridos += insertEquip.run({
      modelo: p.MODELO, serie: p['SÉRIE'], is_backup: 0, backup_nome: null,
    }).changes;
  }

  // ── 4. Popular equipamentos a partir de backup.json ───────────────────────
  for (const b of backups) {
    equipInseridos += insertEquip.run({
      modelo: b.MODELO, serie: b['SÉRIE'], is_backup: 1, backup_nome: b.BACKUPS,
    }).changes;
  }

  // ── 5. Detectar equipamentos desconhecidos (serial SNMP nunca visto) ──────
  // Casos reais de troca de hardware que não estão em nenhum JSON cadastrado
  for (const imp of todasImpressoras) {
    if (!imp.serie_snmp) continue;

    const existe = db.prepare('SELECT id FROM equipamentos WHERE serie = ?').get(imp.serie_snmp);
    if (existe) continue;

    // Leitura SNMP com 1 char extra no final → mesmo hardware, não duplicar
    const serie = imp.serie ?? '';
    const mesmoBase = imp.serie_snmp.startsWith(serie) && imp.serie_snmp.length === serie.length + 1;
    if (mesmoBase) continue;

    // Serial genuinamente diferente → equipamento trocado, registrar como desconhecido
    equipInseridos += insertEquip.run({
      modelo: imp.modelo, serie: imp.serie_snmp, is_backup: 0, backup_nome: null,
    }).changes;
    console.log(`  ⚠ Equipamento não cadastrado criado: ${imp.modelo} | ${imp.serie_snmp} | (${imp.setor})`);
  }

  const totalEquip = db.prepare('SELECT COUNT(*) AS n FROM equipamentos').get().n;
  console.log(`✓ equipamentos: ${equipInseridos} inseridos (total: ${totalEquip})`);

  // ── 6. Adicionar colunas FK em impressoras (idempotente) ──────────────────
  const cols = db.prepare('PRAGMA table_info(impressoras)').all().map(c => c.name);

  if (!cols.includes('local_id')) {
    db.exec('ALTER TABLE impressoras ADD COLUMN local_id INTEGER REFERENCES locais(id)');
    console.log('✓ coluna local_id adicionada em impressoras');
  }
  if (!cols.includes('equipamento_id')) {
    db.exec('ALTER TABLE impressoras ADD COLUMN equipamento_id INTEGER REFERENCES equipamentos(id)');
    console.log('✓ coluna equipamento_id adicionada em impressoras');
  }
  if (!cols.includes('ativo')) {
    db.exec('ALTER TABLE impressoras ADD COLUMN ativo INTEGER NOT NULL DEFAULT 1');
    console.log('✓ coluna ativo adicionada em impressoras');
  }

  // ── 7. Popular local_id ───────────────────────────────────────────────────
  const rLocal = db.prepare(`
    UPDATE impressoras
    SET local_id = (SELECT id FROM locais WHERE locais.ip_liberty = impressoras.ip_liberty)
    WHERE local_id IS NULL
  `).run();
  console.log(`✓ local_id populado em ${rLocal.changes} impressoras`);

  // ── 8. Popular equipamento_id ─────────────────────────────────────────────
  // a) Match exato por serie_snmp (equipamento atualmente instalado)
  let updEquip = db.prepare(`
    UPDATE impressoras
    SET equipamento_id = (SELECT id FROM equipamentos WHERE serie = impressoras.serie_snmp)
    WHERE equipamento_id IS NULL AND serie_snmp IS NOT NULL
  `).run().changes;

  // b) serie_snmp com 1 char extra → mesmo hardware com leitura SNMP truncada
  updEquip += db.prepare(`
    UPDATE impressoras
    SET equipamento_id = (SELECT id FROM equipamentos WHERE serie = impressoras.serie)
    WHERE equipamento_id IS NULL
      AND serie IS NOT NULL AND serie_snmp IS NOT NULL
      AND length(serie_snmp) = length(serie) + 1
      AND substr(serie_snmp, 1, length(serie)) = serie
  `).run().changes;

  // c) Fallback: sem serie_snmp → usa serial cadastrado
  updEquip += db.prepare(`
    UPDATE impressoras
    SET equipamento_id = (SELECT id FROM equipamentos WHERE serie = impressoras.serie)
    WHERE equipamento_id IS NULL AND serie IS NOT NULL
  `).run().changes;

  console.log(`✓ equipamento_id populado em ${updEquip} impressoras`);

  // ── 9. Índices das FK ──────────────────────────────────────────────────────
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_imp_local ON impressoras(local_id);
    CREATE INDEX IF NOT EXISTS idx_imp_equip ON impressoras(equipamento_id);
  `);
  console.log('✓ índices de FK criados');

  // ── 10. Relatório ──────────────────────────────────────────────────────────
  const semLocal = db.prepare('SELECT COUNT(*) AS n FROM impressoras WHERE local_id       IS NULL').get().n;
  const semEquip = db.prepare('SELECT COUNT(*) AS n FROM impressoras WHERE equipamento_id IS NULL').get().n;

  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║        RELATÓRIO DE MIGRAÇÃO v2           ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`  impressoras  : ${todasImpressoras.length}`);
  console.log(`  locais       : ${totalLocais}`);
  console.log(`  equipamentos : ${totalEquip}`);
  if (semLocal  > 0) console.warn(`  ⚠  ${semLocal} impressoras sem local_id!`);
  if (semEquip  > 0) console.warn(`  ⚠  ${semEquip} impressoras sem equipamento_id — revise manualmente`);
  if (semLocal === 0 && semEquip === 0) console.log('  ✅  Todos os vínculos populados com sucesso!');

  console.log(`
  ─── PRÓXIMO PASSO: definir o prédio de cada local ─────────────────────────
  Ajuste as queries abaixo e execute no banco (ou use PUT /api/locais/:id):

  -- Ambulatório (andar 0, setores de atendimento ambulatorial):
  UPDATE locais SET predio = 'hmacn_ambulatorio'
  WHERE nome_setor IN (
    'AMBULATÓRIO','CONSULTÓRIO','PS','GASOTERAPIA','NIR','FARMÁCIA',
    'ALMOXARIFADO','CME','ROUPARIA','SERVIÇO SOCIAL','SND','SESMT',
    'ZELADORIA','PLANTÃO ADM','PRONTUÁRIO','CHEFIA MÉDICA','SPDM','QUALIDADE'
  );

  -- Internação (andares 1–6 + administrativo andar 2):
  UPDATE locais SET predio = 'hmacn_internacao' WHERE predio IS NULL;
`);
});

migrar();
db.close();
console.log('✅  Migração v2 concluída!\n');
