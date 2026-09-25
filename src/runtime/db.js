// ============================================================
// src/runtime/db.js — محول قاعدة البيانات D1-متوافق
// يقلّد واجهة env.DB.prepare(sql).bind(...).first()/all()/run()
// فوق قاعدتين:
//   - الإنتاج:  PostgreSQL عبر pg (عند ضبط DATABASE_URL)
//   - محلياً:   SQLite عبر better-sqlite3 (بدون خادم)
// يطبّق المخطط تلقائياً عند الإقلاع لكلا الخلفيتين.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const schemaSqlite = path.join(HERE, 'schema.sqlite.sql');
const schemaPg = path.join(HERE, 'schema.pg.sql');

// ---------- ترجمة SQL من لهجة SQLite/D1 إلى PostgreSQL ----------
export function toPgSql(sql) {
  let s = String(sql);
  // MAX(a,b) كدالة سلمية → GREATEST(a,b) (Postgres لا يملك MAX سلمية)
  s = s.replace(/MAX\(([^()]+),([^()]+)\)/gi, 'GREATEST($1, $2)');
  // INSERT OR IGNORE INTO → INSERT INTO ... ON CONFLICT DO NOTHING يتولاه المُترجم هنا
  s = s.replace(/^(INSERT\s+OR\s+IGNORE\s+)(INTO)/i, 'INSERT $2');
  // تحويل المواضع ? و?N إلى $N
  let i = 0;
  s = s.replace(/\?(\d+)?/g, (m, n) => (n ? `$${n}` : `$${++i}`));
  return s;
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// ---------- SQLite ----------
async function createSqlite() {
  const { default: sqlite3 } = await import('better-sqlite3');
  const file = process.env.SQLITE_PATH
    ? path.resolve(process.env.SQLITE_PATH)
    : path.join(ROOT, 'data', 'bzfbdz.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite3(file);
  db.pragma('journal_mode = WAL');
  try {
    db.pragma('busy_timeout = 5000');
  } catch {}

  const stmts = splitStatements(fs.readFileSync(schemaSqlite, 'utf8'));
  const run = db.transaction(() => {
    for (const s of stmts) db.exec(s);
  });
  run();

  const DB = {
    backend: 'sqlite',
    path: file,
    prepare(sql) {
      let stmt = null;
      return {
        bind(...params) {
          if (!stmt) stmt = db.prepare(sql);
          return {
            async first() {
              const row = stmt.get(...params);
              return row === undefined ? null : row;
            },
            async all() {
              return { results: stmt.all(...params) };
            },
            async run() {
              const r = stmt.run(...params);
              return { success: true, meta: { changes: r.changes, lastRowId: r.lastInsertRowid } };
            },
          };
        },
      };
    },
    async exec(sql) {
      db.exec(sql);
      return { success: true };
    },
    close() {
      try {
        db.close();
      } catch {}
    },
  };
  return DB;
}

// ---------- PostgreSQL ----------
function createPg(connectionString) {
  return import('pg').then(async ({ default: pg }) => {
    const pool = new pg.Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl:
        process.env.PG_NO_SSL === 'true' || process.env.PG_NO_SSL === '1'
          ? false
          : { rejectUnauthorized: false },
    });

    // تحقق أولي + تطبيق المخطط
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      const schema = fs.readFileSync(schemaPg, 'utf8');
      for (const s of splitStatements(schema)) {
        await client.query(s);
      }
    } finally {
      client.release();
    }

    const DB = {
      backend: 'pg',
      prepare(sql) {
        const finalSql = toPgSql(sql);
        return {
          bind(...params) {
            return {
              async first() {
                const r = await pool.query(finalSql, params);
                return r.rows[0] ?? null;
              },
              async all() {
                const r = await pool.query(finalSql, params);
                return { results: r.rows };
              },
              async run() {
                const r = await pool.query(finalSql, params);
                return { success: true, meta: { changes: r.rowCount ?? 0 } };
              },
            };
          },
        };
      },
      async exec(sql) {
        await pool.query(toPgSql(sql));
        return { success: true };
      },
      close() {
        pool.end().catch(() => {});
      },
    };
    return DB;
  });
}

// ---------- المصنّع ----------
export async function createDb() {
  const url = process.env.DATABASE_URL || '';
  if (/^postgres(ql)?:\/\//i.test(url)) {
    return await createPg(url.trim());
  }
  return await createSqlite();
}