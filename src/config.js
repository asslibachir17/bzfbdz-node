// إعدادات وثوابت البوت — تُقرأ من متغيرات البيئة (wrangler vars / secrets)

export const FB_GRAPH = 'https://graph.facebook.com/v19.0';

// مهلات عامة
export const FB_BUTTON_REPEAT_TTL = 3000; // تجاهل الضغط المتكرر على نفس الزر خلال 3 ثوانٍ
export const MENU_CONTEXT_TTL = 15 * 60 * 1000; // صلاحية آخر قائمة أزرار محفوظة (للمطابقة المفتاحية المحلية على عنوان الأزرار)
export const ACTIVATE_2G_COOLDOWN_MS = 168 * 60 * 60 * 1000; // 168 ساعة بين تفعيلات 2Go
export const ACTIVATE_2G_TRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 دقائق بين محاولات 2Go (نجاح أو "لم يمر أسبوع")
export const TOKEN_REFRESH_AFTER_MS = 210 * 60 * 1000; // تحديث التوكن بعد 3.5 ساعات

export function num(env, key, def) {
  const v = env[key];
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : def;
}

export function str(env, key, def) {
  const v = env[key];
  return v === undefined || v === '' ? def : String(v);
}

export function bool(env, key, def) {
  const v = env[key];
  if (v === undefined || v === '') return def;
  return String(v).toLowerCase() === 'true' || v === '1';
}

export function rateConfig(env) {
  return {
    senderBurstMax: num(env, 'PER_SENDER_BURST_MAX', 5),
    senderBurstWindowMs: num(env, 'PER_SENDER_BURST_WINDOW_MS', 2000),
    senderBurstBlockMs: num(env, 'PER_SENDER_BURST_BLOCK_MS', 8000),
    globalBurstMax: num(env, 'GLOBAL_BURST_MAX', 40),
    globalBurstWindowMs: num(env, 'GLOBAL_BURST_WINDOW_MS', 5000),
    rate60sMax: num(env, 'RATE_60S_MAX', 10),
    rateDayMax: num(env, 'RATE_DAY_MAX', 300),
    rateWarnCount: num(env, 'RATE_WARN_COUNT', 14),
    otpResendMinMs: num(env, 'OTP_RESEND_MIN_MS', 20000),
    botServiceCooldownMs: num(env, 'BOT_SERVICE_COOLDOWN_MS', 120000),
  };
}
