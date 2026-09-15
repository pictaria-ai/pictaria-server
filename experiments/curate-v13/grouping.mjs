// Offline experiment, deliberately not imported by the server. The semantic
// veto is a calibration candidate, not a validated production classifier.
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { thumbhashDistance } from '../../src/enrich/reviewService.mjs';

export function fingerprint(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
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
  // Composition can change against an identical backdrop. Requiring a
  // different thumbnail would suppress the people/landscape and couple/solo
  // candidate vetoes we are evaluating. Corroboration is still not proof:
  // this rule stays opt-in until positive AND missed-detection cases pass.
  return true;
}

function descriptor(row) {
  const value = row.thumbhash;
  if (typeof value !== 'string' || !value.length || value.length > 128
    || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= 64 ? bytes : null;
}

function lookbackCompatible(a, b, distance) {
  const ac = count(a), bc = count(b);
  // Positive support is deliberately stricter than the ordinary time fallback.
  // Unknown facts withhold this optional merge; recognition never proves that
  // subjects match. Even a supported lookback remains an unconfirmed candidate.
  if (ac === null || ac > 100 || ac !== bc || !Array.isArray(a.personIds) || !Array.isArray(b.personIds)
    || a.personIds.length !== ac || b.personIds.length !== bc
    || [...a.personIds, ...b.personIds].some(id => typeof id !== 'string' || !id.length)
    || new Set(a.personIds).size !== ac || new Set(b.personIds).size !== bc
    || a.personIds.some(id => !b.personIds.includes(id))) return false;
  const ah = descriptor(a), bh = descriptor(b);
  return ah !== null && bh !== null && ah.length === bh.length && thumbhashDistance(ah, bh) <= distance;
}

function* groupingSteps(rows, {
  semanticVeto = false, maxSpanMs = 180000, maxGapMs = 15000,
  candidateLimit = 32, pairsPerCandidate = 64, comparisonBudget = 2000000,
  separations = [], lookbackDistance = null,
} = {}) {
  if (lookbackDistance !== null && (!Number.isFinite(lookbackDistance) || lookbackDistance < 0 || lookbackDistance > 1)) throw Error('invalid lookback distance');
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
  const groups = [], exact = new Map(), emptyLabels = new Map();
  const metrics = { candidateVisits: 0, pairComparisons: 0, limitedGroups: 0, sourcePhotos: rows.length,
    lookbackJoins: 0, lookbackPairComparisons: 0, lookbackLimitedCandidates: 0 };
  const sorted = rows.map(row => ({ row, time: Date.parse(row.capturedAt) }))
    .sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity)
      - (Number.isFinite(b.time) ? b.time : Infinity) || a.row.id.localeCompare(b.row.id));
  for (const { row, time } of sorted) {
    const ownLabels = labels.get(row.id) ?? emptyLabels;
    const previous = exact.get(row.checksum);
    let selected;
    // Exact match first, then the same bounded recent window as before. Avoid
    // rebuilding arrays and a Set for every photo in every background pass.
    for (let ci = groups.length; ci >= Math.max(0, groups.length - candidateLimit); ci--) {
      const group = ci === groups.length ? (row.checksum ? previous : null) : groups[ci];
      if (!group || (ci !== groups.length && row.checksum && group === previous)) continue;
      metrics.candidateVisits++;
      // Hard human constraints cover ALL members, even when the softer
      // evidence budget is exhausted. A bridge cannot reunite a split.
      let separated = false;
      for (const [key, part] of ownLabels) {
        if (group.labels.has(key) && group.labels.get(key) !== part) { separated = true; break; }
      }
      if (separated) continue;
      const sameBytes = row.checksum && group.checksum === row.checksum;
      if (!sameBytes && !(Number.isFinite(time) && time - group.first <= maxSpanMs)) continue;
      const longerGap = !sameBytes && time - group.last > maxGapMs;
      const needsLookback = !sameBytes && (longerGap || group.lookback);
      if (needsLookback) {
        if (lookbackDistance === null || group.limited) continue;
        // The first extension checks the WHOLE candidate, including pairs in
        // the existing time group. Later additions must preserve that invariant,
        // even if they arrive within the ordinary short-gap window.
        let checked = 0, supported = true, exhausted = false;
        const pair = (a, b) => {
          if (checked >= pairsPerCandidate || metrics.pairComparisons >= comparisonBudget) {
            exhausted = true; return false;
          }
          checked++; metrics.pairComparisons++; metrics.lookbackPairComparisons++;
          return lookbackCompatible(a, b, lookbackDistance);
        };
        if (!group.lookback) {
          for (let i = 0; i < group.members.length && supported; i++) {
            for (let j = 0; j < i && supported; j++) supported = pair(group.members[i], group.members[j]);
          }
        }
        for (const member of group.members) {
          if (!supported) break;
          supported = pair(member, row);
        }
        if (exhausted) metrics.lookbackLimitedCandidates++;
        if (!supported) continue; // never infer support from an unfinished check
      }
      let conflict = false, limited = false;
      if (semanticVeto && !sameBytes && !needsLookback) {
        for (let i = 0; i < group.members.length; i++) {
          if (i >= pairsPerCandidate || metrics.pairComparisons >= comparisonBudget) { limited = true; break; }
          metrics.pairComparisons++;
          if (candidateContradiction(group.members[i], row)) { conflict = true; break; }
        }
      }
      if (conflict) continue;
      group.limited ||= limited;
      if (needsLookback) group.lookback = true;
      if (longerGap) metrics.lookbackJoins++;
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
    yield; // bounded candidate work can yield without publishing partial groups
  }
  const result = [];
  for (const group of groups) {
    const ids = group.members.map(r => r.id).sort();
    if (group.limited) metrics.limitedGroups++;
    result.push({
      id: fingerprint(ids), ids,
      pendingIds: group.members.filter(r => r.state !== 'kept').map(r => r.id),
      keptContextIds: group.members.filter(r => r.state === 'kept').map(r => r.id),
      route: group.limited ? 'manual-budget' : group.checksum && ids.length > 1 ? 'checksum-bypass' : 'uncertain',
      reasons: [group.checksum ? 'same recorded checksum' : 'bounded capture-time candidate',
        ...(group.lookback ? ['whole-candidate evidence supports longer-gap comparison; grouping unconfirmed'] : []),
        ...(group.limited ? ['evidence comparison budget exhausted; grouping unconfirmed'] : []),
        ...(group.labels.size ? ['human separation constraints applied'] : [])],
    });
    yield;
  }
  return { groups: result, metrics };
}

