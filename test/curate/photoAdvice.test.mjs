import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPhotoChoices, photoAssessment, photoAdviceSummary } from '../../public/curate/photo-advice.js';
import { stackStatus } from '../../public/curate/stack-status.js';
import { photoRefereeActivity } from '../../public/curate/referee-status.js';
import { gridSuggestion, suggestionMatches, nextActionLabel } from '../../public/curate/suggestions.js';

const photos = ['a', 'b', 'c'].map(id => ({ id, state: 'undecided' }));
const advice = { state: 'complete', canApplyAll: true, keeperIds: ['a', 'c'], coverage: 'whole-group', checkCoverage: 'checked' };

test('a grid shortcut requires the same complete applicable advice and pending human scope', () => {
  const shown = { key: 'snapshot', keeperIds: ['a', 'c'] };
  const photoReferee = { ...advice, suggestion: shown };
  const group = { memberCount: 3, photoReferee };
  const comparison = { ids: ['a', 'b', 'c'], photos, photoReferee, photoRecommendations: advice };
  assert.deepEqual(gridSuggestion(group), shown);
  assert.equal(suggestionMatches(shown, comparison), true);
  for (const patch of [{ state: 'partial' }, { state: 'waiting' }, { canApplyAll: false }, { unavailableReason: 'stack-pending' }, { suggestion: null }])
    assert.equal(gridSuggestion({ ...group, photoReferee: { ...photoReferee, ...patch } }), null);
  assert.equal(gridSuggestion({ ...group, similarity: { state: 'updated' } }), null);
  assert.equal(gridSuggestion({ ...group, updated: true }), null);
  assert.equal(gridSuggestion({ ...group, memberCount: 1 }), null);
  for (const patch of [
    { updated: true }, { photoRecommendations: { ...advice, state: 'partial' } },
    { photoRecommendations: { ...advice, canApplyAll: false } },
    { photoRecommendations: { ...advice, unavailableReason: 'stack-pending' } },
    { photoReferee: { ...photoReferee, suggestion: { ...shown, key: 'changed' } } },
    { photoRecommendations: { ...advice, keeperIds: ['a', 'b'] } },
    { photos: [...photos.slice(0, 2), { id: 'c', state: 'rejected' }] },
    { ids: ['a', 'b'] },
  ]) assert.equal(suggestionMatches(shown, { ...comparison, ...patch }), false);
});

test('next action describes the human draft without conflating favorite, skip and rejection', () => {
  assert.equal(nextActionLabel({ a: 'favorite', b: 'approve', c: 'reviewed' }), 'Keep 2 · Next');
  assert.equal(nextActionLabel({ a: 'reviewed', b: 'reviewed' }), 'Skip all · Next');
  assert.equal(nextActionLabel({ a: 'reject', b: 'reviewed' }), 'Save · Next');
  assert.equal(nextActionLabel({}), 'Save · Next');
});

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
