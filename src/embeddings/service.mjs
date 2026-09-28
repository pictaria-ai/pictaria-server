import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeHttpUrl } from '../config.mjs';
import { sanitizeDiagnostic } from '../diagnostics.mjs';
import { CALIBRATION_VERSION, calibrationImage } from './calibration.mjs';
import { EmbeddingServiceError, ImmichMlClient } from './client.mjs';
import { EMBEDDING_BACKEND, SUGGESTED_EMBEDDING_MODELS, normalizeEmbeddingModel, validEmbeddingModel } from './models.mjs';

export const EMBEDDING_LIMITS = Object.freeze({
  // First use of a model makes the service download it inside this request.
  calibrationTimeoutMs: 10 * 60_000,
  // A run waits this long for calibration, then enriches photos without
  // vectors until the model is ready.
  calibrationWaitMs: 15_000,
  // Extra wait for a photo's vector once its enrichment has finished; work
  // still running then is aborted.
  settleMs: 5_000,
  // Consecutive service failures (including requests still running when the
  // photo's wait expires) that pause embedding for the rest of a run.
  failureLimit: 3,
  // Immich restarts its idle machine-learning worker; a first ping after a
  // quiet period can wait for it to boot.
  sessionPingTimeoutMs: 60_000,
  // Safety bound for aborted work to drain; every request takes the signal.
  closeGraceMs: 1_000,
  connectionCacheMs: 60_000,
  testTimeoutMs: 120_000,
  // How long Test connection waits for the shared prediction lane.
  testLaneWaitMs: 15_000,
});

// A silent timeout or refusal usually means the address works from a browser
// but not from Pictaria's own container, e.g. the Immich host's own address.
export const REACHABILITY_HINT = 'The address must work from Pictaria’s own server or container, not only from your computer. '
  + 'If Pictaria runs on the same machine as Immich, connect Pictaria to Immich’s Docker network and use the '
  + 'machine-learning container’s name, such as http://immich_machine_learning:3003.';
const unreachable = (error) => ['ml_unreachable', 'ml_timeout'].includes(error?.code);

// Lane priorities: Enrich first, then a person's connection test, then lab passes.
const PRIORITY = Object.freeze({ enrich: 2, test: 1, lab: 0 });

// Every prediction Pictaria sends to the machine-learning service goes through
// this one lane: at most one request in flight for the whole server, across
// Enrich sessions, lab passes and connection tests. Waiters are served by
// priority, then arrival. A waiter whose signal aborts leaves the queue without
// sending anything; the lane is released only after the request has settled.
export class PredictionLane {
  constructor() {
    this.running = false;
    this.waiting = [];
    this.sequence = 0;
  }

  async run(work, { priority = 0, signal = null, waitMs = null } = {}) {
    await this.#acquire(priority, signal, waitMs);
    try { return await work(); } finally { this.#release(); }
  }

  get busy() {
    return this.running;
  }

  #acquire(priority, signal, waitMs) {
    signal?.throwIfAborted();
    if (!this.running) {
      this.running = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let timer = null;
      const waiter = { priority, order: this.sequence++ };
      const leave = (error) => {
        this.waiting = this.waiting.filter((entry) => entry !== waiter);
        waiter.cleanup();
        reject(error);
      };
      const onAbort = () => leave(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      waiter.cleanup = () => { signal?.removeEventListener('abort', onAbort); if (timer) clearTimeout(timer); };
      waiter.resolve = () => { waiter.cleanup(); resolve(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (waitMs !== null) {
        timer = setTimeout(() => leave(new EmbeddingServiceError(
          'The machine-learning service is busy with other embedding work. Try again shortly.', 'ml_busy', { service: false })), waitMs);
      }
      this.waiting.push(waiter);
      this.waiting.sort((a, b) => b.priority - a.priority || a.order - b.order);
    });
  }

  #release() {
    const next = this.waiting.shift();
    if (next) next.resolve();
    else this.running = false;
  }
}

// Optional Enrich step. Sessions never throw into the enrichment run: every
// outcome is counted and logged, and a missing vector is left for backfill.
export class EmbeddingService {
  constructor({ repo, config, fetchImpl = fetch, now = Date.now, elapsedNow = () => performance.now(), limits = EMBEDDING_LIMITS }) {
    Object.assign(this, { repo, config, fetchImpl, now, elapsedNow, limits });
    this.lastConnection = null;
    this.lastSession = null;
    this.testing = false;
    // Open sessions: 'enrich' (one per Enrich run) and 'lab' (explicit passes).
    this.active = new Set();
    this.lane = new PredictionLane();
  }

