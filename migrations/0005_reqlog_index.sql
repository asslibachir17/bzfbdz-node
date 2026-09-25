-- ============================================================
-- BZFBDZ — فهرس سجل الطلبات لتنظيف يومي فعّال
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
