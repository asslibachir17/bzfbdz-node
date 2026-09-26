// عميل أوريدو — إعادة كتابة كاملة لتعمل على Cloudflare Workers (WebCrypto + fetch)
//
// ملاحظة: أوريدو متاح من عناوين Cloudflare مباشرة (مؤكَّد: checkpoint يعيد 202).
// لذلك لا نعتبر 403 حجبًا — بل هو سلوك OTP الأصلي ("أُرسل الرمز وثُبّتت الجلسة").
// حُذفت كل كولدداونات الحجب الجغرافي/WAF و"كثرة المحاولات" — نجرب دائمًا ونمرّر
// الاستجابة الأصلية، وندعم OOREDOO_RELAY_URL كاحتياط.
import { httpRequest } from './http.js';
import { xSignature, generateDeviceFingerprint, platformDataSignature } from './ooredooSign.js';
import { sleep } from '../util.js';
import { cooldownLeftMs, setCooldown } from '../cooldowns.js';

const CHECKPOINT_PATH = '/api/ooredoo-bff/checkpoint/token';
const TOKEN_PATH = '/api/auth/realms/myooredoo/protocol/openid-connect/token';

const OTP_PACE_MS = 2500; // تباعد بين طلبات OTP

// ---------- تثبيت SID (نفس IP الخروج) بين إرسال/تحقق OTP ----------
// أوريدو يقيّد الرمز بالـ IP الذي أرسله → نحفظ SID الإرسال في D1
// (لأن الإرسال والتحقق استدعاءان منفصلان) ونعيد استخدامه في التحقق.
const SID_PREFIX = 'sid-';
function freshFlowSid() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return SID_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function pinOtpSid(db, msisdn, sid) {
  try {
    await db.prepare('INSERT INTO otp_sids (msisdn, sid, created_at) VALUES (?, ?, ?) ON CONFLICT(msisdn) DO UPDATE SET sid = excluded.sid, created_at = excluded.created_at')
      .bind(msisdn, sid, Date.now())
      .run();
  } catch (e) {
    console.log(`[Ooredoo] فشل حفظ SID: ${e.message}`);
  }
}
async function getPinnedSid(db, msisdn) {
  try {
    const row = await db.prepare('SELECT sid FROM otp_sids WHERE msisdn = ?').bind(msisdn).first();
    return row ? row.sid : null;
  } catch {
    return null;
  }
}
async function clearPinnedSid(db, msisdn) {
  try {
    await db.prepare('DELETE FROM otp_sids WHERE msisdn = ?').bind(msisdn).run();
  } catch {}
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

// هل الاستجابة تدل على حجب شبكي فعلي؟
function isBlocked(res) {
  if (!res) return false;
  if (res.status === 407) return false;
  // أخطاء origin من Cloudflare (522/520/521/524...) = حجب شبكي لا استجابة API
  if (res.status >= 520 && res.status <= 526) return true;
  // صفحات HTML (صفحة حجب WAF/جدار ناري)
  if (typeof res.data === 'string' && /<html|<!doctype/i.test(res.data)) return true;
  return false;
}

function cookieJar(headers) {
  try {
    if (headers && typeof headers.getSetCookie === 'function') {
      const raw = headers.getSetCookie();
      if (raw && raw.length) return raw.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    }
  } catch {}
  try {
    const s = headers && typeof headers.get === 'function' ? headers.get('set-cookie') : '';
    if (s) return s.split(',').map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  } catch {}
  return '';
}

function freshTimestamp(ms) {
  const base = new Date(ms).toISOString().slice(0, 19);
  const micro = String((ms % 1000) * 1000 + Math.floor(Math.random() * 1000)).padStart(6, '0');
  return `${base}.${micro}Z`;
}

export function createOoredoo(env) {
  const base = env.API_BASE_URL_OOREDOO || 'https://apis.ooredoo.dz';
  const appVersion = env.APP_VERSION || '1.5.12';
  const instanceId = env.OOREDOO_INSTANCE_ID || '7f1d9e3c5a6b8f2e4d1c9a7b3e5f8d2c';
  const byopValidity = env.OOREDOO_BYOP_VALIDITY || 'Biweekly';

  const BYOP_CODES = ['IG', 'YT', 'WA', 'FB', env.OOREDOO_BYOP_TT_CODE || '2Go_Tt'];
  const BYOP_LIMITED_CODES = String(env.OOREDOO_BYOP_LIMITED_CODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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
    // إذا ضُبط OOREDOO_RELAY_URL (وركر oo-relay يخرج من Cloudflare IP غير محجوب)
    // فهو الطريق المعتمد لأوريدو: بدون direct (والذي على Render يعود HTML حجب) ولا
    // بروكسيات معطوبة — نمرر الطلب عبر الوركر (أو مجموعة الوركرات) مباشرةً.
    if (env.OOREDOO_RELAY_URL) {
      const r = await httpRequest(env, {
        method,
        url,
        headers,
        body,
        relayKey: 'OOREDOO_RELAY_URL',
        useDbProxy: false,
        sid,
        timeoutMs: 60000,
        directFirst: false,
      });
      if (r && r.status) {
        console.log('[ooredoo] rawRequest via relay:', method, url.split('/').pop(), 'status=', r.status, 'via=', r.via);
        return { statusCode: r.status || 500, data: parseBody(r.data), text: r.text, via: r.via };
      }
      console.log('[ooredoo] rawRequest: كل relays مرفوضة → نعود بخطأ واضح بدل بروكسي معطوب');
      return { statusCode: 503, data: { message: 'خدمة أوريدو مشغولة الآن، أعد المحاولة بعد دقائق.' } };
    }
    let res = await httpRequest(env, {
      method,
      url,
      headers,
      body,
      relayKey: 'OOREDOO_RELAY_URL',
      useDbProxy: true,
      proxyService: 'ooredoo',
      sid,
      timeoutMs: 60000,
      directFirst: true,
    });
    if (isBlocked(res)) {
      // المباشر محجوب من جدار أوريدو (HTML/أخطاء Cloudflare) — نُعيد المحاولة
      // عبر بروكسي الجزائر لأنه يصل فعلاً (checkpoint يُثبَّت عبره).
      console.log('[ooredoo] rawRequest: المباشر محجوب:', method, url.split('/').pop(), 'status=', res.status, 'via=', res.via, '→ بروكسي');
      const fb = await httpRequest(env, {
        method,
        url,
        headers,
        body,
        relayKey: 'OOREDOO_RELAY_URL',
        useDbProxy: true,
        proxyService: 'ooredoo',
        sid,
        timeoutMs: 60000,
        directFirst: false,
      });
      if (fb && fb.status && !isBlocked(fb)) {
        console.log('[ooredoo] rawRequest: نجح عبر البروكسي (via=' + fb.via + ')');
        return { statusCode: fb.status, data: parseBody(fb.data), text: fb.text, via: fb.via };
      }
      if (fb && fb.status) res = fb;
      console.log('[ooredoo] rawRequest: بعد البروكسي:', method, url.split('/').pop(), 'status=', res.status, 'via=', res.via, 'body=', String(res.text || '').slice(0, 160));
    }
    return { statusCode: res.status || 500, data: parseBody(res.data), text: res.text, via: res.via };
  }

  async function checkpoint(sig, corr, ts, fp, msisdn, path, method, cookie, sid) {
    if (env.OOREDOO_RELAY_URL) {
      const r = await httpRequest(env, {
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
        useDbProxy: false,
        sid,
        timeoutMs: 60000,
        directFirst: false,
      });
      if (r && r.status) {
        return r;
      }
      console.log('[ooredoo] checkpoint: كل relays مرفوضة');
      return null;
    }
    let res = await httpRequest(env, {
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
      timeoutMs: 60000,
      directFirst: true,
    });
    if (isBlocked(res)) {
      console.log('[ooredoo] checkpoint: المباشر محجوب status=', res.status, 'via=', res.via, '→ بروكسي');
      const fb = await httpRequest(env, {
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
        timeoutMs: 60000,
        directFirst: false,
      });
      if (fb && fb.status && !isBlocked(fb)) {
        console.log('[ooredoo] checkpoint: نجح عبر البروكسي (via=' + fb.via + ') status=', fb.status);
        return fb;
      }
      if (fb && fb.status) res = fb;
      console.log('[ooredoo] checkpoint: بعد البروكسي status=', res.status, 'via=', res.via);
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
    const nonceId = cp.headers && typeof cp.headers.get === 'function' ? cp.headers.get('x-nonce-id') : null;
    const chronosId = cp.headers && typeof cp.headers.get === 'function' ? cp.headers.get('x-chronos-id') : null;
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
    await withOtpPacing();
    const n = await nonceHandshake(msisdn, TOKEN_PATH, 'POST', sid);
    if (!n) {
      console.log('[ooredoo] tokenFlow: فشل المصافحة لـ', msisdn, '(قد يكون حجب أو شبكة)');
      return { statusCode: 500, data: { message: 'فشل الاتصال بخدمة أوريدو، حاول مجددًا.' } };
    }
    const res = await tokenRequest(msisdn, n, buildParams(), sid);
    if (res.statusCode >= 500 || /<html/i.test(String(res.data || ''))) {
      console.log('[ooredoo] tokenFlow tokenRequest: status', res.statusCode, 'via', res.via, 'body', String(res.text || (res.data && res.data.message) || '').slice(0, 200));
    }
    return res;
  }

  // ---------- OTP ----------
  async function attemptOtpSend(msisdn) {
    const params = ['client_id=myooredoo-app', 'grant_type=password', `username=${encodeURIComponent(msisdn)}`];
    if (env.OOREDOO_PASSWORD) params.push(`password=${encodeURIComponent(env.OOREDOO_PASSWORD)}`);

    const flowSid = freshFlowSid(); // IP خروج ثابت لكل تدفق الإرسال (checkpoint+token)
    const res = await tokenFlow(msisdn, () => params, flowSid);
    if (res.data && res.data.blocked) return res;
    if (res.statusCode === 403) {
      // 403 = أُرسل الرمز وثُبّتت الجلسة على هذا الـ IP → نحفظ SID للتحقق
      await pinOtpSid(env.DB, msisdn, flowSid);
      return { statusCode: 200, data: { message: 'OTP sent', otpRequired: true } };
    }
    if (res.statusCode === 200) {
      const data = res.data;
      if (typeof data === 'string' && /<html/i.test(data)) {
        console.log('[ooredoo] attemptOtpSend: استجابة HTML رغم المحاولة (via=' + res.via + ') — ليست نجاح OTP');
        return { statusCode: 503, data: { message: 'خدمة أوريدو محجوبة من هذا الاتصال، أعد المحاولة لاحقًا.' } };
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
    // نفس SID الذي أرسل الرمز → نفس IP الخروج
    const pinnedSid = await getPinnedSid(env.DB, msisdn) || freshFlowSid();
    const res = await tokenFlow(msisdn, () => params, pinnedSid);
    if (res.statusCode === 200 && res.data && res.data.access_token) {
      await clearPinnedSid(env.DB, msisdn); // تحقق ناجح → انتهى الربط
    }
    return { statusCode: res.statusCode, data: res.data };
  }

  async function doRefreshToken(msisdn, refreshToken) {
    const params = [
      'grant_type=refresh_token',
      'client_id=myooredoo-app',
      `refresh_token=${encodeURIComponent(refreshToken)}`,
    ];
    const res = await tokenFlow(msisdn, () => params, freshFlowSid());
    return { statusCode: res.statusCode, data: res.data };
  }

  // ---------- الواجهات العامة للـ OTP ----------
  async function sendVerificationCode(phoneNumber) {
    const msisdn = toMsisdn(phoneNumber);
    return attemptOtpSend(msisdn);
  }

  async function verifyCode(phoneNumber, code) {
    const msisdn = toMsisdn(phoneNumber);
    const res = await doVerifyOtp(msisdn, code);
    if (res.statusCode === 401) {
      return { statusCode: 401, data: { message: 'الرمز غير صحيح أو انتهت صلاحيته.' } };
    }
    return res;
  }

  async function refreshToken(phoneNumber, refreshToken) {
    const msisdn = toMsisdn(phoneNumber);
    return doRefreshToken(msisdn, refreshToken);
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
    // IP الخروج يجب أن يطابق IP إصدار التوكن وإلا رفضت أوريدو (401).
    // نستخدم نفس الـ sid المثبّت أثناء التحقق (أو جديد) لكلا طلبي checkpoint+BFF.
    const sid = (await getPinnedSid(env.DB, msisdn)) || freshFlowSid();
    const n = await nonceHandshake(msisdn, path, method, sid);
    if (!n) return { statusCode: 500, data: { message: 'فشل الاتصال بخدمة أوريدو، حاول مجددًا.' } };
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
