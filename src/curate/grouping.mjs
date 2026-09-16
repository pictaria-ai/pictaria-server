import { fingerprint } from './contracts.mjs';

export const GROUPING_METHOD = 'standard-1';
export const GROUPING_LIMITS = Object.freeze({
  gapMs: 15_000,
  spanMs: 180_000,
  candidates: 32,
  pairs: 64,
  comparisons: 2_000_000,
});
const contradiction = (a, b) =>
  Number.isInteger(a.peopleCount) &&
  Number.isInteger(b.peopleCount) &&
  a.peopleCount !== b.peopleCount &&
  a.recognizedCount === a.peopleCount &&
  b.recognizedCount === b.peopleCount;

// Runs in the Curate worker. Pending photos alone form actionable groups;
// already-kept context is selected separately by an indexed bounded query.
export function groupPhotos(rows, { stacks = true, separations = [], limits = GROUPING_LIMITS } = {}) {
  const labels = new Map();
  for (const { id, partitions } of separations)
    for (let part = 0; part < partitions.length; part++) {
      for (const photo of partitions[part]) {
        if (!labels.has(photo)) labels.set(photo, new Map());
        labels.get(photo).set(id, part);
      }
    }
  const emptyLabels = new Map();
  const groups = [],
    exact = new Map(),
    duplicates = new Map();
  const metrics = {
    photos: rows.length,
    candidateVisits: 0,
    pairComparisons: 0,
    limitedGroups: 0,
    separations: 0,
    contradictions: 0,
  };
  const sorted = [...rows].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id));
  for (const row of sorted) {
    const own = labels.get(row.id) ?? emptyLabels;
    let selected,
      rejectedForCount = false,
      rejectedForSeparation = false;
    const preferred = [row.checksum && exact.get(row.checksum), row.duplicateId && duplicates.get(row.duplicateId)];
    if (stacks && row.availability !== 'unavailable')
      for (let i = -2; i < limits.candidates; i++) {
        const group = i < 0 ? preferred[i + 2] : groups[groups.length - 1 - i];
        if (!group || (i >= 0 && preferred.includes(group)) || (i === -1 && group === preferred[0])) continue;
        if (group.unavailable) continue;
        metrics.candidateVisits++;
        if ([...own].some(([key, part]) => group.labels.has(key) && group.labels.get(key) !== part)) {
          rejectedForSeparation = true;
          metrics.separations++;
          continue;
        }
        const sameOriginal = row.checksum && group.checksum === row.checksum;
        const sameBytes = sameOriginal && row.renditionKey && row.renditionKey === group.renditionKey;
        const duplicate = row.duplicateId && group.duplicateId === row.duplicateId;
        if (
          !sameOriginal &&
          !duplicate &&
          !(
            row.time !== null &&
            group.first !== null &&
            row.time - group.first <= limits.spanMs &&
            row.time - group.last <= limits.gapMs
          )
        )
          continue;
        let conflict = false,
          limited = false;
        if (!sameBytes)
          for (let n = 0; n < group.members.length; n++) {
            if (n >= limits.pairs || metrics.pairComparisons >= limits.comparisons) {
              limited = true;
              break;
            }
            metrics.pairComparisons++;
            if (contradiction(group.members[n], row)) {
              conflict = true;
              break;
            }
          }
        if (conflict) {
          rejectedForCount = true;
          group.contradiction = true;
          metrics.contradictions++;
          continue;
        }
        group.limited ||= limited;
        group.duplicate ||= Boolean(duplicate);
        selected = group;
        break;
      }
    if (!selected) {
      selected = {
        members: [],
        labels: emptyLabels,
        first: row.time,
        last: row.time,
        checksum: row.checksum,
        duplicateId: row.duplicateId,
        renditionKey: row.renditionKey,
        limited: false,
        unavailable: row.availability === 'unavailable',
        contradiction: rejectedForCount,
        separated: rejectedForSeparation,
      };
      groups.push(selected);
    }
    selected.members.push(row);
    selected.last = row.time;
    if (selected.checksum !== row.checksum) selected.checksum = null;
    if (selected.duplicateId !== row.duplicateId) selected.duplicateId = null;
    if (selected.renditionKey !== row.renditionKey) selected.renditionKey = null;
    if (own.size && selected.labels === emptyLabels) selected.labels = new Map();
    for (const [key, part] of own) selected.labels.set(key, part);
    if (row.checksum) exact.set(row.checksum, selected);
    if (row.duplicateId) duplicates.set(row.duplicateId, selected);
  }
  return {
    method: GROUPING_METHOD,
    metrics,
    groups: groups.map((g) => {
      const ids = g.members.map((r) => r.id),
        keyIds = [...ids].sort();
      if (g.limited) metrics.limitedGroups++;
      return {
        id:
          ids.length === 1
            ? `single:${GROUPING_METHOD}:${ids[0]}`
            : fingerprint({ method: GROUPING_METHOD, ids: keyIds }),
        ids,
        // The first member has the earliest known capture time (unknown dates sort last).
        capturedMs: g.first,
        route: g.unavailable
          ? 'unavailable'
          : ids.length === 1
            ? 'single'
            : g.limited
              ? 'manual-budget'
              : g.checksum && g.renditionKey
                ? 'checksum-bypass'
                : 'uncertain',
        reasons: [
          !stacks
            ? 'Stacking is off.'
            : g.checksum && ids.length > 1
              ? 'Same recorded original checksum.'
              : g.duplicateId && ids.length > 1
                ? 'Same Immich duplicate group; subject match remains uncertain.'
                : ids.length > 1
                  ? 'Capture times fit the 15-second gap and 3-minute span.'
                  : 'No compatible alternative in the bounded search.',
          ...(g.contradiction ? ['Different people counts corroborated by recognition separated candidates.'] : []),
          ...(g.labels.size || g.separated ? ['Saved human separations were respected.'] : []),
          ...(g.limited ? ['Comparison budget reached; stack composition is unconfirmed.'] : []),
          ...(g.unavailable ? ['Photo is known to be unavailable.'] : []),
        ],
      };
    }),
  };
}
