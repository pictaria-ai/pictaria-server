import { randomUUID } from 'node:crypto';

// Compact accounting only. No prompts, credentials, photo data or raw replies.
// The scheduler owns work selection; this store cannot start or retry work.
export const AI_ATTEMPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_ai_attempts (
 role TEXT NOT NULL CHECK(role IN ('stack','keeper')),
 input_key TEXT NOT NULL CHECK(length(input_key)=64),
 attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 2),
 state TEXT NOT NULL CHECK(state IN ('running','failed','succeeded','stale','interrupted')),
 token TEXT,
 PRIMARY KEY(role,input_key),
 CHECK((state='running' AND token IS NOT NULL) OR (state!='running' AND token IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_curate_ai_single_request
 ON curate_ai_attempts(state) WHERE state='running';
`;

function validate(role, inputKey) {
  if (!['stack', 'keeper'].includes(role) || typeof inputKey !== 'string' || !/^[a-f0-9]{64}$/.test(inputKey))
    throw new TypeError('Invalid Curate AI attempt identity.');
}

export class CurateAiAttempts {
  constructor(repo) { this.repo = repo; }

  status(role, inputKey) {
    validate(role, inputKey);
    const row = this.repo.db.prepare(
      'SELECT attempts,state FROM curate_ai_attempts WHERE role=? AND input_key=?',
    ).get(role, inputKey);
    return row ? { ...row } : { attempts: 0, state: 'new' };
  }

  eligibility(role, inputKey) {
    const prior = this.status(role, inputKey);
    if (prior.state === 'succeeded' || prior.state === 'stale') return 'settled';
    if (prior.state === 'running') return 'busy';
    if (prior.attempts >= 2) return 'exhausted';
    if (this.repo.db.prepare("SELECT 1 FROM curate_ai_attempts WHERE state='running'").get()) return 'busy';
    return 'eligible';
  }

  // Call immediately before exactly one provider invocation. Charging before
  // dispatch deliberately treats a crash in that tiny window conservatively.
  start(role, inputKey) {
    return this.repo.transaction(() => {
      const state = this.eligibility(role, inputKey);
      if (state !== 'eligible') return { state };
      const token = randomUUID();
      this.repo.db.prepare(`INSERT INTO curate_ai_attempts VALUES(?,?,1,'running',?)
        ON CONFLICT(role,input_key) DO UPDATE SET
        attempts=attempts+1,state='running',token=excluded.token`).run(role, inputKey, token);
      return { state: 'started', role, inputKey, token, attempts: this.status(role, inputKey).attempts };
    });
  }

  finish(ticket, state) {
    validate(ticket?.role, ticket?.inputKey);
    if (!['failed', 'succeeded', 'stale'].includes(state) || typeof ticket.token !== 'string')
      throw new TypeError('Invalid Curate AI attempt completion.');
    return this.repo.db.prepare(`UPDATE curate_ai_attempts SET state=?,token=NULL
      WHERE role=? AND input_key=? AND state='running' AND token=?`)
      .run(state, ticket.role, ticket.inputKey, ticket.token).changes === 1;
  }

  // Startup recovery only, after exclusive server ownership is established.
  // Merely opening a repository or constructing another store must NOT release
  // an in-flight request. Recovery never refunds its attempt or accepts a late
  // completion token. This is not a timeout-based lease or a retry scheduler.
  recoverInterrupted() {
    return this.repo.db.prepare("UPDATE curate_ai_attempts SET state='interrupted',token=NULL WHERE state='running'")
      .run().changes;
  }
}
