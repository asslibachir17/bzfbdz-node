const { Pool } = require('pg');
const pool = new Pool({
  host: 'dpg-dar7ntnavr4c7383eepg-a.oregon-postgres.render.com',
  port: 5432,
  database: 'bzfbdz_node',
  user: 'bzfbdz_node_user',
  password: 'WluScHr37xlFybtz21uFlYaZV36DR3tR',
  ssl: { rejectUnauthorized: false },
});

const rows = [
  { id: 1, host: 'v2.proxyempire.io', port: 5000, username: 'r_ff45693e44-country-dz', password: '970fb1c855', active: 1, last_used: '2026-09-24T09:11:02.596Z', service: 'ooredoo', blocked_until: 0 },
  { id: 2, host: 'gw.dataimpulse.com', port: 823, username: 'b60f40fc7fc058f21a2a__cr.dz', password: '3f3da8c474e52c99', active: 1, last_used: '2026-09-22T20:57:43.542Z', service: 'djezzy', blocked_until: 1790305486556 },
  { id: 3, host: 'eu.911proxy.net', port: 2600, username: 'mm7ajxh2mlie_area-DZ', password: 'TUp8hNaN3VriDofu', active: 1, last_used: '2026-08-13T20:45:08.585Z', service: 'ooredoo', blocked_until: 1790241361482 },
  { id: 4, host: 'node-de-35.astroproxy.com', port: 10042, username: 'AsslibachirvI1', password: 'ef59c6xN7', active: 1, last_used: '2026-09-09T11:20:42.361Z', service: 'djezzy', blocked_until: 1790305486100 },
  { id: 5, host: 'change6.owlproxy.com', port: 7778, username: 'ZGuhzCqDNn10_custom_zone_DZ_st__city_sid_25360531_time_5', password: '5523206', active: 1, last_used: '2026-09-25T04:18:36.794Z', service: 'djezzy', blocked_until: 0 },
];

async function main() {
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO proxies (id, host, port, username, password, active, last_used, service, blocked_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET host=EXCLUDED.host, port=EXCLUDED.port, username=EXCLUDED.username, password=EXCLUDED.password, active=EXCLUDED.active, last_used=EXCLUDED.last_used, service=EXCLUDED.service, blocked_until=EXCLUDED.blocked_until`,
      [r.id, r.host, r.port, r.username, r.password, r.active, r.last_used, r.service, r.blocked_until]
    );
    console.log(`proxy ${r.id} (${r.host}) rowCount=${res.rowCount}`);
  }
  const chk = await pool.query('SELECT id, host, service, blocked_until FROM proxies ORDER BY id');
  console.log('FINAL:', JSON.stringify(chk.rows));
  await pool.end();
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });