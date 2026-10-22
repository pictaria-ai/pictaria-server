import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../../src/enrich/providers.mjs';
import { refereeCapability, stackRefereeModelStatus } from '../../src/curate/referee-capabilities.mjs';
import { stackRefereeSupport } from '../../src/curate/stack-referee-contract.mjs';
import { refereeActivity } from '../../public/curate/referee-status.js';
import { stackStatus } from '../../public/curate/stack-status.js';
import { evidenceRows, algorithmLabel } from '../../public/curate/explanation-copy.js';

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
  assert.equal(refereeActivity(status).title, 'Stack Referee paused');
  const stack = { memberCount: 3, route: 'candidate-supported', similarity: { state: 'checked' } };
  assert.equal(stackStatus({ ...stack, stackReferee: { ...status, state: 'incomplete' } }).badge, 'checked');
  assert.deepEqual(stackStatus({ ...stack, stackReferee: status }).steps[1],
    { name: 'AI check', state: 'off', text: 'paused, check the AI provider in Settings' });
  assert.match(refereeActivity({ ...status, reason: 'model-failures' }).detail, /Choose a vision model that compares multiple images/);
});

test('only current checked evidence earns an AI badge; working and incomplete states remain distinct', () => {
  const group = { memberCount: 3, route: 'candidate-unconfirmed', similarity: { state: 'checked', uncertain: true } };
  assert.equal(stackStatus(group).badge, 'unsure');
  assert.equal(stackStatus({ ...group, stackReferee: { state: 'checked' } }).badge, 'ai-checked');
  assert.equal(stackStatus({ ...group, stackReferee: { state: 'checking' } }).badge, 'checking');
  assert.equal(stackStatus({ ...group, stackReferee: { state: 'waiting' } }).steps[1].text, 'queued');
  for (const state of ['off', 'skipped', 'updated', 'unexpected'])
    assert.equal(stackStatus({ ...group, stackReferee: { state } }).badge, 'unsure');
  const supported = { ...group, route: 'candidate-supported', similarity: { state: 'checked' } };
  for (const reason of ['unsupported-size', 'invalid-answer', 'preparation-failed', 'photo-limit']) {
    const status = stackStatus({ ...supported, stackReferee: { state: 'incomplete', reason } });
    assert.equal(status.badge, 'partial'); assert.match(status.detail, /still choose/);
    assert.match(status.steps[1].text, /^not possible, /);
  }
  assert.equal(stackStatus({ ...supported, stackReferee: { state: 'paused', reason: 'preview-cooldown' } }).badge, 'partial');
  assert.doesNotMatch(stackStatus({ ...supported, stackReferee: { state: 'incomplete', reason: 'PRIVATE RAW ERROR' } }).steps[1].text, /PRIVATE/);
});

test('Why distinguishes AI checks from deterministic evidence and preserves the model reason as text', () => {
  const group = { algorithm: 'candidate-6', ids: ['a', 'b'], reasons: ['thumbhash'] };
  assert.equal(algorithmLabel(group), 'Algorithm 6');
  const checked = { ...group, stackReferee: { state: 'checked', reason: '<img src=x onerror=alert(1)>', split: false } };
  assert.deepEqual(evidenceRows(checked).map(row => row.value), ['<img src=x onerror=alert(1)>', 'Look alike (ThumbHash)']);
  assert.equal(stackStatus({ memberCount: 2, route: 'candidate-unconfirmed', ...checked }).steps[1].text, 'confirmed');
  const updated = { ...checked, stackReferee: { ...checked.stackReferee, state: 'updated' } };
  assert.equal(algorithmLabel(updated), 'Grouping from this saved view');
  assert.equal(evidenceRows(updated).length, 1);
});
