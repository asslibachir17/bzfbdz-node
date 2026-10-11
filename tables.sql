-- ============================================================
-- BZFBDZ-node — جداول PostgreSQL
-- 11 جدولاً: المستخدمون/الجلسات/المهل/السجل/البروكسيات...
-- جاهز للتنفيذ على أي قاعدة PostgreSQL (نفس schema المطبَّق عند الإقلاع).
-- ============================================================

-- 1) المستخدمون
CREATE TABLE IF NOT EXISTS users (
  phoneNumber TEXT PRIMARY KEY,
  chat_id TEXT,
  operator TEXT,
  access_token TEXT,
  refresh_token TEXT,
  activation_date BIGINT,
  updated_at BIGINT NOT NULL DEFAULT 0,
  snapchat_activated_at BIGINT,
  gamification_played_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_chat ON users(chat_id);

-- 2) جلسات المحادثة
CREATE TABLE IF NOT EXISTS sessions (
  psid TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT '',
  phone TEXT,
  operator TEXT,
  last_code_sent_at BIGINT,
  menu_ctx TEXT,
  invite_phone TEXT,
  invite_operator TEXT,
  invite_status TEXT,
  last_payload TEXT,
  last_payload_ts BIGINT,
  last_phone_sent TEXT,
  pendingPayload TEXT,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- 3) عدادات نافذة السبام
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL DEFAULT 0,
  limit_value INTEGER NOT NULL DEFAULT 0,
  window_seconds INTEGER NOT NULL DEFAULT 0
);

-- 4) المهل والعدادات (cooldowns + حجب متصاعد)
CREATE TABLE IF NOT EXISTS cooldowns (
  key TEXT PRIMARY KEY,
  until BIGINT NOT NULL DEFAULT 0,
  counter INTEGER NOT NULL DEFAULT 0
);

-- 5) سجل الطلبات
CREATE TABLE IF NOT EXISTS request_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at BIGINT NOT NULL DEFAULT 0,
  direction TEXT,
  kind TEXT,
  method TEXT,
  url TEXT,
  status_code INTEGER,
  duration_ms BIGINT,
  sender_psid TEXT,
  note TEXT
);

-- 6) تثبيت SID لأوريدو (نفس IP بين الإرسال والتحقق)
CREATE TABLE IF NOT EXISTS otp_sids (
  msisdn TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT 0
);

-- 7) البروكسيات السكنية الدوّارة
CREATE TABLE IF NOT EXISTS proxies (
  id BIGSERIAL PRIMARY KEY,
  service TEXT,             -- 'djezzy' | 'ooredoo' | 'shared'
  host TEXT,
  port INTEGER,
  username TEXT,
  password TEXT,
  active INTEGER DEFAULT 1,
  last_used TEXT,           -- ISO تاريخ آخر استخدام (التدوير LIFO)
  blocked_until BIGINT DEFAULT 0  -- حجب مؤقت بعد 429/522/403-Html
);

-- 7.1) بلاك ليست IPs الفعلية (مستقلة عن صفوف البروكسيات): المفتاح (service, ip)
CREATE TABLE IF NOT EXISTS proxy_ip_blacklist (
  service TEXT NOT NULL,
  ip TEXT NOT NULL,
  host TEXT,
  reason TEXT,
  expires_at BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (service, ip)
);

-- 8) المهام المؤجلة
CREATE TABLE IF NOT EXISTS deferred_tasks (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  action TEXT NOT NULL,
  phone TEXT,
  operator TEXT,
  extra TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deferred_status ON deferred_tasks(status, created_at);

-- 9) سجلات تصحيح التلغرام
CREATE TABLE IF NOT EXISTS tg_debug_logs (
  id BIGSERIAL PRIMARY KEY,
  created_at BIGINT NOT NULL DEFAULT 0,
  sender_id TEXT,
  direction TEXT NOT NULL DEFAULT 'in',
  event_type TEXT NOT NULL DEFAULT '',
  action TEXT,
  summary TEXT,
  data TEXT
);

-- 10) سجل الذكرى السنوية
CREATE TABLE IF NOT EXISTS anniversary_log (
  id BIGSERIAL PRIMARY KEY,
  phoneNumber TEXT NOT NULL,
  activated_at BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  api_status INTEGER,
  api_response TEXT,
  sender TEXT
);
CREATE INDEX IF NOT EXISTS idx_anniversary_log_phone ON anniversary_log(phoneNumber);
CREATE INDEX IF NOT EXISTS idx_anniversary_log_activated ON anniversary_log(activated_at);

-- 11) إعداد الذكرى السنوية
CREATE TABLE IF NOT EXISTS anniversary_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT INTO anniversary_config (key, value) VALUES ('enabled', '1')
ON CONFLICT (key) DO NOTHING;