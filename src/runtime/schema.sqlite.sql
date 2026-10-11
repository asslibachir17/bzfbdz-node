-- ============================================================
-- BZFBDZ-node — مخطط قاعدة البيانات المحلية (SQLite / better-sqlite3)
-- مكافئ لمجموعة هجرات D1 (0001–0006) + الجداول اليدوية الحية.
-- كل التواريخ أرقام epoch بالملّي ثانية.
-- ============================================================

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
  pendingPayload TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL DEFAULT 0,
  limit_value INTEGER NOT NULL DEFAULT 0,
  window_seconds INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cooldowns (
  key TEXT PRIMARY KEY,
  until INTEGER NOT NULL DEFAULT 0,
  counter INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE IF NOT EXISTS otp_sids (
  msisdn TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT,
  host TEXT,
  port INTEGER,
  username TEXT,
  password TEXT,
  active INTEGER DEFAULT 1,
  last_used TEXT,
  blocked_until INTEGER DEFAULT 0
);

-- بلاك ليست IPs الفعلية (مستقلة عن صفوف البروكسيات): المفتاح (service, ip)
CREATE TABLE IF NOT EXISTS proxy_ip_blacklist (
  service TEXT NOT NULL,
  ip TEXT NOT NULL,
  host TEXT,
  reason TEXT,
  expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service, ip)
);

CREATE TABLE IF NOT EXISTS deferred_tasks (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  action TEXT NOT NULL,
  phone TEXT,
  operator TEXT,
  extra TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deferred_status ON deferred_tasks(status, created_at);

CREATE TABLE IF NOT EXISTS tg_debug_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT 0,
  sender_id TEXT,
  direction TEXT NOT NULL DEFAULT 'in',
  event_type TEXT NOT NULL DEFAULT '',
  action TEXT,
  summary TEXT,
  data TEXT
);

CREATE TABLE IF NOT EXISTS anniversary_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phoneNumber TEXT NOT NULL,
  activated_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  api_status INTEGER,
  api_response TEXT,
  sender TEXT
);
CREATE INDEX IF NOT EXISTS idx_anniversary_log_phone ON anniversary_log(phoneNumber);
CREATE INDEX IF NOT EXISTS idx_anniversary_log_activated ON anniversary_log(activated_at);

CREATE TABLE IF NOT EXISTS anniversary_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO anniversary_config (key, value) VALUES ('enabled', '1');

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('djezzy_maintenance', '0');