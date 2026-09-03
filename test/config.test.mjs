import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendHttpUrlPath,
  loadConfig,
  normalizeBaseUrl,
  normalizeHttpUrl,
  validateServerAuthConfig,
} from '../src/config.mjs';

test('service URLs reject query and fragment delimiters and append endpoint paths structurally', () => {
  for (const delimiter of ['?', '?target=internal', '#', '#fragment']) {
    assert.throws(
      () => normalizeHttpUrl(`http://service.local:1234/base${delimiter}`),
      /without credentials, a query, or a fragment/,
    );
    assert.throws(
      () => normalizeBaseUrl(`http://immich.local:2283/base${delimiter}`),
      /without credentials, a query, or a fragment/,
    );
  }

  assert.equal(
    appendHttpUrlPath('https://service.example:8443/custom/v1', '/chat/completions?mode=strict'),
    'https://service.example:8443/custom/v1/chat/completions?mode=strict',
  );
  assert.equal(
    appendHttpUrlPath('http://service.local/base%3Fsegment', '/api/chat'),
    'http://service.local/base%3Fsegment/api/chat',
  );
});

test('every environment-configurable service base URL rejects query components', () => {
  for (const variable of [
    'IMMICH_BASE_URL',
    'IMMICH_PUBLIC_URL',
    'LMSTUDIO_BASE_URL',
    'OPENAI_COMPATIBLE_BASE_URL',
    'OLLAMA_LOCAL_BASE_URL',
    'OPENROUTER_BASE_URL',
    'OLLAMA_BASE_URL',
    'VENICE_BASE_URL',
  ]) {
    assert.throws(
      () => loadConfig({ [variable]: 'http://internal.invalid/chosen?' }),
      /without credentials, a query, or a fragment/,
      variable,
    );
  }
});

test('empty Compose values preserve native LM Studio defaults', () => {
  const native = loadConfig({}).providers.local_lmstudio;
  const composeEmpty = loadConfig({
    LMSTUDIO_API_KEY: '',
    LMSTUDIO_MAX_TOKENS: '',
    LMSTUDIO_TEMPERATURE: '',
  }).providers.local_lmstudio;

  assert.equal(native.apiKey, 'lm-studio');
  assert.equal(composeEmpty.apiKey, native.apiKey);
  assert.equal(composeEmpty.maxTokens, native.maxTokens);
  assert.equal(composeEmpty.temperature, native.temperature);

  const configured = loadConfig({
    LMSTUDIO_API_KEY: 'proxy-token',
    LMSTUDIO_MAX_TOKENS: '4096',
    LMSTUDIO_TEMPERATURE: '0.7',
  }).providers.local_lmstudio;
  assert.equal(configured.apiKey, 'proxy-token');
  assert.equal(configured.maxTokens, 4096);
  assert.equal(configured.temperature, 0.7);
});

test('OpenAI-compatible configuration is explicit and keeps authentication optional', () => {
  const empty = loadConfig({}).providers.openai_compatible;
  assert.deepEqual(empty, { apiKey: '', modelName: '', baseUrl: '' });

  const configured = loadConfig({
    OPENAI_COMPATIBLE_BASE_URL: 'llama-host:8080/v1/',
    OPENAI_COMPATIBLE_MODEL: 'qwen-vision',
    OPENAI_COMPATIBLE_API_KEY: 'proxy-token',
  }).providers.openai_compatible;
  assert.deepEqual(configured, {
    apiKey: 'proxy-token',
    modelName: 'qwen-vision',
    baseUrl: 'http://llama-host:8080/v1',
  });
});

test('inference host context is operator-authored, trimmed, and bounded', () => {
  assert.equal(loadConfig({ INFERENCE_HOST_LABEL: '  M4 Mac mini · LM Studio  ' }).inferenceHostLabel,
    'M4 Mac mini · LM Studio');
  assert.equal(loadConfig({ INFERENCE_HOST_LABEL: 'x'.repeat(121) }).inferenceHostLabel, 'x'.repeat(120));
  assert.equal(loadConfig({}).inferenceHostLabel, '');
});

