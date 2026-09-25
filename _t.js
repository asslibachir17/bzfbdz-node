require('pg').Pool.prototype.end
const { Pool } = require('pg');
(async () => {
  const candidates = [
    { name: 'external', host: 'dpg-dar7ntnavr4c7383eepg-a.oregon-postgres.render.com' },
  ];
  for (const c of candidates) {
    const pool = new Pool({
      host: c.host, port: 5432,
      database: 'bzfbdz_node', user: 'bzfbdz_node_user',
      password: 'WluScHr37xlFybtz21uFlYaZV36DR3tR',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 12000,
    });
    try {
      const r = await pool.query('SELECT 1 AS ok');
      console.log(c.name, 'OK', JSON.stringify(r.rows[0]));
    } catch (e) {
      console.log(c.name, 'FAIL', e.message.slice(0, 120));
    } finally { await pool.end().catch(()=>{}); }
  }
})();
