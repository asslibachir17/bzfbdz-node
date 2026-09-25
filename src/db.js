// غلاف لعمليات D1 — اختصارات للقراءة والكتابة بأمان

export async function first(env, sql, ...params) {
  try {
    return await env.DB.prepare(sql).bind(...params).first();
  } catch (e) {
    console.error('[DB:first]', e.message, sql);
    return null;
  }
}

export async function all(env, sql, ...params) {
  try {
    const res = await env.DB.prepare(sql).bind(...params).all();
    return res.results || [];
  } catch (e) {
    console.error('[DB:all]', e.message, sql);
    return [];
  }
}

export async function run(env, sql, ...params) {
  try {
    return await env.DB.prepare(sql).bind(...params).run();
  } catch (e) {
    console.error('[DB:run]', e.message, sql);
    return { success: false, error: e.message };
  }
}
