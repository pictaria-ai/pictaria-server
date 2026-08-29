import { ImmichApiError } from '../immich.mjs';
import { awaitDrain } from '../lifecycle.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

// Opt-in writeback of enrichment captions into Immich's description field,
// so photos become searchable in Immich itself by what's actually in them.
//
// Runs from its own durable queue (caption_writeback table) — deliberately
// separate from the decision-sync queue, which applies strictly in order: a
// library-sized caption backfill must never block a Curate decision from
// reaching Immich.
//
// The rule is "never knowingly overwrite a human": an empty description
// receives the caption; a description that exactly matches what we wrote
// before may be updated when a newer enrichment changes the caption; any
// other text is someone's own words and is skipped permanently. Immich does
// not offer a conditional asset update, so the read below is the final safe
// decision point before its unavoidable, narrow read-to-write interval.

const IDLE_POLL_MS = 5000;
const ERROR_BACKOFF_MS = 15000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;

export class CaptionWritebackService {
  constructor({ repo, immich, config, log = () => {} }) {
    this.repo = repo;
    this.immich = immich;
    this.config = config;
    this.log = log;
    this._running = false;
    this._wake = null;
    this._lastError = null;
    this._sessionWritten = 0;
    this._stopRequested = false;
    this._loopDone = null;
  }

  status() {
    return {
      enabled: Boolean(this.config.captionWriteback),
      ...this.repo.captionWritebackCounts(),
      lastError: this._lastError,
    };
  }

  enqueue(assetIds) {
    const queued = this.repo.captionWritebackEnqueue(assetIds);
    if (queued > 0) {
      this.wake();
    }
    return queued;
  }

  backfill() {
    const queued = this.repo.captionWritebackBackfill();
    if (queued > 0) {
      this.wake();
    }
    return queued;
  }

  wake() {
    if (this._wake) {
      const wake = this._wake;
      this._wake = null;
      wake();
    }
  }

  start() {
    // Restartable: clear any stale stop request before spawning the loop.
    this._stopRequested = false;
    if (this._running) {
      return;
    }
    this._running = true;
    this._loopDone = this.#loop();
  }

  // Shutdown drain: signal the loop, wake an idle sleep, and resolve when the
  // in-flight write (if any) finishes — the queue is durable, so anything
  // still pending resumes on the next start. The wait is bounded so a stalled
  // Immich call can never hang shutdown; the server's force-exit timer stays
  // the backstop.
  async stop(timeoutMs = 3000) {
    this._stopRequested = true;
    this.wake();
    if (!this._loopDone) {
      return true;
    }
    // Returns false on give-up so the lifecycle registry can warn by name.
    return awaitDrain(this._loopDone, timeoutMs);
  }

  async #loop() {
    for (;;) {
      if (this._stopRequested) {
        this._running = false;
        return;
      }
      if (!this.config.captionWriteback) {
        await this.#sleep(IDLE_POLL_MS);
        continue;
      }
      const batch = this.repo.captionWritebackNext(BATCH_SIZE);
      if (batch.length === 0) {
        await this.#sleep(IDLE_POLL_MS);
        continue;
      }
      let hadError = false;
      for (const item of batch) {
        if (this._stopRequested || !this.config.captionWriteback) {
          break;
        }
        try {
          await this.pushOne(item);
          this._lastError = null;
        } catch (error) {
          hadError = true;
          this._lastError = sanitizeDiagnostic(error instanceof Error ? error.message : error, {
            secrets: configuredSecrets(this.config, this.immich),
          });
          this.repo.captionWritebackFailure(item.assetId, this._lastError, { maxAttempts: MAX_ATTEMPTS });
        }
      }
      if (hadError) {
        await this.#sleep(ERROR_BACKOFF_MS);
      }
    }
  }

  async pushOne(item) {
    const caption = typeof item.caption === 'string' ? item.caption.trim() : '';
    if (!caption) {
      this.repo.captionWritebackMark(item.assetId, { status: 'skipped', note: 'no caption' });
      return;
    }
    let asset;
    try {
      asset = await this.immich.getAsset(item.assetId);
    } catch (error) {
      if (error instanceof ImmichApiError && error.status === 404) {
        this.repo.captionWritebackMark(item.assetId, { status: 'skipped', note: 'asset not found in Immich' });
        return;
      }
      throw error;
    }
    const current = String(asset?.exifInfo?.description ?? '').trim();
    if (current === caption) {
      // Already says what we'd write (e.g. from an earlier install).
      this.repo.captionWritebackMark(item.assetId, { status: 'written', writtenDescription: caption });
      return;
    }
    if (current && current !== String(item.writtenDescription ?? '').trim()) {
      this.repo.captionWritebackMark(item.assetId, { status: 'skipped', note: 'existing description kept' });
      return;
    }

    await this.immich.updateAsset(item.assetId, { description: caption });
    this.repo.captionWritebackMark(item.assetId, { status: 'written', writtenDescription: caption });
    this._sessionWritten += 1;
    if (this._sessionWritten % 500 === 0) {
      this.log(`caption writeback: ${this._sessionWritten} descriptions written since start`);
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      this._wake = resolve;
      const timer = setTimeout(() => {
        if (this._wake === resolve) {
          this._wake = null;
        }
        resolve();
      }, ms);
      timer.unref?.();
    });
  }
}
