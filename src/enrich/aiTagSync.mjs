import { ImmichApiError } from '../immich.mjs';
import { awaitDrain } from '../lifecycle.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

// Independent durable backlog, shared write boundary. Backoff never holds
// the coordinator, and a large AI backlog cannot fill the decision queue.
const BACKOFF_MS = 30000;
const IDLE_MS = 5000;

export class AiTagSyncService {
  constructor({ repo, immich, review, tagWrites, config, log = () => {} }) {
    Object.assign(this, { repo, immich, review, tagWrites, config, log });
    this.store = repo.aiTagSync;
    this.stopped = true;
    this.done = null;
    this.waker = null;
  }

  status() { return { ...this.store.status(), paused: !this.config.enrichEnabled }; }
  retry() { const n = this.store.retry(); this.wake(); return n; }
  wake() { this.waker?.(); }
  start() {
    if (this.done) return;
    this.stopped = false;
    this.done = this.loop().finally(() => { this.done = null; });
  }
  async stop(timeoutMs = 3000) {
    this.stopped = true;
    this.wake();
    return this.done ? awaitDrain(this.done, timeoutMs) : true;
  }

  async loop() {
    while (!this.stopped) {
      let worked = false;
      try { worked = await this.tick(); }
      catch (error) {
        // Database/read failures also must not create an unhandled rejection.
        this.log(`AI tag sync will retry: ${this.diagnostic(error)}`);
      }
      if (!worked) await this.sleep(IDLE_MS);
    }
  }

  diagnostic(error) {
    return sanitizeDiagnostic(error instanceof Error ? error.message : error, {
      secrets: configuredSecrets(this.config, this.immich),
    });
  }

  async tick() {
    if (!this.config.enrichEnabled || this.store.status().retryAfter > Date.now()) return false;
    if (!this.store.next(1).length) return false;
    return this.tagWrites.run(async () => {
      if (!this.config.enrichEnabled || this.stopped) return false;
      // Choose and snapshot only AFTER acquiring the write boundary.
      const batch = this.store.next();
      if (!batch.length) return false;
      const active = [];
      const remoteAssets = new Map();
      let attempted = null;
      let stage = 'read';
      try {
        for (const item of batch) {
          if (!this.store.current(item)) continue;
          attempted = item;
          try {
            const asset = await this.immich.getAsset(item.assetId);
            if (!Array.isArray(asset?.tags)) {
              throw new ImmichApiError('Immich did not expose asset tags. Enable Tags for the API-key account and grant tag.read, tag.create, and tag.asset.', 403);
            }
            remoteAssets.set(item.assetId, asset);
            active.push(item);
          } catch (error) {
            if (error instanceof ImmichApiError && error.status === 404) {
              this.store.mark(item, 'skipped', 'Photo no longer exists in Immich.');
              continue;
            }
            throw error;
          }
        }
        if (!active.length) { this.store.defer(null, 0); return true; }
        stage = 'write';
        const assetIds = active.map(item => item.assetId);
        const localTagsByAsset = this.repo.loadAssetTagsFor(assetIds, { prefix: 'ai/' });
        await this.review.syncAiTagsForAssets(assetIds, undefined, { localTagsByAsset, remoteAssets });
        await this.review.verifyAndRepairTags({ assetIds, add: [], remove: [] }, { localTagsByAsset, verifyAiRemovals: true });
        for (const item of active) this.store.mark(item, 'written');
        this.store.defer(null, 0);
      } catch (error) {
        const message = this.diagnostic(error);
        // Permission, connectivity, overload and server errors pause the lane
        // without burning retries on thousands of individual photos.
        const systemic = error.code !== 'immich_tag_inconsistent' && (
          !(error instanceof ImmichApiError) || error.status == null
          || [401, 403, 408, 429].includes(error.status) || error.status >= 500);
        if (!systemic) {
          for (const item of stage === 'read' ? (attempted ? [attempted] : []) : active) {
            if (error.code === 'immich_tag_inconsistent' && !error.assetIds.includes(item.assetId)) {
              this.store.mark(item, 'written');
            } else {
              this.store.failure(item, message);
            }
          }
        }
        this.store.defer(message, Date.now() + BACKOFF_MS);
      }
      return true;
    }, { priority: 0 });
  }

  sleep(ms) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); this.waker = null; resolve(); };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.waker = finish;
      if (this.stopped) finish();
    });
  }
}
