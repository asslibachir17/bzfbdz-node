// ===========================================================================
// نظام معالجة الضغط العالي (Load Guard / Circuit Breaker)
// ---------------------------------------------------------------------------
// حماية الروابط الخارجية (Djezzy/Ooredoo/Facebook/Telegram) من موجات الازدحام:
//  1) تزامن محدود: عدد ثابت من الطلبات يُنفّذ في اللحظة نفسها (CONCURRENCY).
//  2) طابور انتظار FIFO: الطلبات الزائدة تصطف، ولكل عنصر حد انتظار (TTL)
//     يُرفض بعده بـ 503 بدل تعليق الجميع.
//  3) Circuit Breaker: إن فشلت الخدمة الخارجية بنسبة عالية خلال نافذة،
//     تُفتح الدارة مؤقتاً ويُرفض كل طلب سريعاً (503) حتى يُعاد الهدوء.
// ===========================================================================

const DEFAULTS = {
  maxConcurrency: 8,
  maxQueue: 200,
  queueTtlMs: 8000,
  breakerThreshold: 0.6,
  breakerMinSamples: 20,
  breakerCooldownMs: 30000,
  sampleWindowMs: 60000,
};

class LoadGuard {
  constructor(opts = {}) {
    this.maxConcurrency = opts.maxConcurrency ?? DEFAULTS.maxConcurrency;
    this.maxQueue = opts.maxQueue ?? DEFAULTS.maxQueue;
    this.queueTtlMs = opts.queueTtlMs ?? DEFAULTS.queueTtlMs;
    this.breakerThreshold = opts.breakerThreshold ?? DEFAULTS.breakerThreshold;
    this.breakerMinSamples = opts.breakerMinSamples ?? DEFAULTS.breakerMinSamples;
    this.breakerCooldownMs = opts.breakerCooldownMs ?? DEFAULTS.breakerCooldownMs;
    this.sampleWindowMs = opts.sampleWindowMs ?? DEFAULTS.sampleWindowMs;

    this.active = 0;
    this.queue = [];
    this.breakerState = 'closed'; // closed | open | half-open
    this.breakerUntil = 0;
    this.samples = []; // { t, ok }
    this.stats = { ran: 0, ok: 0, fail: 0, rejected: 0, queueTimeout: 0, circuitOpen: 0 };
  }

  // ---------- الدارة ----------
  _record(ok) {
    const now = Date.now();
    this.samples.push({ t: now, ok });
    if (this.samples.length > 500) this.samples = this.samples.slice(-400);
    const cutoff = now - this.sampleWindowMs;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].t < cutoff) {
        this.samples.splice(0, i);
        break;
      }
    }
  }

  _isCircuitOpen() {
    if (this.breakerState === 'open') {
      if (Date.now() >= this.breakerUntil) {
        this.breakerState = 'half-open'; // جرّب طلباً واحداً
        return false;
      }
      return true;
    }
    return false;
  }

  _evaluateBreaker() {
    if (this.breakerState === 'open') return;
    const total = this.samples.length;
    if (total < this.breakerMinSamples) return;
    const fail = this.samples.filter((s) => !s.ok).length;
    if (fail / total >= this.breakerThreshold) {
      this.breakerState = 'open';
      this.breakerUntil = Date.now() + this.breakerCooldownMs;
      this.stats.circuitOpen++;
      console.log(`[loadGuard] circuit OPEN: ${fail}/${total} failed · cooldown ${this.breakerCooldownMs}ms`);
    } else if (this.breakerState === 'half-open') {
      this.breakerState = 'closed';
    }
  }

  _busyError() {
    const e = new Error('LOAD_GUARD_BUSY');
    e.status = 503;
    this.stats.rejected++;
    return e;
  }

  // ---------- نقطة الدخول الرئيسية ----------
  async run(task, opts = {}) {
    // 1) الدارة مفتوحة → رفض سريع (أو تنفيذ بديل)
    if (this._isCircuitOpen()) {
      if (opts.onCircuitOpen) return opts.onCircuitOpen();
      throw this._busyError();
    }

    // 2) طابور ممتلئ → رفض فوري (حماية من تراكم لا نهائي للذاكرة)
    if (this.queue.length >= this.maxQueue) {
      throw this._busyError();
    }

    // 3) سعة متاحة → نفّذ فوراً ولا تنتظر.
    if (this.active < this.maxConcurrency) {
      return this._execute(task, opts);
    }

    // 4) السعة ممتلئة → اصف في الطابور وانتظر حتى يُشغّله _pump.
    //    _pump وحده من ينفّذ المهمة (لا نعيد تنفيذها هنا أبدًا).
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + this.queueTtlMs;
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        this.stats.queueTimeout++;
        const e = new Error('LOAD_GUARD_QUEUE_TIMEOUT');
        e.status = 503;
        reject(e);
      }, this.queueTtlMs);
      const entry = { resolve, reject, task, opts, deadline, timer };
      this.queue.push(entry);
    });
  }

  async _execute(task, opts = {}) {
    this.active++;
    this.stats.ran++;
    try {
      const result = await task();
      this._record(true);
      this.stats.ok++;
      return result;
    } catch (e) {
      this._record(false);
      this.stats.fail++;
      throw e;
    } finally {
      this.active--;
      this._evaluateBreaker();
      this._pump();
    }
  }

  _pump() {
    // شغّل عناصر الطابور ما دامت السعة متاحة (FIFO)
    while (this.active < this.maxConcurrency && this.queue.length) {
      const entry = this.queue.shift();
      clearTimeout(entry.timer);
      // لا ننتظر هُنا — ننفذ في الخلفية دون حجب موصل المضخة
      this._execute(entry.task, entry.opts).then(entry.resolve).catch(entry.reject);
    }
  }

  getStats() {
    return { ...this.stats, active: this.active, queued: this.queue.length, breaker: this.breakerState };
  }
}

const _guards = new Map();

// يُنشئ أو يعيد حارساً بحسب الاسم (مثال: 'otp', 'webhook', 'bot')
export function getLoadGuard(name, env = {}) {
  if (!_guards.has(name)) {
    // قيمة خاصة بالاسم لها الأولوية (WEBHOOK_LOAD_MAX_CONCURRENCY...) ثم العامة
    const n = (suffix) => env?.[`${String(name).toUpperCase()}_LOAD_${suffix}`] ?? env?.[`LOAD_${suffix}`];
    const o = {
      maxConcurrency: Number(n('MAX_CONCURRENCY')) || DEFAULTS.maxConcurrency,
      maxQueue: Number(n('MAX_QUEUE')) || DEFAULTS.maxQueue,
      queueTtlMs: Number(n('QUEUE_TTL_MS')) || DEFAULTS.queueTtlMs,
      breakerThreshold: Number(n('BREAKER_THRESHOLD')) || DEFAULTS.breakerThreshold,
      breakerMinSamples: Number(n('BREAKER_MIN_SAMPLES')) || DEFAULTS.breakerMinSamples,
      breakerCooldownMs: Number(n('BREAKER_COOLDOWN_MS')) || DEFAULTS.breakerCooldownMs,
    };
    _guards.set(name, new LoadGuard(o));
  }
  return _guards.get(name);
}

export default LoadGuard;