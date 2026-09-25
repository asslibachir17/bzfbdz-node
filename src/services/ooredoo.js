import crypto from 'node:crypto';
import { httpRequest } from './http.js';
import { xSignature, generateDeviceFingerprint, platformDataSignature } from './ooredooSign.js';
import { sleep } from '../util.js';
import { cooldownLeftMs, setCooldown, extendCooldown, bumpCounter, resetCounter } from '../cooldowns.js';

const CHECKPOINT_PATH = '/api/ooredoo-bff/checkpoint/token';
const TOKEN_PATH = '/api/auth/realms/myooredoo/protocol/openid-connect/token';

const OTP_PACE_MS = 2500; // تباعد بين طلبات OTP
const WAF_MAX = 180000; // أقصى كولدداون عند حجب شبكي متكرر

// ---------- تثبيت SID (نفس IP الخروج) بين إرسال/تحقق OTP ----------
const SID_PREFIX = 'sid-';
const inMemoryOtpSids = new Map();

function freshFlowSid() {
  const bytes = crypto.randomBytes(5);
  return SID_PREFIX + bytes.toString('hex');
}

async function pinOtpSid(db, msisdn, sid) {
  if (db && typeof db.prepare === 'function') {
    try {
      await db.prepare('INSERT INTO otp_sids (msisdn, sid, created_at) VALUES (?, ?, ?) ON CONFLICT(msisdn) DO UPDATE SET sid = excluded.sid, created_at = excluded.created_at')
        .bind(msisdn, sid, Date.now())
        .run();
      return;
    } catch (e) {
      console.log(`[Ooredoo] فشل حفظ SID في DB: ${e.message}`);
    }
  }
  inMemoryOtpSids.set(msisdn, { sid, createdAt: Date.now() });
}

async function getPinnedSid(db, msisdn) {
  if (db && typeof db.prepare === 'function') {
    try {
      const row = await db.prepare('SELECT sid FROM otp_sids WHERE msisdn = ?').bind(msisdn).first();
      if (row) return row.sid;
    } catch {}
  }
  const item = inMemoryOtpSids.get(msisdn);
  return item ? item.sid : null;
}

async function clearPinnedSid(db, msisdn) {
  if (db && typeof db.prepare === 'function') {
    try {
      await db.prepare('DELETE FROM otp_sids WHERE msisdn = ?').bind(msisdn).run();
    } catch {}
  }
  inMemoryOtpSids.delete(msisdn);
}

function parseBody(data) {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  return data;
}

function toMsisdn(phoneNumber) {
  const digits = String(phoneNumber ?? '').replace(/\D/g, '');
  return `213${digits.replace(/^0/, '')}`;
}

// هل الاستجابة تدل على حجب WAF أو حظر شبكي فعلي؟
function isBlocked(res) {
  if (!res) return false;
  if (res.status === 407) return false;
  if (res.status >= 520 && res.status <= 526) return true;
  if (typeof res.data === 'string' && /<html|<!doctype/i.test(res.data)) return true;
  return false;
}

function cookieJar(headers) {
  if (!headers) return '';
  try {
    if (typeof headers.getSetCookie === 'function') {
      const raw = headers.getSetCookie();
      if (raw && raw.length) return raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    }
  } catch {}
  try {
    const s = typeof headers.get === 'function' ? headers.get('set-cookie') : (headers['set-cookie'] || '');
    if (Array.isArray(s)) {
      return s.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    }
    if (s) return s.split(',').map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  } catch {}
  return '';
}

function freshTimestamp(ms) {
  const base = new Date(ms).toISOString().slice(0, 19);
  const micro = String((ms % 1000) * 1000 + Math.floor(Math.random() * 1000)).padStart(6, '0');
  return `${base}.${micro}Z`;
}

