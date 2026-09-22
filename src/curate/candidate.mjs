import { fingerprint } from './contracts.mjs';
import { groupPhotos } from './grouping.mjs';
import { thumbhashDistance } from '../enrich/reviewService.mjs';
import { recognizedIds } from './evidence.mjs';

// Membership-affecting changes require a new version and a docs/CURATE-ALGORITHM.md entry.
export const CANDIDATE_METHOD = 'candidate-1';
export const CANDIDATE_LIMITS = Object.freeze({ gapMs: 90_000, spanMs: 180_000,
  photos: 40, comparisons: 600_000, hashDistance: 0.10, nearOutside: 3, moderateOutside: 8 });
const small = { none: 0, one: 1, couple: 2 };
function hash(value) {
  if (typeof value !== 'string' || !value || value.length > 88 || value.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= 64 ? bytes : null;
}
const order = (a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id);
const difference = (a, b) => a.length !== b.length || a.some((id, i) => id !== b[i]);

export function candidateGroups(rows, { stacks = true, separations = [], ranks = {} } = {}) {
  const limits = CANDIDATE_LIMITS, labels = new Map();
  for (const { id, partitions } of separations) partitions.forEach((part, n) => {
    for (const photo of part) {
      if (!labels.has(photo)) labels.set(photo, new Map());
      labels.get(photo).set(id, n);
    }
  });
  const separated = (a, b) => [...(labels.get(a.id) ?? [])].some(([id, part]) =>
    labels.get(b.id)?.has(id) && labels.get(b.id).get(id) !== part);
  const cohorts = [];
  for (const row of [...rows].sort(order)) {
    const last = cohorts.at(-1);
    if (stacks && row.availability !== 'unavailable' && row.time !== null && last &&
        last[0].availability !== 'unavailable' && last[0].time !== null &&
        row.time - last[0].time <= limits.spanMs && row.time - last.at(-1).time <= limits.gapMs) last.push(row);
    else cohorts.push([row]);
  }
  const groups = [], scopes = [], metrics = { photos: rows.length, pairComparisons: 0, limitedGroups: 0 };
  function emit(members, route, reasons) {
    const sorted = [...members].sort(order), ids = sorted.map(p => p.id);
    groups.push({ id: ids.length === 1 ? `single:${CANDIDATE_METHOD}:${ids[0]}`
      : fingerprint({ method: CANDIDATE_METHOD, ids, route }), ids,
    capturedMs: sorted[0].time, route, reasons });
  }
  for (const cohort of cohorts) {
    if (cohort.length === 1) {
      emit(cohort, cohort[0].availability === 'unavailable' ? 'unavailable' : 'single',
        [!stacks ? 'Stacking is off.' : 'No other pending photo within the time limits.']);
      continue;
    }
    const bounded = cohort.length <= limits.photos &&
      metrics.pairComparisons + cohort.length * (cohort.length - 1) / 2 <= limits.comparisons;
    if (!bounded) {
      // Preserve the complete logical scope; never silently analyze a sample.
      // The existing bounded engine respects all human labels even when its
      // semantic comparison budget is exhausted. All results remain unconfirmed.
      const fallback = groupPhotos(cohort, { separations, limits: { gapMs: limits.gapMs,
        spanMs: limits.spanMs, candidates: 32, pairs: 0, comparisons: 0 } });
      const byId = new Map(cohort.map(p => [p.id, p]));
      for (const g of fallback.groups) {
        emit(g.ids.map(id => byId.get(id)), 'manual-budget',
          ['Grouped by capture time; similarity not established.',
            'Automatic composition checks are limited to 40 photos and a bounded rebuild budget.',
            'Saved human separations were respected.']);
        metrics.limitedGroups++;
      }
      continue;
    }
    const ids = cohort.map(p => p.id);
    const scopeId = fingerprint({ method: CANDIDATE_METHOD,
      rows: cohort.map(p => [p.id, p.materialKey, [...(labels.get(p.id) ?? [])]]) });
    const evidence = ranks[scopeId] ?? {}, supplied = evidence.rows ?? {};
    const members = cohort.map(p => ({ ...p, hash: hash(p.thumbhash), identities: recognizedIds(p.recognition) }));
    const matrix = new Map();
    const at = (a, b) => matrix.get(a.id)?.get(b.id);
    const outside = (a, b) => {
      const value = supplied[a.id]?.[b.id];
      return Number.isInteger(value) && value >= 0 ? value : null;
    };
    const near = (a, b, threshold = limits.nearOutside) => {
      const n = outside(a, b); return n !== null && n <= threshold;
    };
    let visual = false, needsRanks = false;
    for (let i = 0; i < members.length; i++) {
      const a = members[i]; if (!matrix.has(a.id)) matrix.set(a.id, new Map());
      for (let j = i + 1; j < members.length; j++) {
        const b = members[j]; if (!matrix.has(b.id)) matrix.set(b.id, new Map());
        metrics.pairComparisons++;
        const human = separated(a, b), ca = small[a.peopleCategory], cb = small[b.peopleCategory];
        const categoryConflict = Number.isInteger(ca) && Number.isInteger(cb) && ca !== cb;
        const identityConflict = a.identities && b.identities && a.identities.length && b.identities.length &&
          difference(a.identities, b.identities);
        const groundedIdentities = Number.isInteger(ca) && Number.isInteger(cb) &&
          a.identities?.length === ca && b.identities?.length === cb;
        const peopleConflict = categoryConflict || Boolean(identityConflict && groundedIdentities);
        const recognitionUncertain = Boolean(identityConflict && !groundedIdentities);
        const exact = a.checksum && a.checksum === b.checksum && a.renditionKey && a.renditionKey === b.renditionKey;
        const hashKnown = Boolean(a.hash && b.hash);
        const hashClose = hashKnown && thumbhashDistance(a.hash, b.hash) <= limits.hashDistance;
        const reciprocal = near(a, b) && near(b, a);
        visual ||= hashKnown || outside(a, b) !== null || outside(b, a) !== null || Boolean(exact);
        // Conflicting strong signals remain uncertain. One missed recognition
        // can be rescued by reciprocal ranks; a common background alone cannot.
        const supported = !human && !peopleConflict &&
          (exact || reciprocal || (hashClose && !recognitionUncertain));
        const pair = { supported: Boolean(supported), conflict: human || (peopleConflict && !reciprocal),
          human, peopleConflict, recognitionUncertain, hashClose, reciprocal, exact: Boolean(exact) };
        matrix.get(a.id).set(b.id, pair); matrix.get(b.id).set(a.id, pair);
        if (!human && !supported) needsRanks = true;
      }
    }
    scopes.push({ id: scopeId, ids, materialKeys: cohort.map(p => p.materialKey), needsRanks });
    const reasons = ['Time candidates use a 90-second gap and a 3-minute total span.'];
    if (!visual) {
      const provisional = [];
      for (const p of members) {
        const group = provisional.find(g => g.every(q => !at(p, q).conflict));
        if (group) group.push(p); else provisional.push([p]);
      }
      for (const g of provisional) emit(g, g.length > 1 ? 'candidate-unconfirmed' : 'single',
        [...reasons, 'Grouped by capture time and available people evidence; visual similarity is not established.',
          'Saved human separations and supported people differences were respected.']);
      continue;
    }
    // Build fully supported cores first, with deterministic tie-breaking.
    // A single bridge must not merge two already established cores.
    const degree = p => members.filter(q => q !== p && at(p, q).supported).length;
    const pending = [...members].sort((a, b) => degree(b) - degree(a) || order(a, b));
    const cores = [];
    while (pending.length) {
      const core = [pending.shift()];
      for (let i = 0; i < pending.length;) {
        if (core.every(p => at(p, pending[i]).supported)) core.push(...pending.splice(i, 1));
        else i++;
      }
      cores.push({ core, additions: [] });
    }
    const attached = new Set();
    for (const item of cores.filter(g => g.core.length === 1)) {
      const p = item.core[0];
      const targets = cores.filter(({ core, additions }) => core.length >= 3 &&
        [...core, ...additions].every(q => !at(p, q).conflict && !at(p, q).peopleConflict) &&
        core.filter(q => near(q, p)).length >= Math.ceil(core.length * 0.75) &&
        core.some(q => near(p, q)) &&
        core.filter(q => near(p, q, limits.moderateOutside)).length >= Math.ceil(core.length * 0.5));
      // Competing valid cores are ambiguous; do not pick an arbitrary one.
      if (targets.length === 1) { targets[0].additions.push(p); attached.add(p.id); }
    }
    for (const { core, additions } of cores) {
      if (core.length === 1 && attached.has(core[0].id)) continue;
      const g = [...core, ...additions], pairs = g.flatMap((p, i) => g.slice(i + 1).map(q => at(p, q)));
      const why = [...reasons];
      if (g.length === 1) why.push('No sufficiently supported group found; this photo remains separate for review.');
      if (pairs.some(p => p.exact)) why.push('Matching original checksums and compatible renditions support grouping.');
      if (pairs.some(p => p.hashClose)) why.push('Close ThumbHash descriptors support visual similarity.');
      if (pairs.some(p => p.reciprocal)) why.push('Reciprocal nearby Immich search ranks support this composition.');
      if (additions.length) why.push('An asymmetric search match was retained through strong support from the established core.');
      if (g.some(p => labels.has(p.id))) why.push('Saved human separations were respected.');
      why.push('Distant ThumbHash values or missing search results alone are not evidence of a different subject.');
      emit(g, g.length > 1 ? 'candidate-supported' : 'single', why);
    }
  }
  groups.sort((a, b) => (a.capturedMs ?? Infinity) - (b.capturedMs ?? Infinity) || a.ids[0].localeCompare(b.ids[0]));
  return { method: CANDIDATE_METHOD, groups, scopes, metrics };
}
