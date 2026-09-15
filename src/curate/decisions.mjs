import { randomUUID } from 'node:crypto';
import { CurateError, canonicalJson, fingerprint } from './contracts.mjs';
import { ACTION_RULES, HUMAN_TAGS } from '../enrich/reviewActions.mjs';
import { validateAssetBatch } from '../enrich/assetBatch.mjs';
import { LEASE_MS } from './repository.mjs';

const DAY = 86400000;
export const RECEIPT_MS = 30 * DAY;
export const TOMBSTONE_MS = 30 * DAY;
export const DECISION_SCHEMA = `
CREATE TABLE IF NOT EXISTS decision_intents (
 asset_id TEXT NOT NULL, tag TEXT NOT NULL, present INTEGER NOT NULL,
 revision TEXT NOT NULL, synced_revision TEXT,
 PRIMARY KEY(asset_id,tag)
);
CREATE TABLE IF NOT EXISTS decision_operations (
 id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, receipt_json TEXT,
 before_json TEXT, created_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_decision_settled ON decision_operations(settled_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_undo_id ON decision_operations(json_extract(receipt_json,'$.undo.operationId'));
CREATE TABLE IF NOT EXISTS decision_operation_members (
 operation_id TEXT NOT NULL, asset_id TEXT NOT NULL, human_id INTEGER NOT NULL, scope_json TEXT NOT NULL,
 PRIMARY KEY(operation_id,asset_id)
);
CREATE INDEX IF NOT EXISTS idx_decision_member_asset ON decision_operation_members(asset_id);
CREATE TABLE IF NOT EXISTS decision_sync_links (job_id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_decision_sync_operation ON decision_sync_links(operation_id);
CREATE TRIGGER IF NOT EXISTS decision_sync_cleanup AFTER DELETE ON pending_sync_jobs BEGIN
 DELETE FROM decision_sync_links WHERE job_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS decision_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
`;

