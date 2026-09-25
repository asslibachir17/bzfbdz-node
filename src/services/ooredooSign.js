const crypto = require('node:crypto');

// =========================================================================
// قيم ثابتة مستخرجة مسبقاً من my-ooredoo-algeria-1-5-12.apk
// (متحقق منها: apkIntegrity(apk) يعيد نفس القيم بالضبط)
// =========================================================================
const DEFAULT_CHECKSUM = '3138619328'; // CRC32 لـ classes.dex
const DEFAULT_SIGNATURE = 'SCvfcghAsOtibBJqbzKRDHQYCgnuW/eAJp/R0CndYwg='; // توقيع الشهادة Base64

// حساب الـ X-Signature الثابت مسبقاً مرة واحدة عند تحميل الملف
const CACHED_X_SIGNATURE = process.env.X_SIGNATURE
  || process.env.OOREDOO_X_SIGNATURE
  || generateXSignature(DEFAULT_CHECKSUM, DEFAULT_SIGNATURE);

/**
 * generateDeviceFingerprint(instanceId, msisdn, timestamp)
 * = hex( HMAC_SHA256(key = utf8(timestamp), data = utf8(msisdn + instanceId + timestamp)) )
 */
function generateDeviceFingerprint(instanceId, msisdn, timestamp) {
  const ts = String(timestamp);
  const key = Buffer.from(ts, 'utf8');
  const data = Buffer.from(`${msisdn}${instanceId}${ts}`, 'utf8');
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/**
 * generateXSignature(checksum, signature) = sha256hex( utf8(signature + checksum) )
 */
function generateXSignature(checksum, signature) {
  return crypto
    .createHash('sha256')
    .update(`${signature}${checksum}`, 'utf8')
    .digest('hex');
}

/**
 * دالة استرجاع التوقيع فوراً من الذاكرة (0ms)
 */
function xSignature() {
  return CACHED_X_SIGNATURE;
}

/**
 * دالة وهمية سريعة لضمان عدم كسر الكود الذي يستدعي apkIntegrity في أماكن أخرى
 */
function apkIntegrity() {
  return {
    checksum: DEFAULT_CHECKSUM,
    signature: DEFAULT_SIGNATURE,
    xSignature: CACHED_X_SIGNATURE,
  };
}

module.exports = {
  generateDeviceFingerprint,
  generateXSignature,
  apkIntegrity,
  xSignature,
};
