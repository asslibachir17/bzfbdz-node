// ===========================================================================
// مطابقة النصوص العربية المفتاحية مع خيارات القائمة (بديل/مكمّل للأزرار)
// تعمل محليًا بدون Gemini — لمن لا تظهر لديهم الأزرار أو يكتبون نصًا/إيموجيًا.
// ===========================================================================

// تطبيع النص العربي: توحيد الهمزات/الألف/اللام القمرية، إزالة التشكيل والمسافات الزائدة
function normalizeArabic(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '') // تشكيل وتنوين
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // رموز/إيموجي → مسافة
    .replace(/\s+/g, ' ')
    .trim();
}

// كلمات مفتاحية لكل نوع عملية (البادئة في الـ payload)
const ACTION_KEYWORDS = {
  activate2G: ['تفعيل 2', '2go', '2 جيغا', '2 جيجا', 'جيغا', 'جيجا', 'giga', 'ال2 جيغا', 'ال2 جيجا'],
  infosimdjezzy: ['معلومات', 'الشريحه', 'الشريحة', 'معلومات الشريحه', 'حسابي', 'الحساب', 'معلومه', 'info'],
  startinvite: ['دعوه', 'دعوة', 'ادعو', 'ادعوا', 'دعوه صديق', 'دعوة صديق', 'invite'],
  srv1: ['انترنت', 'انترنيت', 'باقه', 'باقة', '4 جيغا', '4 جيجا', '70 دج', '4g', '4go', 'باقة انترنت'],
  djoffers: ['عروض', 'العروض', 'عروض دجيزي', 'عروض الجازي', 'عرض', 'العرض', 'باقات', 'باقه', 'عروض internet', 'offers'],
  ogift: ['هديه', 'هدية', 'الهديه اليوميه', 'الهدية اليومية', 'gift'],
  osnap: ['سناب', 'سناب شات', 'snapchat', 'snap'],
  oaccount: ['معلومات', 'الشريحه', 'الشريحة', 'معلومات الشريحه', 'حسابي', 'الحساب', 'معلومه', 'info'],
  oservices: ['العروض', 'عروض', 'الكل', 'offers'],
  obundles: ['العروض', 'عروض', 'الكل', 'offers'],
  obyop: ['انستغرام', 'انستا', 'instagram', 'يوتيوب', 'youtube', 'واتساب', 'whatsapp', 'فيسبوك', 'فايسبوك', 'facebook', 'تيك توك', 'tiktok'],
  back: ['رجوع', 'القائمه', 'القائمة', 'الرئيسيه', 'الرئيسية', 'العودة', 'back'],
};

// كلمات للـ BYOP حسب الكود
const BYOP_KEYWORDS = {
  IG: ['انستغرام', 'انستا', 'instagram', 'insta'],
  YT: ['يوتيوب', 'youtube'],
  WA: ['واتساب', 'whatsapp'],
  FB: ['فيسبوك', 'فايسبوك', 'facebook'],
  '2Go_Tt': ['تيك توك', 'tiktok', 'tt'],
};

// نطاقات الإيموجي/الرموز في عناوين الأزرار (مثل ℹ 🎉 🎁 👻 👥 📦 ⬅️ 🏠)
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2100}-\u{27BF}\u{FE0F}]/gu;

function scoreText(text, keywords) {
  if (!keywords || !keywords.length) return 0;
  let score = 0;
  for (const kw of keywords) {
    const n = normalizeArabic(kw);
    if (!n) continue;
    if (text.includes(n)) {
      score += n.length;
    } else if (n.includes(text) && text.length >= 3) {
      // تخمين جزئي: المستخدم كتب جزءًا من الكلمة المفتاحية
      score += 1;
    }
  }
  return score;
}

/**
 * طابق نص المستخدم مع قائمة خيارات (أزرار). يعيد الخيار الأفضل تطابقًا أو null.
 * يطابق: العنوان كاملًا/جزئيًا + الكلمات المفتاحية + الإيموجي في النص/العنوان.
 * @param {string} userText نص المستخدم
 * @param {{title:string, payload:string}[]} options خيارات القائمة
 */
