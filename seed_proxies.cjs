// ============================================================================
// سكربت زرع البروكسيات في جدول proxies
//
// ⚠️  تنبيه أمني: هذا الملف كان يحتوي على كلمة مرور PostgreSQL الحيّة
//     وخمس كلمات مرور بروكسي مدفوعة مكتوبة مباشرةً، وكان مُرفعاً على
//     مستودع GitHub عام. تم حذف كل الأسرار من هنا نهائياً.
//     كل القيم تُقرأ الآن من متغيرات البيئة:
//       DATABASE_URL  — سلسلة اتصال PostgreSQL (إلزامية)
//       PROXIES_JSON  — مصفوفة JSON بالبروكسيات (إلزامية)
//
//     مثال لـ PROXIES_JSON:
//     [{"host":"example.com","port":5000,"username":"u","password":"p","service":"ooredoo"}]
//
//     التشغيل:  node seed_proxies.cjs
//     (يجب ضبط المتغيرين في البيئة أو في .env داخل نفس المجلد)
// ============================================================================
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// تحميل .env اختيارياً حتى لا نحتاج ضبط متغيرات النظام يدوياً
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const connectionString = (process.env.DATABASE_URL || '').trim();
if (!connectionString) {
  console.error('ERR: متغير البيئة DATABASE_URL غير معرّف. لا يوجد أي سرّ افتراضي في هذا الملف عن قصد.');
  process.exit(1);
}

let rows;
try {
  rows = JSON.parse(process.env.PROXIES_JSON || '[]');
} catch (e) {
  console.error('ERR: PROXIES_JSON ليس JSON صالحاً:', e.message);
  process.exit(1);
}
if (!Array.isArray(rows) || !rows.length) {
  console.error('ERR: متغير البيئة PROXIES_JSON فارغ أو ليس مصفوفة. لا يوجد أي سرّ افتراضي في هذا الملف عن قصد.');
  process.exit(1);
}

// لا نطبع كلمات المرور أبداً في السجل
const mask = (s) => (s ? `${String(s).slice(0, 2)}***` : '');

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function main() {
  // ملاحظة: جدول proxies فيه id BIGSERIAL بلا قيد UNIQUE على host،
  // فاستخدام ON CONFLICT (id) دون تحديد id يُنتج تكراراً عند كل تشغيل.
  // لذلك نحذف الصف السابق لنفس (host, service) ثم نُدرج، داخل معاملة واحدة:
  // هذا يجعل الزرع آمناً للتكرار (idempotent) وبلا حاجة إلى معرفة الـ ids.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      for (const f of ['host', 'port', 'username', 'password', 'service']) {
        if (r[f] === undefined || r[f] === null || r[f] === '') {
          throw new Error(`حقل "${f}" مفقود في أحد العناصر`);
        }
      }
      await client.query('DELETE FROM proxies WHERE host = $1 AND service = $2', [r.host, r.service]);
      const res = await client.query(
        `INSERT INTO proxies (host, port, username, password, active, last_used, service, blocked_until)
         VALUES ($1,$2,$3,$4,$5,to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),$6,$7)`,
        [r.host, r.port, r.username, r.password, r.active === 0 ? 0 : 1, r.service, Number(r.blocked_until) || 0]
      );
      console.log(`proxy ${r.host} (${r.service}) user=${r.username} pass=${mask(r.password)} rowCount=${res.rowCount}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const chk = await pool.query('SELECT id, host, service, active, blocked_until FROM proxies ORDER BY id');
  console.log('FINAL:', JSON.stringify(chk.rows));
  await pool.end();
}

main().catch((e) => {
  console.error('ERR', e.message || e);
  process.exit(1);
});
