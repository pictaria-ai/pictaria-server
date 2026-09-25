// Experimental, deterministic lab rules. These never change production groups.
export const LAB_PHOTO_LIMIT = 250;

export function decodeHash(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return bytes.length >= 3 ? bytes : null;
  } catch { return null; }
}

// Same raw-byte normalized L1 heuristic as released Curate. Unknown is not 1.
export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

export function peopleCategory(photo) {
  return ['none', 'one', 'couple', 'group'].includes(photo.peopleCategory) ? photo.peopleCategory : null;
}

export function peopleLabel(photo) {
  const category = peopleCategory(photo);
  if (category) return { none: 'None', one: 'One', couple: 'Couple', group: 'Group' }[category];
  if (photo.peopleStatus === 'unsupported') return 'Unknown (saved Enrich information unavailable)';
  if (photo.peopleStatus === 'conflicting') return 'Unknown (conflicting Enrich fields)';
  return 'Unknown';
}

export function recognizedPeople(photo) {
  return Array.isArray(photo.recognizedIds) ? new Set(photo.recognizedIds) : null;
}

// A returned empty list is an observation; unavailable recognition is not.
export function identitiesDiffer(a, b) {
  return a === null || b === null ? null : a.size !== b.size || [...a].some(id => !b.has(id));
}

export function timeGroups(photos, gapMs) {
  const sorted = [...photos].sort((a, b) =>
    (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id));
  const groups = [];
  for (const photo of sorted) {
    const last = groups.at(-1);
    if (last && photo.time !== null && last.at(-1).time !== null &&
        photo.time - last.at(-1).time <= gapMs) last.push(photo);
    else groups.push([photo]);
  }
  return groups;
}

export function partition(photos, { gapMs, spanMs = null, thumbhash = false, threshold = 0.1, people = false, identities = false }) {
  if (photos.length > LAB_PHOTO_LIMIT) throw Error(`Experiments support at most ${LAB_PHOTO_LIMIT} photos.`);
  if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > 180000 ||
      (spanMs !== null && (!Number.isFinite(spanMs) || spanMs < 0 || spanMs > 3600000)) ||
      !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw Error('Invalid experiment settings.');
  const sorted = [...photos].sort((a, b) =>
    (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id));
  const hashes = new Map(photos.map((p) => [p.id, decodeHash(p.thumbhash)]));
  const recognized = new Map(photos.map((p) => [p.id, recognizedPeople(p)]));
  const groups = [], byPhoto = new Map(), reasons = new Map();
  for (const photo of sorted) {
    let found = null;
    const blocked = new Set();
    if (photo.time === null) blocked.add('Capture time unknown');
    else for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      if (group.at(-1).time === null || photo.time - group.at(-1).time > gapMs) {
        blocked.add('Time gap'); continue;
      }
      if (spanMs !== null && photo.time - group[0].time > spanMs) {
        blocked.add('Total span'); continue;
      }
      let compatible = true;
      for (const member of group) {
        const a = recognized.get(photo.id), b = recognized.get(member.id);
        if (identities && identitiesDiffer(a, b)) {
          blocked.add('Different recognized people'); compatible = false; break;
        }
        if (people && peopleCategory(photo) !== null && peopleCategory(member) !== null &&
            peopleCategory(photo) !== peopleCategory(member)) {
          blocked.add('Enrich people-category difference'); compatible = false; break;
        }
        if (thumbhash) {
          const distance = hashDistance(hashes.get(photo.id), hashes.get(member.id));
          if (distance === null || distance > threshold) {
            blocked.add(distance === null ? 'ThumbHash unavailable or incompatible' : 'ThumbHash difference');
            compatible = false; break;
          }
        }
      }
      if (compatible) { found = group; break; }
    }
    if (found) {
      found.push(photo);
      reasons.set(photo.id, 'Joins this group under the selected rules');
    } else {
      found = [photo]; groups.push(found);
      reasons.set(photo.id, blocked.size ? `New group: ${[...blocked].join(', ').toLowerCase()}` : 'Starts the first group');
    }
    byPhoto.set(photo.id, found);
  }
  const numbered = new Map(groups.map((g, i) => [g, i + 1]));
  return { groups, reasons, byPhoto: new Map([...byPhoto].map(([id, g]) => [id, numbered.get(g)])) };
}
