import { CANDIDATE_METHOD } from './candidate.mjs';

export const RANK_STORE_LIMITS = Object.freeze({
  records: 50_000,
  recordBytes: 256 * 1024,
  bytes: 64 * 1024 * 1024,
});
export const RANK_MEMBER_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_rank_members (asset_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_curate_rank_member_scope ON curate_rank_members(scope_id);
CREATE TRIGGER IF NOT EXISTS curate_rank_member_cleanup AFTER DELETE ON curate_rank_evidence BEGIN
 DELETE FROM curate_rank_members WHERE scope_id=OLD.scope_id;
END;
`;
export const RANK_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_rank_evidence (
 scope_id TEXT PRIMARY KEY, connection_key TEXT NOT NULL, method TEXT NOT NULL,
 json TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 262144), checked_at INTEGER NOT NULL
);
${RANK_MEMBER_SCHEMA}
`;

// Finished outcomes survive restarts: a complete matrix or one safe problem
// code for an incomplete check. No partial pass or future retry work is stored.
export class CurateRankStore {
  constructor(db, connection, limits = RANK_STORE_LIMITS) {
    this.limits = limits;
    this.db = db;
    this.connection = connection;
    db.prepare('DELETE FROM curate_rank_evidence WHERE connection_key<>? OR method<>?').run(
      connection,
      CANDIDATE_METHOD,
    );
    const records = db.prepare("SELECT scope_id,bytes,json_extract(json,'$.problemCode') problem,json_type(json,'$.settled') settled FROM curate_rank_evidence").all();
    this.records = new Map(records.map(r => [r.scope_id, r.bytes]));
    this.problems = new Map(records.filter(r => r.problem).map(r => [r.scope_id, r.problem]));
    this.settled = new Set(records.filter(r => r.settled).map(r => r.scope_id));
    this.bytes = [...this.records.values()].reduce((n, bytes) => n + bytes, 0);
  }
  has(id) {
    return this.records.has(id);
  }
  problem(id) { return this.problems.get(id); }
  read(id) {
    const row = this.db
      .prepare('SELECT json FROM curate_rank_evidence WHERE scope_id=? AND connection_key=? AND method=?')
      .get(id, this.connection, CANDIDATE_METHOD);
    return row ? JSON.parse(row.json) : null;
  }
  save(entry, now) {
    const json = JSON.stringify({ ...(entry.problemCode ? { problemCode: entry.problemCode }
      : { rows: entry.rows, coverage: entry.coverage }), ...(entry.settled ? { settled: entry.settled } : {}) }),
      bytes = Buffer.byteLength(json);
    if (
      bytes > this.limits.recordBytes ||
      (!this.has(entry.id) && this.records.size >= this.limits.records) ||
      this.bytes - (this.records.get(entry.id) ?? 0) + bytes > this.limits.bytes
    )
      return false;
    this.db.exec('SAVEPOINT curate_rank_save');
    try {
      this.db.prepare(`INSERT INTO curate_rank_evidence VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope_id) DO UPDATE SET connection_key=excluded.connection_key,method=excluded.method,
        json=excluded.json,bytes=excluded.bytes,checked_at=excluded.checked_at`)
        .run(entry.id, this.connection, CANDIDATE_METHOD, json, bytes, now);
      this.db.prepare('DELETE FROM curate_rank_members WHERE scope_id=?').run(entry.id);
      if (entry.settled) {
        const member = this.db.prepare('INSERT OR REPLACE INTO curate_rank_members VALUES(?,?)');
        for (const [id] of entry.settled.members) member.run(id, entry.id);
      }
      this.db.exec('RELEASE curate_rank_save');
    } catch (error) {
      this.db.exec('ROLLBACK TO curate_rank_save; RELEASE curate_rank_save');
      throw error;
    }
    if (entry.settled) this.settled.add(entry.id);
    else this.settled.delete(entry.id);
    this.bytes += bytes - (this.records.get(entry.id) ?? 0);
    this.records.set(entry.id, bytes);
    if (entry.problemCode) this.problems.set(entry.id, entry.problemCode);
    else this.problems.delete(entry.id);
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
        this.problems.delete(id); this.settled.delete(id);
        this.bytes -= bytes;
        if (++removed === 128) break;
      }
    return removed;
  }
  reset(connection) {
    this.db.prepare('DELETE FROM curate_rank_evidence').run();
    this.records.clear();
    this.problems.clear(); this.settled.clear();
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
    const result = row ? JSON.parse(row.json) : null;
    return result?.problemCode ? null : result;
  };
}
