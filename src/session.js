// جلسة المستخدم (حالة التحقق، آخر قائمة، حالة الدعوة...) مخزّنة في D1
// حتى تعمل عبر جميع عقد Cloudflare (ليست مجرد ذاكرة محلية).
import { first, run } from './db.js';

export const DEFAULT_SESSION = {
  psid: '',
  stage: '', // waiting_code | verified | ''
  phone: null,
  operator: null,
  last_code_sent_at: 0,
  menu_ctx: null, // JSON string: { quick_replies: [...], ts }
  invite_phone: null,
  invite_operator: null,
  invite_status: null,
  last_payload: null,
  last_payload_ts: 0,
  last_phone_sent: null,
  pendingPayload: null,
  updated_at: 0,
};

export function emptySession(psid) {
  return { ...DEFAULT_SESSION, psid, updated_at: Date.now() };
}

export async function loadSession(env, psid) {
  const row = await first(env, 'SELECT * FROM sessions WHERE psid = ?', psid);
  if (!row) return emptySession(psid);
  return { ...DEFAULT_SESSION, ...row };
}

export async function saveSession(env, s) {
  s.updated_at = Date.now();
  await run(
    env,
    `INSERT INTO sessions
       (psid, stage, phone, operator, last_code_sent_at, menu_ctx,
        invite_phone, invite_operator, invite_status,
        last_payload, last_payload_ts, last_phone_sent, pendingPayload, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(psid) DO UPDATE SET
       stage = excluded.stage,
       phone = excluded.phone,
       operator = excluded.operator,
       last_code_sent_at = excluded.last_code_sent_at,
       menu_ctx = excluded.menu_ctx,
       invite_phone = excluded.invite_phone,
       invite_operator = excluded.invite_operator,
       invite_status = excluded.invite_status,
       last_payload = excluded.last_payload,
       last_payload_ts = excluded.last_payload_ts,
       last_phone_sent = excluded.last_phone_sent,
       pendingPayload = excluded.pendingPayload,
       updated_at = excluded.updated_at`,
    s.psid,
    s.stage,
    s.phone,
    s.operator,
    Number(s.last_code_sent_at) || 0,
    s.menu_ctx,
    s.invite_phone,
    s.invite_operator,
    s.invite_status,
    s.last_payload,
    Number(s.last_payload_ts) || 0,
    s.last_phone_sent,
    s.pendingPayload || null,
    s.updated_at
  );
}

export function setMenuContext(session, quickReplies) {
  if (quickReplies && quickReplies.length > 0) {
    session.menu_ctx = JSON.stringify({
      quick_replies: quickReplies,
      ts: Date.now(),
    });
  } else {
    session.menu_ctx = null;
  }
}

export function getMenuContext(session, ttlMs) {
  if (!session || !session.menu_ctx) return null;
  try {
    const ctx = JSON.parse(session.menu_ctx);
    if (!ctx || !Array.isArray(ctx.quick_replies)) return null;
    if (Date.now() - (ctx.ts || 0) > ttlMs) return null;
    return ctx;
  } catch {
    return null;
  }
}

// واجهة الجلسات المستخدمة من bot.js (الوسيط بين منطق البوت وجدول D1)
export const sessionStore = {
  async get(env, psid) {
    return loadSession(env, psid);
  },
  async set(env, psid, session) {
    await saveSession(env, session);
  },
};
