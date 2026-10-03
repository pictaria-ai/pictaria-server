import test from 'node:test';
import assert from 'node:assert/strict';
import { stackStatus, statusCounts, keeperCount, BADGE_WORDS } from '../../public/curate/stack-status.js';
import { evidenceRows } from '../../public/curate/explanation-copy.js';
import { candidateGroups } from '../../src/curate/candidate.mjs';
import { REASON } from '../../src/curate/reasons.mjs';

// PIC-371: one grouping badge per stack, highest first, the same in every view.
const stack = (overrides = {}) => ({ memberCount: 4, route: 'candidate-supported', similarity: null, stackReferee: { state: 'off' }, ...overrides });
const badge = group => stackStatus(group)?.badge ?? null;

test('one badge per stack, highest first: Checking, AI checked, Unsure, Not fully checked, Checked', () => {
  const unsure = stack({ route: 'candidate-unconfirmed' });
  assert.equal(badge(stack()), 'checked');
  assert.equal(badge(unsure), 'unsure');
  assert.equal(badge(stack({ route: 'manual-budget' })), 'partial');
  assert.equal(badge(stack({ similarity: { state: 'incomplete', problem: 'Immich has no search embedding.' } })), 'partial');
  assert.equal(badge({ ...unsure, similarity: { state: 'incomplete' } }), 'unsure', 'Unsure outranks Not fully checked');
  assert.equal(badge({ ...unsure, stackReferee: { state: 'checked', split: false } }), 'ai-checked');
  for (const similarity of [{ state: 'waiting' }, { state: 'checking', done: 1, total: 4 }])
    assert.equal(badge({ ...unsure, similarity, stackReferee: { state: 'checked' } }), 'checking', 'Checking outranks everything');
  assert.equal(badge({ ...unsure, stackReferee: { state: 'waiting' } }), 'checking');
  assert.equal(badge({ ...unsure, stackReferee: { state: 'incomplete', reason: 'unsupported-size', limit: 10 } }), 'unsure');
  assert.equal(badge(stack({ stackReferee: { state: 'incomplete', reason: 'unsupported-size', limit: 10 } })), 'partial');
  // Standard-1 time stacks, without candidate stacking, are unsure too.
  assert.equal(badge(stack({ route: 'uncertain' })), 'unsure');
  assert.equal(stackStatus(stack(), { decided: true }), null, 'decided photos show their decision only');
  assert.deepEqual(Object.values(BADGE_WORDS), ['Checking', 'AI checked', 'Unsure', 'Not fully checked', 'Checked', 'Kept apart']);
});

test('single photos are Kept apart only when actively separated; plain singles have no badge', () => {
  const single = (reasons, overrides = {}) => badge({ memberCount: 1, route: 'single', reasons, ...overrides });
  assert.equal(single([REASON.unlinked]), null);
  assert.equal(single([REASON.alone]), null);
  assert.equal(single(undefined), null);
  for (const code of [REASON.embeddingApart, REASON.peopleApart, REASON.rankContrast, REASON.savedSplit])
    assert.equal(single([code]), 'apart', code);
  // Saved before reason codes, and split off by the Stack Referee.
  assert.equal(single(['Clearly different image embeddings separate photos taken at the same time.']), 'apart');
  assert.equal(single([REASON.unlinked], { stackReferee: { state: 'checked', reason: 'A solo portrait.' } }), 'apart');
  assert.equal(single([REASON.unlinked], { similarity: { state: 'checking' } }), 'checking', 'a single being checked may still join a stack');
  assert.deepEqual(stackStatus({ memberCount: 1, route: 'single', reasons: [REASON.peopleApart] }).steps, [], 'no process strip for singles');
});

test('the process strip names each step, and why a check could not run', () => {
  const steps = group => stackStatus(group).steps.map(s => `${s.name}: ${s.text}`);
  assert.deepEqual(steps(stack({ stackReferee: { state: 'skipped', reason: 'supported-by-grouping' } })), ['Grouping: done', 'AI check: not needed']);
  assert.deepEqual(steps(stack({ memberCount: 34, route: 'candidate-unconfirmed', stackReferee: { state: 'incomplete', reason: 'unsupported-size', limit: 10 } })),
    ['Grouping: unsure', 'AI check: not possible, 34 photos is over the 10-photo limit']);
  assert.deepEqual(steps(stack({ similarity: { state: 'checking', done: 3, total: 8 }, stackReferee: { state: 'skipped', reason: 'deterministic-pending' } })),
    ['Grouping: checking similarity, 3 of 8', 'AI check: waits for similarity checks']);
  assert.deepEqual(steps(stack({ route: 'manual-budget', stackReferee: { state: 'off' } })),
    ['Grouping: too many photos to compare, grouped by time', 'AI check: off']);
  assert.deepEqual(steps(stack({ route: 'candidate-unconfirmed', stackReferee: { state: 'checked', split: true } })),
    ['Grouping: unsure', 'AI check: split a larger stack']);
  const failed = stackStatus(stack({ similarity: { state: 'incomplete', problem: 'Immich has no search embedding for one of these photos.' } })).steps[0];
  assert.equal(failed.state, 'limited'); assert.match(failed.detail, /no search embedding/);
  assert.equal(stackStatus(stack({ stackReferee: { state: 'waiting', reason: 'shared-provider' } })).steps[1].text, 'queued for the shared AI provider');
});