  settings() {
    const value = this.config.enrichEmbeddings ?? {};
    return { enabled: value.enabled === true, url: value.url || '', model: normalizeEmbeddingModel(value.model) };
  }

  status() {
    const { enabled, url, model } = this.settings();
    const connection = this.lastConnection?.url === url ? publicConnection(this.lastConnection) : null;
    return {
      enabled, configured: Boolean(url), model, backend: EMBEDDING_BACKEND,
      suggestions: SUGGESTED_EMBEDDING_MODELS,
      connection: !enabled ? { state: 'off' } : !url ? { state: 'not_configured' } : connection,
      coverage: this.repo.embeddings.coverage({ backend: EMBEDDING_BACKEND, model }),
      lastRun: this.lastSession,
    };
  }

  // Cached ping for the home page; the service belongs to Immich, so it is not
  // probed on every status poll.
  async connection({ refresh = false } = {}) {
    const { enabled, url } = this.settings();
    if (!enabled) return { state: 'off' };
    if (!url) return { state: 'not_configured' };
    const last = this.lastConnection;
    if (!refresh && last?.url === url && this.now() - last.checkedAt < this.limits.connectionCacheMs) return publicConnection(last);
    this.pinging ??= (async () => {
      let state = 'connected', message = '';
      try { await new ImmichMlClient({ baseUrl: url, fetchImpl: this.fetchImpl }).ping(); }
      catch (error) {
        state = error?.code === 'ml_not_immich' ? 'not_immich' : 'unreachable';
        message = safeMessage(error);
      }
      this.lastConnection = { url, state, message, checkedAt: this.now() };
      return this.lastConnection;
    })().finally(() => { this.pinging = null; });
    return publicConnection(await this.pinging);
  }

  // Settings → Test connection with unsaved draft values. Creates no space and
  // stores nothing; reports whether stored vectors would be reused.
  async test({ url, model, signal } = {}) {
    if (this.testing) throw new EmbeddingServiceError('A connection test is already running.', 'ml_test_busy', { service: false });
    const saved = this.settings();
    let target;
    try { target = normalizeHttpUrl(url ?? saved.url); }
    catch { throw new EmbeddingServiceError('Enter a valid HTTP or HTTPS URL.', 'ml_invalid_url', { service: false }); }
    const name = normalizeEmbeddingModel(model ?? saved.model);
    if (!validEmbeddingModel(name)) {
      throw new EmbeddingServiceError('Enter an Immich model name such as ViT-B-32__openai.', 'ml_invalid_model', { service: false });
    }
    this.testing = true;
    try {
      const client = new ImmichMlClient({ baseUrl: target, fetchImpl: this.fetchImpl });
      try { await client.ping({ signal }); }
      catch (error) {
        if (!unreachable(error)) throw error;
        throw new EmbeddingServiceError(`${error.message} ${REACHABILITY_HINT}`, error.code, { service: false });
      }
      let started = null;
      let vector;
      try {
        vector = await this.lane.run(() => {
          started = this.elapsedNow();
          return client.embedImage(calibrationImage(), { model: name, signal, timeoutMs: this.limits.testTimeoutMs });
        }, { priority: PRIORITY.test, signal, waitMs: this.limits.testLaneWaitMs });
      } catch (error) {
        if (error?.code !== 'ml_timeout') throw error;
        throw new EmbeddingServiceError(`${error.message} A model’s first use downloads it inside this request; try again in a few minutes.`,
          'ml_timeout');
      }
      const elapsedMs = Math.round(this.elapsedNow() - started);
      const match = this.repo.embeddings.matchSpace({
        backend: EMBEDDING_BACKEND, model: name, calibrationVersion: CALIBRATION_VERSION, calibration: vector,
      });
      const known = this.repo.embeddings.latestSpace({ backend: EMBEDDING_BACKEND, model: name });
      if (target === saved.url) this.lastConnection = { url: target, state: 'connected', message: '', checkedAt: this.now() };
      return { ok: true, model: name, dims: vector.length, elapsedMs,
        vectors: match ? 'reused' : known ? 'new-set' : 'first-set' };
    } finally { this.testing = false; }
  }

