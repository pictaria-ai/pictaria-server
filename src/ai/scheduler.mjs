import { createHash } from 'node:crypto';
import { enrichmentProviderConfiguration, ProviderRequestError } from '../enrich/providers.mjs';
import { awaitDrain } from '../lifecycle.mjs';

export const ENRICH_TURN_CALLS = 10;
export const ENRICH_TURN_MS = 5 * 60_000;
const MAX_SESSIONS = 200;

// Conservative resource identity from the pinned adapter. Models, credentials
// and API paths do not prove separate capacity. Do not retain URLs or secrets.
// Loopback aliases name the same host. Separate origins are separate resources;
// we cannot discover shared GPUs/quotas hidden behind different proxy origins.
export function aiResourceKey(provider) {
  const endpoint = enrichmentProviderConfiguration(provider).endpoint;
  if (!endpoint) throw new TypeError('AI scheduling requires a provider endpoint.');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('AI scheduling requires HTTP or HTTPS.');
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'localhost';
  return createHash('sha256').update(url.origin).digest('hex');
}

export class AiSchedulingCancelled extends ProviderRequestError {
  constructor() {
    super('AI work stopped before its next request.', { cancelled: true });
    this.code = 'ai_schedule_cancelled';
  }
}

// One server-owned arbiter, not a durable work queue. A session pins its
// resource for a run. Enrich keeps its short turn across per-photo downloads
// and persistence; retry backoff or run completion releases it explicitly.
// Curate releases after every request. Active calls are never preempted.
export class AiRequestScheduler {
  constructor({ now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.sessions = new Set(); this.resources = new Map(); this.active = new Set();
    this.stopped = false; this.scheduled = false; this.sequence = 0;
    this.curateOwner = null; this.priorityTurns = 0;
  }

  session(provider, lane, { signal, eligible = () => true, priority = false } = {}) {
    if (!['enrich', 'curate'].includes(lane)) throw new TypeError('Invalid AI scheduling lane.');
    if (this.stopped || signal?.aborted) throw new AiSchedulingCancelled();
    if (this.sessions.size >= MAX_SESSIONS) throw new Error('AI scheduling capacity reached.');
    const s = { key: aiResourceKey(provider), lane, eligible, priority, signal,
      pending: null, active: false, closed: false, releaseAfter: false, calls: 0, since: 0, timer: null };
    this.sessions.add(s);
    const close = () => {
      s.closed = true;
      this.#rejectPending(s);
      if (!s.active) this.#release(s);
      this.#wake();
    };
    s.onAbort = close;
    signal?.addEventListener('abort', close, { once: true });
    return Object.freeze({
      run: work => {
        if (typeof work !== 'function') throw new TypeError('AI request callback required.');
        if (s.closed || this.stopped || !this.#eligible(s)) return Promise.reject(new AiSchedulingCancelled());
        if (s.pending || s.active) throw new Error('An AI session already has a request.');
        const pending = Promise.withResolvers();
        s.pending = { ...pending, work, order: ++this.sequence };
        this.#resource(s); this.#wake();
        return pending.promise;
      },
      // Backoff/download-only pauses must not retain a model turn. Yielding
      // does not abort a submitted request or reset any durable attempt cap.
      yield: () => {
        if (s.active) s.releaseAfter = true;
        else this.#release(s);
        this.#wake();
      },
      close,
      ownsTurn: () => s.active && this.resources.get(s.key)?.owner === s,
      status: () => ({ state: s.active ? 'running' : s.pending ? 'waiting' : s.closed ? 'stopped' : 'idle',
        reason: s.pending ? (this.resources.get(s.key)?.owner ? 'shared-backend' : 'curate-busy') : null }),
    });
  }

  // Settings changes invalidate queued opt-outs promptly, without touching
  // the pinned provider or interrupting an already-submitted request.
  refresh() { this.#wake(); }

  async stop(timeoutMs = 3000) {
    this.stopped = true;
    for (const s of this.sessions) {
      s.closed = true; this.#rejectPending(s);
      if (!s.active) this.#release(s);
    }
    return awaitDrain(Promise.allSettled([...this.active]), timeoutMs);
  }

  #eligible(s) {
    try { return s.eligible() === true && !s.signal?.aborted; }
    catch { return false; }
  }
  #resource(s) {
    let resource = this.resources.get(s.key);
    if (!resource) { resource = { owner: null, lastLane: null }; this.resources.set(s.key, resource); }
    return resource;
  }
  #rejectPending(s) {
    if (s.pending) { s.pending.reject(new AiSchedulingCancelled()); s.pending = null; }
  }
  #release(s) {
    if (s.timer !== null) { this.clearTimer(s.timer); s.timer = null; }
    const r = this.resources.get(s.key);
    if (r?.owner === s) r.owner = null;
    if (this.curateOwner === s) this.curateOwner = null;
    s.releaseAfter = false;
    if (s.closed) { this.sessions.delete(s); s.signal?.removeEventListener('abort', s.onAbort); }
  }
  #wake() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    // Give request continuations and I/O a chance to enqueue the next photo.
    // A self-replenishing chain of instantly completed work must not monopolize
    // the microtask queue (or hide a waiting competitor).
    setImmediate(() => { this.scheduled = false; this.#pump(); });
  }
  #pump() {
    if (this.stopped) return;
    for (const s of this.sessions) if (!s.active && !this.#eligible(s)) {
      s.closed = true; this.#rejectPending(s); this.#release(s);
    }
    const waiting = () => [...this.sessions].filter(s => s.pending && !s.closed);
    for (const [key, r] of this.resources) {
      const s = r.owner;
      if (!s || s.lane !== 'enrich') continue;
      const competing = waiting().some(w => w.key === key && w.lane === 'curate');
      const due = s.calls >= ENRICH_TURN_CALLS || this.now() - s.since >= ENRICH_TURN_MS;
      if (!s.active && competing && due) this.#release(s);
      else if (competing && !due && s.timer === null) {
        s.timer = this.setTimer(() => { s.timer = null; this.#wake(); }, Math.max(0, ENRICH_TURN_MS - (this.now() - s.since)));
        s.timer?.unref?.();
      }
    }
    // Prefer Enrich at the start of contention and after a Curate turn.
    // A completed Enrich turn hands off to Curate if it is waiting.
    for (const [key, r] of this.resources) if (!r.owner) {
      const queue = waiting().filter(s => s.key === key);
      const enrich = queue.find(s => s.lane === 'enrich');
      const curate = queue.some(s => s.lane === 'curate');
      if (enrich && (!curate || r.lastLane !== 'enrich' || this.curateOwner)) this.#grant(enrich, r);
    }
    if (!this.curateOwner) {
      const queue = waiting().filter(s => s.lane === 'curate' && !this.#resource(s).owner)
        .sort((a, b) => a.pending.order - b.pending.order);
      // At most two preferred comparisons before the oldest waiting one.
      // Both future roles share this selection and the single Curate slot.
      const preferred = this.priorityTurns < 2 && queue.find(s => s.priority === true);
      const next = preferred || queue[0];
      if (next) {
        this.priorityTurns = preferred ? this.priorityTurns + 1 : 0;
        this.#grant(next, this.#resource(next));
      }
    }
    for (const [key, r] of this.resources) {
      if (r.owner?.pending && !r.owner.active) this.#dispatch(r.owner);
      if (!r.owner && !waiting().some(s => s.key === key)) this.resources.delete(key);
    }
  }
  #grant(s, r) {
    r.owner = s; r.lastLane = s.lane; s.calls = 0; s.since = this.now();
    if (s.lane === 'curate') this.curateOwner = s;
  }
  #dispatch(s) {
    const p = s.pending; s.pending = null; s.active = true; s.calls++;
    // Defer execution one microtask so all active handles exist even when
    // an adapter throws synchronously. Observe all outcomes; no unhandled jobs.
    const task = Promise.resolve().then(() => {
      if (this.stopped || s.closed || !this.#eligible(s)) throw new AiSchedulingCancelled();
      return p.work();
    });
    this.active.add(task);
    task.then(value => this.#finish(s, p, task, null, value), error => this.#finish(s, p, task, error));
  }
  #finish(s, p, task, error, value) {
    this.active.delete(task); s.active = false;
    if (s.lane === 'curate' || error || s.releaseAfter || s.closed || this.stopped || !this.#eligible(s)) this.#release(s);
    if (error) p.reject(error); else p.resolve(value);
    this.#wake();
  }
}
