// proxy.js — بروكسي HTTP عبر CONNECT tunnel (نسخة Node.js / BZFBDZ-node)
// البديل المكافئ لنسخة الـ Worker (tunnelfetch + cloudflare:sockets):
// نفس منطق التجمع والتبديل والحجب تماماً، والترانسبورت عبر https-proxy-agent
// (Agent تابع لـ node:https) بدل tunnelfetch.
// نسخة محسّنة: حجب مستمر + ثبات + تدوير ذكي.
import https from 'node:https';
import zlib from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── ثوابت ───
const POOL_SIZE = 8;
const POOL_TTL_MS = 60000;
const STICKY_TTL_MS = 5 * 60 * 1000;
const STICKY_SID_TTL_MS = 30 * 60 * 1000;
const BAD_TTL_MS = 5 * 60 * 1000;
const LAST_USED_TTL_MS = 30000;
const D1_WRITE_THROTTLE_MS = 10000; // لا نكتب لنفس البروكسي في D1 إلا كل 10 ثوانٍ
const MAX_ATTEMPTS = 6; // تكرارات داخل الطلب الواحد للالتفاف حول IPs البوابة السيئة
const DJEZZY_429_BAD_MS = 60 * 1000; // دجيزي: عند 429 نستبعد عنوان الخروج الحالي دقيقة ثم ندوّر

// ─── بلاك ليست IP الخروج ───
// عند حجب المشغِّل لعنوان الخروج (403/HTML) أو بوابة شبكة سيئة (500 gate)، نضع IP فعلياً
// في بلاك ليست ويتجاوزه الاختيار حتى لو عاد نفس البروكسي/نفس الـ IP، ثم يُعاد لاحقاً.
const IPBL_TTL_MS = 15 * 60 * 1000;        // مدة استبعاد الـ IP المحظور
const AUTH_BAD_BASE_MS = 20 * 1000;        // 407 عابر ← استبعاد قصير متصاعد
const AUTH_BAD_MAX_MS = 5 * 60 * 1000;
const TRANSIENT_BAD_MS = 8 * 1000;         // عطل شبكة عابر (status=0) ← استبعاد في الذاكرة فقط، قصير
const ATTEMPT_TIMEOUT_MS = Number(process.env.PROXY_ATTEMPT_TIMEOUT_MS) || 12000; // مهلة كل محاولة واحدة (لا تعلّق خانة 60ث)
const IP_PROBE_TTL_MS = 10 * 60 * 1000;    // تخزين egress IP المكتشف مؤقتاً
const IP_PROBE_TIMEOUT_MS = 8000;
const IP_ECHO_URL = 'https://api.ipify.org?format=json';
const IP_BL_WRITE_THROTTLE_MS = 10000;     // لا نكتب لنفس الـ IP في DB إلا كل 10 ثوانٍ
const MAX_PROXY_CONCURRENCY = Number(process.env.PROXY_MAX_PER_IP) || 6;   // حد التوازي لكل عنوان خروج (per-IP)
const MAX_PROXY_CONCURRENCY_TOTAL = Number(process.env.PROXY_MAX_TOTAL) || 48; // سقف عام للأمان

// ─── ذاكرة حالة (per-process) ───
const poolCache = new Map();
const stickyByService = new Map();
// توزيع دجيزي بالتناوب (round-robin) على كل عناوين الخروج الصحية: كل جلسة جديدة تأخذ
// العنوان التالي، فلا يتركّز الحمل على IP واحد ولا يقع ضغط/حدّ (429) على عنوان بعينه.
const rrCursor = new Map(); // service -> index
// تثبيت بروكسي بعينه لكل (خدمة، sid): تُخرج OTP/التوكين/الفعيل من نفس IP
// (بدون لمس اسم المستخدم — بعض المزوّدين كـ kookeey يرفضون لاحقة -sid-).
const sidSticky = new Map(); // `${service}:${sid}` -> { proxyId, until }
function stickSid(service, sid, proxyId) {
  if (!service || !sid || !proxyId) return;
  sidSticky.set(`${service}:${sid}`, { proxyId: String(proxyId), until: Date.now() + STICKY_SID_TTL_MS });
}
const badProxies = new Map();
const lastUsedCache = new Map();
const d1WriteCache = new Map(); // proxyId → آخر وقت كتابة في DB (للتخفيف)

