import { partition, decodeHash, hashDistance, peopleCategory } from './stacking-model.js';

// Candidate rules for owner evaluation, not production confidence/bypass rules.
// Rank absence/low rank is never a negative visual observation.
export function assessPair(a, b, settings, rows) {
  const notes = [];
  const distance = settings.thumbhash ? hashDistance(decodeHash(a.thumbhash), decodeHash(b.thumbhash)) : null;
  const close = distance !== null && distance <= settings.threshold;
  const far = distance !== null && !close;
  if (settings.thumbhash) notes.push(distance === null ? 'ThumbHash unknown' : `ThumbHash ${distance.toFixed(3)} (${close ? 'close' : 'different'})`);
  const ac = peopleCategory(a), bc = peopleCategory(b);
  const categoryConflict = settings.people && ac !== null && bc !== null && ac !== bc;
  const categoryAgreement = settings.people && ac !== null && ac === bc;
  if (settings.people) notes.push(ac === null || bc === null ? 'Enrich people unknown' : `Enrich people ${ac} / ${bc}`);
  const ai = new Set(a.recognizedIds ?? []), bi = new Set(b.recognizedIds ?? []);
  const overlap = [...ai].some(id => bi.has(id));
  const identityConflict = settings.identities && ai.size > 0 && bi.size > 0 && !overlap;
  if (settings.identities) notes.push(!ai.size || !bi.size ? 'Recognized identities incomplete or missing'
    : overlap ? 'Some recognized identities match (may be incomplete)' : 'Recognized identities differ (may be incomplete)');
  const rank = (from, to) => {
    const row = rows.get(from);
    return row?.state === 'complete' ? row.photos.find(p => p.id === to)?.rank ?? null : null;
  };
  const ab = rank(a.id, b.id), ba = rank(b.id, a.id);
  const reciprocal = settings.ranks && ab !== null && ba !== null && ab <= settings.rankLimit && ba <= settings.rankLimit;
  if (settings.ranks) {
    const label = (from, value) => rows.get(from)?.state === 'complete' ? value === null ? 'not returned' : `#${value}` : rows.get(from)?.state ?? 'unqueried';
    notes.push(`Search → ${label(a.id, ab)}; ← ${label(b.id, ba)}${reciprocal ? ' (reciprocal near ranks)' : ' (no reciprocal support; not a mismatch)'}`);
  }
  const conflict = categoryConflict || identityConflict;
  let state = 'uncertain', reason = 'Capture time only or insufficient evidence';
  if (conflict && (close || reciprocal)) reason = 'Visual support conflicts with people evidence';
  else if (conflict && far) { state = 'separate'; reason = 'ThumbHash difference corroborates people difference'; }
  else if (!conflict && (close || (reciprocal && (categoryAgreement || (settings.identities && overlap))))) {
    state = 'supported'; reason = close ? 'Close ThumbHash without an observed people conflict' : 'Reciprocal ranks and people agreement support alternatives';
  } else if (conflict) reason = 'People difference without corroborating visual evidence';
  else if (reciprocal) reason = 'Reciprocal ranks need independent composition evidence';
  return { state, reason, notes };
}

export function combinedPartition(photos, settings, rows = new Map()) {
  if (!Number.isInteger(settings.rankLimit) || settings.rankLimit < 1 || settings.rankLimit > 50)
    throw Error('Choose a rank cutoff from 1 to 50.');
  const pairs = new Map(), key = (a, b) => JSON.stringify([a, b].sort());
  for (let i = 0; i < photos.length; i++) for (let j = i + 1; j < photos.length; j++) {
    const a = photos[i], b = photos[j];
    pairs.set(key(a.id, b.id), assessPair(a, b, settings, rows));
  }
  const result = partition(photos, { gapMs: settings.gapMs, spanMs: settings.spanMs,
    pairRule: (a, b) => {
      const pair = pairs.get(key(a.id, b.id));
      return pair.state === 'separate' ? pair.reason : null;
    } });
  const summaries = result.groups.map(group => {
    let supported = 0, uncertain = 0;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const pair = pairs.get(key(group[i].id, group[j].id));
      if (pair.state === 'supported') supported++; else uncertain++;
    }
    return group.length === 1 ? 'Single photo' : uncertain
      ? `Provisional: ${uncertain} uncertain pair${uncertain === 1 ? '' : 's'}, ${supported} supported`
      : `Supported by these experimental rules: all ${supported} pairs`;
  });
  return { ...result, summaries, pairs, pair: (a, b) => pairs.get(key(a, b)) };
}
