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
  validatePersistentStatePaths,
  validateServerAuthConfig,
} from '../src/config.mjs';
import { ANTHROPIC_DEFAULT_MODEL } from '../src/enrich/anthropicContract.mjs';

test('Claude configuration defaults to Haiku 5.5 and leaves other providers unchanged', () => {
  const defaults = loadConfig({});
  assert.equal(ANTHROPIC_DEFAULT_MODEL, 'claude-haiku-5-5');
  assert.deepEqual(defaults.providers.cloud_anthropic, { apiKey: '', modelName: ANTHROPIC_DEFAULT_MODEL });
  assert.equal(loadConfig({ ANTHROPIC_MODEL: '' }).providers.cloud_anthropic.modelName, 'claude-haiku-5-5', 'empty Compose forwarding retains the default');
  const configured = loadConfig({ ANTHROPIC_API_KEY: 'synthetic-credential', ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
  assert.deepEqual(configured.providers.cloud_anthropic, { apiKey: 'synthetic-credential', modelName: 'claude-sonnet-5-5' });
  for (const name of Object.keys(defaults.providers).filter(name => name !== 'cloud_anthropic')) {
    assert.deepEqual(configured.providers[name], defaults.providers[name]);
  }
  assert.equal(configured.defaultProvider, defaults.defaultProvider);
});

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
    'IMMICH_ML_URL',
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
  assert.equal(loadConfig({ INFERENCE_HOST_LABEL: '  M4\n Mac\tmini · LM Studio  ' }).inferenceHostLabel,
    'M4 Mac mini · LM Studio');
  assert.equal(loadConfig({ INFERENCE_HOST_LABEL: 'x'.repeat(121) }).inferenceHostLabel, 'x'.repeat(120));
  assert.equal(loadConfig({}).inferenceHostLabel, '');
});