test('a checking limit is a Grouping step when the strip shows, and an evidence row otherwise', () => {
  const comparison = { ids: ['1', '2', '3'], reasons: [REASON.budget, REASON.savedSplit] };
  assert.deepEqual(evidenceRows(comparison, { steps: true }).map(row => row.signal), ['Your split']);
  assert.deepEqual(evidenceRows(comparison).map(row => row.signal), ['Grouping', 'Your split']);
});

test('an updated grouping keeps the shown badge and adds a note, never a badge of its own', () => {
  for (const similarity of [{ state: 'updated', pending: false }, { state: 'updated', pending: true, checking: true }]) {
    const status = stackStatus(stack({ route: 'candidate-unconfirmed', similarity, stackReferee: { state: 'updated' } }));
    assert.equal(status.badge, 'unsure'); assert.equal(status.updated, true);
    assert.equal(status.steps[1].text, 'waits for the updated grouping');
  }
  assert.equal(stackStatus(stack()).updated, false);
});

test('the keeper slot shows a star with its count and a Keepers step once PIC-116 supplies advice', () => {
  assert.equal(keeperCount(stack()), null);
  assert.equal(stackStatus(stack()).steps.length, 2, 'no Keepers step until the Photo Referee reports');
  const advised = stack({ photoReferee: { state: 'complete', keepers: 2 } });
  assert.equal(stackStatus(advised).keepers, 2);
  assert.equal(stackStatus(advised).badge, 'checked', 'the star sits beside the grouping badge');
  assert.deepEqual(stackStatus(advised).steps.at(-1), { name: 'Keepers', state: 'done', text: '2 suggested' });
  assert.equal(keeperCount(stack({ photoReferee: { state: 'complete' }, photoRecommendations: { keeperIds: ['a'] } })), 1);
  assert.equal(stackStatus(stack({ photoReferee: { state: 'complete', keepers: 0 } })).steps.at(-1).text, 'none suggested');
  assert.equal(stackStatus(stack({ photoReferee: { state: 'waiting', reason: 'stack-pending' } })).steps.at(-1).text, 'waits for the AI check');
  assert.equal(stackStatus(stack({ photoReferee: { state: 'skipped', reason: 'not-pending-stack' } })).steps.length, 2);
});

test('header counts cover the loaded cards that need attention', () => {
  const groups = [stack({ similarity: { state: 'checking' } }), stack({ route: 'candidate-unconfirmed' }),
    stack({ route: 'candidate-unconfirmed' }), stack({ route: 'manual-budget' }), stack(),
    { memberCount: 1, route: 'single', reasons: [REASON.embeddingApart] }];
  assert.deepEqual(statusCounts(groups), { checking: 1, unsure: 2, partial: 1 });
});

test('the algorithm records which evidence kept photos apart, without English sentences', () => {
  const photo = (id, overrides = {}) => ({ id, time: Number(id) * 1000, availability: 'observed', materialKey: id, ...overrides });
  const reasonsFor = (result, id) => result.groups.find(g => g.ids.includes(id)).reasons;
  // Different people: one person against a couple.
  const people = candidateGroups([photo('1', { peopleCategory: 'one' }), photo('2', { peopleCategory: 'couple' })]);
  assert.deepEqual(reasonsFor(people, '1'), [REASON.peopleApart]);
  // A saved split is named where it separates photos taken at the same time.
  const split = candidateGroups([photo('1'), photo('2'), photo('3')], { separations: [{ id: 's', partitions: [['1'], ['2']] }] });
  assert.deepEqual(reasonsFor(split, '2'), [REASON.savedSplit]);
  assert.deepEqual(reasonsFor(split, '3'), [REASON.provisional, REASON.savedSplit]);
  assert.deepEqual(candidateGroups([photo('1'), photo('2'), photo('3')]).groups[0].reasons, [REASON.provisional]);
  const elsewhere = candidateGroups([photo('1'), photo('2'), photo('9', { time: 9e6 })],
    { separations: [{ id: 's', partitions: [['1'], ['9']] }] });
  assert.deepEqual(reasonsFor(elsewhere, '1'), [REASON.provisional], 'a split with a photo taken later does not apply here');
  // A lone photo, and stacking turned off.
  assert.deepEqual(candidateGroups([photo('1')]).groups[0].reasons, [REASON.alone]);
  assert.deepEqual(candidateGroups([photo('1'), photo('2')], { stacks: false }).groups[0].reasons, [REASON.stacksOff]);
  const all = candidateGroups([photo('1', { peopleCategory: 'one' }), photo('2', { peopleCategory: 'couple' }), photo('3')]);
  assert.ok(all.groups.flatMap(g => g.reasons).every(code => Object.values(REASON).includes(code)));
  // The page words what the server recorded.
  assert.deepEqual(evidenceRows({ ids: ['1'], reasons: reasonsFor(people, '1'), nearby: 1 }).map(r => `${r.signal}: ${r.value}`),
    ['People: Different people from some nearby photos', 'Taken: 1 other photo at the same time']);
});
