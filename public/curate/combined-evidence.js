import { LAB_PHOTO_LIMIT, decodeHash, hashDistance, peopleCategory } from './stacking-model.js';
import { evidencePartition } from './evidence-partition.js';
import { rankObservation } from './rank-evidence.js';

export const COMBINED_DEFAULTS = Object.freeze({ nearHash: .025, farHash: .15, outsideLimit: 2, rankContrast: 8 });
const key = (a, b) => JSON.stringify([a, b].sort());

function evaluator(photos, settings, rows) {
  const s = { ...COMBINED_DEFAULTS, ...settings };
  if (!Number.isFinite(s.nearHash) || !Number.isFinite(s.farHash) || s.nearHash < 0 || s.farHash > 1 || s.nearHash >= s.farHash ||
      !Number.isInteger(s.outsideLimit) || s.outsideLimit < 0 || s.outsideLimit > 49 ||
      !Number.isInteger(s.rankContrast) || s.rankContrast < 1 || s.rankContrast > 49)
    throw Error('Choose ordered ThumbHash bands and valid outside-photo/contrast limits.');
  const hashes = new Map(photos.map(p => [p.id, decodeHash(p.thumbhash)]));
  const countsAgree = p => {
    const category = peopleCategory(p), ids = p.recognizedIds;
    if (!Array.isArray(ids) || category === null) return false;
    const count = new Set(ids).size;
    return category === 'group' ? count >= 3 : count === { none: 0, one: 1, couple: 2 }[category];
  };
  const observations = new Map();
  const input = (a, b) => {
    // Direction matters to the two rank observations; cache in call order.
    const id = JSON.stringify([a.id, b.id]);
    if (observations.has(id)) return observations.get(id);
    const ac = peopleCategory(a), bc = peopleCategory(b);
    const ai = new Set(a.recognizedIds ?? []), bi = new Set(b.recognizedIds ?? []);
    const overlap = [...ai].some(id => bi.has(id));
    const categoryConflict = s.people && ac !== null && bc !== null && ac !== bc;
    const conflict = categoryConflict || (s.identities && ai.size > 0 && bi.size > 0 && !overlap);
    const agreement = (s.people && ac !== null && ac === bc) || (s.identities && overlap);
    const countConflict = s.people && s.identities && categoryConflict && countsAgree(a) && countsAgree(b);
    const distance = s.thumbhash ? hashDistance(hashes.get(a.id), hashes.get(b.id)) : null;
    const near = distance !== null && distance <= s.nearHash, far = distance !== null && distance >= s.farHash;
    const middle = distance !== null && !near && !far;
    const ab = s.ranks ? rankObservation(rows.get(a.id), b.id) : null;
    const ba = s.ranks ? rankObservation(rows.get(b.id), a.id) : null;
    const reciprocal = ab !== null && ba !== null && ab.outsideAhead <= s.outsideLimit && ba.outsideAhead <= s.outsideLimit;
    const result = { ac, bc, ai, bi, overlap, conflict, agreement, countConflict, distance, near, middle, far, ab, ba, reciprocal };
    observations.set(id, result); return result;
  };
  const contrastFrom = (a, b, rank) => {
    if (!rank || rank.outsideAhead <= s.outsideLimit) return false;
    return photos.some(c => {
      if (c.id === a.id || c.id === b.id) return false;
      const basis = input(a, c);
      // A returned lower rank alone is not negative evidence. Require a
      // reciprocal near alternative with independent visual/people support.
      return basis.reciprocal && !basis.conflict && (basis.near || basis.middle || basis.agreement) &&
        rank.outsideAhead - basis.ab.outsideAhead >= s.rankContrast;
    });
  };
  return (a, b) => {
    const p = input(a, b), notes = [];
    const contrast = contrastFrom(a, b, p.ab) && contrastFrom(b, a, p.ba);
    if (s.thumbhash) notes.push(p.distance === null ? 'ThumbHash unknown'
      : `ThumbHash ${p.distance.toFixed(3)} (${p.near ? 'very close' : p.far ? 'clearly different' : 'middle band'})`);
    if (s.people) notes.push(p.ac === null || p.bc === null ? 'Enrich people unknown' : `Enrich people ${p.ac} / ${p.bc}`);
    if (s.identities) notes.push(!Array.isArray(a.recognizedIds) || !Array.isArray(b.recognizedIds)
      ? 'Recognized identities missing' : `Recognized counts ${p.ai.size} / ${p.bi.size} (may be incomplete); ${p.overlap ? 'some identities match' : p.ai.size && p.bi.size ? 'identities differ' : 'empty observations do not establish absence'}`);
    if (p.countConflict) notes.push('Both recognition counts corroborate their different Enrich categories');
    if (s.ranks) {
      const label = (from, value) => value ? `#${value.rank}, ${value.outsideAhead} outside ahead`
        : rows.get(from)?.state === 'complete' ? 'not returned' : rows.get(from)?.state ?? 'unqueried';
      notes.push(`Search → ${label(a.id, p.ab)}; ← ${label(b.id, p.ba)}${p.reciprocal ? ' (reciprocal near ranks)' : contrast ? ' (reciprocal contrast with supported alternatives)' : ' (no conclusive rank contrast)'}`);
    }
    let state = 'uncertain', reason = 'Capture time only or insufficient evidence';
    if (p.conflict && p.reciprocal) reason = 'Reciprocal ranks conflict with people evidence';
    else if (p.countConflict || (p.conflict && (p.far || contrast)) || (p.far && contrast)) {
      state = 'separate';
      reason = p.countConflict ? 'Different Enrich categories corroborated by recognition counts'
        : contrast ? 'Returned rank contrast corroborates a people or visual difference' : 'Clearly different ThumbHash corroborates people difference';
    } else if (p.conflict || contrast) reason = 'Conflicting evidence needs review';
    else if (p.near || (p.middle && (p.agreement || p.reciprocal)) || (p.reciprocal && p.agreement)) {
      state = 'supported'; reason = p.near ? 'Very close ThumbHash without observed conflict'
        : p.middle ? 'Middle-band ThumbHash has independent corroboration' : 'Reciprocal ranks and people agreement support alternatives';
    } else if (p.reciprocal) reason = 'Reciprocal ranks need independent composition evidence';
    return { state, reason, notes };
  };
}

export function assessPair(a, b, settings, rows = new Map(), photos = [a, b]) {
  return evaluator(photos, settings, rows)(a, b);
}

export function combinedPartition(photos, settings, rows = new Map()) {
  if (photos.length > LAB_PHOTO_LIMIT) throw Error(`Experiments support at most ${LAB_PHOTO_LIMIT} photos.`);
  const assess = evaluator(photos, settings, rows), pairs = new Map();
  for (let i = 0; i < photos.length; i++) for (let j = i + 1; j < photos.length; j++) {
    const a = photos[i], b = photos[j]; pairs.set(key(a.id, b.id), assess(a, b));
  }
  const pair = (a, b) => pairs.get(key(a, b));
  const result = evidencePartition(photos, settings, (a, b) => pair(a.id, b.id));
  const summaries = result.groups.map(group => {
    let supported = 0, uncertain = 0;
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      if (pair(group[i].id, group[j].id).state === 'supported') supported++; else uncertain++;
    }
    return group.length === 1 ? 'Single photo' : uncertain
      ? `Provisional: ${uncertain} uncertain pair${uncertain === 1 ? '' : 's'}, ${supported} supported`
      : `Supported by these experimental rules: all ${supported} pairs`;
  });
  return { ...result, summaries, pairs, pair };
}
