// bot.js — منطق البوت المشترك بين فيسبوك وتلغرام وإنستغرام
// كل منصة تحصل على messenger مناسب لها داخليًا (لا حاجة لأي ربط خارجي setMessenger/setSend)
import { createMessenger } from './messenger.js';
import { createTelegram } from './telegram.js';
import { createInstagram } from './instagram.js';
import { createDjezzy } from './services/djezzy.js';
import { createOoredoo } from './services/ooredoo.js';
import { httpRequest } from './services/http.js';

const NEW_API_BASE2 = "https://apim.djezzy.dz/mobile-api/api/v1";

// صيانة مؤقتة لدجيزي: نُظهر هذه الرسالة بدل أخطاء الخدمة حتى يكتمل الإصلاح.
const DJEZZY_MAINTENANCE_MSG = "📶 نوع الشريحة: Djezzy\nجيزي في طور الإنجاز حالـيا 🤠🛠️";

import {
  getUserByPhone,
  updateUserTokens,
  updateActivationDate,
  createOrUpdateUser,
  maybeDailySnapchatReset,
  setUserTimestamp,
  getOoredooTimestamps,
} from './users.js';
import { checkAndSetCooldown, checkAndSetCooldownOne, setCooldown, clearCooldown, cooldownLeftMs } from './cooldowns.js';
import { fastFloodGate, isDuplicatePayload } from './rateLimit.js';
import { loadSession, saveSession, getMenuContext } from './session.js';
import { matchKeywordIntent, buildFallbackOptions } from './keywords.js';
import { isDjezzyMaintenance } from './settings.js';
import {
  formatPhoneNumber,
  isValidDjezzyNumber,
  maskOoredooPhone,
  decodeJwtPayload,
  formatDurationMs,
  formatMinutesShort,
  formatSecondsShort,
  ooredooMsisdn,
  getOperator,
  sameAlgeriaDay,
  parseOoredooTime,
  formatAlgeriaTime,
} from './util.js';
import {
  FB_BUTTON_REPEAT_TTL,
  MENU_CONTEXT_TTL,
  ACTIVATE_2G_COOLDOWN_MS,
  ACTIVATE_2G_TRY_COOLDOWN_MS,
  rateConfig,
} from './config.js';

// مُساعد esbuild لتسمية الدوال المجهولة وقت البناء — لا تأثير وظيفي، إرجاع الدالة كما هي
function __name2(fn) {
  return fn;
}

// ---------------- أزرار سريعة مشتركة (Quick Replies) ----------------
function backQR(phone, op) {
  return [{ content_type: 'text', title: 'رجوع ⬅️', payload: `back:${phone}:${op}` }];
}
function gocheckQR(phone, op, sender) {
  return [{ content_type: 'text', title: '✅ تحقق الآن', payload: `gocheck:${phone}:${op}:${sender}` }];
}
function cancelInviteQR(phone, op) {
  return [{ content_type: 'text', title: '❌ إلغاء', payload: `cancel_invite:${phone}:${op}` }];
}
function cancelVerifyQR() {
  return [{ content_type: 'text', title: '❌ إلغاء العملية', payload: 'CANCEL_VERIFICATION' }];
}
// أسطر مرقمة من أزرار الخدمات (تُضاف لنص الرسالة لأن أزرار quick_replies لا تظهر في فيسبوك لايت)
function numberedServiceLines(quickReplies) {
  if (!quickReplies || !quickReplies.length) return '';
  const lines = [];
  let n = 1;
  for (const q of quickReplies) {
    if (!q || /^back:/i.test(String(q.payload || ''))) continue;
    lines.push(`${n}- ${q.title}`);
    n++;
  }
  return lines.length ? lines.join('\n') : '';
}

// ترويج بوت فيسبوك لمستخدمي تلغرام فقط (لا تأثير على فيسبوك نفسه)
const FB_PAGE_LINK = 'https://www.facebook.com/BZeroBot';
const facebookQR = { content_type: 'text', title: 'البوت في فيسبوك 🤖', url: FB_PAGE_LINK, full_row: true };
function withFbButton(response, platform) {
  if (platform !== 'tg' || !response) return response;
  return { ...response, quick_replies: [...(response.quick_replies || []), facebookQR] };
}

// ---------------- عروض دجيزي ----------------
// امتياز (فئة Surprise): services/shake ثم إعادة محاولة عبر activate-product عند 403/404.
// إنترنت (فئة Internet): activate-product فقط بترويسة MobileApp/3.0.9.
// الأسعار والمدد كما يعرضها customer-offers (tags=STANDARD,SURPRISE).
const DJEZZY_SHAKE_OFFERS = {
  BTLINTSPEEDDAY2Go: { label: "امتياز", name: "4Go", data: "4 جيغا", price: 70, duration: "24 ساعة", kind: "imtiyaz", cvmOfferId: 30199 },
  BTL500MBDAY: { label: "امتياز", name: "5Go", data: "5 جيغا", price: 90, duration: "24 ساعة", kind: "imtiyaz", cvmOfferId: 10274 },
  BTL4GBDAY: { label: "امتياز", name: "10Go", data: "10 جيغا", price: 190, duration: "3 أيام", kind: "imtiyaz", cvmOfferId: 10276 },
  DOVINTSPEEDDAY100MoPRE: { label: "إنترنت يومي", name: "300Mo", data: "300 ميغا", price: 30, duration: "24 ساعة", kind: "internet" },
  DOVINTSPEEDDAY250MoPRE: { label: "إنترنت يومي", name: "600Mo", data: "600 ميغا", price: 50, duration: "24 ساعة", kind: "internet" },
  DOVINTSPEEDDAY1GoPRE: { label: "إنترنت يومي", name: "2Go", data: "2 جيغا", price: 100, duration: "24 ساعة", kind: "internet" },
  DOVINTSPEEDDAY5GoPRE5G: { label: "إنترنت يومي", name: "5Go", data: "5 جيغا", price: 150, duration: "24 ساعة", kind: "internet" },
  DOVINTSPEEDWEEK2GoPRE: { label: "إنترنت أسبوعي", name: "4Go", data: "4 جيغا", price: 150, duration: "أسبوع", kind: "internet" },
  DOVINTSPEEDWEEK3GoPRE: { label: "إنترنت أسبوعي", name: "10Go", data: "10 جيغا", price: 300, duration: "أسبوع", kind: "internet" },
  DOVINTSPEEDWEEK20GoPRE5G: { label: "إنترنت أسبوعي", name: "20Go", data: "20 جيغا", price: 500, duration: "أسبوع", kind: "internet" },
  DOVINTSPEEDMONTH6GoPRE: { label: "إنترنت شهري", name: "12Go", data: "12 جيغا", price: 500, duration: "شهر", kind: "internet" },
  DOVINTSPEEDMONTH15GoPRE: { label: "إنترنت شهري", name: "30Go", data: "30 جيغا", price: 1000, duration: "شهر", kind: "internet" }
};
const DJEZZY_SHAKE_ORDER = ["BTLINTSPEEDDAY2Go", "BTL500MBDAY", "BTL4GBDAY"];
const DJEZZY_INTERNET_ORDER = [
  "DOVINTSPEEDDAY100MoPRE",
  "DOVINTSPEEDDAY250MoPRE",
  "DOVINTSPEEDDAY1GoPRE",
  "DOVINTSPEEDDAY5GoPRE5G",
  "DOVINTSPEEDWEEK2GoPRE",
  "DOVINTSPEEDWEEK3GoPRE",
  "DOVINTSPEEDWEEK20GoPRE5G",
  "DOVINTSPEEDMONTH6GoPRE",
  "DOVINTSPEEDMONTH15GoPRE"
];
// ترتيب ثابت تصاعدي حسب السعر (.Apenyi أول صنف امتياز في التساوي)
const DJEZZY_ALL_ORDER = [...DJEZZY_INTERNET_ORDER, ...DJEZZY_SHAKE_ORDER]
  .map((code, i) => ({ code, i }))
  .sort((a, b) => DJEZZY_SHAKE_OFFERS[a.code].price - DJEZZY_SHAKE_OFFERS[b.code].price || a.i - b.i)
  .map((x) => x.code);

// استخراج نص الرسالة من استجابات دجيزي (ar/fr/en)
function pickLocalized(msg, fallback) {
  if (!msg) return fallback || "";
  if (typeof msg === "string") return msg;
  if (typeof msg === "object") return msg.ar || msg.fr || msg.en || fallback || "";
  return fallback || "";
}

function djezzyDurationLabel(amount, unit) {
  const a = Number(amount) || 0;
  const u = String(unit || "").toUpperCase();
  if (u === "HOURS") return a >= 48 ? `${Math.round(a / 24)} أيام` : `${a} ساعة`;
  if (u === "DAYS") return a === 1 ? "يوم" : a === 7 ? "أسبوع" : a === 30 ? "شهر" : `${a} أيام`;
  if (u === "WEEKS") return `${a} أسابيع`;
  return "";
}

