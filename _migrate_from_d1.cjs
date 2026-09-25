// ---------------------------------------------------------------------------
// _migrate_from_d1.cjs — ترحيل D1 (Cloudflare) → Postgres (Render bzfbdz_node)
// قراءة دفعات من D1 عبر wrangler --json، ثم إدراجها في Postgres مع ON CONFLICT.
// الاستخدام: node _migrate_from_d1.cjs
// (ملف مؤقت — يُحذف بعد النقل)
// ---------------------------------------------------------------------------
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// ---------- إعدادات D1 / wrangler ----------
const WRANGLER = process.env.WRANGLER_CMD || path.resolve(
  'C:/Users/BACHIR_PC/Documents/Default Project/BZFBDZ-cloudflare/node_modules/wrangler/bin/wrangler.js');
const D1_DB = 'bzfbdz';

// ---------- إعدادات Postgres ----------
const PG = {
  host: 'dpg-dar7ntnavr4c7383eepg-a.oregon-postgres.render.com',
  port: 5432,
  database: 'bzfbdz_node',
  user: 'bzfbdz_node_user',
  password: 'WluScHr37xlFybtz21uFlYaZV36DR3tR',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
};

const BATCH = 3000;

function d1Count(sql) {
  const r = spawnSync(process.execPath,
    [WRANGLER, 'd1', 'execute', D1_DB, '--remote', '--command', sql, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(r.stdout.trim());
  const res = j && j[0] && j[0].results ? j[0].results : [];
  return res[0] ? Number(res[0].c) : 0;
}

function d1Rows(sql) {
  const r = spawnSync(process.execPath,
    [WRANGLER, 'd1', 'execute', D1_DB, '--remote', '--command', sql, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('wrangler failed: ' + (r.stderr || '').slice(-300));
  const j = JSON.parse(r.stdout.trim());
  return j && j[0] && j[0].results ? j[0].results : [];
}

// ---------- جدول التهيئة: اسم PG، أعمدة، PK، هل نحفظ id ----------
const TABLES = [
  { pg: 'users', pk: 'phoneNumber', keepId: false },
  { pg: 'sessions', pk: 'psid', keepId: false },
  { pg: 'proxies', pk: 'id', keepId: true },
  { pg: 'cooldowns', pk: 'key', keepId: false },
  { pg: 'request_logs', pk: 'id', keepId: true },
  { pg: 'otp_sids', pk: 'msisdn', keepId: false },
  { pg: 'rate_limits', pk: 'key', keepId: false },
  { pg: 'tg_debug_logs', pk: 'id', keepId: true },
  { pg: 'anniversary_log', pk: 'id', keepId: true },
  { pg: 'anniversary_config', pk: 'key', keepId: false },
];

async function ensureColumn(pool, table, col, ddl) {
  const r = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2",
    [table, col]);
  if (r.rows.length === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${ddl}`);
    console.log(`  + عمود جديد: ${table}.${col}`);
  }
}

async function setSeq(pool, table, idCol) {
  const seq = `"${table}_${idCol}_seq"`;
  await pool.query(`SELECT setval('${seq}', COALESCE((SELECT MAX(${idCol}) FROM ${table}), 1))`);
}

async function migrateTable(pool, cfg) {
  const table = cfg.pg;
  console.log(`\n=== ${table} ===`);
  // أسماء أعمدة */D1 نقرأ ديناميكياً من أول صف
  const sample = d1Rows(`SELECT * FROM ${table} LIMIT 1`);
  const total = d1Count(`SELECT COUNT(*) AS c FROM ${table}`);
  if (!total) { console.log(`  0 صف — تخطي`); return; }
  const cols = sample.length ? Object.keys(sample[0]) : [];
  if (!cols.length) { console.log('  لا أعمدة — تخطي'); return; }
  // ترتيب الأعمدة بحيث يكون الـ id أولاً إن وُجد (للجداول ذات keepId)
  const rawCols = [...cols].sort((a, b) => {
    const ia = a === (cfg.keepId ? 'id' : cfg.pk) ? 0 : 1;
    const ib = b === (cfg.keepId ? 'id' : cfg.pk) ? 0 : 1;
    return ia - ib;
  });
  // خريطة: اسم عمود D1 (مفتاح JSON) → اسم عمود Postgres (lowercase)
  const colMap = rawCols.map((c) => ({ src: c, dst: c.toLowerCase() }));
  const colList = colMap.map((m) => `"${m.dst}"`).join(', ');
  const placeholders = colMap.map((_, i) => `$${i + 1}`).join(', ');
  const conflict = `ON CONFLICT ("${cfg.pk.toLowerCase()}") DO NOTHING`;

  let offset = 0, inserted = 0, totalDup = 0;
  while (offset < total) {
    const rows = d1Rows(`SELECT * FROM ${table} LIMIT ${BATCH} OFFSET ${offset}`);
    if (!rows.length) break;
    // إدراج دفعة واحدة متعددة الصفوف
    const values = [];
    for (const row of rows) {
      const tuple = colMap.map((m) => {
        const v = row[m.src];
        return v === null || v === undefined ? null : v;
      });
      values.push(tuple);
    }
    // إدراج كل صف على حدة في معاملة ضميمة (آمن للفروق في الأعمدة)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const tuple of values) {
        const r = await client.query(
          `INSERT INTO ${table} (${colList}) VALUES (${colMap.map((_, i) => `$${i + 1}`).join(', ')}) ${conflict}`,
          tuple);
        if (r.rowCount > 0) inserted++; else totalDup++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    offset += rows.length;
    process.stdout.write(`  ${offset}/${total} (جديد: ${inserted}, مكرر: ${totalDup})\r`);
  }
  if (cfg.keepId) await setSeq(pool, table, 'id').catch(() => {});
  console.log(`\n  تم: ${inserted} صف جديد، ${totalDup} مكرر`);
}

async function main() {
  const pool = new Pool(PG);
  // عمود welcome_sent في sessions غير موجود في Postgres
  await ensureColumn(pool, 'sessions', 'welcome_sent', 'welcome_sent BIGINT NOT NULL DEFAULT 0');
  try {
    for (const cfg of TABLES) {
      await migrateTable(pool, cfg);
    }
  } finally {
    await pool.end();
  }
  console.log('\n===== اكتمل الترحيل من D1 إلى Postgres =====');
}

main().catch((e) => {
  console.error('\nخطأ:', e.message);
  process.exit(1);
});