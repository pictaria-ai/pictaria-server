import { setTimeout as sleep } from 'node:timers/promises';
import { EmbeddingServiceError } from './client.mjs';
import { EMBEDDING_BACKEND } from './models.mjs';

export const BACKFILL_LIMITS = Object.freeze({
  pageSize: 200,
  // While an Enrich run holds the service, check this often whether it ended.
  enrichPollMs: 2_000,
  // Photos in a row that fail (usually the preview download) before stopping,
  // so an Immich outage does not walk the whole worklist.
  failureLimit: 10,
  drainMs: 2_000,
});

const RUNNING = new Set(['starting', 'running', 'waiting']);

// Settings → Enrich → Image embeddings → "Embed enriched photos": embeds every
// enriched photo that lacks a current vector for the selected model, one at a
// time, through the same sessions, lane and identity rules as Enrich. Vectors
// are saved as they are computed, so starting again continues with whatever
// is still missing; no job state is persisted. Enrich runs go first.
export class EmbeddingBackfill {
  constructor({ service, immich, immichReady = () => true, log = () => {}, limits = BACKFILL_LIMITS }) {
    Object.assign(this, { service, immich, immichReady, log, limits });
    this.store = service.repo.embeddings;
    this.shutdown = new AbortController();
    this.job = null;
    this.promise = null;
  }

  status() {
    const { model } = this.service.settings();
    const job = this.job;
    return {
      enriched: this.store.enrichedCoverage({ backend: EMBEDDING_BACKEND, model }),
      sets: this.store.sets({ backend: EMBEDDING_BACKEND, model }),
      backfill: job ? { ...job, running: RUNNING.has(job.state) } : { state: 'idle', running: false },
    };
  }

  running() {
    return Boolean(this.job && RUNNING.has(this.job.state));
  }

