// تفعيل/إلغاء صيانة دجيزي.
// الاستعمال:
//   node scripts/djezzy-maintenance.mjs on    -> إظهار رسالة الصيانة لمستخدمي دجيزي
//   node scripts/djezzy-maintenance.mjs off   -> إعادة الخدمة
//   node scripts/djezzy-maintenance.mjs       -> حالة العلم الحالية
import { loadDotEnv, buildEnv } from '../src/runtime/env.js';
import { createDb } from '../src/runtime/db.js';
import { getSetting, setSetting } from '../src/settings.js';

loadDotEnv();
const db = await createDb();
const env = buildEnv(db);

const val = process.argv[2];
if (val === 'on' || val === '1') {
  await setSetting(env, 'djezzy_maintenance', '1');
  console.log('djezzy_maintenance = ON');
} else if (val === 'off' || val === '0') {
  await setSetting(env, 'djezzy_maintenance', '0');
  console.log('djezzy_maintenance = OFF');
} else {
  const cur = await getSetting(env, 'djezzy_maintenance');
  console.log('djezzy_maintenance =', cur === '1' ? 'ON' : 'OFF');
}
await db.close?.();
process.exit(0);