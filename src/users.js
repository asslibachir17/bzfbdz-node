// عمليات جدول المستخدمين (D1) — بديل عن Postgres الأصلي
import { first, run } from './db.js';

const TIMESTAMP_COLUMNS = ['activation_date', 'gamification_played_at', 'snapchat_activated_at'];

export async function getUserByPhone(env, phoneNumber) {
  if (!phoneNumber) return null;
  return first(env, 'SELECT * FROM users WHERE phoneNumber = ? LIMIT 1', phoneNumber);
}

export async function createOrUpdateUser(env, { phoneNumber, chatId, operator, accessToken, refreshToken }) {
  const t = Date.now();
  await run(
    env,
    `INSERT INTO users (phoneNumber, chat_id, operator, access_token, refresh_token, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(phoneNumber) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       chat_id = excluded.chat_id,
       operator = excluded.operator,
       updated_at = excluded.updated_at`,
    phoneNumber,
    chatId,
    operator,
    accessToken,
    refreshToken,
    t,
    t
  );
}

export async function updateUserTokens(env, phoneNumber, accessToken, refreshToken) {
  await run(
    env,
    'UPDATE users SET access_token = ?, refresh_token = ?, updated_at = ? WHERE phoneNumber = ?',
    accessToken,
    refreshToken,
    Date.now(),
    phoneNumber
  );
}

export async function updateActivationDate(env, phoneNumber) {
  await run(env, 'UPDATE users SET activation_date = ? WHERE phoneNumber = ?', Date.now(), phoneNumber);
}

export async function setUserTimestamp(env, phoneNumber, column, ms) {
  if (!TIMESTAMP_COLUMNS.includes(column)) return false;
  await run(env, `UPDATE users SET ${column} = ? WHERE phoneNumber = ?`, Number(ms) || Date.now(), phoneNumber);
  return true;
}

export async function getOoredooTimestamps(env, phoneNumber) {
  const row = await first(
    env,
    'SELECT snapchat_activated_at, gamification_played_at FROM users WHERE phoneNumber = ?',
    phoneNumber
  );
  return row || {};
}

// ---------------- إعادة تعيين سناب شات اليومية (بتوقيت الجزائر UTC+1) ----------------
// ووركرز لا يدعم cron، لذلك نقوم بفحص كسول: عند كل رسالة مستخدم نتحقق إن كان
// اليوم الجزائري قد تغيّر (منتصف الليل 12:00)، وعندها نُصفّر تواريخ تفعيل سناب شات
// لكل المستخدمين. يُنفَّذ مرة واحدة يوميًا فقط (مفتاح في جدول cooldowns).
export async function maybeDailySnapchatReset(env, t = Date.now()) {
  const dayNum = Math.floor((t + 3600000) / 86400000); // عدد الأيام منذ العصر بتوقيت الجزائر
  const marker = await first(env, 'SELECT until FROM cooldowns WHERE key = ?', 'snapchat_daily_reset');
  if (marker && Number(marker.until) >= dayNum) return false;
  await run(env, 'UPDATE users SET snapchat_activated_at = NULL WHERE snapchat_activated_at IS NOT NULL');
  await run(
    env,
    'INSERT INTO cooldowns (key, until) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until',
    'snapchat_daily_reset',
    dayNum
  );
  return true;
}

// واجهة موحّدة تُستخدم من bot.js (تتلقى access_token/refresh_token بصيغة snake_case)
export const users = {
  getUserByPhone,
  updateUserTokens,
  updateActivationDate,
  upsertUser: (env, u) =>
    createOrUpdateUser(env, {
      phoneNumber: u.phoneNumber,
      chatId: u.chatId,
      operator: u.operator,
      accessToken: u.access_token,
      refreshToken: u.refresh_token,
    }),
};
