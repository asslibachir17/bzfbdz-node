// عميل Facebook Messenger — طلب واحد فقط لكل رد (بدون mark_seen/typing إن FB_TYPING_INDICATORS=false)
const lastSendBySender = new Map();

async function throttleSend(senderPsid, minGapMs = 350) {
  const last = lastSendBySender.get(senderPsid) || 0;
  const wait = last + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendBySender.set(senderPsid, Date.now());
}

export function createMessenger(env) {
  // توكن صفحة فيسبوك كان مُضمَّناً هنا كنص صريح. حُذف عمداً:
  // النسخة الاحتياطية منه في تاريخ Git، ويجب إصدار توكن جديد.
  const token = env.PAGE_ACCESS_TOKEN || '';
  if (!token) {
    // لا نُسقط العملية: نُبقيها تعمل مع تنبيه صريح، لأن غياب التوكن
    // كان سابقاً يُنتج "بوت حيّ لا يُرسل شيئاً" بصمت.
    console.error('[FB] PAGE_ACCESS_TOKEN غير معرّف — كل الرسائل إلى فيسبوك ستُسقط بصمت. عيّنه في البيئة (وليس في الكود).');
  }
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${encodeURIComponent(token)}`;

  // تنظيف quick_replies: إزالة الحقول غير المدعومة من Facebook Send API (full_row, url، إلخ)
  function sanitizeResponse(response) {
    if (!response) return response;
    if (!Array.isArray(response.quick_replies) || !response.quick_replies.length) {
      // Facebook لا يقبل مصفوفة فارغة: يرفضها بخطأ #194
      // "(#194) param message[quick_replies] has too few elements".
      // لذلك نحذف الحقل كلياً بدل إرساله فارغاً.
      if (!('quick_replies' in response)) return response;
      const { quick_replies: _drop, ...rest } = response;
      return rest;
    }
    const quick_replies = response.quick_replies
      .map((q) => {
        const clean = {};
        if (q.content_type) clean.content_type = q.content_type;
        if (q.title !== undefined) clean.title = q.title;
        if (q.payload !== undefined) clean.payload = q.payload;
        if (q.image_url) clean.image_url = q.image_url;
        return clean;
      })
      // لا نُبقي عنصراً فارغاً: قد يسبّب نفس خطأ #194
      .filter((q) => Object.keys(q).length > 0);
    if (!quick_replies.length) {
      const { quick_replies: _drop, ...rest } = response;
      return rest;
    }
    return { ...response, quick_replies };
  }

  async function callSend(senderPsid, response) {
    if (!token || !senderPsid) return 0;
    try {
      const _t = Date.now();
      await throttleSend(senderPsid);
      const afterThrottle = Date.now() - _t;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: senderPsid }, message: sanitizeResponse(response) }),
      });
      const elapsed = Date.now() - _t;
      if (elapsed > 300) console.log(`[perf-fb] send ${elapsed}ms (throttle ${afterThrottle}ms, status ${res.status})`);
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.error('[FB] فشل الإرسال', res.status, t.slice(0, 300));
      }
      return res.status;
    } catch (e) {
      console.error('[FB] خطأ إرسال:', e.message);
      return 0;
    }
  }

  // مؤشرات "شوهدت / يكتب الآن" — قابلة للتعطيل عبر متغير FB_TYPING_INDICATORS=false (توفير طلبات)
  async function senderAction(senderPsid, action) {
    if (String(env.FB_TYPING_INDICATORS || 'true').toLowerCase() === 'false') return 0;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: senderPsid }, sender_action: action }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.error('[FB] فشل sender_action', action, res.status, t.slice(0, 200));
      }
      return res.status;
    } catch (e) {
      console.error('[FB] خطأ sender_action', action, e.message);
      return 0;
    }
  }

  async function markSeen(senderPsid) {
    return senderAction(senderPsid, 'mark_seen');
  }
  async function typingOn(senderPsid) {
    return senderAction(senderPsid, 'typing_on');
  }
  async function typingOff(senderPsid) {
    return senderAction(senderPsid, 'typing_off');
  }

  return { callSend, senderAction, markSeen, typingOn, typingOff };
}
