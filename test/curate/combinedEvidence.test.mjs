import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPair, combinedPartition, COMBINED_DEFAULTS } from '../../public/curate/combined-evidence.js';
import { evidencePartition } from '../../public/curate/evidence-partition.js';
import { rankObservation } from '../../public/curate/rank-evidence.js';
const photo = (id, byte, category = 'one', recognizedIds = null) => ({ id, time: 1, peopleCategory: category, recognizedIds,
  thumbhash: byte === null ? null : Buffer.alloc(21, byte).toString('base64') });
const settings = { ...COMBINED_DEFAULTS, gapMs: 15000, spanMs: 180000, thumbhash: true, people: true,
  identities: true, ranks: true };
function rowsFor(ids, start = 1) {
  return new Map(ids.map(id => [id, { state: 'complete', photos: [{ id, rank: null }, ...ids.filter(other => other !== id).map((other, i) => ({ id: other, rank: start + i }))] }]));
}
const memberships = result => result.groups.map(g => g.map(p => p.id));

function mixedBackdrop() {
  const photos = [photo('a', 0, 'one', ['person']), photo('b', 0, 'one', ['person']), photo('c', 0, 'one', ['person']),
    photo('d', 0, 'couple', ['person', 'partner']), photo('e', 0, 'couple', ['person', 'partner']), photo('f', 200, 'one', ['person'])];
  const rows = new Map(photos.map(a => {
    const same = photos.filter(b => b.id !== a.id && b.peopleCategory === a.peopleCategory);
    const other = photos.filter(b => b.peopleCategory !== a.peopleCategory);
    return [a.id, { state: 'complete', photos: [{ id: a.id, rank: null },
      ...same.map((b, i) => ({ id: b.id, rank: i + 1 })), ...other.map((b, i) => ({ id: b.id, rank: 14 + i }))] }];
  }));
  return { photos, rows };
}

test('reciprocal ranks and people agreement recover a coarse-hash difference; rank alone remains uncertain', () => {
  const a = photo('a', 0), b = photo('b', 255), rows = rowsFor(['a', 'b']);
  assert.equal(assessPair(a, b, settings, rows).state, 'supported');
  assert.equal(assessPair(a, b, settings, new Map([['a', rows.get('a')]])).state, 'uncertain');
  assert.equal(assessPair(a, b, settings, rowsFor(['a', 'b'], 11)).state, 'uncertain');
  assert.equal(assessPair(a, b, { ...settings, people: false }, rows).state, 'uncertain');
  assert.deepEqual(memberships(combinedPartition([b, a], settings, rows)), [['a', 'b']]);
});

test('a shared backdrop separates by corroborated counts, retaining the backlit solo with its supported alternatives', () => {
  const { photos, rows } = mixedBackdrop(), before = JSON.stringify([photos, [...rows]]);
  const result = combinedPartition(photos, settings, rows);
  assert.deepEqual(memberships(result), [['a', 'b', 'c', 'f'], ['d', 'e']]);
  assert.equal(result.pair('a', 'd').state, 'separate');
  assert.match(result.pair('a', 'd').reason, /corroborated by recognition counts/);
  assert.equal(result.pair('a', 'f').state, 'supported');
  assert.deepEqual(memberships(combinedPartition([...photos].reverse(), settings, rows)), memberships(result));
  assert.equal(JSON.stringify([photos, [...rows]]), before);
});

