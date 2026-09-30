// طبقة HTTP موحّدة: fetch مع مهلة + دعم Relay اختياري + بروكسي Socket من D1
// - Relay: خادم خارجي يعيد توجيه الطلب (IP آخر).
// - DbProxy: بروكسي HTTP من جدول proxies في D1 عبر نفق Socket (مثل proxyAxios القديم).
import proxyRequest from './proxy.js';
import { resolveRelays } from '../config/relays.js';

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
// سجلّ أداء لكل ريلاي: يُستخدم لزيادة التجميد تدرّجياً وتفضيل الناجين.
// مع 45 ريلاي على 11 منطقة، الحجب يصيب منطقة كاملة دفعةً واحدة، فالثبات
// (60ث للجميع) يعيد محاولةِ ريلايس ميتة ويضيع طلبات على عناوين محجوبة.
const relayScore = new Map(); // relayUrl -> { ok, fail, backoffMs }
const RELAY_BACKOFF_MIN = 45000;
const RELAY_BACKOFF_MAX = 15 * 60 * 1000;
const RELAY_BACKOFF_STEP = 30000;

function relayStat(relayUrl) {
  let s = relayScore.get(relayUrl);
  if (!s) { s = { ok: 0, fail: 0, backoffMs: RELAY_BACKOFF_MIN }; relayScore.set(relayUrl, s); }
  return s;
}

// متغيّرات البيئة أولاً (تثبيت يدوي من Dashboard)، ثم القائمة المدمجة في
// src/config/relays.js التي ضمّت التوسعة إلى 45. الدمج يجعل النشر وحده
// كافياً لتفعيل الشبكة كاملة، لأن render.yaml لا يُطبَّق على متغيّرات مستقلة.
function relayList(primary, extra) {
  return resolveRelays(primary, extra);
}

// ترتيب بالترجيح: الأقل تجميداً أولاً، وعند التساوي الأقل فشلاً، ثم round-robin.
// هذا يجعل الريلايس الناجحة تُختار أولاً بدل الاعتماد على موضعها في القائمة.
function pickRelay(relays, now) {
  const live = [];
  const frozen = [];
  for (const u of relays) {
    const cd = rejectedCursor.get(u);
    if (!cd || cd <= now) live.push(u); else frozen.push({ u, cd });
  }
  if (!live.length) return null;
  live.sort((a, b) => {
    const sa = relayStat(a), sb = relayStat(b);
    if (sa.ok !== sb.ok) return sb.ok - sa.ok;          // الناجح أولاً
    if (sa.fail !== sb.fail) return sa.fail - sb.fail;  // الأقل فشلاً
    return 0;                                          // ثم ترتيب القائمة
  });
  // round-robin داخل المجموعة الأفضل: يتناوب بينها بعدلUsage عادل
  const top = live.filter((u) => relayStat(u).ok === relayStat(live[0]).ok && relayStat(u).fail === relayStat(live[0]).fail);
  relayCursor = (relayCursor + 1) % top.length;
  return top[relayCursor];
}

function nextRelay(relays) {
  const now = Date.now();
  const best = pickRelay(relays, now);
  if (best) return { relay: best, all: false };
  // الكل مجمّد → نعيد أقل مدة تجميد (سيُجرَّب بعد انتهائها) بدل الأول عشوائياً
  let soonest = null, soonestAt = Infinity;
  for (const [u, cd] of rejectedCursor) {
    if (!relays.includes(u)) continue;
    if (cd < soonestAt) { soonestAt = cd; soonest = u; }
  }
  return { relay: soonest || relays[0], all: true };
}

function markRejected(relayUrl) {
  // تدرّج: كل فشل متتالٍ يزيد مدة التجميد (45ث ← 15د). الحجب عند أوريدو
  // يتراكم على عنوان الخروج، فريلايس محجوب تماماً لا يُفيد محاولته بعد 45ث.
  const s = relayStat(relayUrl);
  s.fail++;
  s.ok = 0;
  s.backoffMs = Math.min(RELAY_BACKOFF_MAX, s.backoffMs + RELAY_BACKOFF_STEP);
  rejectedCursor.set(relayUrl, Date.now() + s.backoffMs);
}

