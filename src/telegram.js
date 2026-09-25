// telegram.js — محوّل تلغرام يحاكي واجهة messenger.js (callSend / typingOn / typingOff / markSeen)
// - callSend يحوّل { text, quick_replies } إلى رسالة تلغرام مع inline keyboard
// - callback_data = payload (بحد 64 بايت؛ نحذف الجزء المضمّن :sender من النهاية إن تجاوز)
// - معرّف المرسل في تلغرام = "t" + chatId لتفادي تصادم جدول sessions مع psid فيسبوك
// - عند ضغطة زر (callback_query): يعدّل callSend نفس الرسالة (editMessageText) بدل إرسال رسالة جديدة،
//   تمامًا كما كان يفعل الكود القديم — ومخزّن مؤقتًا داخل نفس الطلب (كل createTelegram = طلب واحد).
const TG_API = 'https://api.telegram.org/bot';

// أهداف التعديل على مستوى الوحدة (مشتركة بين كل نسخ createTelegram):
// في الطلب الواحد يُنشأ نسختان (tg-index + bot.js) — لو بقيت داخل الدالة لن تُرى من الثانية.
// chatId (نص) -> { message_id, ts } لرسالة الزر المضغوطة (يُستهلك بأول callSend)
const editTargets = new Map();

export function createTelegram(env) {
  const token = env.TG_BOT_TOKEN;
  if (!token) throw new Error('TG_BOT_TOKEN غير معرف');

  async function tg(method, body) {
    const res = await fetch(`${TG_API}${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) console.error('[TG]', method, res.status);
    return data;
  }

  // sender = "t<chatId>" → نستخرج chatId
  function chatId(sender) {
    const s = String(sender || '');
    return s.startsWith('t') ? s.slice(1) : s;
  }

  // تقليم payload لتلائم حد callback_data (64 بايت) دون كسر وظيفته:
  // نحذف الجزء المضمّن :<sender> من النهاية (لا يُقرأ في handlePostback) وإن لم يوجد نزيل آخر جزء
  function trimCallbackData(payload, sender) {
    let p = String(payload || '');
    if (p.length <= 64) return p;
    const s = String(sender || '');
    if (s && p.endsWith(`:${s}`)) return p.slice(0, p.length - s.length - 1);
    const i = p.lastIndexOf(':');
    return i > 0 ? p.slice(0, i) : p.slice(0, 64);
  }

  // quick_replies → صفوف أزرار (زرّان لكل صف، أو صف كامل عند full_row، وزر رابط عند url)
  function buildKeyboard(quickReplies, sender) {
    if (!Array.isArray(quickReplies) || !quickReplies.length) return undefined;
    const rows = [];
    const row = [];
    for (const q of quickReplies) {
      if (!q || !q.title) continue;
      const btn = q.url
        ? { text: String(q.title), url: String(q.url) }
        : q.payload
          ? { text: String(q.title), callback_data: trimCallbackData(q.payload, sender) }
          : null;
      if (!btn) continue;
      if (q.full_row) {
        if (row.length) rows.push(row.splice(0));
        rows.push([btn]);
      } else {
        row.push(btn);
        if (row.length === 2) rows.push(row.splice(0));
      }
    }
    if (row.length) rows.push(row);
    if (!rows.length) return undefined;
    return { inline_keyboard: rows };
  }

  async function callSend(sender, response) {
    const cid = chatId(sender);
    if (!cid || !response) return 0;
    const kb = buildKeyboard(response.quick_replies, sender);
    const body = { chat_id: cid, text: response.text || '' };
    if (kb) body.reply_markup = kb;

    // ضغطة زر → تعديل نفس الرسالة بدل إرسال جديدة (يُستهلك الهدف بأول إرسال)
    const target = editTargets.get(String(cid));
    if (target) {
      editTargets.delete(String(cid));
      // نهمل الأهداف القديمة جدًا (> 5 دقائق) ونرسل رسالة جديدة بدل تعديل رسالة مهجورة
      if (Date.now() - target.ts < 5 * 60 * 1000) {
        body.message_id = target.message_id;
        const data = await tg('editMessageText', body);
        if (data && data.ok) return 200;
        // إن كان المحتوى مطابقًا بالفعل (message is not modified) → لا حاجة لرسالة جديدة
        const errDesc = String(data?.description || '');
        if (/message is not modified/i.test(errDesc)) return 200;
        // فشل التعديل (رسالة قديمة/محذوفة/غير قابلة) → نرسل رسالة جديدة كبديل
        delete body.message_id;
      }
    }

    const data = await tg('sendMessage', body);
    return data && data.ok ? 200 : 0;
  }

  async function senderAction(sender, action) {
    const cid = chatId(sender);
    if (!cid) return 0;
    const data = await tg('sendChatAction', { chat_id: cid, action: action || 'typing' });
    return data && data.ok ? 200 : 0;
  }

  // لا يوجد مفهوم "مقروء" في تلغرام
  async function markSeen(sender) {
    return 0;
  }

  // مؤشر الكتابة: لا نبدأه في تلغرام إطلاقًا، لأن لا يوجد إيقاف صريح له
  // (sendChatAction يستمر ~5 ثوانٍ تلقائيًا) والردود فورية — فيبدو معلّقًا بعد الرد.
  async function typingOn(sender) {
    return 0;
  }

  async function typingOff(sender) {
    return 0;
  }

  // إجابة الاستعلام عن زر (يزيل مؤشر التحميل، ويمنع تلغرام من إعادة الإرسال)
  async function answerCallback(queryId, text) {
    if (!queryId) return;
    const body = { callback_query_id: queryId };
    if (text) body.text = text;
    await tg('answerCallbackQuery', body);
  }

  // إلغاء هدف تعديل معلّق (يُستدعى عند حجب تحديث قبل وصوله إلى callSend)
  function clearEditTarget(chatIdNum) {
    if (chatIdNum !== undefined && chatIdNum !== null) editTargets.delete(String(chatIdNum));
  }

  // تحويل update تلغرام إلى حدث بوت { sender:{id}, message | postback }
  function toBotEvent(update) {
    if (!update) return null;
    if (update.callback_query) {
      const cq = update.callback_query;
      const chat = cq.message?.chat?.id || cq.from?.id;
      if (chat === undefined || chat === null) return null;
      // حفظ هدف التعديل: الرسالة التي عليها الزر ستصبح "مكان الرد" لأول إرسال قادم
      if (cq.message?.message_id) editTargets.set(String(chat), { message_id: cq.message.message_id, ts: Date.now() });
      return {
        sender: { id: `t${chat}` },
        postback: { payload: cq.data || '', title: '' },
        callbackQueryId: cq.id,
      };
    }
    if (update.message) {
      const m = update.message;
      if (!m.chat?.id) return null;
      const hasMedia = !!(m.photo || m.video || m.document || m.audio || m.voice);
      return {
        sender: { id: `t${m.chat.id}` },
        message: {
          text: m.text || (m.caption ? '' : ''),
          ...(hasMedia ? { attachments: [{}] } : {}),
        },
      };
    }
    return null;
  }

  return { callSend, senderAction, markSeen, typingOn, typingOff, answerCallback, clearEditTarget, toBotEvent };
}
