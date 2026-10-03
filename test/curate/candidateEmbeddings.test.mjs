import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateGroups, CANDIDATE_METHOD, EMBEDDING_CANDIDATE_METHOD } from '../../src/curate/candidate.mjs';
import { selectStackReferee } from '../../src/curate/ai-policy.mjs';

// candidate-4 (PIC-392): Pictaria image embeddings as stacking evidence.
const hash = n => Buffer.alloc(21, n).toString('base64');
const people = ids => JSON.stringify({ ids, omitted: false });
const photo = (id, overrides = {}) => ({ id, time: Number(id) * 1000, availability: 'observed', materialKey: id, ...overrides });
const partition = result => result.groups.map(g => [...g.ids].sort()).sort((a, b) => a[0].localeCompare(b[0]));
const reasons = result => result.groups.flatMap(g => g.reasons).join(' ');
// Stands in for embedding-evidence.mjs with a fixed similarity table.
function embeddings(table, { key = 'policy' } = {}) {
  const value = new Map(Object.entries(table).flatMap(([pair, s]) => {
    const [a, b] = pair.split('-');
    return [[`${a}|${b}`, s], [`${b}|${a}`, s]];
  }));
  return { key, near: 0.9, far: 0.75, average: 0.8, prepare() {}, loadKeys() {},
    signature: ids => `${key}:${ids.join(',')}`, similarity: (a, b) => value.get(`${a}|${b}`) ?? null };
}
const allRanks = (rows, outside) => Object.fromEntries(rows.map(p => [p.id,
  Object.fromEntries(rows.filter(q => q !== p).map(q => [q.id, outside]))]));

test('very similar embeddings stack photos with no Immich search', () => {
  const rows = ['1', '2', '3'].map(id => photo(id));
  const result = candidateGroups(rows, { embeddings: embeddings({ '1-2': 0.95, '1-3': 0.93, '2-3': 0.92 }) });
  assert.equal(result.method, EMBEDDING_CANDIDATE_METHOD);
  assert.deepEqual(partition(result), [['1', '2', '3']]);
  assert.equal(result.groups[0].route, 'candidate-supported');
  assert.deepEqual(result.scopes[0].referenceIds, []);
  assert.equal(result.scopes[0].needsRanks, false);
  assert.match(reasons(result), /\bembedding-near\b/);
  const before = candidateGroups(rows);
  assert.equal(before.method, CANDIDATE_METHOD);
  assert.equal(before.groups[0].route, 'candidate-unconfirmed', 'candidate-3 waits for searches');
  assert.equal(before.scopes[0].needsRanks, true);
});

test('clearly different embeddings separate photos, unless the same people or a very close ThumbHash say otherwise', () => {
  // ThumbHash 20/255 apart: close enough for candidate-3 support, not very close.
  const close = [photo('1', { thumbhash: hash(0) }), photo('2', { thumbhash: hash(20) })];
  const separated = candidateGroups(close, { embeddings: embeddings({ '1-2': 0.6 }) });
  assert.deepEqual(partition(separated), [['1'], ['2']]);
  assert.deepEqual(separated.scopes[0].referenceIds, [], 'never searched');
  assert.match(reasons(separated), /\bembedding-apart\b/);
  assert.deepEqual(partition(candidateGroups(close)), [['1', '2']], 'candidate-3 groups them on the ThumbHash');

  const veryClose = [photo('1', { thumbhash: hash(0) }), photo('2', { thumbhash: hash(3) })];
  assert.deepEqual(partition(candidateGroups(veryClose, { embeddings: embeddings({ '1-2': 0.6 }) })), [['1', '2']]);

  const samePeople = [photo('1', { recognition: people(['a']) }), photo('2', { recognition: people(['a']) })];
  const kept = candidateGroups(samePeople, { embeddings: embeddings({ '1-2': 0.6 }) });
  assert.deepEqual(partition(kept), [['1', '2']]);
  assert.equal(kept.groups[0].route, 'candidate-unconfirmed', 'neither separated nor supported: uncertain');
  assert.match(reasons(kept), /\bembedding-undecided\b/);
  assert.doesNotMatch(reasons(kept), /\bprovisional\b/, 'the embedding reason already names what is unsettled');
});

