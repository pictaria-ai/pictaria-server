import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidateGroups } from '../../src/curate/candidate.mjs';
import { STACK_EMBEDDING_THRESHOLDS } from '../../src/curate/embedding-evidence.mjs';

// PIC-392 acceptance: replay the owner's judged stacking-lab groups (anonymized
// similarities only) through candidate-4 and compare with the judged stacks.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/curate/judged-embedding-groups.json', import.meta.url), 'utf8'));
const thresholds = STACK_EMBEDDING_THRESHOLDS[fixture.model];

function replay(group, options = {}) {
  const table = new Map(group.similarities.split('|').map(entry => {
    const [a, b, value] = entry.split(' ');
    return [`${a}|${b}`, Number(value)];
  }));
  const embeddings = { key: 'replay', ...thresholds, prepare() {}, loadKeys() {}, signature: ids => ids.join(','),
    similarity: (a, b) => table.get(`${a}|${b}`) ?? table.get(`${b}|${a}`) ?? null };
  const rows = group.photos.map((n, i) => ({ id: String(n), time: 1_000_000 + i * 1000, availability: 'observed', materialKey: String(n) }));
  return candidateGroups(rows, options.embeddings === false ? {} : { embeddings });
}

// Share of photo pairs placed as judged (together or apart), against the
// best-matching acceptable judgment.
function agreement(result, judged) {
  const where = new Map(result.groups.flatMap((g, i) => g.ids.map(id => [Number(id), i])));
  return Math.max(...judged.map(split => {
    const truth = new Map(split.flatMap((g, i) => g.map(p => [p, i])));
    const ids = [...truth.keys()];
    let agree = 0, total = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      total++;
      if ((where.get(ids[i]) === where.get(ids[j])) === (truth.get(ids[i]) === truth.get(ids[j]))) agree++;
    }
    return agree / total;
  }));
}

test('judged groups: candidate-4 agrees with the owner far more than candidate-3 can without evidence', () => {
  const scores = {}, baseline = {};
  let stacks = 0, uncertain = 0;
  for (const [name, group] of Object.entries(fixture.groups)) {
    const result = replay(group);
    scores[name] = agreement(result, group.judged);
    baseline[name] = agreement(replay(group, { embeddings: false }), group.judged);
    for (const g of result.groups) if (g.ids.length > 1) { stacks++; if (g.route === 'candidate-unconfirmed') uncertain++; }
    // With a similarity for every pair, nothing is searched.
    const known = new Set(group.similarities.split('|').map(entry => entry.split(' ').slice(0, 2).join('|')));
    const everyPair = group.photos.every((a, i) => group.photos.slice(i + 1).every(b => known.has(`${a}|${b}`) || known.has(`${b}|${a}`)));
    if (everyPair) assert.deepEqual(result.scopes.flatMap(scope => scope.referenceIds), [], `${name}: no searches`);
  }
  const mean = values => Object.values(values).reduce((a, b) => a + b, 0) / Object.values(values).length;
  // Recorded 2026-10-01: 81.6% with 2 of 14 stacks uncertain, against 55.6%.
  assert.ok(mean(scores) >= 0.8, `mean agreement ${mean(scores)}`);
  assert.ok(mean(scores) - mean(baseline) >= 0.2, 'embeddings add substantial evidence');
  for (const name of ['group1', 'group2', 'group3', 'group8']) assert.equal(scores[name], 1, `${name} matches the judgment`);
  assert.ok(scores.group4 >= 0.9 && scores.group6 >= 0.75, 'the two hardest groups');
  assert.ok(uncertain <= 2, `${uncertain} of ${stacks} stacks left uncertain`);
});

test('judged groups: the two tight halves of group 2 form one stack, and its outlying pair stays apart', () => {
  const result = replay(fixture.groups.group2);
  assert.deepEqual(result.groups.map(g => g.ids.map(Number).sort((a, b) => a - b)),
    [[1, 2, 3, 4, 5, 6, 7, 8], [9, 10]]);
  assert.ok(result.groups.every(g => g.route === 'candidate-supported'));
});
