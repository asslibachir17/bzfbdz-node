// ============================================================
// src/runtime/env.js — بناء كائن env المكافئ لمتغيرات الـ Worker
// كل متغيرات البيئة تصل كسلاسل (مثل wrangler vars) + ربط DB.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

export function buildEnv(db) {
  const env = { ...process.env };
  env.DB = db;
  return env;
}

export function loadDotEnv() {
  // محمّل .env خفيف (بدون تبعية) — لا يمسّ المتغيرات الموجودة
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}