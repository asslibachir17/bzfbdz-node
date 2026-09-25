// طبقة HTTP موحّدة: fetch مع مهلة + دعم Relay اختياري + بروكسي Socket من D1
// - Relay: خادم خارجي يعيد توجيه الطلب (IP آخر).
// - DbProxy: بروكسي HTTP من جدول proxies في D1 عبر نفق Socket (مثل proxyAxios القديم).
import proxyRequest from './proxy.js';

function timeoutSignal(timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return { ctrl, clear: () => clearTimeout(timer) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseText(text) {
  if (text === undefined || text === null) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * يقوم بطلب HTTP ويعيد { status, data, headers, text }
 * - headers: كائن Headers (فيه getSetCookie إن وُجد)
 * - relayKey: اسم متغير البيئة الذي يحمل رابط الـ Relay (اختياري)
 *   عقد الـ Relay: POST إلى الرابط بجسم { method, url, headers, body }
 *   ويعيد { status, headers, data }
 */
export async function httpRequest(env, opts) {
  const {
    method = 'GET',
    url,
    headers = {},
    body, // string أو object (سيُحوَّل لـ JSON)
    relayKey = null,
    useDbProxy = false,
    proxyService = 'shared',
    sid = null,
    timeoutMs = 30000,
    directFirst = false, // جرّب الاتصال المباشر أولاً (أسرع)، والبروكسي احتياط عند الفشل
  } = opts;

  const relay = relayKey ? env[relayKey] : null;

  let payload = body;
  const hdrs = { ...headers };
  if (body && typeof body !== 'string') {
    if (!hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  // الوضع المباشر أولاً (مطابق للأصل): إن نجح الـ fetch المباشر نستخدم نتيجته
  // فورًا مهما كانت (403/200/...). لا نلجأ للبروكسي/relay إلا عند فشل الشبكة،
  // كي لا نضاعف عدد الطلبات على الخدمة عند الحجب (ضغط شبكة).
  if (directFirst) {
    const directTimeout = Math.min(timeoutMs, 15000);
    const { ctrl, clear } = timeoutSignal(directTimeout);
    try {
      const res = await fetch(url, {
        method,
        headers: hdrs,
        body: payload !== undefined ? payload : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      return { status: res.status, data: parseText(text), headers: res.headers, text, via: 'direct' };
    } catch (e) {
      console.log(`[http] direct failed: ${e.message || e} → fallback`);
    } finally {
      clear();
    }
  }

  // بروكسي Socket من D1 (للخدمات المحجوبة من عناوين Cloudflare مثل دجيزي)
  if (useDbProxy) {
    try {
      const r = await proxyRequest(env, { method, url, headers: hdrs, body: payload, service: proxyService, sid }, timeoutMs);
      if (r.status !== 0) return r;
      console.log(`[http] db-proxy failed (status 0): ${r.error || 'unknown'} → fallback`);
    } catch (e) {
      console.log(`[http] db-proxy failed: ${e.message || e} → fallback`);
    }
  }

  if (relay) {
    return relayRequest(env, relay, { method, url, headers: hdrs, body: payload }, timeoutMs);
  }
  // المحاولة الأخيرة: fetch مباشر مع إعادة محاولة واحدة سريعة على أخطاء الشبكة المؤقتة
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { ctrl, clear } = timeoutSignal(timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: hdrs,
        body: payload !== undefined ? payload : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      return { status: res.status, data: parseText(text), headers: res.headers, text };
    } catch (e) {
      if (attempt === 1) {
        console.log(`[http] fetch attempt 1 failed: ${e.message || e} → retry`);
        await sleep(250);
        continue;
      }
      return { status: 0, data: undefined, headers: null, error: e.message || 'network error' };
    } finally {
      clear();
    }
  }
  return { status: 0, data: undefined, headers: null, error: 'fetch exhausted' };
}

async function relayRequest(env, relayUrl, spec, timeoutMs) {
  const { ctrl, clear } = timeoutSignal(timeoutMs + 10000);
  try {
    const res = await fetch(relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-relay-secret': env.RELAY_SECRET || '',
      },
      body: JSON.stringify(spec),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let payload = parseText(text);
    if (payload && payload.error) {
      return { status: res.status === 200 ? 502 : res.status, data: payload, headers: res.headers, text, via: 'relay' };
    }
    if (payload && typeof payload === 'object' && 'status' in payload) {
      // عقد Relay: { status, headers?, data? } — headers يُعاد ككائن عادي،
      // نعيد بناء Headers حقيقي حتى تعمل headers.get('set-cookie') / getSetCookie
      return {
        status: Number(payload.status) || res.status,
        data: payload.data,
        headers: toHeaders(payload.headers),
        text: typeof payload.data === 'string' ? payload.data : text,
        via: 'relay',
      };
    }
    return { status: res.status, data: payload, headers: res.headers, text, via: 'relay' };
  } catch (e) {
    return { status: 0, data: undefined, headers: null, error: e.message || 'relay error', via: 'relay' };
  } finally {
    clear();
  }
}

function toHeaders(obj) {
  if (!obj || typeof obj === 'object' && typeof obj.get === 'function') return obj || new Headers();
  const h = new Headers();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => h.append(k, String(x)));
    else h.set(k, String(v));
  }
  return h;
}

// تحويل كائن Headers إلى كائن عادي (للسهولة)
export function headersToObject(headers) {
  if (!headers) return {};
  const out = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}
