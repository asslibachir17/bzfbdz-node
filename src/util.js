// أدوات عامة: تنسيق الأرقام، JWT، الوقت الجزائري، وغيرها (لا تتطلب Node APIs)

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function now() {
  return Date.now();
}

export function getOperator(phoneNumber) {
  if (typeof phoneNumber !== 'string') return null;
  if (phoneNumber.startsWith('07')) return 'djezzy';
  if (phoneNumber.startsWith('05')) return 'ooredoo';
  return null;
}

export function isValidDjezzyNumber(number) {
  return /^07\d{8}$/.test(String(number));
}

// تنسيق الرقم: 0712345678 → 07xxxxxx78
export function formatPhoneNumber(inputPhone) {
  const s = String(inputPhone || '');
  if (s.length < 4) return s;
  return `${s.slice(0, 2)}xxxxxx${s.slice(-2)}`;
}

export function maskOoredooPhone(phone) {
  const s = String(phone || '').trim();
  if (s.length < 5) return s;
  return `${s.slice(0, 2)}${'x'.repeat(s.length - 4)}${s.slice(-2)}`;
}

// 07xxxxxxxx → 213xxxxxxxx
export function toInternational(phoneNumber) {
  const s = String(phoneNumber || '').replace(/\D/g, '');
  return `213${s.replace(/^0/, '')}`;
}

// 07xxxxxxxx → 2137xxxxxxxx (أوريدو)
export function ooredooMsisdn(phoneNumber) {
  const digits = String(phoneNumber || '').replace(/\D/g, '');
  return `213${digits.replace(/^0/, '')}`;
}

// ---------------------------------------------------------------------------
// JWT decode بدون Buffer (WebCrypto/atob)
// ---------------------------------------------------------------------------
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// توقيت الجزائر (UTC+1)
// ---------------------------------------------------------------------------
export function parseOoredooTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return new Date(Number(s));
  if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  return new Date(`${s.replace(' ', 'T')}+01:00`);
}

export function algeriaDayKey(value) {
  const d = new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Algiers',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function sameAlgeriaDay(a, b) {
  return algeriaDayKey(a) === algeriaDayKey(b);
}

export function formatAlgeriaTime(value) {
  try {
    const d = parseOoredooTime(value);
    if (!d || Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('ar-DZ', {
      timeZone: 'Africa/Algiers',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return String(value);
  }
}

// الساعة الحالية بتوقيت الجزائر (عدد الساعات) — للدعوات
export function algeriaHour() {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Algiers',
    hour: '2-digit',
    hour12: false,
  }).format(new Date());
  return parseInt(s, 10) % 24;
}

// ---------------------------------------------------------------------------
// تنسيق الوقت المتبقي بالعربية
// ---------------------------------------------------------------------------
export function formatTimeUnit(value, singular, plural, type) {
  if (value === 0) return '';
  if (type === 'day') return value === 1 ? '1 يوم' : ` ${value} أيام`;
  if (value >= 1 && value <= 10) return ` ${value} ${plural}`;
  return ` ${value} ${singular}`;
}

export function formatDurationMs(ms) {
  if (ms <= 0) return '';
  const totalMins = Math.ceil(ms / 60000);
  const days = Math.floor(totalMins / (24 * 60));
  const hours = Math.floor((totalMins % (24 * 60)) / 60);
  const minutes = totalMins % 60;
  const parts = [
    formatTimeUnit(days, 'يوم', 'أيام', 'day'),
    formatTimeUnit(hours, 'ساعة', 'ساعات', 'hour'),
    formatTimeUnit(minutes, 'دقيقة', 'دقائق', 'minute'),
  ].filter(Boolean);
  return parts.join(' و');
}

export function formatMinutesShort(ms) {
  const totalSecs = Math.max(1, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} ساعة`);
  if (mins > 0) parts.push(`${mins} دقيقة`);
  if (secs > 0) parts.push(`${secs} ثانية`);
  return parts.length ? parts.join(' و ') : '1 ثانية';
}

export function formatSecondsShort(ms) {
  return `${Math.max(1, Math.ceil(ms / 1000))} ثانية`;
}

// ---------------------------------------------------------------------------
// سجل خفيف
// ---------------------------------------------------------------------------
export function log(env, ...args) {
  try {
    if (env && String(env.REQUEST_LOGGING) === 'true') {
      console.log(...args);
    } else {
      // سجل دائمًا الأخطاء فقط
    }
  } catch {}
}

export function err(...args) {
  try {
    console.error(...args);
  } catch {}
}
