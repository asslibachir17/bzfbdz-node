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

function urlFor(name) {
  if (name.endsWith('workers.dev')) return 'https://' + name;
  const host = PRIMARY_HOSTS[name] || `${name}.asslibachiir.workers.dev`;
  return 'https://' + host;
}

// 45 ريلاي: 28 على مناطق نظيفة + 17 احتياط MAD.
export const DEFAULT_RELAY_URLS = [...CLEAN, ...FALLBACK_MAD].map(urlFor);

// يدمج ما جاء من متغيّرات البيئة مع القائمة المدمجة: المتغيّرات أولاً (حتى
// يبقى able المستخدم لتثبيت ريلاي بعينه)، ثم كل ما هو ناقص من المدمجة.
// النتيجة: Render تاخذ 45 ريلاي بمجرد النشر، بلا تعديل يدوي.
export function resolveRelays(primaryUrl, envList) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (!v) return;
    const u = String(v).trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  push(primaryUrl);
  if (envList) for (const s of String(envList).split(',')) push(s);
  for (const u of DEFAULT_RELAY_URLS) push(u);
  return out;
}
