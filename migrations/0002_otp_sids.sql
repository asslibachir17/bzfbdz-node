-- ============================================================
-- BZFBDZ — تثبيت SID تدفقات OTP لأوريدو
-- أوريدو يقيّد الرمز بالـ IP الذي أرسله، لذلك نثبّت نفس SID
-- (نفس IP الخروج من البروكسي) بين الإرسال والتحقق.
-- تُطبَّق عبر: wrangler d1 migrations apply bzfbdz --remote
-- ============================================================

CREATE TABLE IF NOT EXISTS otp_sids (
  msisdn TEXT PRIMARY KEY,
  sid TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