// بلاك ليست IPs فعلية (مستقلة عن صفوف البروكسيات): ip → حتى (ms)
const ipBlacklist = new Map();
// egress IP المكتشف عبر فحص خفيف ipify لكل بروكسي جاللي (دجيزي): 'P'+proxyId → { ip, until }
const ipCache = new Map();
const ipProbeBusy = new Set();  // proxyId — فحص واحد قيد التنفيذ
const ipBlWriteCache = new Map(); // ip → آخر وقت كتابة في DB (للتخفيف)
const authFailCount = new Map();  // proxyId → تفشيات 407 متتالية (استبعاد متصاعد)

// ─── حد التوازي عبر البروكسي (per-IP) ───
// كان الحد عاماً (4) بينما لدينا 4 عناوين خروج مستقلة → خنق واصطفاف عميق (waiting ~95).
// الحد الآن لكل عنوان خروج (proxy id) + سقف عام، فيتضاعف الإنتاج مع الحفاظ على سلامة كل IP.
let proxyInFlightTotal = 0;
const proxyInFlightByKey = new Map(); // key(proxy id / 'shared') -> count
const proxyWaiters = [];
const PROXY_SLOT_MAX_WAIT_MS = 90000;
function _slotCount(key) { return proxyInFlightByKey.get(key) || 0; }
function _slotCanAcquire(key) {
  return proxyInFlightTotal < MAX_PROXY_CONCURRENCY_TOTAL && _slotCount(key) < MAX_PROXY_CONCURRENCY;
}
function _slotGrant(key, entry) {
  entry.done = true;
  if (entry.timer) clearTimeout(entry.timer);
  proxyInFlightTotal++;
  proxyInFlightByKey.set(key, _slotCount(key) + 1);
  entry.resolve();
}
function acquireProxySlot(key = 'shared', maxWaitMs = PROXY_SLOT_MAX_WAIT_MS) {
  return new Promise((resolve) => {
    if (_slotCanAcquire(key)) { proxyInFlightTotal++; proxyInFlightByKey.set(key, _slotCount(key) + 1); return resolve(); }
    const entry = { key, resolve, timer: null, done: false };
    // مهلة أمان: لا نسمح لخانة أن تعلق للأبد (لو تسرّبت بسبب طلب شارد) فنمنحها قسراً.
    entry.timer = setTimeout(() => {
      if (entry.done) return;
      const i = proxyWaiters.indexOf(entry);
      if (i >= 0) proxyWaiters.splice(i, 1);
      console.log(`[proxy] slot force-acquired (${key}) after ${Math.round(maxWaitMs / 1000)}s`);
      _slotGrant(key, entry);
    }, maxWaitMs);
    proxyWaiters.push(entry);
  });
}
function releaseProxySlot(key = 'shared') {
  proxyInFlightTotal = Math.max(0, proxyInFlightTotal - 1);
  const c = _slotCount(key);
  if (c <= 1) proxyInFlightByKey.delete(key); else proxyInFlightByKey.set(key, c - 1);
  // امنح خانة واحدة لمن ينتظر ولديه سعة متاحة (حفاظاً على السقف العام).
  for (let i = 0; i < proxyWaiters.length; i++) {
    const entry = proxyWaiters[i];
    if (!entry.done && _slotCanAcquire(entry.key)) {
      proxyWaiters.splice(i, 1);
      _slotGrant(entry.key, entry);
      return;
    }
  }
}
export function __proxyDebug() {
  return { inflight: proxyInFlightTotal, waiting: proxyWaiters.length, max: MAX_PROXY_CONCURRENCY, maxTotal: MAX_PROXY_CONCURRENCY_TOTAL };
}

// ─── ترحيل: إضافة عمود blocked_until ───
let migrationDone = false;
async function ensureMigration(env) {
  if (migrationDone) return;
  try {
    await env.DB.prepare('ALTER TABLE proxies ADD COLUMN blocked_until INTEGER DEFAULT 0').run();
  } catch {}
  migrationDone = true;
}

