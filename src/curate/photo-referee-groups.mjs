import { fingerprint } from './contracts.mjs';
import { PHOTO_REFEREE_CONTRACT, collectPhotoRefereeComparisons } from './photo-referee-contract.mjs';
import { CANDIDATE_LIMITS } from './candidate.mjs';
import { REASON } from './reasons.mjs';

const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

// Image/composition evidence remains useful after decisions subtract siblings.
// Recommendations still require unchanged human state on the photos being
// offered and unchanged read-only context. Never reopen a decided photo.
export function photoPartitionMembersCurrent(store, record) {
  const saved = record.photoReferee;
  return Boolean(saved?.members && same(record.ids, saved.members.map(m => m[0])) &&
    saved.members.every(([id, key, availability, separation]) => {
      const p = store.photo(id);
      return p && p.inputKey === key && p.availability === availability && store.separationKey(id) === separation;
    }) && saved.contextMembers && same(saved.snapshot.contextIds, saved.contextMembers.map(m => m[0])) &&
    saved.contextMembers.every(([id, material, availability, separation]) => {
      const p = store.photo(id);
      return p?.state === 'approved' && p.materialKey === material && p.availability === availability && store.separationKey(id) === separation;
    }));
}

export function photoPartitionAdviceCurrent(store, record, ids) {
  store.flushIds([...record.ids, ...record.photoReferee.snapshot.contextIds]);
  return photoPartitionMembersCurrent(store, record) &&
    !store.pendingScopeChanges(record.ids, CANDIDATE_LIMITS.spanMs) && ids.every(id => {
      const p = store.photo(id), member = record.photoReferee.members.find(m => m[0] === id);
      return p?.state === 'undecided' && p.humanKey === member?.[4];
    });
}

// Like Stack Referee checks, a saved whole-input partition can only subdivide
// current groups. Human decisions may subtract photos, but changed source
// evidence, separations or newly joined members invalidate it. Partial/batched
// comparisons have no global partition and never change visible membership.
export function applyPhotoPartitions(store, result, stacks = true) {
  if (!stacks) return result;
  const byMember = new Map(result.groups.flatMap(g => g.ids.map(id => [id, g])));
  const replacements = new Map();
  const rows = store.prepare(`SELECT DISTINCT a.input_key,a.json FROM curate_advice a
    JOIN curate_advice_members m ON m.role=a.role AND m.input_key=a.input_key
    JOIN curate_photos p ON p.asset_id=m.asset_id
    WHERE a.role='keeper' AND a.schema_version=? AND p.state='undecided'`).iterate(PHOTO_REFEREE_CONTRACT);
  for (const row of rows) {
    const record = JSON.parse(row.json), saved = record.photoReferee;
    if (!photoPartitionMembersCurrent(store, record)) continue;
    const advice = collectPhotoRefereeComparisons(saved.plan, saved.answers);
    if (!advice.canApplyAll || !advice.partition) continue;
    const partition = advice.partition.map(part => ({ ...part, ids: part.ids.filter(id => record.ids.includes(id)) }))
      .filter(part => part.ids.length);
    if (partition.length < 2) continue;
    const ids = new Set(record.ids), groups = new Set(record.ids.map(id => byMember.get(id)).filter(Boolean));
    if ([...groups].some(g => g.ids.some(id => !ids.has(id)))) continue;
    for (const group of groups) {
      const selected = new Set(group.ids);
      const parts = partition.map(part => ({ ...part, ids: part.ids.filter(id => selected.has(id)) })).filter(part => part.ids.length);
      replacements.set(group.id, parts.map(part => ({ ...group, ids: part.ids,
        id: same(part.ids, group.ids) ? group.id : fingerprint({ method: result.method, photoPartition: row.input_key, ids: part.ids }),
        capturedMs: store.photo(part.ids[0]).time,
        reasons: [...new Set([...(group.reasons ?? []), REASON.photoSplit])],
        photoPartition: { inputKey: row.input_key, reason: part.reason, checkCoverage: saved.checkCoverage },
      })));
    }
  }
  return { ...result, groupsForRetention: result.groupsForRetention ?? result.groups,
    groups: result.groups.flatMap(g => replacements.get(g.id) ?? [g])
      .sort((a,b) => (a.capturedMs ?? Infinity) - (b.capturedMs ?? Infinity) || a.ids[0].localeCompare(b.ids[0])) };
}