// Durable human intent is per owned tag; a queue entry is a wake-up for those
// assets, not authority to replay its historical tag payload. The existing
// bounded queue, coordinator and recovery UI are shared by every writer.
export class DecisionRepository {
  constructor(repo) { this.repo = repo; this.db = repo.db; this.pruneCursor = ''; }
  intent(assetId, tag) {
    return this.db.prepare('SELECT * FROM decision_intents WHERE asset_id=? AND tag=?').get(assetId, tag);
  }
  recordIntent(assetIds, add, remove, revision = randomUUID(), { synced = false } = {}) {
    const write = this.db.prepare(`INSERT INTO decision_intents VALUES(?,?,?,?,?)
      ON CONFLICT(asset_id,tag) DO UPDATE SET present=excluded.present,revision=excluded.revision,synced_revision=excluded.synced_revision`);
    for (const id of assetIds) for (const tag of [...add, ...remove]) {
      if (!HUMAN_TAGS.includes(tag)) throw new CurateError('Invalid decision tag.', 'invalid_decision_request', 400);
      write.run(id, tag, Number(add.includes(tag)), revision, synced ? revision : null);
    }
    return revision;
  }
  bootstrap(jobs) {
    if (this.db.prepare("SELECT 1 FROM decision_meta WHERE key='legacy-intents'").get()) return;
    this.repo.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO decision_intents VALUES(?,?,?,?,NULL)');
      const present = this.db.prepare('SELECT 1 FROM asset_tags WHERE asset_id=? AND tag=?');
      for (const job of jobs()) {
        if (job.invalidReason) continue; // existing worker/recovery quarantines malformed envelopes
        for (const id of job.assetIds) for (const tag of [...job.add, ...job.remove]) {
          // The local human projection already includes all later decisions.
          // Never resurrect an older queued approval over a newer local Hide.
          insert.run(id, tag, Number(Boolean(present.get(id, tag))), `legacy:${job.id}`);
        }
      }
      this.db.prepare("INSERT INTO decision_meta VALUES('legacy-intents',1)").run();
    });
  }
  pendingFor(assetId) {
    return this.db.prepare(`SELECT * FROM decision_intents WHERE asset_id=? AND synced_revision IS NOT revision ORDER BY tag`).all(assetId);
  }
  acknowledge(rows) {
    this.repo.transaction(() => {
      const ack = this.db.prepare('UPDATE decision_intents SET synced_revision=? WHERE asset_id=? AND tag=? AND revision=?');
      for (const row of rows) ack.run(row.revision, row.asset_id, row.tag, row.revision);
    });
  }
  humanId(id) {
    return this.db.prepare('SELECT COALESCE(MAX(id),0) id FROM manual_overrides WHERE asset_id=?').get(id).id;
  }
  assertAvailable(ids) {
    for (const id of ids) {
      const row = this.db.prepare('SELECT missing_since FROM assets WHERE asset_id=?').get(id);
      const observation = this.db.prepare('SELECT json FROM curate_observations WHERE asset_id=?').get(id);
      const o = observation ? JSON.parse(observation.json) : {};
      if (row?.missing_since || o.isTrashed === true || o.isOffline === true)
        throw new CurateError('A selected photo is unavailable.', 'curate_unavailable');
    }
  }
  issue(comparison, mode = 'manual', now = Date.now()) {
    // Production advice applicability belongs to PIC-116/370. Until that
    // runtime is connected, fail closed instead of blessing an old rank.
    if (mode !== 'manual') throw new CurateError('Applicable keeper advice is not available.', 'curate_advice_unavailable');
    const snapshot = { comparisonId: comparison.id, ids: [...comparison.ids], material: comparison.material };
    validateAssetBatch(snapshot.ids);
    const scope = { kind: 'decision', mode, snapshot };
    return this.repo.transaction(() => {
      this.repo.curate.assertComparison(comparison.id, now);
      const old = this.db.prepare("SELECT id FROM curate_leases WHERE kind='operation' AND scope_hash=? AND expires_at>? LIMIT 1")
        .get(fingerprint(scope), now);
      const lease = old ? this.repo.curate.getLease(old.id, 'operation', now) : this.repo.curate.lease('operation', scope, now);
      return { operationId: lease.id, expiresAt: lease.expiresAt, ...scope };
    });
  }
  payload(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.operationId !== 'string' || input.operationId.length > 128)
      throw new CurateError('Invalid operation.', 'invalid_decision_request', 400);
    const { operationId, ...payload } = input;
    const allowed = payload.kind === 'undo' ? ['kind','targetOperationId'] : ['kind','mode','snapshot','outcomes'];
    if (Object.keys(payload).some(k => !allowed.includes(k)))
      throw new CurateError('Unexpected operation fields.', 'invalid_decision_request', 400);
    let scope;
    if (payload.kind === 'undo' && typeof payload.targetOperationId === 'string') {
      scope = { kind: 'undo', targetOperationId: payload.targetOperationId };
    } else if (payload.kind === 'decision' && ['manual','advice'].includes(payload.mode)) {
      const ids = payload.snapshot?.ids, outcomes = payload.outcomes;
      const clean = validateAssetBatch(ids);
      if (clean.length !== ids.length || !outcomes || typeof outcomes !== 'object' || Array.isArray(outcomes)
        || fingerprint(Object.keys(outcomes).sort()) !== fingerprint(clean)
        || Object.values(outcomes).some(action => !Object.hasOwn(ACTION_RULES, action)))
        throw new CurateError('Provide exactly one valid outcome for every inspected photo.', 'invalid_decision_request', 400);
      scope = { kind: payload.kind, mode: payload.mode, snapshot: payload.snapshot };
    } else throw new CurateError('Invalid operation mode.', 'invalid_decision_request', 400);
    return { operationId, payload, hash: fingerprint(payload), scope };
  }
  replay(input) {
    const parsed = this.payload(input);
    const old = this.db.prepare('SELECT * FROM decision_operations WHERE id=?').get(parsed.operationId);
    if (!old) return null;
    if (old.payload_hash !== parsed.hash) throw new CurateError('This operation ID was already used for different work.');
    if (!old.receipt_json) throw new CurateError('This operation receipt expired.', 'curate_expired');
    return JSON.parse(old.receipt_json);
  }
  apply(input, assertScope, now = Date.now()) {
    const parsed = this.payload(input);
    return this.repo.transaction(() => {
      const replay = this.replay(input);
      if (replay) return replay;
      // Fetch by the issued ID inside the transaction. Neither a free-form
      // client scope hash nor an unrelated live comparison grants authority.
      const lease = parsed.payload.kind === 'undo' ? this.undoLease(parsed.operationId, now) :
        this.repo.curate.getLease(parsed.operationId, 'operation', now);
      const { id, expiresAt, ...scope } = lease;
      if (fingerprint(scope) !== fingerprint(parsed.scope)) throw new CurateError('Operation scope does not match its issued ID.');
      let before;
      if (parsed.payload.kind === 'undo') {
        before = this.undoChanges(parsed.payload.targetOperationId);
      } else {
        if (parsed.payload.mode !== 'manual') throw new CurateError('Applicable keeper advice is not available.', 'curate_advice_unavailable');
        const snapshot = parsed.payload.snapshot;
        if (this.repo.curate.material(snapshot.ids) !== snapshot.material) throw new CurateError('Comparison inputs changed. Refresh Curate.');
        assertScope(snapshot.ids);
        before = snapshot.ids.map(assetId => {
          const rule = ACTION_RULES[parsed.payload.outcomes[assetId]];
          return this.before(assetId, rule.add, rule.remove, parsed.payload.outcomes[assetId]);
        });
      }
      return this.commit(id, parsed.hash, before, now, parsed.payload.kind === 'undo');
    });
  }
  undoLease(operationId, now) {
    const row = this.db.prepare("SELECT receipt_json FROM decision_operations WHERE json_extract(receipt_json,'$.undo.operationId')=?").get(operationId);
    const undo = row ? JSON.parse(row.receipt_json).undo : null;
    if (!undo || undo.expiresAt <= now) throw new CurateError('This Undo expired.', 'curate_expired');
    return { id:operationId, expiresAt:undo.expiresAt, kind:'undo', targetOperationId:undo.targetOperationId };
  }
  // Compatibility entry point for the existing page and reopen-for-enrichment
  // flow. These explicit commands capture state at acceptance, not a pinned
  // browser comparison. PIC-369 replaces this with issued comparison scopes.
  acceptCurrent(outcomes, now = Date.now()) {
    return this.repo.transaction(() => {
      const before = Object.entries(outcomes).map(([assetId,action]) => {
        const rule = ACTION_RULES[action];
        if (!rule) throw new CurateError('Unsupported action.', 'invalid_decision_request', 400);
        return this.before(assetId,rule.add,rule.remove,action);
      });
      return this.commit(randomUUID(),fingerprint({kind:'legacy',outcomes}),before,now);
    });
  }
  commit(id, hash, before, now, isUndo = false) {
    this.assertAvailable(before.map(r => r.assetId));
    // Group identical patches, retaining one local transaction for the full
    // keeper/remainder set. Queue capacity errors roll back every member.
    const groups = new Map();
    for (const row of before) {
      const key = canonicalJson([row.action,row.add,row.remove]);
      if (!groups.has(key)) groups.set(key, { action: row.action, addTags: row.add, removeTags: row.remove, assetIds: [] });
      groups.get(key).assetIds.push(row.assetId);
    }
    for (const group of groups.values()) {
      const jobId = this.repo.recordDecision({ ...group, revision: id });
      this.db.prepare('INSERT INTO decision_sync_links VALUES(?,?)').run(jobId, id);
    }
    // Successful acceptance consumes the comparison operation scope.
    this.repo.curate.releaseLease(id);
    let undo = null;
    if (!isUndo) {
      undo = { operationId: randomUUID(), kind: 'undo', targetOperationId: id, expiresAt: now + LEASE_MS };
    }
    const receipt = { operationId: id, assetCount: before.length, savedLocally: true, sync: 'pending', undo };
    this.db.prepare('INSERT INTO decision_operations VALUES(?,?,?,?,?,NULL)')
      .run(id, hash, JSON.stringify(receipt), JSON.stringify(before), now);
    for (const row of before) this.db.prepare('INSERT INTO decision_operation_members VALUES(?,?,?,?)')
      .run(id, row.assetId, this.humanId(row.assetId), JSON.stringify([...row.add,...row.remove]));
    return receipt;
  }
  before(assetId, add, remove, action) {
    const tags = new Set(this.repo.loadAssetTagsFor([assetId])[assetId] ?? []);
    return { assetId, action, add, remove, previous: Object.fromEntries([...add,...remove].map(tag => [tag,tags.has(tag)])) };
  }
  undoChanges(target) {
    const row = this.db.prepare('SELECT before_json FROM decision_operations WHERE id=?').get(target);
    if (!row?.before_json) throw new CurateError('This Undo expired.', 'curate_expired');
    const members = this.db.prepare('SELECT * FROM decision_operation_members WHERE operation_id=?').all(target);
    if (members.some(m => this.humanId(m.asset_id) !== m.human_id)) throw new CurateError('A newer human decision prevents this Undo.');
    return JSON.parse(row.before_json).map(previous => {
      const add = Object.keys(previous.previous).filter(t => previous.previous[t]);
      const remove = Object.keys(previous.previous).filter(t => !previous.previous[t]);
      return this.before(previous.assetId, add, remove, 'restore');
    });
  }
  status(id) {
    const row = typeof id === 'string' && this.db.prepare('SELECT receipt_json FROM decision_operations WHERE id=?').get(id);
    if (!row?.receipt_json) throw new CurateError('Operation receipt unavailable.', 'curate_expired');
    const counts = { pending: 0, synced: 0, superseded: 0 };
    const queued = new Set(this.db.prepare(`SELECT DISTINCT a.value asset_id FROM decision_sync_links l
      JOIN pending_sync_jobs j ON j.id=l.job_id, json_each(j.asset_ids_json) a WHERE l.operation_id=?`).all(id).map(r=>r.asset_id));
    const members = this.db.prepare('SELECT * FROM decision_operation_members WHERE operation_id=?').all(id);
    for (const m of members) {
      const intents = JSON.parse(m.scope_json).map(t => this.intent(m.asset_id,t));
      const own = intents.filter(i => i?.revision === id);
      if (queued.has(m.asset_id) || own.some(i => i.synced_revision !== i.revision)) counts.pending++;
      else if (own.length !== intents.length) counts.superseded++;
      else counts.synced++;
    }
    const failed = this.db.prepare(`SELECT j.last_error FROM pending_sync_jobs j JOIN decision_sync_links l ON l.job_id=j.id
      WHERE l.operation_id=? AND j.dead_at IS NOT NULL LIMIT 1`).get(id);
    return { operationId: id, savedLocally: true, sync: counts.pending ? (failed ? 'failed' : 'pending') :
      (counts.superseded ? 'superseded' : 'synced'), ...counts, lastError: counts.pending ? failed?.last_error ?? null : null };
  }
  retry(id) {
    this.status(id); // reject missing/tombstoned operation; do not rerun any AI
    return this.repo.transaction(() => {
      const members = this.db.prepare('SELECT asset_id FROM decision_operation_members WHERE operation_id=?').all(id);
      let count = 0;
      // A Frame action may already have synchronized human tags while this
      // operation's separately owned AI-tag portion is still parked.
      for (const link of this.db.prepare('SELECT job_id FROM decision_sync_links WHERE operation_id=?').all(id))
        count += this.repo.retryDeadSyncJobs(link.job_id);
      for (const m of members) {
        const rows = this.pendingFor(m.asset_id);
        if (!rows.length) continue;
        // Only queue pointers: no new human revision or local tag mutation.
        const existing = this.db.prepare(`SELECT j.id FROM pending_sync_jobs j JOIN decision_sync_links l ON l.job_id=j.id
          WHERE l.operation_id=? AND EXISTS(SELECT 1 FROM json_each(j.asset_ids_json) WHERE value=?) LIMIT 1`).get(id,m.asset_id);
        if (existing) this.repo.retryDeadSyncJobs(existing.id);
        else {
          const job = this.repo.enqueueDecisionSync({ assetIds:[m.asset_id], action:'restore',
            addTags:rows.filter(r=>r.present).map(r=>r.tag), removeTags:rows.filter(r=>!r.present).map(r=>r.tag) });
          this.db.prepare('INSERT INTO decision_sync_links VALUES(?,?)').run(job,id);
        }
        count++;
      }
      return { operationId:id, retried:count };
    });
  }
  prune(now = Date.now()) {
    // Settlement is indexed by operation/member and bounded per maintenance
    // pass. Outstanding intent (including parked/dismissed work) pins receipts.
    this.repo.transaction(() => {
      const candidates = this.db.prepare(`SELECT id FROM decision_operations
        WHERE settled_at IS NULL AND id>? ORDER BY id LIMIT 100`).all(this.pruneCursor);
      for (const {id} of candidates) {
        this.db.prepare(`UPDATE decision_operations SET settled_at=? WHERE id=? AND NOT EXISTS (
          SELECT 1 FROM decision_operation_members m, json_each(m.scope_json) t
          JOIN decision_intents i ON i.asset_id=m.asset_id AND i.tag=t.value
          WHERE m.operation_id=? AND i.revision=? AND i.synced_revision IS NOT i.revision
        ) AND NOT EXISTS(SELECT 1 FROM decision_sync_links WHERE operation_id=?)`).run(now,id,id,id,id);
      }
      this.pruneCursor = candidates.length === 100 ? candidates.at(-1).id : '';
      const expired = this.db.prepare(`SELECT id FROM decision_operations WHERE receipt_json IS NOT NULL AND settled_at<=? LIMIT 100`).all(now-RECEIPT_MS);
      for (const {id} of expired) {
        this.db.prepare('UPDATE decision_operations SET receipt_json=NULL,before_json=NULL WHERE id=?').run(id);
        this.db.prepare('DELETE FROM decision_operation_members WHERE operation_id=?').run(id);
      }
      this.db.prepare('DELETE FROM decision_operations WHERE id IN (SELECT id FROM decision_operations WHERE receipt_json IS NULL AND settled_at<=? LIMIT 100)').run(now-RECEIPT_MS-TOMBSTONE_MS);
    });
  }
}