export function groupPhotos(rows, options) {
  const steps = groupingSteps(rows, options);
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

// The caller supplies an immutable prepared snapshot, never live mutable rows.
// Sorting and one candidate/member operation remain indivisible; report actual
// slices rather than claiming this timer imposes a hard latency bound on them.
export async function groupPhotosInBackground(rows, options, {
  sliceMs = 4, signal, yieldNow = setImmediate, onSlice = () => {},
} = {}) {
  if (!Number.isFinite(sliceMs) || sliceMs < 0) throw Error('invalid slice budget');
  const steps = groupingSteps(rows, options);
  let started = performance.now();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const step = steps.next();
      const elapsed = performance.now() - started;
      if (step.done || elapsed >= sliceMs) {
        onSlice(elapsed);
        if (step.done) return step.value;
        await yieldNow();
        started = performance.now();
      }
    }
  } finally { steps.return(); }
}

// No request chunk becomes a stack, and no per-chunk winner is discarded.
// This envelope is a PROPOSED starting point; actual provider quality and
// realistic renditions still require the authorized visual evaluation.
export function planRequest(group, sizes, { role, stacks = true, check = false, referee = false, checkState = 'pending', maxImages = 30 }) {
  if (!['check', 'keeper'].includes(role)) throw Error('invalid role');
  if (!stacks || !(role === 'check' ? check : referee)) return { state: 'disabled' };
  if (group.pendingIds.length < 2) return { state: 'manual-context' };
  if (role === 'keeper' && check && !['valid', 'bypass'].includes(checkState)) return { state: 'waiting-for-check' };
  if (group.route === 'manual-budget') return { state: 'manual-budget' };
  if (role === 'check' && group.route === 'checksum-bypass') return { state: 'bypass' };
  if (!Number.isSafeInteger(maxImages) || maxImages < 2) return { state: 'unsupported-provider' };
  const bytes = group.ids.map(id => sizes[id]);
  if (bytes.some(n => !Number.isSafeInteger(n) || n <= 0)) return { state: 'unavailable-image' };
  const rawBytes = bytes.reduce((sum, n) => sum + n, 0);
  if (group.ids.length > 30 || bytes.some(n => n > 2 * 1024 * 1024) || rawBytes > 24 * 1024 * 1024) {
    return { state: 'manual-size', members: group.ids.length, rawBytes };
  }
  if (group.ids.length > maxImages) return { state: 'manual-provider', members: group.ids.length, maxImages };
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
