import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { abrirBanco }    from './db.js';
import { criarRotasApi } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT ?? 3000;

const app = express();
const db  = abrirBanco();

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.use('/api', criarRotasApi(db));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Monitor de Impressoras`);
  console.log(`  ─────────────────────────────`);
  console.log(`  http://localhost:${PORT}\n`);
});
