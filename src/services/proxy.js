// proxy.js — بروكسي HTTP عبر CONNECT tunnel (نسخة Node.js / BZFBDZ-node)
// البديل المكافئ لنسخة الـ Worker (tunnelfetch + cloudflare:sockets):
// نفس منطق التجمع والتبديل والحجب تماماً، والترانسبورت عبر https-proxy-agent
// (Agent تابع لـ node:https) بدل tunnelfetch.
// نسخة محسّنة: حجب مستمر + ثبات + تدوير ذكي.
import https from 'node:https';
import zlib from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── ثوابت ───
const POOL_SIZE = 3;
const POOL_TTL_MS = 60000;
const STICKY_TTL_MS = 5 * 60 * 1000;
const BAD_TTL_MS = 5 * 60 * 1000;
const LAST_USED_TTL_MS = 30000;
const D1_WRITE_THROTTLE_MS = 10000; // لا نكتب لنفس البروكسي في D1 إلا كل 10 ثوانٍ
const MAX_ATTEMPTS = 3;

// ─── ذاكرة حالة (per-process) ───
const poolCache = new Map();
const stickyByService = new Map();
const badProxies = new Map();
const lastUsedCache = new Map();
const d1WriteCache = new Map(); // proxyId → آخر وقت كتابة في DB (للتخفيف)

// ─── ترحيل: إضافة عمود blocked_until ───
let migrationDone = false;
async function ensureMigration(env) {
  if (migrationDone) return;
  try {
    await env.DB.prepare('ALTER TABLE proxies ADD COLUMN blocked_until INTEGER DEFAULT 0').run();
  } catch {}
  migrationDone = true;
}

// ─── جلب البروكسيات من DB (مع تصفية المحجوبة) ───
async function fetchProxyPool(env, service = 'shared') {
  if (!env || !env.DB) throw new Error('env.DB غير معرفة');
  await ensureMigration(env);

  const now = Date.now();
  const cached = poolCache.get(service);
  if (cached && now - cached.fetchedAt < POOL_TTL_MS) return cached;

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
  return entry;
}

// ─── حالة البروكسي ───
function isProxyBad(proxyId, t = Date.now()) {
  return (badProxies.get(proxyId) || 0) > t;
}

function markBad(proxyId, t = Date.now()) {
  badProxies.set(proxyId, t + BAD_TTL_MS);
}

// ─── DB writes مع throttle (تقليل الضغط) ───
function shouldWriteD1(proxyId, t = Date.now()) {
  const last = d1WriteCache.get(proxyId) || 0;
  return (t - last) >= D1_WRITE_THROTTLE_MS;
}

function markBadD1(env, proxyId) {
  if (!proxyId || !shouldWriteD1(proxyId)) return;
  d1WriteCache.set(proxyId, Date.now());
  const until = Date.now() + BAD_TTL_MS;
  try {
    env.DB.prepare('UPDATE proxies SET blocked_until = ? WHERE id = ?')
      .bind(until, proxyId).run();
  } catch {}
}

function markGoodD1(env, proxyId) {
  if (!proxyId || !shouldWriteD1(proxyId)) return;
  d1WriteCache.set(proxyId, Date.now());
  try {
    env.DB.prepare('UPDATE proxies SET blocked_until = 0 WHERE id = ?')
      .bind(proxyId).run();
  } catch {}
}

// ─── اختيار البروكسي ───
function pickStickyProxy(entry, service, t = Date.now()) {
  const sticky = stickyByService.get(service);
  if (sticky && t - sticky.pickedAt < STICKY_TTL_MS) {
    const same = entry.list.find((p) => String(p.id) === String(sticky.proxyId));
    if (same && !isProxyBad(same.id, t)) return same;
  }
  const proxy = entry.list.find((p) => !isProxyBad(p.id, t)) || entry.list[0];
  if (proxy) stickyByService.set(service, { proxyId: proxy.id, pickedAt: t });
  return proxy;
}

function pickNextProxy(entry, excludeIds, t = Date.now()) {
  return entry.list.find((p) => !isProxyBad(p.id, t) && !excludeIds.includes(p.id))
    || entry.list.find((p) => !excludeIds.includes(p.id))
    || entry.list[0];
}

