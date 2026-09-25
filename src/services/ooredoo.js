const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { Pool } = require('pg');
const {
  API_BASE_URL_OOREDOO,
  FACEBOOK_PAGE_ACCESS_TOKEN,
} = require('../config/config');
const { generateDeviceFingerprint, xSignature } = require('./ooredooSignatureFast');

// ---------------------------------------------------------------------------
// 1) قاعدة البيانات — Pool آمن ضد التعليق وانقطاع الاتصال
// ---------------------------------------------------------------------------
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000),
});

pool.on('error', (err) => {
  console.error('[PG] خطأ على اتصال خامل:', err.message);
});

// ---------------------------------------------------------------------------
// 2) تسجيل الأحداث — كتابة غير متزامنة (Batch)
// ---------------------------------------------------------------------------
const LOG_ENABLED = String(process.env.OOREDOO_LOG || '1') !== '0';
const LOG_DIR = process.env.OOREDOO_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = process.env.OOREDOO_LOG_FILE || path.join(LOG_DIR, 'ooredoo_api.log');
const LOG_MAX_LINE = Number(process.env.OOREDOO_LOG_MAX_LINE || 2000);
const LOG_QUEUE_LIMIT = Number(process.env.OOREDOO_LOG_QUEUE_LIMIT || 2000);
const LOG_FLUSH_MS = Number(process.env.OOREDOO_LOG_FLUSH_MS || 1000);

let logQueue = [];
let logFlushing = false;

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function flushLogQueue() {
  if (!LOG_ENABLED || logFlushing || logQueue.length === 0) return;
  logFlushing = true;
  const batch = logQueue.splice(0, logQueue.length);
  fs.promises
    .appendFile(LOG_FILE, batch.join(''), 'utf8')
    .catch((err) => console.error('[LOG] فشل كتابة السجل:', err.message))
    .finally(() => {
      logFlushing = false;
    });
}

function pushLogLine(line) {
  if (!LOG_ENABLED) return;
  logQueue.push(line);
  if (logQueue.length >= LOG_QUEUE_LIMIT) flushLogQueue();
}

if (LOG_ENABLED) {
  ensureLogDir();
  setInterval(flushLogQueue, LOG_FLUSH_MS).unref();
  process.on('exit', () => {
    try {
      if (logQueue.length > 0) fs.appendFileSync(LOG_FILE, logQueue.join(''), 'utf8');
    } catch {}
  });
}

const SECRET_FIELD_PATTERN = /access_token|refresh_token|authorization|cookie|password|otp|x-signature/i;

function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = SECRET_FIELD_PATTERN.test(key) ? '***' : redact(value[key]);
    }
    return out;
  }
  return value;
}

function truncate(value, max = LOG_MAX_LINE) {
  if (value === undefined) return value;
  let str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str && str.length > max) str = `${str.slice(0, max)}… [truncated ${str.length - max} chars]`;
  return str;
}