// ─── ترحيل: جدول بلاك ليست IPs ───
let ipTableDone = false;
async function ensureIpBlacklistTable(env) {
  if (ipTableDone) return;
  try {
    // DDL متوافق مع SQLite/D1 وPostgreSQL (يترجمه محوّل toPgSql عند الحاجة)
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS proxy_ip_blacklist (service TEXT NOT NULL, ip TEXT NOT NULL, host TEXT, reason TEXT, expires_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (service, ip))'
    ).run();
  } catch {}
  ipTableDone = true;
}

// ─── كشف IP الخروج الحقيقي عبر فحص خفيف من خلال البروكسي ───
// مخصّص لدجيزي: لربط الحجب بـ IP فعلي (خاصة المزوّدات الدوّارة)، مع تخزين مؤقت.
async function probeEgressIp(env, proxy, service, t = Date.now()) {
  if (service !== 'djezzy' || !proxy || !proxy.id) return null;
  const cached = ipCache.get('P' + proxy.id);
  if (cached && cached.until > t) return cached.ip;
  if (ipProbeBusy.has(proxy.id)) return cached ? cached.ip : null;
  ipProbeBusy.add(proxy.id);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IP_PROBE_TIMEOUT_MS);
    const pUrl = proxyUrl(proxy, null, service);
    const r = await httpViaProxy(pUrl, IP_ECHO_URL, { method: 'GET', headers: {} }, ctrl.signal, IP_PROBE_TIMEOUT_MS);
    clearTimeout(timer);
    let ip = null;
    if (r && r.status === 200 && r.text) {
      try { const j = JSON.parse(r.text); ip = (j && j.ip) || null; } catch { ip = null; }
    }
    if (ip) ipCache.set('P' + proxy.id, { ip, until: t + IP_PROBE_TTL_MS });
    return ip;
  } catch {
    return cached ? cached.ip : null;
  } finally {
    ipProbeBusy.delete(proxy.id);
  }
}

// هل الـ IP المعروف لهذا البروكسي موجود في بلاك ليست؟
function isProxyIpBlocked(proxy, t = Date.now()) {
  if (!proxy || !proxy.id) return false;
  const c = ipCache.get('P' + proxy.id);
  if (!c || !c.ip) return false;
  return (ipBlacklist.get(c.ip) || 0) > t;
}

// بلاك ليست في الذاكرة + سطر سجل
function blacklistIp(ip, reason, t = Date.now()) {
  ipBlacklist.set(ip, t + IPBL_TTL_MS);
  console.log(`[proxy] BLACKLIST ip=${ip} reason=${reason} until=${new Date(t + IPBL_TTL_MS).toISOString()}`);
}

