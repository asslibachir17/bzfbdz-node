// ===========================================================================
// نظام مضاد السبام متعدد الطبقات — هدفه إيقاف السبام قبل أن يستهلك طلبات خارجية
//
//  الطبقة 1: انفجار الذاكرة (per-isolate، تكلفة صفر) — يوقف الفيض فورًا
//  الطبقة 2: نافذة D1 ثابتة لكل مستخدم (دقيقة) — يوقف الإساءة المستمرة
//  الطبقة 3: نافذة يومية (لأصحاب الإساءة الشديدة) + حجز أبدي تقريبًا
//  الطبقة 4: منع تكرار نفس الزر/النص خلال ثوانٍ
//  الطبقة 5: حدود عالمية في المثيل (حماية من موجات الرسائل الجماعية)
// ===========================================================================
import { first } from './db.js';
import { rateConfig } from './config.js';

// ---------------- الطبقة 1 + 5: في الذاكرة (لا D1 إطلاقًا) ----------------
const burstMap = new Map(); // key -> { until: ms, hits: [] }
const globalEvents = []; // الطوابع الزمنية للأحداث في هذا المثيل

// returns true إذا سُمح بالمرور
function memoryBurstCheck(key, max, windowMs, blockMs, t = Date.now()) {
  const rec = burstMap.get(key);
  if (rec && rec.until > t) return false; // محظور مؤقتًا
  const arr = rec ? rec.hits : [];
  const cutoff = t - windowMs;
  while (arr.length && arr[0] <= cutoff) arr.shift();
  if (arr.length >= max) {
    burstMap.set(key, { until: t + blockMs, hits: [] });
    return false;
  }
  arr.push(t);
  burstMap.set(key, { hits: arr, until: rec && rec.until > t ? rec.until : 0 });
  return true;
}

function globalBurstCheck(max, windowMs, t = Date.now()) {
  const cutoff = t - windowMs;
  while (globalEvents.length && globalEvents[0] <= cutoff) globalEvents.shift();
  if (globalEvents.length >= max) return false;
  globalEvents.push(t);
  return true;
}

// فحص سريع متزامن يُستدعى قبل أي عمل (تكلفة صفر) — يرفض الفيض فورًا
export function fastFloodGate(sender, rc, t = Date.now()) {
  if (!sender) return true;
  if (!globalBurstCheck(rc.globalBurstMax, rc.globalBurstWindowMs, t)) return false;
  return memoryBurstCheck(`s:${sender}`, rc.senderBurstMax, rc.senderBurstWindowMs, rc.senderBurstBlockMs, t);
}

// ---------------- الطبقة 2 + 3: D1 (نافذة ثابتة) ----------------
// يزيد العداد ويرجع عدد أحداث النافذة الحالية
export async function incrWindow(env, key, limit, windowSeconds, t = Date.now()) {
  const winStart = t - windowSeconds * 1000;
  const row = await first(
    env,
    `INSERT INTO rate_limits (key, count, window_start, limit_value, window_seconds)
     VALUES (?1, 1, ?2, ?3, ?4)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start <= ?5 THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start <= ?5 THEN ?2 ELSE rate_limits.window_start END,
       limit_value = ?3,
       window_seconds = ?4
     RETURNING count, limit_value`,
    key,
    t,
    limit,
    windowSeconds,
    winStart
  );
  const count = row && row.count !== undefined ? Number(row.count) : 1;
  const lim = row && row.limit_value !== undefined ? Number(row.limit_value) : limit;
  return { count, limit: lim, ok: count <= lim };
}

// فحص شامل لكل مستخدم — يُستدعى داخل معالجة الحدث (بعد fastFloodGate)
// يرجع { ok } فقط؛ الرسائل الزائدة تُتجاهل بصمت دون إشعار المستخدم.
export async function checkRateLimit(env, sender, t = Date.now()) {
  const rc = rateConfig(env);
  if (!sender) return { ok: true };

  // نافذة الدقيقة — دائمًا
  const w60 = await incrWindow(env, `rl:s:${sender}`, rc.rate60sMax, 60, t);
  if (!w60.ok) {
    return { ok: false };
  }

  // النافذة اليومية — نقرر كتابتها نادرًا (كل 5 أحداث) لتوفير كتابات D1
  if (w60.count === 1 || w60.count % 5 === 0) {
    const day = await incrWindow(env, `rl:d:${sender}`, rc.rateDayMax, 86400, t);
    if (!day.ok) return { ok: false };
  }

  return { ok: true };
}

// ---------------- الطبقة 4: تكرار نفس الزر/النص ----------------
export function isDuplicatePayload(session, payload, ttlMs, t = Date.now()) {
  if (!session) return false;
  if (session.last_payload && session.last_payload === payload) {
    const last = Number(session.last_payload_ts || 0);
    if (last > 0 && t - last < ttlMs) return true;
  }
  return false;
}
