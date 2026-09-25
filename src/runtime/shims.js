// ============================================================
// src/runtime/shims.js — ضمان توافر متغيرات/واجهات Worker في Node
// (يُحمَّل قبل أي وحدة أخرى). Node ≥ 20 يوفّر أغلبها أصلاً.
// ============================================================
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
} else {
  // في بعض الإصدارات: crypto موجود لكن getRandomValues/subtle غير مربوطين
  if (typeof globalThis.crypto.getRandomValues !== 'function' && webcrypto.getRandomValues) {
    globalThis.crypto.getRandomValues = webcrypto.getRandomValues.bind(webcrypto);
  }
  if (!globalThis.crypto.subtle && webcrypto.subtle) {
    globalThis.crypto.subtle = webcrypto.subtle;
  }
}

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = (await import('node:util')).TextEncoder;
}
if (!globalThis.TextDecoder) {
  globalThis.TextDecoder = (await import('node:util')).TextDecoder;
}

// Headers.getSetCookie — متوفر من Node 18.14+، نضيفه وقائياً إن غاب
if (globalThis.Headers && typeof globalThis.Headers.prototype.getSetCookie !== 'function') {
  try {
    Object.defineProperty(globalThis.Headers.prototype, 'getSetCookie', {
      configurable: true,
      writable: true,
      value: function getSetCookie() {
        const out = [];
        this.forEach((v, k) => {
          if (k.toLowerCase() === 'set-cookie') out.push(v);
        });
        return out;
      },
    });
  } catch {}
}

// getres? لا داعي
export const READY = true;