// نقطة دخول الـ Worker — webhook فيسبوك + فحص توقيع + بوابة فيض + تنظيف دوري
import { createBot } from './bot.js';
import { createDjezzy } from './services/djezzy.js';
import { createOoredoo } from './services/ooredoo.js';
import { createMessenger } from './messenger.js';
import { getLoadGuard } from './loadGuard.js';

// مخزن السجلات الأخيرة في الذاكرة (يُقرأ عبر /debuglogs عند الحاجة)
const ringLog = [];
function ring(...args) {
  try {
    const line = new Date().toISOString() + ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    ringLog.push(line);
    if (ringLog.length > 300) ringLog.splice(0, ringLog.length - 300);
  } catch {}
}
const origConsole = { log: console.log.bind(console), error: console.error.bind(console) };
console.log = (...args) => { try { ring(...args); } catch {} origConsole.log(...args); };
console.error = (...args) => { try { ring('[ERR]', ...args); } catch {} origConsole.error(...args); };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- تشخيص محمي (للتجريب فقط): يتطلب رأس x-diag-key === DIAG_KEY ----------
    if (request.method === 'POST' && url.pathname === '/_diag/socket') {
      if (!env.DIAG_KEY || request.headers.get('x-diag-key') !== env.DIAG_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      try {
        const { default: net } = await import('node:net');
        const out = await new Promise((resolve) => {
          const socket = net.connect({ host: body.host || 'gw.dataimpulse.com', port: Number(body.port || 823) });
          let acc = Buffer.alloc(0);
          const to = setTimeout(() => { try { socket.destroy(); } catch {}; resolve(''); }, 10000);
          socket.on('connect', () => socket.write('GET http://apim.djezzy.dz/ HTTP/1.1\r\nHost: apim.djezzy.dz\r\nConnection: close\r\n\r\n'));
          socket.on('data', (c) => { acc = Buffer.concat([acc, c]); });
          socket.on('end', () => { clearTimeout(to); resolve(acc.toString('utf8')); });
          socket.on('error', () => { clearTimeout(to); try { socket.destroy(); } catch {}; resolve(''); });
        });
        const line = out.split('\r\n')[0];
        return new Response(JSON.stringify({ ok: true, statusLine: line, head: out.slice(0, 120) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message || String(e) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (request.method === 'POST' && url.pathname === '/_diag/otp') {
      if (!env.DIAG_KEY || request.headers.get('x-diag-key') !== env.DIAG_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      const target = body.target || 'ooredoo-otp';
      console.log('[diag] target =', target, 'phone =', String(body.phone || ''));
      const phone = String(body.phone || '0550000000');
      let res;
      if (target === 'djezzy') {
        res = await createDjezzy(env).sendVerificationCode(phone);
      } else if (target === 'djezzy-raw') {
        // إعادة إنتاج كامل لصيغة الكود القديم (URLSearchParams + رؤوس axios)
        const clientId = env.DJEZZY_CLIENT_ID;
        const msisdn = `213${String(phone).replace(/^0/, '')}`;
        const bodyObj = new URLSearchParams({ msisdn, client_id: clientId, scope: 'smsotp' });
        const mode = body.mode || 'post';
        const url = mode === 'get'
          ? `https://apim.djezzy.dz/` // GET بلا أي جسم — أصفى اختبار لطبيعة الحجب
          : 'https://apim.djezzy.dz/oauth2/registration';
        const useFullHeaders = body.fullHeaders !== false;
        const headers = {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Djezzy/2.6.7',
          ...(useFullHeaders
            ? {
                Accept: 'application/json, text/plain, */*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
              }
            : {}),
        };
        const r = await fetch(url, {
          method: mode === 'get' ? 'GET' : 'POST',
          headers,
          body: mode === 'get' ? undefined : bodyObj.toString(),
        });
        const text = await r.text();
        res = { statusCode: r.status, data: { mode, rawStatus: r.status, rawBody: text.slice(0, 200) } };
      } else if (target === 'djezzy-proxy') {
        // الاستجابة الخام عبر البروكسي المشترك (نفس مسار djezzy.js لكن بدون normalize)
        const { httpRequest } = await import('./services/http.js');
        const clientId = env.DJEZZY_CLIENT_ID;
        const msisdn = `213${String(phone).replace(/^0/, '')}`;
        const form = new URLSearchParams({ msisdn, client_id: clientId, scope: 'smsotp' }).toString();
        const r = await httpRequest(env, {
          method: 'POST',
          url: 'https://apim.djezzy.dz/oauth2/registration',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Djezzy/2.6.7' },
          body: form,
          useDbProxy: true,
          timeoutMs: 60000,
        });
        res = {
          statusCode: r.status || (r.error ? 599 : 500),
          data: { via: r.via, rawStatus: r.status, rawBody: String(r.text || r.body || '').slice(0, 300), error: r.error || null },
        };
      } else if (target === 'proxy-ip') {
        // فحص بلد/عنوان الـ exit عبر البروكسي (لتأكيد استهداف الجزائر)
        const { httpRequest } = await import('./services/http.js');
        const r = await httpRequest(env, {
          method: 'GET',
          url: body.ipUrl || 'http://ip-api.com/json',
          useDbProxy: true,
          proxyService: body.service || 'shared',
          timeoutMs: 60000,
        });
        res = { statusCode: r.status || 500, data: { via: r.via, ip: r.text || r.data, error: r.error || null } };
      } else if (target === 'proxy-trace') {
        const { default: proxyRequest } = await import('./services/proxy.js');
        const targetUrl = body.ipUrl || 'http://ip-api.com/json';
        const method = body.method || 'GET';
        const r = await proxyRequest(env, {
          method,
          url: targetUrl,
          headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Djezzy/2.6.7' },
          body: method === 'GET' ? undefined : new URLSearchParams({ msisdn: '213778830644', client_id: '87pIExRhxBb3_wGsA5eSEfyATloa', scope: 'smsotp' }).toString(),
          service: body.service || 'djezzy',
        }, 30000);
        res = { statusCode: r.status || 599, data: { via: r.via, status: r.status, text: String(r.text || '').slice(0, 400), error: r.error || null } };
      } else if (target === 'proxy-direct') {
        // استدعاء proxyRequest مباشرة (بدون سقوط) لرؤية خطأ البروكسي الحقيقي
        const { default: proxyRequest } = await import('./services/proxy.js');
        const clientId = '6E6CwTkp8H1CyQxraPmcEJPQ7xka';
        const msisdn = `213${String(phone).replace(/^0/, '')}`;
        const form = new URLSearchParams({ msisdn, client_id: clientId, scope: 'smsotp' }).toString();
        const targetUrl = body.ipUrl || 'https://apim.djezzy.dz/oauth2/registration';
        const method = body.method || 'POST';
        const r = await proxyRequest(env, {
          method,
          url: targetUrl,
          headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Djezzy/2.6.7' },
          body: method === 'GET' ? undefined : form,
          service: body.service || 'djezzy',
        }, 25000);
        res = { statusCode: r.status || 599, data: { via: r.via, status: r.status, error: r.error || null, body: String(r.text || '').slice(0, 200) } };
      } else if (target === 'ooredoo-info') {
        // فحص userInfo + getActivePackages كما يستدعيهما البوت بالضبط
        const ooredoo = createOoredoo(env);
        const msisdn = String(body.msisdn || '213558293697');
        const token = String(body.token || '');
        const [ui, pk] = await Promise.all([
          ooredoo.userInfo({ token, msisdn }).catch(() => ({ statusCode: 0, data: null })),
          ooredoo.accountInfo({ token, msisdn }),
        ]);
        res = {
          statusCode: pk.statusCode,
          data: {
            userInfoStatus: ui.statusCode,
            userInfoData: ui.data && typeof ui.data === 'object' ? { ratePlan: ui.data.ratePlan, startDate: ui.data.startDate, blocked: ui.data.blocked, message: ui.data.message } : ui.data,
            packagesStatus: pk.statusCode,
            planName: pk.data?.planName,
            planCode: pk.data?.planCode,
            blocked: pk.data?.blocked,
          },
        };
      } else if (target === 'ooredoo-verify') {
        // تحقق من رمز OTP — نجاح = 200 مع access_token (عكس إرسال الرمز الذي يكون 403)
        res = await createOoredoo(env).verifyCode(phone, String(body.code || ''));
      } else if (target === 'djezzy-v2') {
        // نفس ما يستخدمه البوت حالياً: sendVerificationCodeV2 (mobile-api/oauth2/registration, UA 3.0.7)
        res = await createDjezzy(env).sendVerificationCodeV2(phone);
      } else if (target === 'djezzy-v2-mobile') {
        // مسار بديل مقترح: oauth2 على جذر apim (كما V1) لكن UA 3.0.7
        const { httpRequest } = await import('./services/http.js');
        const msisdn = `213${String(phone).replace(/^0/, '')}`;
        const form = new URLSearchParams({ msisdn, client_id: env.DJEZZY_CLIENT_ID, scope: 'smsotp' }).toString();
        const r = await httpRequest(env, {
          method: 'POST',
          url: 'https://apim.djezzy.dz/oauth2/registration',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Djezzy/3.0.7' },
          body: form,
          useDbProxy: true,
          proxyService: 'djezzy',
          timeoutMs: 60000,
          relayKey: 'DJEZZY_RELAY_URL',
        });
        res = { statusCode: r.status || 500, data: { via: r.via, rawStatus: r.status, rawBody: String(r.text || r.body || '').slice(0, 300), error: r.error || null } };
      } else {
        res = await createOoredoo(env).sendVerificationCode(phone);
      }
      return new Response(JSON.stringify({ statusCode: res.statusCode, data: res.data, error: res.error || null }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---------- التحقق من webhook (وضع الاشتراك) ----------
    if (request.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      const expected = env.VERIFY_TOKEN || '123123123';
      if (mode === 'subscribe' && token === expected) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    // ---------- فحص صحي (اختياري للمراقبة) ----------
    if (request.method === 'GET' && url.pathname === '/health') {
      const dbBackend = env.DB?.backend || 'none';
      const data = {
        ok: true,
        db: dbBackend,
        hasDatabaseUrl: /^postgres(ql)?:\/\//i.test(env.DATABASE_URL || ''),
        git: process.env.RENDER_GIT_COMMIT || env.RENDER_GIT_COMMIT || null,
        deployedAt: new Date().toISOString(),
      };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---------- آخر السجلات (مخزن في الذاكرة) للتمييز بين حجب/خطأ ----------
    if (request.method === 'GET' && url.pathname === '/debuglogs') {
      const key = request.headers.get('x-diag-key') || url.searchParams.get('key');
      if (!env.DIAG_KEY || key !== env.DIAG_KEY) return new Response('Forbidden', { status: 403 });
      return new Response(JSON.stringify({ lines: ringLog.slice(-80) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---------- فحص الـ relays من داخل الخادم (عام: يكشف القائمة الفعلية + حالة كل relay) ----------
    if (request.method === 'GET' && url.pathname === '/relay-check') {
      const primary = env.OOREDOO_RELAY_URL || '';
      const rawList = env.OOREDOO_RELAY_URL_LIST || '';
      const list = rawList.split(',').map((s) => s.trim()).filter(Boolean);
      const entries = [];
      for (const u of [primary, ...list]) {
        if (!u) continue;
        let out = { url: u, ok: false };
        try {
          const r = await fetch(u + '/ip', { signal: AbortSignal.timeout(20000) });
          const j = await r.json().catch(() => null);
          out = { url: u, ok: r.ok, status: r.status, asn: (j && j.asn) || null };
        } catch (e) {
          out = { url: u, ok: false, error: (e && e.message) || String(e) };
        }
        entries.push(out);
      }
      return new Response(JSON.stringify({
        relaySecretSet: !!env.RELAY_SECRET,
        primary,
        rawList,
        list,
        count: entries.length,
        entries,
        db: env.DB?.backend || 'none',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ---------- إرسال OTP تشخيصي عبر نفس مسار البوت من داخل الخادم (DIAG_KEY) ----------
    // يرجع أين خرج الطلب فعلياً + ما رده أوريدو — للتمييز بين «حظر IP» و«رقم محجوب».
    if (request.method === 'POST' && url.pathname === '/_diag/relay-otp') {
      if (!env.DIAG_KEY || request.headers.get('x-diag-key') !== env.DIAG_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      const phone = String(body.phone || '0550000000');
      const primary = env.OOREDOO_RELAY_URL || '';
      const list = (env.OOREDOO_RELAY_URL_LIST || '').split(',').map((s) => s.trim()).filter(Boolean);
      const relayEntries = [];
      for (const u of [primary, ...list]) {
        if (!u) continue;
        let out = { url: u, ok: false };
        try {
          const r = await fetch(u + '/ip', { signal: AbortSignal.timeout(20000) });
          const j = await r.json().catch(() => null);
          out = { url: u, ok: r.ok, status: r.status, asn: (j && j.asn) || null };
        } catch (e) {
          out = { url: u, ok: false, error: (e && e.message) || String(e) };
        }
        relayEntries.push(out);
      }
      const t0 = Date.now();
      let res;
      try {
        res = await createOoredoo(env).sendVerificationCode(phone);
      } catch (e) {
        res = { statusCode: 500, data: { message: 'exception: ' + (e && e.message || e) } };
      }
      const ua = Math.round(Date.now() - t0);
      const resData = res && res.data && typeof res.data === 'object'
        ? { message: res.data.message || null, blocked: res.data.blocked || null, keys: Object.keys(res.data).slice(0, 12) }
        : { raw: String(res && res.data).slice(0, 250) };
      return new Response(JSON.stringify({
        phone,
        ok: res && res.statusCode === 200,
        statusCode: res && res.statusCode,
        via: res && res.via,
        text: String(res && (res.text || (res.data && res.data.message) || '')).slice(0, 300),
        data: resData,
        elapsedMs: ua,
        relayCount: relayEntries.length,
        relayEntries,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ---------- اختبار بروكسيات DB لأوريدو مباشرة (بدون relay) ----------
    // يذهب من الخادم إلى بروكسي DB (ooredoo) ثم إلى apis.ooredoo.dz
    // ويرجع الرد الخام — لنرى هل البروكسي يصل فعلاً لأوريدو (عنوان DZ) أم ميت.
    if (request.method === 'GET' && url.pathname === '/_diag/dbproxy-check') {
      const key = request.headers.get('x-diag-key') || url.searchParams.get('key');
      if (!env.DIAG_KEY || key !== env.DIAG_KEY) return new Response('Forbidden', { status: 403 });
      const { httpRequest } = await import('./services/http.js');
      const { default: proxyRequest } = await import('./services/proxy.js');
      const probeUrl = 'https://apis.ooredoo.dz/my_ooredoo/rest/v1/users/self';
      let out = { mode: 'httpRequest-ooredoo' };
      try {
        const r = await httpRequest(env, {
          method: 'GET',
          url: probeUrl,
          headers: { 'User-Agent': 'Dart/3.4 (dart:io)', Accept: '*/*' },
          relayKey: 'OOREDOO_RELAY_URL',
          useDbProxy: true,
          proxyService: 'ooredoo',
          timeoutMs: 45000,
          directFirst: false,
        });
        out.status = r.status;
        out.via = r.via;
        out.error = r.error || null;
        out.text = String(r.text || (r.data && typeof r.data === 'string' && r.data) || '').slice(0, 300);
      } catch (e) {
        out.error = 'httpRequest threw: ' + (e && e.message || e);
      }
      let out2 = { mode: 'proxyRequest-ooredoo' };
      try {
        const r2 = await proxyRequest(env, { method: 'GET', url: probeUrl, headers: { 'User-Agent': 'Dart/3.4 (dart:io)', Accept: '*/*' }, service: 'ooredoo' }, 45000);
        out2.status = r2.status;
        out2.via = r2.via;
        out2.error = r2.error || null;
        out2.text = String(r2.text || '').slice(0, 300);
      } catch (e) {
        out2.error = 'proxyRequest threw: ' + (e && e.message || e);
      }
      return new Response(JSON.stringify({ direct: out, proxy2: out2 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ---------- إحصائيات نظام الضغط (محمي بـ DIAG_KEY) ----------
    if (request.method === 'GET' && url.pathname === '/_diag/load') {
      const key = request.headers.get('x-diag-key') || url.searchParams.get('key');
      if (!env.DIAG_KEY || key !== env.DIAG_KEY) return new Response('Forbidden', { status: 403 });
      const otpD = getLoadGuard('otp-djezzy', env).getStats();
      const otpO = getLoadGuard('otp-ooredoo', env).getStats();
      const wb = getLoadGuard('webhook', env).getStats();
      return new Response(JSON.stringify({ djezzy: otpD, ooredoo: otpO, webhook: wb }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ---------- تشخيص شامل (محمي بـ DIAG_KEY) ----------
    if (request.method === 'GET' && url.pathname === '/debug') {
      const diagKey = env.DIAG_KEY || 'bzfbdz-debug-2026';
      if (url.searchParams.get('key') !== diagKey) {
        return new Response('Forbidden', { status: 403 });
      }
      const token = env.PAGE_ACCESS_TOKEN || '';
      const info = {
        tokenSet: !!token,
        tokenLen: token.length,
        tokenPrefix: token.slice(0, 10) + '...',
        verifyToken: env.VERIFY_TOKEN || '(missing)',
        pageAppSecretSet: !!env.PAGE_APP_SECRET,
        d1Binding: !!env.DB,
        djezzyClientId: !!env.DJEZZY_CLIENT_ID,
        ooredooClientId: !!env.OOREDOO_CLIENT_ID,
        region: env.CF_REGION || '(unknown)',
      };
      try {
        if (env.DB) {
          const row = await env.DB.prepare('SELECT COUNT(*) as cnt FROM sessions').first();
          info.sessionsCount = row?.cnt ?? '?';
        }
      } catch (e) {
        info.sessionsCount = 'error: ' + e.message;
      }
      return new Response(JSON.stringify(info, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // ---------- اختبار استدعاء Djezzy عبر البروكسي ----------
    if (request.method === 'POST' && url.pathname === '/_diag/djezzy-call') {
      if (!env.DIAG_KEY || request.headers.get('x-diag-key') !== env.DIAG_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      const { httpRequest } = await import('./services/http.js');
      const body = await request.json().catch(() => ({}));
      const res = await httpRequest(env, {
        method: body.method || 'POST',
        url: body.url,
        headers: body.headers || {},
        body: body.body ? JSON.stringify(body.body) : undefined,
        relayKey: body.relayKey || 'DJEZZY_RELAY_URL',
        useDbProxy: true,
        proxyService: 'djezzy',
        timeoutMs: 30000
      }).catch(e => ({ status: 0, data: null, error: e.message }));
      return new Response(JSON.stringify(res, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // ---------- اختبار إرسال رسالة فيسبوك ----------
    if (request.method === 'GET' && url.pathname === '/test-send') {
      const testPsid = url.searchParams.get('psid');
      if (!testPsid) return new Response('Give ?psid=PSID', { status: 400 });
      const messenger = createMessenger(env);
      const res = await messenger.callSend(testPsid, { text: '🔧 اختبار البوت — البوت يعمل!' });
      return new Response(JSON.stringify({ status: res }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ---------- استخراج توكنات مستخدم للمحاكي ----------
    if (request.method === 'GET' && url.pathname === '/_diag/tokens') {
      if (!env.DIAG_KEY || url.searchParams.get('key') !== env.DIAG_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      const phone = url.searchParams.get('phone');
      if (!phone) return new Response('Give ?phone=NUMBER&key=DIAG_KEY', { status: 400 });
      const row = await env.DB.prepare('SELECT phoneNumber, access_token, refresh_token, operator, chat_id, updated_at FROM users WHERE phoneNumber = ?').bind(phone).first();
      if (!row) return new Response(JSON.stringify({ error: 'User not found' }), { headers: { 'Content-Type': 'application/json' }, status: 404 });
      return new Response(JSON.stringify(row, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }

    // ---------- استقبال أحداث Messenger ----------
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const rawBody = await request.text();
      console.log('[webhook] POST received, len=' + rawBody.length);
      const _whT0 = Date.now();

      // التحقق من توقيع X-Hub-Signature-256 إن وُضع PAGE_APP_SECRET
      // (يمنع إرسال أحداث مزيفة من الخارج = توفير طلبات وتكلفة)
      if (env.PAGE_APP_SECRET) {
        const signature = request.headers.get('X-Hub-Signature-256') || '';
        const expected = await hmacSha256Hex(env.PAGE_APP_SECRET, rawBody);
        if (!signature || !safeEqual(signature, `sha256=${expected}`)) {
          console.log('[webhook] BAD signature');
          return new Response('Invalid signature', { status: 401 });
        }
        console.log('[webhook] signature OK');
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        console.log('[webhook] bad JSON');
        return new Response('Bad request', { status: 400 });
      }

      // البوت ينشئ messenger فيسبوك المناسب داخليًا (لا حاجة لأي ربط يدوي)
      const bot = createBot(env, ctx, 'fb');

      // قرأة فورية: نُعلِم فيسبوك بأن المستخدم "شوهد" فورًا بدون انتظار DB أو الطابور،
      // فلا يبقى السؤال "غير مقروء" فترة طويلة أثناء المعالجة/الانتظار.
      const seenTargets = new Set();
      for (const e of body?.entry || []) {
        for (const m of e.messaging || []) {
          const s = m?.sender?.id;
          if (s && ((m.message && !m.message.is_echo) || m.postback)) seenTargets.add(s);
        }
      }
      for (const s of seenTargets) bot.markSeenFb(s).catch(() => {});
      seenTargets.clear();

      // نرد 200 فورًا لفيسبوك ثم نعالج في الخلفية مباشرة (بدون طابور):
      // أي طابور كان يعلّق الرسائل النصية خلف مهام OTP البطيئة (15-30 ثانية)
      // فيصل الرد متأخرًا. المعالجة الفورية = رد فوري لكل رسالة، والحماية
      // الحقيقية تبقى داخل حارس OTP نفسه (تزامن محدود للاستدعاءات الخارجية).
      const runBg = async () => {
        try {
          await bot.process(body);
        } catch (e2) {
          console.log('[webhook] processing error:', e2.message);
        }
      };
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(runBg());
      else runBg();
      const _whDt = Date.now() - _whT0;
      if (_whDt > 100) console.log(`[perf-wh] webhook accepted in ${_whDt}ms (direct)`);
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },

  // تنظيف دوري يومي (يُشغَّل عبر crons في wrangler.toml)
  async scheduled(event, env, ctx) {
    await maintenance(env);
  },
};

// ---------------------------------------------------------------------------
async function hmacSha256Hex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function maintenance(env) {
  try {
    const now = Date.now();
    // حذف المهل المنتهية والعدادات القديمة (تخفيض حجم D1 والتكلفة)
    await env.DB.prepare('DELETE FROM cooldowns WHERE until > 0 AND until < ?')
      .bind(now - 60 * 60 * 1000) // احتفظ بساعة واحدة احتياطًا
      .run();
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(now - 7 * 24 * 60 * 60 * 1000)
      .run();
    // حذف الجلسات القديمة (أكثر من 30 يومًا)
    await env.DB.prepare('DELETE FROM sessions WHERE updated_at < ?')
      .bind(now - 30 * 24 * 60 * 60 * 1000)
      .run();
    // تنظيف سجل الطلبات دائمًا (يشمل صفوف التشخيص diag:*) باحتفاظ 14 يومًا
    await env.DB.prepare('DELETE FROM request_logs WHERE created_at < ?')
      .bind(now - 14 * 24 * 60 * 60 * 1000)
      .run();
  } catch (e) {
    console.error('[maintenance]', e.message);
  }
}
