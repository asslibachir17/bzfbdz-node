// ============================================================
// BZFBDZ-node — server.js
// خادم Node.js يحاكي بيئة Worker: يستقبل webhooks فيسبوك/تلغرام/انستغرام
// ويمرّرها إلى نفس معالجات الـ Worker الأصلية (src/index.js والتوينات)
// مع بيئة env + ctx + DB متوافقة (SQLite محلياً / PostgreSQL على Render).
//
// المسارات:
//   /            فيسبوك  (webhook سابقاً في الـ Worker)
//   /tg/...      تلغرام   → https://<host>/tg/webhook
//   /ig/...      انستغرام → https://<host>/ig/webhook
// ============================================================
import http from 'node:http';
import './src/runtime/shims.js';
import { createDb } from './src/runtime/db.js';
import { buildEnv, loadDotEnv } from './src/runtime/env.js';
import fbWorker from './src/index.js';
import tgWorker from './src/tg-index.js';
import igWorker from './src/ig-index.js';

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'host',
  'expect',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// اختيار المعالج حسب البادئة: /tg و/ig و(الافتراضي) فيسبوك
function pickHandler(pathname) {
  if (pathname === '/tg' || pathname.startsWith('/tg/')) {
    return { worker: tgWorker, path: pathname === '/tg' ? '/' : pathname.slice(3) };
  }
  if (pathname === '/ig' || pathname.startsWith('/ig/')) {
    return { worker: igWorker, path: pathname === '/ig' ? '/' : pathname.slice(3) };
  }
  return { worker: fbWorker, path: pathname || '/' };
}

async function handleRequest(req, res, env, ctx) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { worker, path } = pickHandler(u.pathname);

  const raw = await readBody(req);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v || HOP_BY_HOP.has(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }

  const targetUrl = `http://${req.headers.host || 'localhost'}${path}${u.search}`;
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = raw.toString('utf8');
  }

  const webReq = new Request(targetUrl, init);
  const webRes = await worker.fetch(webReq, env, ctx);

  const outHeaders = {};
  if (webRes.headers) webRes.headers.forEach((v, k) => { outHeaders[k] = v; });
  res.writeHead(webRes.status, outHeaders);
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

// المجدول: صيانة يومية في الساعة MAINT_HOUR_UTC (افتراضي 04:00 مثل cron الأصلي)
function startSchedulers(env, ctx) {
  const hour = Number.isFinite(Number(process.env.MAINT_HOUR_UTC)) ? Number(process.env.MAINT_HOUR_UTC) : 4;
  let lastDay = -1;
  const run = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      console.error('[maint]', label, (e && e.message) || e);
    }
  };
  setInterval(async () => {
    const now = new Date();
    if (now.getUTCHours() !== hour || now.getUTCMinutes() !== 0) return;
    if (now.getUTCDate() === lastDay) return;
    lastDay = now.getUTCDate();
    await run('fb', () => fbWorker.scheduled({}, env, ctx));
    await run('ig', () => igWorker.scheduled({}, env, ctx));
  }, 60 * 1000);
  console.log(`[BZFBDZ-node] daily maintenance scheduled at ${hour}:00 UTC`);
}

async function main() {
  loadDotEnv();
  const db = await createDb();
  const env = buildEnv(db);
  const ctx = {
    waitUntil(p) {
      Promise.resolve(p).catch((e) => console.error('[waitUntil]', (e && e.stack) || e));
    },
    passThroughOnException() {},
  };

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, env, ctx);
    } catch (e) {
      console.error('[server error]', (e && e.stack) || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e && e.message) || 'internal error' }));
      }
    }
  });

  const port = Number(process.env.PORT || 8080);
  server.listen(port, '0.0.0.0', () => {
    console.log(`[BZFBDZ-node] listening on 0.0.0.0:${port} (db: ${db.backend}${db.path ? ' @ ' + db.path : ''})`);
  });

  startSchedulers(env, ctx);

  const shutdown = () => {
    console.log('[BZFBDZ-node] shutting down...');
    try {
      db.close();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[BZFBDZ-node] فشل الإقلاع:', (e && e.stack) || e);
  process.exit(1);
});