function djezzyDataLabel(pkg) {
  const parts = [];
  for (const b of pkg?.trafficBundles || []) {
    if (b.usageType !== "DATA") continue;
    if (b.is_unlimited) parts.push("إنترنت مفتوح");
    else {
      const mb = Number(b.freeUsageAmount);
      if (!Number.isFinite(mb) || mb <= 0) continue;
      parts.push(mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} Go` : `${mb} Mo`);
    }
  }
  return parts.length ? [...new Set(parts)].join(" + ") : "";
}

// تصنيف عروض customer-offers القادمة إلى: امتياز + إنترنت
function parseDjezzyOffers(payload) {
  const out = { imtiyaz: [], internet: [] };
  const cats = Array.isArray(payload?.data) ? payload.data : [];
  for (const cat of cats) {
    const code = String(cat?.code || "");
    const target = code === "Surprise" ? out.imtiyaz : code === "Internet" ? out.internet : null;
    if (!target) continue;
    for (const sub of cat?.subcategories || []) {
      for (const p of sub?.packages || []) {
        if (p?.show === false || p?.isEligible === false) continue;
        const price = Number(p.price);
        if (!Number.isFinite(price)) continue;
        target.push({
          code: p.code,
          name: p?.commercialName?.ar || p?.title?.ar || p.code,
          price,
          duration: djezzyDurationLabel(p.periodicAmount, p.periodicUnit),
          data: djezzyDataLabel(p),
          offerId: p?.cvmOfferId != null ? Number(p.cvmOfferId) : undefined,
        });
      }
    }
  }
  return out;
}

// نص قائمة العروض (نفس نمط بطاقات أوريدو) + عناوين أزرار كل العروض
function buildDjezzyOffersMessage(mask) {
  const colors = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤"];
  const card = (o, i) => {
    const rows = [`${i + 1}- ${o.label}`, `${colors[i % colors.length]} • ${o.price} دج 💸`];
    if (o.data) rows.push(`🌐 • إنترنت : ${o.data}`);
    if (o.duration) rows.push(`🗓️ • مدة : ${o.duration}`);
    return rows.join("\n");
  };
  const body = DJEZZY_ALL_ORDER.map((code, i) => card(DJEZZY_SHAKE_OFFERS[code], i)).join("\n\n");
  const text = `🛍️ عروض 🏷️
📱 الرقم: ${mask}

${body}

اختر العرض المناسب من الأزرار أدناه 🔽`;
  const buttons = DJEZZY_ALL_ORDER.map((code) => {
    const o = DJEZZY_SHAKE_OFFERS[code];
    return { code, title: `${o.price} دج - ${o.data} - ${o.duration}` };
  });
  return { text, buttons };
}

export { parseDjezzyOffers, buildDjezzyOffersMessage, DJEZZY_SHAKE_OFFERS, DJEZZY_SHAKE_ORDER, DJEZZY_INTERNET_ORDER, DJEZZY_ALL_ORDER };

export
function createBot(env, ctx, platform = "fb") {
  const messenger = platform === "tg" ? createTelegram(env) : platform === "ig" ? createInstagram(env) : createMessenger(env);
  const djezzy = createDjezzy(env);
  const ooredoo = createOoredoo(env);
  const rc = rateConfig(env);
  const isTg = true;
  // الإنتاج: يبقى مفعّلًا افتراضيًا حتى لو لم يزامن Render المتغيّر الجديد
const djezzyExperiments = String(env.EXPERIMENT_OFFERS ?? "1") !== "0";

  // محاولة تلقائية عند الحجب الجغرافي: يعيد المحاولة حتى3 مرات مع تأخير
  async function withBlockRetry(fn) {
    const MAX = 3;
    let lastRes;
    for (let i = 1; i <= MAX; i++) {
      const res = await fn();
      if (!(res && res.data && res.data.blocked)) return res;
      lastRes = res;
      if (i < MAX) await new Promise(r => setTimeout(r, 2000));
    }
    return lastRes;
    return await fn();
  }
  const isDjezzyAuthFail = /* @__PURE__ */ __name2((r) => r?.statusCode === 401 || r?.statusCode === 403 && r?.data?.fault?.code === 900908 || r?.data?.fault?.code === 900901 || /invalid credentials/i.test(JSON.stringify(r?.data || "")), "isDjezzyAuthFail");
  let lastSnapResetDayChecked = 0;
  async function send(sender, response, session) {
    if (!response || (!response.text && !response.attachment && !response.quick_replies)) return 0;
    if (response && session && response.quick_replies && response.quick_replies.length) {
      session.menu_ctx = JSON.stringify({ quick_replies: response.quick_replies, ts: Date.now() });
    } else if (response && session) {
      session.menu_ctx = null;
    }
    const status = await messenger.callSend(sender, response);
    return status;
  }
  function extractEvents(body) {
    if (!body || body.object !== "page" || !Array.isArray(body.entry))
      return [];
    const events = [];
    for (const entry of body.entry) {
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging)
          events.push(m);
      }
    }
    return events;
  }
  function floodGate(body) {
    const events = extractEvents(body);
    if (!events.length) return false;
    for (const ev of events) {
      const sender = ev?.sender?.id;
      if (sender && !fastFloodGate(sender, rc)) return false;
    }
    return true;
  }
  async function process(body) {
    const events = extractEvents(body);
    let processed = 0;
    for (const ev of events) {
      try {
        await processEvent(ev);
        processed++;
      } catch (e) {
        console.error("[BOT] خطأ في معالجة حدث:", e.message, e.stack);
        try {
          const sender = ev?.sender?.id;
          if (sender) await messenger.callSend(sender, { text: "⚠️ حدث خطأ مؤقت، يرجى المحاولة لاحقًا." });
        } catch {}
      }
    }
    console.log(`[bot] processed ${processed}/${events.length} events`);
    return processed;
  }
  async function processEvent(ev) {
    const sender = ev?.sender?.id;
    if (!sender)
      return;
    const _t0 = Date.now();
    const mid = ev?.message?.mid;
    if (mid) {
      const _tm = Date.now();
      const seen = await checkAndSetCooldownOne(env, `mid:${mid}`, 5 * 60 * 1e3);
      const _tmDt = Date.now() - _tm;
      if (_tmDt > 100) console.log(`[perf-mid] mid-check took ${_tmDt}ms`);
      if (!seen.ok)
        return;
    }
    const algeriaDayNow = Math.floor((Date.now() + 36e5) / 864e5);
    if (algeriaDayNow !== lastSnapResetDayChecked) {
      lastSnapResetDayChecked = algeriaDayNow;
      const _tS = Date.now();
      await maybeDailySnapchatReset(env);
      const _tSd = Date.now() - _tS;
      if (_tSd > 100) console.log(`[perf-snap] daily reset took ${_tSd}ms`);
    }
    const session = await loadSession(env, sender);
    const t1 = Date.now();
    if (ev.message) {
      if (ev.message.is_echo || ev.message.is_deleted || ev.message.is_unsupported) {
        await saveSession(env, session);
        return;
      }
      // القرأة أُرسلت فورًا في الويب هوك (index.js). مؤشر الكتابة: لا ننتظره —
      // الرد يُبنى مباشرة بأسرع وقت (لا نقطعة إضافية للشبكة قبل المعالجة).
      messenger.typingOn(sender).catch(() => {});
      let t5 = Date.now();
      await handleMessage(sender, ev.message, session);
      let t6 = Date.now();
      await saveSession(env, session);
      let t7 = Date.now();
      console.log(`[perf-bot] loadSession=${t1-_t0}ms handle=${t6-t5}ms save=${t7-t6}ms total=${t7-_t0}ms`);
      return;
    } else if (ev.postback) {
      if (ev.postback.title || ev.postback.payload) {
        messenger.typingOn(sender).catch(() => {});
      }
      await handlePostback(sender, ev.postback, session);
      await saveSession(env, session);
      return;
    }
    await saveSession(env, session);
    const _dt = Date.now() - _t0;
    if (_dt > 150) console.log(`[perf-bot] event handled in ${_dt}ms (mid=${mid || '-'})`);
  }
  async function handleMessage(sender, received_message, session) {
    const messageText = (received_message?.text || "").trim();
    if (received_message?.quick_reply?.payload) {
      await handlePostback(sender, { payload: received_message.quick_reply.payload }, session);
      return;
    }
    if (session.invite_status === "awaiting_number") {
      const inviteDigits = messageText.replace(/\D/g, "");
      if (isValidDjezzyNumber(inviteDigits)) {
        const phoneNumber = session.invite_phone;
        const operator = session.invite_operator;
        session.invite_status = null;
        session.invite_phone = null;
        session.invite_operator = null;
        const result = await sendInvitation(sender, phoneNumber, inviteDigits, operator, session);
        await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
      } else {
        await send(sender, { text: "❌ رقم جازي غير صالح! يجب أن يبدأ بـ 07 ويتكون من 10 أرقام." }, session);
      }
      return;
    }
    const digitsOnly = messageText.replace(/\D/g, "");
    const match = messageText.match(/\d{10}|\d{6}/);
    const cleaned = match ? match[0] : digitsOnly.length === 10 || digitsOnly.length === 6 ? digitsOnly : "";
    if (/^\d{10}$/.test(cleaned)) {
      await handlePhoneNumber(sender, cleaned, session);
      return;
    }
    if (/^\d{6}$/.test(cleaned)) {
      await handleVerificationCode(sender, cleaned, session);
      return;
    }
    if (received_message.attachments) {
      await send(sender, { text: "👍" }, session);
      return;
    }
    const menu = getMenuContext(session, MENU_CONTEXT_TTL);
    if (menu && menu.quick_replies.length) {
      const options = menu.quick_replies.map((q) => ({ title: q.title, payload: q.payload }));
      // اختيار رقمي: يكتب المستخدم رقم الخدمة (1..9) فيتطابق مع الترتيب المرقّم المعروض
      const numMatch = /^([1-9])$/.exec(messageText.trim());
      if (numMatch) {
        const ordered = options.filter((o) => !/^back:/i.test(o.payload));
        const target = ordered[Number(numMatch[1]) - 1];
        if (target) {
          session.menu_ctx = null;
          await handlePostback(sender, { payload: target.payload }, session);
          return;
        }
      }
      const local = matchKeywordIntent(messageText, options);
      if (local) {
        session.menu_ctx = null;
        await handlePostback(sender, { payload: local.payload }, session);
        return;
      }
    }
    const fallbackOptions = buildFallbackOptions(session.phone, session.operator);
    if (fallbackOptions) {
      const local = matchKeywordIntent(messageText, fallbackOptions);
      if (local) {
        await handlePostback(sender, { payload: local.payload }, session);
        return;
      }
    }
    await send(sender, { text: "📱 يرجى إدخال رقم هاتف فقط!" }, session);
  }
  async function handlePhoneNumber(sender, phone_number, session) {
    const inputPhone = phone_number.trim();
    if (inputPhone.startsWith("06")) {
      await send(sender, { text: "📶 نوع الشريحة: Mobilis\n⚠️ الحالة: غير متوفرة حاليًا." }, session);
      return;
    }
    if (inputPhone.startsWith("02") && inputPhone.length === 9) {
      await send(sender, { text: "📡 الخدمة: اتصالات الجزائر\n⚠️ الحالة: غير متوفرة حاليًا." }, session);
      return;
    }
    const operator = getOperator(inputPhone);
    if (!operator) {
      await send(sender, { text: "❌ رقم غير صالح!\nيرجى إدخال رقم هاتف صالح." }, session);
      return;
    }
    if (operator === "djezzy" && (await isDjezzyMaintenance(env))) {
      await send(sender, { text: DJEZZY_MAINTENANCE_MSG }, session);
      return;
    }
    const existingUser = await getUserByPhone(env, inputPhone);
    if (existingUser?.access_token) {
      if (session.last_phone_sent === inputPhone && existingUser.operator === "djezzy") {
        session.last_phone_sent = null;
        session.pendingPayload = `activate2G:${inputPhone}:${existingUser.operator}`;
        const result = await activate2G(sender, inputPhone, existingUser.operator, session);
        await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        return;
      }
      session.last_phone_sent = inputPhone;
      await showServicesMenu(sender, inputPhone, existingUser.operator, session);
      return;
    }
    await sendVerificationCode(sender, inputPhone, session);
  }
  async function sendVerificationCode(sender, phoneNumber, session, pendingPayload) {
    const operator = getOperator(phoneNumber);
    if (!operator) {
      await send(sender, { text: "⚠️ المشغل غير مدعوم، يرجى اختيار Djezzy أو Ooredoo." }, session);
      return;
    }
    let sess = session;
    if (!sess) {
      sess = await loadSession(env, sender);
    }
    const now = Date.now();
    const lastSent = Number(sess.last_code_sent_at) || 0;
    if (lastSent && now - lastSent < rc.otpResendMinMs) {
      const secondsLeft = Math.ceil((rc.otpResendMinMs - (now - lastSent)) / 1e3);
      await send(sender, { text: `⏳ يرجى الانتظار ${secondsLeft} ثانية قبل طلب رمز جديد.` }, sess);
      return;
    }
    const formattedPhone = phoneNumber.replace(/^0/, "");
    const apiResponse = await withBlockRetry(() => operator === "djezzy" ? djezzy.sendVerificationCodeV2(formattedPhone) : ooredoo.sendVerificationCode(formattedPhone));
    console.log("[OTP]", operator, "status=", apiResponse.statusCode, "via=", apiResponse.via || "direct", "data=", JSON.stringify(apiResponse.data || {}).slice(0, 200), "err=", apiResponse.error || "");
    if (apiResponse.data && apiResponse.data.blocked) {
      await send(sender, { text: apiResponse.data.message || "الخدمة غير متاحة حاليًا." }, sess);
      return;
    }
    if (apiResponse.statusCode === 200) {
      sess.phone = phoneNumber;
      sess.operator = operator;
      sess.stage = "waiting_code";
      sess.last_code_sent_at = now;
      if (pendingPayload) sess.pendingPayload = pendingPayload;
      await saveSession(env, sess);
      await send(sender, { text: `✅ تم إرسال الرمز!
رقمك: ${formatPhoneNumber(phoneNumber)}` }, sess);
    } else if (apiResponse.data?.blocked) {
      await send(sender, { text: apiResponse.data.message || "الخدمة غير متاحة حاليًا." }, sess);
    } else if (apiResponse.statusCode === 400) {
      await send(sender, { text: "❌ حدث خطأ في الطلب، يرجى المحاولة لاحقًا." }, sess);
    } else if (apiResponse.statusCode === 429 && apiResponse.data?.message) {
      await send(sender, { text: apiResponse.data.message }, sess);
    } else if (apiResponse.statusCode === 503 && apiResponse.data?.message) {
      await send(sender, { text: apiResponse.data.message }, sess);
    } else if (apiResponse.statusCode === 401 || /invalid user credentials/i.test(JSON.stringify(apiResponse.data || {}))) {
      if (operator === "ooredoo") {
        await send(sender, { text: "⚠️ الضغط على شبكة أوريدو الآن.\nأعد المحاولة بعد بضع دقائق." }, sess);
      } else {
        await send(sender, { text: "رقم غير صحيح او غير موجود رجاء تحقق من رقم واعادة محاولة ❌" }, sess);
      }
    } else if (apiResponse.statusCode !== 500 && apiResponse.statusCode !== 0) {
      await send(sender, { text: "❌ حدث خطأ، يرجى المحاولة لاحقًا." }, sess);
    } else {
      await send(sender, { text: "⚠️ فشل إرسال الرمز، يرجى المحاولة لاحقًا." }, sess);
    }
  }
  async function handleVerificationCode(sender, code, session) {
    if (!session || session.stage !== "waiting_code" || !session.phone) {
      await send(sender, { text: "⚠️ لم يتم العثور على طلب تحقق.\nابدأ بإرسال رقم هاتفك أولاً." }, session);
      return;
    }
    const operator = session.operator;
    const verifyResponse = await withBlockRetry(() => operator === "djezzy" ? djezzy.verifyCodeV2(session.phone.slice(1), code) : ooredoo.verifyCode(session.phone.slice(1), code));
    if (verifyResponse.data && verifyResponse.data.blocked) {
      await send(sender, { text: verifyResponse.data.message || "الخدمة غير متاحة حاليًا." }, session);
      return;
    }
    if (verifyResponse.statusCode === 429 && verifyResponse.data?.message) {
      await send(sender, { text: verifyResponse.data.message }, session);
      return;
    }
    if (verifyResponse.statusCode !== 200 || !verifyResponse.data) {
      await send(
        sender,
        { text: "❌ الرمز غير صحيح أو انتهت صلاحيته.\n🔄 أرسل رقمك من جديد لإرسال رمز جديد.", quick_replies: cancelVerifyQR() },
        session
      );
      return;
    }
    const { access_token, refresh_token } = verifyResponse.data;
    if (!access_token) {
      await send(sender, { text: "⚠️ حدث خطأ أثناء التحقق." }, session);
      return;
    }
    await createOrUpdateUser(env, {
      phoneNumber: session.phone,
      chatId: sender,
      operator,
      accessToken: access_token,
      refreshToken: refresh_token
    });
    session.stage = "verified";
    const pendingPayload = session.pendingPayload || null;
    delete session.pendingPayload;
    await send(sender, { text: "✅ تم التحقق بنجاح!" }, session);
    // العودة للدفعة المعلّقة ليست ضغطة زر مكررة، لذلك نلغي حارس التكرار قبل تشغيلها
    // وإلا أُهملت الشاشات التي طلبت التحقق تلقائيًا (قائمة العروض / بطاقة العرض).
    session.last_payload = null;
    session.last_payload_ts = 0;
    if (pendingPayload) {
      await handlePostback(sender, { payload: pendingPayload }, session);
    } else {
      await showServicesMenu(sender, session.phone, operator, session);
    }
  }
  async function handlePostback(sender, received_postback, session) {
    const payload = received_postback?.payload;
    if (!payload)
      return;
    session.last_phone_sent = null;
    session.menu_ctx = null;
    if (isDuplicatePayload(session, payload, FB_BUTTON_REPEAT_TTL))
      return;
    session.last_payload = payload;
    session.last_payload_ts = Date.now();
    if (payload === "GET_STARTED") {
      delete session.pendingPayload;
      await send(
        sender,
        {
          text: "السلام عليكم 👋 \nأنا بوت BZero أساعدك في تفعيل خدمات وهدايا مجانية 🇩🇿 لشرائح الجزائرية. \n💡 للبدء:\n1️⃣ أرسل رقم هاتفك\n2️⃣ أدخل رمز التفعيل\n3️⃣ اختر الخدمة التي تناسبك ✅"
        },
        session
      );
      return;
    }
    if (payload === "CANCEL_VERIFICATION") {
      delete session.pendingPayload;
      session.stage = "";
      session.phone = null;
      session.operator = null;
      await send(sender, { text: "✅ تم إلغاء العملية بنجاح!" }, session);
      return;
    }
    const parts = payload.split(":");
    const action = parts[0];
    const phoneNumber = parts[1];
    const operator = parts[2];
    if (operator === "djezzy" && (await isDjezzyMaintenance(env))) {
      await send(sender, { text: DJEZZY_MAINTENANCE_MSG }, session);
      return;
    }
    if (action !== "gocheck") {
      session.pendingPayload = payload;
    }
    switch (action) {
      case "activate2G": {
        const result = await activate2G(sender, phoneNumber, operator, session);
        if (result) await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "startinvite": {
        await startInvitationProcess(sender, phoneNumber, operator, session);
        break;
      }
      case "cancel_invite": {
        delete session.pendingPayload;
        session.invite_status = null;
        session.invite_phone = null;
        session.invite_operator = null;
        await send(sender, { text: "✅ تم إلغاء عملية الدعوة." }, session);
        break;
      }
      case "mgm-menu": {
        if (!isTg)
          break;
        const back = backQR(phoneNumber, operator);
        const menuMsg = `👥 الدعوات`;
        const menuBtns = [
          { content_type: "text", title: "إرسال دعوة جديدة 👥", payload: `startinvite:${phoneNumber}:${operator}`, full_row: true },
          { content_type: "text", title: "دعواتي 👥", payload: `myinvites:${phoneNumber}:${operator}`, full_row: true },
          ...back
        ];
        await send(sender, { text: menuMsg, quick_replies: menuBtns }, session);
        break;
      }
      case "myinvites": {
        if (!isTg)
          break;
        const result = await showMyInvitations(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "claimmgm": {
        if (!isTg)
          break;
        const result = await claimMgmReward(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "delmgm": {
        if (!isTg)
          break;
        const receiver = parts[3];
        if (!receiver)
          break;
        const result = await deleteMgmInvitation(sender, phoneNumber, operator, receiver, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "resendmgm": {
        if (!isTg)
          break;
        const receiver = parts[3];
        if (!receiver)
          break;
        const result = await resendMgmInvitation(sender, phoneNumber, operator, receiver, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "infosimdjezzy": {
        const result = await infosimdjezzy(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "srv1": {
        const result = await prepareInternetPackageConfirmation(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "srv2": {
        const result = await preparePaid2GoConfirmation(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "confirmpaid2g": {
        const result = await executePaid2Go(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "confirminternet": {
        const result = await executeInternetPackageActivation(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "back": {
        delete session.pendingPayload;
        await showServicesMenu(sender, phoneNumber, operator, session);
        break;
      }
      case "obundles": {
        await showBundlesSubmenu(sender, phoneNumber, operator, session);
        break;
      }
      case "oservices": {
        await showOoredooOffers(sender, phoneNumber, operator, session);
        break;
      }
      case "oexclusive": {
        const result = await showOoredooBundles(sender, phoneNumber, operator, "exclusive", session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "oloyalty": {
        const result = await showOoredooBundles(sender, phoneNumber, operator, "loyalty", session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "odynbuy": {
        const code = parts[3];
        const name = parts[4] ? decodeURIComponent(parts[4]) : "";
        const result = await confirmDynamicBundlePurchase(sender, phoneNumber, operator, code, name);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "odynconfirm": {
        const code = parts[3];
        const result = await executeDynamicBundlePurchase(sender, phoneNumber, operator, code, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "ogift": {
        const result = await handleOoredooGift(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "oaccount": {
        const result = await handleOoredooAccount(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "osnap": {
        const result = await handleOoredooSnapchat(sender, phoneNumber, operator, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "obyop": {
        const result = await showByopMenu(sender, phoneNumber, operator);
        await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "obyopcode": {
        const code = parts[3];
        const result = await confirmByopPurchase(sender, phoneNumber, operator, code);
        await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "djoffers": {
        if (!djezzyExperiments) break;
        const parts = String(payload).split(":");
        const result = await showDjezzyOffersMenu(sender, parts[1] || phoneNumber, parts[2] || operator, session);
        if (result) await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "djshake": {
        if (!djezzyExperiments) break;
        const code = parts[3];
        const result = await prepareDjezzyShakeOffer(sender, phoneNumber, operator, session, code);
        if (result) await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "djshakeok": {
        if (!djezzyExperiments) break;
        const code = parts[3];
        const result = await executeDjezzyShakeOffer(sender, phoneNumber, operator, session, code);
        if (result) await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "obyopconfirm": {
        const code = parts[3];
        const result = await executeByopPurchase(sender, phoneNumber, operator, code, session);
        if (result)
          await send(sender, { text: result.text, quick_replies: result.quick_replies || [] }, session);
        break;
      }
      case "gocheck": {
        await sendVerificationCode(sender, phoneNumber, session);
        break;
      }
      default:
        delete session.pendingPayload;
        if (phoneNumber && operator) {
          await showServicesMenu(sender, phoneNumber, operator, session);
        } else {
          await send(sender, { text: "📱 يرجى إدخال رقم هاتفك للبدء." }, session);
        }
        break;
    }
  }
  async function botServiceCooldown(sender, action, phoneNumber, session, cooldownMs) {
    const key = `bot:${action}:${sender}:${phoneNumber || ""}`;
    const ms = cooldownMs || rc.botServiceCooldownMs;
    const leftMs = await cooldownLeftMs(env, key);
    if (leftMs > 0) {
      const label = ms >= 6e4 ? formatMinutesShort(leftMs) : formatSecondsShort(leftMs);
      await send(sender, { text: `⏳ يرجى الانتظار ${label} قبل تكرار هذه العملية.` }, session);
      return false;
    }
    return true;
  }
  async function activate2G(sender, phoneNumber, operator, session) {
    const formattedPhone = `213${String(phoneNumber).replace(/^0/, "")}`;
    const mask = formatPhoneNumber(phoneNumber);
    const lock = await checkAndSetCooldown(env, `act2g:lock:${phoneNumber}`, 12e4);
    if (!lock.ok) {
      return { text: "⏳ جاري تنفيذ العملية، الرجاء الانتظار قليلاً...", quick_replies: backQR(phoneNumber, operator) };
    }
    try {
      const existingUser = await getUserByPhone(env, phoneNumber);
      if (!existingUser || !existingUser.access_token) {
        return { text: "❌ الرقم غير مسجل لدينا.", quick_replies: gocheckQR(phoneNumber, operator, sender) };
      }
      if (existingUser.activation_date) {
        const diff = Date.now() - Number(existingUser.activation_date);
        if (diff > 0 && diff < ACTIVATE_2G_COOLDOWN_MS) {
          const remaining = ACTIVATE_2G_COOLDOWN_MS - diff;
          return {
            text: `رقم الهاتف: ${mask} 📱
تبقى: ${formatDurationMs(remaining)}
قبل إمكانية التفعيل مجددًا ❌`,
            quick_replies: backQR(phoneNumber, operator)
          };
        }
      }
      return await activate2GV2(sender, phoneNumber, operator, session, existingUser);
    } finally {
      await clearCooldown(env, `act2g:lock:${phoneNumber}`);
    }
  }
  async function activate2GV2(sender, phoneNumber, operator, session, existingUser) {
    const formattedPhone = `213${String(phoneNumber || "").replace(/^0/, "").trim()}`;
    const mask = formatPhoneNumber(phoneNumber);
    const back = backQR(phoneNumber, operator);
    try {
      const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
      if (!tokenRes.access_token)
        return tokenRes.fbResponse || {};
      let accessToken = tokenRes.access_token;
      const walkBody = JSON.stringify({ packageCode: "GIFTWALKWIN2GO" });
      let walkRes = await httpRequest(env, {
        method: "POST",
        url: `${NEW_API_BASE2}/services/walk/activate-reward/${formattedPhone}`,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "MobileApp/3.0.7",
          Accept: "application/json",
          "Accept-Language": "fr"
        },
        body: walkBody,
        relayKey: "DJEZZY_RELAY_URL",
        useDbProxy: true,
        proxyService: "djezzy",
        sid: formattedPhone,
        timeoutMs: 6e4
      }).catch(() => ({ status: 0, data: null }));
      let res = { statusCode: walkRes.status, data: walkRes.data, raw: walkRes };
      if ((walkRes.status === 401 || walkRes.data && typeof walkRes.data === "object" && (walkRes.data.error === "invalid_token" || walkRes.data.fault)) && existingUser?.refresh_token) {
        const tokenUpdate = await djezzy.refreshTokenV2(existingUser.refresh_token).catch(() => null);
        if (tokenUpdate?.statusCode === 200 && tokenUpdate?.data?.access_token) {
          accessToken = tokenUpdate.data.access_token;
          await updateUserTokens(env, phoneNumber, accessToken, tokenUpdate.data.refresh_token || existingUser.refresh_token);
          walkRes = await httpRequest(env, {
            method: "POST",
            url: `${NEW_API_BASE2}/services/walk/activate-reward/${formattedPhone}`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "User-Agent": "MobileApp/3.0.7",
              Accept: "application/json",
              "Accept-Language": "fr"
            },
            body: walkBody,
            relayKey: "DJEZZY_RELAY_URL",
            useDbProxy: true,
            proxyService: "djezzy",
            sid: formattedPhone,
            timeoutMs: 6e4
          }).catch(() => ({ status: 0, data: null }));
          res = { statusCode: walkRes.status, data: walkRes.data, raw: walkRes };
        }
      }
      if (!((res.statusCode === 200 || res.statusCode === 201) && res.data?.status === 200)) {
        try {
          await env.DB.prepare(
            "INSERT INTO request_logs (created_at, direction, kind, method, url, status_code, sender_psid, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            Date.now(),
            "out",
            "diag:act2g-v2-walk",
            "POST",
            "activate-reward",
            res.statusCode || 0,
            sender,
            JSON.stringify({ data: res.data }).slice(0, 2e3)
          ).run();
        } catch (e) {
        }
      }
      const resStatus = res.statusCode || 0;
      const resBodyStatus = Number(res.data?.status) || 0;
      if ((resStatus === 200 || resStatus === 201) && [200, 201, 202].includes(resBodyStatus) && res.data?.message === "Product successfully activated") {
        await updateActivationDate(env, phoneNumber);
        await setCooldown(env, `act2g:op:${phoneNumber}`, ACTIVATE_2G_TRY_COOLDOWN_MS);
        return withFbButton({ text: `تم تفعيل 2Go بنجاح! 🎉
رقم الهاتف: ${mask}`, quick_replies: back }, platform);
      }
      if (res?.data?.blocked || resStatus === 0 || (resStatus >= 500 && resStatus <= 599)) {
        return withFbButton({ text: `⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.
رقم الهاتف: ${mask}`, quick_replies: back }, platform);
      }
      if (resStatus === 403 || resBodyStatus === 403) {
        return withFbButton({ text: `❌ هذه العملية غير متوفرة حاليًا.
رقم الهاتف: ${mask}`, quick_replies: back }, platform);
      }
      if (resStatus === 401 || resBodyStatus === 401) {
        await sendVerificationCode(sender, phoneNumber, session);
        return null;
      }
      return { text: `حدث خطأ أثناء محاولة التفعيل ⚠️
رقم الهاتف: ${mask}`, quick_replies: back };
    } catch (e) {
      console.error("[2Go V2] خطأ:", e.message);
      return { text: `حدث خطأ أثناء محاولة التفعيل ⚠️
رقم الهاتف: ${mask}`, quick_replies: back };
    } finally {
      await clearCooldown(env, `act2g:lock:${phoneNumber}`);
    }
  }
  async function preparePaid2GoConfirmation(sender, phoneNumber, operator, session) {
    const mask = formatPhoneNumber(phoneNumber);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return {
        text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملغىتك لهذا الرقم ❌`,
        quick_replies: gocheckQR(phoneNumber, operator, sender)
      };
    }
    if (!await botServiceCooldown(sender, "srv2", phoneNumber, session))
      return null;
    return {
      text: `✅ العرض: 2Go لمدة 24 ساعة - 100 دج
📱 رقمك: ${mask}
💵 السعر: 100 دج

هل تريد التفعيل الآن؟`,
      quick_replies: [
        {
          content_type: "text",
          title: "✅ نعم، فعل العرض",
          payload: `confirmpaid2g:${phoneNumber}:${operator}:${sender}`
        },
        ...backQR(phoneNumber, operator)
      ]
    };
  }
  async function executePaid2Go(sender, phoneNumber, operator, session) {
    const formattedPhone = `213${String(phoneNumber || "").replace(/^0/, "").trim()}`;
    const mask = formatPhoneNumber(phoneNumber);
    const back = backQR(phoneNumber, operator);
    const lock = await checkAndSetCooldown(env, `paid2g:lock:${phoneNumber}`, 12e4);
    if (!lock.ok) {
      return { text: "⏳ جاري تنفيذ العملية، الرجاء الانتظار قليلاً...", quick_replies: back };
    }
    try {
      const existingUser = await getUserByPhone(env, phoneNumber);
      if (!existingUser || !existingUser.access_token) {
        return { text: "❌ لم يتم العثور على جلسة لهذا الرقم.\nيرجى التحقق أولاً.", quick_replies: gocheckQR(phoneNumber, operator, sender) };
      }
      const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
      if (!tokenRes.access_token)
        return tokenRes.fbResponse || {};
      let accessToken = tokenRes.access_token;
      const prodBody = JSON.stringify({ packageCode: "DOVINTSPEEDDAY1GoPRE" });
      let prodRes = await httpRequest(env, {
        method: "POST",
        url: `${NEW_API_BASE2}/subscribers/activate-product/${formattedPhone}`,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "MobileApp/3.0.7",
          Accept: "application/json",
          "Accept-Language": "fr"
        },
        body: prodBody,
        relayKey: "DJEZZY_RELAY_URL",
        useDbProxy: true,
        proxyService: "djezzy",
        sid: formattedPhone,
        timeoutMs: 6e4
      }).catch(() => ({ status: 0, data: null }));
      let res = { statusCode: prodRes.status, data: prodRes.data, raw: prodRes };
      if ((prodRes.status === 401 || prodRes.data && typeof prodRes.data === "object" && (prodRes.data.error === "invalid_token" || prodRes.data.fault)) && existingUser?.refresh_token) {
        const tokenUpdate = await djezzy.refreshTokenV2(existingUser.refresh_token).catch(() => null);
        if (tokenUpdate?.statusCode === 200 && tokenUpdate?.data?.access_token) {
          accessToken = tokenUpdate.data.access_token;
          await updateUserTokens(env, phoneNumber, accessToken, tokenUpdate.data.refresh_token || existingUser.refresh_token);
          prodRes = await httpRequest(env, {
            method: "POST",
            url: `${NEW_API_BASE2}/subscribers/activate-product/${formattedPhone}`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "User-Agent": "MobileApp/3.0.7",
              Accept: "application/json",
              "Accept-Language": "fr"
            },
            body: prodBody,
            relayKey: "DJEZZY_RELAY_URL",
            useDbProxy: true,
            proxyService: "djezzy",
            sid: formattedPhone,
            timeoutMs: 6e4
          }).catch(() => ({ status: 0, data: null }));
          res = { statusCode: prodRes.status, data: prodRes.data, raw: prodRes };
        }
      }
      if (!((res.statusCode === 200 || res.statusCode === 201) && res.data?.status === 200)) {
        try {
          await env.DB.prepare(
            "INSERT INTO request_logs (created_at, direction, kind, method, url, status_code, sender_psid, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            Date.now(),
            "out",
            "diag:act-paid2g",
            "POST",
            "activate-product",
            res.statusCode || 0,
            sender,
            JSON.stringify({ data: res.data }).slice(0, 2e3)
          ).run();
        } catch (e) {
        }
      }
      if ((res.statusCode === 200 || res.statusCode === 201) && res.data?.status === 200 && res.data?.message === "Product successfully activated") {
        await setCooldown(env, `bot:srv2:${sender}:${phoneNumber}`, rc.botServiceCooldownMs);
        return withFbButton({ text: `✅ تم تفعيل 2Go لمدة 24 ساعة بنجاح!
📱 رقمك: ${mask}
💵 السعر: 100 دج`, quick_replies: back }, platform);
      }
      if (res.statusCode === 402 || res.data?.status === 402) {
        const balance = res.data?.data?.mainBalance;
        const balanceLine = balance != null ? `
💳 رصيدك الحالي: ${Math.floor(Number(balance))} دج` : "";
        const errMsg = res.data?.message && typeof res.data.message === "object" ? res.data.message.ar || res.data.message.fr || res.data.message.en || "رصيدك غير كافي" : res.data?.message || "رصيدك غير كافي";
        return withFbButton({ text: `❌ ${errMsg}${balanceLine}
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      }
      if (res.statusCode === 401 || res.data?.status === 401) {
        return withFbButton({ text: `❌ حسابك غير متاح لشريحة هذا العرض.
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      }
      const errMsg2 = res.data?.message && typeof res.data.message === "object" ? res.data.message.ar || res.data.message.en || "حدث خطأ" : res.data?.message || "حدث خطأ";
      return { text: `❌ ${errMsg2}
رقمك: ${mask}`, quick_replies: back };
    } catch (e) {
      console.error("[Paid 2Go] خطأ:", e.message);
      return { text: `❌ حدث خطأ أثناء محاولة التفعيل ⚠️
رقمك: ${mask}`, quick_replies: back };
    } finally {
      await clearCooldown(env, `paid2g:lock:${phoneNumber}`);
    }
  }
  async function infosimdjezzy(sender, phoneNumber, operator, session) {
    const formattedPhone = `213${String(phoneNumber || "").replace(/^0/, "").trim()}`;
    const mask = formatPhoneNumber(phoneNumber);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || !existingUser.access_token) {
      return {
        text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`,
        quick_replies: gocheckQR(phoneNumber, operator, sender)
      };
    }
    if (String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return {
        text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`,
        quick_replies: gocheckQR(phoneNumber, operator, sender)
      };
    }
    if (!await botServiceCooldown(sender, "infosimdjezzy", phoneNumber, session, 6e4))
      return null;
    return await djezzySimInfoV2(sender, phoneNumber, operator, session, existingUser);
  }
  function parseDjezzySimV2(balanceRes, infoRes, productsRes) {
    const bal = balanceRes?.data?.data || {};
    const cust = bal.customerInformations || infoRes?.data?.data || {};
    const mainBalance = bal.mainBalance != null ? Math.floor(Number(bal.mainBalance)) : "—";
    const due = bal.due ?? null;
    const subType = cust.subscriptionType || {};
    const nameObj = subType.name || {};
    const simName = nameObj.ar || nameObj.fr || nameObj.en || "غير متوفر";
    const connection = cust.connectionType || "غير معروف";
    const status = cust.status || null;
    let activationDate = "غير متوفر";
    let activationTime = "";
    if (cust.activationTime) {
      const dt = new Date(cust.activationTime);
      if (!isNaN(dt)) {
        const p = /* @__PURE__ */ __name2((n) => String(n).padStart(2, "0"), "p");
        activationDate = `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
        activationTime = `${p(dt.getHours())}:${p(dt.getMinutes())}`;
      } else {
        activationDate = String(cust.activationTime).split("T")[0] || "غير متوفر";
      }
    }
    const lines = ["✅ معلومات الشريحة:"];
    lines.push(`💵 الرصيد: ${mainBalance} دج`);
    lines.push(`💳 نوع الشريحة: ${simName}`);
    lines.push(`📶 نوع الاتصال: ${connection}`);
    lines.push(`🗓 تاريخ التفعيل: ${activationDate}${activationTime ? ` ⏰ ${activationTime}` : ""}`);
    return lines.join("\n");
  }
  function renderDjezzyProductsV2(productsRes) {
    const products = productsRes?.data?.data?.products;
    if (!Array.isArray(products) || !products.length)
      return null;
    const lines = ["", "🔹 العروض المفعلة:"];
    for (const p of products) {
      const name = p.commercialName?.ar || p.commercialName?.fr || p.productName || p.name || p.code || "عرض";
      lines.push(`🔸 ${name}`);
      const exp = p.expiryAt || p.expirationDate || p.expiry;
      if (exp)
        lines.push(`📅 الانتهاء: ${String(exp).slice(0, 16).replace("T", " ")}`);
      if (Array.isArray(p.balances)) {
        for (const b of p.balances) {
          const bName = (typeof b.name === "object" ? b.name?.ar || b.name?.fr || "" : b.name) || b.balanceName || "";
          const rem = b.remaining ?? b.remainingAmount ?? b.remainingAmountMB ?? null;
          const tot = b.totalAmount ?? b.total ?? null;
          const unit = b.usageUnit || b.unit || "";
          const remNum = rem != null ? Number(rem) : null;
          const totNum = tot != null ? Number(tot) : null;
          const isData = /internet|data|go|mb|gb|dono/i.test(bName) || /^g[o0]|mb|gb$/i.test(unit);
          const isMinutes = /minutes|minute|min|mcall|مكالم|jaze|جازي/i.test(bName) || /^min/i.test(unit);
          const isSms = /sms|pieces|piece|رسال/i.test(bName) || /^pie/i.test(unit);
          const isCredit = /credit|رصيد|da|dzd|amount/i.test(bName) || /^d[aA]/i.test(unit);
          if (isData && remNum != null && totNum != null) {
            let remGB, totGB;
            if (/go|gb/i.test(unit)) {
              remGB = remNum.toFixed(2);
              totGB = totNum.toFixed(2);
            } else {
              remGB = (remNum / 1024).toFixed(2);
              totGB = (totNum / 1024).toFixed(2);
            }
            lines.push(`🌐 إنترنت: ${remGB} / ${totGB} Go`);
          } else if (isMinutes && remNum != null && totNum != null) {
            lines.push(`📞 مكالمات نحو جازي: ${remNum} / ${totNum} دقيقة`);
          } else if (isSms && remNum != null && totNum != null) {
            lines.push(`💬 رسائل نحو جازي: ${remNum} / ${totNum}`);
          } else if (isCredit && remNum != null && totNum != null) {
            lines.push(`💳 الرصيد: ${remNum} / ${totNum} DA`);
          } else if (remNum != null && totNum != null) {
            lines.push(`   ${bName}: ${remNum} / ${totNum} ${unit}`);
          } else if (remNum != null) {
            lines.push(`   ${bName}: المتبقي ${remNum} ${unit}`);
          }
        }
      }
      lines.push("");
    }
    while (lines.length && !lines[lines.length - 1])
      lines.pop();
    return lines.join("\n");
  }
  async function djezzySimInfoV2(sender, phoneNumber, operator, session, existingUser) {
    const formattedPhone = `213${String(phoneNumber || "").replace(/^0/, "").trim()}`;
    const back = backQR(phoneNumber, operator);
    const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    let accessToken = tokenRes.access_token;
    let balanceRes = await djezzy.getMainBalance(formattedPhone, accessToken).catch(() => ({ statusCode: 0, data: null }));
    let infoRes = await djezzy.getCustomerInformation(formattedPhone, accessToken).catch(() => ({ statusCode: 0, data: null }));
    let productsRes = await djezzy.getConnectedProductsBalances(formattedPhone, accessToken).catch(() => ({ statusCode: 0, data: null }));
    if ([balanceRes, infoRes, productsRes].some((r) => isDjezzyAuthFail(r))) {
      const tokenUpdate = existingUser?.refresh_token ? await djezzy.refreshTokenV2(existingUser.refresh_token).catch(() => null) : null;
      if (tokenUpdate?.statusCode === 200 && tokenUpdate?.data?.access_token) {
        accessToken = tokenUpdate.data.access_token;
        await updateUserTokens(env, phoneNumber, accessToken, tokenUpdate.data.refresh_token || existingUser.refresh_token);
        balanceRes = await djezzy.getMainBalance(formattedPhone, accessToken).catch(() => ({ statusCode: 0, data: null }));
        infoRes = await djezzy.getCustomerInformation(formattedPhone, accessToken).catch(() => ({ statusCode: 0, data: null }));
        productsRes = await djezzy.getConnectedProductsBalances(formattedPhone, accessToken).catch(() => ({ statusCode: 0, data: null }));
      }
    }
    if ([balanceRes, infoRes, productsRes].some((r) => isDjezzyAuthFail(r))) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    if (balanceRes.statusCode === 403 || balanceRes.data && balanceRes.data.blocked) {
      return { text: balanceRes.data?.message || "⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.", quick_replies: back };
    }
    if (balanceRes.statusCode !== 200 || !balanceRes.data) {
      return { text: "❌ حدث خطأ أثناء جلب البيانات، حاول لاحقاً.", quick_replies: back };
    }
    try {
      let text = parseDjezzySimV2(balanceRes, infoRes, productsRes);
      const offers = renderDjezzyProductsV2(productsRes);
      if (offers)
        text += "\n\n" + offers;
      await setCooldown(env, `bot:infosimdjezzy:${sender}:${phoneNumber}`, 6e4);
      return { text, quick_replies: back };
    } catch (e) {
      console.error("[infosimdjezzy-v2] خطأ في التنسيق:", e.message);
      return { text: "❌ حدث خطأ أثناء التنفيذ، حاول لاحقاً.", quick_replies: back };
    }
  }
  async function startInvitationProcess(sender, phoneNumber, operator, session) {
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      await send(
        sender,
        { text: `رقم الهاتف: ${formatPhoneNumber(phoneNumber)} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) },
        session
      );
      return;
    }
    if (!await botServiceCooldown(sender, "startinvite", phoneNumber, session))
      return;
    await setCooldown(env, `bot:startinvite:${sender}:${phoneNumber}`, rc.botServiceCooldownMs);
    session.invite_phone = phoneNumber;
    session.invite_operator = operator;
    session.invite_status = "awaiting_number";
    await send(
      sender,
      { text: `أدخل رقم الهاتف الذي تريد دعوته 👥
رقم هاتفك: ${formatPhoneNumber(phoneNumber)}`, quick_replies: cancelInviteQR(phoneNumber, operator) },
      session
    );
  }
  async function sendInvitation(sender, phoneNumber, invitedNumber, operator, session) {
    const subscriberNumber = phoneNumber.startsWith("0") ? `213${phoneNumber.slice(1)}` : phoneNumber;
    const formattedUserPhone = formatPhoneNumber(phoneNumber);
    const formattedInvitedPhone = formatPhoneNumber(invitedNumber);
    const back = backQR(phoneNumber, operator);
    if (formattedUserPhone === formattedInvitedPhone) {
      return { text: "❌ لا يمكنك دعوة نفسك.", quick_replies: back };
    }
    try {
      const userData = await getUserByPhone(env, phoneNumber);
      if (!userData || !userData.access_token) {
        return { text: "يرجى تحقق أولا", quick_replies: gocheckQR(phoneNumber, operator, sender) };
      }
      let accessToken = userData.access_token;
      const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, userData, session);
      if (!tokenRes.access_token)
        return tokenRes.fbResponse || {};
      accessToken = tokenRes.access_token;
      const receiver213 = `213${String(invitedNumber).replace(/^0/, "")}`;
      const response = await djezzy.sendMgmInvitation(subscriberNumber, accessToken, receiver213);
      if (response.statusCode === 401) {
        await sendVerificationCode(sender, phoneNumber, session);
        return null;
      }
      {
        const vBody = response.data;
        const vStatus = vBody ? Number(vBody.status) : NaN;
        if (vStatus === 200) {
          return {
            text: `تم إرسال الدعوة بنجاح! 🎉
رقم هاتفك: ${formattedUserPhone}
رقم المدعو: ${formattedInvitedPhone}

🎁 سيحصل كل منكما على هدية عند تفعيل الدعوة.`,
            quick_replies: back
          };
        }
        if (vStatus >= 400) {
          const msg = vBody && typeof vBody.message === "string" && vBody.message ? vBody.message : "";
          if (vStatus === 408) {
            return {
              text: `تم تجاوز الحد الأقصى لعدد الدعوات ❌
رقم هاتفك: ${formattedUserPhone}
رقم المدعو: ${formattedInvitedPhone}${msg ? `
${msg}` : ""}`,
              quick_replies: back
            };
          }
          return { text: msg || `فشل إرسال الدعوة ❌
رقم هاتفك: ${formattedUserPhone}
رقم المدعو: ${formattedInvitedPhone}

يرجى المحاولة لاحقًا.`, quick_replies: back };
        }
        if (response.statusCode === 200) {
          return {
            text: `تم إرسال الدعوة بنجاح! 🎉
رقم هاتفك: ${formattedUserPhone}
رقم المدعو: ${formattedInvitedPhone}

🎁 سيحصل كل منكما على هدية عند تفعيل الدعوة.`,
            quick_replies: back
          };
        }
        return {
          text: `فشل إرسال الدعوة ❌ 
رقم هاتفك: ${formattedUserPhone}
رقم المدعو: ${formattedInvitedPhone}

يرجى المحاولة لاحقًا.`,
          quick_replies: back
        };
      }
    } catch (e) {
      console.error("[دعوة] خطأ:", e.message);
      return { text: "حدث خطأ غير متوقع ❌ \nيرجى المحاولة مرة أخرى لاحقًا ⚠️ ", quick_replies: back };
    }
  }
  function formatMgmReceiver(msisdn) {
    const s = String(msisdn || "");
    return s.startsWith("213") ? `0${s.slice(3)}` : s;
  }
  function mgmStatusLabel(status) {
    if (status === "DONE")
      return "مقبولة ✔️";
    if (status === "PENDING")
      return "قيد الانتظار ⏳";
    return status || "غير معروف";
  }
  async function showMyInvitations(sender, phoneNumber, operator, session) {
    const mask = formatPhoneNumber(phoneNumber);
    const back = backQR(phoneNumber, operator);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || !existingUser.access_token) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (!await botServiceCooldown(sender, "myinvites", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const formattedPhone = `213${String(phoneNumber).replace(/^0/, "")}`;
    const res = await djezzy.getMgmInvitations(formattedPhone, tokenRes.access_token).catch(() => ({ statusCode: 0, data: null }));
    if (res.data && res.data.blocked) {
      return { text: res.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: back };
    }
    if (res.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    if (res.statusCode !== 200 || !res.data) {
      return { text: "❌ حدث خطأ أثناء جلب الدعوات، حاول لاحقاً.", quick_replies: back };
    }
    await setCooldown(env, `bot:myinvites:${sender}:${phoneNumber}`, 6e4);
    const invitations = res.data?.data?.invitations;
    if (!Array.isArray(invitations) || !invitations.length) {
      return { text: `📭 لا توجد دعوات مرسلة.
📱 رقم هاتفك: ${mask}`, quick_replies: back };
    }
    const lines = [`📱 رقم هاتفك: ${mask}`, "", "👥 الدعوات المرسلة:"];
    const actions = [];
    invitations.forEach((inv) => {
      const receiverFmt = formatMgmReceiver(inv.msisdnReceiver);
      const sentDate = inv.smsSendAt ? String(inv.smsSendAt).slice(0, 10) : "";
      lines.push(`🔹 ${receiverFmt} — ${mgmStatusLabel(inv.status)}${sentDate ? ` (أُرسلت ${sentDate})` : ""}`);
      if (inv.status !== "DONE") {
        actions.push({
          content_type: "text",
          title: `❌ إلغاء ${receiverFmt}`,
          payload: `delmgm:${phoneNumber}:${operator}:${inv.msisdnReceiver}`,
          full_row: true
        });
        actions.push({
          content_type: "text",
          title: `🔄 إعادة SMS ${receiverFmt}`,
          payload: `resendmgm:${phoneNumber}:${operator}:${inv.msisdnReceiver}`,
          full_row: true
        });
      }
    });
    lines.push("", "يمكنك إلغاء الدعوات غير المقبولة.");
    let rewardText = "";
    try {
      const offersRes = await djezzy.getCustomerOffers(formattedPhone, tokenRes.access_token, "MGM").catch(() => null);
      if (offersRes && offersRes.statusCode === 200 && offersRes.data) {
        const offersData = offersRes.data?.data;
        if (Array.isArray(offersData) && offersData.length) {
          const eligible = offersData.flatMap((cat) => (cat.subcategories || []).flatMap((sub) => sub.packages || []).filter((pkg) => pkg.isEligible && pkg.show));
          if (eligible.length) {
            const pkgName = eligible[0].commercialName?.ar || eligible[0].code;
            rewardText = "\n\n🎁 يوجد مكافآة متاحة: " + pkgName + "\nاضغط إعضاء للتفعيل من الأسفل.";
            actions.push({ content_type: "text", title: "🎁 تفعيل المكافآة", payload: "claimmgm:" + phoneNumber + ":" + operator, full_row: true });
          }
        }
      }
    } catch (_) {
    }
    if (rewardText)
      lines.push(rewardText);
    return { text: lines.join("\n"), quick_replies: [...actions, ...back] };
  }
  async function claimMgmReward(sender, phoneNumber, operator, session) {
    const mask = formatPhoneNumber(phoneNumber);
    const back = backQR(phoneNumber, operator);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || !existingUser.access_token) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملغىتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملغىتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (!await botServiceCooldown(sender, "claimmgm", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const accessToken = tokenRes.access_token;
    const formattedPhone = `213${String(phoneNumber).replace(/^0/, "")}`;
    const offersRes = await djezzy.getCustomerOffers(formattedPhone, accessToken, "MGM").catch(() => ({ statusCode: 0, data: null }));
    if (offersRes.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    if (offersRes.statusCode !== 200 || !offersRes.data) {
      return { text: "❌ حدث خطأ أثناء جلب المكافآت.", quick_replies: back };
    }
    await setCooldown(env, `bot:claimmgm:${sender}:${phoneNumber}`, 6e4);
    const offersData = offersRes.data?.data;
    if (!Array.isArray(offersData) || !offersData.length) {
      return { text: `📭 لا توجد مكافآت متاحة للتفعيل.
📱 رقم الهاتف: ${mask}`, quick_replies: back };
    }
    const eligiblePkg = offersData.flatMap((cat) => (cat.subcategories || []).flatMap((sub) => sub.packages || []).filter((pkg) => pkg.isEligible && pkg.show))[0];
    if (!eligiblePkg) {
      return { text: `📭 لا توجد مكافآت متاحة للتفعيل.
📱 رقم الهاتف: ${mask}`, quick_replies: back };
    }
    const pkgName = eligiblePkg.commercialName?.ar || eligiblePkg.code || "المكافآة";
    const activateRes = await djezzy.activateMgmReward(formattedPhone, accessToken, eligiblePkg.code).catch(() => ({ statusCode: 0, data: null }));
    if (activateRes.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    const vStatus = activateRes.data ? Number(activateRes.data.status) : NaN;
    if (vStatus === 200 || activateRes.statusCode === 200) {
      return { text: `✅ تم تفعيل المكافآة بنجاح!
📱 رقمك: ${mask}
🎁 ${pkgName}`, quick_replies: back };
    }
    const errMsg = activateRes.data?.message && typeof activateRes.data.message === "string" ? activateRes.data.message : "فشل تفعيل المكافآة ❌";
    return { text: `${errMsg}
📱 رقمك: ${mask}`, quick_replies: back };
  }
  async function deleteMgmInvitation(sender, phoneNumber, operator, receiver213, session) {
    const mask = formatPhoneNumber(phoneNumber);
    const receiverFmt = formatMgmReceiver(receiver213);
    const back = backQR(phoneNumber, operator);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || !existingUser.access_token) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (!await botServiceCooldown(sender, "delmgm", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const formattedPhone = `213${String(phoneNumber).replace(/^0/, "")}`;
    const res = await djezzy.deleteMgmInvitation(formattedPhone, tokenRes.access_token, receiver213).catch(() => ({ statusCode: 0, data: null }));
    if (res.data && res.data.blocked) {
      return { text: res.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: back };
    }
    if (res.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    await setCooldown(env, `bot:delmgm:${sender}:${phoneNumber}`, 6e4);
    const vStatus = res.data ? Number(res.data.status) : NaN;
    if (vStatus === 200) {
      return { text: `✅ تم إلغاء دعوة ${receiverFmt} بنجاح!`, quick_replies: back };
    }
    if (vStatus >= 400 && res.data && typeof res.data.message === "string" && res.data.message) {
      return { text: res.data.message, quick_replies: back };
    }
    return { text: `❌ فشل إلغاء دعوة ${receiverFmt}، حاول لاحقًا.`, quick_replies: back };
  }
  async function resendMgmInvitation(sender, phoneNumber, operator, receiver213, session) {
    const mask = formatPhoneNumber(phoneNumber);
    const receiverFmt = formatMgmReceiver(receiver213);
    const back = backQR(phoneNumber, operator);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || !existingUser.access_token) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return { text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`, quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (!await botServiceCooldown(sender, "resendmgm", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const formattedPhone = `213${String(phoneNumber).replace(/^0/, "")}`;
    const res = await djezzy.resendMgmSms(formattedPhone, tokenRes.access_token, receiver213).catch(() => ({ statusCode: 0, data: null }));
    if (res.data && res.data.blocked) {
      return { text: res.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: back };
    }
    if (res.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    await setCooldown(env, `bot:resendmgm:${sender}:${phoneNumber}`, 6e4);
    const vStatus = res.data ? Number(res.data.status) : NaN;
    if (vStatus === 200) {
      return { text: `✅ تم إعادة إرسال SMS الدعوة إلى ${receiverFmt}.`, quick_replies: back };
    }
    if (vStatus >= 400 && res.data && typeof res.data.message === "string" && res.data.message) {
      return { text: res.data.message, quick_replies: back };
    }
    return { text: `❌ فشل إعادة إرسال SMS إلى ${receiverFmt}، حاول لاحقًا.`, quick_replies: back };
  }
  async function prepareInternetPackageConfirmation(sender, phoneNumber, operator, session) {
    const mask = formatPhoneNumber(phoneNumber);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return {
        text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملكيتك لهذا الرقم ❌`,
        quick_replies: gocheckQR(phoneNumber, operator, sender)
      };
    }
    if (!await botServiceCooldown(sender, "srv1", phoneNumber, session))
      return null;
    return {
      text: `✅ العرض: 4Go لمدة 24 ساعة - 70 دج
📱 رقمك: ${mask}
💵 السعر: 70 دج

هل تريد التفعيل الآن؟`,
      quick_replies: [
        {
          content_type: "text",
          title: "✅ نعم، فعل العرض",
          payload: `confirminternet:${phoneNumber}:${operator}:BTLINTSPEEDDAY2Go:${sender}`
        },
        ...backQR(phoneNumber, operator)
      ]
    };
  }
  async function executeInternetPackageActivation(sender, phoneNumber, operator, session) {
    const formattedPhone = `213${String(phoneNumber || "").replace(/^0/, "").trim()}`;
    const mask = formatPhoneNumber(phoneNumber);
    const back = backQR(phoneNumber, operator);
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || !existingUser.access_token) {
      return { text: "❌ لم يتم العثور على جلسة لهذا الرقم.\nيرجى التحقق أولاً.", quick_replies: gocheckQR(phoneNumber, operator, sender) };
    }
    if (String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return {
        text: `رقم الهاتف: ${mask} 📞
يرجى التحقق من ملغىتك لهذا الرقم ❌`,
        quick_replies: gocheckQR(phoneNumber, operator, sender)
      };
    }
    const lock = await checkAndSetCooldown(env, `srv1:lock:${phoneNumber}`, 12e4);
    if (!lock.ok) {
      return { text: "⏳ جاري تنفيذ العملية، الرجاء الانتظار قليلاً...", quick_replies: back };
    }
    try {
      const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
      if (!tokenRes.access_token)
        return tokenRes.fbResponse || {};
      let accessToken = tokenRes.access_token;
      const prodBody = JSON.stringify({ packageCode: "BTLINTSPEEDDAY2Go", offerId: 30199 });
      let prodRes = await httpRequest(env, {
        method: "POST",
        url: `${NEW_API_BASE2}/subscribers/activate-product/${formattedPhone}`,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "MobileApp/3.0.7",
          Accept: "application/json",
          "Accept-Language": "fr"
        },
        body: prodBody,
        relayKey: "DJEZZY_RELAY_URL",
        useDbProxy: true,
        proxyService: "djezzy",
        sid: formattedPhone,
        timeoutMs: 6e4
      }).catch(() => ({ status: 0, data: null }));
      let res = { statusCode: prodRes.status, data: prodRes.data, raw: prodRes };
      if ((prodRes.status === 401 || prodRes.data && typeof prodRes.data === "object" && (prodRes.data.error === "invalid_token" || prodRes.data.fault)) && existingUser?.refresh_token) {
        const tokenUpdate = await djezzy.refreshTokenV2(existingUser.refresh_token).catch(() => null);
        if (tokenUpdate?.statusCode === 200 && tokenUpdate?.data?.access_token) {
          accessToken = tokenUpdate.data.access_token;
          await updateUserTokens(env, phoneNumber, accessToken, tokenUpdate.data.refresh_token || existingUser.refresh_token);
          prodRes = await httpRequest(env, {
            method: "POST",
            url: `${NEW_API_BASE2}/subscribers/activate-product/${formattedPhone}`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
              "User-Agent": "MobileApp/3.0.7",
              Accept: "application/json",
              "Accept-Language": "fr"
            },
            body: prodBody,
            relayKey: "DJEZZY_RELAY_URL",
            useDbProxy: true,
            proxyService: "djezzy",
            sid: formattedPhone,
            timeoutMs: 6e4
          }).catch(() => ({ status: 0, data: null }));
          res = { statusCode: prodRes.status, data: prodRes.data, raw: prodRes };
        }
      }
      if (!((res.statusCode === 200 || res.statusCode === 201) && res.data?.status === 200)) {
        try {
          await env.DB.prepare(
            "INSERT INTO request_logs (created_at, direction, kind, method, url, status_code, sender_psid, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            Date.now(),
            "out",
            "diag:act-srv1",
            "POST",
            "activate-product",
            res.statusCode || 0,
            sender,
            JSON.stringify({ data: res.data }).slice(0, 2e3)
          ).run();
        } catch (e) {
        }
      }
      if ((res.statusCode === 200 || res.statusCode === 201) && res.data?.status === 200 && res.data?.message === "Product successfully activated") {
        await setCooldown(env, `bot:srv1:${sender}:${phoneNumber}`, rc.botServiceCooldownMs);
        await updateActivationDate(env, phoneNumber);
        return withFbButton({ text: `✅ تم تفعيل 4Go لمدة 24 ساعة بنجاح!
📱 رقمك: ${mask}
💵 السعر: 70 دج`, quick_replies: back }, platform);
      }
      if (res.statusCode === 402 || res.data?.status === 402) {
        const balance = res.data?.data?.mainBalance;
        const balanceLine = balance != null ? `
💳 رصيدك الحالي: ${Math.floor(Number(balance))} دج` : "";
        const errMsg = res.data?.message && typeof res.data.message === "object" ? res.data.message.ar || res.data.message.fr || res.data.message.en || "رصيدك غير كافي" : res.data?.message || "رصيدك غير كافي";
        return withFbButton({ text: `❌ ${errMsg}${balanceLine}
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      }
      if (res.statusCode === 401 || res.data?.status === 401) {
        return withFbButton({ text: `❌ حسابك غير متاح لشريحة هذا العرض.
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      }
      const errMsg2 = res.data?.message && typeof res.data.message === "object" ? res.data.message.ar || res.data.message.en || "حدث خطأ" : res.data?.message || "حدث خطأ";
      return { text: `❌ ${errMsg2}
رقمك: ${mask}`, quick_replies: back };
    } catch (e) {
      console.error("[عرض 4Go] خطأ:", e.message);
      return { text: `❌ حدث خطأ أثناء محاولة التفعيل ⚠️
رقمك: ${mask}`, quick_replies: back };
    } finally {
      await clearCooldown(env, `srv1:lock:${phoneNumber}`);
    }
  }
  async function showOoredooOffers(sender, inputPhone, operator, session) {
    const byopNames = { IG: "انستغرام", YT: "يوتيوب", WA: "واتساب", FB: "فيسبوك" };
    const byopTtName = "تيك توك 2Go";
    const byopAllCodes = [...ooredoo.BYOP_CODES, ...ooredoo.BYOP_LIMITED_CODES];
    const byopColors = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫", "⚪", "🔶", "🔷", "🟥"];
    const byopNameOf = (code) => byopNames[code] || (ooredoo.BYOP_LIMITED_CODES.includes(code) ? byopTtName : code);
    const byopButtons = byopAllCodes.map((code) => ({
      content_type: "text",
      title: `${byopNameOf(code)} 100دج`,
      payload: `obyopcode:${inputPhone}:${operator}:${code}`
    }));
    const byopBody = byopAllCodes.map((code, i) => {
      const color = byopColors[i % byopColors.length];
      const internet = ooredoo.BYOP_LIMITED_CODES.includes(code) ? "2Go فقط" : "غير محدود";
      return `${i + 1}- ${byopNameOf(code)}\n${color} • 100 دج 💸\n🌐 • إنترنت : ${internet}\n🗓️ • مدة : أسبوعين`;
    }).join("\n\n");
    const offersText = `🛍️ عروض مخصصة 🏷️\n📱 الرقم: ${maskOoredooPhone(inputPhone)}\n\n${byopBody}\n\nاختر العرض المناسب من الأزرار أدناه 🔽`;
    const pubReplies = [...byopButtons, ...backQR(inputPhone, operator)];
    await send(sender, { text: offersText, quick_replies: pubReplies }, session);
  }
  async function djezzyOwnershipCheck(sender, phoneNumber) {
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || String(existingUser.chat_id || "").trim() !== String(sender).trim())
      return { ok: false, user: existingUser };
    return { ok: true, user: existingUser };
  }

  // بدل رسالة «تحقق من ملكيتك» + زر: نرسل رمز التحقق تلقائيًا ونترك المستخدم يُكمل بالرمز.
  // pendingPayload يجعل البوت يعود لنفس الشاشة (قائمة العروض أو بطاقة التأكيد) بعد نجاح التحقق.
  async function djezzyAutoVerify(sender, phoneNumber, session, pendingPayload) {
    // نستبدل أي دفعة معلّقة سابقًا (قد تكون زر تفعيل يخصم المال) بشاشة العرض الآمنة،
    // حتى لو تعذّر إرسال الرمز الآن فتبقى العودة للبطاقة لا للتفعيل.
    session.pendingPayload = pendingPayload;
    await saveSession(env, session);
    const gate = await checkAndSetCooldown(env, `djverify:${sender}:${phoneNumber}`, 3 * 60e3);
    if (!gate.ok) {
      const minutes = Math.max(1, Math.ceil(gate.leftMs / 6e4));
      await send(
        sender,
        {
          text: `⏳ سبق أن أرسلنا رمز تحقق إلى هذا الرقم.
أدخل الرمز الذي وصلك، أو أعد إرسال رقمك بعد ${minutes} دقيقة.`
        },
        session
      );
      return;
    }
    await sendVerificationCode(sender, phoneNumber, session, pendingPayload);
  }

  async function prepareDjezzyShakeOffer(sender, phoneNumber, operator, session, code) {
    const offer = DJEZZY_SHAKE_OFFERS[code];
    if (!offer) return null;
    const mask = formatPhoneNumber(phoneNumber);
    const chk = await djezzyOwnershipCheck(sender, phoneNumber);
    if (!chk.ok) {
      await djezzyAutoVerify(sender, phoneNumber, session, `djshake:${phoneNumber}:${operator}:${code}:${sender}`);
      return null;
    }
    if (!await botServiceCooldown(sender, `djshake-${code}`, phoneNumber, session)) return null;
    return {
      text: `✅ العرض: ${offer.label} (${offer.data}) لمدة ${offer.duration}
📱 رقمك: ${mask}
💵 السعر: ${offer.price} دج

هل تريد التفعيل الآن؟`,
      quick_replies: [
        { content_type: "text", title: "✅ نعم، فعل العرض", payload: `djshakeok:${phoneNumber}:${operator}:${code}:${sender}` },
        ...backQR(phoneNumber, operator)
      ]
    };
  }

  async function executeDjezzyShakeOffer(sender, phoneNumber, operator, session, code) {
    const offer = DJEZZY_SHAKE_OFFERS[code];
    const mask = formatPhoneNumber(phoneNumber);
    const back = backQR(phoneNumber, operator);
    if (!offer) return { text: "❌ عرض غير معروف.", quick_replies: back };
    const formattedPhone = `213${String(phoneNumber || "").replace(/^0/, "").trim()}`;
    const chk = await djezzyOwnershipCheck(sender, phoneNumber);
    if (!chk.ok) {
      await djezzyAutoVerify(sender, phoneNumber, session, `djshake:${phoneNumber}:${operator}:${code}:${sender}`);
      return null;
    }
    const existingUser = chk.user;
    if (!existingUser.access_token) {
      await djezzyAutoVerify(sender, phoneNumber, session, `djshake:${phoneNumber}:${operator}:${code}:${sender}`);
      return null;
    }

    const lock = await checkAndSetCooldown(env, `djshake-${code}:lock:${phoneNumber}`, 12e4);
    if (!lock.ok) return { text: "⏳ جاري تنفيذ العملية، الرجاء الانتظار قليلاً...", quick_replies: back };
    try {
      const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
      if (!tokenRes.access_token) return tokenRes.fbResponse || {};
      let token = tokenRes.access_token;
      // جلب كتالوج العروض الحيّ من customer-offers لتحديث packageCode/offerId الفعليين
      // عند كل تفعيل (فحص مجاني/قراءة فقط). لو فشل، نقع على القيم الثابتة.
      let effectiveCode = code;
      let effectiveOfferId = offer.cvmOfferId;
      const liveFetch = await djezzy.getCustomerOffers(formattedPhone, token, "STANDARD,SURPRISE").catch(() => ({ statusCode: 0, data: null }));
      if (liveFetch?.statusCode === 200 && liveFetch?.data) {
        const parsedLive = parseDjezzyOffers(liveFetch.data);
        const found = [...parsedLive.imtiyaz, ...parsedLive.internet].find((o) => o.code === code);
        if (found) {
          effectiveCode = found.code;
          if (found.offerId != null) effectiveOfferId = found.offerId;
        }
      }
      const trace = [];
      const callApis = async (accessToken) => {
        if (offer.kind === "internet") {
          const direct = await djezzy.activateProductApp(formattedPhone, accessToken, effectiveCode, effectiveOfferId).catch(() => ({ statusCode: 0, data: null }));
          trace.push({ api: "activate-product", http: direct?.statusCode, body: direct?.data });
          return direct;
        }
        const shake = await djezzy.activateShake(formattedPhone, accessToken, effectiveCode).catch(() => ({ statusCode: 0, data: null }));
        const shakeBodyStatus = Number(shake?.data?.status) || 0;
        trace.push({ api: "services/shake", http: shake?.statusCode, body: shake?.data });
        if (![403, 404].includes(Number(shake?.statusCode)) && shakeBodyStatus !== 404) return shake;
        console.log(`[djshake] ${code} shake=${shake?.statusCode}/${shakeBodyStatus} -> activate-product`);
        const viaProduct = await djezzy.activateProductApp(formattedPhone, accessToken, effectiveCode, effectiveOfferId).catch(() => ({ statusCode: 0, data: null }));
        trace.push({ api: "activate-product", http: viaProduct?.statusCode, body: viaProduct?.data });
        return viaProduct;
      };
      let res = await callApis(token);
      if (isDjezzyAuthFail(res) && existingUser?.refresh_token) {
        const tokenUpdate = await djezzy.refreshTokenV2(existingUser.refresh_token).catch(() => null);
        if (tokenUpdate?.statusCode === 200 && tokenUpdate?.data?.access_token) {
          await updateUserTokens(env, phoneNumber, tokenUpdate.data.access_token, tokenUpdate.data.refresh_token || existingUser.refresh_token);
          token = tokenUpdate.data.access_token;
          res = await callApis(token);
        }
      }
      const statusCode = res?.statusCode || 0;
      const data = res?.data;
      const dataIsString = typeof data === "string";
      const bodyStatus = Number(data?.status) || 0;
      const success = (statusCode === 200 || statusCode === 201) && [200, 201, 202].includes(bodyStatus);
      if (!success) {
        try {
          await env.DB.prepare(
            "INSERT INTO request_logs (created_at, direction, kind, method, url, status_code, sender_psid, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            Date.now(),
            "out",
            "diag:djshake",
            "POST",
            "services/shake",
            statusCode,
            sender,
            JSON.stringify({ code, effectiveCode, effectiveOfferId, trace, data }).slice(0, 2e3)
          ).run();
        } catch (e) {}
      }
      if (success) {
        await setCooldown(env, `bot:djshake-${code}:${sender}:${phoneNumber}`, rc.botServiceCooldownMs);
        await updateActivationDate(env, phoneNumber);
        return withFbButton({
          text: `✅ تم تفعيل ${offer.label} (${offer.data}) لمدة ${offer.duration} بنجاح!
📱 رقمك: ${mask}
💵 السعر: ${offer.price} دج`,
          quick_replies: back
        }, platform);
      }
      if (res?.data?.blocked)
        return withFbButton({ text: `⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      if (statusCode === 0 || (statusCode >= 500 && statusCode <= 599) || dataIsString && /INVALID_ZONE|invalid zone|Request Rejected/i.test(data))
        return withFbButton({ text: `⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      if (statusCode === 402 || bodyStatus === 402) {
        const balance = data?.data?.mainBalance;
        const balanceLine = balance != null ? `
💳 رصيدك الحالي: ${Math.floor(Number(balance))} دج` : "";
        return withFbButton({
          text: `❌ ${pickLocalized(data?.message, "رصيدك غير كافي")}${balanceLine}
📱 رقمك: ${mask}`,
          quick_replies: back
        }, platform);
      }
      if (statusCode === 401 || bodyStatus === 401) {
        await sendVerificationCode(sender, phoneNumber, session);
        return null;
      }
      if (statusCode === 404 || bodyStatus === 404)
        return withFbButton({ text: `العرض (${offer.label} ${offer.data}) غير متوفر حاليًا ❎
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      if ((statusCode === 403 || bodyStatus === 403) && dataIsString && /<html|<!doctype/i.test(data))
        return withFbButton({ text: `⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      if (statusCode === 403 || bodyStatus === 403)
        return withFbButton({ text: `رقمك غير مؤهل لعرض (${offer.label} ${offer.data}) ❎
📱 رقمك: ${mask}`, quick_replies: back }, platform);
      const errMsg3 = dataIsString ? "" : pickLocalized(data?.message, "");
      return withFbButton({ text: `❌ ${errMsg3 || "حدث خطأ أثناء محاولة التفعيل"}
📱 رقمك: ${mask}`, quick_replies: back }, platform);
    } catch (e) {
      console.error("[عرض امتياز]", code, "خطأ:", e.message);
      return { text: `❌ حدث خطأ أثناء محاولة التفعيل ⚠️
رقمك: ${mask}`, quick_replies: back };
    } finally {
      await clearCooldown(env, `djshake-${code}:lock:${phoneNumber}`);
    }
  }

  async function showDjezzyOffersMenu(sender, phoneNumber, operator, session) {
    const mask = formatPhoneNumber(phoneNumber);
    const chk = await djezzyOwnershipCheck(sender, phoneNumber);
    if (!chk.ok) {
      await djezzyAutoVerify(sender, phoneNumber, session, `djoffers:${phoneNumber}:${operator}:${sender}`);
      return null;
    }
    const existingUser = chk.user;
    if (!existingUser.access_token) {
      await djezzyAutoVerify(sender, phoneNumber, session, `djoffers:${phoneNumber}:${operator}:${sender}`);
      return null;
    }
    // بناء القائمة من الكتالوج الحي للرقم (امتياز + إنترنت) ليعرض فقط ما يملكه الرقم فعلاً،
    // مع التراجع للقائمة الثابتة إذا تعذر الجلب أو كان الكتالوج فارغاً.
    const formattedPhone = `213${String(phoneNumber || "").replace(/^0/, "").trim()}`;
    const tokenRes = await getDjezzyFreshToken(sender, phoneNumber, operator, existingUser, session);
    let live = null;
    if (tokenRes?.access_token) {
      const liveFetch = await djezzy.getCustomerOffers(formattedPhone, tokenRes.access_token, "STANDARD,SURPRISE").catch(() => ({ statusCode: 0, data: null }));
      if (liveFetch?.statusCode === 200 && liveFetch?.data) {
        const parsed = parseDjezzyOffers(liveFetch.data);
        if (parsed.imtiyaz.length || parsed.internet.length) live = parsed;
      }
    }
    let text;
    let buttons;
    if (live) {
      const colors = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤"];
      const card = (o, i) => {
        const rows = [`${i + 1}- ${o.name || o.code}`, `${colors[i % colors.length]} • ${o.price} دج 💸`];
        if (o.data) rows.push(`🌐 • إنترنت : ${o.data}`);
        if (o.duration) rows.push(`🗓️ • مدة : ${o.duration}`);
        return rows.join("\n");
      };
      const items = [...live.imtiyaz, ...live.internet].sort((a, b) => a.price - b.price);
      const body = items.map((o, i) => card(o, i)).join("\n\n");
      text = `🛍️ عروض 🏷️
📱 الرقم: ${mask}

${body}

اختر العرض المناسب من الأزرار أدناه 🔽`;
      buttons = items.map((o) => ({ code: o.code, title: `${o.price} دج - ${o.data || o.name} - ${o.duration}` }));
    } else {
      const fallback = buildDjezzyOffersMessage(mask);
      text = fallback.text;
      buttons = fallback.buttons;
    }
    const quick_replies = [
      ...buttons.map((b) => ({
        content_type: "text",
        title: b.title,
        payload: `djshake:${phoneNumber}:${operator}:${b.code}:${sender}`,
        full_row: true
      })),
      ...backQR(phoneNumber, operator)
    ];
    return { text, quick_replies: quick_replies };
  }

  async function showServicesMenu(sender, inputPhone, operator, session) {
    let quickReplies = [];
    let statusLines = [];
    if (operator === "ooredoo") {
      const userRow = await getUserByPhone(env, inputPhone);
      const storedToken = userRow?.access_token || null;
      const snapClaim = storedToken ? decodeJwtPayload(storedToken)?.ratePlan : null;
      const snapchatSupported = ooredooPlanSupports(env, snapClaim, "OOREDOO_SNAPCHAT_PLANS", "N'YOOZ,682,736");
      const stamps = await getOoredooTimestamps(env, inputPhone);
      const giftKnown = stamps.gamification_played_at != null;
      const snapKnown = stamps.snapchat_activated_at != null;
      const lines = [`📱 رقم الهاتف: ${maskOoredooPhone(inputPhone)}`];
      const actionButtons = [];
      const lastGift = Number(stamps.gamification_played_at) || 0;
      const giftReady = ooredooGiftReady(lastGift);
      if (giftKnown && !giftReady) {
        lines.push("", `🎁 الهدية اليومية: تعود بعد ${ooredooGiftRemaining(lastGift)} 🕑`);
      } else {
        actionButtons.push({ content_type: "text", title: "الهدية اليومية 🎁", payload: `ogift:${inputPhone}:${operator}` });
      }
      if (snapchatSupported) {
        if (snapKnown) {
          lines.push("", "👻 سناب شات: مفعّل ✔️");
        } else {
          actionButtons.push({ content_type: "text", title: "تفعيل سناب شات 👻", payload: `osnap:${inputPhone}:${operator}:${sender}` });
        }
      }
      lines.push("", "🗳 اختر الخدمة التي تريدها");
      statusLines = lines;
      const serviceButtons = [
        ...actionButtons,
      ];
      quickReplies = [
        ...serviceButtons,
        { content_type: "text", title: "معلومات الشريحة ℹ", payload: `oaccount:${inputPhone}:${operator}:${sender}` },
        { content_type: "text", title: "📦 العروض", payload: `obundles:${inputPhone}:${operator}:${sender}` }
      ];
    } else {
      const djezzyUser = await getUserByPhone(env, inputPhone);
      const lastActivation = Number(djezzyUser?.activation_date) || 0;
      const weekMs = ACTIVATE_2G_COOLDOWN_MS;
      const twoGoReady = !lastActivation || (Date.now() - lastActivation >= weekMs);
      const djezzyActionButtons = [];
      const djezzyStatusLines = [];
      if (!twoGoReady) {
        const remaining = weekMs - (Date.now() - lastActivation);
        const rDays = Math.floor(remaining / (24 * 60 * 60 * 1000));
        const rHours = Math.floor((remaining % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        const rMins = Math.ceil((remaining % (60 * 60 * 1000)) / (60 * 1000));
        const rParts = [];
        if (rDays > 0) rParts.push(`${rDays} أيام`);
        if (rHours > 0) rParts.push(`${rHours} ساعات`);
        if (rMins > 0 && rDays === 0) rParts.push(`${rMins} دقيقة`);
        djezzyStatusLines.push("", `🎉 2 جيغا الاسبوعية: تعود بعد ${rParts.join(" و ")} 🕑`);
      } else {
        djezzyActionButtons.push({ content_type: "text", title: "تفعيل 2Go 🎉", payload: `activate2G:${inputPhone}:${operator}`, full_row: true });
      }
      djezzyActionButtons.push({ content_type: "text", title: "معلومات الشريحة ℹ", payload: `infosimdjezzy:${inputPhone}:${operator}:${sender}`, full_row: true });
      if (isTg) djezzyActionButtons.push({ content_type: "text", title: "👥 دعوة", payload: `mgm-menu:${inputPhone}:${operator}`, full_row: true });
      if (djezzyExperiments) djezzyActionButtons.push({ content_type: "text", title: "🛍️ عروض 🏷️", payload: `djoffers:${inputPhone}:${operator}:${sender}`, full_row: true });
      if (djezzyStatusLines.length) {
        djezzyStatusLines.push("", "🗳 اختر الخدمة التي تريدها");
        statusLines = [...(statusLines.length ? statusLines : [`📱 رقم الهاتف: ${formatPhoneNumber(inputPhone)}`]), ...djezzyStatusLines];
      }
      quickReplies = djezzyActionButtons;
    }
    const text = statusLines.length ? statusLines.join("\n") : `📱 رقم الهاتف: ${formatPhoneNumber(inputPhone)}
🗳 اختر الخدمة التي تريدها`;
    session.phone = inputPhone;
    session.operator = operator;
    session.stage = "verified";
    const numbered = numberedServiceLines(quickReplies);
    const finalText = numbered ? `${text}\n\n${numbered}` : text;
    await send(sender, { text: finalText, quick_replies: quickReplies }, session);
  }
  // قائمة فرعية للعروض: زر واحد في القائمة الرئيسية يفتح هذه القائمة بثلاثة أزرار.
  async function showBundlesSubmenu(sender, inputPhone, operator, session) {
    const lines = [`📦 العروض\n📱 رقم الهاتف: ${maskOoredooPhone(inputPhone)}`, "", "🗳 اختر نوع العرض:"];
    const quick_replies = [
      { content_type: "text", title: "🛍️ عروض مخصصة", payload: `oservices:${inputPhone}:${operator}:${sender}` },
      { content_type: "text", title: "💎 عروض حصرية", payload: `oexclusive:${inputPhone}:${operator}:${sender}` },
      { content_type: "text", title: "💝 عروض وفاء", payload: `oloyalty:${inputPhone}:${operator}:${sender}` },
      ...backQR(inputPhone, operator)
    ];
    const numbered = numberedServiceLines(quick_replies);
    const text = numbered ? `${lines.join("\n")}\n\n${numbered}` : lines.join("\n");
    await send(sender, { text, quick_replies }, session);
  }
  const OOREDOO_PLAN_NAMES = { "736": "N'YOOZ", "682": "682", "654": "654", "DIMAN": "DIMA", "DIMA": "DIMA" };
  function resolveOoredooPlanName(ratePlan) {
    if (!ratePlan) return "غير معروف";
    const upper = String(ratePlan).toUpperCase().replace(/[^A-Z0-9]/g, "");
    return OOREDOO_PLAN_NAMES[upper] || ratePlan;
  }
  function ooredooPlanSupports(env2, ratePlan, key, def) {
    if (!ratePlan)
      return true;
    const supported = String(env2[key] || def).split(",").map((s) => s.trim()).filter(Boolean);
    const norm = /* @__PURE__ */ __name2((s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, ""), "norm");
    const target = norm(ratePlan);
    return supported.some((p) => norm(p) === target);
  }
  function ooredooGiftCooldownMs() {
    const hours = Number(env.OOREDOO_GIFT_COOLDOWN_HOURS || 24);
    return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1e3;
  }
  function ooredooGiftReady(lastMs) {
    if (!lastMs)
      return true;
    return Date.now() - Number(lastMs) >= ooredooGiftCooldownMs();
  }
  function ooredooGiftRemaining(lastMs) {
    try {
      if (!lastMs)
        return "الآن";
      const remainingMs = ooredooGiftCooldownMs() - (Date.now() - Number(lastMs));
      if (remainingMs <= 0)
        return "الآن";
      const mins = Math.max(1, Math.round(remainingMs / 6e4));
      const hours = Math.floor(mins / 60);
      const m = mins % 60;
      if (hours <= 0)
        return `${m} دقيقة`;
      if (m === 0)
        return `${hours} ساعة`;
      return `${hours} ساعة و ${m} دقيقة`;
    } catch {
      return "لاحقًا";
    }
  }
  function ooredooNoWinGift(giftName) {
    if (!giftName)
      return true;
    const m = String(giftName).match(/^(\d+)\s*(?:mo|go|mb|gb)?/i);
    if (m)
      return Number(m[1]) === 0;
    return false;
  }
  async function verifyOoredooOwnership(sender, phoneNumber, operator) {
    const existingUser = await getUserByPhone(env, phoneNumber);
    if (!existingUser || String(existingUser.chat_id || "").trim() !== String(sender).trim()) {
      return { ok: false, fbResponse: { text: "❌ يرجى التحقق من ملكيتك لهذا الرقم أولاً.", quick_replies: gocheckQR(phoneNumber, operator, sender) } };
    }
    return { ok: true };
  }
  async function getOoredooFreshToken(sender, phoneNumber, operator, session) {
    const userData = await getUserByPhone(env, phoneNumber);
    if (!userData || !userData.access_token) {
      await sendVerificationCode(sender, phoneNumber, session);
      return { access_token: null };
    }
    const diffMs = Date.now() - (Number(userData.updated_at) || 0);
    if (diffMs >= 210 * 60 * 1e3 && userData.refresh_token) {
      const tokenUpdate = await ooredoo.refreshToken(phoneNumber, userData.refresh_token);
      if (tokenUpdate.statusCode === 200 && tokenUpdate.data?.access_token) {
        await updateUserTokens(env, phoneNumber, tokenUpdate.data.access_token, tokenUpdate.data.refresh_token || userData.refresh_token);
        return { access_token: tokenUpdate.data.access_token };
      }
      if (tokenUpdate.data?.blocked) {
        return {
          access_token: null,
          fbResponse: { text: tokenUpdate.data.message || "⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.", quick_replies: gocheckQR(phoneNumber, operator, sender) }
        };
      }
      await sendVerificationCode(sender, phoneNumber, session);
      return { access_token: null };
    }
    return { access_token: userData.access_token };
  }
  async function getDjezzyFreshToken(sender, phoneNumber, operator, userData, session) {
    const u = userData || await getUserByPhone(env, phoneNumber);
    if (!u || !u.access_token) {
      await sendVerificationCode(sender, phoneNumber, session);
      return { access_token: null };
    }
    const diffMs = Date.now() - (Number(u.updated_at) || 0);
    if (diffMs < 3.5 * 60 * 60 * 1e3) {
      return { access_token: u.access_token };
    }
    if (u.refresh_token) {
      const tokenUpdate = await djezzy.refreshTokenV2(u.refresh_token).catch(() => ({ statusCode: 0, data: null }));
      if (tokenUpdate.statusCode === 200 && tokenUpdate.data?.access_token) {
        await updateUserTokens(env, phoneNumber, tokenUpdate.data.access_token, tokenUpdate.data.refresh_token || u.refresh_token);
        return { access_token: tokenUpdate.data.access_token, id_token: tokenUpdate.data.id_token || null };
      }
      if (tokenUpdate.data?.blocked) {
        return {
          access_token: null,
          fbResponse: { text: tokenUpdate.data.message || "⚠️ تعذر تنفيذ العملية الآن، حاول مرة أخرى.", quick_replies: gocheckQR(phoneNumber, operator, sender) }
        };
      }
      if (tokenUpdate.statusCode !== 200 || !tokenUpdate.data?.access_token) {
        await sendVerificationCode(sender, phoneNumber, session);
        return { access_token: null };
      }
    }
    return { access_token: u.access_token };
  }
  async function handleOoredooGift(sender, phoneNumber, operator, session) {
    const lock = await checkAndSetCooldown(env, `obuy:gift:${phoneNumber}`, 6e4);
    if (!lock.ok)
      return null;
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    if (!await botServiceCooldown(sender, "ogift", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getOoredooFreshToken(sender, phoneNumber, operator, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const msisdn = ooredooMsisdn(phoneNumber);
    const masked = maskOoredooPhone(phoneNumber);
    const actions = backQR(phoneNumber, operator);
    const alreadyClaimed = /* @__PURE__ */ __name2((lastTime) => withFbButton(
      {
        text: `✖️ لقد استفدت بالفعل من الهدية اليومية
يمكن محاولة بعد ${ooredooGiftRemaining(lastTime)} 🕑

رقم هاتف : ${masked} ✅`,
        quick_replies: actions
      },
      platform
    ), "alreadyClaimed");
    const stamps = await getOoredooTimestamps(env, phoneNumber);
    if (stamps.gamification_played_at && !ooredooGiftReady(Number(stamps.gamification_played_at))) {
      return alreadyClaimed(Number(stamps.gamification_played_at));
    }
    const status = await ooredoo.gamificationStatus({ token: tokenRes.access_token, msisdn });
    if (status.data?.blocked) {
      return { text: status.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: actions };
    }
    if (status.statusCode === 200 && status.data?.played && status.data?.lastPlayedTime) {
      const last = parseOoredooTime(status.data.lastPlayedTime)?.getTime() || Date.now();
      if (!ooredooGiftReady(last)) {
        await setUserTimestamp(env, phoneNumber, "gamification_played_at", last);
        return alreadyClaimed(last);
      }
    }
    const play = await ooredoo.playGamification({ token: tokenRes.access_token, msisdn });
    if (play.data?.blocked) {
      return { text: play.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: actions };
    }
    if (play.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    if (play.statusCode === 200 && play.data) {
      await setCooldown(env, `bot:ogift:${sender}:${phoneNumber}`, 6e4);
      await setUserTimestamp(env, phoneNumber, "gamification_played_at", play.data.playedTime || Date.now());
      if (play.data.giftName && !ooredooNoWinGift(play.data.giftName)) {
        const validity = play.data.validityHour ? ` تنتهي بعد ${play.data.validityHour} ساعة` : "";
        return withFbButton({ text: `🎁 مبروك لقد حصلت على ${play.data.giftName}${validity} 🕑

رقم هاتف : ${masked}`, quick_replies: actions }, platform);
      }
      return withFbButton({ text: `للأسف لم تربح شيء اليوم 😓

رقم هاتف : ${masked}`, quick_replies: actions }, platform);
    }
    return { text: "حدث خطأ أثناء محاولة الحصول على الهدية، يرجى المحاولة لاحقًا ⚠️", quick_replies: actions };
  }
  function renderOoredooOffers(data) {
    const lines = [];
    const expiry = /* @__PURE__ */ __name2((v) => v ? String(v).slice(0, 16).replace("T", " ") : null, "expiry");
    const balanceText = /* @__PURE__ */ __name2((account) => {
      if (!account || account.balance === undefined || account.balance === null)
        return null;
      if (/unlimited/i.test(String(account.balance)))
        return "غير محدود ♾️";
      const unit = account.unit ? ` ${account.unit}` : "";
      return `${account.balance}${unit}`;
    }, "balanceText");
    const kindText = /* @__PURE__ */ __name2((allocationName) => {
      const kind = String(allocationName || "").toUpperCase();
      if (kind === "DATA")
        return "🌐 إنترنت";
      if (kind === "SMS")
        return "💬 رسائل";
      if (kind === "VOICE_ON_NET")
        return "📞 مكالمات نحو أوريدو";
      if (kind === "VOICE_OFF_NET")
        return "📞 مكالمات نحو شبكات أخرى";
      if (kind === "VOICE_INTERNATIONAL")
        return "📞 مكالمات دولية";
      if (kind === "MONEY")
        return "💳 رصيد";
      if (kind === "YOUTUBE")
        return "▶️ يوتيوب";
      return null;
    }, "kindText");
    const pushAllocation = /* @__PURE__ */ __name2((allocationName, account) => {
      if (!account || typeof account !== "object")
        return;
      const bal = balanceText(account);
      if (!bal)
        return;
      const offerName = account.account || allocationName || "عرض";
      const kind = kindText(allocationName);
      lines.push(`🔸 ${offerName}`);
      if (kind)
        lines.push(`   ${kind}: ${bal}`);
      else
        lines.push(`   الكمية: ${bal}`);
      const exp = expiry(account.expiryDate);
      if (exp)
        lines.push(`📅 الانتهاء: ${exp}`);
      lines.push("");
    }, "pushAllocation");
    if (data.snapchatAllocation?.account)
      pushAllocation(data.snapchatAllocation.allocationName, data.snapchatAllocation.account);
    const nouj = data.noudjoumAllocation;
    if (nouj && typeof nouj === "object") {
      for (const key of ["DATA", "SMS", "VOICE_ON_NET", "VOICE_OFF_NET"])
        pushAllocation(key, nouj[key]);
    }
    for (const list of [data.classicAllocations, data.gamificationAllocations, data.dataSharing?.received, data.otherAllocations]) {
      if (Array.isArray(list))
        for (const item of list)
          pushAllocation(item.allocationName, item.account);
    }
    const hybrid = data.hybridAllocations?.hybridBundleAllocations;
    if (Array.isArray(hybrid)) {
      for (const hb of hybrid) {
        const hbName = hb.bundleName || "عرض";
        const hbExp = hb.bearingDetails ? null : expiry(hb.expiryDate || hb.expireDate);
        lines.push(`🔸 ${hbName}`);
        if (Array.isArray(hb.bundleAllocations)) {
          for (const a of hb.bundleAllocations) {
            const aName = a.allocationName || "";
            const aVal = a.allocationValue ?? "";
            const aMax = a.allocationMaxValue ?? "";
            const aUnit = a.unit || "";
            const aExp = expiry(a.expireDate || a.expiryDate);
            const kind = kindText(aName);
            if (/unlimited/i.test(String(aVal))) {
              lines.push(`   ${kind || aName}: غير محدود ♾️`);
            } else if (aMax && aVal) {
              const isData = aUnit === "KB" || aUnit === "MB" || aUnit === "GB" || aName === "DATA";
              if (isData) {
                const valGB = (Number(aVal) / 1024).toFixed(2);
                const maxGB = (Number(aMax) / 1024).toFixed(2);
                lines.push(`   ${kind || aName}: ${valGB} / ${maxGB} Go`);
              } else {
                lines.push(`   ${kind || aName}: ${aVal} / ${aMax} ${aUnit}`);
              }
            } else if (aVal) {
              const isData = aUnit === "KB" || aUnit === "MB" || aUnit === "GB" || aName === "DATA";
              if (isData) {
                lines.push(`   ${kind || aName}: ${(Number(aVal) / 1024).toFixed(2)} Go`);
              } else if (aUnit) {
                lines.push(`   ${kind || aName}: ${aVal} ${aUnit}`);
              } else {
                lines.push(`   ${kind || aName}: ${aVal}`);
              }
            }
          }
        }
        const bearing = hb.bearingDetails;
        if (bearing) {
          const dueDate = data.hybridAllocations?.dueDate;
          if (dueDate) lines.push(`📅 الانتهاء: ${String(dueDate).slice(0, 16).replace("T", " ")}`);
        }
        lines.push("");
      }
    }
    const bundleLists = [
      ...data.dailyBundlePurchases?.dailyBundles || [],
      ...data.dailyBundlePurchases?.smartBundles || [],
      ...data.dailyBundlePurchases?.dataBundles || [],
      ...data.dailyBundlePurchases?.voiceBundles || [],
      ...data.monthlyDataSmartBundlePurchases?.smartBundles || [],
      ...data.monthlyDataSmartBundlePurchases?.dataBundles || [],
      ...data.weeklyBundlePurchases?.smartBundles || [],
      ...data.weeklyBundlePurchases?.dataBundles || [],
      ...data.weeklyBundlePurchases?.weeklyExclusiveBundles || []
    ];
    for (const b of bundleLists) {
      const name = b.bundleName || b.allocationName || b.name || "عرض";
      const exp = expiry(b.expiryDate || b.expirationDate || b.expireDate);
      lines.push(`🔸 ${name}`);
      const acct = b.account || b;
      const bal = balanceText(acct);
      if (bal)
        lines.push(`   ${bal}`);
      if (b.remainingBalance !== undefined && b.remainingBalance !== null) {
        const rbName = kindText(b.allocationName);
        const rbVal = b.remainingBalance;
        const rbUnit = b.unit || "";
        if (/unlimited/i.test(String(rbVal))) {
          lines.push(`   ${rbName || b.allocationName}: غير محدود ♾️`);
        } else if (rbUnit === "KB" || rbUnit === "MB" || b.allocationName === "DATA") {
          lines.push(`   ${rbName || b.allocationName}: ${(Number(rbVal) / 1024).toFixed(2)} Go`);
        } else {
          lines.push(`   ${rbName || b.allocationName}: ${rbVal} ${rbUnit}`);
        }
      }
      if (Array.isArray(b.allocations)) {
        for (const a of b.allocations) {
          const aBal = balanceText(a.account || a);
          const aKind = kindText(a.allocationName);
          if (aBal)
            lines.push(`   ${aKind ? aKind + ": " : (a.allocationName || "") + ": "}${aBal}`);
        }
      }
      if (exp)
        lines.push(`📅 الانتهاء: ${exp}`);
      lines.push("");
    }
    while (lines.length && !lines[lines.length - 1])
      lines.pop();
    if (!lines.length)
      return null;
    return `🔹 العروض المفعلة:

${lines.join("\n").trim()}`;
  }
  async function handleOoredooAccount(sender, phoneNumber, operator, session) {
    const back = backQR(phoneNumber, operator);
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    if (!await botServiceCooldown(sender, "oaccount", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getOoredooFreshToken(sender, phoneNumber, operator, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const msisdn = ooredooMsisdn(phoneNumber);
    const planClaim = decodeJwtPayload(tokenRes.access_token)?.ratePlan;
    const [info, packages] = await Promise.all([
      ooredoo.userInfo({ token: tokenRes.access_token, msisdn }).catch(() => ({ statusCode: 0, data: null })),
      ooredoo.accountInfo({ token: tokenRes.access_token, msisdn })
    ]);
    if (packages.data?.blocked || info.data?.blocked) {
      return { text: packages.data?.message || info.data?.message || "الخدمة غير متاحة حاليًا.", quick_replies: back };
    }
    if (packages.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    if (packages.statusCode !== 200 || !packages.data) {
      return { text: "⚠️ تعذر جلب معلومات الشريحة، يرجى المحاولة لاحقًا.", quick_replies: back };
    }
    await setCooldown(env, `bot:oaccount:${sender}:${phoneNumber}`, 6e4);
    const data = packages.data || {};
    const startDate = info.data?.startDate ? String(info.data.startDate).slice(0, 10) : null;
    const planCandidates = [info.data?.ratePlan, data.planName, planClaim].filter(
      (v) => v && String(v).trim() && !/^\d+(\.\d+)?$/.test(String(v).trim())
    );
    const internetPlan = planCandidates[0] || "—";
    const balance = data.accountBalance !== undefined && data.accountBalance !== null ? data.accountBalance : "—";
    const offers = renderOoredooOffers(data);
    const lines = [
      "✅ معلومات الشريحة:",
      `📱 الرقم: ${maskOoredooPhone(phoneNumber)}`,
      `💳 نوع الشريحة: ${internetPlan}`,
      startDate ? `🗓 تاريخ الإنشاء: ${startDate}` : null,
      `💰 الرصيد: ${balance} دج`
    ].filter(Boolean);
    if (offers)
      lines.push("", offers);
    return { text: lines.join("\n"), quick_replies: back };
  }
  async function handleOoredooSnapchat(sender, phoneNumber, operator, session) {
    const lock = await checkAndSetCooldown(env, `obuy:snap:${phoneNumber}`, 6e4);
    if (!lock.ok)
      return null;
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    if (!await botServiceCooldown(sender, "osnap", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getOoredooFreshToken(sender, phoneNumber, operator, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const msisdn = ooredooMsisdn(phoneNumber);
    const snapClaim = decodeJwtPayload(tokenRes.access_token)?.ratePlan;
    const actions = backQR(phoneNumber, operator);
    if (snapClaim && !ooredooPlanSupports(env, snapClaim, "OOREDOO_SNAPCHAT_PLANS", "N'YOOZ,682,736")) {
      return { text: `💜 عرض سناب شات متوفر فقط لخطة N'YOOZ.
شريحتك (الخطة ${resolveOoredooPlanName(snapClaim)}) لا تدعمه.`, quick_replies: actions };
    }
    const stamps = await getOoredooTimestamps(env, phoneNumber);
    if (stamps.snapchat_activated_at) {
      const last = Number(stamps.snapchat_activated_at);
      if (sameAlgeriaDay(last, /* @__PURE__ */ new Date())) {
        return withFbButton(
          {
            text: `تم تفعيل عرض سناب شات 👻 بالفعل في ساعة ${formatAlgeriaTime(last)} 🕑

يتوقف عرض على ساعة 12 ليلا ويمكن اعادة تفعيله وقتها 💁🏼‍♂️`,
            quick_replies: actions
          },
          platform
        );
      }
    }
    const elig = await ooredoo.snapchatEligibility({ token: tokenRes.access_token, msisdn });
    if (elig.data?.blocked) {
      return { text: elig.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: actions };
    }
    if (elig.statusCode === 200 && elig.data && typeof elig.data.eligible === "boolean" && !elig.data.eligible) {
      await setUserTimestamp(env, phoneNumber, "snapchat_activated_at", Date.now());
      return withFbButton({ text: "💜 تم تفعيل عرض سناب شات اليوم بالفعل عبر جهة أخرى 👻", quick_replies: actions }, platform);
    }
    const apply = await ooredoo.applySnapchat({ token: tokenRes.access_token, msisdn });
    if (apply.data?.blocked) {
      return { text: apply.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: actions };
    }
    await setCooldown(env, `bot:osnap:${sender}:${phoneNumber}`, 6e4);
    await setUserTimestamp(env, phoneNumber, "snapchat_activated_at", Date.now());
    return withFbButton(
      {
        text: "تم تفعيل سناب شات 👻\nيتوقف الساعة 12 مساء 🕑 ويمكنك اعادة تفعيله وقتها ✅",
        quick_replies: actions
      },
      platform
    );
  }
  const OOREDOO_BYOP_PRICE = "100 دج لمدة أسبوعين";
  async function showByopMenu(sender, phoneNumber, operator) {
    const session = await loadSession(env, sender);
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    const tokenRes = await getOoredooFreshToken(sender, phoneNumber, operator, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const titles = {
      IG: "انستغرام",
      YT: "يوتيوب",
      WA: "واتساب",
      FB: "فيسبوك",
      "2Go_Tt": "تيك توك 2Go",
      ...Object.fromEntries(ooredoo.BYOP_LIMITED_CODES.map((c) => [c, "تيك توك 2Go"]))
    };
    const quick_replies = [...ooredoo.BYOP_CODES, ...ooredoo.BYOP_LIMITED_CODES].map((code) => ({
      content_type: "text",
      title: `${titles[code] || code} 100دج`,
      payload: `obyopcode:${phoneNumber}:${operator}:${code}`
    }));
    quick_replies.push(...backQR(phoneNumber, operator));
    const numbered = numberedServiceLines(quick_replies);
    return {
      text: `💰 عروض BYOP المخصصة (${OOREDOO_BYOP_PRICE})
اختر التطبيق الذي تريد تفعيله:

⚠️ هذه الخدمة مدفوعة وتُخصم من رصيدك.${numbered ? `\n\n${numbered}` : ''}`,
      quick_replies
    };
  }
  async function confirmByopPurchase(sender, phoneNumber, operator, code) {
    const titles = {
      IG: "انستغرام",
      YT: "يوتيوب",
      WA: "واتساب",
      FB: "فيسبوك",
      "2Go_Tt": "تيك توك 2Go",
      ...Object.fromEntries(ooredoo.BYOP_LIMITED_CODES.map((c) => [c, "تيك توك 2Go"]))
    };
    const name = titles[code] || code;
    const limited = ooredoo.BYOP_LIMITED_CODES.includes(code);
    const priceLine = limited ? "100 دج - 2Go فقط" : `${OOREDOO_BYOP_PRICE} (غير محدود)`;
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    return {
      text: `✅ العرض: ${name}
📱 رقمك: ${formatPhoneNumber(phoneNumber)}
💵 السعر: ${priceLine}
💳 يُخصم المبلغ من رصيدك مباشرة.

هل تريد التفعيل الآن؟`,
      quick_replies: [
        { content_type: "text", title: "✅ نعم، فعّل", payload: `obyopconfirm:${phoneNumber}:${operator}:${code}` },
        ...backQR(phoneNumber, operator)
      ]
    };
  }
  async function executeByopPurchase(sender, phoneNumber, operator, code, session) {
    const titles = {
      IG: "انستغرام",
      YT: "يوتيوب",
      WA: "واتساب",
      FB: "فيسبوك",
      "2Go_Tt": "تيك توك 2Go",
      ...Object.fromEntries(ooredoo.BYOP_LIMITED_CODES.map((c) => [c, "تيك توك 2Go"]))
    };
    const name = titles[code] || code;
    const back = backQR(phoneNumber, operator);
    const lock = await checkAndSetCooldown(env, `obuy:byop:${phoneNumber}:${code}`, 6e4);
    if (!lock.ok)
      return null;
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    if (!await botServiceCooldown(sender, "obyopconfirm", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getOoredooFreshToken(sender, phoneNumber, operator, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const msisdn = ooredooMsisdn(phoneNumber);
    const result = await ooredoo.purchaseByop({ token: tokenRes.access_token, msisdn, code });
    if (result.data?.blocked) {
      return { text: result.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: back };
    }
    if (result.statusCode === 200 || result.statusCode === 201) {
      await setCooldown(env, `bot:obyopconfirm:${sender}:${phoneNumber}`, 6e4);
      return withFbButton({ text: `✅ تم تفعيل عرض ${name} بنجاح!
📱 الرقم: ${formatPhoneNumber(phoneNumber)}`, quick_replies: back }, platform);
    }
    if (result.statusCode === 409 && result.data?.message) {
      const msg = String(result.data.message);
      if (msg.includes("DYNAMIC_CREDIT_LIMIT_NOT_ENOUGH")) {
        return { text: `⛔ رصيدك غير كافٍ لتفعيل عرض ${name}.
اشحن رصيدك ثم أعد المحاولة.`, quick_replies: back };
      }
      return { text: `⚠️ لم يتم تفعيل العرض: ${msg}`, quick_replies: back };
    }
    if (result.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    return { text: "⚠️ فشل تفعيل العرض، يرجى المحاولة لاحقًا.", quick_replies: back };
  }
  // ---------- عروض حصرية / عروض وفاء (CVM) ----------
  function parseCvmBundles(data) {
    // البنية: body.getBundlesResponse.responseData[] -> { attributes: { code, name:{ar}, instances:[{ attributes:{ price, periodic-amount, periodic-unit, allowances:[{attributes:{usage-type, usage-value, usage-unit, destination, code}}] } }] } }
    const durationUnitMap = { day: "يوم", days: "يوم", week: "أسبوع", weeks: "أسبوع", month: "شهر", months: "شهر" };
    const destMap = { FB: "فيسبوك", YT: "يوتيوب", IG: "انستاغرام", SC: "سناب شات", Tt: "تيك توك", TIKTOK: "تيك توك", WA: "واتساب", YT_UAE: "يوتيوب" };
    const unitArMap = { minute: "دقيقة", minutes: "دقيقة", min: "دقيقة", gb: "جيغا", mb: "ميغا", kb: "كيلو", dzg: "دج", dzd: "دج", da: "دج", s: "ثانية" };
    const out = [];
    if (!data || typeof data !== "object") return out;
    const inner = data.body && typeof data.body === "object" ? data.body : data;
    const responseData = inner.getBundlesResponse?.responseData;
    if (!Array.isArray(responseData)) return out;
    for (const item of responseData) {
      const attrs = item?.attributes || {};
      const code = attrs.code;
      if (!code) continue;
      const nameAr = attrs.name?.ar || attrs.name || code;
      const inst = Array.isArray(attrs.instances) && attrs.instances[0]?.attributes || {};
      const price = inst.price != null ? String(inst.price) : null;
      const amount = attrs["periodic-amount"] != null ? String(attrs["periodic-amount"]) : (inst["periodic-amount"] != null ? String(inst["periodic-amount"]) : null);
      const unit = attrs["periodic-unit"] ? String(attrs["periodic-unit"]).toLowerCase() : (inst["periodic-unit"] ? String(inst["periodic-unit"]).toLowerCase() : null);
      const unitAr = unit ? durationUnitMap[unit] || unit : null;
      const duration = amount ? `${amount} ${unitAr || ""}`.trim() : null;
      let services = [];
      const allowArr = Array.isArray(inst.allowances) ? inst.allowances : [];
      for (const a of allowArr) {
        const aa = a?.attributes || {};
        const type = String(aa["usage-type"] || "");
        const dest = String(aa.destination || aa.code || "").toUpperCase();
const val = aa["usage-value"] != null ? String(aa["usage-value"]) : null;
      const u2 = aa["usage-unit"] ? String(aa["usage-unit"]) : null;
      const u2Ar = u2 ? unitArMap[u2.toLowerCase()] || u2 : null;
      let label;
      if (destMap[dest]) {
        label = destMap[dest];
      } else if (type === "voice") {
        label = dest === "HOME" ? "مكالمات" : dest === "NATIONAL" ? "خارج الشبكة" : "مكالمات";
      } else if (type === "sms") {
        label = "رسائل";
      } else if (type === "data") {
        label = "إنترنت";
      } else {
        label = dest && dest !== "ANY" ? dest : "إنترنت";
      }
      const valTxt = val && u2Ar && val !== "0" ? `${val} ${u2Ar}` : null;
      services.push({ label, value: valTxt });
      }
      if (!services.length) services = [{ label: "إنترنت", value: null }];
      out.push({ code, name: nameAr, price, duration, services });
    }
    return out;
  }
  function renderCvmBundleItem(b, i) {
    const color = ["🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫", "⚪", "🔶", "🔷", "🟥"][i % 12];
    const lines = [`${color} • ${b.price ? `${b.price} دج` : "‏"} 💸`];
    for (const s of b.services || []) {
      lines.push(`🌐 • ${s.label}${s.value ? ` : ${s.value}` : ""}`);
    }
    if (b.duration) lines.push(`🗓️ • مدة : ${b.duration}`);
    return lines.join("\n");
  }
  async function showOoredooBundles(sender, phoneNumber, operator, kind, session) {
    const back = backQR(phoneNumber, operator);
    const lockKey = kind === "exclusive" ? `obuy:exclusive:${phoneNumber}` : `obuy:loyalty:${phoneNumber}`;
    const lock = await checkAndSetCooldown(env, lockKey, 6e4);
    if (!lock.ok)
      return null;
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    if (!await botServiceCooldown(sender, `o${kind}`, phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getOoredooFreshToken(sender, phoneNumber, operator, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const msisdn = ooredooMsisdn(phoneNumber);
    const raw = kind === "exclusive"
      ? await ooredoo.promoBundles({ token: tokenRes.access_token, msisdn })
      : await ooredoo.loyaltyBundles({ token: tokenRes.access_token, msisdn });
    if (raw.data?.blocked) {
      return { text: raw.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: back };
    }
    if (raw.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    const bundles = parseCvmBundles(raw.data || {});
    console.log(`[ooredoo-bundles][${kind}] status=${raw.statusCode} via=${raw.via} blocked=${!!raw.data?.blocked} parsed=${bundles.length} dataShape=${raw.data && typeof raw.data === "object" ? Object.keys(raw.data).join(",") : typeof raw.data}`);
    const masked = maskOoredooPhone(phoneNumber);
    if (!bundles.length) {
      return { text: `⚠️ لا توجد ${kind === "exclusive" ? "عروض حصرية" : "عروض وفاء"} متاحة حاليًا.\n📱 الرقم: ${masked}`, quick_replies: back };
    }
    const title = kind === "exclusive" ? "💎 عروض حصرية 🏷️" : "💝 عروض وفاء 🏷️";
    const body = bundles.map((b, i) => `${i + 1}- ${b.name}\n${renderCvmBundleItem(b, i)}`).join("\n\n");
    const lines = [`${title}\n📱 الرقم: ${masked}`, "", body];
    const quick_replies = bundles.map((b) => ({
      content_type: "text",
      title: `عرض ${b.price ? b.price : ""}`.trim(),
      payload: `odynbuy:${phoneNumber}:${operator}:${encodeURIComponent(b.code)}:${encodeURIComponent(`${b.name}|${b.price || ""}`)}`
    }));
    quick_replies.push(...back);
    return { text: `${lines.join("\n")}\n\nاختر العرض المناسب من الأزرار أدناه 🔽`, quick_replies };
  }
  async function confirmDynamicBundlePurchase(sender, phoneNumber, operator, code, namePrice) {
    const bundleCode = decodeURIComponent(code || "");
    const rawName = namePrice ? decodeURIComponent(namePrice) : "";
    const [bundleName = bundleCode, bundlePrice = ""] = rawName.split("|");
    const back = backQR(phoneNumber, operator);
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    return {
      text: `✅ العرض: ${bundleName}
📱 رقمك: ${formatPhoneNumber(phoneNumber)}
💵 السعر: ${bundlePrice ? `${bundlePrice} دج` : "-"}

هل تريد التفعيل الآن؟`,
      quick_replies: [
        { content_type: "text", title: "✅ نعم، فعل العرض", payload: `odynconfirm:${phoneNumber}:${operator}:${encodeURIComponent(bundleCode)}` },
        ...back
      ]
    };
  }
  async function executeDynamicBundlePurchase(sender, phoneNumber, operator, code, session) {
    const bundleCode = decodeURIComponent(code || "");
    const back = backQR(phoneNumber, operator);
    const lock = await checkAndSetCooldown(env, `obuy:dynamic:${phoneNumber}:${bundleCode}`, 6e4);
    if (!lock.ok)
      return null;
    const ownership = await verifyOoredooOwnership(sender, phoneNumber, operator);
    if (!ownership.ok)
      return ownership.fbResponse;
    if (!await botServiceCooldown(sender, "odynconfirm", phoneNumber, session, 6e4))
      return null;
    const tokenRes = await getOoredooFreshToken(sender, phoneNumber, operator, session);
    if (!tokenRes.access_token)
      return tokenRes.fbResponse || {};
    const msisdn = ooredooMsisdn(phoneNumber);
    const result = await ooredoo.purchaseDynamicBundle({ token: tokenRes.access_token, msisdn, code: bundleCode });
    if (result.data?.blocked) {
      return { text: result.data.message || "الخدمة غير متاحة حاليًا.", quick_replies: back };
    }
    if (result.statusCode === 200 || result.statusCode === 201) {
      await setCooldown(env, `bot:odynconfirm:${sender}:${phoneNumber}`, 6e4);
      return withFbButton({ text: `✅ تم تفعيل العرض بنجاح!
📦 العرض: ${bundleCode}
📱 الرقم: ${formatPhoneNumber(phoneNumber)}`, quick_replies: back }, platform);
    }
    if (result.statusCode === 409 && (result.data?.message || result.data?.code)) {
      const msg = String(result.data.message || "");
      const codeErr = String(result.data.code || "");
      if (msg.includes("DYNAMIC_CREDIT_LIMIT_NOT_ENOUGH") || codeErr.includes("DYNAMIC_CREDIT_LIMIT_NOT_ENOUGH") || msg.includes("Credit Balance Not Enough")) {
        return { text: `⛔ رصيدك غير كافٍ لتفعيل هذا العرض.
اشحن رصيدك ثم أعد المحاولة.`, quick_replies: back };
      }
      return { text: `⚠️ لم يتم تفعيل العرض: ${msg}`, quick_replies: back };
    }
    if (result.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    return { text: "⚠️ فشل تفعيل العرض، يرجى المحاولة لاحقًا.", quick_replies: back };
  }
  return {
    floodGate,
    process,
    markSeenFb: async (sender) => messenger.markSeen(sender),
  };
}
