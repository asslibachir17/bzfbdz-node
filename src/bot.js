// bot.js — منطق البوت المشترك بين فيسبوك وتلغرام وإنستغرام
// كل منصة تحصل على messenger مناسب لها داخليًا (لا حاجة لأي ربط خارجي setMessenger/setSend)
import { createMessenger } from './messenger.js';
import { createTelegram } from './telegram.js';
import { createInstagram } from './instagram.js';
import { createDjezzy } from './services/djezzy.js';
import { createOoredoo } from './services/ooredoo.js';
import { httpRequest } from './services/http.js';

const NEW_API_BASE2 = "https://apim.djezzy.dz/mobile-api/api/v1";

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

// ترويج بوت فيسبوك لمستخدمي تلغرام فقط (لا تأثير على فيسبوك نفسه)
const FB_PAGE_LINK = 'https://www.facebook.com/BZeroBot';
const facebookQR = { content_type: 'text', title: 'البوت في فيسبوك 🤖', url: FB_PAGE_LINK, full_row: true };
function withFbButton(response, platform) {
  if (platform !== 'tg' || !response) return response;
  return { ...response, quick_replies: [...(response.quick_replies || []), facebookQR] };
}

export
function createBot(env, ctx, platform = "fb") {
  const messenger = platform === "tg" ? createTelegram(env) : platform === "ig" ? createInstagram(env) : createMessenger(env);
  const djezzy = createDjezzy(env);
  const ooredoo = createOoredoo(env);
  const rc = rateConfig(env);
  const isTg = true;

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
      if (operator === "ooredoo") {
        await send(sender, { text: "شريحتك قديمة حولها لـ NYOOZ او DIMA وحاول مجددا" }, sess);
      } else {
        await send(sender, { text: "❌ حدث خطأ، يرجى المحاولة لاحقًا." }, sess);
      }
    } else if (apiResponse.statusCode === 429 && apiResponse.data?.message) {
      await send(sender, { text: apiResponse.data.message }, sess);
    } else if (apiResponse.statusCode === 401 || /invalid user credentials/i.test(JSON.stringify(apiResponse.data || {}))) {
      if (operator === "ooredoo") {
        await send(sender, { text: "⚠️ الضغط على شبكة أوريدو الآن.\nأعد المحاولة بعد بضع دقائق." }, sess);
      } else {
        await send(sender, { text: "رقم غير صحيح او غير موجود رجاء تحقق من رقم واعادة محاولة ❌" }, sess);
      }
    } else if (apiResponse.statusCode !== 500 && apiResponse.statusCode !== 0) {
      if (operator === "ooredoo") {
        await send(sender, { text: "شريحتك قديمة حولها لـ NYOOZ او DIMA وحاول مجددا" }, sess);
      } else {
        await send(sender, { text: "❌ حدث خطأ، يرجى المحاولة لاحقًا." }, sess);
      }
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
      case "oservices": {
        await showOoredooOffers(sender, phoneNumber, operator, session);
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
      if ((res.statusCode === 200 || res.statusCode === 201) && res.data?.status === 200 && res.data?.message === "Product successfully activated") {
        await updateActivationDate(env, phoneNumber);
        await setCooldown(env, `act2g:op:${phoneNumber}`, ACTIVATE_2G_TRY_COOLDOWN_MS);
        return withFbButton({ text: `تم تفعيل 2Go بنجاح! 🎉
رقم الهاتف: ${mask}`, quick_replies: back }, platform);
      }
      if (res.statusCode === 403 || res.data?.status === 403) {
        return withFbButton({ text: `❌ لم يمر أسبوع منذ آخر تفعيل.
رقم الهاتف: ${mask}`, quick_replies: back }, platform);
      }
      if (res.statusCode === 401 || res.data?.status === 401) {
        return withFbButton({ text: `❌ لم يمر أسبوع منذ آخر تفعيل.
رقم الهاتف: ${mask}`, quick_replies: back }, platform);
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
      console.error("[باقة 4Go] خطأ:", e.message);
      return { text: `❌ حدث خطأ أثناء محاولة التفعيل ⚠️
رقمك: ${mask}`, quick_replies: back };
    } finally {
      await clearCooldown(env, `srv1:lock:${phoneNumber}`);
    }
  }
  async function showOoredooOffers(sender, inputPhone, operator, session) {
    const byopTitles = {
      IG: "📸 انستغرام",
      YT: "▶️ يوتيوب",
      WA: "💬 واتساب",
      FB: "📘 فيسبوك",
      "2Go_Tt": "🎵 تيك توك 2Go",
      ...Object.fromEntries(ooredoo.BYOP_LIMITED_CODES.map((c) => [c, "🎵 تيك توك 2Go"]))
    };
    const userRow = await getUserByPhone(env, inputPhone);
    const storedToken = userRow?.access_token || null;
    const snapClaim = storedToken ? decodeJwtPayload(storedToken)?.ratePlan : null;
    const byopSupported = ooredooPlanSupports(env, snapClaim, "OOREDOO_BYOP_PLANS", "N'YOOZ,682,736");
    const byopButtons = byopSupported ? [
      ...ooredoo.BYOP_CODES.map((code) => ({
        content_type: "text",
        title: `${byopTitles[code] || code} 100دج`,
        payload: `obyopcode:${inputPhone}:${operator}:${code}`
      })),
      ...ooredoo.BYOP_LIMITED_CODES.map((code) => ({
        content_type: "text",
        title: `${byopTitles[code] || code} 100دج`,
        payload: `obyopcode:${inputPhone}:${operator}:${code}`
      }))
    ] : [];
    const lines = [`📱 رقم الهاتف: ${maskOoredooPhone(inputPhone)}`, "", "🗳 اختر الخدمة التي تريدها"];
    await send(
      sender,
      {
        text: lines.join("\n"),
        quick_replies: [...byopButtons, ...backQR(inputPhone, operator)]
      },
      session
    );
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
        { content_type: "text", title: "📦 العروض", payload: `oservices:${inputPhone}:${operator}:${sender}` }
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
      djezzyActionButtons.push({ content_type: "text", title: "70 دج - 4 جيغا - 24 ساعة", payload: `srv1:${inputPhone}:${operator}:${sender}`, full_row: true });
      djezzyActionButtons.push({ content_type: "text", title: "100 دج - 2Go - 24 ساعة", payload: `srv2:${inputPhone}:${operator}:${sender}`, full_row: true });
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
    await send(sender, { text, quick_replies: quickReplies }, session);
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
        const hbName = hb.bundleName || "باقة";
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
      const name = b.bundleName || b.allocationName || b.name || "باقة";
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
    const planClaim = decodeJwtPayload(tokenRes.access_token)?.ratePlan;
    if (planClaim && !ooredooPlanSupports(env, planClaim, "OOREDOO_BYOP_PLANS", "N'YOOZ,682,736")) {
      return { text: `💰 العروض المخصصة متوفرة فقط لخطة N'YOOZ.
شريحتك (الخطة ${resolveOoredooPlanName(planClaim)}) لا تدعمها.`, quick_replies: backQR(phoneNumber, operator) };
    }
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
    return {
      text: `💰 عروض BYOP المخصصة (${OOREDOO_BYOP_PRICE})
اختر التطبيق الذي تريد تفعيله:

⚠️ هذه الخدمة مدفوعة وتُخصم من رصيدك.`,
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
      text: `⚠️ تأكيد الاشتراك:

📦 الباقة: ${name}
💵 السعر: ${priceLine}
📱 الرقم: ${formatPhoneNumber(phoneNumber)}
💳 يُخصم المبلغ من رصيدك مباشرة.

هل تريد المتابعة؟`,
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
      return withFbButton({ text: `✅ تم تفعيل باقة ${name} بنجاح!
📱 الرقم: ${formatPhoneNumber(phoneNumber)}`, quick_replies: back }, platform);
    }
    if (result.statusCode === 409 && result.data?.message) {
      const msg = String(result.data.message);
      if (msg.includes("DYNAMIC_CREDIT_LIMIT_NOT_ENOUGH")) {
        return { text: `⛔ رصيدك غير كافٍ لتفعيل باقة ${name}.
اشحن رصيدك ثم أعد المحاولة.`, quick_replies: back };
      }
      return { text: `⚠️ لم يتم تفعيل الباقة: ${msg}`, quick_replies: back };
    }
    if (result.statusCode === 401) {
      await sendVerificationCode(sender, phoneNumber, session);
      return null;
    }
    return { text: "⚠️ فشل تفعيل الباقة، يرجى المحاولة لاحقًا.", quick_replies: back };
  }
  return {
    floodGate,
    process,
    markSeenFb: async (sender) => messenger.markSeen(sender),
  };
}