test('server auth configuration fails closed unless open mode is explicit', () => {
  for (const env of [{}, { APP_PASSWORD: '' }, { APP_PASSWORD: '', ALLOW_INSECURE_OPEN: 'false' }]) {
    assert.throws(
      () => validateServerAuthConfig(loadConfig(env)),
      /APP_PASSWORD.*ALLOW_INSECURE_OPEN=true/,
    );
  }

  assert.doesNotThrow(() => validateServerAuthConfig(loadConfig({ APP_PASSWORD: 'household-secret' })));
  assert.doesNotThrow(() => validateServerAuthConfig(loadConfig({
    APP_PASSWORD: '',
    ALLOW_INSECURE_OPEN: 'true',
  })));
});

test('generated persistent-state paths cannot collide with configured targets', () => {
  assert.throws(
    () => loadConfig({ SETTINGS_PATH: '/tmp/pictaria/persistent-state.json' }),
    /SETTINGS_PATH.*persistent-state inventory.*both resolve/s,
  );
  assert.throws(
    () => loadConfig({
      SETTINGS_PATH: '/tmp/pictaria/settings.json',
      DATABASE_PATH: '/tmp/pictaria/persistent-state.json',
    }),
    /DATABASE_PATH.*persistent-state inventory.*both resolve/s,
  );
  assert.throws(
    () => loadConfig({
      SETTINGS_PATH: '/tmp/pictaria/settings.json',
      FRAME_DB_PATH: '/tmp/pictaria/persistent-state.json.initialized',
    }),
    /FRAME_DB_PATH.*persistent-state marker.*both resolve/s,
  );
  assert.throws(
    () => loadConfig({
      SETTINGS_PATH: '/tmp/pictaria/settings.json',
      BACKUP_DIR: '/tmp/pictaria/persistent-state.json',
    }),
    /BACKUP_DIR\/BACKUP_DIR_DEFAULT.*persistent-state inventory.*both resolve/s,
  );
  assert.throws(
    () => loadConfig({
      SETTINGS_PATH: '/tmp/pictaria/settings.json',
      BACKUP_DIR_DEFAULT: '/tmp/pictaria/persistent-state.json.initialized',
    }),
    /BACKUP_DIR\/BACKUP_DIR_DEFAULT.*persistent-state marker.*both resolve/s,
  );
  assert.throws(
    () => loadConfig({
      SETTINGS_PATH: '/tmp/pictaria/settings.json',
      DATABASE_PATH: '/tmp/pictaria/settings.json.initialized',
    }),
    /DATABASE_PATH.*legacy settings marker.*both resolve/s,
  );
});

test('persistent-state collision checks resolve symlink aliases and existing file identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-config-paths-'));
  try {
    const dataDir = join(dir, 'data');
    const aliasDir = join(dir, 'alias');
    mkdirSync(dataDir);
    symlinkSync(dataDir, aliasDir, 'dir');

    assert.throws(
      () => loadConfig({
        SETTINGS_PATH: join(dataDir, 'settings.json'),
        DATABASE_PATH: join(aliasDir, 'persistent-state.json'),
      }),
      /DATABASE_PATH.*persistent-state inventory.*both resolve/s,
    );

    const inventoryPath = join(dataDir, 'persistent-state.json');
    const hardLinkPath = join(dir, 'inventory-hard-link');
    writeFileSync(inventoryPath, '{}');
    linkSync(inventoryPath, hardLinkPath);
    assert.throws(
      () => loadConfig({
        SETTINGS_PATH: join(dataDir, 'settings.json'),
        DATABASE_PATH: hardLinkPath,
      }),
      /DATABASE_PATH.*persistent-state inventory.*both resolve/s,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
