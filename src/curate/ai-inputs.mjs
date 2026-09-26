import { fingerprint } from './contracts.mjs';
import { AI_WINDOW_MS } from './ai-limits.mjs';
import { CANDIDATE_LIMITS } from './candidate.mjs';

// Applicability/accounting references only; never prompts, renditions or replies.
export const AI_INPUT_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_ai_inputs (
 role TEXT NOT NULL CHECK(role IN ('stack','keeper')),
 input_key TEXT NOT NULL CHECK(length(input_key)=64),
 json TEXT NOT NULL CHECK(length(CAST(json AS BLOB))<=32768),
 recorded_ms INTEGER NOT NULL,
 PRIMARY KEY(role,input_key)
);
CREATE INDEX IF NOT EXISTS idx_curate_ai_input_age ON curate_ai_inputs(recorded_ms,role,input_key);
`;

const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

export class CurateAiInputs {
  constructor(curate, { now = Date.now } = {}) {
    this.curate = curate; this.store = curate.store; this.now = now; this.cursor = null;
  }

  // Call after refresh. The server derives the full authoritative scope and
  // read-only context; callers may choose a bounded actionable batch, not
  // exempt arbitrary photos from charging or supply applicability signatures.
  capture({ role, groupId, contract, photoIds, includeContext = false }) {
    if (!['stack', 'keeper'].includes(role) || typeof contract !== 'string' || !contract || contract.length > 100)
      throw new TypeError('Invalid Curate AI input contract.');
    const group = this.curate.current?.byId.get(groupId);
    if (!group || group.ids.length < 2 || group.ids.length > CANDIDATE_LIMITS.photos) return null;
    const actionable = photoIds ?? group.ids;
    if (!Array.isArray(actionable) || !actionable.length || actionable.length > 30 ||
        new Set(actionable).size !== actionable.length || actionable.some(id => !group.ids.includes(id)) ||
        (role === 'stack' && !same(actionable, group.ids)))
      throw new TypeError('Invalid Curate AI actionable batch.');
    const contextIds = includeContext ? this.store.context(group.ids).ids.slice(0, Math.min(8, 30 - actionable.length)) : [];
    const snapshot = { role, contract, groupId, ids: [...group.ids], actionable: [...actionable], contextIds };
    // Capture only from a fully rebuilt projection. Later checks below are
    // scope-specific, so unrelated imports need not discard a paid result.
    if (this.curate.current.generation !== this.store.generation() ||
        this.store.prepare('SELECT 1 FROM curate_dirty LIMIT 1').get()) return null;
    const material = this.material(snapshot);
    if (!material) return null;
    snapshot.scopeMaterial = material.scope;
    snapshot.material = fingerprint(material);
    snapshot.inputKey = fingerprint(snapshot);
    return snapshot;
  }

  material(snapshot) {
    const ids = [...snapshot.ids, ...snapshot.contextIds];
    this.store.flushIds(ids);
    const group = this.curate.current?.byMember.get(snapshot.ids[0]);
    if (!this.curate.current) return null;
    // Stacks-off changes the presentation into singles, not the photo inputs
    // of an already submitted request. Keep useful paid work through that
    // toggle while still checking all source/human evidence below.
    if (this.curate.current.stacks !== false &&
        (!group || group.id !== snapshot.groupId || !same(group.ids, snapshot.ids))) return null;
    const photos = ids.map(id => this.store.photo(id));
    if (photos.some((p, i) => !p || p.availability === 'unavailable' ||
      p.state !== (i < snapshot.ids.length ? 'undecided' : 'approved'))) return null;
    if (ids.some(id => this.store.separatedFrom(id, ids))) return null;
    // Candidate composition uses a wider window than the old 15-second engine.
    // Include new/changed nearby sources even before a rebuild has consumed them.
    if (this.store.pendingScopeChanges(ids, CANDIDATE_LIMITS.spanMs)) return null;
    const times = photos.slice(0, snapshot.ids.length).map(p => p.time).filter(t => t !== null);
    let neighbors = [];
    if (times.length) {
      neighbors = this.store.prepare(`SELECT asset_id,material_key FROM curate_photos
        WHERE state='undecided' AND captured_ms BETWEEN ? AND ? ORDER BY captured_ms,asset_id LIMIT 257`)
        .all(Math.min(...times) - CANDIDATE_LIMITS.spanMs, Math.max(...times) + CANDIDATE_LIMITS.spanMs);
      // Do not silently sample a dense neighborhood. Manual review stays usable.
      if (neighbors.length > 256) return null;
    }
    // The basic grouper also recognizes exact/duplicate candidates outside the
    // time window. Source indexes avoid a whole-library scan at checkpoints.
    const exact = new Map();
    const members = photos.slice(0, snapshot.ids.length);
    for (const [column, values] of this.curate.candidateEnabled ? [] :
      [['checksum', members.map(p => p.checksum)], ['duplicate_id', members.map(p => p.duplicateId)]])
      for (const value of new Set(values.filter(Boolean))) {
        const rows = this.store.prepare(`SELECT p.asset_id,p.material_key FROM assets a JOIN curate_photos p ON p.asset_id=a.asset_id
          WHERE a.${column}=? AND p.state='undecided' ORDER BY p.asset_id LIMIT 257`).all(value);
        for (const row of rows) exact.set(row.asset_id, row.material_key);
        if (exact.size > 256) return null;
      }
    const signatures = photos.map(p => [p.id, p.materialKey, p.availability, this.store.separationKey(p.id)]);
    return { scope: fingerprint({ photos: signatures.slice(0, snapshot.ids.length), neighbors,
      exact: [...exact].sort(([a], [b]) => a.localeCompare(b)) }), context: fingerprint(signatures.slice(snapshot.ids.length)) };
  }

  current(snapshot) {
    const material = this.material(snapshot);
    return material !== null && fingerprint(material) === snapshot.material;
  }

  record(snapshot) {
    this.store.prepare('INSERT OR IGNORE INTO curate_ai_inputs VALUES(?,?,?,?)')
      .run(snapshot.role, snapshot.inputKey, JSON.stringify(snapshot), this.now());
  }

  protected(snapshot, liveKeys, comparisons) {
    if (liveKeys.has(snapshot.inputKey)) return true;
    const ids = [...snapshot.ids, ...snapshot.contextIds];
    if (comparisons.some(scope => [...(scope.ids ?? []), ...(scope.contextIds ?? [])].some(id => ids.includes(id)))) return true;
    for (const id of ids) {
      if (this.store.prepare(`SELECT 1 FROM decision_operation_members m JOIN decision_operations o ON o.id=m.operation_id
        WHERE m.asset_id=? AND (o.settled_at IS NULL OR
          (o.before_json IS NOT NULL AND json_extract(o.receipt_json,'$.undo.expiresAt')>?)) LIMIT 1`).get(id, this.now())) return true;
      const advice = this.store.prepare(`SELECT a.* FROM curate_advice a JOIN curate_advice_members m
        ON m.role=a.role AND m.input_key=a.input_key WHERE m.asset_id=?`).all(id);
      for (const row of advice) {
        const members = JSON.parse(row.json).ids;
        if (this.store.advice(row.role, members, row.schema_version)) return true;
      }
    }
    return false;
  }

  // Bounded, cursor-based cleanup: protected old rows cannot starve later ones.
  // Unknown pre-integration records stay intact; no fabricated membership.
  prune(liveKeys = new Set()) {
    if (!this.curate.current || this.curate.current.stacks === false || this.curate.building ||
        this.curate.current.generation !== this.store.generation() ||
        this.store.prepare('SELECT 1 FROM curate_dirty LIMIT 1').get()) return 0;
    const rows = this.store.prepare(`SELECT * FROM curate_ai_inputs WHERE recorded_ms<=?
      AND (recorded_ms,role,input_key)>(?,?,?) ORDER BY recorded_ms,role,input_key LIMIT 20`)
      .all(this.now() - AI_WINDOW_MS, ...(this.cursor ?? [-1, '', '']));
    const comparisons = this.store.prepare("SELECT json FROM curate_leases WHERE kind IN ('comparison','operation') AND expires_at>?")
      .all(this.now()).map(row => JSON.parse(row.json));
    return this.store.repo.transaction(() => {
      const retired = [], start = performance.now();
      let count = 0;
      for (const row of rows) {
        const snapshot = JSON.parse(row.json);
        if (!this.current(snapshot) && !this.protected(snapshot, liveKeys, comparisons))
          retired.push({ role: row.role, inputKey: row.input_key });
        count++;
        this.cursor = [row.recorded_ms, row.role, row.input_key];
        if (performance.now() - start >= 4) break;
      }
      if (count === rows.length && rows.length < 20) this.cursor = null;
      const removed = this.store.aiLimits.pruneObsolete(retired);
      for (const { role, inputKey } of retired) this.store.prepare(`DELETE FROM curate_ai_inputs WHERE role=? AND input_key=?
        AND NOT EXISTS(SELECT 1 FROM curate_ai_attempts WHERE role=? AND input_key=?)
        AND NOT EXISTS(SELECT 1 FROM curate_ai_skipped_inputs WHERE role=? AND input_key=?)`)
        .run(role, inputKey, role, inputKey, role, inputKey);
      return removed;
    });
  }
}