// بلاك ليست مُثبَّتة في DB (عند إقلاع جديد تظل محفوظة حتى انتهاء المدة)
async function persistIpBlacklist(env, service, ip, host, reason) {
  if (!ip) return;
  const last = ipBlWriteCache.get(ip) || 0;
  const now = Date.now();
  if (now - last < IP_BL_WRITE_THROTTLE_MS) return;
  ipBlWriteCache.set(ip, now);
  const until = now + IPBL_TTL_MS;
  try {
    await ensureIpBlacklistTable(env);
    await env.DB.prepare('DELETE FROM proxy_ip_blacklist WHERE service = ? AND ip = ?').bind(service, ip).run();
    await env.DB.prepare('INSERT INTO proxy_ip_blacklist (service, ip, host, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(service, ip, host || null, reason || '', until, now).run();
  } catch {}
}

// ─── جلب البروكسيات من DB (مع تصفية المحجوبة) ───
async function fetchProxyPool(env, service = 'shared', sid = null) {
  if (!env || !env.DB) throw new Error('env.DB غير معرفة');
  await ensureMigration(env);

  const now = Date.now();
  const cached = poolCache.get(service);
  if (cached && now - cached.fetchedAt < POOL_TTL_MS) {
    const entry = sid ? { list: cached.list.slice(), fetchedAt: cached.fetchedAt } : cached;
    if (sid) ensurePinned(entry.list, service, sid);
    return entry;
  }

  let list = [];
  try {
    const res = await env.DB.prepare(
      "SELECT * FROM proxies WHERE active = 1 AND (service = ? OR service = 'shared') AND (blocked_until IS NULL OR blocked_until <= ?) ORDER BY COALESCE(last_used, '0') ASC LIMIT ?"
    ).bind(service, now, POOL_SIZE).all();
    list = res.results || [];
  } catch {}

  if (list.length === 0) {
    try {
      const res = await env.DB.prepare(
        "SELECT * FROM proxies WHERE active = 1 AND (service = ? OR service = 'shared') ORDER BY COALESCE(last_used, '0') ASC LIMIT ?"
      ).bind(service, POOL_SIZE).all();
      list = res.results || [];
    } catch {}
  }

  const entry = { list, fetchedAt: now };
  poolCache.set(service, entry);
  if (sid) ensurePinned(entry.list, service, sid);
  return entry;
}

// يضع البروكسي المثبّت لهذا السيد في مقدمة القائمة (ويحضره من DB إن خرج من الكاش)
async function ensurePinned(list, service, sid) {
  const pin = sidSticky.get(`${service}:${sid}`);
  if (!pin) return;
  if (pin.until <= Date.now()) { sidSticky.delete(`${service}:${sid}`); return; }
  const already = list.find((p) => String(p.id) === String(pin.proxyId));
  if (already) {
    const idx = list.indexOf(already);
    if (idx > 0) { list.splice(idx, 1); list.unshift(already); }
    return;
  }
  try {
    const pr = await env.DB.prepare('SELECT * FROM proxies WHERE id = ?').bind(Number(pin.proxyId)).first();
    if (pr) list.unshift(pr);
    else sidSticky.delete(`${service}:${sid}`);
  } catch {}
}

// ─── حالة البروكسي ───
function isProxyBad(proxyId, t = Date.now()) {
  return (badProxies.get(proxyId) || 0) > t;
}

function markBad(proxyId, t = Date.now()) {
  badProxies.set(proxyId, t + BAD_TTL_MS);
}

function markBadMs(proxyId, ttlMs, t = Date.now()) {
  badProxies.set(proxyId, t + ttlMs);
}

// ─── DB writes مع throttle (تقليل الضغط) ───
function shouldWriteD1(proxyId, t = Date.now()) {
  const last = d1WriteCache.get(proxyId) || 0;
  return (t - last) >= D1_WRITE_THROTTLE_MS;
}

function markBadD1(env, proxyId, ttlMs = BAD_TTL_MS) {
  if (!proxyId || !shouldWriteD1(proxyId)) return;
  d1WriteCache.set(proxyId, Date.now());
  const until = Date.now() + ttlMs;
  try {
    // .run() يُرجع وعداً؛ بدون .catch() يصبح رفضه unhandledRejection يسقط العملية.
    env.DB.prepare('UPDATE proxies SET blocked_until = ? WHERE id = ?')
      .bind(until, proxyId).run().catch(() => {});
  } catch {}
}

function markGoodD1(env, proxyId) {
  if (!proxyId || !shouldWriteD1(proxyId)) return;
  d1WriteCache.set(proxyId, Date.now());
  try {
    env.DB.prepare('UPDATE proxies SET blocked_until = 0 WHERE id = ?')
      .bind(proxyId).run().catch(() => {});
  } catch {}
}

// ─── اختيار البروكسي ───
function pickStickyProxy(entry, service, sid = null, t = Date.now()) {
  // 1) تثبيت الجلسة لكل (خدمة، sid): يبقى OTP/التوكين/الفعيل لنفس الرقم على نفس IP.
  if (service && sid) {
    const pin = sidSticky.get(`${service}:${sid}`);
    if (pin && pin.until > t) {
      const same = entry.list.find((p) => String(p.id) === String(pin.proxyId));
      if (same && !isProxyBad(same.id, t) && !isProxyIpBlocked(same, t)) return same;
    }
  }
  // 2) دجيزي: نوزّع الجلسات الجديدة بالتناوب على كل عناوين الخروج الصحية (round-robin)
  //    بدل تثبيتها على عنوان واحد لخمس دقائق — لتقليل الضغط والحدّ (429) لكل IP.
  if (service === 'djezzy') {
    const healthy = entry.list.filter((p) => !isProxyBad(p.id, t) && !isProxyIpBlocked(p, t));
    const pool = healthy.length ? healthy : entry.list;
    if (!pool.length) return null;
    const i = (rrCursor.get(service) || 0) % pool.length;
    rrCursor.set(service, i + 1);
    return pool[i];
  }
  const sticky = stickyByService.get(service);
  if (sticky && t - sticky.pickedAt < STICKY_TTL_MS) {
    const same = entry.list.find((p) => String(p.id) === String(sticky.proxyId));
    if (same && !isProxyBad(same.id, t) && !isProxyIpBlocked(same, t)) return same;
  }
  const proxy = entry.list.find((p) => !isProxyBad(p.id, t) && !isProxyIpBlocked(p, t)) || entry.list[0];
  if (proxy) stickyByService.set(service, { proxyId: proxy.id, pickedAt: t });
  return proxy;
}

function pickNextProxy(entry, excludeIds, t = Date.now()) {
  return entry.list.find((p) => !isProxyBad(p.id, t) && !isProxyIpBlocked(p, t) && !excludeIds.includes(p.id))
    || entry.list.find((p) => !isProxyBad(p.id, t) && !isProxyIpBlocked(p, t))
    || entry.list.find((p) => !excludeIds.includes(p.id))
    || entry.list[0];
}

// ─── حجب WAF/جغرافي ───
function isBlocked(result, service = 'shared') {
  const s = result.status;
  // عند دجيزي: 429 = حدّ/تغذية من الخدمة نفسها (وليس حجب البروكسي)،
  // فلا ندوّر IP الخروج كي تبقى الجلسة على نفس العنوان.
  if (service === 'djezzy' && s === 429) return false;
  if (s === 407 || s === 429 || s === 522) return true;
  if (s === 403 && typeof result.data === 'string' && /<html|<!doctype/i.test(result.data)) return true;
  if (s === 401 && typeof result.data === 'string' && /proxy|access denied|invalid auth/i.test(result.data)) return true;
  return false;
}

// بوابة شبكة المشغِّل (Gate) تعترض بعض IPs الخروج الدوّارة وترفض HTTPS الأجنبي/العالي
// بـ «errorMsg: 500 UNKNOWN ... code:5002 ... read reply from gate». هذا ليس رفضاً من
// الـ API — إنه IP بوابة سيئ: نسودّده ونستمر باتصال جديد (تدوير) حتى نجده سليماً.
function isGateway500(result) {
  if (Number(result?.status) !== 500) return false;
  const d = result?.data ?? result?.text;
  const t = typeof d === 'string' ? d : (d && typeof d === 'object' ? JSON.stringify(d) : String(d || ''));
  return /errorMsg:\s*500 UNKNOWN|read reply from gate|code:5002/i.test(t);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── بناء URL البروكسي ───
function stickyUsername(user, sid) {
  if (!user || !sid) return user;
  const clean = user.replace(/-sid-[a-zA-Z0-9]+/g, '');
  const value = String(sid).replace(/^sid-/, '');
  return `${clean}-sid-${value}`;
}

function proxyUrl(proxy, sid, service) {
  // لاحقة -sid- في اسم المستخدم يدعمها مزوّد ooredoo فقط؛
  // بالنسبة لدجيزي/غيرها نرسل الاسم كما هو (kookeey/novada يرفضون اللاحقة 407).
  const user = service === 'ooredoo' ? stickyUsername(proxy.username, sid) : proxy.username;
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(proxy.password || '')}@` : '';
  return `http://${auth}${proxy.host}:${proxy.port}`;
}

// ─── كتابة last_used مع throttle ───
async function touchLastUsed(env, proxy) {
  if (!proxy || !proxy.id) return;
  const last = lastUsedCache.get(proxy.id) || 0;
  const now = Date.now();
  if (now - last < LAST_USED_TTL_MS) return;
  lastUsedCache.set(proxy.id, now);
  try {
    await env.DB.prepare('UPDATE proxies SET last_used = ? WHERE id = ?')
      .bind(new Date().toISOString(), proxy.id).run();
  } catch {}
}

// ─── ترانسبورت Node: https عبر بروكسي CONNECT ───
// يعيد { status, headers, text } مع فك ضغط gzip/deflate تلقائياً.
// مهم: نضمن أن الوعد يُحسم دائماً (نجاح/خطأ/مهلة/إلغاء) حتى لا تتسرّب خانات التوازي
// (proxyInFlight) وتُجمّد كل طلبات البروكسي اللاحقة. لا نعتمد على signal في https.request
// (لا يُدمّر المقبس العالق أثناء CONNECT دائماً)، بل نُدمّر الطلب/الوكيل بأنفسنا.
function httpViaProxy(pUrl, targetUrl, { method, headers, body }, signal, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    let agent = null;
    let req = null;
    let hardTimer = null;
    const finish = (obj) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      try { if (signal && onAbort) signal.removeEventListener('abort', onAbort); } catch {}
      try { if (req) req.destroy(); } catch {}
      try { if (agent) agent.destroy(); } catch {}
      resolve(obj);
    };
    const onAbort = () => finish({ status: 0, headers: null, text: '', error: 'aborted/timeout' });
    let u;
    try { u = new URL(targetUrl); } catch { return finish({ status: 0, headers: null, text: '', error: 'bad target url' }); }
    try { agent = new HttpsProxyAgent(pUrl); } catch { return finish({ status: 0, headers: null, text: '', error: 'bad proxy url' }); }
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // مهلة صلبة داخلية (أعلى قليلاً من مهلة الطلب): شبكة أمان تضمن الحسم دائماً.
    const ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs + 5000 : 40000;
    hardTimer = setTimeout(onAbort, ms);
    const reqHeaders = { ...(headers || {}) };
    if (body !== undefined && body !== null && !reqHeaders['Content-Length']) {
      reqHeaders['Content-Length'] = Buffer.byteLength(String(body));
    }
    try {
      req = https.request(
        {
          method: method || 'GET',
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          headers: reqHeaders,
          agent,
          servername: u.hostname,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', (e) => finish({ status: 0, headers: null, text: '', error: (e && e.message) || 'response error' }));
          res.on('aborted', () => finish({ status: 0, headers: null, text: '', error: 'response aborted' }));
          res.on('end', () => {
            let buf = Buffer.concat(chunks);
            const enc = String(res.headers?.['content-encoding'] || '').toLowerCase();
            try {
              if (enc === 'gzip') buf = zlib.gunzipSync(buf);
              else if (enc === 'deflate') buf = zlib.inflateSync(buf);
              else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
            } catch {}
            finish({ status: res.statusCode || 0, headers: makeHeaders(res.headers), text: buf.toString('utf8') });
          });
        }
      );
    } catch (e) {
      return finish({ status: 0, headers: null, text: '', error: (e && e.message) || 'request setup error' });
    }
    req.on('error', (e) => finish({ status: 0, headers: null, text: '', error: (e && e.message) || 'proxy request error' }));
    req.on('timeout', () => finish({ status: 0, headers: null, text: '', error: 'socket timeout' }));
    try { req.setTimeout(ms, () => { try { req.destroy(); } catch {} }); } catch {}
    if (body !== undefined && body !== null) req.write(String(body));
    req.end();
  });
}

