// instagram.js — Instagram Messaging API client (mirrors messenger.js interface)
// Same Graph API as Facebook but uses /{PAGE_ID}/messages endpoint and IGSID recipients
const lastSendBySender = new Map();

async function throttleSend(senderIgsid, minGapMs = 1100) {
  const last = lastSendBySender.get(senderIgsid) || 0;
  const wait = last + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendBySender.set(senderIgsid, Date.now());
}

export function createInstagram(env) {
  const token = env.IG_PAGE_ACCESS_TOKEN || env.PAGE_ACCESS_TOKEN;
  const pageId = env.IG_PAGE_ID;
  const baseUrl = (token || '').startsWith('IGAA')
    ? 'https://graph.instagram.com'
    : 'https://graph.facebook.com/v19.0';
  const url = `${baseUrl}/${pageId}/messages?access_token=${encodeURIComponent(token)}`;

  function sanitizeResponse(response) {
    if (!response) return response;
    if (!Array.isArray(response.quick_replies) || !response.quick_replies.length) {
      // لا نرسل مصفوفة فارغة — IGSendAPI يرفضها كما يرفضها Facebook Send API.
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
      .filter((q) => Object.keys(q).length > 0);
    if (!quick_replies.length) {
      const { quick_replies: _drop, ...rest } = response;
      return rest;
    }
    return { ...response, quick_replies };
  }

  async function callSend(senderIgsid, response) {
    if (!token || !senderIgsid || !pageId) return 0;
    try {
      await throttleSend(senderIgsid);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: senderIgsid }, message: sanitizeResponse(response) }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.error('[IG] فشل الإرسال', res.status, t.slice(0, 300));
      }
      return res.status;
    } catch (e) {
      console.error('[IG] خطأ إرسال:', e.message);
      return 0;
    }
  }

  async function senderAction(senderIgsid, action) {
    if (!token || !senderIgsid || !pageId) return 0;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: senderIgsid }, sender_action: action }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        console.error('[IG] فشل sender_action', action, res.status, t.slice(0, 200));
      }
      return res.status;
    } catch (e) {
      console.error('[IG] خطأ sender_action', action, e.message);
      return 0;
    }
  }

  async function markSeen(senderIgsid) {
    return senderAction(senderIgsid, 'mark_seen');
  }
  async function typingOn(senderIgsid) {
    return senderAction(senderIgsid, 'typing_on');
  }
  async function typingOff(senderIgsid) {
    return senderAction(senderIgsid, 'typing_off');
  }

  return { callSend, senderAction, markSeen, typingOn, typingOff };
}