// تُستدعى عند ردّ صالح من الريلايس (200 أو حتى 401/403 حقيقي) ليعود تدريجياً
// إلى قائمة الترجيح unwell-known بعد نجاح وحيد.
function markRelayOk(relayUrl) {
  const s = relayStat(relayUrl);
  s.ok++;
  s.fail = 0;
  s.backoffMs = RELAY_BACKOFF_MIN;
  rejectedCursor.delete(relayUrl);
}

function isOoredooRejected(data) {
  if (!data || typeof data !== 'string') return false;
  if (!/Request Rejected/i.test(data)) return false;
  // صفحة الحجب HTML، لكن قد يعيد Cloudflare الحجب كنص عادي أو JSON.
  return /<html|<!doctype/i.test(data) || data.trim().length < 2000;
}

// ريلاي أخفق مؤقتاً بسبب بنية تحتية أو حجر upstream: HTML حجب، خطأ Cloudflare
// (520-526)، أو انقطاع الشبكة. هذه أخطاء عابرة على مستوى الريلاي نفسه، فنجرّب
// ريلاياً آخر بدل إرجاع الفشل للمستخدم.
function isRelayInfrastructureFailure(status, data) {
  const s = Number(status) || 0;
  if (s === 0) return true;
  if (s >= 520 && s <= 526) return true;
  if (typeof data === 'string' && /<html|<!doctype/i.test(data)) return true;
  return false;
}

async function relayRequest(env, relays, spec, timeoutMs) {
  const sid = spec && spec.sid;
  let first;
  // التدفق الواحد (checkpoint→token) يجب أن يمر عبر نفس الـ relay/IP من أجل
  // الـ nonce الذي يثبّته checkpoint — حتى لا تقلب أوريدو التدفق المنقسم.
  if (sid && sidRelay.has(sid) && relays.includes(sidRelay.get(sid))) {
    first = sidRelay.get(sid);
    if (!rejectedCursor.get(first) || rejectedCursor.get(first) <= Date.now()) {
      // نثبّت sid على هذا الريلاي مباشرةً. لا نلمس relayCursor هنا لأن pickRelay
      // يعمل على قائمة المرشّحين المرتّبة لا على relays — تعديله كان يتخطّى ريلايس.
      relayStat(first).ok++;
    } else {
      first = null; // مثبَّت لكنه مجمّد (حُجب) → نترك الاختيار الحر يختار غيره
      if (sid) sidRelay.delete(sid);
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
        // أوريدو ترفض أحياناً الـ IP المزدحم بـ HTML «Request Rejected» (حماية ضد التردد).
        // يردّ الحجب أحياناً بـ 200 وأحياناً بـ 403/429 — سابقاً كنا نفحص 200 فقط،
        // فكان 403 يُعتبر «رداً نهائياً» ويتوقف الدوران عند أول ريلاي.
        if (isOoredooRejected(payload.data)) {
          console.log(`[http] relay ${r.split('/')[2]} rejected by ooredoo → try next`);
          markRejected(r);
          if (sid && sidRelay.get(sid) === r) sidRelay.delete(sid);
          await sleep(150);
          continue;
        }
        // فشل بنية تحتية على هذا الريلاي (حجب HTML، خطأ Cloudflare 520-526، أو
        // انقطاع): نجرّب ريلاياً آخر بدل إنهاء الطلب. سابقاً كان هذا الرد
        // يُعاد مباشرةً للمستخدم فتنقسم الجلسة عند أول ريلاي سيّئ.
        if (isRelayInfrastructureFailure(status, payload.data)) {
          console.log(`[http] relay ${r.split('/')[2]} infra failure (status=${status}) → try next`);
          markRejected(r);
          if (sid && sidRelay.get(sid) === r) sidRelay.delete(sid);
          await sleep(150);
          continue;
        }
        // ردّ قابل للاستخدام من أوريدو/دجيزي (401 رمز خاطئ، 400 خطأ واضح،
        // 403 محجوب برمجياً، أو 200 ناجح). نحترمه ولا نجرّب ريلاياً آخر كي
        // لا نُسرّب رموز زائدة على رقم المستخدم.
        // إن وصلنا إلى هنا بعد تخطّي ريلاي فاشل، نثبّت الـ sid على هذا الريلاي
        // الناجح فعلاً حتى يبقى checkpoint+token على نفس الـ IP في الطلب التالي.
        if (sid) sidRelay.set(sid, r);
        markRelayOk(r);
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
