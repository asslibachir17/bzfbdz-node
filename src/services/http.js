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

  const relays = relayKey ? relayList(env[relayKey], env[relayKey + '_LIST']) : null;

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

  if (relays?.length) {
    return relayRequest(env, relays, { method, url, headers: hdrs, body: payload, sid }, timeoutMs);
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

// فهرس تدواري (round-robin) للـ relays — يتبدل كل طلب لتوزيع الحمولة على
// عناوين خروج مختلفة، ويستمر في تجربة التالي عند رفض أوريدو (Request Rejected).
let relayCursor = 0;
let rejectedCursor = new Map(); // relayUrl -> expiry (ms) لتجميد الـ relay المرفوض مؤقتاً
const sidRelay = new Map(); // sid -> relayUrl: تثبيت مصدر الخروج لكل تدفق (checkpoint+token من نفس IP)

function relayList(primary, extra) {
  const all = [];
  if (primary) all.push(primary);
  if (extra) for (const s of String(extra).split(',')) {
    const v = s.trim();
    if (v) all.push(v);
  }
  return all;
}

function nextRelay(relays) {
  const now = Date.now();
  for (let i = 0; i < relays.length; i++) {
    relayCursor = (relayCursor + 1) % relays.length;
    const u = relays[relayCursor];
    const cooldown = rejectedCursor.get(u);
    if (!cooldown || cooldown <= now) return { relay: u, all: false };
  }
  // الكل مرفوض حالياً → نعيد الأول (سيجرب من جديد بعد انتهاء تهدئة)
  rejectedCursor.clear();
  return { relay: relays[0], all: true };
}

function markRejected(relayUrl) {
  // تجميد أطول (60 ثانية) لأن عنوان الخروج الواحد يعاني «صومعة التردد»
  // من أوريدو بعد رفض حقيقي، والانتقال الفوري يزيد الضغط على العنوان التالي.
  rejectedCursor.set(relayUrl, Date.now() + 60000);
}

function isOoredooRejected(data) {
  if (!data || typeof data !== 'string') return false;
  return /Request Rejected/i.test(data) && /<html/i.test(data);
}

async function relayRequest(env, relays, spec, timeoutMs) {
  const sid = spec && spec.sid;
  let first;
  // التدفق الواحد (checkpoint→token) يجب أن يمر عبر نفس الـ relay/IP من أجل
  // الـ nonce الذي يثبّته checkpoint — حتى لا تقلب أوريدو التدفق المنقسم.
  if (sid && sidRelay.has(sid) && relays.includes(sidRelay.get(sid))) {
    first = sidRelay.get(sid);
    if (!rejectedCursor.get(first) || rejectedCursor.get(first) <= Date.now()) {
      relayCursor = relays.indexOf(first);
    } else {
      first = null;
    }
  }
  if (!first) {
    const n = nextRelay(relays);
    first = n.relay;
    if (sid) sidRelay.set(sid, first);
  }
  let tried = [];
  let hasResult = false;
  // نجرب حتى عدد الـ relays؛ بعد التجميد يعيد أول relay إذا كان الكل مرفوضاً
  const attempts = relays.length;
  for (let i = 0; i < attempts; i++) {
    const { relay: r } = i === 0 ? { relay: first } : nextRelay(relays);
    if (tried.includes(r)) continue;
    tried.push(r);
    const { ctrl, clear } = timeoutSignal(timeoutMs + 10000);
    try {
      const res = await fetch(r, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-secret': env.RELAY_SECRET || '',
        },
        body: JSON.stringify(spec),
        signal: ctrl.signal,
      });
      const text = await res.text();
      hasResult = true;
      let payload = parseText(text);
      if (payload && payload.error) {
        return { status: res.status === 200 ? 502 : res.status, data: payload, headers: res.headers, text, via: 'relay' };
      }
      if (payload && typeof payload === 'object' && 'status' in payload) {
        const status = Number(payload.status) || res.status;
        // أوريدو ترفض أحياناً الـ IP المزدحم بـ HTML «Request Rejected» (حماية ضد التردد)
        if (status === 200 && isOoredooRejected(payload.data)) {
          console.log(`[http] relay ${r.split('/')[2]} rejected by ooredoo → try next`);
          markRejected(r);
          if (sid && sidRelay.get(sid) === r) sidRelay.delete(sid);
          await sleep(150);
          continue;
        }
        return {
          status,
          data: payload.data,
          headers: toHeaders(payload.headers),
          text: typeof payload.data === 'string' ? payload.data : text,
          via: 'relay',
        };
      }
      return { status: res.status, data: payload, headers: res.headers, text, via: 'relay' };
    } catch (e) {
      markRejected(r);
      console.log(`[http] relay ${r.split('/')[2]} error: ${e.message || e} → try next`);
      await sleep(150);
      continue;
    } finally {
      clear();
    }
  }
  // فشلت كل الـ relays في هذه الجولة (status 0): قد يكون كلها تحت تهدئة لحظية
  // من أوريدو بعد ضغط متواصل. نمنح ثانيتين ثم نعيد الجولة مرة واحدة — أوريدو
  // يتعافى أحياناً بعد ثوانٍ (رفض تردد قصير).
  if (tried.length && !hasResult) {
    await sleep(2000);
    const n = nextRelay(relays);
    const r2 = n.relay;
    console.log(`[http] retry round after cooldown → ${r2.split('/')[2]}`);
    try {
      const res = await fetch(r2, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-relay-secret': env.RELAY_SECRET || '' },
        body: JSON.stringify(spec),
        signal: timeoutSignal(timeoutMs + 10000).ctrl.signal,
      });
      const text = await res.text();
      const payload = parseText(text);
      if (payload && !payload.error && typeof payload === 'object' && 'status' in payload) {
        return {
          status: Number(payload.status) || res.status,
          data: payload.data,
          headers: toHeaders(payload.headers),
          text: typeof payload.data === 'string' ? payload.data : text,
          via: 'relay',
        };
      }
      if (payload && payload.error) {
        return { status: res.status === 200 ? 502 : res.status, data: payload, headers: res.headers, text, via: 'relay' };
      }
    } catch (e) {
      console.log(`[http] retry relay ${r2.split('/')[2]} error: ${e.message || e}`);
    }
  }
  return { status: 0, data: undefined, headers: null, error: 'all relays rejected: ' + tried.join(', '), via: 'relay' };
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
