import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPhotoChoices, photoAssessment, photoAdviceSummary } from '../../public/curate/photo-advice.js';
import { stackStatus } from '../../public/curate/stack-status.js';
import { photoRefereeActivity } from '../../public/curate/referee-status.js';

const photos = ['a', 'b', 'c'].map(id => ({ id, state: 'undecided' }));
const advice = { state: 'complete', canApplyAll: true, keeperIds: ['a', 'c'], coverage: 'whole-group', checkCoverage: 'checked' };

test('only complete applicable advice seeds a new draft, including zero and multiple keepers', () => {
  assert.deepEqual(initialPhotoChoices({ photos, photoRecommendations: advice }), { a: 'approve', b: 'reviewed', c: 'approve' });
  for (const patch of [{ state: 'partial' }, { canApplyAll: false }, { keeperIds: [], noneRecommended: true }])
    assert.deepEqual(initialPhotoChoices({ photos, photoRecommendations: { ...advice, ...patch } }),
      { a: 'reviewed', b: 'reviewed', c: 'reviewed' });
  assert.deepEqual(initialPhotoChoices({ photos, updated: true, photoRecommendations: advice }),
    { a: 'reviewed', b: 'reviewed', c: 'reviewed' });
  assert.deepEqual(initialPhotoChoices({ photos, photoRecommendations: advice }, { decided: true }),
    { a: 'reviewed', b: 'reviewed', c: 'reviewed' });
});

test('saved human outcomes override advice even when creating a new draft', () => {
  assert.deepEqual(initialPhotoChoices({ photoRecommendations: advice,
    photos: [{ id: 'a', state: 'rejected' }, { id: 'b', state: 'approved', favorite: true }, { id: 'c', state: 'reviewed' }] }),
  { a: 'reject', b: 'favorite', c: 'reviewed' });
});

test('only valid batch assessments are inspectable; coverage and zero are explicit', () => {
  assert.equal(photoAssessment(null, 'a'), null);
  const result = { ...advice, batches: [{ status: 'unavailable', assessments: [{ id: 'b', reason: 'Ignored' }] },
    { status: 'valid', assessments: [{ id: 'a', reason: '<script>visible text</script>' }] }] };
  assert.equal(photoAssessment(result, 'b'), null);
  assert.equal(photoAssessment(result, 'a').suggested, true);
  assert.match(photoAdviceSummary({ ...advice, noneRecommended: true, keeperIds: [] }), /none suggested/);
  assert.doesNotMatch(photoAdviceSummary({ ...advice, state: 'partial', keeperIds: [] }), /none suggested/);
  assert.match(photoAdviceSummary({ ...advice, coverage: 'within-batches', checkCoverage: 'unchecked-size' }), /separate batches.*too large/);
  assert.match(photoAdviceSummary({ ...advice, canApplyAll: false }), /Review manually/);
  assert.match(photoAdviceSummary({ ...advice, checkCoverage: 'incomplete' }), /checking finished incomplete/);
});

test('Photo Referee activity is independent, with no claim that it performed a Stack Referee check', () => {
  assert.equal(photoRefereeActivity({ state: 'off' }), null);
  assert.equal(photoRefereeActivity({ state: 'checking' }).title, 'Photo Referee checking');
  assert.match(photoRefereeActivity({ state: 'paused', reason: 'model-failures' }).detail, /photo comparisons/);
  const state = stackStatus({ ids: ['a', 'b'], route: 'candidate-unconfirmed', photoReferee: { state: 'complete', keepers: 2 } });
  assert.equal(state.badge, 'unsure'); assert.equal(state.keepers, 2);
  const mixed = stackStatus({ ids: ['a', 'b'], photoReferee: { state: 'complete', keepers: 0, canApplyAll: false } });
  assert.equal(mixed.keepers, null); assert.equal(mixed.steps.at(-1).text, 'review manually');
  const waiting = stackStatus({ ids: ['a', 'b'], photoReferee: { state: 'complete', keepers: 2,
    canApplyAll: false, unavailableReason: 'stack-pending' } });
  assert.match(waiting.steps.at(-1).detail, /Stack checking is not ready/);
  assert.doesNotMatch(waiting.steps.at(-1).detail, /different subjects/);
  assert.equal(stackStatus({ ids: ['a'], reasons: ['photo-split'] }).badge, 'apart');
});
