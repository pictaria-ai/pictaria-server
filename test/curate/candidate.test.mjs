import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateGroups, CANDIDATE_METHOD } from '../../src/curate/candidate.mjs';
const hash = n => Buffer.alloc(21, n).toString('base64');
const people = ids => JSON.stringify({ ids, omitted: false });
const photo = (id, overrides = {}) => ({ id, time: Number(id) * 1000 || 1000,
  availability: 'observed', materialKey: id, ...overrides });
const partition = result => result.groups.map(g => [...g.ids].sort()).sort((a, b) => a[0].localeCompare(b[0]));
function ranked(rows, matrix, options = {}) {
  const scope = candidateGroups(rows, options).scopes[0];
  return candidateGroups(rows, { ...options, ranks: { [scope.id]: { rows: Object.fromEntries(
    rows.map((p, i) => [p.id, Object.fromEntries(rows.flatMap((q, j) =>
      matrix[i][j] === null ? [] : [[q.id, matrix[i][j]]]))]) ) } } });
}

test('owner-confirmed landscape: strong core retains an asymmetric fifth photo', () => {
  const rows = [1, 2, 3, 4, 5].map(n => photo(String(n), { thumbhash: hash(n * 40), peopleCategory: 'none' }));
  // Outside-candidate counts derived from the owner's anonymized raw-rank table.
  const matrix = [[null,0,1,0,0], [0,null,0,0,0], [6,1,null,19,6], [0,0,1,null,0], [0,2,2,0,null]];
  assert.deepEqual(partition(ranked(rows, matrix)), [['1','2','3','4','5']]);
  assert.match(ranked(rows, matrix).groups[0].reasons.join(' '), /established core/);
  assert.ok(candidateGroups(rows).groups.length > 1, 'far descriptors cannot establish this composition alone');
});

test('no chain bridge, and conflicting people cannot be hidden behind a similar background', () => {
  const rows = [photo('1', { thumbhash: hash(0) }), photo('2', { thumbhash: hash(20) }), photo('3', { thumbhash: hash(40) })];
  assert.deepEqual(partition(candidateGroups(rows)), [['1','2'], ['3']]);
  const changed = rows.slice(0, 2).map((p, i) => ({ ...p, peopleCategory: i ? 'couple' : 'one' }));
  assert.deepEqual(partition(candidateGroups(changed)), [['1'], ['2']]);
  assert.deepEqual(partition(ranked(changed, [[null,0],[0,null]])), [['1'], ['2']], 'conflicting strong evidence stays uncertain');
});

test('equal people counts are not a match; group is not an exact count; recognition misses can be rescued', () => {
  const rows = [photo('1', { thumbhash: hash(0), peopleCategory: 'one', recognition: people(['a']) }),
    photo('2', { thumbhash: hash(1), peopleCategory: 'one', recognition: people(['b']) })];
  assert.deepEqual(partition(candidateGroups(rows)), [['1'], ['2']]);
  rows[1].recognition = people([]);
  assert.deepEqual(partition(candidateGroups(rows)), [['1','2']], 'empty observation does not prove a different person');
  rows[1].recognition = people(['a','b']); rows[1].peopleCategory = 'group';
  assert.deepEqual(partition(candidateGroups(rows)), [['1'], ['2']], 'uncorroborated identity change needs independent support');
  assert.deepEqual(partition(ranked(rows, [[null,0],[0,null]])), [['1','2']]);
  rows.forEach(p => { p.thumbhash = hash(p.id === '1' ? 0 : 255); p.recognition = null; });
  assert.equal(candidateGroups(rows).groups.length, 2);
});

test('all human partitions win, including a prohibited pair inside core recovery', () => {
  const rows = [1,2,3,4,5].map(n => photo(String(n)));
  const opts = { separations: [{ id: 'human', partitions: [['3'], ['4']] }] };
  const matrix = [[null,0,1,0,0], [0,null,0,0,0], [6,1,null,19,6], [0,0,1,null,0], [0,2,2,0,null]];
  const result = ranked(rows, matrix, opts);
  assert.ok(!result.groups.some(g => g.ids.includes('3') && g.ids.includes('4')));
  assert.deepEqual(result.groups.flatMap(g => g.ids).sort(), ['1','2','3','4','5']);
});

test('bounded time-only fallback is honest; missing timestamps and stacking off remain singles', () => {
  const rows = [photo('1'), photo('2', { time: 62000 }), photo('3', { time: 180001 }), photo('4', { time: null })];
  const result = candidateGroups(rows);
  assert.deepEqual(partition(result), [['1','2'], ['3'], ['4']]);
  assert.equal(result.groups[0].route, 'candidate-unconfirmed');
  assert.equal(candidateGroups(rows, { stacks: false }).groups.length, 4);
  assert.equal(result.method, CANDIDATE_METHOD);
});

test('known compatible exact renditions still respect time and human bounds', () => {
  const rows = [photo('1', { checksum: 'same', renditionKey: 'same' }), photo('2', { checksum: 'same', renditionKey: 'same' })];
  const result = candidateGroups(rows); assert.deepEqual(partition(result), [['1','2']]);
  assert.equal(result.scopes[0].needsRanks, false);
  rows[1].time = 500000;
  assert.equal(candidateGroups(rows).groups.length, 2);
});

test('successful empty or absent search results are unknown, not a separation', () => {
  const rows = [photo('1'), photo('2')];
  assert.deepEqual(partition(ranked(rows, [[null,null],[null,null]])), [['1','2']]);
  rows[0].thumbhash = hash(12); rows[1].thumbhash = hash(13);
  assert.deepEqual(partition(ranked(rows, [[null,null],[null,null]])), [['1','2']]);
});

test('oversized cohort is retained without sampling and respects human separations', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => photo(String(i), { time: i * 100 }));
  const result = candidateGroups(rows, { separations: [{ id: 'h', partitions: [['1'], ['999']] }] });
  assert.equal(result.groups.flatMap(g => g.ids).length, 1000);
  assert.equal(result.scopes.length, 0);
  assert.ok(result.groups.every(g => g.route === 'manual-budget'));
  assert.ok(!result.groups.some(g => g.ids.includes('1') && g.ids.includes('999')));
});

test('candidate evidence has deterministic ordering and changing material invalidates the entire scope', () => {
  const rows = [photo('2'), photo('1')];
  assert.deepEqual(candidateGroups(rows), candidateGroups([...rows].reverse()));
  const id = candidateGroups(rows).scopes[0].id;
  rows[0].materialKey = 'changed';
  assert.notEqual(candidateGroups(rows).scopes[0].id, id);
});
