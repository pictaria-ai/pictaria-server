import { LAB_PHOTO_LIMIT } from './stacking-model.js';

const order = (a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id);

// Build supported relationships before attaching uncertain ones. Every merge
// respects all cross-group separations, not just the edge that prompted it.
// This is deterministic greedy clustering, not a global optimum guarantee.
export function evidencePartition(photos, { gapMs, spanMs = null }, pair) {
  if (photos.length > LAB_PHOTO_LIMIT || !Number.isFinite(gapMs) || gapMs < 0 || gapMs > 180000 ||
      (spanMs !== null && (!Number.isFinite(spanMs) || spanMs < 0 || spanMs > 3600000)))
    throw Error('Invalid experiment size or time limits.');
  const sorted = [...photos].sort(order), owners = new Map(), supported = [], uncertain = [];
  for (const p of sorted) owners.set(p.id, { members: [p], blocked: new Set() });
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i], b = sorted[j], state = pair(a, b).state;
    if (state === 'separate') {
      owners.get(a.id).blocked.add(b.id); owners.get(b.id).blocked.add(a.id);
    } else (state === 'supported' ? supported : uncertain).push([a, b]);
  }
  const join = (a, b) => {
    const left = owners.get(a.id), right = owners.get(b.id);
    if (left === right || right.members.some(p => left.blocked.has(p.id))) return;
    const members = [...left.members, ...right.members].sort(order);
    if (members.some(p => p.time === null) ||
        (spanMs !== null && members.at(-1).time - members[0].time > spanMs) ||
        members.some((p, i) => i > 0 && p.time - members[i - 1].time > gapMs)) return;
    const merged = { members, blocked: new Set([...left.blocked, ...right.blocked]) };
    for (const p of members) owners.set(p.id, merged);
  };
  for (const [a, b] of supported) join(a, b);
  // A supported edge that initially exceeded the consecutive gap can become
  // admissible after uncertain intermediate photos are attached. Revisit it
  // after those attachments without weakening any separation or time bound.
  for (const [a, b] of uncertain) join(a, b);
  for (const [a, b] of supported) join(a, b);
  const groups = [...new Set(sorted.map(p => owners.get(p.id)))].map(g => g.members).sort((a, b) => order(a[0], b[0]));
  const byPhoto = new Map(), reasons = new Map();
  groups.forEach((group, i) => group.forEach(p => {
    byPhoto.set(p.id, i + 1);
    reasons.set(p.id, p.time === null ? 'Capture time unknown; remains single'
      : 'Supported links placed first; uncertain attachments respect every separation and time limit');
  }));
  return { groups, byPhoto, reasons };
}
