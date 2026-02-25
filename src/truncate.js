import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '../data/db/monitor.db'));

db.pragma('foreign_keys = ON');
db.exec(`
  DELETE FROM consumiveis_snapshot;
  DELETE FROM snapshots;
  DELETE FROM sqlite_sequence WHERE name IN ('snapshots','consumiveis_snapshot');
`);

console.log('snapshots       :', db.prepare('SELECT COUNT(*) as n FROM snapshots').get().n);
console.log('consumiveis     :', db.prepare('SELECT COUNT(*) as n FROM consumiveis_snapshot').get().n);
console.log('impressoras     :', db.prepare('SELECT COUNT(*) as n FROM impressoras').get().n);
console.log('catalogo_precos :', db.prepare('SELECT COUNT(*) as n FROM catalogo_precos').get().n);
console.log('\nTabelas truncadas. IDs resetados para 1.');