// ─── حجب WAF/جغرافي ───
function isBlocked(result) {
  const s = result.status;
  if (s === 407 || s === 429 || s === 522) return true;
  if (s === 403 && typeof result.data === 'string' && /<html|<!doctype/i.test(result.data)) return true;
  if (s === 401 && typeof result.data === 'string' && /proxy|access denied|invalid auth/i.test(result.data)) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── بناء URL البروكسي ───
function stickyUsername(user, sid) {
  if (!user || !sid) return user;
  const clean = user.replace(/-sid-[a-zA-Z0-9]+/g, '');
  const value = String(sid).replace(/^sid-/, '');
  return `${clean}-sid-${value}`;
}

function proxyUrl(proxy, sid) {
  const user = stickyUsername(proxy.username, sid);
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
function httpViaProxy(pUrl, targetUrl, { method, headers, body }, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const agent = new HttpsProxyAgent(pUrl);
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return resolve({ status: 0, headers: null, text: '', error: 'bad target url' });
    }
    const reqHeaders = { ...(headers || {}) };
    if (body !== undefined && body !== null) {
      if (!reqHeaders['Content-Length']) {
        reqHeaders['Content-Length'] = Buffer.byteLength(String(body));
      }
    }
    const req = https.request(
      {
        method: method || 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: reqHeaders,
        agent,
        servername: u.hostname,
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          try {
            agent.destroy();
          } catch {}
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers?.['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch {}
          const text = buf.toString('utf8');
          resolve({ status: res.statusCode || 0, headers: makeHeaders(res.headers), text });
        });
      }
    );
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      try {
        agent.destroy();
      } catch {}
      resolve({ status: 0, headers: null, text: '', error: (e && e.message) || 'proxy request error' });
    });
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
  const entry = await fetchProxyPool(env, service);
  if (!entry.list.length) throw new Error(`لا يوجد بروكسي نشط للخدمة "${service}" في D1`);

  let lastResult = null;
  const usedIds = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const proxy = attempt === 1
      ? pickStickyProxy(entry, service)
      : pickNextProxy(entry, usedIds);

    if (!proxy) {
      return { status: 0, data: undefined, headers: null, error: `لا يوجد بروكسي نشط للخدمة "${service}"`, via: 'db-proxy' };
    }
    if (proxy) usedIds.push(proxy.id);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const target = new URL(url);
      const pUrl = proxyUrl(proxy, sid);

      const r = await httpViaProxy(pUrl, target.href, { method, headers, body }, ctrl.signal);
      console.log(`[proxy] ${proxy.host}:${proxy.port} sid=${sid || '-'} user=${proxy.username} status=${r.status} text=${String(r.text).slice(0, 80)}`);
      if (r.status === 407) console.log(`[proxy] 407 from ${proxy.host}:${proxy.port} (user=${proxy.username}) pUrl=${pUrl.split('@').pop()} text=${String(r.text).slice(0,80)}`);

      if (!r.status) {
        markBad(proxy.id);
        markBadD1(env, proxy.id);
        lastResult = { status: 0, data: undefined, headers: null, text: r.text, error: r.error || 'proxy error', via: 'db-proxy' };
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[proxy] attempt ${attempt}/${MAX_ATTEMPTS} error: ${r.error || 'network'} → retry`);
          await sleep(300 * attempt);
          continue;
        }
        return lastResult;
      }

      let data;
      try { data = JSON.parse(r.text); } catch { data = r.text; }
      const result = { status: r.status, data, headers: r.headers, text: r.text, via: 'db-proxy' };
      lastResult = result;

      if (isBlocked(result)) {
        markBad(proxy.id);
        markBadD1(env, proxy.id);
        if (attempt < MAX_ATTEMPTS) {
          console.log(`[proxy] attempt ${attempt}/${MAX_ATTEMPTS} blocked (${result.status}) → rotating`);
          await sleep(300 * attempt);
          continue;
        }
        return result;
      }

      markGoodD1(env, proxy.id);
      await touchLastUsed(env, proxy);
      return result;
    } catch (e) {
      markBad(proxy.id);
      markBadD1(env, proxy.id);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[proxy] attempt ${attempt}/${MAX_ATTEMPTS} error: ${e.message} → retry`);
        await sleep(300 * attempt);
        continue;
      }
      return { status: 0, data: undefined, headers: null, error: e.message || 'proxy error', via: 'db-proxy' };
    } finally {
      clearTimeout(timer);
    }
  }
  return lastResult || { status: 0, data: undefined, headers: null, error: 'proxy attempts exhausted', via: 'db-proxy' };
}

export default proxyRequest;