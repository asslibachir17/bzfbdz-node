// إعدادات عامة (key/value) من قاعدة البيانات مع كاش قصير لتجنّب استعلام لكل رسالة.
// تُنشأ الجداول في schema.sqlite.sql / schema.pg.sql عند كل إقلاع (CREATE IF NOT EXISTS).

const cache = new Map(); // key -> { value, at }
const TTL_MS = 30 * 1000;

export async function getSetting(env, key) {
  const now = Date.now();
  const c = cache.get(key);
  if (c && now - c.at < TTL_MS) return c.value;
  let value = null;
  try {
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(key).first();
    value = row ? row.value : null;
  } catch {
    value = null;
  }
  cache.set(key, { value, at: now });
  return value;
}

export async function setSetting(env, key, value) {
  const now = Date.now();
  const v = String(value);
  const res = await env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind(key, v, now).run();
  cache.set(key, { value: v, at: now });
  return res;
}

// علم الصيانة لدجيزي: '1' -> نُظهر للمستخدمين رسالة الصيانة بدل أخطاء الخدمة.
export async function isDjezzyMaintenance(env) {
  return (await getSetting(env, 'djezzy_maintenance')) === '1';
}