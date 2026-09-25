-- ============================================================
-- BZFBDZ — مخطط قاعدة بيانات D1 (SQLite)
-- تُطبَّق عبر: wrangler d1 migrations apply bzfbdz
-- ملاحظة: كل التواريخ أرقام epoch بالملّي ثانية (رقم صحيح)
-- ============================================================

-- المستخدمون (بديل جدول Postgres الأصلي)
CREATE TABLE IF NOT EXISTS users (
  phoneNumber TEXT PRIMARY KEY,
  chat_id TEXT,
  operator TEXT,
  access_token TEXT,
  refresh_token TEXT,
  activation_date INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  snapchat_activated_at INTEGER,
  gamification_played_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_chat ON users(chat_id);

-- جلسات المحادثة (حالة التحقق، القائمة المحفوظة، حالة الدعوة)
CREATE TABLE IF NOT EXISTS sessions (
  psid TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT '',
  phone TEXT,
  operator TEXT,
  last_code_sent_at INTEGER,
  menu_ctx TEXT,
  invite_phone TEXT,
  invite_operator TEXT,
  invite_status TEXT,
  last_payload TEXT,
  last_payload_ts INTEGER,
  last_phone_sent TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- عدادات نافذة السبام (إدخال لكل مفتاح)
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  limit_value INTEGER NOT NULL DEFAULT 0,
  window_seconds INTEGER NOT NULL DEFAULT 0
);

-- المهل والعدادات (cooldowns + عدادات الحجب المتصاعد)
CREATE TABLE IF NOT EXISTS cooldowns (
  key TEXT PRIMARY KEY,
  until INTEGER NOT NULL DEFAULT 0,
  counter INTEGER NOT NULL DEFAULT 0
);

-- سجل الطلبات (اختياري — يُفعَّل عبر REQUEST_LOGGING=true)
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT 0,
  direction TEXT,
  kind TEXT,
  method TEXT,
  url TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  sender_psid TEXT,
  note TEXT
);
