import { CANDIDATE_METHOD } from './candidate.mjs';

export const RETRY_LIMITS = Object.freeze({ records: 50_000, bytes: 16 * 1024 * 1024, recordBytes: 256 * 1024 });
export const RETRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_rank_retries (
 scope_id TEXT PRIMARY KEY, connection_key TEXT NOT NULL, method TEXT NOT NULL,
 json TEXT NOT NULL, summary TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144)
);
`;

// Park incomplete passes outside the 32 active slots. Only compact summaries
// stay in memory; successful rows and sanitized per-reference backoff stay cold.
// Exact input scopes and connection keys match the completed-evidence store.
export class CurateRetryStore {
  constructor(db, connection, limits = RETRY_LIMITS) {
    this.db = db; this.connection = connection; this.limits = limits;
    db.prepare('DELETE FROM curate_rank_retries WHERE connection_key<>? OR method<>?').run(connection, CANDIDATE_METHOD);
    this.records = new Map(db.prepare('SELECT scope_id,bytes,summary FROM curate_rank_retries').all()
      .map(r => [r.scope_id, { bytes: r.bytes, ...JSON.parse(r.summary) }]));
    this.bytes = [...this.records.values()].reduce((sum, r) => sum + r.bytes, 0);
  }
  read(id) {
    const r = this.db.prepare('SELECT json FROM curate_rank_retries WHERE scope_id=? AND connection_key=? AND method=?')
      .get(id, this.connection, CANDIDATE_METHOD);
    return r ? JSON.parse(r.json) : null;
  }
  save(entry, summary) {
    const json = JSON.stringify({ rows: entry.rows, coverage: entry.coverage, errors: entry.errors,
      retryAt: entry.retryAt, failures: entry.failures, failureCode: entry.failureCode, admittedAt: entry.admittedAt });
    const compact = JSON.stringify(summary), bytes = Buffer.byteLength(json) + Buffer.byteLength(compact);
    if (bytes > this.limits.recordBytes || (!this.records.has(entry.id) && this.records.size >= this.limits.records) ||
        this.bytes - (this.records.get(entry.id)?.bytes ?? 0) + bytes > this.limits.bytes) return false;
    this.db.prepare(`INSERT INTO curate_rank_retries VALUES(?,?,?,?,?,?) ON CONFLICT(scope_id) DO UPDATE SET
      connection_key=excluded.connection_key,method=excluded.method,json=excluded.json,summary=excluded.summary,bytes=excluded.bytes`)
      .run(entry.id, this.connection, CANDIDATE_METHOD, json, compact, bytes);
    this.bytes += bytes - (this.records.get(entry.id)?.bytes ?? 0);
    this.records.set(entry.id, { ...summary, bytes });
    return true;
  }
  delete(id) {
    if (!this.records.has(id)) return;
    this.db.prepare('DELETE FROM curate_rank_retries WHERE scope_id=?').run(id);
    this.bytes -= this.records.get(id).bytes; this.records.delete(id);
  }
  prune(valid) {
    let removed = 0;
    for (const id of this.records.keys()) if (!valid.has(id)) {
      this.delete(id); if (++removed === 128) break;
    }
    return removed;
  }
  reset(connection) {
    this.db.prepare('DELETE FROM curate_rank_retries').run();
    this.records.clear(); this.bytes = 0; this.connection = connection;
  }
}