test('middle-band embeddings need the same people or a similar ThumbHash; search ranks never decide them', () => {
  const emb = embeddings({ '1-2': 0.85 });
  const ones = [photo('1', { peopleCategory: 'one' }), photo('2', { peopleCategory: 'one' })];
  const corroborated = candidateGroups(ones, { embeddings: emb });
  assert.equal(corroborated.groups[0].route, 'candidate-supported');
  assert.match(reasons(corroborated), /\bembedding-corroborated\b/);

  const scenery = ones.map(p => ({ ...p, peopleCategory: 'none' }));
  const uncertain = candidateGroups(scenery, { embeddings: emb });
  assert.equal(uncertain.groups[0].route, 'candidate-unconfirmed', 'no people does not tell us two scenes match');
  assert.deepEqual(uncertain.scopes[0].referenceIds, []);
  const scope = uncertain.scopes[0].id;
  for (const outside of [0, 20]) {
    const ranked = candidateGroups(scenery, { embeddings: emb, ranks: { [scope]: { rows: allRanks(scenery, outside) } } });
    assert.equal(ranked.groups[0].route, 'candidate-unconfirmed', `ranks ${outside} outside do not decide an embedded pair`);
  }

  // 33/255 ≈ 0.13: above candidate-3's 0.10 support, within the 0.15 band.
  const hashed = [photo('1', { thumbhash: hash(0) }), photo('2', { thumbhash: hash(33) })];
  assert.equal(candidateGroups(hashed, { embeddings: emb }).groups[0].route, 'candidate-supported');
  // Different recognized people without corroborating counts: no corroboration.
  const unsure = hashed.map((p, i) => ({ ...p, recognition: people([i ? 'b' : 'a']) }));
  assert.equal(candidateGroups(unsure, { embeddings: emb }).groups[0].route, 'candidate-unconfirmed');
});

test('groups join on their average similarity; a clearly different pair blocks the join', () => {
  const rows = ['1', '2', '3', '4'].map(id => photo(id));
  const halves = { '1-2': 0.95, '3-4': 0.94, '1-3': 0.84, '1-4': 0.82, '2-3': 0.86, '2-4': 0.83 };
  const joined = candidateGroups(rows, { embeddings: embeddings(halves) });
  assert.deepEqual(partition(joined), [['1', '2', '3', '4']]);
  assert.equal(joined.groups[0].route, 'candidate-supported');
  assert.match(reasons(joined), /\bembedding-average\b/);
  assert.doesNotMatch(reasons(joined), /\bembedding-undecided\b/);
  const blocked = candidateGroups(rows, { embeddings: embeddings({ ...halves, '2-4': 0.7 }) });
  assert.deepEqual(partition(blocked), [['1', '2'], ['3', '4']]);

  // A single photo joins a group on its average; two single photos do not join on one pair.
  const single = candidateGroups(rows.slice(0, 3), { embeddings: embeddings({ '1-2': 0.95, '1-3': 0.84, '2-3': 0.8 }) });
  assert.deepEqual(partition(single), [['1', '2', '3']]);
  const pair = candidateGroups(rows.slice(0, 2), { embeddings: embeddings({ '1-2': 0.85 }) });
  assert.equal(pair.groups[0].route, 'candidate-unconfirmed');
  // The closer of two groups wins.
  const two = ['1', '2', '3', '4', '5'].map(id => photo(id));
  const closest = candidateGroups(two, { embeddings: embeddings({ '1-2': 0.95, '4-5': 0.95, '1-4': 0.6, '1-5': 0.6, '2-4': 0.6, '2-5': 0.6,
    '3-1': 0.82, '3-2': 0.82, '3-4': 0.88, '3-5': 0.86 }) });
  assert.deepEqual(partition(closest), [['1', '2'], ['3', '4', '5']]);
});

test('people conflicts and saved separations still outweigh very similar embeddings', () => {
  const emb = embeddings({ '1-2': 0.97 });
  const categories = [photo('1', { peopleCategory: 'one' }), photo('2', { peopleCategory: 'none' })];
  assert.deepEqual(partition(candidateGroups(categories, { embeddings: emb })), [['1'], ['2']]);
  const rows = [photo('1'), photo('2')];
  const separations = [{ id: 's', partitions: [['1'], ['2']] }];
  assert.deepEqual(partition(candidateGroups(rows, { embeddings: emb, separations })), [['1'], ['2']]);
});

test('photos without an embedding keep candidate-3 evidence and searches', () => {
  const rows = ['1', '2', '3'].map(id => photo(id));
  const emb = embeddings({ '1-2': 0.95 });
  const waiting = candidateGroups(rows, { embeddings: emb });
  assert.deepEqual(waiting.scopes[0].referenceIds, ['1', '2', '3']);
  assert.equal(waiting.scopes[0].needsRanks, true);
  assert.equal(waiting.groups[0].route, 'candidate-unconfirmed');
  const scope = waiting.scopes[0].id;
  const ranked = candidateGroups(rows, { embeddings: emb, ranks: { [scope]: { rows: allRanks(rows, 0) } } });
  assert.deepEqual(partition(ranked), [['1', '2', '3']]);
  assert.equal(ranked.groups[0].route, 'candidate-supported');
  assert.match(reasons(ranked), /(^| )ranks( |$)/);
});