function logApi(entry) {
  if (!LOG_ENABLED) return;
  try {
    const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`;
    pushLogLine(line);
    const err = entry.errMessage ? ` | ERR: ${entry.errMessage}` : '';
    const via = entry.via ? ` via=${entry.via}` : '';
    console.log(`[OOREDOO-API] ${entry.request?.method || ''} ${entry.request?.url || ''} → ${entry.response?.status || 'ERR'} (${entry.durationMs}ms)${via}${err}`);
  } catch {}
}

// ---------------------------------------------------------------------------
// 3) الثوابت والإعدادات
// ---------------------------------------------------------------------------
const CHECKPOINT_PATH = '/api/ooredoo-bff/checkpoint/token';
const TOKEN_PATH = '/api/auth/realms/myooredoo/protocol/openid-connect/token';
const APP_VERSION = process.env.APP_VERSION || '1.5.15';
const INSTANCE_ID = process.env.OOREDOO_INSTANCE_ID || crypto.randomUUID().replace(/-/g, '');
const NATIVE_TOKEN = process.env.NATIVE_TOKEN || '';

const BYOP_VALIDITY = process.env.OOREDOO_BYOP_VALIDITY || 'Biweekly';
const BYOP_CODES = ['IG', 'YT', 'WA', 'FB', process.env.OOREDOO_BYOP_TT_CODE || '2Go_Tt'];
const BYOP_LIMITED_CODES = String(process.env.OOREDOO_BYOP_LIMITED_CODES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function toMsisdn(phoneNumber) {
  const digits = String(phoneNumber ?? '').replace(/\D/g, '');
  return `213${digits.replace(/^0/, '')}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 4) طابور OTP مع تهدئة تكيّفية
// ---------------------------------------------------------------------------
const OTP_QUEUE_INTERVAL_MS = parseInt(process.env.OOREDOO_OTP_INTERVAL_MS || '2500', 10);
const OTP_QUEUE_COOLDOWN_MS = parseInt(process.env.OOREDOO_OTP_COOLDOWN_MS || '30000', 10);
const OTP_QUEUE_COOLDOWN_MAX_MS = parseInt(process.env.OOREDOO_OTP_COOLDOWN_MAX_MS || '180000', 10);
const OTP_QUEUE_WAF_THRESHOLD = parseInt(process.env.OOREDOO_OTP_WAF_THRESHOLD || '3', 10);
const OTP_MAX_ATTEMPTS = parseInt(process.env.OOREDOO_MAX_OTP_ATTEMPTS || '1', 10);
const OTP_TRANSPORT_MAX_ATTEMPTS = parseInt(process.env.OOREDOO_TRANSPORT_ATTEMPTS || '3', 10);
const OTP_PACING_MS = parseInt(process.env.OOREDOO_OTP_PACING_MS || '0', 10);
const OTP_401_SUSPECT_THRESHOLD = parseInt(process.env.OOREDOO_OTP_401_THRESHOLD || '4', 10);
const OTP_401_COOLDOWN_MS = parseInt(process.env.OOREDOO_OTP_401_COOLDOWN_MS || '15000', 10);
const OTP_PER_NUMBER_401_THRESHOLD = parseInt(process.env.OOREDOO_PER_NUMBER_401_THRESHOLD || '3', 10);
const OTP_PER_NUMBER_COOLDOWN_MS = parseInt(process.env.OOREDOO_PER_NUMBER_COOLDOWN_MS || '30000', 10);

let otpQueue = [];
let otpQueueRunning = false;
let otpCooldownUntil = 0;
let lastOtpRunAt = 0;
let consecutiveWafBlocks = 0;
let consecutiveOtp401s = 0;
let otpCooldownMs = OTP_QUEUE_COOLDOWN_MS;

const otpNumberCooldownUntil = new Map();
const otpNumber401Count = new Map();

function setNumberCooldown(msisdn) {
  otpNumberCooldownUntil.set(msisdn, Date.now() + OTP_PER_NUMBER_COOLDOWN_MS);
  otpNumber401Count.delete(msisdn);
}

function numberCooldownLeftMs(msisdn) {
  const left = (otpNumberCooldownUntil.get(msisdn) || 0) - Date.now();
  return left > 0 ? left : 0;
}

function enqueueOtp(task) {
  return new Promise((resolve, reject) => {
    otpQueue.push({ task, resolve, reject });
    drainOtpQueue();
  });
}

function isWafBlockResult(result) {
  if (!result) return false;
  if (result.statusCode === 407) return false;
  if (result.statusCode === 500) return true;
  if (result.statusCode === 401 && typeof result.data === 'string' && /<html/i.test(result.data)) return true;
  return false;
}

function registerOtpResult(result) {
  if (isWafBlockResult(result)) {
    consecutiveWafBlocks++;
    consecutiveOtp401s = 0;
    if (consecutiveWafBlocks >= OTP_QUEUE_WAF_THRESHOLD) {
      otpCooldownUntil = Date.now() + otpCooldownMs;
      console.log(`🧊 WAF حجب ${consecutiveWafBlocks} مرات متتالية → cooldown ${Math.round(otpCooldownMs / 1000)}s`);
      otpCooldownMs = Math.min(otpCooldownMs * 2, OTP_QUEUE_COOLDOWN_MAX_MS);
      consecutiveWafBlocks = 0;
    }
  } else if (result && result.statusCode === 401) {
    consecutiveOtp401s++;
    if (consecutiveOtp401s >= OTP_401_SUSPECT_THRESHOLD) {
      otpCooldownUntil = Math.max(otpCooldownUntil, Date.now() + OTP_401_COOLDOWN_MS);
      console.log(`⚙️ ${consecutiveOtp401s} استجابات 401 متتالية → تهدئة قصيرة ${Math.round(OTP_401_COOLDOWN_MS / 1000)}s`);
      consecutiveOtp401s = 0;
    }
  } else {
    consecutiveWafBlocks = 0;
    consecutiveOtp401s = 0;
    otpCooldownMs = OTP_QUEUE_COOLDOWN_MS;
  }
}

async function drainOtpQueue() {
  if (otpQueueRunning) return;
  otpQueueRunning = true;
  try {
    while (otpQueue.length > 0) {
      if (otpCooldownUntil > Date.now()) {
        const wait = otpCooldownUntil - Date.now();
        console.log(`🧊 إيقاف مؤقت ${Math.round(wait / 1000)}s قبل استئناف الطابور...`);
        await sleep(wait);
      }
      const sinceLast = Date.now() - lastOtpRunAt;
      if (lastOtpRunAt > 0 && sinceLast < OTP_QUEUE_INTERVAL_MS) {
        await sleep(OTP_QUEUE_INTERVAL_MS - sinceLast);
      }
      const item = otpQueue.shift();
      lastOtpRunAt = Date.now();
      try {
        const result = await item.task();
        registerOtpResult(result);
        item.resolve(result);
      } catch (error) {
        registerOtpResult({ statusCode: 500, error: error.message });
        item.reject(error);
      }
    }
  } finally {
    otpQueueRunning = false;
  }
}

// ---------------------------------------------------------------------------
// 5) البروكسي من قاعدة البيانات
// ---------------------------------------------------------------------------
const DB_PROXY_ROTATION_INTERVAL = parseInt(process.env.DB_PROXY_ROTATION_INTERVAL || '10', 10);
const STABLE_SID = 'sid-8d203eda';

let lastDbProxyUrl = null;
let dbProxyRequestCount = 0;

function freshSidProxyUrl(proxyUrl, customSid = null) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return proxyUrl;
  const sidToUse = customSid || STABLE_SID;

  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username) {
      const cleanUser = parsed.username.replace(/-sid-[a-zA-Z0-9]+/, '');
      parsed.username = `${cleanUser}-${sidToUse}`;
      return parsed.toString();
    }
  } catch {}

  if (/-sid-[a-zA-Z0-9]+/.test(proxyUrl)) {
    return proxyUrl.replace(/-sid-[a-zA-Z0-9]+/, `-${sidToUse}`);
  }

  const at = proxyUrl.indexOf('@');
  if (at === -1) return proxyUrl;
  return `${proxyUrl.slice(0, at)}-${sidToUse}${proxyUrl.slice(at)}`;
}

