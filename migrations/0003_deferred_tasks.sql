-- ============================================================
-- BZFBDZ — المهام المؤجلة (Deferred Tasks)
-- للتغلب على حد 30 ثانية للخطة المجانية: عند الضغط على زر تفعيل
-- (باقة/هدية/سناب/BYOP/2Go) نرد فورًا ثم نخزن المهمة هنا،
-- وينفذها الـ cron كل دقيقة ويعيد المحاولة حتى تكتمل ثم يغلقها.
-- تُطبَّق عبر: wrangler d1 migrations apply bzfbdz --remote
-- ============================================================

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