export function matchKeywordIntent(userText, options) {
  if (!options || options.length === 0) return null;
  const text = normalizeArabic(userText);
  if (!text) return null;
  const raw = String(userText || '').toLowerCase();

  // إيموجيات موجودة في نص المستخدم
  const userEmojis = new Set(raw.match(EMOJI_RE) || []);

  let best = null;
  let bestScore = 0;

  for (const opt of options) {
    const payload = String(opt.payload || '');
    const action = payload.split(':')[0];
    const title = normalizeArabic(opt.title || '');
    const rawTitle = String(opt.title || '').toLowerCase();

    let score = 0;

    // 1) تطابق العنوان (كامل/جزئي/نص أطول يحتوي العنوان)
    if (title && text.length >= 2) {
      if (text === title) score += 8;
      else if (text.includes(title)) score += 5;
      else if (title.includes(text)) score += 3;
    }

    // 2) الكلمات المفتاحية للنص
    if (action === 'obyopcode') {
      const code = payload.split(':')[3];
      score += scoreText(text, BYOP_KEYWORDS[code]);
    } else if (ACTION_KEYWORDS[action]) {
      score += scoreText(text, ACTION_KEYWORDS[action]);
    }

    // 3) إيموجي: إن كان إيموجي عنوان الزر موجودًا في نص المستخدم → تطابق قوي
    for (const em of rawTitle.match(EMOJI_RE) || []) {
      if (userEmojis.has(em)) {
        score += 6;
        break;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }

  // أي تطابق ولو بسيط يُقبل — وإلا null (فيعيد البوت عرض القائمة تلقائيًا)
  return bestScore > 0 ? best : null;
}

/**
 * أبني خيارات قائمة ثابتة (بدون فحوص شبكة) للمطابقة المفتاحية
 * عندما لا توجد قائمة محفوظة (من يكتب نصًا دون أزرار).
 */
export function buildFallbackOptions(phoneNumber, operator) {
  if (!phoneNumber || !operator) return null;
  const p = (action, extra = '') => ({ title: action, payload: `${action}:${phoneNumber}:${operator}${extra}` });
  if (operator === 'ooredoo') {
    return [
      p('ogift'),
      p('osnap'),
      p('oaccount'),
      p('obundles'),
      ...Object.keys(BYOP_KEYWORDS).map((code) => ({ title: BYOP_KEYWORDS[code][0], payload: `obyopcode:${phoneNumber}:${operator}:${code}` })),
    ];
  }
  if (operator === 'djezzy') {
    return [p('djoffers'), p('activate2G'), p('infosimdjezzy'), p('startinvite'), p('srv1')];
  }
  return null;
}

// ===========================================================================
// كشف رسائل الشكر بمختلف الصياغات (عربية/دارجة/فرنسية/إنجليزية)
// ===========================================================================
const THANKS_TOKENS = [
  'شكرا', 'شكرن', 'مشكور', 'مشكوره', 'مشكورين', 'الشكر', 'شكرا جزيلا', 'شكرا لك',
  'ثانكس', 'ثانكيو', 'تانكيو', 'ثانك يو', 'تنكس', 'ثنكس', 'سنكس', 'ثانكس بزاف',
  'ميغسي', 'ميرسي', 'مرسي', 'مغسي', 'ميغسي بزاف', 'ميرسي بوكو',
  'merci', 'merci beaucoup', 'thanks', 'thank you', 'thankyou', 'thx', 'tnx', 'thanx',
  'chokran', 'choukran', 'shukran', 'chokrane',
];

export function isThanksText(userText) {
  const text = normalizeArabic(userText);
  if (!text) return false;
  const words = text.split(' ').filter(Boolean);
  if (words.length > 4) return false;
  for (const tk of THANKS_TOKENS) {
    const n = normalizeArabic(tk);
    if (!n) continue;
    if (text === n || text.includes(n)) return true;
  }
  return false;
}