export function createOoredoo(env = {}) {
  const base = env.API_BASE_URL_OOREDOO || process.env.API_BASE_URL_OOREDOO || 'https://apis.ooredoo.dz';
  const appVersion = env.APP_VERSION || process.env.APP_VERSION || '1.5.15';
  const instanceId = env.OOREDOO_INSTANCE_ID || process.env.OOREDOO_INSTANCE_ID || '7f1d9e3c5a6b8f2e4d1c9a7b3e5f8d2c';
  const byopValidity = env.OOREDOO_BYOP_VALIDITY || process.env.OOREDOO_BYOP_VALIDITY || 'Biweekly';

  const BYOP_CODES = ['IG', 'YT', 'WA', 'FB', env.OOREDOO_BYOP_TT_CODE || process.env.OOREDOO_BYOP_TT_CODE || '2Go_Tt'];
  const BYOP_LIMITED_CODES = String(env.OOREDOO_BYOP_LIMITED_CODES || process.env.OOREDOO_BYOP_LIMITED_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // ---------- كولدداونات WAF ----------
  async function wafBlocked() {
    return (await cooldownLeftMs(env, 'oo:waf')) > 0;
  }

  async function registerWafBlock() {
    const c = await bumpCounter(env, 'oo:waf:count');
    if (c >= 2) {
      const ms = Math.min(WAF_MAX, 30000 * Math.pow(2, c - 2));
      await extendCooldown(env, 'oo:waf', ms);
      console.log(`[Ooredoo] حجب WAF متكرر (${c}) ← كولدداون ${Math.round(ms / 1000)}s`);
    }
  }

  async function resetWafCounter() {
    await resetCounter(env, 'oo:waf:count');
  }

  // ---------- تباعد OTP ----------
  async function withOtpPacing() {
    const left = await cooldownLeftMs(env, 'oo:otp:pace');
    if (left > 0) await sleep(left);
    await setCooldown(env, 'oo:otp:pace', OTP_PACE_MS);
  }

  // ---------- الرؤوس ----------
  function commonHeaders({ sig, corr, ts, fp, msisdn, cookie }) {
    return {
      'User-Agent': 'Dart/3.4 (dart:io)',
      Accept: '*/*',
      platform: 'android',
      'X-Platform-Origin': 'mobile-android',
      'x-msisdn': msisdn,
      'X-Correlation-ID': corr,
      'x-signature': sig,
      'x-version': appVersion,
      'X-Timestamp': String(ts),
      'X-Instance-Id': instanceId,
      'X-Device-Fingerprint': fp,
      'x-force-update': 'true',
      ...(cookie ? { Cookie: cookie } : {}),
    };
  }

  async function rawRequest(method, url, headers, body, sid) {
    const res = await httpRequest(env, {
      method,
      url,
      headers,
      body,
      relayKey: 'OOREDOO_RELAY_URL',
      useDbProxy: true,
      proxyService: 'ooredoo',
      sid,
      timeoutMs: 25000,
      directFirst: true,
    });

    if (isBlocked(res)) {
      await registerWafBlock();
      console.log('[ooredoo] rawRequest blocked:', method, url.split('/').pop(), 'status=', res.status, 'via=', res.via, 'body=', String(res.text || (res.data && res.data.message) || '').slice(0, 160));
      return { statusCode: 403, data: { message: 'تعذر الاتصال بالخادم، يرجى المحاولة لاحقًا', blocked: true, detail: String(res.text || '').slice(0, 120) } };
    }

    return { statusCode: res.status || 500, data: parseBody(res.data), text: res.text, via: res.via };
  }

  async function checkpoint(sig, corr, ts, fp, msisdn, path, method, cookie, sid) {
    const res = await httpRequest(env, {
      method: 'POST',
      url: `${base}${CHECKPOINT_PATH}`,
      headers: {
        ...commonHeaders({ sig, corr, ts, fp, msisdn, cookie }),
        'Content-Type': 'application/json',
        'x-path': path,
        'x-method': method,
      },
      body: '{}',
      relayKey: 'OOREDOO_RELAY_URL',
      useDbProxy: true,
      proxyService: 'ooredoo',
      sid,
      timeoutMs: 25000,
      directFirst: true,
    });

    if (isBlocked(res)) {
      await registerWafBlock();
      return null;
    }
    return res;
  }

  async function nonceHandshake(msisdn, path, method, sid) {
    const ts = Date.now();
    const corr = `${ts}-${Math.floor(100 + Math.random() * 900)}`;
    const fp = await generateDeviceFingerprint(instanceId, msisdn, ts);
    const sig = xSignature(env);
    const cp = await checkpoint(sig, corr, ts, fp, msisdn, path, method, undefined, sid);
    if (!cp) return null;

    const getHeader = (key) => {
      if (!cp.headers) return null;
      if (typeof cp.headers.get === 'function') return cp.headers.get(key);
      return cp.headers[key] || cp.headers[key.toLowerCase()];
    };

    const nonceId = getHeader('x-nonce-id');
    const chronosId = getHeader('x-chronos-id');
    if (!nonceId || !chronosId) return null;

    return { nonceId, chronosId, cookie: cookieJar(cp.headers), signature: sig, correlationId: corr, timestamp: ts, fingerprint: fp };
  }

  async function tokenRequest(msisdn, n, params, sid) {
    const headers = {
      ...commonHeaders({
        sig: n.signature,
        corr: n.correlationId,
        ts: n.timestamp,
        fp: n.fingerprint,
        msisdn,
        cookie: n.cookie,
      }),
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-nonce-id': n.nonceId,
      'x-chronos-id': n.chronosId,
    };
    return rawRequest('POST', `${base}${TOKEN_PATH}`, headers, params.join('&'), sid);
  }

  async function tokenFlow(msisdn, buildParams, sid) {
    if (await wafBlocked()) {
      return { statusCode: 429, data: { message: 'كثرة المحاولات، أعد المحاولة لاحقًا.', blocked: true } };
    }
    await withOtpPacing();

    const n = await nonceHandshake(msisdn, TOKEN_PATH, 'POST', sid);
    if (!n) {
      console.log('[ooredoo] tokenFlow: nonceHandshake فشل لـ', msisdn);
      return { statusCode: 500, data: { message: 'فشل إنشاء الاتصال الآمن مع الخادم', blocked: false } };
    }

    const res = await tokenRequest(msisdn, n, buildParams(), sid);
    if (res.statusCode >= 500 || /<html/i.test(String(res.data || ''))) {
      console.log('[ooredoo] tokenFlow tokenRequest: status', res.statusCode, 'via', res.via, 'body', String(res.text || (res.data && res.data.message) || '').slice(0, 200));
    }
    return res;
  }

  // ---------- OTP ----------
  async function attemptOtpSend(msisdn) {
    const password = env.OOREDOO_PASSWORD || process.env.OOREDOO_PASSWORD;
    const params = ['client_id=myooredoo-app', 'grant_type=password', `username=${encodeURIComponent(msisdn)}`];
    if (password) params.push(`password=${encodeURIComponent(password)}`);

    const flowSid = freshFlowSid();
    const res = await tokenFlow(msisdn, () => params, flowSid);
    if (res.data && res.data.blocked) return res;

    if (res.statusCode === 403) {
      await pinOtpSid(env.DB, msisdn, flowSid);
      return { statusCode: 200, data: { message: 'OTP sent', otpRequired: true } };
    }

    if (res.statusCode === 200) {
      const data = res.data;
      if (typeof data === 'string' && /<html/i.test(data)) {
        await registerWafBlock();
        return { statusCode: 403, data: { message: 'استجابة غير صالحة من الخادم', blocked: true } };
      }
      if (data && data.access_token) return { statusCode: 200, data };
      return { statusCode: 200, data: { message: 'OTP sent', otpRequired: true } };
    }
    return res;
  }

  async function doVerifyOtp(msisdn, code) {
    const params = [
      'grant_type=password',
      `username=${encodeURIComponent(msisdn)}`,
      'client_id=myooredoo-app',
      `otp=${encodeURIComponent(String(code ?? '').trim())}`,
    ];

    const pinnedSid = (await getPinnedSid(env.DB, msisdn)) || freshFlowSid();
    const res = await tokenFlow(msisdn, () => params, pinnedSid);

    if (res.statusCode === 200 && res.data && res.data.access_token) {
      await clearPinnedSid(env.DB, msisdn);
    }
    return { statusCode: res.statusCode, data: res.data };
  }

  async function doRefreshToken(msisdn, refreshTokenToken) {
    const params = [
      'grant_type=refresh_token',
      'client_id=myooredoo-app',
      `refresh_token=${encodeURIComponent(refreshTokenToken)}`,
    ];
    const res = await tokenFlow(msisdn, () => params, freshFlowSid());
    return { statusCode: res.statusCode, data: res.data };
  }

  // ---------- الواجهات العامة للـ OTP ----------
  async function sendVerificationCode(phoneNumber) {
    const msisdn = toMsisdn(phoneNumber);
    const res = await attemptOtpSend(msisdn);
    if (res.statusCode === 200 && !(res.data && res.data.blocked)) await resetWafCounter();
    return res;
  }

  async function verifyCode(phoneNumber, code) {
    const msisdn = toMsisdn(phoneNumber);
    const numCooldown = await cooldownLeftMs(env, `oo:otp:num:${msisdn}`);
    if (numCooldown > 0) {
      return {
        statusCode: 429,
        data: { message: `كثرة المحاولات على هذا الرقم، أعد المحاولة بعد ${Math.max(1, Math.ceil(numCooldown / 1000))} ثانية` },
      };
    }
    const res = await doVerifyOtp(msisdn, code);
    if (res.statusCode === 401 && !(res.data && res.data.blocked)) {
      const c = await bumpCounter(env, `oo:otp:401:${msisdn}`);
      if (c >= 3) await setCooldown(env, `oo:otp:num:${msisdn}`, 30000);
    } else if (res.statusCode === 200 && res.data && res.data.access_token) {
      await resetCounter(env, `oo:otp:401:${msisdn}`);
      await resetCounter(env, `oo:otp:num:${msisdn}`);
      await resetWafCounter();
    }
    return res;
  }

  async function refreshToken(phoneNumber, refreshTokenToken) {
    const msisdn = toMsisdn(phoneNumber);
    return doRefreshToken(msisdn, refreshTokenToken);
  }

  // ---------- BFF ----------
  async function authHeaders(token, msisdn, n, extra) {
    const ts = Date.now();
    const fp = await generateDeviceFingerprint(instanceId, msisdn, ts);
    return {
      'User-Agent': 'Dart/3.4 (dart:io)',
      Accept: '*/*',
      'Accept-Encoding': 'gzip',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
      platform: 'android',
      'X-Device-Fingerprint': fp,
      'x-platform-data-signature': platformDataSignature(instanceId),
      'x-platform-origin': 'web',
      'x-signature': xSignature(env),
      'x-timestamp': freshTimestamp(ts),
      'x-version': appVersion,
      'X-Instance-Id': instanceId,
      'x-force-update': 'true',
      ...(n.cookie ? { Cookie: n.cookie } : {}),
      ...extra,
    };
  }

  async function bffRequest(method, path, token, msisdn, opts) {
    if (await wafBlocked()) {
      return { statusCode: 429, data: { message: 'كثرة المحاولات، أعد المحاولة لاحقًا.', blocked: true } };
    }

    const sid = (await getPinnedSid(env.DB, msisdn)) || freshFlowSid();
    const n = await nonceHandshake(msisdn, path, method, sid);
    if (!n) return { statusCode: 500, data: { message: 'فشل إنشاء الاتصال الآمن', blocked: false } };

    const { body, extraHeaders } = opts || {};
    const headers = await authHeaders(token, msisdn, n, {
      'x-msisdn': msisdn,
      'x-nonce-id': n.nonceId,
      'x-chronos-id': n.chronosId,
      ...(extraHeaders || {}),
    });

    return rawRequest(method, `${base}${path}`, headers, body, sid);
  }

  const BFF = {
    dashboardSync: (o) => bffRequest('GET', '/api/ooredoo-bff/dashboard/database/sync', o.token, o.msisdn),
    flariePlayerToken: (o) => bffRequest('GET', '/api/ooredoo-bff/flarie/player/token', o.token, o.msisdn),
    gamificationStatus: (o) => bffRequest('GET', '/api/ooredoo-bff/gamification/status', o.token, o.msisdn),
    gamificationHistory: (o) => bffRequest('GET', '/api/ooredoo-bff/gamification/history', o.token, o.msisdn),
    playGamification: (o) => bffRequest('GET', '/api/ooredoo-bff/gamification/play', o.token, o.msisdn),
    snapchatEligibility: (o) => bffRequest('GET', '/api/ooredoo-bff/snap-chat/eligibility', o.token, o.msisdn),
    applySnapchat: (o) => bffRequest('POST', '/api/ooredoo-bff/snap-chat/apply', o.token, o.msisdn, { body: '' }),
    accountInfo: (o) => bffRequest('GET', '/api/ooredoo-bff/bundle/getActivePackages', o.token, o.msisdn),
    userInfo: (o) =>
      bffRequest('GET', '/api/ooredoo-bff/userInfo/personal', o.token, o.msisdn, {
        extraHeaders: { 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' },
      }),
  };

  function purchaseByop({ token, msisdn, code }) {
    const isLimited = BYOP_LIMITED_CODES.includes(code);
    return bffRequest('POST', '/api/ooredoo-bff/bundle/purchase/byop', token, msisdn, {
      body: JSON.stringify({
        validity: byopValidity,
        limitedBundleDetails: isLimited ? [code] : [],
        unlimitedBundleDetails: isLimited ? [] : [code],
      }),
    });
  }

  return {
    sendVerificationCode,
    verifyCode,
    refreshToken,
    ...BFF,
    purchaseByop,
    BYOP_CODES,
    BYOP_LIMITED_CODES,
  };
}