  // Captured at run start, like other processing controls, so one run uses one
  // model even if Settings change while it is running.
  session({ log = () => {}, signal = null } = {}) {
    const { enabled, url, model } = this.settings();
    if (!enabled) return null;
    // Enrich takes the service back from an explicit lab pass: the pass's
    // current request is aborted and drained before Enrich's first prediction.
    for (const session of this.active) {
      if (session.kind === 'lab') {
        session.preempt('An Enrich run started embedding photos, so this pass stopped to leave the machine-learning service to it. Completed photos are kept.');
      }
    }
    return new EmbeddingSession(this, { url, model, log, signal, kind: 'enrich' });
  }

  // An explicit pass a person starts for a few photos (the stacking lab). It
  // needs the URL and model from Settings but not the automatic Enrich
  // switch, runs one at a time, and yields to Enrich: it cannot start during
  // an Enrich session and stops between photos when one begins.
  labPass({ log = () => {}, signal = null } = {}) {
    const { url, model } = this.settings();
    if (!url) {
      throw new EmbeddingServiceError('Set the Immich machine-learning URL in Settings → Enrich → Image embeddings first.',
        'ml_not_configured', { service: false });
    }
    if (this.enrichActive()) {
      throw new EmbeddingServiceError('An Enrich run is embedding photos right now. Try again when it finishes.', 'ml_busy', { service: false });
    }
    if ([...this.active].some((session) => session.kind === 'lab')) {
      throw new EmbeddingServiceError('Another embedding pass is running. Try again when it finishes.', 'ml_busy', { service: false });
    }
    return new EmbeddingSession(this, { url, model, log, signal, kind: 'lab' });
  }

  enrichActive() {
    return [...this.active].some((session) => session.kind === 'enrich');
  }
}

// Resource policy: embedding work exists only inside an Enrich run (one run at
// a time) and only for a photo that run is analyzing. At most one request is
// in flight; it starts beside the photo's vision call and must finish within
// settleMs after that photo's enrichment, or it is aborted. Nothing outlives
// its photo or the run. The machine-learning service is a different origin
// from every vision provider, so it is its own resource in the AI scheduler's
// terms; a future embed-only backfill must share one server-wide lane here.
class EmbeddingSession {
  constructor(service, { url, model, log, signal, kind }) {
    Object.assign(this, { service, url, model, log, kind });
    service.active.add(this);
    this.store = service.repo.embeddings;
    this.limits = service.limits;
    this.controller = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.space = null;
    this.stopped = null;
    this.reason = null;
    this.request = null;
    this.failures = 0;
    this.embedMs = 0;
    this.waits = { count: 0, totalMs: 0, maxMs: 0 };
    this.counts = { embedded: 0, current: 0, busy: 0, waiting: 0, paused: 0, late: 0, failed: 0 };
  }

  // Enrich waits briefly for the model and continues without vectors; an
  // explicit pass waits for it (bounded by the caller's signal).
  async start({ waitForModel = false } = {}) {
    let client = null;
    try { client = this.url ? new ImmichMlClient({ baseUrl: this.url, fetchImpl: this.service.fetchImpl }) : null; } catch {}
    if (!client) {
      this.#stop('ml_not_configured', 'image embeddings are on, but no valid machine-learning URL is set; photos are enriched without them');
      return;
    }
    this.client = client;
    this.log(`image embeddings: on (${this.model})`);
    this.calibration = this.#calibrate();
    if (waitForModel) await within(this.calibration, this.limits.calibrationTimeoutMs, this.signal);
    else await within(this.calibration, this.limits.calibrationWaitMs, this.signal);
    if (!this.space && !this.stopped && !this.signal.aborted) {
      this.log('image embeddings: waiting for the machine-learning service to load the model (the first use downloads it); photos continue without embeddings until it is ready');
    }
  }

