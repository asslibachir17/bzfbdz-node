// طبقة الكولدداونز (المهل) المحفوظة في D1 — تمنع تكرار الخدمات والسبام
import { first, run } from './db.js';

// مدة متبقية بالميلي ثانية (0 إذا انتهت)
export async function cooldownLeftMs(env, key, t = Date.now()) {
  const row = await first(env, 'SELECT until FROM cooldowns WHERE key = ?', key);
  if (!row) return 0;
  const left = Number(row.until) - t;
  return left > 0 ? left : 0;
}

// تسجيل بداية كولدداون جديد
export async function setCooldown(env, key, cooldownMs, t = Date.now()) {
  await run(
    env,
    'INSERT INTO cooldowns (key, until) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until',
    key,
    t + cooldownMs
  );
}

// تمديد كولدداون فقط إذا كان أطول (يُستخدم لكولدداون الحجب المتصاعد)
export async function extendCooldown(env, key, cooldownMs, t = Date.now()) {
  await run(
    env,
    `INSERT INTO cooldowns (key, until) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET until = MAX(cooldowns.until, excluded.until)`,
    key,
    t + cooldownMs
  );
}

// فحص + تسجيل في عملية واحدة. يرجع { ok, leftMs }
export async function checkAndSetCooldown(env, key, cooldownMs, t = Date.now()) {
  const left = await cooldownLeftMs(env, key, t);
  if (left > 0) return { ok: false, leftMs: left };
  await setCooldown(env, key, cooldownMs, t);
  return { ok: true, leftMs: 0 };
}

// فحص + تسجيل في عملية واحدة (UPSERT) — رحلة شبكة واحدة بدل اثنتين.
// يرجع { ok: true } عند السماح (إدراج جديد أو كولدداون منتهٍ)،
// و{ ok: false, leftMs } عند بقاء الكوللداون قائمًا (قيمة قديمة محفوظة).
// المقارنة المعيارية للنهاية تستخدم علامة counter موثوقة بدل مقارنة القيم
// (التي تفشل عندما تتساوى القيمة القديمة والجديدة) — counter=-1 لدى الحظر،
// و0/1 لدى السماح (مفتاح mid: لا يُقرأ عداده في أي مكان).
//
// ملاحظة مهمة: نستخدم معاملات ? المرقّمة بالترتيب (وليس ?1/?2/?3) لأن better-sqlite3
// (نسخة SQLite) لا يدعم ترقيم المعاملات ويفشل بـ "Too many parameter values were provided".
// طبقة toPgSql في runtime/db.js تحوّل ? إلى $1,$2,$3 تلقائياً ليعمل PostgreSQL أيضاً.
export async function checkAndSetCooldownOne(env, key, cooldownMs, t = Date.now()) {
  const until = t + cooldownMs;
  // ترتيب المعاملات يطابق ترتيب ظهورها في الجملة: key, until, t, t
  const row = await first(
    env,
    `INSERT INTO cooldowns (key, until, counter) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       until = CASE WHEN cooldowns.until > ? THEN cooldowns.until ELSE excluded.until END,
       counter = CASE WHEN cooldowns.until > ? THEN -1 ELSE 0 END
     RETURNING until, counter`,
    key,
    until,
    t,
    t
  );
  if (Number(row?.counter) === -1) {
    const left = Number(row?.until) - t;
    return { ok: false, leftMs: left > 0 ? left : 0 };
  }
  return { ok: true, leftMs: 0 };
}

// عدّاد متصاعد محفوظ (للحجب بعد N محاولات): يرجع العدد الحالي
export async function bumpCounter(env, key, t = Date.now()) {
  const row = await first(
    env,
    `INSERT INTO cooldowns (key, until, counter)
     VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET counter = cooldowns.counter + 1
     RETURNING counter`,
    key,
    t
  );
  return row ? Number(row.counter) : 1;
}

export async function getCounter(env, key) {
  const row = await first(env, 'SELECT counter FROM cooldowns WHERE key = ?', key);
  return row ? Number(row.counter) : 0;
}

export async function clearCooldown(env, key) {
  await run(env, 'DELETE FROM cooldowns WHERE key = ?', key);
}

export async function resetCounter(env, key) {
  await run(env, 'DELETE FROM cooldowns WHERE key = ?', key);
}
