import crypto from 'crypto';
import { xSignature, generateDeviceFingerprint, platformDataSignature } from './ooredooSign.js';

const BASE_URL = process.env.API_BASE_URL_OOREDOO || 'https://apis.ooredoo.dz';
const CHECKPOINT_PATH = '/api/ooredoo-bff/checkpoint/token';
const TOKEN_PATH = '/api/auth/realms/myooredoo/protocol/openid-connect/token';
const APP_VERSION = process.env.APP_VERSION || '1.5.12';
const INSTANCE_ID = process.env.OOREDOO_INSTANCE_ID || '7f1d9e3c5a6b8f2e4d1c9a7b3e5f8d2c';

// إدارة الذاكرة المؤقتة في Node.js (In-Memory Store)
const memoryStore = new Map();
const otpSids = new Map();

function setCooldown(key, durationMs) {
  memoryStore.set(key, Date.now() + durationMs);
}

function getCooldownLeft(key) {
  const expire = memoryStore.get(key);
  if (!expire) return 0;
  const left = expire - Date.now();
  if (left <= 0) {
    memoryStore.delete(key);
    return 0;
  }
  return left;
}

function freshFlowSid() {
  return 'sid-' + crypto.randomBytes(5).toString('hex');
}

function toMsisdn(phoneNumber) {
  const digits = String(phoneNumber ?? '').replace(/\D/g, '');
  return `213${digits.replace(/^0/, '')}`;
}