  async #calibrate() {
    try {
      await this.client.ping({ signal: this.signal, timeoutMs: this.limits.sessionPingTimeoutMs });
      const vector = await this.service.lane.run(() => this.client.embedImage(calibrationImage(),
        { model: this.model, signal: this.signal, timeoutMs: this.limits.calibrationTimeoutMs }),
      { priority: PRIORITY[this.kind], signal: this.signal });
      this.signal.throwIfAborted();
      let space;
      try {
        space = this.store.resolveSpace({
          backend: EMBEDDING_BACKEND, model: this.model, calibrationVersion: CALIBRATION_VERSION, calibration: vector,
        });
      } catch (error) {
        if (error instanceof EmbeddingServiceError) throw error;
        this.#storageFailure(error);
        return;
      }
      if (this.signal.aborted) return;
      this.space = space;
      if (space.replacesEarlier) {
        this.log(`image embeddings: ${this.model} now returns different vectors, so a new set starts; earlier vectors are kept but never compared with it`);
      } else if (space.created) {
        this.log(`image embeddings: started a ${space.dims}-dimension set for ${this.model}`);
      }
    } catch (error) {
      if (!this.signal.aborted) {
        this.#stop(error?.code ?? 'ml_error', `image embeddings paused for this run: ${safeMessage(error)}`
          + (unreachable(error) ? ' Use Settings → Enrich → Test connection; the URL must work from the Pictaria server itself.' : ''));
      }
    }
  }

  // Starts embedding one photo when the lane is free. Returns a promise that
  // never rejects, or null when the photo is left without a vector. With the
  // preview bytes in hand, an unchanged vector is recognised exactly.
  embed({ assetId, image = null, loadImage = null }) {
    if (this.closed || this.stopped || this.signal.aborted) { this.counts.paused++; return null; }
    if (!this.space) { this.counts.waiting++; return null; }
    if (this.request) { this.counts.busy++; return null; }
    let source, imageSha256 = null;
    try {
      if (image) imageSha256 = sha256(image.data);
      if (this.store.isCurrent(assetId, this.space.id, { imageSha256 })) { this.counts.current++; return null; }
      source = this.store.sourceOf(assetId);
    } catch (error) {
      this.#storageFailure(error);
      return null;
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([this.signal, controller.signal]);
    const promise = this.#embed({ assetId, source, image, imageSha256, loadImage, signal }).finally(() => {
      if (this.request?.promise === promise) this.request = null;
    });
    this.request = { promise, controller };
    return promise;
  }

  async #embed({ assetId, source, image, imageSha256, loadImage, signal }) {
    const started = this.service.elapsedNow();
    const spaceId = this.space.id;
    try {
      const input = image ?? await loadImage(signal);
      signal.throwIfAborted();
      const hash = imageSha256 ?? sha256(input.data);
      if (this.#storage(() => this.store.adopt({ assetId, spaceId, source, imageSha256: hash }))) {
        this.counts.current++;
        return 'current';
      }
      const vector = await this.service.lane.run(() => this.client.embedImage(input, { model: this.model, signal }),
        { priority: PRIORITY[this.kind], signal });
      // Never write once the photo's window or the run has closed.
      signal.throwIfAborted();
      if (vector.length !== this.space.dims) {
        throw new EmbeddingServiceError('the machine-learning service changed its output during this run', 'ml_output_changed');
      }
      this.#storage(() => this.store.save({ assetId, spaceId, source, imageSha256: hash, vector }));
      this.counts.embedded++;
      this.failures = 0;
      this.embedMs += this.service.elapsedNow() - started;
      return 'embedded';
    } catch (error) {
      if (error instanceof StorageFailure) return 'storage-error';
      if (this.signal.aborted) return 'cancelled';
      if (signal.aborted) {
        // The photo's window expired first: slower than enrichment itself.
        this.counts.late++;
        this.#serviceFailure(new EmbeddingServiceError(
          `the machine-learning service took longer than ${Math.round(this.limits.settleMs / 1000)} seconds after the photo finished`, 'ml_late'));
        return 'late';
      }
      this.counts.failed++;
      if (error instanceof EmbeddingServiceError && error.service) this.#serviceFailure(error);
      return 'failed';
    }
  }

  // Bounded post-vision wait. Work still running when it expires is aborted
  // and drained, so no request continues in the background.
  async settle(pending) {
    if (!pending) return;
    const started = this.service.elapsedNow();
    const finished = await within(pending, this.limits.settleMs, this.signal);
    if (!finished && this.request?.promise === pending) this.request.controller.abort();
    if (!finished) await within(pending, this.limits.closeGraceMs);
    const waited = this.service.elapsedNow() - started;
    this.waits.count++;
    this.waits.totalMs += waited;
    this.waits.maxMs = Math.max(this.waits.maxMs, waited);
  }

  async close({ cancelled = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.service.active.delete(this);
    if (!cancelled && this.request) await this.settle(this.request.promise);
    // The calibration may still be loading a model; the service can finish
    // that download on its own, but this session stops waiting for it.
    this.controller.abort();
    await within(Promise.all([this.request?.promise, this.calibration].filter(Boolean)), this.limits.closeGraceMs);
    const { embedded, current, busy, waiting, paused, late, failed } = this.counts;
    const skipped = busy + waiting + paused;
    const averageMs = embedded ? Math.round(this.embedMs / embedded) : null;
    const wait = this.waits.count ? { averageMs: Math.round(this.waits.totalMs / this.waits.count), maxMs: Math.round(this.waits.maxMs) } : null;
    if (this.client) {
      this.log(`image embeddings: ${embedded} new, ${current} already current, ${skipped} skipped, ${late} too slow, ${failed} failed`
        + (averageMs !== null ? ` · ${averageMs} ms per photo` : '')
        + (wait ? ` · waited ${wait.averageMs} ms on average (at most ${wait.maxMs} ms) after enrichment` : ''));
    }
    const summary = { model: this.model, ...this.counts, stopped: this.stopped, reason: this.reason,
      averageMs, wait, finishedAt: new Date(this.service.now()).toISOString() };
    // Settings and Enrich report the last Enrich run; lab passes report their own.
    if (this.kind === 'enrich') this.service.lastSession = summary;
    this.summary = summary;
  }

  // Stop for good and abort work in flight (Enrich reclaiming the service from
  // a lab pass). close() still drains and releases.
  preempt(message) {
    this.#stop('preempted', message);
    this.controller.abort();
  }

  #serviceFailure(error) {
    this.failures++;
    if (error.code === 'ml_output_changed' || this.failures >= this.limits.failureLimit) {
      this.#stop(error.code, `image embeddings paused for the rest of this run: ${safeMessage(error)}`);
    }
  }

  // Database failures are not machine-learning failures: stop, say so plainly
  // in the run log and server log, and let the Enrich run report its own state.
  #storage(work) {
    try { return work(); } catch (error) {
      if (error instanceof EmbeddingServiceError) throw error;
      this.#storageFailure(error);
      throw new StorageFailure();
    }
  }

  #storageFailure(error) {
    const message = safeMessage(error);
    console.error(`[Pictaria] Image embeddings could not read or write the Enrich database: ${message}`);
    this.#stop('storage_error', `image embeddings stopped for this run: the Enrich database rejected an embedding read or write (${message}). This is a storage problem, not a machine-learning one; check the server's disk and database`);
  }

  #stop(code, message) {
    if (this.stopped) return;
    this.stopped = code;
    this.reason = message;
    this.log(message);
  }
}

class StorageFailure extends Error {}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Resolves true when the promise settles first, false when ms elapse or the
// signal aborts. Clears its timer either way.
async function within(promise, ms, signal = null) {
  const timer = new AbortController();
  const stop = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  try {
    return await Promise.race([promise.then(() => true, () => true),
      sleep(ms, false, { signal: stop }).catch(() => false)]);
  } finally { timer.abort(); }
}

function safeMessage(error) {
  return sanitizeDiagnostic(error instanceof Error ? error.message : error, { maxBytes: 300, fallback: 'unknown error' });
}

function publicConnection({ state, message, checkedAt }) {
  return { state, ...(message ? { message } : {}), checkedAt: new Date(checkedAt).toISOString() };
}
