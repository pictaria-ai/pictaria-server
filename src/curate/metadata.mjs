import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { CurateError, fingerprint } from './contracts.mjs';

export const METADATA_LIMITS = Object.freeze({
  batch: 500,
  concurrency: 2,
  minIntervalMs: 30_000,
  freshnessMs: 24 * 60 * 60_000,
  backoffMaxMs: 15 * 60_000,
  contextMs: 30 * 60_000,
  timeoutMs: 30_000,
  responseBytes: 1024 * 1024,
});
export const METADATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_metadata (
 asset_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, priority INTEGER NOT NULL,
 next_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER, checked_at INTEGER,
 context_until INTEGER NOT NULL DEFAULT 0, claim_id TEXT, outcome TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_curate_metadata_due ON curate_metadata(priority,next_at,asset_id);
CREATE TABLE IF NOT EXISTS curate_metadata_control (
 id INTEGER PRIMARY KEY CHECK(id=1), connection_key TEXT, failures INTEGER NOT NULL DEFAULT 0,
 retry_at INTEGER NOT NULL DEFAULT 0, problem TEXT
);
INSERT OR IGNORE INTO curate_metadata_control(id) VALUES(1);
CREATE TRIGGER IF NOT EXISTS curate_metadata_cleanup AFTER DELETE ON review_list BEGIN
 DELETE FROM curate_metadata WHERE asset_id=OLD.asset_id;
END;
INSERT OR IGNORE INTO curate_dirty(asset_id) SELECT asset_id FROM review_list
 WHERE NOT EXISTS(SELECT 1 FROM curate_metadata WHERE curate_metadata.asset_id=review_list.asset_id);
`;

// Observed source image/duplicate/time and detail evidence changes request a
// new read. Enrich output, human decisions, and Immich updatedAt (also changed
// by tags) do not.
export const metadataSourceKey = (asset, observation) =>
  fingerprint([
    asset.checksum,
    asset.file_created_at,
    asset.file_modified_at,
    asset.width,
    asset.height,
    asset.thumbhash,
    asset.duplicate_id,
    asset.missing_since,
    observation,
  ]);

export class CurateMetadataStore {
  constructor(store) {
    this.store = store;
    this.repo = store.repo;
  }
  prepare(sql) {
    return this.store.prepare(sql);
  }
  row(id) {
    return this.prepare('SELECT * FROM curate_metadata WHERE asset_id=?').get(id);
  }
  control() {
    return this.prepare('SELECT * FROM curate_metadata_control WHERE id=1').get();
  }
  project(id, asset, state, observation, now = Date.now()) {
    const key = metadataSourceKey(asset, observation);
    this.prepare(
      `INSERT INTO curate_metadata(asset_id,source_key,priority) VALUES(?,?,?)
      ON CONFLICT(asset_id) DO UPDATE SET
      priority=CASE WHEN excluded.priority=1 THEN 1 WHEN context_until>? AND (next_at<=? OR source_key IS NOT excluded.source_key) THEN 2 ELSE 0 END,
      next_at=CASE WHEN source_key IS NOT excluded.source_key
        THEN MIN(next_at,MAX(?,COALESCE(last_attempt_at,0)+?)) ELSE next_at END,
      outcome=CASE WHEN source_key IS NOT excluded.source_key THEN 'pending' ELSE outcome END,
      source_key=excluded.source_key`,
    ).run(id, key, state === 'undecided' ? 1 : 0, now, now, now, METADATA_LIMITS.minIntervalMs);
  }
  request(ids, now, { force = false } = {}) {
    if (
      !Array.isArray(ids) ||
      ids.length > METADATA_LIMITS.batch ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !id || id.length > 128)
    )
      throw new CurateError('Metadata refresh needs at most 500 distinct photos.', 'invalid_curate_query', 400);
    if (this.repo.reviewListMembership(ids).size !== ids.length)
      throw new CurateError('Metadata refresh must target review photos.');
    this.store.flushIds(ids);
    this.repo.transaction(() => {
      for (const id of ids)
        this.prepare(
          `UPDATE curate_metadata SET
        priority=CASE WHEN priority=1 THEN 1 WHEN ? OR next_at<=? THEN 2 ELSE 0 END,context_until=?,
        next_at=CASE WHEN ? THEN MIN(next_at,MAX(?,COALESCE(last_attempt_at,0)+?)) ELSE next_at END
        WHERE asset_id=?`,
        ).run(
          Number(force),
          now,
          now + METADATA_LIMITS.contextMs,
          Number(force),
          now,
          METADATA_LIMITS.minIntervalMs,
          id,
        );
    });
  }
  connection(key) {
    if (this.control().connection_key === key) return;
    this.repo.transaction(() => {
      this.prepare(
        'UPDATE curate_metadata_control SET connection_key=?,failures=0,retry_at=0,problem=NULL WHERE id=1',
      ).run(key);
      // A different connection must revalidate its view of the pending library.
      // Existing observations remain last-observed evidence until refreshed.
      this.prepare("UPDATE curate_metadata SET next_at=0,claim_id=NULL,outcome='pending'").run();
    });
  }
  next(now, limit = METADATA_LIMITS.batch) {
    // Read at most one bounded page from either priority. Retire expired
    // context without scanning decided history to find an eligible row.
    const select = (priority, count) =>
      this.prepare(
        `SELECT asset_id,context_until FROM curate_metadata
      WHERE priority=? AND next_at<=? ORDER BY next_at,asset_id LIMIT ?`,
      ).all(priority, now, count);
    const context = [];
    for (const row of select(2, limit)) {
      if (row.context_until > now) context.push(row);
      else this.prepare('UPDATE curate_metadata SET priority=0 WHERE asset_id=?').run(row.asset_id);
    }
    return [...context, ...select(1, limit - context.length)].map((row) => row.asset_id);
  }

  claim(id, now) {
    this.store.flushIds([id]);
    const row = this.row(id);
    if (!row || row.next_at > now || !(row.priority === 1 || (row.priority === 2 && row.context_until > now)))
      return null;
    const claimId = randomUUID();
    this.prepare('UPDATE curate_metadata SET claim_id=?,last_attempt_at=?,next_at=? WHERE asset_id=?').run(
      claimId,
      now,
      now + METADATA_LIMITS.minIntervalMs,
      id,
    );
    return { id, claimId, sourceKey: row.source_key };
  }
  current(claim) {
    this.store.flushIds([claim.id]);
    const row = this.row(claim.id);
    return row?.claim_id === claim.claimId && row.source_key === claim.sourceKey;
  }
  complete(claim, outcome, now) {
    this.prepare(
      `UPDATE curate_metadata SET checked_at=?,next_at=?,claim_id=NULL,outcome=?,
      priority=CASE WHEN priority=2 THEN 0 ELSE priority END WHERE asset_id=? AND claim_id=?`,
    ).run(now, now + METADATA_LIMITS.freshnessMs, outcome, claim.id, claim.claimId);
  }
  defer(claim, now, problem) {
    this.prepare('UPDATE curate_metadata SET claim_id=NULL,next_at=?,outcome=? WHERE asset_id=? AND claim_id=?').run(
      now + METADATA_LIMITS.minIntervalMs,
      problem,
      claim.id,
      claim.claimId,
    );
  }
  fail(now, problem) {
    const failures = Math.min(this.control().failures + 1, 16);
    const retryAt = now + Math.min(METADATA_LIMITS.backoffMaxMs, METADATA_LIMITS.minIntervalMs * 2 ** (failures - 1));
    this.prepare('UPDATE curate_metadata_control SET failures=?,retry_at=?,problem=? WHERE id=1').run(
      failures,
      retryAt,
      problem,
    );
  }
  recovered() {
    this.prepare('UPDATE curate_metadata_control SET failures=0,retry_at=0,problem=NULL WHERE id=1').run();
  }
}

// One durable, bounded Immich-read lane. It has no AI/provider or tag-writing
// responsibilities. Normal page responses do not await a metadata request.
export class CurateMetadataRefresher {
  constructor({ curate, now = Date.now, automatic = true }) {
    this.curate = curate;
    this.store = curate.store.metadata;
    this.now = now;
    this.automatic = automatic;
    this.work = null;
    this.controller = null;
    this.scheduled = null;
  }
  connectionKey(client) {
    return fingerprint([client.baseUrl ?? 'injected', client.apiKey ?? 'injected']);
  }
  configured(client) {
    return Boolean(
      client?.getAsset &&
        (!Object.hasOwn(client, 'baseUrl') || client.baseUrl) &&
        (!Object.hasOwn(client, 'apiKey') || client.apiKey),
    );
  }
  enabled() {
    return (
      !this.curate.closed && this.curate.config.curateBurstGrouping !== false && this.configured(this.curate.immich)
    );
  }
  demanded() {
    return Boolean(
      this.curate.store
        .prepare("SELECT 1 FROM curate_leases WHERE kind='view' AND expires_at>? LIMIT 1")
        .get(this.now()),
    );
  }
  status() {
    const row = this.store.control();
    return {
      state: !this.configured(this.curate.immich)
        ? 'not-configured'
        : this.curate.config.curateBurstGrouping === false
          ? 'stacks-off'
          : this.work
            ? 'refreshing'
            : Math.max(row.retry_at, this.localRetryAt ?? 0) > this.now()
              ? 'paused'
              : 'idle',
      problem: this.localProblem ?? row.problem,
      retryAt: Math.max(row.retry_at, this.localRetryAt ?? 0) || null,
    };
  }
  wake() {
    if (!this.automatic || this.scheduled || this.work || !this.enabled() || !this.demanded()) return;
    this.scheduled = globalThis.setImmediate(() => {
      this.scheduled = null;
      void this.tick().catch(() => {});
    });
    this.scheduled.unref?.();
  }
  settingsChanged() {
    if (!this.enabled() || (this.activeKey && this.activeKey !== this.connectionKey(this.curate.immich)))
      this.controller?.abort();
    this.wake();
  }
  tick() {
    if (this.work) return this.work;
    this.work = this.run()
      .catch((error) => {
        this.localProblem = 'storage-error';
        this.localRetryAt = this.now() + METADATA_LIMITS.minIntervalMs;
        throw error;
      })
      .finally(() => {
        this.work = null;
      });
    return this.work;
  }
  async run() {
    if (!this.enabled() || !this.demanded() || this.localRetryAt > this.now()) return { attempted: 0 };
    this.localProblem = null;
    this.localRetryAt = null;
    const original = this.curate.immich;
    const key = this.connectionKey(original);
    this.store.connection(key);
    const control = this.store.control();
    if (control.retry_at > this.now()) return { attempted: 0 };
    // A paused lane admits one recovery probe, not another 500-photo batch.
    const ids = this.store.next(this.now(), control.problem ? 1 : METADATA_LIMITS.batch);
    if (!ids.length) return { attempted: 0 };
    if (control.problem)
      this.curate.store
        .prepare('UPDATE curate_metadata_control SET retry_at=? WHERE id=1')
        .run(this.now() + METADATA_LIMITS.minIntervalMs);
    const client = original.clone?.() ?? original;
    if (client !== original)
      client.timeoutMs = Math.min(client.timeoutMs ?? METADATA_LIMITS.timeoutMs, METADATA_LIMITS.timeoutMs);
    this.controller = new AbortController();
    this.activeKey = key;
    const controller = this.controller;
    const allowed = () =>
      this.enabled() && this.demanded() && !controller.signal.aborted && key === this.connectionKey(this.curate.immich);
    let cursor = 0,
      failed = false;
    const result = { attempted: 0, updated: 0, unavailable: 0, discarded: 0 };
    const worker = async () => {
      while (cursor < ids.length && !failed && allowed()) {
        const claim = this.store.claim(ids[cursor++], this.now());
        if (!claim) continue;
        result.attempted++;
        let applying = false;
        try {
          const asset = await client.getAsset(claim.id, {
            signal: controller.signal,
            maxBytes: METADATA_LIMITS.responseBytes,
          });
          if (!allowed()) {
            result.discarded++;
            continue;
          }
          if (
            asset?.id !== claim.id ||
            !['fileCreatedAt', 'checksum', 'people'].some((field) => Object.hasOwn(asset, field))
          )
            throw Object.assign(Error('Invalid asset-detail response.'), { code: 'curate_metadata_invalid' });
          applying = true;
          this.curate.repo.transaction(() => {
            if (!this.store.current(claim)) {
              result.discarded++;
              return;
            }
            this.curate.store.mergeMetadataAsset(asset);
            this.curate.store.flushIds([claim.id]);
            this.store.complete(claim, 'refreshed', this.now());
            result.updated++;
          });
          if (control.problem && !failed) this.store.recovered();
        } catch (error) {
          if (applying) throw error;
          if (!allowed()) {
            result.discarded++;
            continue;
          }
          const missing = [404, 410].includes(error.status);
          const invalid =
            error.code === 'curate_metadata_invalid' ||
            error.name === 'ResponseTooLargeError' ||
            error instanceof SyntaxError;
          if (missing || invalid) {
            this.curate.repo.transaction(() => {
              if (!this.store.current(claim)) {
                result.discarded++;
                return;
              }
              if (missing) {
                this.curate.store
                  .prepare('UPDATE assets SET missing_since=? WHERE asset_id=?')
                  .run(new Date(this.now()).toISOString(), claim.id);
                this.curate.store.flushIds([claim.id]);
                result.unavailable++;
              }
              this.store.complete(claim, missing ? 'unavailable' : 'invalid-response', this.now());
            });
            if (control.problem && !failed) this.store.recovered();
          } else {
            const firstFailure = !failed;
            failed = true;
            if (firstFailure)
              this.store.fail(this.now(), [401, 403].includes(error.status) ? 'permission' : 'connection');
            this.store.defer(claim, this.now(), 'retry');
          }
        }
        await setImmediate();
      }
    };
    try {
      const guarded = () =>
        worker().catch((error) => {
          failed = true;
          throw error;
        });
      // Drain both requests even if local storage fails: releasing the lane
      // early could admit two more calls while the other request still runs.
      const outcomes = await Promise.allSettled(Array.from({ length: METADATA_LIMITS.concurrency }, guarded));
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      if (rejected) {
        this.localProblem = 'storage-error';
        throw rejected.reason;
      }
    } finally {
      this.controller = null;
      this.activeKey = null;
    }
    return result;
  }
  async close() {
    clearImmediate(this.scheduled);
    this.scheduled = null;
    this.controller?.abort();
    await this.work?.catch(() => {});
  }
}