export function createOoredoo(env = process.env) {
  // دالة إرسال الطلبات الأساسية باستخدام fetch المدمجة
  async function rawRequest(method, url, headers, data) {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' && method !== 'HEAD' ? data : undefined,
      });

      const text = await response.text();
      let parsedData;
      try {
        parsedData = JSON.parse(text);
      } catch {
        parsedData = text;
      }

      // فحص حجب WAF (صفحات HTML أو أخطاء Origin)
      const isHtml = typeof text === 'string' && /<html|<!doctype/i.test(text);
      if (response.status >= 520 || isHtml) {
        return { statusCode: 403, data: { message: 'حجب شبكي مؤقت', isWafBlock: true } };
      }

      const setCookie = response.headers.get('set-cookie');

      return {
        statusCode: response.status,
        data: parsedData,
        headers: {
          'x-nonce-id': response.headers.get('x-nonce-id'),
          'x-chronos-id': response.headers.get('x-chronos-id'),
          'set-cookie': setCookie,
        },
      };
    } catch (err) {
      return { statusCode: 500, data: { message: err.message } };
    }
  }

  // Handshake للحصول على x-nonce-id و x-chronos-id
  async function nonceHandshake(msisdn, path, method) {
    const ts = Date.now();
    const corr = `${ts}-${Math.floor(100 + Math.random() * 900)}`;
    const fp = await generateDeviceFingerprint(INSTANCE_ID, msisdn, ts);
    const sig = xSignature();

    const headers = {
      'User-Agent': 'Dart/3.4 (dart:io)',
      'Content-Type': 'application/json',
      'platform': 'android',
      'X-Platform-Origin': 'mobile-android',
      'x-msisdn': msisdn,
      'X-Correlation-ID': corr,
      'x-signature': sig,
      'x-version': APP_VERSION,
      'X-Timestamp': String(ts),
      'X-Instance-Id': INSTANCE_ID,
      'X-Device-Fingerprint': fp,
      'x-force-update': 'true',
      'x-path': path,
      'x-method': method,
    };

    const res = await rawRequest('POST', `${BASE_URL}${CHECKPOINT_PATH}`, headers, '{}');
    if (res.statusCode !== 200 || !res.headers) return null;

    const nonceId = res.headers['x-nonce-id'];
    const chronosId = res.headers['x-chronos-id'];
    const cookie = res.headers['set-cookie'] || '';

    if (!nonceId || !chronosId) return null;

    return { nonceId, chronosId, cookie, signature: sig, correlationId: corr, timestamp: ts, fingerprint: fp };
  }

  // 1. إرسال رمز OTP
  async function sendVerificationCode(phoneNumber) {
    const msisdn = toMsisdn(phoneNumber);
    const cooldownKey = `cooldown:${msisdn}`;
    
    const leftMs = getCooldownLeft(cooldownKey);
    if (leftMs > 0) {
      return {
        statusCode: 429,
        data: { message: `كثرة المحاولات، أعد المحاولة بعد ${Math.ceil(leftMs / 1000)} ثانية.` }
      };
    }

    const n = await nonceHandshake(msisdn, TOKEN_PATH, 'POST');
    if (!n) {
      return { statusCode: 403, data: { message: 'فشل الاتصال بسيرفر الخدمة، أعد المحاولة.' } };
    }

    const params = new URLSearchParams({
      client_id: 'myooredoo-app',
      grant_type: 'password',
      username: msisdn,
    });
    if (env.OOREDOO_PASSWORD) {
      params.append('password', env.OOREDOO_PASSWORD);
    }

    const headers = {
      'User-Agent': 'Dart/3.4 (dart:io)',
      'Content-Type': 'application/x-www-form-urlencoded',
      'platform': 'android',
      'X-Platform-Origin': 'mobile-android',
      'x-msisdn': msisdn,
      'X-Correlation-ID': n.correlationId,
      'x-signature': n.signature,
      'x-version': APP_VERSION,
      'X-Timestamp': String(n.timestamp),
      'X-Instance-Id': INSTANCE_ID,
      'X-Device-Fingerprint': n.fingerprint,
      'x-force-update': 'true',
      'x-nonce-id': n.nonceId,
      'x-chronos-id': n.chronosId,
      ...(n.cookie ? { Cookie: n.cookie } : {}),
    };

    const res = await rawRequest('POST', `${BASE_URL}${TOKEN_PATH}`, headers, params.toString());

    if (res.statusCode === 200 || res.statusCode === 403) {
      setCooldown(cooldownKey, 60000);
      otpSids.set(msisdn, freshFlowSid());
      return { statusCode: 200, data: { message: 'تم إرسال الرمز بنجاح', otpRequired: true } };
    }

    return res;
  }

  // 2. تأكيد رمز OTP
  async function verifyCode(phoneNumber, code) {
    const msisdn = toMsisdn(phoneNumber);
    const n = await nonceHandshake(msisdn, TOKEN_PATH, 'POST');
    if (!n) {
      return { statusCode: 403, data: { message: 'فشل الاتصال بسيرفر الخدمة، أعد المحاولة.' } };
    }

    const params = new URLSearchParams({
      grant_type: 'password',
      username: msisdn,
      client_id: 'myooredoo-app',
      otp: String(code ?? '').trim(),
    });

    const headers = {
      'User-Agent': 'Dart/3.4 (dart:io)',
      'Content-Type': 'application/x-www-form-urlencoded',
      'platform': 'android',
      'X-Platform-Origin': 'mobile-android',
      'x-msisdn': msisdn,
      'X-Correlation-ID': n.correlationId,
      'x-signature': n.signature,
      'x-version': APP_VERSION,
      'X-Timestamp': String(n.timestamp),
      'X-Instance-Id': INSTANCE_ID,
      'X-Device-Fingerprint': n.fingerprint,
      'x-force-update': 'true',
      'x-nonce-id': n.nonceId,
      'x-chronos-id': n.chronosId,
      ...(n.cookie ? { Cookie: n.cookie } : {}),
    };

    return await rawRequest('POST', `${BASE_URL}${TOKEN_PATH}`, headers, params.toString());
  }

  // 3. تجديد التوكن Refresh Token
  async function refreshToken(phoneNumber, refreshTokenValue) {
    const msisdn = toMsisdn(phoneNumber);
    const n = await nonceHandshake(msisdn, TOKEN_PATH, 'POST');
    if (!n) {
      return { statusCode: 403, data: { message: 'فشل الاتصال بسيرفر الخدمة، أعد المحاولة.' } };
    }

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'myooredoo-app',
      refresh_token: refreshTokenValue,
    });

    const headers = {
      'User-Agent': 'Dart/3.4 (dart:io)',
      'Content-Type': 'application/x-www-form-urlencoded',
      'platform': 'android',
      'X-Platform-Origin': 'mobile-android',
      'x-msisdn': msisdn,
      'X-Correlation-ID': n.correlationId,
      'x-signature': n.signature,
      'x-version': APP_VERSION,
      'X-Timestamp': String(n.timestamp),
      'X-Instance-Id': INSTANCE_ID,
      'X-Device-Fingerprint': n.fingerprint,
      'x-force-update': 'true',
      'x-nonce-id': n.nonceId,
      'x-chronos-id': n.chronosId,
      ...(n.cookie ? { Cookie: n.cookie } : {}),
    };

    return await rawRequest('POST', `${BASE_URL}${TOKEN_PATH}`, headers, params.toString());
  }

  // 4. تصفير الذاكرة
  function resetAllCooldowns() {
    memoryStore.clear();
    otpSids.clear();
    return { success: true, message: 'تم تصفير جميع العدادات بنجاح' };
  }

  return {
    sendVerificationCode,
    verifyCode,
    refreshToken,
    resetAllCooldowns,
  };
}