test('daily Enrich schedule has safe defaults and normalizes environment values', () => {
  assert.deepEqual(loadConfig({ ENRICH_SCHEDULE_TIME_ZONE: 'UTC' }).enrichSchedule, {
    enabled: false,
    time: '03:00',
    timeZone: 'UTC',
    photoBudget: 100,
  });
  assert.deepEqual(loadConfig({
    ENRICH_SCHEDULE_ENABLED: 'true',
    ENRICH_SCHEDULE_TIME: '21:45',
    ENRICH_SCHEDULE_TIME_ZONE: 'America/Los_Angeles',
    ENRICH_SCHEDULE_PHOTO_BUDGET: '250',
  }).enrichSchedule, {
    enabled: true,
    time: '21:45',
    timeZone: 'America/Los_Angeles',
    photoBudget: 250,
  });
  assert.equal(loadConfig({ ENRICH_SCHEDULE_TIME: '25:90' }).enrichSchedule.time, '03:00');
  assert.equal(loadConfig({ ENRICH_SCHEDULE_TIME_ZONE: 'not-a-zone' }).enrichSchedule.timeZone, 'UTC');
  assert.equal(loadConfig({ ENRICH_SCHEDULE_PHOTO_BUDGET: '99999' }).enrichSchedule.photoBudget, 10000);
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

// Stands in for a filesystem that reports the given device and inode numbers,
// such as Unraid's user share, whose inode numbers can exceed 2^53. Like Node,
// it returns them exactly only when asked for bigint stats; ordinary stats
// carry them as Numbers, rounded. Paths it does not know do not exist.
function statWithIdentities(identities) {
  return (path, options) => {
    const identity = identities.get(path);
    if (!identity) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
    }
    return options?.bigint
      ? { dev: identity.dev, ino: identity.ino }
      : { dev: Number(identity.dev), ino: Number(identity.ino) };
  };
}

test('persistent-state collision checks compare large inode numbers exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-config-inodes-'));
  try {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir);
    const config = loadConfig({
      SETTINGS_PATH: join(dataDir, 'settings.json'),
      DATABASE_PATH: join(dataDir, 'enrichment.sqlite'),
    });
    const databasePath = config.databasePath;
    const inventoryPath = config.persistentState.inventoryPath;
    writeFileSync(databasePath, '');
    writeFileSync(inventoryPath, '{}');

    // Two different files, created one after the other on an Unraid array
    // disk. Both inode numbers round to the same Number.
    assert.equal(Number(649081296301245283n), Number(649081296301245284n));
    assert.doesNotThrow(() => validatePersistentStatePaths(config, statWithIdentities(new Map([
      [databasePath, { dev: 45n, ino: 649081296301245283n }],
      [inventoryPath, { dev: 45n, ino: 649081296301245284n }],
    ]))));

    // The same file under both names, as a hard link there would report.
    assert.throws(
      () => validatePersistentStatePaths(config, statWithIdentities(new Map([
        [databasePath, { dev: 45n, ino: 649081296301245283n }],
        [inventoryPath, { dev: 45n, ino: 649081296301245283n }],
      ]))),
      /DATABASE_PATH.*persistent-state inventory.*both resolve/s,
    );

    // The same inode number on different devices is two files.
    assert.doesNotThrow(() => validatePersistentStatePaths(config, statWithIdentities(new Map([
      [databasePath, { dev: 45n, ino: 649081296301245283n }],
      [inventoryPath, { dev: 46n, ino: 649081296301245283n }],
    ]))));

    // A filesystem that reports no identity at all proves nothing.
    assert.doesNotThrow(() => validatePersistentStatePaths(config, statWithIdentities(new Map([
      [databasePath, { dev: 0n, ino: 0n }],
      [inventoryPath, { dev: 0n, ino: 0n }],
    ]))));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persistent-state collision checks still catch real aliases of existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-config-aliases-'));
  try {
    const dataDir = join(dir, 'data');
    const aliasDir = join(dir, 'alias');
    mkdirSync(dataDir);
    symlinkSync(dataDir, aliasDir, 'dir');
    const settingsPath = join(dataDir, 'settings.json');
    const inventoryPath = join(dataDir, 'persistent-state.json');
    const hardLinkPath = join(dir, 'inventory-hard-link');
    const otherPath = join(dataDir, 'enrichment.sqlite');
    writeFileSync(inventoryPath, '{}');
    writeFileSync(otherPath, '');
    linkSync(inventoryPath, hardLinkPath);

    for (const databasePath of [
      hardLinkPath,
      join(aliasDir, 'persistent-state.json'),
      join(dataDir, '..', 'data', '.', 'persistent-state.json'),
    ]) {
      assert.throws(
        () => loadConfig({ SETTINGS_PATH: settingsPath, DATABASE_PATH: databasePath }),
        /DATABASE_PATH.*persistent-state inventory.*both resolve/s,
      );
    }
    assert.doesNotThrow(() => loadConfig({ SETTINGS_PATH: settingsPath, DATABASE_PATH: otherPath }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('optional Stack Referee scope normalizes environment values and falls back without blocking startup', t => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  for (const [value, expected] of [[undefined, 'uncertain'], ['', 'uncertain'], ['  ', 'uncertain'],
    ['All', 'all'], [' ALL ', 'all'], [' uncertain', 'uncertain'], ['UNCERTAIN', 'uncertain']]) {
    const config = loadConfig({ CURATE_STACK_REFEREE_SCOPE: value });
    assert.equal(config.curateStackRefereeScope, expected);
    assert.equal(config.curateStackRefereeEnabled, false);
  }
  assert.deepEqual(warnings, []);
  const config = loadConfig({ CURATE_STACK_REFEREE_SCOPE: 'private-invalid-input' });
  assert.equal(config.curateStackRefereeScope, 'uncertain');
  assert.equal(config.curateStackRefereeEnabled, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Invalid CURATE_STACK_REFEREE_SCOPE; using uncertain/);
  assert.doesNotMatch(warnings[0], /private-invalid-input/);
});

test('image embeddings default off with Immich’s model and tolerate a bad model name', (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  assert.deepEqual(loadConfig({}).enrichEmbeddings, { enabled: false, url: '', model: 'ViT-B-32__openai' });
  assert.deepEqual(loadConfig({ ENRICH_EMBEDDINGS_ENABLED: 'true', IMMICH_ML_URL: 'immich-machine-learning:3003/',
    ENRICH_EMBEDDINGS_MODEL: ' immich-app/ViT-B-16-SigLIP__webli ' }).enrichEmbeddings,
  { enabled: true, url: 'http://immich-machine-learning:3003', model: 'ViT-B-16-SigLIP__webli' });
  assert.deepEqual(warnings, []);
  assert.equal(loadConfig({ ENRICH_EMBEDDINGS_MODEL: 'private value with spaces' }).enrichEmbeddings.model, 'ViT-B-32__openai');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /private value/);
});