test('with mixed coverage, ranks of embedded pairs never settle them through rank recovery', () => {
  // Photo 2 has no vector; 3 is in the middle band with 0 and 1 and nothing corroborates it.
  const rows = ['0', '1', '2', '3'].map(id => photo(id));
  const emb = embeddings({ '0-1': 0.95, '0-3': 0.78, '1-3': 0.78 });
  const scope = candidateGroups(rows, { embeddings: emb }).scopes[0];
  assert.deepEqual(scope.referenceIds, ['0', '1', '2', '3'], 'photo 2 and its neighbors are searched');
  const outcome = embeddedRanks => {
    const matrix = allRanks(rows, 0);
    for (const [a, b] of [['0', '3'], ['1', '3']]) { matrix[a][b] = embeddedRanks; matrix[b][a] = embeddedRanks; }
    const result = candidateGroups(rows, { embeddings: emb, ranks: { [scope.id]: { rows: matrix } } });
    const group = result.groups.find(g => g.ids.includes('3'));
    const selection = selectStackReferee({ curateBurstGrouping: true, curateStackRefereeEnabled: true },
      { memberCount: group.ids.length, pending: true, deterministicSettled: true, route: group.route }, { stack: true, keeper: false });
    return { ids: [...group.ids].sort(), route: group.route, selection: selection.reason };
  };
  const far = outcome(20), near = outcome(0);
  assert.deepEqual(far, { ids: ['0', '1', '2', '3'], route: 'candidate-unconfirmed', selection: 'uncertain-composition' });
  assert.deepEqual(near, far, 'only the embedded pairs\' ranks changed');
});

test('two photos recovered by ranks keep an unresolved embedding relation between them uncertain', () => {
  // 0-2 have no vectors and form a reciprocal-near core; 3 and 4 have vectors at 0.78.
  const rows = ['0', '1', '2', '3', '4'].map(id => photo(id));
  const emb = embeddings({ '3-4': 0.78 });
  const scope = candidateGroups(rows, { embeddings: emb }).scopes[0];
  const matrix = allRanks(rows, 0);
  for (const added of ['3', '4']) Object.assign(matrix[added], { 0: 0, 1: 6, 2: 20 });
  const result = candidateGroups(rows, { embeddings: emb, ranks: { [scope.id]: { rows: matrix } } });
  assert.deepEqual(partition(result), [['0', '1', '2', '3', '4']]);
  const [group] = result.groups;
  assert.match(group.reasons.join(' '), /\brank-recovered\b/);
  assert.equal(group.route, 'candidate-unconfirmed');
  assert.match(group.reasons.join(' '), /\bembedding-undecided\b/);
  assert.equal(selectStackReferee({ curateBurstGrouping: true, curateStackRefereeEnabled: true },
    { memberCount: 5, pending: true, deterministicSettled: true, route: group.route }, { stack: true, keeper: false }).reason,
  'uncertain-composition');
  // Settled by embeddings instead, the same recovery is supported.
  const settled = candidateGroups(rows, { embeddings: embeddings({ '3-4': 0.95 }), ranks: { [scope.id]: { rows: matrix } } });
  assert.equal(settled.groups[0].route, 'candidate-supported');
});

test('without embeddings the result is exactly candidate-3; the policy keys the scope', () => {
  const rows = [photo('1', { thumbhash: hash(0) }), photo('2', { thumbhash: hash(20) }), photo('3', { thumbhash: hash(200) })];
  const plain = candidateGroups(rows);
  assert.deepEqual(candidateGroups(rows, { embeddings: null }), plain);
  const scope = plain.scopes[0].id;
  const ranks = { [scope]: { rows: allRanks(rows, 1) } };
  assert.deepEqual(candidateGroups(rows, { ranks, embeddings: null }), candidateGroups(rows, { ranks }));
  assert.equal(plain.scopes[0].embeddingKey, undefined);
  assert.ok(plain.groups.every(g => !g.id.includes(EMBEDDING_CANDIDATE_METHOD)));

  const first = candidateGroups(rows, { embeddings: embeddings({}, { key: 'a' }) });
  const second = candidateGroups(rows, { embeddings: embeddings({}, { key: 'b' }) });
  assert.notEqual(first.scopes[0].id, scope, 'embedded scopes keep their own search evidence');
  assert.notEqual(first.scopes[0].id, second.scopes[0].id);
  assert.equal(first.scopes[0].embeddingKey, 'a:1,2,3');
});
