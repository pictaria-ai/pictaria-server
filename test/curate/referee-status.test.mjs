import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../../src/enrich/providers.mjs';
import { refereeCapability, stackRefereeModelStatus } from '../../src/curate/referee-capabilities.mjs';
import { stackRefereeSupport } from '../../src/curate/stack-referee-contract.mjs';
import { stackRefereePresentation } from '../../public/curate/referee-status.js';
import { groupPresentation } from '../../public/curate/photos.js';
import { plainReasons, groupingAlgorithmLabel } from '../../public/curate/explanation-copy.js';

test('all existing multi-image adapters admit the selected model with a conservative limit, without probing', () => {
  for (const name of ['cloud_openai', 'openrouter', 'venice', 'local_lmstudio', 'local_ollama', 'cloud_ollama', 'openai_compatible']) {
    const provider = createProvider(name, { modelName: 'operator-selected-vision', apiKey: 'synthetic',
      baseUrl: 'http://localhost:1234/v1', fetchImpl: () => { throw new Error('No request authorized'); } });
    const cap = refereeCapability(provider);
    assert.equal(cap.provider, name); assert.equal(cap.model, provider.modelName);
    assert.equal(stackRefereeSupport(provider, cap, 10).state, 'ready');
    assert.equal(stackRefereeSupport(provider, cap, 11).state, 'unsupported-size');
    cap.maxImages = 30;
    assert.equal(refereeCapability(provider).maxImages, 10, 'callers cannot mutate the policy');
    for (const patch of [{ providerName: 'unsupported' }, { modelName: '' }, { analyzeImages: undefined }, { baseUrl: 'ftp://invalid' }])
      assert.equal(refereeCapability({ ...provider, analyzeImages() {}, ...patch }), null);
  }
  assert.equal(refereeCapability(null), null);
});

test('Settings resolves the actual shared model without returning credentials or probing', () => {
  const config = { defaultProvider: 'venice', providers: {
    venice: { modelName: 'qwen3-vl-235b-a22b', apiKey: 'PRIVATE KEY' },
    local_ollama: { modelName: 'configured-local-vision', baseUrl: 'http://private-host:11434' },
  } };
  assert.deepEqual(stackRefereeModelStatus(config), { state: 'configured', provider: 'venice', model: 'qwen3-vl-235b-a22b', maxImages: 10 });
  config.curateRefereeProvider = 'local_ollama'; config.curateRefereeModel = 'overridden-vision';
  assert.deepEqual(stackRefereeModelStatus(config), { state: 'configured', provider: 'local_ollama', model: 'overridden-vision', maxImages: 10 });
  assert.doesNotMatch(JSON.stringify(stackRefereeModelStatus(config)), /PRIVATE|private-host/);
  config.curateRefereeProvider = 'cloud_openai';
  assert.deepEqual(stackRefereeModelStatus(config), { state: 'configuration' });
});

test('configuration blockers appear at page level without giving every card a failure badge', () => {
  const status = { state: 'paused', reason: 'configuration', scope: 'configuration' };
  assert.equal(stackRefereePresentation(status), null);
  assert.equal(stackRefereePresentation(status, { page: true }).title, 'Stack Referee paused');
  assert.equal(groupPresentation({ stackReferee: { ...status, state: 'incomplete' }, similarity: { state: 'checked' } }).phase, null);
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
