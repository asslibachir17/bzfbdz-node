// ig-index.js — Instagram Worker entry point (webhook) — same D1 as FB/TG
import { createBot } from './bot.js';

function getGraphApi(token) {
  return (token || '').startsWith('IGAA')
    ? 'https://graph.instagram.com'
    : 'https://graph.facebook.com/v19.0';
}

async function igFetch(env, method, body) {
  try {
    const token = env.IG_PAGE_ACCESS_TOKEN || env.PAGE_ACCESS_TOKEN;
    const pageId = env.IG_PAGE_ID;
    const graphApi = getGraphApi(token);
    const res = await fetch(`${graphApi}/${pageId}/${method}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json().catch(() => null);
  } catch (e) {
    console.error('[IG]', method, e.message);
    return null;
  }
}

async function handleWebhookEvent(body, env, ctx) {
  try {
    const entries = body.entry || [];
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const evt of messaging) {
        const senderId = evt.sender?.id;
        if (!senderId) continue;

        const igSid = `ig${senderId}`;

        let botEvent = null;

        if (evt.message) {
          const msgText = evt.message?.text || '';
          const isEcho = evt.message?.is_echo;
          if (isEcho) continue;

          botEvent = {
            sender: { id: igSid },
            message: { text: msgText },
          };
        } else if (evt.postback) {
          botEvent = {
            sender: { id: igSid },
            postback: {
              payload: evt.postback?.payload || '',
              title: evt.postback?.title || '',
            },
          };
        }

        if (!botEvent) continue;

        const bot = createBot(env, ctx, 'ig');

        ctx.waitUntil(bot.process({ object: 'page', entry: [{ messaging: [botEvent] }] }));
      }
    }
  } catch (e) {
    console.error('[IG] خطأ في معالجة الأحداث:', e.message, e.stack);
  }
}

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
    await env.DB.prepare('DELETE FROM cooldowns WHERE until > 0 AND until < ?')
      .bind(now - 60 * 60 * 1000).run();
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
      .bind(now - 7 * 24 * 60 * 60 * 1000).run();
    await env.DB.prepare('DELETE FROM sessions WHERE updated_at < ?')
      .bind(now - 30 * 24 * 60 * 60 * 1000).run();
    await env.DB.prepare('DELETE FROM request_logs WHERE created_at < ?')
      .bind(now - 14 * 24 * 60 * 60 * 1000).run();
  } catch (e) {
    console.error('[maintenance]', e.message);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook verification (GET)
    if (request.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === env.VERIFY_TOKEN) {
        return new Response(challenge, { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    // Debug
    if (request.method === 'GET' && url.pathname === '/debug') {
      if (!env.DIAG_KEY || url.searchParams.get('key') !== env.DIAG_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      const token = env.IG_PAGE_ACCESS_TOKEN || env.PAGE_ACCESS_TOKEN || '';
      const info = {
        tokenSet: !!token,
        tokenLen: token.length,
        tokenPrefix: token.slice(0, 10) + '...',
        pageId: env.IG_PAGE_ID || '(missing)',
        verifyToken: env.VERIFY_TOKEN || '(missing)',
        d1Binding: !!env.DB,
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

    // Subscribe IG account to webhook events
    if (request.method === 'GET' && url.pathname === '/subscribe') {
      const token = env.IG_PAGE_ACCESS_TOKEN || env.PAGE_ACCESS_TOKEN;
      const pageId = env.IG_PAGE_ID;
      if (!token || !pageId) return new Response('Missing token or pageId', { status: 500 });
      const graphApi = getGraphApi(token);
      const res = await fetch(`${graphApi}/${pageId}/subscribed_apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscribed_fields: 'messages,messaging_postbacks,messaging_referral' }),
      });
      const json = await res.json().catch(() => null);
      return new Response(JSON.stringify({ status: res.status, result: json }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Test send
    if (request.method === 'GET' && url.pathname === '/test-send') {
      const testId = url.searchParams.get('igsid');
      if (!testId) return new Response('Give ?igsid=IGSID', { status: 400 });
      const { createInstagram } = await import('./instagram.js');
      const ig = createInstagram(env);
      const res = await ig.callSend(testId, { text: '🔧 اختبار بوت Instagram — البوت يعمل!' });
      return new Response(JSON.stringify({ status: res }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Webhook events (POST)
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const rawBody = await request.text();
      console.log('[IG webhook] POST received, len=' + rawBody.length);

      if (env.IG_APP_SECRET) {
        const signature = request.headers.get('X-Hub-Signature-256') || '';
        const expected = await hmacSha256Hex(env.IG_APP_SECRET, rawBody);
        if (!signature || !safeEqual(signature, `sha256=${expected}`)) {
          console.log('[IG webhook] BAD signature');
          return new Response('Invalid signature', { status: 401 });
        }
      }

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return new Response('Bad request', { status: 400 });
      }

      ctx.waitUntil(handleWebhookEvent(body, env, ctx));
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await maintenance(env);
  },
};