async function setupDbProxy() {
  try {
    const result = await pool.query(`
      SELECT * FROM proxies
      WHERE active = true
      ORDER BY last_used ASC NULLS FIRST
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      console.warn('⚠️ لا يوجد بروكسي مفعل في قاعدة البيانات.');
      lastDbProxyUrl = null;
      return;
    }

    const proxy = result.rows[0];
    const auth = proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : '';
    lastDbProxyUrl = freshSidProxyUrl(`http://${auth}${proxy.host}:${proxy.port}`);

    await pool.query(`UPDATE proxies SET last_used = NOW() WHERE id = $1`, [proxy.id]);
    console.log(`✅ تم تفعيل بروكسي DB: ${proxy.host}:${proxy.port} [User: ${proxy.username}]`);
  } catch (error) {
    console.error('❌ فشل جلب البروكسي من DB:', error.message);
    lastDbProxyUrl = null;
  }
}

function refreshDbProxyConnection() {
  if (!lastDbProxyUrl) return;
  lastDbProxyUrl = freshSidProxyUrl(lastDbProxyUrl);
  console.log('🔄 إعادة الاتصال بالبروكسي (ثبات الـ SID/IP)');
}

// ---------------------------------------------------------------------------
// 6) تدفق الجلسات المرتبطة
// ---------------------------------------------------------------------------
let currentFlowSid = null;
const otpPinnedSid = new Map();

function freshFlowSid() {
  currentFlowSid = `sid-${crypto.randomBytes(5).toString('hex')}`;
  return currentFlowSid;
}

function otpProxyUrl() {
  return lastDbProxyUrl ? freshSidProxyUrl(lastDbProxyUrl, currentFlowSid) : null;
}

function createProxyAgent(url) {
  if (!url) return null;
  const agent = new HttpsProxyAgent(url);
  agent.options.rejectUnauthorized = false;
  return agent;
}

// ---------------------------------------------------------------------------
// 7) طبقة HTTP
// ---------------------------------------------------------------------------
const httpClient = axios.create({ timeout: 25000, proxy: false });

async function performRequest(config, agent) {
  const requestConfig = agent ? { ...config, httpsAgent: agent } : config;
  try {
    const res = await httpClient.request(requestConfig);
    return { status: res.status, data: res.data, headers: res.headers || {}, errMessage: null };
  } catch (error) {
    const res = error.response;
    if (res) {
      return { status: res.status, data: res.data, headers: res.headers || {}, errMessage: error.message };
    }
    return { status: 0, data: undefined, headers: {}, errMessage: error.message };
  }
}

async function rawRequest(method, url, headers, body, flowAgent) {
  const start = Date.now();
  const config = { method, url, headers, timeout: 25000 };
  if (body !== undefined && body !== null) config.data = body;

  let result;
  let via = 'direct';

  if (flowAgent) {
    via = 'flow-proxy';
    result = await performRequest(config, flowAgent);
    if (result.status === 0) result = { ...result, status: 500 };
    return finishRaw(result, via, start, method, url, headers, body);
  }

  if (!lastDbProxyUrl) await setupDbProxy();

  if (lastDbProxyUrl) {
    via = 'db-proxy';
    const agent = new HttpsProxyAgent(lastDbProxyUrl);
    agent.options.rejectUnauthorized = false;
    try {
      result = await performRequest(config, agent);
    } finally {
      if (agent && typeof agent.destroy === 'function') agent.destroy();
    }
  }

  if (!result || result.status === 0 || result.status === 407) {
    via = 'direct';
    result = await performRequest(config, null);
  }

  if (!result || result.status === 0) result = { status: 500, data: undefined, headers: {}, errMessage: result?.errMessage };

  dbProxyRequestCount++;
  if (dbProxyRequestCount >= DB_PROXY_ROTATION_INTERVAL) {
    dbProxyRequestCount = 0;
    setupDbProxy().catch(console.error);
  }

  return finishRaw(result, via, start, method, url, headers, body);
}

function finishRaw(result, via, start, method, url, headers, body) {
  logApi({
    ts: new Date().toISOString(),
    request: {
      method,
      url: url.replace(/token[^/]*$/i, 'token'),
      headers: redact({
        'x-path': headers['x-path'],
        'x-method': headers['x-method'],
        'x-nonce-id': headers['x-nonce-id'],
        'x-chronos-id': headers['x-chronos-id'],
        'x-msisdn': headers['x-msisdn'],
        'x-signature': headers['x-signature'],
        'x-version': headers['x-version'],
        platform: headers.platform,
        'x-platform-origin': headers['x-platform-origin'],
        'x-correlation-id': headers['x-correlation-id'],
      }),
      body: truncate(redact(body)),
    },
    response: {
      status: result.status,
      data: truncate(redact(result.data)),
    },
    via,
    errMessage: result.errMessage,
    durationMs: Date.now() - start,
  });

  return { status: result.status, headers: result.headers || {}, data: result.data, via };
}

function cookieJar(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return '';
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
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

function logFlow(operation, msisdn, result, extra) {
  if (!LOG_ENABLED) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      flow: {
        operation,
        msisdn: msisdn ? `213${msisdn.replace(/^213/, '').replace(/^0/, '').replace(/.(?=.{3}$)/g, 'x')}` : undefined,
        statusCode: result?.statusCode,
        ...(extra || {}),
      },
    };
    pushLogLine(`${new Date().toISOString()} ${JSON.stringify(entry)}\n`);
    console.log(`[OOREDOO-FLOW] ${operation} (${entry.flow.msisdn}) → ${result?.statusCode}`);
  } catch {}
}

