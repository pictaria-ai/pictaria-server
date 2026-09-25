import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurateAiProvider } from '../../src/curate/ai-config.mjs';

function configuration() {
  return {
    defaultProvider: 'local_lmstudio',
    curateRefereeProvider: '',
    curateRefereeModel: '',
    providers: {
      local_lmstudio: { modelName: 'local-vision', baseUrl: 'http://localhost:1234/v1', apiKey: 'synthetic-local-key', temperature: 0.2 },
      venice: { modelName: 'cloud-vision', apiKey: 'synthetic-cloud-key' },
    },
  };
}

test('Curate follows the current Enrich selection independently of its enable switch', () => {
  const config = configuration();
  config.enrichEnabled = false;
  const first = createCurateAiProvider(config);
  assert.equal(first.providerName, 'local_lmstudio');
  assert.equal(first.modelName, 'local-vision');
  config.defaultProvider = 'venice';
  const next = createCurateAiProvider(config);
  assert.equal(next.providerName, 'venice');
  assert.equal(next.modelName, 'cloud-vision');
  assert.equal(first.modelName, 'local-vision');
});

test('shared provider/model overrides can be cleared without changing Enrich', () => {
  const config = configuration();
  const before = structuredClone(config.providers);
  config.curateRefereeProvider = 'venice';
  config.curateRefereeModel = 'curate-vision';
  const overridden = createCurateAiProvider(config);
  assert.equal(overridden.providerName, 'venice');
  assert.equal(overridden.modelName, 'curate-vision');
  config.curateRefereeModel = '';
  assert.equal(createCurateAiProvider(config).modelName, 'cloud-vision');
  config.curateRefereeProvider = '';
  assert.equal(createCurateAiProvider(config).modelName, 'local-vision');
  assert.deepEqual(config.providers, before);
});

test('a running job retains its connection, credentials and inference options', () => {
  const config = configuration();
  const pinned = createCurateAiProvider(config, { minimumTimeoutMs: 1_200_000 });
  Object.assign(config.providers.local_lmstudio, {
    baseUrl: 'http://localhost:4321/v1', apiKey: 'synthetic-replacement-key',
    modelName: 'next-vision', temperature: 0.8, timeoutMs: 1_800_000,
  });
  assert.equal(pinned.baseUrl, 'http://localhost:1234/v1');
  assert.equal(pinned.apiKey, 'synthetic-local-key');
  assert.equal(pinned.modelName, 'local-vision');
  assert.equal(pinned.temperature, 0.2);
  assert.equal(pinned.timeoutMs, 1_200_000);
  const next = createCurateAiProvider(config, { minimumTimeoutMs: 1_200_000 });
  assert.equal(next.baseUrl, 'http://localhost:4321/v1');
  assert.equal(next.apiKey, 'synthetic-replacement-key');
  assert.equal(next.modelName, 'next-vision');
  assert.equal(next.temperature, 0.8);
  assert.equal(next.timeoutMs, 1_800_000);
});

test('invalid explicit configuration fails rather than falling back to another provider', () => {
  const config = configuration();
  config.curateRefereeProvider = 'venice';
  config.providers.venice.apiKey = '';
  assert.throws(() => createCurateAiProvider(config), /VENICE_API_KEY is required/);
  config.curateRefereeProvider = 'unsupported';
  assert.throws(() => createCurateAiProvider(config), /Unsupported provider/);
});
