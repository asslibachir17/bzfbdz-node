// توقيع أوريدو وتوقيع الجهاز عبر WebCrypto (بديل node:crypto)
// X-Signature قيمة ثابتة محسوبة مسبقًا (تُمرَّر عبر env.X_SIGNATURE أو القيمة الافتراضية)

const DEFAULT_X_SIGNATURE = '634efc7e419e3f5797ec445e29176c525cee4bfc17de0a8f4c399da5a3628ac1';

const encoder = new TextEncoder();

export function xSignature(env) {
  return env.X_SIGNATURE || env.OOREDOO_X_SIGNATURE || DEFAULT_X_SIGNATURE;
}

// generateDeviceFingerprint = hex( HMAC_SHA256(key=utf8(ts), data=utf8(msisdn+instance+ts)) )
export async function generateDeviceFingerprint(instanceId, msisdn, timestamp) {
  const ts = String(timestamp);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(ts),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${msisdn}${instanceId}${ts}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function platformDataSignature(deviceId) {
  return btoa(JSON.stringify({ platform: 'android', 'is-physical-device': true, 'device-id': deviceId }));
}
