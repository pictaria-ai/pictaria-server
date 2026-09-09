import { AsyncLocalStorage } from 'node:async_hooks';

// Only Enrich enters this context. Concurrent referee/voice calls, even on
// the same provider object, cannot be attributed to an enrichment photo.
const invocation = new AsyncLocalStorage();
export const TIMING_LIMITS = Object.freeze({ runs: 100, photos: 10000, attempts: 60000, page: 100 });

export const TIMING_SCHEMA = `
CREATE TABLE IF NOT EXISTS enrich_timing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  configuration_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'running',
  photo_count INTEGER NOT NULL DEFAULT 0,
  skipped_successful INTEGER NOT NULL DEFAULT 0,
  skipped_discarded INTEGER NOT NULL DEFAULT 0,
  skipped_failure_limit INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enrich_photo_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timing_run_id INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  processing_run_id INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms REAL CHECK(duration_ms IS NULL OR duration_ms >= 0),
  outcome TEXT NOT NULL DEFAULT 'running',
  error_kind TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_enrich_photo_timing_run ON enrich_photo_executions(timing_run_id, id);
CREATE TABLE IF NOT EXISTS enrich_provider_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_execution_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms REAL CHECK(duration_ms IS NULL OR duration_ms >= 0),
  outcome TEXT NOT NULL DEFAULT 'running',
  http_status INTEGER,
  UNIQUE(photo_execution_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_enrich_attempt_photo_id ON enrich_provider_attempts(photo_execution_id, id);
CREATE TRIGGER IF NOT EXISTS enrich_timing_delete_run AFTER DELETE ON enrich_timing_runs BEGIN
  DELETE FROM enrich_photo_executions WHERE timing_run_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS enrich_timing_delete_photo AFTER DELETE ON enrich_photo_executions BEGIN
  DELETE FROM enrich_provider_attempts WHERE photo_execution_id = OLD.id;
END;
`;

function pageOptions({ afterId = 0, limit = 50 } = {}) {
  return {
    afterId: Number.isSafeInteger(afterId) && afterId >= 0 ? afterId : 0,
    limit: Number.isSafeInteger(limit) ? Math.max(1, Math.min(TIMING_LIMITS.page, limit)) : 50,
  };
}
function page(rows, limit) {
  const items = rows.slice(0, limit).map((row) => ({ ...row }));
  return { items, nextAfterId: rows.length > limit ? items.at(-1).id : null };
}
function elapsed(start, clock) {
  const value = clock() - start;
  return Number.isFinite(value) ? Math.max(0, value) : null;
}
export function timingErrorKind(error) {
  if (error?.cancelled || error?.name === 'RetryWaitCancelledError') return 'cancelled';
  if (error?.timeout) return 'timeout';
  if (error?.invalidResponse || error?.name === 'OutputValidationError') return 'invalid_response';
  if (error?.status != null) return 'http_error';
  return error?.name === 'ProviderRequestError' ? 'transport_error' : 'other_error';
}

export class EnrichTimingStore {
  constructor(db, { wallNow = () => new Date().toISOString(), monotonicNow = () => performance.now() } = {}) {
    this.db = db;
    this.wallNow = wallNow;
    this.monotonicNow = monotonicNow;
    this.photoWrites = 0;
    this.attemptWrites = 0;
  }

  atomic(work) {
    this.db.exec('SAVEPOINT enrich_timing_write');
    try {
      const result = work();
      this.db.exec('RELEASE enrich_timing_write');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO enrich_timing_write; RELEASE enrich_timing_write');
      throw error;
    }
  }

  startRun(configuration) {
    return this.atomic(() => {
      const id = Number(this.db.prepare(`INSERT INTO enrich_timing_runs
        (configuration_id, provider, model, started_at) VALUES (?, ?, ?, ?)`).run(
        configuration.id, configuration.runKey.provider, configuration.runKey.model ?? null, this.wallNow(),
      ).lastInsertRowid);
      // Preserve active work; the server is single-flight. Every terminal run
      // remains discoverable here even if a crash prevented its job summary.
      this.db.prepare(`DELETE FROM enrich_timing_runs WHERE outcome != 'running' AND id NOT IN
        (SELECT id FROM enrich_timing_runs ORDER BY id DESC LIMIT ?)`).run(TIMING_LIMITS.runs);
      return id;
    });
  }