  // Throws EmbeddingServiceError with a user-facing message when it cannot start.
  start() {
    if (this.closed) throw new EmbeddingServiceError('Pictaria is shutting down.', 'backfill_unavailable', { service: false });
    if (this.running()) throw new EmbeddingServiceError('Enriched photos are already being embedded.', 'backfill_running', { service: false });
    const { enabled, url, model } = this.service.settings();
    if (!enabled) throw new EmbeddingServiceError('Turn on Image embeddings in Settings → Enrich first.', 'ml_off', { service: false });
    if (!url) {
      throw new EmbeddingServiceError('Set the Immich machine-learning URL in Settings → Enrich → Image embeddings first.',
        'ml_not_configured', { service: false });
    }
    if (!this.immichReady()) throw new EmbeddingServiceError('Connect Immich in Settings first.', 'immich_not_configured', { service: false });
    if (this.service.passActive()) {
      throw new EmbeddingServiceError('A stacking-lab pass is embedding photos. Try again when it finishes.', 'ml_busy', { service: false });
    }
    // With everything covered it still checks the service first, so a changed
    // model or preprocessing is noticed and re-embedded into a new set.
    this.store.enrichedCache = null;
    if (this.store.enrichedCoverage({ backend: EMBEDDING_BACKEND, model }).total === 0) {
      throw new EmbeddingServiceError('There are no enriched photos to embed yet.', 'backfill_nothing', { service: false });
    }
    this.controller = new AbortController();
    // `failed` counts photos skipped because they could not be embedded.
    this.job = { state: 'starting', model, total: null, done: 0, embedded: 0, current: 0, failed: 0,
      startedAt: new Date(this.service.now()).toISOString(), finishedAt: null, reason: null, elapsedMs: 0 };
    this.startedAt = this.service.elapsedNow();
    this.log(`embedding enriched photos: started (${model})`);
    this.promise = this.#run(model).catch((error) => {
      this.#finish('failed', `it stopped unexpectedly: ${error?.message ?? error}`);
    });
    return this.status().backfill;
  }

  // Stop asked for by the person: the current request is aborted and nothing
  // is written afterwards. Completed photos keep their vectors.
  async stop() {
    if (!this.running()) return this.status().backfill;
    this.stopRequested = true;
    this.controller.abort();
    await this.#drain();
    return this.status().backfill;
  }

  // Server shutdown: stop admitting work, cancel, and wait briefly.
  async close() {
    this.closed = true;
    this.shutdown.abort();
    await this.#drain();
  }

  async #drain() {
    if (!this.promise) return;
    const stop = new AbortController();
    try {
      await Promise.race([this.promise, sleep(this.limits.drainMs, undefined, { signal: stop.signal }).catch(() => {})]);
    } finally { stop.abort(); }
  }

  async #run(model) {
    const signal = AbortSignal.any([this.controller.signal, this.shutdown.signal]);
    const job = this.job;
    // The worklist is walked newest capture first, but Enrich and Curate can
    // refresh a capture time from Immich while the job runs, moving a photo
    // behind the cursor. So a walk that reaches the end starts again from the
    // top, passing over photos this job already tried, and the job finishes
    // only after a walk finds no photo it has not tried. Skipped photos (ones
    // that could not be embedded) are not retried within a job.
    const skipped = new Set();
    let tried = new Set(), after = null, found = false, spaceId = null, failuresInRow = 0;
    while (!signal.aborted) {
      // Enrich goes first: wait for its run to end, then continue.
      if (this.service.enrichActive()) {
        job.state = 'waiting';
        try { await sleep(this.limits.enrichPollMs, undefined, { signal }); } catch { break; }
        continue;
      }
      let pass;
      try {
        pass = this.service.backfillPass({ model, signal, log: (message) => this.log(message) });
      } catch (error) {
        // An Enrich run or a short lab pass holds the service: wait for it.
        if (error instanceof EmbeddingServiceError && error.code === 'ml_busy') {
          job.state = 'waiting';
          try { await sleep(this.limits.enrichPollMs, undefined, { signal }); } catch { break; }
          continue;
        }
        return this.#finish('stopped', message(error));
      }
      try {
        job.state = 'running';
        await pass.start({ waitForModel: true });
        if (signal.aborted) break;
        if (pass.stopped === 'preempted') continue;
        if (pass.stopped || !pass.space) return this.#finish('stopped', pass.reason ?? 'the machine-learning service did not answer');
        // Calibration picks the set. A different set (the service's output
        // changed) starts the walk over; skipped photos stay skipped, so they
        // are not counted twice.
        if (pass.space.id !== spaceId) { spaceId = pass.space.id; tried = new Set(skipped); after = null; found = false; }
        this.#count(spaceId);
        for (;;) {
          const page = this.store.missingEnriched(spaceId, { after, limit: this.limits.pageSize });
          if (!page.length) {
            if (!found) return this.#finish('finished', null);
            after = null;
            found = false;
            this.#count(spaceId);
            continue;
          }
          for (const row of page) {
            if (signal.aborted || pass.stopped) break;
            if (tried.has(row.assetId)) { after = row; continue; }
            found = true;
            const settings = this.service.settings();
            if (!settings.enabled) return this.#finish('stopped', 'Image embeddings were turned off');
            if (settings.model !== model) return this.#finish('stopped', 'the embedding model changed in Settings; start again to embed photos for the new model');
            const pending = pass.embed({ assetId: row.assetId,
              loadImage: (requestSignal) => this.immich.getAssetThumbnail(row.assetId, 'preview', { signal: requestSignal }) });
            const outcome = pending ? await pending : pass.stopped ? 'paused' : 'current';
            // A photo interrupted by Enrich or Stop is not counted; it is offered again.
            if (outcome === 'cancelled' || outcome === 'paused') break;
            after = row;
            tried.add(row.assetId);
            job.done++;
            if (outcome === 'embedded') { job.embedded++; failuresInRow = 0; }
            else if (outcome === 'current') { job.current++; failuresInRow = 0; }
            else {
              job.failed++;
              skipped.add(row.assetId);
              if (++failuresInRow >= this.limits.failureLimit) {
                return this.#finish('stopped', `${failuresInRow} photos in a row could not be embedded; check Immich and the machine-learning service`);
              }
            }
            job.elapsedMs = Math.round(this.service.elapsedNow() - this.startedAt);
          }
          if (signal.aborted) break;
          if (pass.stopped === 'preempted') break;
          if (pass.stopped) return this.#finish('stopped', pass.reason);
        }
      } finally {
        await pass.close({ cancelled: signal.aborted || pass.stopped === 'preempted' });
      }
    }
    if (this.shutdown.signal.aborted) return this.#finish('stopped', 'the server stopped');
    return this.#finish('stopped', this.stopRequested ? 'you stopped it' : 'it was cancelled');
  }

  // Photos done so far plus those still to try. Skipped photos stay missing,
  // so they are taken off.
  #count(spaceId) {
    const job = this.job;
    job.total = Math.max(job.done, job.done + this.store.countMissingEnriched(spaceId) - job.failed);
  }

  #finish(state, reason) {
    const job = this.job;
    if (!job || !RUNNING.has(job.state)) return;
    this.stopRequested = false;
    job.state = state;
    job.reason = reason ? reason.replace(/^image embeddings( paused for this run| paused for the rest of this run| stopped for this run)?: /, '') : null;
    job.finishedAt = new Date(this.service.now()).toISOString();
    job.elapsedMs = Math.round(this.service.elapsedNow() - this.startedAt);
    this.store.enrichedCache = null;
    this.store.coverageCache = null;
    this.store.setsCache = null;
    this.log(`embedding enriched photos: ${state} — ${job.embedded} embedded, ${job.current} already current, ${job.failed} skipped`
      + (job.reason ? ` (${job.reason})` : ''));
  }
}

function message(error) {
  return error instanceof EmbeddingServiceError ? error.message.replace(/\.$/, '') : `it stopped unexpectedly: ${error?.message ?? error}`;
}
