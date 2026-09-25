import { createHash } from 'node:crypto';
import { enrichmentProviderConfiguration, ProviderRequestError } from '../enrich/providers.mjs';

export const AI_WINDOW_MS = 30 * 60_000;
export const AI_PHOTO_LIMIT = 3;
export const AI_RECOVERY_DELAY_MS = 30_000;
const digest = value => createHash('sha256').update(value).digest('hex');
const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);

// Resolve from the actual pinned adapter, never today's Settings. Different
// models on the same endpoint/credential share failure protection. Persist only
// this opaque digest, never the endpoint, credentials or request configuration.
// This is a pause identity, not proof of independent hardware for scheduling.
export function aiBackendKey(provider) {
  const endpoint = enrichmentProviderConfiguration(provider).endpoint;
  if (!endpoint) throw new TypeError('An AI backend requires an explicit endpoint.');
  return digest(JSON.stringify([endpoint, provider.apiKey ?? '']));
}

export const AI_LIMIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_ai_photo_charges (
 role TEXT NOT NULL CHECK(role IN ('stack','keeper')),
 photo_key TEXT NOT NULL CHECK(length(photo_key)=64),
 token TEXT NOT NULL,
 charged_ms INTEGER NOT NULL,
 PRIMARY KEY(role,photo_key,token)
);
CREATE INDEX IF NOT EXISTS idx_curate_ai_photo_expiry ON curate_ai_photo_charges(charged_ms);
CREATE INDEX IF NOT EXISTS idx_curate_ai_photo_window ON curate_ai_photo_charges(role,photo_key,charged_ms);
CREATE TABLE IF NOT EXISTS curate_ai_backends (
 backend_key TEXT PRIMARY KEY CHECK(length(backend_key)=64),
 state TEXT NOT NULL CHECK(state IN ('ready','cooldown','paused')),
 reason TEXT CHECK(reason IN ('auth','configuration','unavailable','interrupted')),
 retry_at INTEGER,
 token TEXT,
 recovering INTEGER NOT NULL DEFAULT 0 CHECK(recovering IN (0,1)),
 updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS curate_ai_attempt_age (
 role TEXT NOT NULL,
 input_key TEXT NOT NULL,
 updated_ms INTEGER NOT NULL,
 PRIMARY KEY(role,input_key),
 FOREIGN KEY(role,input_key) REFERENCES curate_ai_attempts(role,input_key) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS curate_ai_skipped_inputs (
 role TEXT NOT NULL CHECK(role IN ('stack','keeper')),
 input_key TEXT NOT NULL CHECK(length(input_key)=64),
 updated_ms INTEGER NOT NULL,
 PRIMARY KEY(role,input_key)
);
`;

function photoKeys(job) {
  const context = job.contextPhotoIds ?? [];
  if (!['stack', 'keeper'].includes(job.role) || !validKey(job.inputKey) || !validKey(job.backendKey) ||
      !Array.isArray(job.photoIds) || job.photoIds.length < 1 || job.photoIds.length > 30 ||
      job.photoIds.some(id => typeof id !== 'string' || !id || id.length > 256) ||
      new Set(job.photoIds).size !== job.photoIds.length ||
      !Array.isArray(context) || context.length > 8 || context.length >= job.photoIds.length ||
      new Set(context).size !== context.length || context.some(id => !job.photoIds.includes(id)))
    throw new TypeError('Invalid bounded AI request identity.');
  // photoIds covers the entire request envelope. The authoritative role adapter
  // identifies already-kept read-only context; only actionable members consume
  // the churn allowance. References still count toward image/byte limits and
  // the exact-input digest, and must never be supplied as client exemptions.
  return job.photoIds.filter(id => !context.includes(id)).map(digest);
}

// Durable admission accounting, not a timer or repair queue. All three writes
// (exact attempt, actionable photos and provider ownership) commit together.
export class CurateAiLimits {
  constructor(repo, { now = Date.now } = {}) { this.repo = repo; this.now = now; }

  providerStatus(backendKey) {
    if (!validKey(backendKey)) throw new TypeError('Invalid AI backend identity.');
    const row = this.repo.db.prepare('SELECT state,reason,retry_at,token FROM curate_ai_backends WHERE backend_key=?').get(backendKey);
    if (!row) return { state: 'ready', reason: null };
    if (row.token) return { state: 'busy', reason: null };
    if (row.state === 'cooldown') return { state: this.now() < row.retry_at ? 'cooldown' : 'recovery-ready',
      reason: row.reason, retryAt: row.retry_at };
    return { state: row.state, reason: row.reason };
  }

  eligibility(job) {
    const keys = photoKeys(job);
    if (this.repo.db.prepare('SELECT 1 FROM curate_ai_skipped_inputs WHERE role=? AND input_key=?')
      .get(job.role, job.inputKey)) return 'photo-limit';
    const provider = this.providerStatus(job.backendKey);
    if (!['ready', 'recovery-ready'].includes(provider.state)) return `provider-${provider.state}`;
    const count = this.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges WHERE role=? AND photo_key=? AND charged_ms>?');
    const cutoff = this.now() - AI_WINDOW_MS;
    if (keys.some(key => count.get(job.role, key, cutoff).n >= AI_PHOTO_LIMIT)) return 'photo-limit';
    return 'eligible';
  }

  settleLimited(job) {
    photoKeys(job);
    this.repo.db.prepare('INSERT OR IGNORE INTO curate_ai_skipped_inputs VALUES(?,?,?)')
      .run(job.role, job.inputKey, this.now());
  }

  start(job, attempts) {
    if (attempts.repo !== this.repo) throw new TypeError('AI accounting must share one repository.');
    return this.repo.transaction(() => {
      const state = this.eligibility(job);
      if (state !== 'eligible') {
        if (state === 'photo-limit') this.settleLimited(job);
        return { state };
      }
      const provider = this.providerStatus(job.backendKey);
      const ticket = attempts.start(job.role, job.inputKey);
      if (ticket.state !== 'started') return ticket;
      const now = this.now();
      const insert = this.repo.db.prepare('INSERT INTO curate_ai_photo_charges VALUES(?,?,?,?)');
      for (const key of photoKeys(job)) insert.run(job.role, key, ticket.token, now);
      this.repo.db.prepare(`INSERT INTO curate_ai_attempt_age VALUES(?,?,?)
        ON CONFLICT(role,input_key) DO UPDATE SET updated_ms=excluded.updated_ms`).run(job.role, job.inputKey, now);
      this.repo.db.prepare(`INSERT INTO curate_ai_backends VALUES(?,'ready',NULL,NULL,?,0,?)
        ON CONFLICT(backend_key) DO UPDATE SET token=excluded.token,recovering=?,updated_ms=excluded.updated_ms`)
        .run(job.backendKey, ticket.token, now, Number(provider.state === 'recovery-ready'));
      return { ...ticket, backendKey: job.backendKey };
    });
  }

  // Called exactly once after transport, before answer validation. A bad answer
  // proves the provider answered; it is not a service-wide outage. Never refund
  // an already admitted call, including timeouts and interrupted recovery.
  finish(ticket, error = null) {
    return this.repo.transaction(() => {
      const row = this.repo.db.prepare('SELECT recovering FROM curate_ai_backends WHERE backend_key=? AND token=?')
        .get(ticket.backendKey, ticket.token);
      if (!row) return false;
      let state = 'ready', reason = null, retryAt = null;
      if (error instanceof ProviderRequestError) {
        if ([401, 403].includes(error.status)) { state = 'paused'; reason = 'auth'; }
        else if (error.invalidResponse) { /* Answer failure, not an outage. */ }
        else if (error.cancelled) {
          if (row.recovering) { state = 'paused'; reason = 'interrupted'; }
        } else if (error.infrastructure) {
          reason = 'unavailable';
          state = row.recovering ? 'paused' : 'cooldown';
          if (state === 'cooldown') {
            retryAt = this.now() + Math.max(AI_RECOVERY_DELAY_MS, error.retryAfterMs ?? 0);
            if (!Number.isSafeInteger(retryAt)) { state = 'paused'; retryAt = null; }
          }
        }
      } else if (error) {
        // Unknown transport/programming failure: do not walk the queue to find
        // out whether it is global. Correct the adapter/configuration first.
        state = 'paused'; reason = 'configuration';
      }
      this.repo.db.prepare(`UPDATE curate_ai_backends SET state=?,reason=?,retry_at=?,token=NULL,recovering=0,updated_ms=?
        WHERE backend_key=? AND token=?`).run(state, reason, retryAt, this.now(), ticket.backendKey, ticket.token);
      return true;
    });
  }

  // Only the server owner calls this, alongside attempt recovery. Opening a
  // repository does not recover anything. An interrupted ordinary request gets
  // the normal single recovery opportunity; an interrupted recovery stays
  // paused. Repeated startup cannot reset the delay or grant another probe.
  recoverInterrupted(attempts) {
    if (attempts.repo !== this.repo) throw new TypeError('AI recovery must share one repository.');
    return this.repo.transaction(() => {
      const now = this.now();
      this.repo.db.prepare(`UPDATE curate_ai_backends SET
        state=CASE WHEN recovering=1 THEN 'paused' ELSE 'cooldown' END,
        reason='interrupted',retry_at=CASE WHEN recovering=1 THEN NULL ELSE ? END,
        token=NULL,recovering=0,updated_ms=? WHERE token IS NOT NULL`).run(now + AI_RECOVERY_DELAY_MS, now);
      return attempts.recoverInterrupted();
    });
  }

  // Call only after a deliberate successful connection test/correction. Never
  // from a refresh, restart, preference toggle or per-stack retry. This does not
  // refund any photo/input allowance or enqueue previously settled comparisons.
  connectionVerified(backendKey) {
    if (!validKey(backendKey)) throw new TypeError('Invalid AI backend identity.');
    return this.repo.db.prepare(`UPDATE curate_ai_backends SET state='ready',reason=NULL,retry_at=NULL,
      recovering=0,updated_ms=? WHERE backend_key=? AND token IS NULL`)
      .run(this.now(), backendKey).changes === 1;
  }

  // Cleanup is explicit and bounded. The lifecycle owner supplies only inputs
  // no longer current/queued or referenced by comparisons, Undo or advice. A
  // clock tick alone MUST NOT nominate unchanged work for retirement.
  pruneObsolete(retired = []) {
    if (!Array.isArray(retired) || retired.length > 200 || retired.some(item =>
      !['stack', 'keeper'].includes(item.role) || !validKey(item.inputKey)))
      throw new TypeError('Invalid obsolete AI input batch.');
    return this.repo.transaction(() => {
      const cutoff = this.now() - AI_WINDOW_MS;
      // Bounded maintenance passes; old charges may stay longer without
      // affecting the indexed rolling-window count.
      this.repo.db.prepare(`DELETE FROM curate_ai_photo_charges WHERE rowid IN
        (SELECT rowid FROM curate_ai_photo_charges WHERE charged_ms<=? LIMIT 6000)`).run(cutoff);
      let removed = 0;
      for (const { role, inputKey } of retired) {
        removed += this.repo.db.prepare(`DELETE FROM curate_ai_attempts
          WHERE role=? AND input_key=? AND state!='running' AND EXISTS
          (SELECT 1 FROM curate_ai_attempt_age a WHERE a.role=curate_ai_attempts.role
            AND a.input_key=curate_ai_attempts.input_key AND a.updated_ms<=?)`).run(role, inputKey, cutoff).changes;
        this.repo.db.prepare('DELETE FROM curate_ai_skipped_inputs WHERE role=? AND input_key=? AND updated_ms<=?')
          .run(role, inputKey, cutoff);
      }
      this.repo.db.prepare(`DELETE FROM curate_ai_backends WHERE backend_key IN
        (SELECT backend_key FROM curate_ai_backends WHERE state='ready' AND token IS NULL AND updated_ms<=? LIMIT 200)`)
        .run(cutoff);
      return removed;
    });
  }
}