// بناء كائن Headers متوافق (يوجد فيه get + getSetCookie للاستعمالات في ooredoo.js)
function makeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    const h = new Headers();
    h.getSetCookie = () => [];
    return h;
  }
  const out = new Headers();
  const setCookies = [];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    if (k.toLowerCase() === 'set-cookie') {
      const arr = Array.isArray(v) ? v : [v];
      for (const c of arr) {
        setCookies.push(String(c));
        try {
          out.append('set-cookie', String(c));
        } catch {}
      }
    } else {
      try {
        out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      } catch {}
    }
  }
  out.getSetCookie = () => setCookies.slice();
  return out;
}

// ─── الطلب الرئيسي عبر البروكسي ───
async function proxyRequest(env, { method = 'GET', url, headers = {}, body, service = 'shared', sid = null }, timeoutMs = 30000) {
  const entry = await fetchProxyPool(env, service, sid);
  if (!entry.list.length) throw new Error(`لا يوجد بروكسي نشط للخدمة "${service}" في D1`);

  // لا ننهي إلا إذا كانت كل العناوين محظورة فعلياً (بلاك ليست IP) لأن إعادة المحاولة
  // بلا فائدة. أما الاستبعاد المؤقت (markBadMs بعد عطل شبكة عابر) فلا يمنع المحاولة.
  if (entry.list.every((p) => isProxyIpBlocked(p))) {
    return { status: 0, data: undefined, headers: null, error: `بروكسيات "${service}" كلها محظورة`, via: 'db-proxy' };
  }

  let lastResult = null;
  const usedIds = [];
  // للـ POST (تفعيل/إرسال): لا نعيد إلا عند فشل طبقة-النقل (407/بوابة-500/522) لأن الخادم
  // لم يستلم أصلاً؛ أي ردّ HTTP حقيقي (401/403/404/... مرّ من الخادم) يعود مباشرة
  // بدون إعادة إرسال — تحاشياً للتنشيط المزدوج.
  const maxAttempts = method === 'POST' ? Math.min(3, MAX_ATTEMPTS) : MAX_ATTEMPTS;
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // مهلة كل محاولة قصيرة (12ث افتراضاً) حتى لا تعلّق اتصالاً ميتاً على دجيزي خانة
    // التوازي طوال 60ث؛ والميزانية الكلية تبقى timeoutMs.
    const remaining = deadline - Date.now();
    if (attempt > 1 && remaining <= 1500) break;
    const attemptTimeout = Math.max(3000, Math.min(ATTEMPT_TIMEOUT_MS, remaining));

    const proxy = attempt === 1
      ? pickStickyProxy(entry, service, sid)
      : pickNextProxy(entry, usedIds);

    if (!proxy) {
      return { status: 0, data: undefined, headers: null, error: `لا يوجد بروكسي نشط للخدمة "${service}"`, via: 'db-proxy' };
    }
    usedIds.push(proxy.id);

    // تبريد بين المحاولات دون احتجاز خانة التوازي
    if (attempt > 1) await sleep(250 * (attempt - 1));

    const slotKey = String(proxy.id);
    await acquireProxySlot(slotKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), attemptTimeout);
    try {
      const target = new URL(url);
      const pUrl = proxyUrl(proxy, sid, service);

      const r = await httpViaProxy(pUrl, target.href, { method, headers, body }, ctrl.signal, attemptTimeout);
      console.log(`[proxy] ${proxy.host}:${proxy.port} sid=${sid || '-'} user=${proxy.username} status=${r.status} text=${String(r.text).slice(0, 80)}`);
      if (r.status === 407) console.log(`[proxy] 407 from ${proxy.host}:${proxy.port} (user=${proxy.username}) pUrl=${pUrl.split('@').pop()} text=${String(r.text).slice(0, 80)}`);

      if (!r.status) {
        // عطل شبكة عابر على هذا الاتصال: استبعاد قصير في الذاكرة فقط (لا نكتب blocked_until
        // في DB حتى لا يُقصى العنوان من التجمع بينما قد يعمل بعد لحظات).
        markBadMs(proxy.id, TRANSIENT_BAD_MS);
        lastResult = { status: 0, data: undefined, headers: null, text: r.text, error: r.error || 'proxy error', via: 'db-proxy' };
        if (attempt < maxAttempts) {
          console.log(`[proxy] attempt ${attempt}/${maxAttempts} error: ${r.error || 'network'} → retry`);
          continue;
        }
        return lastResult;
      }

      let data;
      try { data = JSON.parse(r.text); } catch { data = r.text; }
      const result = { status: r.status, data, headers: r.headers, text: r.text, via: 'db-proxy' };
      lastResult = result;

      // دجيزي 429 = ضغط/حدّ على عنوان الخروج الحالي. نستبعده دقيقة وننتقل لعنوان آخر
      // خلال نفس الطلب (حتى للـ POST لأن 429 يعني أن الطلب لم يُنفَّذ) لتوزيع الحمل.
      if (service === 'djezzy' && result.status === 429) {
        markBadMs(proxy.id, DJEZZY_429_BAD_MS);
        markBadD1(env, proxy.id, DJEZZY_429_BAD_MS);
        if (attempt < maxAttempts) {
          console.log(`[proxy] djezzy 429 on ${proxy.host}:${proxy.port} → rotate`);
          continue;
        }
        return result;
      }

      if (isBlocked(result, service) || isGateway500(result)) {
        if (result.status === 407) {
          // 407 = حد مصادقة/اتصالات عابر (خاصة مع التدوير عند الرمي): استبعاد قصير متصاعد،
          // يُصفَّر عند أي نجاح. لا نسودّد IP هنا (ليست مشكلة IP).
          const n = (authFailCount.get(proxy.id) || 0) + 1;
          authFailCount.set(proxy.id, n);
          const ttl = Math.min(AUTH_BAD_MAX_MS, AUTH_BAD_BASE_MS * Math.pow(2, n - 1));
          markBadMs(proxy.id, ttl);
          markBadD1(env, proxy.id, ttl);
          console.log(`[proxy] ${proxy.host}:${proxy.port} 407 x${n} → excl ${Math.round(ttl / 1000)}s`);
        } else if (isGateway500(result)) {
          // بوابة شبكة سيئة على هذا الـ IP: نفحص الـ IP ونضعه في بلاك ليست ثم نحذف
          // كاش الـ IP حتى لا يعلق البروكسي على عنوان سيئ، ونواصل باتصال/تدوير جديد.
          const ip = await probeEgressIp(env, proxy, service);
          if (ip) {
            blacklistIp(ip, `gateway 500`);
            await persistIpBlacklist(env, service, ip, proxy.host, 'gateway 500');
            ipCache.delete('P' + proxy.id);
          }
        } else {
          // حجب المشغِّل لعنوان الخروج: كشف الـ IP الفعلي وإضافته للبلاك ليست + استبعاد
          // قصير للصف (المزوّد الدوّار يعطي IP جديداً بالاتصال التالي — لا منفعة من حظر طويل).
          markBadMs(proxy.id, AUTH_BAD_BASE_MS);
          markBadD1(env, proxy.id, AUTH_BAD_BASE_MS);
          const ip = await probeEgressIp(env, proxy, service);
          if (ip) {
            blacklistIp(ip, `operator block http ${result.status}`);
            await persistIpBlacklist(env, service, ip, proxy.host, `operator block http ${result.status}`);
            ipCache.delete('P' + proxy.id);
          }
        }
        // للـ POST: إعادة التدوير فقط عند فشل طبقة-النقل (لم يبلغ الخادم) —
        // 407 ردّ البروكسي قبل إرسال الطلب، 522/بوابة-500 اعتراض قبل التطبيق.
        const transportFault = result.status === 407 || result.status === 522 || isGateway500(result);
        const canRotate = method !== 'POST' || transportFault;
        if (canRotate && attempt < maxAttempts) {
          console.log(`[proxy] attempt ${attempt}/${maxAttempts} blocked (${result.status}) → rotating${method === 'POST' ? ' (transport-only)' : ''}`);
          continue;
        }
        return result;
      }

      authFailCount.delete(proxy.id);
      markGoodD1(env, proxy.id);
      if (service === 'djezzy' && result.status !== 429) stickSid(service, sid, proxy.id);
      await touchLastUsed(env, proxy);
      return result;
    } catch (e) {
      markBadMs(proxy.id, TRANSIENT_BAD_MS);
      if (attempt < maxAttempts) {
        console.log(`[proxy] attempt ${attempt}/${maxAttempts} error: ${e.message} → retry`);
        continue;
      }
      return { status: 0, data: undefined, headers: null, error: e.message || 'proxy error', via: 'db-proxy' };
    } finally {
      clearTimeout(timer);
      releaseProxySlot(slotKey);
    }
  }
  return lastResult || { status: 0, data: undefined, headers: null, error: 'proxy attempts exhausted', via: 'db-proxy' };
}

export default proxyRequest;