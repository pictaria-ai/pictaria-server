import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPair, combinedPartition } from '../../public/curate/combined-evidence.js';
const photo = (id, byte, category = 'one') => ({ id, time: 1, peopleCategory: category, recognizedIds: null,
  thumbhash: byte === null ? null : Buffer.alloc(21, byte).toString('base64') });
const settings = { gapMs: 15000, spanMs: 180000, thumbhash: true, threshold: .1, people: true,
  identities: true, ranks: true, rankLimit: 10 };
const rowsFor = (ids, rank = 1) => new Map(ids.map(id => [id, { state: 'complete', photos: ids.map(other => ({ id: other, rank: other === id ? null : rank })) }]));

test('combined evidence recovers coarse-hash differences using reciprocal ranks and supported people agreement', () => {
  const a = photo('a', 0), b = photo('b', 255), rows = rowsFor(['a', 'b']);
  assert.equal(assessPair(a, b, settings, rows).state, 'supported');
  assert.equal(assessPair(a, b, settings, new Map([['a', rows.get('a')]])).state, 'uncertain');
  assert.equal(assessPair(a, b, settings, rowsFor(['a', 'b'], 11)).state, 'uncertain');
  assert.equal(assessPair(a, b, { ...settings, people: false }, rows).state, 'uncertain', 'rank alone is not support');
  assert.equal(combinedPartition([b, a], settings, rows).groups.length, 1);
});

test('people conflict plus close visual evidence stays provisional; corroborated difference separates', () => {
  const a = photo('a', 0), b = photo('b', 0, 'couple');
  assert.equal(assessPair(a, b, settings, new Map()).state, 'uncertain');
  assert.match(combinedPartition([a, b], settings).summaries[0], /Provisional: 1 uncertain/);
  b.thumbhash = photo('b', 255).thumbhash;
  assert.equal(assessPair(a, b, settings, new Map()).state, 'separate');
  assert.equal(assessPair(a, b, settings, rowsFor(['a', 'b'])).state, 'uncertain', 'conflicting near ranks withhold separation');
  assert.equal(combinedPartition([a, b], settings).groups.length, 2);
});

test('missing, failed and not-returned ranks never separate a pair or manufacture support', () => {
  const a = photo('a', null, null), b = photo('b', null, null);
  for (const rows of [new Map(), new Map([['a', { state: 'failed' }]]), rowsFor(['a', 'b'], null)]) {
    const result = combinedPartition([a, b], settings, rows);
    assert.equal(result.groups.length, 1); assert.match(result.summaries[0], /1 uncertain/);
  }
});

test('whole-group conflicts cannot be bridged; partitions are exhaustive, stable and respect time bounds', () => {
  const a = photo('a', 0, 'one'), b = photo('b', 20, null), c = photo('c', 40, 'couple');
  const before = JSON.stringify([a, b, c]);
  const result = combinedPartition([c, a, b], settings);
  assert.deepEqual(result.groups.map(g => g.map(p => p.id)), [['a', 'b'], ['c']]);
  assert.deepEqual(combinedPartition([b, c, a], settings).groups, result.groups);
  assert.equal(JSON.stringify([a, b, c]), before);
  assert.match(result.summaries[0], /all 1 pairs/);
  c.time = 999999;
  assert.equal(combinedPartition([a, c], { ...settings, thumbhash: false, people: false }).groups.length, 2);
});

test('identity-only observations may support conflict but absence never means different people', () => {
  const a = photo('a', 0, null), b = photo('b', 255, null);
  a.recognizedIds = ['person-1'];
  assert.equal(assessPair(a, b, settings, new Map()).state, 'uncertain');
  b.recognizedIds = ['person-2'];
  assert.equal(assessPair(a, b, settings, new Map()).state, 'separate');
  assert.equal(assessPair(a, b, { ...settings, identities: false }, new Map()).state, 'uncertain');
});