test('returned reciprocal contrast can corroborate category conflict even with a very close hash and no recognition', () => {
  const { photos, rows } = mixedBackdrop();
  for (const p of photos) p.recognizedIds = null;
  const result = combinedPartition(photos, settings, rows);
  assert.deepEqual(memberships(result), [['a', 'b', 'c', 'f'], ['d', 'e']]);
  assert.match(result.pair('a', 'd').reason, /Returned rank contrast/);
  assert.match(result.pair('a', 'd').notes.join(' '), /#14, 10 outside ahead/);
  const noRanks = combinedPartition(photos, { ...settings, ranks: false }, rows);
  assert.equal(noRanks.pair('a', 'd').state, 'uncertain');
});

test('absence, asymmetry and low ranks without a supported reference alternative never manufacture contrast', () => {
  const { photos, rows } = mixedBackdrop();
  const a = photos[0], d = photos[3]; a.recognizedIds = d.recognizedIds = null;
  rows.get(a.id).photos.find(p => p.id === d.id).rank = null;
  assert.equal(assessPair(a, d, settings, rows, photos).state, 'uncertain');
  rows.get(a.id).photos.find(p => p.id === d.id).rank = 14;
  rows.delete(d.id);
  assert.equal(assessPair(a, d, settings, rows, photos).state, 'uncertain');
  const distant = rowsFor(['a', 'd'], 20);
  assert.equal(assessPair(a, d, settings, distant).state, 'uncertain');
  assert.equal(assessPair(a, d, settings, new Map([['a', { state: 'failed' }]])).state, 'uncertain');
});

test('outside-photo counts remove burst-size inflation, preserve raw ranks, and leave missing targets unknown', () => {
  const photos = Array.from({ length: 14 }, (_, i) => photo(`p${String(i).padStart(2, '0')}`, null));
  const rows = rowsFor(photos.map(p => p.id));
  const result = combinedPartition(photos, settings, rows);
  assert.equal(result.groups.length, 1); assert.match(result.summaries[0], /all 91 pairs/);
  assert.deepEqual(rankObservation(rows.get('p00'), 'p13'), { rank: 13, outsideAhead: 0 });
  const row = { state: 'complete', photos: [{ id: 'a', rank: null }, { id: 'b', rank: 2 }, { id: 'c', rank: 7 }, { id: 'd', rank: null }] };
  assert.deepEqual(rankObservation(row, 'c'), { rank: 7, outsideAhead: 5 });
  assert.equal(rankObservation(row, 'd'), null);
  assert.equal(rankObservation({ ...row, state: 'failed' }, 'c'), null);
  // Candidate adjustment is not proof that all excluded members are siblings.
  const alone = combinedPartition(photos, { ...settings, people: false }, rows);
  assert.match(alone.summaries[0], /91 uncertain/);
});

test('supported links take precedence over uncertain attachments without bridging a separated pair', () => {
  const photos = ['a', 'b', 'c'].map(id => photo(id, null));
  const states = { ab: 'uncertain', bc: 'supported', ac: 'separate' };
  const pair = (a, b) => ({ state: states[[a.id, b.id].sort().join('')] });
  for (const input of [photos, [...photos].reverse(), [photos[1], photos[0], photos[2]]]) {
    assert.deepEqual(memberships(evidencePartition(input, settings, pair)), [['a'], ['b', 'c']]);
  }
  states.ab = 'supported';
  const result = evidencePartition(photos, settings, pair);
  assert.deepEqual(memberships(result), [['a', 'b'], ['c']], 'equal supported links use stable time/ID ties');
  assert.notEqual(result.byPhoto.get('a'), result.byPhoto.get('c'));
});

test('three hash bands remove the old 0.100 support/separation cliff; middle-band evidence needs corroboration', () => {
  const a = photo('a', 0, null);
  assert.equal(assessPair(a, photo('b', 6, null), settings).state, 'supported');
  assert.equal(assessPair(a, photo('b', 7, null), settings).state, 'uncertain');
  for (const byte of [25, 26]) {
    assert.equal(assessPair(photo('a', 0), photo('b', byte, 'couple'), settings).state, 'uncertain');
    assert.equal(assessPair(photo('a', 0), photo('b', byte), settings).state, 'supported');
  }
  assert.equal(assessPair(photo('a', 0), photo('b', 100, 'couple'), settings).state, 'separate');
});

test('count corroboration respects missing/contradictory observations, group lower bound and disabled controls', () => {
  const one = photo('a', 0, 'one', ['person']);
  for (const ids of [null, [], ['person']]) assert.equal(assessPair(one, photo('b', 0, 'couple', ids), settings).state, 'uncertain');
  assert.equal(assessPair(one, photo('b', 0, 'group', ['x', 'y', 'z']), settings).state, 'separate');
  assert.equal(assessPair(one, photo('b', 0, 'group', ['x', 'y']), settings).state, 'uncertain');
  const couple = photo('b', 0, 'couple', ['person', 'partner']);
  assert.equal(assessPair(one, couple, { ...settings, identities: false }).state, 'uncertain');
  assert.equal(assessPair(one, couple, settings, rowsFor(['a', 'b'])).state, 'uncertain', 'reciprocal rank support contradicts the count-based separation');
});

test('time bounds, unknown dates and maximum size still constrain supported-first grouping', () => {
  const photos = ['a', 'b', 'c'].map((id, i) => ({ ...photo(id, 0), time: i * 10000 }));
  const result = combinedPartition(photos, { ...settings, spanMs: 15000 });
  assert.deepEqual(memberships(result), [['a', 'b'], ['c']]);
  photos[2].time = null;
  assert.deepEqual(memberships(combinedPartition(photos, settings)), [['a', 'b'], ['c']]);
  assert.throws(() => combinedPartition(Array(251).fill(photos[0]), settings), /at most 250/);
  assert.throws(() => combinedPartition(photos, { ...settings, nearHash: .2, farHash: .1 }), /ordered ThumbHash/);
  assert.throws(() => combinedPartition(photos, { ...settings, rankContrast: 0 }), /contrast limits/);
  assert.throws(() => combinedPartition(photos, { ...settings, gapMs: -1 }), /time limits/);
});

test('all-unknown and partially assessed input preserves every photo and labels every uncertain internal pair', () => {
  const photos = Array.from({ length: 40 }, (_, i) => photo(String(i), null, null));
  const result = combinedPartition(photos, settings, new Map([['0', { state: 'failed' }]]));
  assert.equal(result.groups.length, 1); assert.equal(result.groups[0].length, 40);
  assert.match(result.summaries[0], /780 uncertain/);
});
