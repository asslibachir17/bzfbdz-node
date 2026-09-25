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
// إن كانت القديمة ما زالت قائمة (لم تنتهِ) نبقيها (using ? placeholder = t)،
// وإلا نضع الجديدة (المعامل الثاني = until الجديد).
export async function checkAndSetCooldownOne(env, key, cooldownMs, t = Date.now()) {
  const until = t + cooldownMs;
  const row = await first(
    env,
    `INSERT INTO cooldowns (key, until, counter) VALUES (?2, ?3, 1)
     ON CONFLICT(key) DO UPDATE SET
       until = CASE WHEN cooldowns.until > ?1 THEN cooldowns.until ELSE excluded.until END,
       counter = cooldowns.counter
     RETURNING until`,
    t,
    key,
    until
  );
  const left = row ? Number(row.until) - t : 0;
  return left > 0 ? { ok: false, leftMs: left } : { ok: true, leftMs: 0 };
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
