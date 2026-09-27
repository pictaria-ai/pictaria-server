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
  // Extra wait for a photo's vector once its enrichment has finished.
  settleMs: 5_000,
  // Consecutive service failures that pause embedding for the rest of a run.
  failureLimit: 3,
  connectionCacheMs: 60_000,
  testTimeoutMs: 120_000,
});

// Optional Enrich step. Sessions never throw into the enrichment run: every
// outcome is counted and logged, and a missing vector is left for backfill.
export class EmbeddingService {
  constructor({ repo, config, fetchImpl = fetch, now = Date.now, elapsedNow = () => performance.now(),
    limits = EMBEDDING_LIMITS, wait = (ms, signal) => sleep(ms, undefined, { signal }) }) {
    Object.assign(this, { repo, config, fetchImpl, now, elapsedNow, limits, wait });
    this.lastConnection = null;
    this.lastSession = null;
    this.testing = false;
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
      await client.ping({ signal });
      const started = this.elapsedNow();
      const vector = await client.embedImage(calibrationImage(), { model: name, signal, timeoutMs: this.limits.testTimeoutMs });
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
    return enabled ? new EmbeddingSession(this, { url, model, log, signal }) : null;
  }
}

class EmbeddingSession {
  constructor(service, { url, model, log, signal }) {
    Object.assign(this, { service, url, model, log });
    this.store = service.repo.embeddings;
    this.limits = service.limits;
    this.controller = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.space = null;
    this.stopped = null;
    this.inFlight = null;
    this.failures = 0;
    this.embedMs = 0;
    this.counts = { embedded: 0, current: 0, busy: 0, waiting: 0, paused: 0, failed: 0 };
  }

  async start() {
    let client = null;
    try { client = this.url ? new ImmichMlClient({ baseUrl: this.url, fetchImpl: this.service.fetchImpl }) : null; } catch {}
    if (!client) {
      this.#stop('ml_not_configured', 'image embeddings are on, but no valid machine-learning URL is set; photos are enriched without them');
      return;
    }
    this.client = client;
    this.log(`image embeddings: on (${this.model})`);
    this.calibration = this.#calibrate();
    await Promise.race([this.calibration, this.service.wait(this.limits.calibrationWaitMs, this.signal).catch(() => {})]);
    if (!this.space && !this.stopped && !this.signal.aborted) {
      this.log('image embeddings: waiting for the machine-learning service to load the model (the first use downloads it); photos continue without embeddings until it is ready');
    }
  }

  async #calibrate() {
    try {
      await this.client.ping({ signal: this.signal });
      const vector = await this.client.embedImage(calibrationImage(),
        { model: this.model, signal: this.signal, timeoutMs: this.limits.calibrationTimeoutMs });
      const space = this.store.resolveSpace({
        backend: EMBEDDING_BACKEND, model: this.model, calibrationVersion: CALIBRATION_VERSION, calibration: vector,
      });
      if (this.signal.aborted) return;
      this.space = space;
      if (space.replacesEarlier) {
        this.log(`image embeddings: ${this.model} now returns different vectors, so a new set starts; earlier vectors are kept but never compared with it`);
      } else if (space.created) {
        this.log(`image embeddings: started a ${space.dims}-dimension set for ${this.model}`);
      }
    } catch (error) {
      if (!this.signal.aborted) this.#stop(error?.code ?? 'ml_error', `image embeddings paused for this run: ${safeMessage(error)}`);
    }
  }

  // Starts embedding one photo when the lane is free. Returns a promise that
  // never rejects, or null when the photo is left without a vector.
  embed({ assetId, image = null, loadImage = null }) {
    if (this.closed || this.stopped) { this.counts.paused++; return null; }
    if (!this.space) { this.counts.waiting++; return null; }
    if (this.inFlight) { this.counts.busy++; return null; }
    let source;
    try {
      if (this.store.isCurrent(assetId, this.space.id)) { this.counts.current++; return null; }
      source = this.store.sourceOf(assetId);
    } catch { this.counts.failed++; return null; }
    const work = this.#embed(assetId, source, image, loadImage).finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
    this.inFlight = work;
    return work;
  }

  async #embed(assetId, source, image, loadImage) {
    const started = this.service.elapsedNow();
    try {
      const input = image ?? await loadImage();
      this.signal.throwIfAborted();
      const vector = await this.client.embedImage(input, { model: this.model, signal: this.signal });
      if (vector.length !== this.space.dims) {
        throw new EmbeddingServiceError('the machine-learning service changed its output during this run', 'ml_output_changed');
      }
      this.store.save({ assetId, spaceId: this.space.id, source,
        imageSha256: createHash('sha256').update(input.data).digest('hex'), vector });
      this.counts.embedded++;
      this.failures = 0;
      this.embedMs += this.service.elapsedNow() - started;
      return 'embedded';
    } catch (error) {
      if (this.signal.aborted) return 'cancelled';
      this.counts.failed++;
      if (error instanceof EmbeddingServiceError && error.service) {
        this.failures++;
        if (error.code === 'ml_output_changed' || this.failures >= this.limits.failureLimit) {
          this.#stop(error.code, `image embeddings paused for the rest of this run: ${safeMessage(error)}`);
        }
      }
      return 'failed';
    }
  }

  // Wait briefly for a photo's vector so it normally lands with its photo.
  async settle(pending) {
    if (!pending) return;
    await Promise.race([pending, this.service.wait(this.limits.settleMs, this.signal).catch(() => {})]);
  }

  async close({ cancelled = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    if (!cancelled && this.inFlight) await this.settle(this.inFlight);
    // Anything still pending after that grace is abandoned; its photo is left
    // for backfill. The service may still finish a model download on its own.
    this.controller.abort();
    await this.inFlight;
    await this.calibration;
    const { embedded, current, busy, waiting, paused, failed } = this.counts;
    const skipped = busy + waiting + paused;
    if (this.client) {
      this.log(`image embeddings: ${embedded} new, ${current} already current, ${skipped} skipped, ${failed} failed`
        + (embedded ? ` · ${Math.round(this.embedMs / embedded)} ms per photo` : ''));
    }
    this.service.lastSession = { model: this.model, ...this.counts, stopped: this.stopped,
      averageMs: embedded ? Math.round(this.embedMs / embedded) : null, finishedAt: new Date(this.service.now()).toISOString() };
  }

  #stop(code, message) {
    if (this.stopped) return;
    this.stopped = code;
    this.log(message);
  }
}

function safeMessage(error) {
  return sanitizeDiagnostic(error instanceof Error ? error.message : error, { maxBytes: 300, fallback: 'unknown error' });
}

function publicConnection({ state, message, checkedAt }) {
  return { state, ...(message ? { message } : {}), checkedAt: new Date(checkedAt).toISOString() };
}