// ---------------------------------------------------------------------------
// 8) بناء الرؤوس
// ---------------------------------------------------------------------------
function commonHeaders({ signature, correlationId, timestamp, fingerprint, msisdn, cookie }) {
  return {
    'User-Agent': 'Dart/3.4 (dart:io)',
    Accept: '*/*',
    platform: 'android',
    'X-Platform-Origin': 'mobile-android',
    'x-msisdn': msisdn,
    'X-Correlation-ID': correlationId,
    'x-signature': signature,
    'x-version': APP_VERSION,
    'X-Timestamp': String(timestamp),
    'X-Instance-Id': INSTANCE_ID,
    'X-Device-Fingerprint': fingerprint,
    'x-force-update': 'true',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function checkpointHeaders(signature, correlationId, timestamp, fingerprint, path, method, msisdn, cookie) {
  return {
    ...commonHeaders({ signature, correlationId, timestamp, fingerprint, msisdn, cookie }),
    'Content-Type': 'application/json',
    'x-path': path,
    'x-method': method,
    ...(NATIVE_TOKEN ? { 'X-Native-Integrity-Token': NATIVE_TOKEN } : {}),
  };
}

function tokenHeaders(signature, correlationId, timestamp, fingerprint, nonceId, chronosId, msisdn, cookie) {
  return {
    ...commonHeaders({ signature, correlationId, timestamp, fingerprint, msisdn, cookie }),
    'Content-Type': 'application/x-www-form-urlencoded',
    'x-nonce-id': nonceId,
    'x-chronos-id': chronosId,
  };
}

async function checkpoint(signature, correlationId, timestamp, fingerprint, msisdn, path, method, cookie, flowAgent) {
  return rawRequest(
    'POST',
    `${API_BASE_URL_OOREDOO}${CHECKPOINT_PATH}`,
    checkpointHeaders(signature, correlationId, timestamp, fingerprint, path, method, msisdn, cookie),
    '{}',
    flowAgent
  );
}

async function nonceHandshake(msisdn, path, method, flowAgent) {
  const ts = Date.now();
  const corr = `${ts}-${Math.floor(100 + Math.random() * 900)}`;
  const fp = generateDeviceFingerprint(INSTANCE_ID, msisdn, ts);
  const sig = xSignature();
  const cp = await checkpoint(sig, corr, ts, fp, msisdn, path, method, undefined, flowAgent);
  const nonceId = cp.headers['x-nonce-id'];
  const chronosId = cp.headers['x-chronos-id'];
  if (!nonceId || !chronosId) throw new Error('checkpoint did not issue a nonce — WAF-blocked or Proxy failed');
  return { nonceId, chronosId, cookie: cookieJar(cp.headers), signature: sig, correlationId: corr, timestamp: ts, fingerprint: fp };
}

async function tokenRequest(msisdn, nonce, params, flowAgent) {
  const body = params.join('&');
  return rawRequest(
    'POST',
    `${API_BASE_URL_OOREDOO}${TOKEN_PATH}`,
    tokenHeaders(
      nonce.signature,
      nonce.correlationId,
      nonce.timestamp,
      nonce.fingerprint,
      nonce.nonceId,
      nonce.chronosId,
      msisdn,
      nonce.cookie
    ),
    body,
    flowAgent
  );
}

// ---------------------------------------------------------------------------
// 9) تدفق OTP الموحّد
// ---------------------------------------------------------------------------
async function tokenFlow(msisdn, sidMode, buildParams) {
  currentFlowSid = sidMode === 'pinned' ? otpPinnedSid.get(msisdn) || freshFlowSid() : freshFlowSid();
  const flowAgent = createProxyAgent(otpProxyUrl());
  if (!flowAgent) return { statusCode: 500, data: { message: 'لا يوجد بروكسي متاح' } };
  try {
    const nonce = await nonceHandshake(msisdn, TOKEN_PATH, 'POST', flowAgent);
    await sleep(OTP_PACING_MS);
    return await tokenRequest(msisdn, nonce, buildParams(), flowAgent);
  } finally {
    if (flowAgent && typeof flowAgent.destroy === 'function') flowAgent.destroy();
  }
}

async function attemptOtpSend(msisdn) {
  const res = await tokenFlow(msisdn, 'fresh', () => {
    const params = ['client_id=myooredoo-app', 'grant_type=password', `username=${encodeURIComponent(msisdn)}`];
    if (process.env.OOREDOO_PASSWORD) params.push(`password=${encodeURIComponent(process.env.OOREDOO_PASSWORD)}`);
    return params;
  });

  if (res.status === 403) {
    otpPinnedSid.set(msisdn, currentFlowSid);
    return { statusCode: 200, data: { message: 'OTP sent', otpRequired: true } };
  }
  if (res.status === 200) {
    if (typeof res.data === 'string' && /<html/i.test(res.data)) {
      return { statusCode: 500, data: { message: 'WAF blocked', blocked: true } };
    }
    const body = parseBody(res.data);
    if (body.access_token) return { statusCode: 200, data: body };
    return { statusCode: 200, data: { message: 'OTP sent', otpRequired: true } };
  }
  return { statusCode: res.status, data: parseBody(res.data) };
}

async function doVerifyOtp(msisdn, code) {
  const res = await tokenFlow(msisdn, 'pinned', () => [
    'grant_type=password',
    `username=${encodeURIComponent(msisdn)}`,
    'client_id=myooredoo-app',
    `otp=${encodeURIComponent(String(code ?? '').trim())}`,
  ]);
  const body = parseBody(res.data);
  if (body.access_token) otpPinnedSid.delete(msisdn);
  return { statusCode: res.status, data: body };
}

async function doRefreshToken(msisdn, refreshToken) {
  const res = await tokenFlow(msisdn, 'fresh', () => [
    'grant_type=refresh_token',
    'client_id=myooredoo-app',
    `refresh_token=${encodeURIComponent(refreshToken)}`,
  ]);
  return { statusCode: res.status, data: parseBody(res.data) };
}

// ---------------------------------------------------------------------------
// 10) خوارزمية OTP مع إعادة المحاولة
// ---------------------------------------------------------------------------
async function runOtpWithRetry(task, msisdn, logLabel, summarize) {
  let result = null;
  let attempts = 0;
  let transportAttempts = 0;

  try {
    const waitMs = numberCooldownLeftMs(msisdn);
    if (waitMs > 0) {
      const waitLabel = waitMs < 60000 ? `${Math.max(1, Math.ceil(waitMs / 1000))} ثانية` : `${Math.ceil(waitMs / 60000)} دقيقة`;
      const cooldownResult = {
        statusCode: 429,
        data: { message: `كثرة المحاولات على هذا الرقم، أعد المحاولة بعد ${waitLabel}`, waitMs },
      };
      logFlow(logLabel, msisdn, cooldownResult, { attempts: 0 });
      return cooldownResult;
    }

    if (!lastDbProxyUrl) await setupDbProxy();
    refreshDbProxyConnection();

    const numberThrottle = logLabel === 'sendOtp';

    while (true) {
      attempts++;
      try {
        result = await enqueueOtp(() => task());
      } catch (error) {
        transportAttempts++;
        if (transportAttempts >= OTP_TRANSPORT_MAX_ATTEMPTS) {
          result = { statusCode: 500, error: error.message };
          break;
        }
        refreshDbProxyConnection();
        console.log(`🚚 فشل نقل (${error.message}) → إعادة محاولة ${transportAttempts + 1}/${OTP_TRANSPORT_MAX_ATTEMPTS}`);
        continue;
      }

      if (result.statusCode === 407 || result.statusCode >= 500 || isWafBlockResult(result)) {
        transportAttempts++;
        if (transportAttempts >= OTP_TRANSPORT_MAX_ATTEMPTS) break;
        refreshDbProxyConnection();
        console.log(`🚚 فشل نقل (${result.statusCode}) → إعادة محاولة ${transportAttempts + 1}/${OTP_TRANSPORT_MAX_ATTEMPTS}`);
        continue;
      }

      if (result.statusCode === 401) {
        refreshDbProxyConnection();
        if (numberThrottle) {
          const c = (otpNumber401Count.get(msisdn) || 0) + 1;
          otpNumber401Count.set(msisdn, c);
          if (c >= OTP_PER_NUMBER_401_THRESHOLD) {
            setNumberCooldown(msisdn);
            console.log(`⏳ تخفيض الرقم ${msisdn.slice(0, 9)}x لمدة ${Math.round(OTP_PER_NUMBER_COOLDOWN_MS / 1000)} ثانية`);
            break;
          }
        }
        if (attempts >= OTP_MAX_ATTEMPTS) break;
        continue;
      }

      otpNumber401Count.delete(msisdn);
      break;
    }

    if (!result) result = { statusCode: 500, error: 'OTP transport failed' };
    logFlow(logLabel, msisdn, result, { attempts, ...(summarize ? summarize(result) : {}) });
    return result;
  } catch (error) {
    const errResult = { statusCode: 500, error: error.message, attempts };
    logFlow(logLabel, msisdn, errResult);
    return errResult;
  }
}

// ---------------------------------------------------------------------------
// 11) الواجهة العامة للـ OTP
// ---------------------------------------------------------------------------
async function sendOoredooVerificationCode(phoneNumber) {
  const msisdn = toMsisdn(phoneNumber);
  return runOtpWithRetry(() => attemptOtpSend(msisdn), msisdn, 'sendOtp', (r) => ({
    otpRequired: !!(r.data && r.data.otpRequired),
  }));
}

async function verifyOoredooCode(phoneNumber, code) {
  const msisdn = toMsisdn(phoneNumber);
  return runOtpWithRetry(() => doVerifyOtp(msisdn, code), msisdn, 'verifyOtp', (r) => ({
    hasAccessToken: !!(r.data && r.data.access_token),
  }));
}

async function refreshOoredooToken(phoneNumber, refreshToken) {
  const msisdn = toMsisdn(phoneNumber);
  return runOtpWithRetry(() => doRefreshToken(msisdn, refreshToken), msisdn, 'refreshToken', (r) => ({
    hasAccessToken: !!(r.data && r.data.access_token),
  }));
}

// ---------------------------------------------------------------------------
// 12) BFF endpoints
// ---------------------------------------------------------------------------
function freshTimestamp() {
  const ms = Date.now();
  const base = new Date(ms).toISOString().slice(0, 19);
  const micro = String((ms % 1000) * 1000 + Math.floor(Math.random() * 1000)).padStart(6, '0');
  return { ms, iso: `${base}.${micro}Z` };
}

function platformDataSignature(deviceId) {
  return Buffer.from(
    JSON.stringify({ platform: 'android', 'is-physical-device': true, 'device-id': deviceId }),
    'utf8'
  ).toString('base64');
}

function authHeaders(token, msisdn, cookie, extra) {
  const { ms, iso } = freshTimestamp();
  const fingerprint = generateDeviceFingerprint(INSTANCE_ID, msisdn, ms);
  return {
    'User-Agent': 'Dart/3.4 (dart:io)',
    'Accept-Encoding': 'gzip',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
    platform: 'android',
    'x-device-fingerprint': fingerprint,
    'x-platform-data-signature': platformDataSignature(INSTANCE_ID),
    'x-platform-origin': 'web',
    'x-signature': xSignature(),
    'x-timestamp': iso,
    'x-version': APP_VERSION,
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

async function bffRequest(method, path, token, msisdn, options) {
  try {
    const { body, extraHeaders } = options || {};
    const n = await nonceHandshake(msisdn, path, method);
    const res = await rawRequest(
      method,
      `${API_BASE_URL_OOREDOO}${path}`,
      authHeaders(token, msisdn, n.cookie, {
        'x-msisdn': msisdn,
        'x-nonce-id': n.nonceId,
        'x-chronos-id': n.chronosId,
        ...(extraHeaders || {}),
      }),
      body
    );
    return { statusCode: res.status, data: parseBody(res.data) };
  } catch (error) {
    return { statusCode: 500, error: error.message };
  }
}

function getOoredooGamificationStatus({ token, msisdn }) {
  return bffRequest('GET', '/api/ooredoo-bff/gamification/status', token, msisdn);
}

function getOoredooGamificationHistory({ token, msisdn }) {
  return bffRequest('GET', '/api/ooredoo-bff/gamification/history', token, msisdn);
}

function playOoredooGamification({ token, msisdn }) {
  return bffRequest('GET', '/api/ooredoo-bff/gamification/play', token, msisdn);
}

function checkOoredooSnapchatEligibility({ token, msisdn }) {
  return bffRequest('GET', '/api/ooredoo-bff/snap-chat/eligibility', token, msisdn);
}

function applyOoredooSnapchat({ token, msisdn }) {
  return bffRequest('POST', '/api/ooredoo-bff/snap-chat/apply', token, msisdn, { body: '' });
}

function getOoredooAccountInfo({ token, msisdn }) {
  return bffRequest('GET', '/api/ooredoo-bff/bundle/getActivePackages', token, msisdn);
}

function getOoredooUserInfo({ token, msisdn }) {
  return bffRequest('GET', '/api/ooredoo-bff/userInfo/personal', token, msisdn, {
    extraHeaders: { 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8' },
  });
}

function purchaseOoredooByop({ token, msisdn, code }) {
  const isLimited = BYOP_LIMITED_CODES.includes(code);
  return bffRequest('POST', '/api/ooredoo-bff/bundle/purchase/byop', token, msisdn, {
    body: JSON.stringify({
      validity: BYOP_VALIDITY,
      limitedBundleDetails: isLimited ? [code] : [],
      unlimitedBundleDetails: isLimited ? [] : [code],
    }),
  });
}

// ---------------------------------------------------------------------------
// 13) Facebook Messenger
// ---------------------------------------------------------------------------
async function sendMessage(senderPsid, response) {
  if (!FACEBOOK_PAGE_ACCESS_TOKEN) {
    console.error('❌ sendMessage: FACEBOOK_PAGE_ACCESS_TOKEN غير معرّف في config');
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v17.0/me/messages?access_token=${FACEBOOK_PAGE_ACCESS_TOKEN}`,
      { recipient: { id: senderPsid }, message: response }
    );
  } catch (error) {
    console.error('❌ خطأ في sendMessage:', error.response?.data || error.message);
  }
}

// ---------------------------------------------------------------------------
// 14) تهيئة البروكسي عند بدء التشغيل + التصدير
// ---------------------------------------------------------------------------
setupDbProxy().catch(console.error);

module.exports = {
  sendOoredooVerificationCode,
  verifyOoredooCode,
  refreshOoredooToken,
  getOoredooGamificationStatus,
  getOoredooGamificationHistory,
  playOoredooGamification,
  checkOoredooSnapchatEligibility,
  applyOoredooSnapchat,
  getOoredooAccountInfo,
  getOoredooUserInfo,
  purchaseOoredooByop,
  BYOP_CODES,
  BYOP_LIMITED_CODES,
  sendMessage,
  setupDbProxy,
};
