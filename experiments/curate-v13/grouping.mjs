// Offline experiment, deliberately not imported by the server. The semantic
// veto is a calibration candidate, not a validated production classifier.
import { createHash } from 'node:crypto';
import { thumbhashDistance } from '../../src/enrich/reviewService.mjs';

export function fingerprint(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function hash(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{1,86}={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length && bytes.length <= 64 ? bytes : null;
}

function count(row) {
  // Explicit adapter contract attached to the producing result; arbitrary
  // tags and the currently selected profile cannot supply these facts.
  const facts = row.facts;
  return facts?.contract === 'curate-facts-prototype-1' && Number.isInteger(facts.peopleCount)
    && facts.peopleCount >= 0 ? facts.peopleCount : null;
}

function candidateContradiction(a, b) {
  const ac = count(a), bc = count(b);
  if (ac === null || bc === null || ac === bc) return false;
  // Recognition supports an observation but never proves completeness.
  // Deliberately withhold this candidate veto when Enrich and recognition
  // conflict (e.g. a couple with only one recognized face).
  if (!Array.isArray(a.personIds) || !Array.isArray(b.personIds)
    || a.personIds.length !== ac || b.personIds.length !== bc) return false;
  const ah = hash(a.thumbhash), bh = hash(b.thumbhash);
  return Boolean(ah && bh && thumbhashDistance(ah, bh) >= 0.15);
}

export function groupPhotos(rows, {
  semanticVeto = false, maxSpanMs = 180000, maxGapMs = 15000,
  candidateLimit = 32, pairsPerCandidate = 64, comparisonBudget = 2000000,
  separations = [],
} = {}) {
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw Error('duplicate photo ID');
  const labels = new Map();
  for (const correction of separations) {
    const assigned = new Set();
    correction.partitions.forEach((partition, index) => {
      for (const id of partition) {
        if (assigned.has(id)) throw Error('invalid separation');
        assigned.add(id);
        if (!labels.has(id)) labels.set(id, new Map());
        if (labels.get(id).has(correction.id)) throw Error('duplicate separation ID');
        labels.get(id).set(correction.id, index);
      }
    });
  }
  const groups = [], exact = new Map();
  const metrics = { candidateVisits: 0, pairComparisons: 0, limitedGroups: 0, sourcePhotos: rows.length };
  const sorted = rows.map(row => ({ row, time: Date.parse(row.capturedAt) }))
    .sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity)
      - (Number.isFinite(b.time) ? b.time : Infinity) || a.row.id.localeCompare(b.row.id));
  for (const { row, time } of sorted) {
    const ownLabels = labels.get(row.id) ?? new Map();
    const previous = exact.get(row.checksum);
    const candidates = [...new Set([
      ...(row.checksum && previous ? [previous] : []),
      ...groups.slice(-candidateLimit).reverse(),
    ])];
    let selected;
    for (const group of candidates) {
      metrics.candidateVisits++;
      // Hard human constraints cover ALL members, even when the softer
      // evidence budget is exhausted. A bridge cannot reunite a split.
      if ([...ownLabels].some(([key, part]) => group.labels.has(key) && group.labels.get(key) !== part)) continue;
      const sameBytes = row.checksum && group.checksum === row.checksum;
      if (!sameBytes && !(Number.isFinite(time) && time - group.first <= maxSpanMs && time - group.last <= maxGapMs)) continue;
      let conflict = false, limited = false;
      if (semanticVeto && !sameBytes) {
        for (let i = 0; i < group.members.length; i++) {
          if (i >= pairsPerCandidate || metrics.pairComparisons >= comparisonBudget) { limited = true; break; }
          metrics.pairComparisons++;
          if (candidateContradiction(group.members[i], row)) { conflict = true; break; }
        }
      }
      if (conflict) continue;
      group.limited ||= limited;
      selected = group;
      break;
    }
    if (!selected) {
      selected = { members: [], labels: new Map(), first: time, last: time, checksum: row.checksum || null, limited: false };
      groups.push(selected);
    }
    selected.members.push(row);
    selected.last = time;
    if (selected.checksum !== row.checksum) selected.checksum = null;
    for (const [key, part] of ownLabels) selected.labels.set(key, part);
    if (row.checksum) exact.set(row.checksum, selected);
  }
  const result = groups.map(group => {
    const ids = group.members.map(r => r.id).sort();
    if (group.limited) metrics.limitedGroups++;
    return {
      id: fingerprint(ids), ids,
      pendingIds: group.members.filter(r => r.state !== 'kept').map(r => r.id),
      keptContextIds: group.members.filter(r => r.state === 'kept').map(r => r.id),
      route: group.limited ? 'manual-budget' : group.checksum && ids.length > 1 ? 'checksum-bypass' : 'uncertain',
      reasons: [group.checksum ? 'same recorded checksum' : 'bounded capture-time candidate',
        ...(group.limited ? ['evidence comparison budget exhausted; grouping unconfirmed'] : []),
        ...(group.labels.size ? ['human separation constraints applied'] : [])],
    };
  });
  return { groups: result, metrics };
}