  finishRun(id, outcome) {
    if (outcome === 'interrupted') return this.interrupt(id);
    return this.atomic(() => {
      this.#interruptPhotos(id);
      this.db.prepare(`UPDATE enrich_timing_runs SET outcome = ?, finished_at = ?
        WHERE id = ? AND outcome = 'running'`).run(outcome, this.wallNow(), id);
    });
  }

  interrupt(id = null) {
    return this.atomic(() => {
      this.#interruptPhotos(id);
      this.db.prepare(`UPDATE enrich_timing_runs SET outcome = 'interrupted'
        WHERE outcome = 'running' AND (? IS NULL OR id = ?)`).run(id, id);
    });
  }

  #interruptPhotos(id) {
    // Unknown completion is not a measured cancellation. Keep completed
    // requests (including response_received) and never fabricate an end time.
    this.db.prepare(`UPDATE enrich_provider_attempts SET outcome = 'interrupted'
      WHERE outcome = 'running' AND photo_execution_id IN
      (SELECT id FROM enrich_photo_executions WHERE (? IS NULL OR timing_run_id = ?))`).run(id, id);
    this.db.prepare(`UPDATE enrich_photo_executions SET outcome = 'interrupted'
      WHERE outcome = 'running' AND (? IS NULL OR timing_run_id = ?)`).run(id, id);
  }

  skip(runId, reason) {
    const column = { already_succeeded: 'skipped_successful', human_discard: 'skipped_discarded', failure_limit: 'skipped_failure_limit' }[reason];
    if (!column) throw new Error('Unknown enrichment skip reason');
    // A library sweep may skip 100k photos. Preserve counters rather than
    // evicting useful measured executions with rows for work never started.
    this.db.prepare(`UPDATE enrich_timing_runs SET ${column} = ${column} + 1 WHERE id = ? AND outcome = 'running'`).run(runId);
  }

  startPhoto(runId, assetId) {
    return this.atomic(() => {
      if (!this.db.prepare("SELECT id FROM enrich_timing_runs WHERE id = ? AND outcome = 'running'").get(runId)) return null;
      const start = this.monotonicNow();
      const id = Number(this.db.prepare(`INSERT INTO enrich_photo_executions
        (timing_run_id, asset_id, started_at) VALUES (?, ?, ?)`).run(runId, assetId, this.wallNow()).lastInsertRowid);
      this.db.prepare('UPDATE enrich_timing_runs SET photo_count = photo_count + 1 WHERE id = ?').run(runId);
      // Prune once per 100 inserts (and the first after opening). At most 99
      // extra terminal rows accrue between passes; avoid a full retention scan
      // per photo when traversing a mostly enriched library.
      if (this.photoWrites++ % 100 === 0) {
        this.db.prepare(`DELETE FROM enrich_photo_executions WHERE outcome != 'running' AND id <=
          (SELECT id FROM enrich_photo_executions ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(TIMING_LIMITS.photos);
      }
      return new PhotoTiming(this, id, runId, start);
    });
  }

  runs(options) {
    const { afterId, limit } = pageOptions(options);
    const rows = this.db.prepare(`SELECT r.*,
      (SELECT id FROM job_runs j WHERE j.timing_run_id = r.id LIMIT 1) AS job_run_id
      FROM enrich_timing_runs r WHERE r.id > ? ORDER BY r.id LIMIT ?`).all(afterId, limit + 1);
    return page(rows, limit);
  }

  photos(runId, options) {
    const run = this.db.prepare('SELECT * FROM enrich_timing_runs WHERE id = ?').get(runId);
    if (!run) return null;
    const { afterId, limit } = pageOptions(options);
    const rows = this.db.prepare('SELECT * FROM enrich_photo_executions WHERE timing_run_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(runId, afterId, limit + 1);
    const retained = this.db.prepare('SELECT COUNT(*) AS n FROM enrich_photo_executions WHERE timing_run_id = ?').get(runId).n;
    return { ...page(rows, limit), run: { ...run }, retained, truncated: retained < run.photo_count };
  }

  attempts(photoId, options) {
    const photo = this.db.prepare('SELECT * FROM enrich_photo_executions WHERE id = ?').get(photoId);
    if (!photo) return null;
    const { afterId, limit } = pageOptions(options);
    const rows = this.db.prepare('SELECT * FROM enrich_provider_attempts WHERE photo_execution_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(photoId, afterId, limit + 1);
    const retained = this.db.prepare('SELECT COUNT(*) AS n FROM enrich_provider_attempts WHERE photo_execution_id = ?').get(photoId).n;
    return { ...page(rows, limit), photo: { ...photo }, retained, truncated: retained < photo.attempt_count };
  }
}

class PhotoTiming {
  constructor(store, id, runId, start) {
    Object.assign(this, { store, id, runId, start });
  }

  finish(outcome, errorKind = null, processingRunId = null) {
    const s = this.store;
    s.db.prepare(`UPDATE enrich_photo_executions SET finished_at = ?, duration_ms = ?, outcome = ?, error_kind = ?, processing_run_id = ?
      WHERE id = ? AND outcome = 'running'`).run(s.wallNow(), elapsed(this.start, s.monotonicNow), outcome, errorKind, processingRunId, this.id);
  }

  async analyze(work) {
    const context = { photo: this, lastRequestId: null };
    return invocation.run(context, async () => {
      try {
        const result = await work();
        this.accept(context.lastRequestId, 'accepted');
        return result;
      } catch (error) {
        // Includes adapter extraction/JSON errors as well as taxonomy/schema
        // validation failures, but never rewrites a transport failure.
        this.accept(context.lastRequestId, 'invalid_response');
        throw error;
      }
    });
  }

  accept(id, outcome) {
    if (id === null) return;
    this.store.db.prepare(`UPDATE enrich_provider_attempts SET outcome = ? WHERE id = ? AND outcome = 'response_received'
      AND EXISTS (SELECT 1 FROM enrich_photo_executions WHERE id = ? AND outcome = 'running')`).run(outcome, id, this.id);
  }

  async request(work, context) {
    const s = this.store;
    const photo = s.db.prepare("SELECT attempt_count FROM enrich_photo_executions WHERE id = ? AND outcome = 'running'").get(this.id);
    // An abandoned request may unwind after shutdown recorded interruption.
    // It must not create new records or overwrite unknown measurements.
    if (!photo) return work(() => {});
    const id = s.atomic(() => {
      const id = Number(s.db.prepare(`INSERT INTO enrich_provider_attempts
        (photo_execution_id, ordinal, started_at) VALUES (?, ?, ?)`).run(this.id, photo.attempt_count + 1, s.wallNow()).lastInsertRowid);
      s.db.prepare('UPDATE enrich_photo_executions SET attempt_count = attempt_count + 1 WHERE id = ?').run(this.id);
      s.db.prepare('UPDATE enrich_timing_runs SET attempt_count = attempt_count + 1 WHERE id = ?').run(this.runId);
      if (s.attemptWrites++ % 100 === 0) {
        s.db.prepare(`DELETE FROM enrich_provider_attempts WHERE outcome != 'running' AND id <=
          (SELECT id FROM enrich_provider_attempts ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(TIMING_LIMITS.attempts);
      }
      s.db.prepare('UPDATE enrich_provider_attempts SET started_at = ? WHERE id = ?').run(s.wallNow(), id);
      return id;
    });
    context.lastRequestId = id;
    const start = s.monotonicNow();
    let outcome = 'response_received';
    let status = null;
    try {
      return await work((value) => { status = value; });
    } catch (error) {
      outcome = timingErrorKind(error);
      throw error;
    } finally {
      s.db.prepare(`UPDATE enrich_provider_attempts SET finished_at = ?, duration_ms = ?, outcome = ?, http_status = ?
        WHERE id = ? AND outcome = 'running'`).run(s.wallNow(), elapsed(start, s.monotonicNow), outcome, status, id);
    }
  }
}

export function measureProviderRequest(work) {
  const context = invocation.getStore();
  return context ? context.photo.request(work, context) : work(() => {});
}
