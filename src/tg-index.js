// tg-index.js — نقطة دخول Worker تلغرام (webhook) — نفس D1 ومتغيرات Worker فيسبوك
import { createBot } from './bot.js';
import { createTelegram } from './telegram.js';
import { createDjezzy } from './services/djezzy.js';

const TG_API = 'https://api.telegram.org/bot';

// ---------- اشتراك إجباري ----------
// القناة المطلوب الاشتراك فيها قبل أي استخدام (غيّر الاسم والرابط هنا)
const REQUIRED_CHANNEL = '@bachir_tech';
const REQUIRED_CHANNEL_LINK = 'https://t.me/bachir_tech';
const BOT_START_LINK = 'https://t.me/BZeroXBot?start=start';

// تذكّر أن رسالة الاشتراك أُرسلت لهذا المستخدم (لا نُرسلها في كل رسالة؛ نعيد التذكير كل فترة)
const gateSentTo = new Map(); // userId -> ts آخر إرسال
const GATE_REMINDER_MS = 10 * 60 * 1000;

async function tgFetch(env, method, body) {
  try {
    const res = await fetch(`${TG_API}${env.TG_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json().catch(() => null);
  } catch (e) {
    console.error('[TG]', method, e.message);
    return null;
  }
}

// فحص فوري ومباشر لعضوية القناة (بدون كاش حتى يُكتشف فورًا أي خروج لاحق من القناة)
async function isChannelMember(env, userId) {
  try {
    const data = await tgFetch(env, 'getChatMember', { chat_id: REQUIRED_CHANNEL, user_id: userId });
    const status = data?.result?.status;
    return ['member', 'administrator', 'creator'].includes(status);
  } catch (e) {
    console.error('[TG] فشل فحص الاشتراك:', e.message);
    return false;
  }
}

// إرسال رسالة الاشتراك لغير المشترك (مع تذكير كل فترة بدل إرسالها في كل رسالة)
async function sendSubscribeGate(env, chatId, userId) {
  const last = userId && gateSentTo.get(userId);
  if (last && Date.now() - last < GATE_REMINDER_MS) return false;
  if (userId) gateSentTo.set(userId, Date.now());
  await tgFetch(env, 'sendMessage', {
    chat_id: chatId,
    text: `🔒 لا يمكنك استخدام هذا البوت قبل الاشتراك في القناة:\n${REQUIRED_CHANNEL.replace('_', '\\_')}`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: '✅ الاشتراك في القناة', url: REQUIRED_CHANNEL_LINK }]],
    },
  });
  return true;
}

// معالجة تحديث واحد في الخلفية (بعد الرد على تلغرام بـ 200)
async function handleUpdate(body, env, ctx) {
  try {
    const tg = createTelegram(env);
    const ev = tg.toBotEvent(body);
    if (!ev) return;

    const msg = body.message || {};
    const cq = body.callback_query || {};
    const userId = cq?.from?.id || msg?.from?.id;
    const chatId = cq?.message?.chat?.id || msg?.chat?.id;
    const chatType = cq?.message?.chat?.type || msg?.chat?.type || '';
    const text = (msg?.text || '').trim();
    const firstName = msg?.from?.first_name || '';

    // ---------- المجموعات: زر لفتح البوت خاصًا (نفس نص الكود القديم) ----------
    // تُرسل فقط عندما يُرسل المستخدم أمرًا من أوامر البوت أو رقم هاتف — لا رد على أي كلام آخر
    const isBotCommand = /^\/[a-zA-Z_]+/.test(text);
    const isPhoneNumber = /^0[5-7]\d{8}$/.test(text) || /^(213|00213)[5-7]\d{8}$/.test(text);
    if (chatType === 'group' || chatType === 'supergroup') {
      // لا رد إطلاقًا في المجموعات إلا على أمر بوت أو رقم هاتف
      if (isBotCommand || isPhoneNumber) {
        await tgFetch(env, 'sendMessage', {
          chat_id: chatId,
          text: `مرحــبـا *${firstName}* 👋،\n\nلإستخدام البوت، إضغط على الزر الموجود في الأسفل ⬇️✅`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: 'بزيرو بوت - BZero Bot', url: BOT_START_LINK }]] },
        });
      }
      return;
    }

    // ---------- أمر /start: ترحيب + فحص اشتراك ----------
    if (text.startsWith('/start')) {
      if (!(await isChannelMember(env, userId))) {
        await sendSubscribeGate(env, chatId, userId);
        return;
      }
      await tgFetch(env, 'sendMessage', {
        chat_id: chatId,
        text:
          `السلام عليكم 👋🏼, ${firstName}\n\n` +
          `🤖 بوت *BZero* يقدم لك :\n` +
          `تفعيل 2 جيغا و الهدية اليومية وبعض العروض الأخرى لشرائح جزائرية 🇩🇿.\n\n` +
          `⚡️ *لبدء الاستخدام:* ⬇️\n` +
          `1️⃣ أرسل *رقم هاتفك* 📱\n` +
          `2️⃣ أرسل *رمز التفعيل* المستلم في الرسائل 📩\n` +
          `3️⃣ اختر *الخدمة المناسبة* ✅`,
        parse_mode: 'Markdown',
      });
      // رسالة ثانية تطلب الرقم مباشرة (نفس سلوك الكود القديم)
      await tgFetch(env, 'sendMessage', {
        chat_id: chatId,
        text: `📱 يرجى إدخال رقم هاتفك:`,
        parse_mode: 'Markdown',
      });
      return;
    }

    // ---------- أمر /terms_of_use: شروط الاستخدام ----------
    if (text.startsWith('/terms_of_use')) {
      const message =
        `⚙️ شروط استخدام بوت BZero\n\n` +
        `🔹 *1. عدم مشاركة البيانات الشخصية:*  \n` +
        `نحن غير مسؤولين عن أي ضرر ناتج عن مشاركة رقم الهاتف أو رمز التفعيل مع أي جهة غير رسمية.\n\n` +
        `🔹 *2. لا نقدم هدايا أو عروض مباشرة:*  \n` +
        `بوت BZero لا يفعّل العروض بشكل مباشر. يمكنكم دائمًا استخدام التطبيقات الرسمية\n\n` +
        `🔹 *3. الحظر الفوري للمخالفات:*  \n` +
        `أي محاولة للتحايل أو إساءة استخدام البوت ستؤدي إلى الحظر الفوري.\n\n` +
        `🔹 *4. نحتفظ بحق الحظر في أي وقت:*  \n` +
        `لدينا كامل الصلاحية في حظر أي مستخدم يخل بشروط الاستخدام.\n\n` +
        `🔹 *5. الحظر المؤقت بسبب الرسائل المتكررة:*  \n` +
        `إرسال رسائل متتالية دون داعٍ قد يؤدي إلى حظر مؤقت.\n\n` +
        `🔹 *6. احترام الخصوصية:*  \n` +
        `هوية المستخدم تبقى سرية تمامًا ولا يتم مشاركتها مع أي جهة كانت.`;
      await tgFetch(env, 'sendMessage', { chat_id: chatId, text: message, parse_mode: 'Markdown' });
      return;
    }

    // ---------- أمر /contact: التواصل مع المطور ----------
    if (text.startsWith('/contact')) {
      const devMessage =
        `👨‍💻 *مطور بوت BZero*\n\n` +
        `📌 هل لديك مشكلة، استفسار، أو اقتراح?  \n` +
        `لا تتردد في التواصل معي مباشرة.\n\n` +
        `🔒 *ملاحظة:* جميع المحادثات يتم التعامل معها بسرية تامة.`;
      await tgFetch(env, 'sendMessage', {
        chat_id: chatId,
        text: devMessage,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '📨 تواصل مع المطور', url: 'https://t.me/BZeroContactBot' }]],
        },
      });
      return;
    }

    // ---------- اشتراك إجباري: رسالة اشتراك لغير المشتركين ----------
    // (لا معالجة لأي أمر قبل الاشتراك؛ تُرسل رسالة الاشتراك مع تذكير كل فترة)
    if (userId && chatId) {
      if (!(await isChannelMember(env, userId))) {
        if (cq.id) await tg.answerCallback(cq.id);
        tg.clearEditTarget(chatId); // نُلغي أي هدف تعديل معلّق قبل الحجب
        await sendSubscribeGate(env, chatId, userId);
        return;
      }
    }

    // البوت ينشئ messenger تلغرام المناسب داخليًا (لا حاجة لأي ربط يدوي)
    const bot = createBot(env, ctx, 'tg');

    // بوابة الفيض (نفس منطق فيسبوك)
    if (!bot.floodGate({ object: 'page', entry: [{ messaging: [ev] }] })) {
      return;
    }

    // المعالجة الكاملة (قد تستغرق وقتًا، لكننا ردّدنا على تلغرام مسبقًا)
    await bot.process({ object: 'page', entry: [{ messaging: [ev] }] });

    // إجابة استعلام الزر (إن كان)
    if (ev.callbackQueryId) await tg.answerCallback(ev.callbackQueryId);
  } catch (e) {
    console.error('[TG] خطأ في معالجة التحديث:', e && e.stack ? e.stack : e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- تشخيص مؤقت (يُحذف بعد الانتهاء): استكشاف مسارات /mobile-api للتفعيل ----------
    if (request.method === 'POST' && url.pathname === '/_diag/v2') {
      if (!env.DIAG_KEY || request.headers.get('x-diag-key') !== env.DIAG_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      const body = await request.json().catch(() => ({}));
      const phoneRaw = String(body.phone || '').trim();
      const phone213 = phoneRaw.startsWith('213') ? phoneRaw : `213${phoneRaw.replace(/^0/, '')}`;
      const action = String(body.action || 'campaign');
      const rt = String(body.refresh_token || '');
      const djezzy = createDjezzy(env);
      try {
        let tok = null;
        if (rt) {
          const upd = await djezzy.refreshToken(rt);
          if (upd.statusCode === 200 && upd.data?.access_token) {
            tok = upd.data;
            try {
              await env.DB.prepare(
                "UPDATE users SET access_token = ?, refresh_token = ?, updated_at = ? WHERE phoneNumber = ?"
              )
                .bind(tok.access_token, tok.refresh_token || rt, Date.now(), phoneRaw)
                .run();
            } catch {}
          }
        }
        const at = tok?.access_token || body.access_token || '';
        let res;
        switch (action) {
          case 'send-otp':
            res = await djezzy.sendVerificationCode(phoneRaw);
            break;
          case 'verify-otp': {
            const v = await djezzy.verifyCode(phoneRaw, String(body.code || ''));
            if (v.statusCode === 200 && v.data?.access_token) {
              try {
                await env.DB.prepare("UPDATE users SET access_token = ?, refresh_token = ?, updated_at = ? WHERE phoneNumber = ?")
                  .bind(v.data.access_token, v.data.refresh_token || '', Date.now(), phoneRaw)
                  .run();
              } catch {}
            }
            res = v;
            break;
          }
          case 'campaign':
            res = await djezzy.walkCampaign(phone213, at);
            break;
          case 'offers':
            res = await djezzy.getCustomerOffers(phone213, at, body.tags || 'STANDARD,SURPRISE');
            break;
          case 'activate-reward':
            res = await djezzy.activateWalkReward(phone213, at, String(body.packageCode || ''));
            break;
          case 'activate-product':
            res = await djezzy.activateProduct(phone213, at, String(body.packageCode || ''), body.offerId ? String(body.offerId) : undefined);
            break;
          case 'info':
            res = await djezzy.getCustomerInformation(phone213, at);
            break;
          case 'balances':
            res = await djezzy.getConnectedProductsBalances(phone213, at);
            break;
          default:
            res = { statusCode: 400, data: { error: `unknown action ${action}` } };
        }
        return new Response(JSON.stringify({ action, tokenStatus: tok ? 200 : (rt ? 'refresh-failed' : 'no-token'), statusCode: res.statusCode, data: res.data, raw: res.raw || null, error: res.error || null }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ action, error: e.message || String(e) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // فحص صحي
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    // استقبال تحديثات تلغرام (يُسجَّل عبر setWebhook)
    if (request.method === 'POST' && url.pathname === '/webhook') {
      const body = await request.json().catch(() => null);
      if (!body) return new Response('Bad request', { status: 400 });

      // المعالجة في الخلفية: نرد 200 فورًا لتلغرام حتى لا يتجاوز التحديث مهلة
      // القراءة مهما بطأت استدعاءات APIs الخارجية (SMS/Gemini...).
      ctx.waitUntil(handleUpdate(body, env, ctx));

      return new Response('OK', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },
};