// No request chunk becomes a stack, and no per-chunk winner is discarded.
// This envelope is a PROPOSED starting point; actual provider quality and
// realistic renditions still require the authorized visual evaluation.
export function planRequest(group, sizes, { role, stacks = true, check = false, referee = false, checkState = 'pending' }) {
  if (!['check', 'keeper'].includes(role)) throw Error('invalid role');
  if (!stacks || !(role === 'check' ? check : referee)) return { state: 'disabled' };
  if (group.pendingIds.length < 2) return { state: 'manual-context' };
  if (role === 'keeper' && check && !['valid', 'bypass'].includes(checkState)) return { state: 'waiting-for-check' };
  if (group.route === 'manual-budget') return { state: 'manual-budget' };
  if (role === 'check' && group.route === 'checksum-bypass') return { state: 'bypass' };
  const bytes = group.ids.map(id => sizes[id]);
  if (bytes.some(n => !Number.isSafeInteger(n) || n <= 0)) return { state: 'unavailable-image' };
  const rawBytes = bytes.reduce((sum, n) => sum + n, 0);
  if (group.ids.length > 30 || bytes.some(n => n > 2 * 1024 * 1024) || rawBytes > 24 * 1024 * 1024) {
    return { state: 'manual-size', members: group.ids.length, rawBytes };
  }
  return { state: 'ready', requests: [group.ids], rawBytes, base64Bytes: bytes.reduce((n, size) => n + 4 * Math.ceil(size / 3), 0) };
}

export function validateAdvice(inputIds, output, role = 'keeper') {
  if (!['check', 'keeper'].includes(role) || !inputIds.length || new Set(inputIds).size !== inputIds.length) throw Error('invalid input');
  if (!output || Object.keys(output).some(k => k !== 'groups') || !Array.isArray(output.groups) || !output.groups.length) throw Error('invalid partition');
  const expected = new Set(inputIds), seen = new Set();
  for (const group of output.groups) {
    const allowed = role === 'keeper' ? ['ids', 'keepers', 'reason'] : ['ids', 'reason'];
    if (!group || Object.keys(group).some(k => !allowed.includes(k)) || !Array.isArray(group.ids) || !group.ids.length
      || typeof group.reason !== 'string' || !group.reason.trim() || group.reason.length > 300) throw Error('invalid group');
    for (const id of group.ids) {
      if (!expected.has(id) || seen.has(id)) throw Error('invalid membership');
      seen.add(id);
    }
    if (role === 'keeper' && (!Array.isArray(group.keepers) || new Set(group.keepers).size !== group.keepers.length
      || group.keepers.some(id => !group.ids.includes(id)))) throw Error('invalid keepers');
  }
  if (seen.size !== expected.size) throw Error('incomplete partition');
  return structuredClone(output);
}
