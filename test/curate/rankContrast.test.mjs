import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateGroups } from '../../src/curate/candidate.mjs';
import { observedRanks, retainedEvidence } from './fixtures/rankContrast.mjs';

const hash = n => Buffer.alloc(21, n).toString('base64');
const photo = (id, overrides = {}) => ({ id, time: Number(id) * 1000,
  materialKey: id, availability: 'observed', thumbhash: hash(0), ...overrides });
const partition = result => result.groups.map(g => [...g.ids].sort()).sort((a, b) => a[0].localeCompare(b[0]));
function evaluate(photos, evidence, options = {}) {
  const scope = candidateGroups(photos, options).scopes[0];
  return candidateGroups(photos, { ...options, ranks: { [scope.id]: evidence } });
}
// The middle trio's people facts are synthetic; the private source records
// were not inspected. Model the already-separated third composition explicitly.
const nine = () => Array.from({ length: 9 }, (_, i) => photo(String(i + 1), {
  peopleCategory: i < 3 ? 'group' : i < 6 ? 'one' : 'couple',
}));
const blocks = [['1','2','3'], ['4','5','6'], ['7','8','9']];

test('owner table: keep the incomplete pass stable; completed contrasts split despite identical hashes', () => {
  const photos = nine(), ids = photos.map(p => p.id);
  const initial = candidateGroups(photos);
  assert.deepEqual(partition(initial), [['1','2','3','7','8','9'], ['4','5','6']]);
  assert.deepEqual(initial.scopes[0].referenceIds, ['1','2','3','7','8','9']);
  const partial = retainedEvidence(observedRanks, ids);
  assert.deepEqual(partition(evaluate(photos, partial)), partition(initial), 'row 9 was not observed');
  assert.equal(evaluate(photos, partial).scopes[0].needsRanks, true);

  // Hypothetical completion A: photo 9 also ranks its couple peers first.
  const full = retainedEvidence([...observedRanks.slice(0, 8), [null,null,null,null,null,null,1,2,null]], ids);
  const result = evaluate(photos, full);
  assert.deepEqual(partition(result), blocks);
  assert.match(result.groups[0].reasons.join(' '), /contrast outweighs ThumbHash/);
  assert.deepEqual(evaluate([...photos].reverse(), full), result);

  // Hypothetical completion B: successful but empty row 9. The two other
  // couple searches positively locate it; its empty row supplies no vote.
  const empty = structuredClone(partial);
  empty.rows['9'] = {}; empty.coverage['9'] = { returned: 0, limit: 50, outside: 0 };
  assert.deepEqual(partition(evaluate(photos, empty)), blocks);

  // Distant descriptors also must not allow the provisional-unknown join to
  // erase the repeated subgroup contrast. No special category split is needed.
  photos.forEach((p, i) => { p.thumbhash = hash(i * 28); });
  assert.deepEqual(partition(evaluate(photos, full)), blocks);
});

function twoPairs() {
  const photos = [1,2,3,4].map(n => photo(String(n), { peopleCategory: 'none' }));
  const evidence = { rows: { '1': { '2': 0 }, '2': { '1': 0 }, '3': { '4': 0 }, '4': { '3': 0 } },
    coverage: Object.fromEntries(photos.map(p => [p.id, { returned: 50, limit: 50, outside: 49 }])) };
  return { photos, evidence };
}

test('landscape-only hash matches get verification, but exact renditions and small local groups skip it', () => {
  const { photos, evidence } = twoPairs();
  assert.deepEqual(candidateGroups(photos).scopes[0].referenceIds, ['1','2','3','4']);
  assert.deepEqual(partition(evaluate(photos, evidence)), [['1','2'], ['3','4']]);
  assert.deepEqual(candidateGroups(photos.slice(0, 3)).scopes[0].referenceIds, []);
  photos.forEach(p => { p.checksum = 'same'; p.renditionKey = 'same'; });
  assert.deepEqual(candidateGroups(photos).scopes[0].referenceIds, []);
  assert.deepEqual(partition(evaluate(photos, evidence)), [['1','2','3','4']], 'rank contrast cannot override exact renditions');
});

test('unreturned targets require full coverage, multiple witnesses and positive subgroup evidence', () => {
  const { photos, evidence } = twoPairs();
  const together = [['1','2','3','4']];
  const check = change => { const e = structuredClone(evidence); change(e); assert.deepEqual(partition(evaluate(photos, e)), together); };
  check(e => { delete e.coverage; });
  check(e => { for (const row of Object.values(e.coverage)) row.returned = 10; });
  check(e => { e.coverage['1'].outside = 3; });
  check(e => { e.rows['2'] = {}; e.coverage['2'].returned = 0; });
  check(e => { e.rows['3'] = {}; e.rows['4'] = {}; });
  check(e => { delete e.rows['4']; });
  check(e => { for (const id of Object.keys(e.rows)) e.rows[id] = {}; });
  check(e => { e.rows['1']['3'] = 0; }); // one strong cross-direction vetoes contrast
});

test('repeated returned far ranks can override hash support without inventing absence evidence', () => {
  const { photos, evidence } = twoPairs();
  delete evidence.coverage;
  for (const p of photos) for (const q of photos) if ((Number(p.id) <= 2) !== (Number(q.id) <= 2)) evidence.rows[p.id][q.id] = 12;
  assert.deepEqual(partition(evaluate(photos, evidence)), [['1','2'], ['3','4']]);
  evidence.rows['1']['3'] = 8;
  assert.deepEqual(partition(evaluate(photos, evidence)), [['1','2','3','4']], 'one weak or moderate relationship is not enough');
});

test('an unindexed or ambiguous singleton cannot be used to merge separated subgroups', () => {
  const { photos, evidence } = twoPairs();
  photos.push(photo('5'));
  evidence.rows['5'] = {}; evidence.coverage['5'] = { returned: 0, limit: 50, outside: 0 };
  const result = evaluate(photos, evidence);
  assert.equal(result.groups.length, 2);
  assert.ok(!result.groups.some(g => g.ids.includes('1') && g.ids.includes('3')));
  assert.deepEqual(result.groups.flatMap(g => g.ids).sort(), ['1','2','3','4','5']);
});

test('human separations remain stronger than repeated search support', () => {
  const { photos, evidence } = twoPairs();
  const result = evaluate(photos, evidence, { separations: [{ id: 'manual', partitions: [['1'], ['2']] }] });
  assert.ok(!result.groups.some(g => g.ids.includes('1') && g.ids.includes('2')));
});
