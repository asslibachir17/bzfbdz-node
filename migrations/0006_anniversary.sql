-- 0006_anniversary.sql
-- جدول سجل تفعيل هدية الذكرى
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

-- جدول إعدادات/تحكم في ميزة الذكرى (تشغيل/إيقاف)
CREATE TABLE IF NOT EXISTS anniversary_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
-- القيمة الافتراضية: الميزة مفعّلة
INSERT OR IGNORE INTO anniversary_config (key, value) VALUES ('enabled', '1');
