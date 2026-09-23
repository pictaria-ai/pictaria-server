import { CANDIDATE_METHOD } from './candidate.mjs';

export const RANK_STORE_LIMITS = Object.freeze({
  records: 50_000,
  recordBytes: 256 * 1024,
  bytes: 64 * 1024 * 1024,
});
export const RANK_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_rank_evidence (
 scope_id TEXT PRIMARY KEY, connection_key TEXT NOT NULL, method TEXT NOT NULL,
 json TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144), checked_at INTEGER NOT NULL
);
`;

// Only completed candidate-member matrices survive restarts. No unrelated search
// results or credentials are retained. Scope hashes include material inputs and
// the algorithm version; opening a page is never a retention condition.
export class CurateRankStore {
  constructor(db, connection, limits = RANK_STORE_LIMITS) {
    this.limits = limits;
    this.db = db;
    this.connection = connection;
    db.prepare('DELETE FROM curate_rank_evidence WHERE connection_key<>? OR method<>?').run(
      connection,
      CANDIDATE_METHOD,
    );
    this.records = new Map(
      db
        .prepare('SELECT scope_id,bytes FROM curate_rank_evidence')
        .all()
        .map((r) => [r.scope_id, r.bytes]),
    );
    this.bytes = [...this.records.values()].reduce((n, bytes) => n + bytes, 0);
  }
  has(id) {
    return this.records.has(id);
  }
  read(id) {
    const row = this.db
      .prepare('SELECT json FROM curate_rank_evidence WHERE scope_id=? AND connection_key=? AND method=?')
      .get(id, this.connection, CANDIDATE_METHOD);
    return row ? JSON.parse(row.json) : null;
  }
  save(entry, now) {
    const json = JSON.stringify({ rows: entry.rows, coverage: entry.coverage }),
      bytes = Buffer.byteLength(json);
    if (
      bytes > this.limits.recordBytes ||
      (!this.has(entry.id) && this.records.size >= this.limits.records) ||
      this.bytes - (this.records.get(entry.id) ?? 0) + bytes > this.limits.bytes
    )
      return false;
    this.db
      .prepare(
        `INSERT INTO curate_rank_evidence VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope_id) DO UPDATE SET connection_key=excluded.connection_key,method=excluded.method,
      json=excluded.json,bytes=excluded.bytes,checked_at=excluded.checked_at`,
      )
      .run(entry.id, this.connection, CANDIDATE_METHOD, json, bytes, now);
    this.bytes += bytes - (this.records.get(entry.id) ?? 0);
    this.records.set(entry.id, bytes);
    return true;
  }
  prune(valid) {
    // Reclaim obsolete evidence in small batches; never evict an unchanged
    // pending result to admit new work and cause continual regroup/recheck loops.
    let removed = 0;
    for (const [id, bytes] of this.records)
      if (!valid.has(id)) {
        this.db.prepare('DELETE FROM curate_rank_evidence WHERE scope_id=?').run(id);
        this.records.delete(id);
        this.bytes -= bytes;
        if (++removed === 128) break;
      }
    return removed;
  }
  reset(connection) {
    this.db.prepare('DELETE FROM curate_rank_evidence').run();
    this.records.clear();
    this.bytes = 0;
    this.connection = connection;
  }
}

export function rankReader(db, connection) {
  const read = db.prepare(
    'SELECT json FROM curate_rank_evidence WHERE scope_id=? AND connection_key=? AND method=?',
  );
  return (id) => {
    const row = read.get(id, connection, CANDIDATE_METHOD);
    return row ? JSON.parse(row.json) : null;
  };
}
