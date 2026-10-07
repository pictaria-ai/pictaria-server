import { fingerprint, validateAdvice } from './contracts.mjs';
import { STACK_REFEREE_CONTRACT } from './stack-referee-contract.mjs';
import { CANDIDATE_LIMITS } from './candidate.mjs';

const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

function membersCurrent(store, record) {
  const saved = record.stackCheck;
  return Boolean(saved && same(record.ids, saved.members.map(m => m[0])) &&
    saved.members.every(([id, key, availability, separation]) => {
      const p = store.photo(id);
      return p && p.inputKey === key && p.availability === availability && store.separationKey(id) === separation;
    }));
}

// A status read can happen between a decision/import and the next rebuild.
// Validate the original bounded check, including siblings of split children,
// without treating a library-wide generation change as a changed AI input.
export function stackCheckCurrent(store, check) {
  const row = store.prepare("SELECT json FROM curate_advice WHERE role='check' AND input_key=? AND schema_version=?")
    .get(check.inputKey, STACK_REFEREE_CONTRACT);
  if (!row) return false;
  const record = JSON.parse(row.json);
  // Project just these members, as other advice reads do. Human decisions can
  // subtract members without changing their image/evidence signatures.
  store.flushIds(record.ids);
  return membersCurrent(store, record) && !store.pendingScopeChanges(record.ids, CANDIDATE_LIMITS.spanMs);
}

// Extend the existing versioned advice JSON, not a second job/history store.
// Acceptance runs inside the executor's current-input transaction.
export function saveStackCheck(store, snapshot, { result, provenance }) {
  validateAdvice(snapshot.ids, result, 'check');
  const members = snapshot.ids.map(id => {
    const p = store.photo(id);
    return [id, p.inputKey, p.availability, store.separationKey(id)];
  });
  const inputKey = fingerprint(members.map(([id, input]) => [id, input]));
  const record = { ids: snapshot.ids, result, stackCheck: { members, provenance } };
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > 64 * 1024) throw new Error('Stack check record is too large.');
  store.saveAdvice({ role: 'check', ids: snapshot.ids, inputKey, schemaVersion: STACK_REFEREE_CONTRACT, result });
  store.prepare('UPDATE curate_advice SET json=? WHERE role=\'check\' AND input_key=?').run(json, inputKey);
  store.bump();
}

// Runs on the read-only grouping worker's SQLite snapshot. Saved partitions
// only split current deterministic groups, never join them. Decisions can
// subtract members; changed images, constraints or newly joined members
// invalidate the original check. No recursive judgments of split children.
export function applyStackChecks(store, result, stacks = true) {
  if (!stacks) return result;
  const byMember = new Map(result.groups.flatMap(g => g.ids.map(id => [id, g])));
  const replacements = new Map();
  const rows = store.prepare(`SELECT DISTINCT a.input_key,a.json FROM curate_advice a
    JOIN curate_advice_members m ON m.role=a.role AND m.input_key=a.input_key
    JOIN curate_photos p ON p.asset_id=m.asset_id
    WHERE a.role='check' AND a.schema_version=? AND p.state='undecided'`).iterate(STACK_REFEREE_CONTRACT);
  for (const row of rows) {
    const record = JSON.parse(row.json);
    if (!membersCurrent(store, record)) continue;
    const ids = new Set(record.ids);
    const groups = new Set(record.ids.map(id => byMember.get(id)).filter(Boolean));
    if ([...groups].some(g => g.ids.some(id => !ids.has(id)))) continue;
    validateAdvice(record.ids, record.result, 'check');
    for (const group of groups) {
      const selected = new Set(group.ids);
      const parts = record.result.groups.map(part => ({ ids: part.ids.filter(id => selected.has(id)), reason: part.reason }))
        .filter(part => part.ids.length);
      // Each part keeps the deterministic reasons; the model's reason stays
      // with the check (stack-status.js). `split` says whether the answer
      // divided the photos it compared, which later decisions cannot change:
      // a confirmed stack that decisions shrink to one photo was not split.
      const split = record.result.groups.length > 1;
      const checked = parts.map(part => ({ ...group, ids: part.ids,
        id: same(part.ids, group.ids) ? group.id : fingerprint({ method: result.method, check: row.input_key, ids: part.ids }),
        capturedMs: store.photo(part.ids[0]).time,
        stackCheck: { state: 'checked', inputKey: row.input_key, reason: part.reason, split },
      }));
      replacements.set(group.id, checked);
    }
  }
  return { ...result, groupsForRetention: result.groups, groups: result.groups.flatMap(g => replacements.get(g.id) ?? [g])
    .sort((a,b) => (a.capturedMs ?? Infinity) - (b.capturedMs ?? Infinity) || a.ids[0].localeCompare(b.ids[0])) };
}
