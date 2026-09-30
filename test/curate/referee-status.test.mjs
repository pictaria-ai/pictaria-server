import test from 'node:test';
import assert from 'node:assert/strict';
import { VeniceProvider } from '../../src/enrich/providers.mjs';
import { refereeCapability } from '../../src/curate/referee-capabilities.mjs';
import { stackRefereeSupport } from '../../src/curate/stack-referee-contract.mjs';
import { stackRefereePresentation } from '../../public/curate/referee-status.js';
import { groupPresentation } from '../../public/curate/photos.js';
import { plainReasons, groupingAlgorithmLabel } from '../../public/curate/explanation-copy.js';

test('capability is bound to the evaluated hosted model and endpoint, with no probe or guessed aliases', () => {
  const provider = new VeniceProvider({ modelName: 'qwen3-vl-235b-a22b', apiKey: 'synthetic',
    fetchImpl: () => { throw new Error('No request authorized'); } });
  const cap = refereeCapability(provider);
  assert.equal(cap.maxImages, 10);
  assert.equal(stackRefereeSupport(provider, cap, 10).state, 'ready');
  assert.equal(stackRefereeSupport(provider, cap, 11).state, 'unsupported-size');
  cap.maxImages = 30;
  assert.equal(refereeCapability(provider).maxImages, 10, 'callers cannot mutate the registry');
  for (const patch of [
    { modelName: 'qwen3-vl-235b-a22b:latest' }, { modelName: 'qwen3-vl-32b' },
    { providerName: 'openai_compatible' }, { baseUrl: 'https://other.example/api/v1' },
    { baseUrl: 'http://api.venice.ai/api/v1' }, { baseUrl: 'https://api.venice.ai/api/v1?model=other' },
    { baseUrl: 'invalid' }, { analyzeImages: undefined },
  ]) assert.equal(refereeCapability({ ...provider, analyzeImages() {}, ...patch }), null);
  assert.equal(refereeCapability({ ...provider, analyzeImages() {}, baseUrl: 'https://api.venice.ai/api/v1/' }).maxImages, 10);
  assert.equal(refereeCapability(null), null);
});

test('only current checked evidence earns an AI badge; working and incomplete states remain distinct', () => {
  const group = { similarity: { state: 'checked', uncertain: true } };
  assert.equal(groupPresentation(group).phase, 'limited');
  assert.equal(groupPresentation({ ...group, stackReferee: { state: 'checked' } }).phase, 'ai-checked');
  assert.equal(groupPresentation({ ...group, stackReferee: { state: 'checking' } }).title, 'Stack Referee checking');
  assert.equal(groupPresentation({ ...group, stackReferee: { state: 'waiting' } }).phase, 'waiting');
  for (const state of ['off', 'skipped', 'updated', 'unexpected'])
    assert.equal(groupPresentation({ ...group, stackReferee: { state } }).phase, 'limited');
  for (const reason of ['unknown-capability', 'unsupported-size', 'invalid-answer', 'preparation-failed', 'photo-limit']) {
    const status = stackRefereePresentation({ state: 'incomplete', reason });
    assert.equal(status.phase, 'limited'); assert.match(status.detail, /still curate/);
  }
  assert.equal(stackRefereePresentation({ state: 'paused', reason: 'preview-cooldown' }).phase, 'limited');
  assert.doesNotMatch(stackRefereePresentation({ state: 'incomplete', reason: 'PRIVATE RAW ERROR' }).detail, /PRIVATE/);
});

test('Why distinguishes AI checks from deterministic evidence and preserves the model reason as text', () => {
  const group = { algorithm: 'candidate-6', reasons: ['Close ThumbHash descriptors support visual similarity.'] };
  assert.match(groupingAlgorithmLabel(group), /no AI stack check/);
  const checked = { ...group, stackReferee: { state: 'checked', reason: '<img src=x onerror=alert(1)>' } };
  assert.match(groupingAlgorithmLabel(checked), /Stack Referee checked/);
  assert.deepEqual(plainReasons(checked), ['Similar-looking previews (ThumbHash) support this group.', '<img src=x onerror=alert(1)>']);
  const updated = { ...checked, stackReferee: { ...checked.stackReferee, state: 'updated' } };
  assert.equal(groupingAlgorithmLabel(updated), 'Grouping from this saved view');
  assert.equal(plainReasons(updated).length, 1);
});
