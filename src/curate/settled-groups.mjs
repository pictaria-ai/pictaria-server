import { setImmediate } from 'node:timers/promises';
import { candidateGroups, CANDIDATE_METHOD, timeCandidates } from './candidate.mjs';
import { fingerprint } from './contracts.mjs';
import { rankReader } from './rank-store.mjs';

// Completed composition is disposable cached work, not human history. Retain its
// original boundaries while decisions only subtract members. Never reinterpret
// original-cohort outside ranks against a smaller pending set.
export function settledCandidateGroups(store, { stacks, connection }) {
  const rows = store.candidateRows(), pending = new Map(rows.map(p => [p.id, p]));
  const retained = new Map(), owner = new Map(), invalid = new Set();
  if (stacks && connection) {
    const saved = store.prepare(`SELECT DISTINCT e.scope_id,json_extract(e.json,'$.settled') settled
      FROM curate_photos p JOIN curate_rank_members m ON m.asset_id=p.asset_id
      JOIN curate_rank_evidence e ON e.scope_id=m.scope_id
      WHERE p.state='undecided' AND e.connection_key=? AND e.method=?`).iterate(connection, CANDIDATE_METHOD);
    for (const record of saved) {
      if (!record.settled) continue;
      const value = JSON.parse(record.settled);
      for (const [id, input, availability, separation] of value.members) {
        const photo = store.photo(id);
        if (!photo || photo.inputKey !== input || photo.availability !== availability || store.separationKey(id) !== separation)
          invalid.add(record.scope_id);
        if (pending.has(id)) owner.set(id, record.scope_id);
      }
      retained.set(record.scope_id, value);
    }
  }
  // Current time candidates may span several older candidates after decisions.
  // Reuse all of them if every photo is unchanged and already covered. A new or
  // changed photo invalidates connected candidates, without scanning history.
  const cohorts = timeCandidates(rows, stacks), neighbors = new Map(), affected = [];
  for (const cohort of cohorts) {
    const ids = new Set(cohort.map(p => owner.get(p.id)).filter(Boolean));
    if (cohort.some(p => !owner.has(p.id))) for (const id of ids) invalid.add(id);
    for (const id of ids) {
      if (!neighbors.has(id)) neighbors.set(id, []);
      neighbors.get(id).push(ids);
    }
  }
  affected.push(...invalid);
  for (let i = 0; i < affected.length; i++) for (const linked of neighbors.get(affected[i]) ?? [])
    for (const id of linked) if (!invalid.has(id)) { invalid.add(id); affected.push(id); }
  const preserved = new Set([...retained.keys()].filter(id => !invalid.has(id)));
  const result = candidateGroups(rows.filter(p => !preserved.has(owner.get(p.id))), {
    stacks, separations: store.separations(), ranks: rankReader(store.db, connection),
  });
  for (const id of preserved) {
    const saved = retained.get(id), ids = saved.members.map(m => m[0]).filter(id => pending.has(id));
    for (const group of saved.groups) {
      const members = group.ids.filter(id => pending.has(id));
      if (!members.length) continue;
      result.groups.push({ ...group, ids: members,
        id: members.length === group.ids.length ? group.id : members.length === 1 ? `single:${CANDIDATE_METHOD}:${members[0]}`
          : fingerprint({ method: CANDIDATE_METHOD, ids: members, route: group.route }),
        capturedMs: pending.get(members[0]).time });
    }
    result.scopes.push({ id, ids, referenceIds: saved.referenceIds.filter(id => pending.has(id)),
      materialKeys: ids.map(id => pending.get(id).materialKey), needsRanks: false });
  }
  result.groups.sort((a,b) => (a.capturedMs ?? Infinity) - (b.capturedMs ?? Infinity) || a.ids[0].localeCompare(b.ids[0]));
  result.metrics.photos = rows.length;
  return result;
}

// Upgrade existing completed records lazily from their exact current snapshot.
// Both fresh results and old preview results use this path. Small slices keep
// capture off long uninterrupted request-thread work; no network work is added.
export async function rememberSettledGroups(store, saved, current, now) {
  const byMember = new Map(current.groups.flatMap(g => g.ids.map(id => [id, g])));
  let slice = performance.now(), limited = false;
  for (const scope of current.scopes ?? []) {
    if (!saved.has(scope.id) || saved.settled.has(scope.id)) continue;
    const photos = scope.ids.map(id => store.photo(id));
    if (photos.some((p,i) => !p || p.state !== 'undecided' || p.materialKey !== scope.materialKeys[i])) continue;
    const groups = [...new Set(scope.ids.map(id => byMember.get(id)))];
    if (groups.some(g => !g || g.ids.some(id => !scope.ids.includes(id)))) continue;
    const record = saved.read(scope.id);
    if (!saved.save({ id: scope.id, ...record, settled: {
      members: photos.map(p => [p.id, p.inputKey, p.availability, store.separationKey(p.id)]),
      referenceIds: scope.referenceIds, groups,
    } }, now)) limited = true;
    if (performance.now() - slice >= 4) { await setImmediate(); slice = performance.now(); }
  }
  return limited;
}
