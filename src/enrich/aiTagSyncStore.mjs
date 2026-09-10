import { sanitizeDiagnostic } from '../diagnostics.mjs';

export const AI_TAG_SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_tag_sync (
  asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','written','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_tag_sync_pending ON ai_tag_sync(status, updated_at, asset_id);
CREATE TABLE IF NOT EXISTS ai_tag_sync_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  retry_after INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
`;

// One row per photo, no copied tag payload. The processing-run id protects
// newer work from completion/failure of a stale HTTP request.
export class AiTagSyncStore {
  constructor(db) { this.db = db; }

  enqueue(assetId, runId) {
    this.db.prepare(`INSERT INTO ai_tag_sync(asset_id,generation,status,updated_at)
      VALUES (?,?,'pending',?) ON CONFLICT(asset_id) DO UPDATE SET
      generation=excluded.generation,status='pending',attempts=0,last_error=NULL,updated_at=excluded.updated_at
    `).run(assetId, runId, Date.now());
  }

  next(limit = 10) {
    return this.db.prepare(`SELECT asset_id AS assetId,generation,attempts FROM ai_tag_sync
      WHERE status='pending' ORDER BY updated_at,asset_id LIMIT ?`).all(Math.max(1, Math.min(10, limit)));
  }

  current(item) {
    return this.db.prepare(`SELECT 1 FROM ai_tag_sync WHERE asset_id=? AND generation=? AND status='pending'`)
      .get(item.assetId, item.generation) !== undefined;
  }

  mark(item, status, error = null) {
    return Number(this.db.prepare(`UPDATE ai_tag_sync SET status=?,last_error=?,updated_at=?
      WHERE asset_id=? AND generation=? AND status='pending'`)
      .run(status, error ? sanitizeDiagnostic(error) : null, Date.now(), item.assetId, item.generation).changes);
  }

  failure(item, error) {
    this.db.prepare(`UPDATE ai_tag_sync SET attempts=attempts+1,last_error=?,updated_at=?,
      status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END
      WHERE asset_id=? AND generation=? AND status='pending'`)
      .run(sanitizeDiagnostic(error), Date.now(), item.assetId, item.generation);
  }

  defer(error, retryAfter) {
    this.db.prepare(`INSERT INTO ai_tag_sync_state(id,retry_after,last_error) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET retry_after=excluded.retry_after,last_error=excluded.last_error`)
      .run(retryAfter, error ? sanitizeDiagnostic(error) : null);
  }

  retry() {
    const result = this.db.prepare(`UPDATE ai_tag_sync SET status='pending',attempts=0,last_error=NULL
      WHERE status='failed'`).run();
    this.defer(null, 0);
    return Number(result.changes);
  }

  status() {
    const counts = { pending: 0, written: 0, skipped: 0, failed: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM ai_tag_sync GROUP BY status').all()) {
      if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.n);
    }
    const state = this.db.prepare('SELECT retry_after,last_error FROM ai_tag_sync_state WHERE id=1').get();
    const failure = this.db.prepare(`SELECT last_error FROM ai_tag_sync WHERE status='failed' ORDER BY updated_at DESC LIMIT 1`).get();
    return { ...counts, retryAfter: state?.retry_after ?? 0, lastError: state?.last_error ?? failure?.last_error ?? null };
  }
}
