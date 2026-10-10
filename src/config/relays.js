// قائمة الريلايس الافتراضية المدمجة في الكود.
// السبب: متغيّرات Render لا تتحدّث من render.yaml عند النشر، فالقائمة كانت
// محبوسة في Dashboard عند 9 ريلايس. هنا ندمجها مع المتغيّرات حتى يُنشر
// التوسعة مع الكود مباشرة.
//
// الترتيب: المناطق-European النظيفة أولاً (مقيسة فعلياً: FRA/CDG/BRU نجحت)،
// وريلايس MAD المحجوبة في الآخر. لكن هذا مجرد ترتيب ابتدائي — التدوير
// بالترجيح في http.js هو ما يقرّر فعلياً بعد تعلّم الفشل.
const CLEAN = [
  // FRA
  'oo-relay-16', 'oo-relay-17', 'oo-relay-22', 'oo-relay-23', 'oo-relay-36', 'oo-relay-37',
  // CDG
  'oo-relay-18', 'oo-relay-20', 'oo-relay-21', 'oo-relay-26', 'oo-relay-27', 'oo-relay-6',
  // BRU
  'oo-relay-19', 'oo-relay-24', 'oo-relay-25',
  // LHR
  'oo-relay-32', 'oo-relay-33', 'oo-relay-40', 'oo-relay-41',
  // AMS / ARN / MXP / HEL / ZRH
  'oo-relay-28', 'oo-relay-29', 'oo-relay-30', 'oo-relay-31',
  'oo-relay-34', 'oo-relay-35', 'oo-relay-38', 'oo-relay-39', 'oo-relay-7',
  // دفعة ثانية على حساب asslimstph (oo-relay-44..oo-relay-93، 50 ريلاي):
  // موزعة على 13 منطقة placement مختلفة (FRA/CDG/BRU/AMS/ARN/LHR/MXP/HEL/MAD/…) لتفريق
  // IPs الخروج وتخفيف ضغط «Request Rejected» من أوريدو. التدوير بالترجيح في http.js
  // سيتعلّم فشل أيٍّ منها ويُبعده فعلياً.
  'oo-relay-44', 'oo-relay-45', 'oo-relay-46', 'oo-relay-47', 'oo-relay-48', 'oo-relay-49',
  'oo-relay-50', 'oo-relay-51', 'oo-relay-52', 'oo-relay-53', 'oo-relay-54', 'oo-relay-55',
  'oo-relay-56', 'oo-relay-57', 'oo-relay-58', 'oo-relay-59', 'oo-relay-60', 'oo-relay-61',
  'oo-relay-62', 'oo-relay-63', 'oo-relay-64', 'oo-relay-65', 'oo-relay-66', 'oo-relay-67',
  'oo-relay-68', 'oo-relay-69', 'oo-relay-70', 'oo-relay-71', 'oo-relay-72', 'oo-relay-73',
  'oo-relay-74', 'oo-relay-75', 'oo-relay-76', 'oo-relay-77', 'oo-relay-78', 'oo-relay-79',
  'oo-relay-80', 'oo-relay-81', 'oo-relay-82', 'oo-relay-83', 'oo-relay-84', 'oo-relay-85',
  'oo-relay-86', 'oo-relay-87', 'oo-relay-88', 'oo-relay-89', 'oo-relay-90', 'oo-relay-91',
  'oo-relay-92', 'oo-relay-93',
];

// MAD محجوبة حالياً (قياس: 0/8) — تبقى كاحتياط فقط، والتدوير سيُبعدها فعلياً.
const FALLBACK_MAD = [
  'oo-relay', 'oo-relay-2', 'oo-relay-3', 'oo-relay-4', 'oo-relay-5',
  'oo-relay-8', 'oo-relay-9', 'oo-relay-10', 'oo-relay-11', 'oo-relay-12',
  'oo-relay-13', 'oo-relay-14', 'oo-relay-15', 'oo-relay-42', 'oo-relay-43',
  'oo-relay-alt.asslimstph', 'oo-relay-alt-2.asslimstph',
];

const PRIMARY_HOSTS = {
  'oo-relay': 'oo-relay.asslibachiir.workers.dev',
  'oo-relay-alt.asslimstph': 'oo-relay-alt.asslimstph.workers.dev',
  'oo-relay-alt-2.asslimstph': 'oo-relay-alt-2.asslimstph.workers.dev',
};

// ريلايات الحساب الثاني (asslimstph): اسم الوركر يقع على worker-asslimstph.workers.dev
const ASSLIMSTPH_HOSTS = new Set();
for (let i = 44; i <= 93; i++) ASSLIMSTPH_HOSTS.add(`oo-relay-${i}`);

function urlFor(name) {
  if (name.endsWith('workers.dev')) return 'https://' + name;
  const host = PRIMARY_HOSTS[name] || (ASSLIMSTPH_HOSTS.has(name) ? `${name}.asslimstph.workers.dev` : `${name}.asslibachiir.workers.dev`);
  return 'https://' + host;
}

// 95 ريلاي: 78 على مناطق نظيفة + 17 احتياط MAD.
export const DEFAULT_RELAY_URLS = [...CLEAN, ...FALLBACK_MAD].map(urlFor);

// مفاتيح الريلاي الإنتاجية التي تستحق دمج القائمة المدمجة.
// أوريدو فقط: شبكة Cloudflare تُخرِج طلبات أوريدو من IP مقبول لديها.
//
// جُرِّب دجيزي (DJEZZY_RELAY_URL) وثبت أنه يضرّ: دجيزي يحجب كل عناوين
// Cloudflare (nginx 403) — حتى GET لجذر apim.djezzy.dz عبر أي ريلاي يعود
// 403. لذلك لا يُدمج لدجيزي، ويُترك لمسار البروكسي/المباشر.
export const PRODUCTION_RELAY_KEYS = new Set(['OOREDOO_RELAY_URL']);

export function isProductionRelayKey(key) {
  return PRODUCTION_RELAY_KEYS.has(key);
}

// يدمج متغيّرات البيئة مع القائمة المدمجة. الترتيب مقصود:
//   1) primary (تثبيت صريح من المستخدم)
//   2) القائمة المدمجة (النظيفة أولاً حسب القياس الفعلي)
//   3) بقايا env list
// السبب: قائمة env على Render قديمة ومسبّبة في MAD المحجوبة، فتقديمها كان
// يُبطئ كل طلب (يجرّب MAD أولاً ثم يفشل). لا نحذفها — نضعها آخراً.
export function resolveRelays(primaryUrl, envList, withDefaults = true) {
  const out = [];
  const seen = new Set();
  // تطبيع: إزالة الفراغات والشرطة المائلة الأخيرة، وإضافة https:// إن غاب
  // المخطط. سبب ذلك: قائمة Render ضبطت primary كاسم مضيف بلا https:// فحُسب
  // رابطاً منفصلاً عن المدمج (كان relayCount=46 بدل 45).
  const norm = (v) => {
    let s = String(v).trim().replace(/\/+$/, '');
    if (s && !/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s;
  };
  const push = (v) => {
    if (!v) return;
    const u = norm(v);
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  push(primaryUrl);
  if (withDefaults) for (const u of DEFAULT_RELAY_URLS) push(u);
  if (envList) for (const s of String(envList).split(',')) push(s);
  return out;
}
