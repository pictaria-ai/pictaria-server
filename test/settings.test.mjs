import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_SETTINGS_STATE_BYTES,
  SETTINGS_VERSION,
  SettingsError,
  SettingsStore,
  migrateSettingsState,
  settingsContract,
  validateSettingsPersistentState,
} from '../src/settings.mjs';

function makeConfig() {
  return {
    immichBaseUrl: 'http://immich.local:2283',
    immichPublicUrl: 'http://immich.local:2283',
    immichApiKey: 'env-immich-key',
    defaultProvider: 'cloud_openai',
    imageSource: 'preview',
    inferenceHostLabel: '',
    curateBurstGrouping: true,
    curateRefereeEnabled: false,
    curateRefereeProvider: '',
    curateRefereeModel: '',
    voice: {
      ttsProvider: 'openai',
      openAiApiKey: 'env-key',
      openAiTtsModel: 'gpt-4o-mini-tts',
      openAiTtsVoice: 'coral',
      openAiTtsSpeed: 1.17,
      openAiTtsInstructions: '',
      elevenLabsApiKey: '',
      elevenLabsTtsModel: 'eleven_multilingual_v2',
      elevenLabsVoiceId: '',
      elevenLabsOutputFormat: 'mp3_44100_128',
    },
    providers: {
      cloud_openai: { apiKey: 'env-key', modelName: 'gpt-5.5' },
      local_lmstudio: { apiKey: 'lm-studio', modelName: '', baseUrl: 'http://127.0.0.1:1234/v1' },
      openai_compatible: { apiKey: '', modelName: '', baseUrl: '' },
      local_ollama: { apiKey: '', modelName: '', baseUrl: 'http://127.0.0.1:11434' },
      openrouter: { apiKey: '', modelName: 'qwen/qwen3-vl-32b-instruct', baseUrl: 'https://openrouter.ai/api/v1' },
      cloud_ollama: { apiKey: '', modelName: 'qwen3.5:cloud', baseUrl: 'https://ollama.com' },
      venice: { apiKey: '', modelName: '', baseUrl: 'https://api.venice.ai/api/v1' },
    },
    insights: {
      favoritesTagId: '',
      favoritesTagValue: '',
      locationGroups: [],
      refreshIntervalHours: 24,
      tripAwayKm: 100,
      tripGapDays: 3,
      tripMinDays: 2,
    },
    ambient: {
      geocodingProvider: '',
      geoapifyApiKey: '',
      immichMetadataWriteback: false,
    },
    backup: {
      dir: '/tmp/backups',
      enabled: true,
      intervalHours: 24,
      keep: 7,
    },
  };
}

function withStore(work, env = { TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'env-key' }) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  const config = makeConfig();
  const store = new SettingsStore({ filePath: join(dir, 'settings.json'), config, env }).load();
  try {
    return work(store, config, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh store materializes private versioned state before any override is saved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    const config = makeConfig();

    const store = new SettingsStore({ filePath: path, config, env: {} }).load();

    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      version: SETTINGS_VERSION,
      credentialBindings: {},
      server: {},
      enrich: {},
      curate: {},
      insights: {},
      ambient: {},
      voice: {},
      prompts: {},
      backup: {},
      support: {},
    });
    assert.equal(store.describe().server.immichBaseUrl.source, 'default');
    assert.equal(config.immichBaseUrl, 'http://immich.local:2283');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings state validation rejects documents that would silently erase overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    for (const [contents, valid] of [
      ['{"version":1}', true],
      ['{"version":2}', true],
      ['{"version":3,"credentialBindings":{}}', true],
      ['null', false],
      ['{}', false],
      ['{"version":1,"server":[]}', false],
      ['{"version":2,"server":{"removedSetting":"value"}}', false],
      ['{"version":2,"backup":{"enabled":"yes"}}', false],
      ['{"version":4}', false],
    ]) {
      writeFileSync(path, contents);
      assert.equal(validateSettingsPersistentState(path).valid, valid, contents);
    }

    writeFileSync(path, 'null');
    assert.throws(
      () => new SettingsStore({ filePath: path, config: makeConfig(), env: {} }).load(),
      /expected a versioned settings object/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings startup and validation reject restored state above the encoded byte ceiling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, Buffer.alloc(MAX_SETTINGS_STATE_BYTES + 1, 0x20));

    assert.equal(validateSettingsPersistentState(path).valid, false);
    assert.throws(
      () => new SettingsStore({ filePath: path, config: makeConfig(), env: {} }).load(),
      /byte limit/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compact legacy settings remain migratable when indentation would cross the ceiling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    const locationGroups = Array.from({ length: 50 }, (_, groupIndex) => ({
      name: `Group ${groupIndex}`,
      cities: Array.from({ length: 500 }, (_, cityIndex) => (
        `City-${groupIndex}-${cityIndex}-${'x'.repeat(54)}`
      )),
    }));
    const compactLegacy = JSON.stringify({ version: 1, insights: { locationGroups } });
    assert.ok(Buffer.byteLength(compactLegacy) < MAX_SETTINGS_STATE_BYTES);
    writeFileSync(path, compactLegacy);

    assert.equal(validateSettingsPersistentState(path).valid, true);
    new SettingsStore({ filePath: path, config: makeConfig(), env: {} }).load();
    const persisted = readFileSync(path);
    assert.ok(persisted.byteLength <= MAX_SETTINGS_STATE_BYTES);
    assert.equal(JSON.parse(persisted).version, SETTINGS_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings materialization is markerless because the global guard owns loss detection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');

    new SettingsStore({ filePath: path, config: makeConfig(), env: {} }).load();
    rmSync(path);
    const restartedConfig = makeConfig();
    const restarted = new SettingsStore({ filePath: path, config: restartedConfig, env: {} }).load();

    assert.equal(existsSync(path), true);
    assert.equal(existsSync(`${path}.initialized`), false);
    assert.equal(restarted.describe().server.immichBaseUrl.source, 'default');
    assert.equal(restartedConfig.immichBaseUrl, 'http://immich.local:2283');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing settings file is loaded without being rewritten or gaining a second marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    const original = '{"version":5,"credentialBindings":{},"voice":{"openAiTtsVoice":"ash"}}\n';
    writeFileSync(path, original, { mode: 0o600 });

    const config = makeConfig();
    new SettingsStore({ filePath: path, config, env: {} }).load();

    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(config.voice.openAiTtsVoice, 'ash');
    assert.equal(existsSync(`${path}.initialized`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prompt overrides apply live, validate placeholders, and clear back to built-in', () => {
  withStore((store, config) => {
    // Custom prompt with its placeholder → accepted and live on config.
    store.update({ prompts: { askPrompt: 'Answer like a pirate: {question}' } });
    assert.equal(config.prompts.askPrompt, 'Answer like a pirate: {question}');
    assert.equal(store.describe().prompts.askPrompt.source, 'settings');

    // Missing placeholder → rejected with a message naming it.
    assert.throws(
      () => store.update({ prompts: { askPrompt: 'Answer like a pirate.' } }),
      (error) => error instanceof SettingsError && /\{question\}/.test(error.message),
    );
    assert.throws(
      () => store.update({ prompts: { interestingPrompt: 'Say something neat.' } }),
      (error) => error instanceof SettingsError && /\{context\}/.test(error.message),
    );

    // Clearing returns to the built-in: an emptied textarea saves '' (the
    // builders treat empty as "use the built-in"), and null (the API's
    // explicit clear) drops the override entirely.
    store.update({ prompts: { askPrompt: '' } });
    assert.equal(config.prompts.askPrompt, '');
    store.update({ prompts: { askPrompt: null } });
    assert.equal(store.describe().prompts.askPrompt.source, 'default');
    assert.equal(config.prompts.askPrompt, '');
  });
});

test('overrides apply to live config and persist to disk', () => {
  withStore((store, config, dir) => {
    store.update({ voice: { openAiTtsVoice: 'ash', openAiTtsSpeed: '1.3' } });

    assert.equal(config.voice.openAiTtsVoice, 'ash');
    assert.equal(config.voice.openAiTtsSpeed, 1.3);

    const stored = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(stored.voice.openAiTtsVoice, 'ash');

    // a fresh store over the same file re-applies the overrides
    const config2 = makeConfig();
    new SettingsStore({ filePath: join(dir, 'settings.json'), config: config2, env: {} }).load();
    assert.equal(config2.voice.openAiTtsVoice, 'ash');
  });
});

test('settings update reports changed field names only after a successful material change', () => {
  withStore((store) => {
    const updates = [];
    store.onUpdated = (fields) => updates.push(fields);

    store.update({ voice: { openAiTtsVoice: 'ash' }, server: { immichApiKey: 'secret-value' } });
    assert.deepEqual(updates, [['server.immichApiKey', 'voice.openAiTtsVoice']]);

    // Re-saving the exact values does not manufacture activity.
    store.update({ voice: { openAiTtsVoice: 'ash' }, server: { immichApiKey: 'secret-value' } });
    assert.equal(updates.length, 1);

    assert.throws(() => store.update({ voice: { ttsProvider: 'invalid-provider' } }), SettingsError);
    assert.equal(updates.length, 1, 'rejected updates emit no activity');
    assert.doesNotMatch(JSON.stringify(updates), /secret-value/);
  });
});

test('clearing an override falls back to the environment value', () => {
  withStore((store, config) => {
    store.update({ voice: { openAiTtsVoice: 'ash' } });
    store.update({ voice: { openAiTtsVoice: null } });
    assert.equal(config.voice.openAiTtsVoice, 'coral');
    assert.equal(store.describe().voice.openAiTtsVoice.source, 'default');
  });
});

test('describe reports provenance and never echoes secrets', () => {
  withStore((store) => {
    const before = store.describe();
    assert.equal(before.voice.ttsProvider.source, 'environment');
    assert.equal(before.server.openAiApiKey.value, '');
    assert.equal(before.server.openAiApiKey.configured, true);

    store.update({ voice: { ttsProvider: 'elevenlabs' } });
    const after = store.describe();
    assert.equal(after.voice.ttsProvider.source, 'settings');
    assert.equal(after.voice.ttsProvider.value, 'elevenlabs');
  });
});

test('the curate burst-grouping switch applies to live config and defaults on', () => {
  withStore((store, config) => {
    assert.equal(store.describe().curate.burstGrouping.value, true);
    store.update({ curate: { burstGrouping: false } });
    assert.equal(config.curateBurstGrouping, false);
    store.update({ curate: { burstGrouping: null } });
    assert.equal(config.curateBurstGrouping, true);
  });
});

test('the OpenAI key (server section) applies to both voice and cloud enrichment', () => {
  withStore((store, config) => {
    store.update({ server: { openAiApiKey: 'new-key' } });
    assert.equal(config.voice.openAiApiKey, 'new-key');
    assert.equal(config.providers.cloud_openai.apiKey, 'new-key');
  });
});

test('a legacy voice.openAiApiKey override migrates to the server section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({ version: 1, voice: { openAiApiKey: 'old-key' } }));
    const config = makeConfig();
    const store = new SettingsStore({ filePath: path, config, env: {} }).load();
    assert.equal(config.voice.openAiApiKey, 'old-key');
    assert.equal(config.providers.cloud_openai.apiKey, 'old-key');
    assert.equal(store.describe().server.openAiApiKey.source, 'settings');
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(stored.version, SETTINGS_VERSION);
    assert.equal(stored.server.openAiApiKey, 'old-key');
    assert.equal(Object.hasOwn(stored.voice, 'openAiApiKey'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('immich settings normalize URLs, re-point config, and fire onApplied', () => {
  withStore((store, config, dir) => {
    let applied = 0;
    store.onApplied = () => { applied += 1; };
    store.update({ server: { immichBaseUrl: 'http://new-immich:2283/api/', immichApiKey: 'k2' } });
    assert.equal(config.immichBaseUrl, 'http://new-immich:2283');
    assert.equal(config.immichApiKey, 'k2');
    // No public-URL override: it follows the server URL.
    assert.equal(config.immichPublicUrl, 'http://new-immich:2283');
    assert.equal(applied, 1);

    store.update({ server: { immichPublicUrl: 'https://photos.example.com' } });
    assert.equal(config.immichPublicUrl, 'https://photos.example.com');
    store.update({ server: { immichPublicUrl: null } });
    assert.equal(config.immichPublicUrl, 'http://new-immich:2283');
    assert.equal(applied, 3);

    // A scheme-less host gets http:// (the LAN default) instead of being
    // accepted broken; explicit https:// is untouched. The override is
    // normalized BEFORE storage, so describe() round-trips the corrected URL
    // back into the settings field.
    assert.throws(
      () => store.update({ server: { immichBaseUrl: 'immich.local:2283/' } }),
      /requires re-entering or clearing its API key/,
    );
    store.update({ server: { immichBaseUrl: 'immich.local:2283/', immichApiKey: null } });
    assert.equal(config.immichBaseUrl, 'http://immich.local:2283');
    assert.equal(config.immichApiKey, 'env-immich-key');
    const described = store.update({
      server: { immichBaseUrl: 'immich.local:2283/', immichApiKey: 'k3' },
    });
    assert.equal(config.immichBaseUrl, 'http://immich.local:2283');
    assert.equal(described.server.immichBaseUrl.value, 'http://immich.local:2283');
    store.update({
      server: { immichBaseUrl: 'https://immich.example.com/api', immichApiKey: 'k4' },
    });
    assert.equal(config.immichBaseUrl, 'https://immich.example.com');

    for (const invalid of ['file:///tmp/immich', 'https://user:pass@immich.example.com', 'https://immich.example.com/#fragment']) {
      assert.throws(
        () => store.update({ server: { immichBaseUrl: invalid, immichApiKey: 'replacement' } }),
        /HTTP or HTTPS/,
      );
    }

    const persistedBeforeUrlRejection = readFileSync(join(dir, 'settings.json'), 'utf8');
    for (const delimiter of ['?', '?target=internal', '#', '#fragment']) {
      assert.throws(
        () => store.update({
          server: { immichBaseUrl: `http://internal.invalid/chosen${delimiter}`, immichApiKey: 'replacement' },
        }),
        /without credentials, a query, or a fragment/,
      );
      assert.equal(config.immichBaseUrl, 'https://immich.example.com');
      assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), persistedBeforeUrlRejection);
    }
  });
});

test('an environment Immich key remains bound to its baseline authority', () => {
  withStore((store, config, dir) => {
    const settingsPath = join(dir, 'settings.json');
    const initialState = readFileSync(settingsPath, 'utf8');
    assert.throws(
      () => store.update({
        server: { immichBaseUrl: 'http://different-immich:2283', immichApiKey: null },
      }),
      /environment-backed Immich API key cannot be used with a Settings URL on a different server/,
    );
    assert.equal(config.immichBaseUrl, 'http://immich.local:2283');
    assert.equal(config.immichApiKey, 'env-immich-key');
    assert.equal(readFileSync(settingsPath, 'utf8'), initialState);

    store.update({
      server: { immichBaseUrl: 'http://immich.local:2283/photos', immichApiKey: null },
    });
    assert.equal(config.immichBaseUrl, 'http://immich.local:2283/photos');
    assert.equal(config.immichApiKey, 'env-immich-key');

    store.update({
      server: { immichBaseUrl: 'http://different-immich:2283', immichApiKey: 'replacement-key' },
    });
    const beforeRejectedClear = readFileSync(settingsPath, 'utf8');

    assert.throws(
      () => store.update({ server: { immichApiKey: null } }),
      /environment-backed Immich API key cannot be used with a Settings URL on a different server/,
    );
    assert.equal(config.immichBaseUrl, 'http://different-immich:2283');
    assert.equal(config.immichApiKey, 'replacement-key');
    assert.equal(readFileSync(settingsPath, 'utf8'), beforeRejectedClear);

    store.update({
      server: { immichBaseUrl: 'http://immich.local:2283', immichApiKey: null },
    });
    assert.equal(config.immichBaseUrl, 'http://immich.local:2283');
    assert.equal(config.immichApiKey, 'env-immich-key');

    store.update({ server: { immichApiKey: 'temporary-baseline-key' } });
    store.update({ server: { immichApiKey: null } });
    assert.equal(config.immichApiKey, 'env-immich-key');
  });
});

test('startup rejects an environment Immich key paired with a persisted non-baseline authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      version: SETTINGS_VERSION,
      credentialBindings: {},
      server: { immichBaseUrl: 'http://different-immich:2283' },
    }));
    const config = makeConfig();

    assert.throws(
      () => new SettingsStore({
        filePath: path,
        config,
        env: { IMMICH_BASE_URL: config.immichBaseUrl, IMMICH_API_KEY: config.immichApiKey },
      }).load(),
      /Before restarting, either set IMMICH_BASE_URL.*settings\.json/,
    );
    assert.equal(config.immichBaseUrl, 'http://immich.local:2283');
    assert.equal(config.immichApiKey, 'env-immich-key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enrichment provider fields write through to config.providers', () => {
  withStore((store, config, dir) => {
    store.update({
      enrich: {
        defaultProvider: 'local_lmstudio',
        lmStudioBaseUrl: 'http://10.0.0.5:1234/v1',
        lmStudioModel: 'qwen2.5-vl-7b',
        openAiCompatibleBaseUrl: 'http://llama.local:8080/v1/',
        openAiCompatibleModel: 'qwen-vision',
      },
    });
    assert.equal(config.defaultProvider, 'local_lmstudio');
    assert.equal(config.providers.local_lmstudio.baseUrl, 'http://10.0.0.5:1234/v1');
    assert.equal(config.providers.local_lmstudio.modelName, 'qwen2.5-vl-7b');
    assert.equal(config.providers.openai_compatible.baseUrl, 'http://llama.local:8080/v1');
    assert.equal(config.providers.openai_compatible.modelName, 'qwen-vision');
    const reloadedConfig = makeConfig();
    const reloaded = new SettingsStore({
      filePath: join(dir, 'settings.json'),
      config: reloadedConfig,
      env: { DEFAULT_PROVIDER: 'cloud_openai' },
    }).load();
    assert.equal(reloadedConfig.defaultProvider, 'local_lmstudio');
    assert.equal(reloaded.describe().enrich.defaultProvider.source, 'settings');
    assert.throws(() => store.update({ enrich: { defaultProvider: 'skynet' } }), SettingsError);

    store.update({
      enrich: {
        lmStudioBaseUrl: 'https://models.example/api/',
        ollamaLocalBaseUrl: 'https://ollama.example/api/',
      },
    });
    assert.equal(config.providers.local_lmstudio.baseUrl, 'https://models.example/api');
    assert.equal(config.providers.local_ollama.baseUrl, 'https://ollama.example/api');

    const persistedBeforeRejection = readFileSync(join(dir, 'settings.json'), 'utf8');
    for (const key of ['lmStudioBaseUrl', 'openAiCompatibleBaseUrl', 'ollamaLocalBaseUrl']) {
      for (const delimiter of ['?', '#']) {
        assert.throws(
          () => store.update({ enrich: { [key]: `http://internal.invalid/chosen${delimiter}` } }),
          /without credentials, a query, or a fragment/,
        );
      }
    }
    assert.equal(config.providers.local_lmstudio.baseUrl, 'https://models.example/api');
    assert.equal(config.providers.openai_compatible.baseUrl, 'http://llama.local:8080/v1');
    assert.equal(config.providers.local_ollama.baseUrl, 'https://ollama.example/api');
    assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), persistedBeforeRejection);
  });
});

test('inference host labels persist as bounded operator-authored run context', () => {
  withStore((store, config, dir) => {
    store.update({ enrich: { inferenceHostLabel: '  M4 Mac mini · LM Studio  ' } });
    assert.equal(config.inferenceHostLabel, 'M4 Mac mini · LM Studio');
    assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).enrich.inferenceHostLabel,
      'M4 Mac mini · LM Studio');
    assert.throws(
      () => store.update({ enrich: { inferenceHostLabel: 'x'.repeat(121) } }),
      /inferenceHostLabel is too long/,
    );
  }, { INFERENCE_HOST_LABEL: 'Environment host' });
});

test('environment-backed local-provider keys stay bound to their authorities', () => {
  withStore((store) => {
    assert.throws(
      () => store.update({ enrich: { lmStudioBaseUrl: 'http://attacker.example/v1' } }),
      /LM Studio has an environment-backed API key/,
    );
    assert.throws(
      () => store.update({ enrich: { ollamaLocalBaseUrl: 'http://attacker.example' } }),
      /Local Ollama has an environment-backed API key/,
    );
    assert.throws(
      () => store.update({ enrich: { openAiCompatibleBaseUrl: 'http://attacker.example/v1' } }),
      /OpenAI-compatible provider has an environment-backed API key/,
    );
  }, {
    LMSTUDIO_API_KEY: 'private-lm-proxy-token',
    OLLAMA_LOCAL_API_KEY: 'private-ollama-proxy-token',
    OPENAI_COMPATIBLE_API_KEY: 'private-compatible-proxy-token',
  });
});

test('a saved OpenAI-compatible key is bound to its configured destination', () => {
  withStore((store, config, dir) => {
    store.update({
      enrich: {
        openAiCompatibleBaseUrl: 'http://llama.local:8080/v1',
        openAiCompatibleApiKey: 'saved-compatible-key',
        openAiCompatibleModel: 'qwen-vision',
      },
    });
    assert.equal(config.providers.openai_compatible.apiKey, 'saved-compatible-key');
    assert.equal(config.providers.openai_compatible.modelName, 'qwen-vision');
    let saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.credentialBindings['enrich.openAiCompatibleApiKey'], 'http://llama.local:8080');

    store.update({ enrich: { openAiCompatibleBaseUrl: 'http://other.local:8080/v1' } });
    assert.equal(config.providers.openai_compatible.apiKey, '');
    assert.equal(store.describe().enrich.openAiCompatibleApiKey.credentialUnavailable, true);

    store.update({ enrich: { openAiCompatibleApiKey: 'replacement-key' } });
    assert.equal(config.providers.openai_compatible.apiKey, 'replacement-key');
    saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.credentialBindings['enrich.openAiCompatibleApiKey'], 'http://other.local:8080');
  });
});

test('startup binds newly provisioned local-provider keys to their environment authorities', () => {
  const cases = [
    {
      name: 'LM Studio',
      providerKey: 'local_lmstudio',
      urlKey: 'lmStudioBaseUrl',
      baselineUrl: 'http://127.0.0.1:1234/v1',
      savedUrl: 'http://attacker.example/v1',
      env: { LMSTUDIO_API_KEY: 'private-lm-proxy-token' },
    },
    {
      name: 'Local Ollama',
      providerKey: 'local_ollama',
      urlKey: 'ollamaLocalBaseUrl',
      baselineUrl: 'http://127.0.0.1:11434',
      savedUrl: 'http://attacker.example',
      env: { OLLAMA_LOCAL_API_KEY: 'private-ollama-proxy-token' },
    },
    {
      name: 'OpenAI-compatible provider',
      providerKey: 'openai_compatible',
      urlKey: 'openAiCompatibleBaseUrl',
      baselineUrl: '',
      savedUrl: 'http://attacker.example/v1',
      env: { OPENAI_COMPATIBLE_API_KEY: 'private-compatible-proxy-token' },
    },
  ];

  for (const provider of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, JSON.stringify({
        version: SETTINGS_VERSION,
        credentialBindings: {},
        enrich: { [provider.urlKey]: provider.savedUrl },
      }));
      const config = makeConfig();

      assert.throws(
        () => new SettingsStore({ filePath: path, config, env: provider.env }).load(),
        new RegExp(`environment-backed ${provider.name} API key cannot be used with the saved`),
      );
      assert.equal(config.providers[provider.providerKey].baseUrl, provider.baselineUrl);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('startup allows an environment local-provider key with a saved path on the same authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      version: SETTINGS_VERSION,
      credentialBindings: {},
      enrich: {
        lmStudioBaseUrl: 'http://127.0.0.1:1234/compatible/v1',
        ollamaLocalBaseUrl: 'http://127.0.0.1:11434/compatible',
        openAiCompatibleBaseUrl: 'http://llama.local:8080/compatible/v1',
      },
    }));
    const config = makeConfig();
    config.providers.openai_compatible.baseUrl = 'http://llama.local:8080/v1';

    new SettingsStore({
      filePath: path,
      config,
      env: {
        LMSTUDIO_API_KEY: 'private-lm-proxy-token',
        OLLAMA_LOCAL_API_KEY: 'private-ollama-proxy-token',
        OPENAI_COMPATIBLE_BASE_URL: 'http://llama.local:8080/v1',
        OPENAI_COMPATIBLE_API_KEY: 'private-compatible-proxy-token',
      },
    }).load();

    assert.equal(config.providers.local_lmstudio.baseUrl, 'http://127.0.0.1:1234/compatible/v1');
    assert.equal(config.providers.local_ollama.baseUrl, 'http://127.0.0.1:11434/compatible');
    assert.equal(config.providers.openai_compatible.baseUrl, 'http://llama.local:8080/compatible/v1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('version 2 migration binds a saved Immich destination but quarantines provider keys without provenance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      version: 2,
      server: {
        immichBaseUrl: 'http://immich.local:2283/library',
        immichApiKey: 'saved-immich-key',
      },
      enrich: {
        openRouterApiKey: 'saved-openrouter-key',
        ollamaApiKey: 'saved-ollama-key',
        veniceApiKey: 'saved-venice-key',
      },
    }));
    const config = makeConfig();
    const store = new SettingsStore({ filePath: path, config, env: {} }).load();

    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.version, SETTINGS_VERSION);
    assert.deepEqual(saved.credentialBindings, {
      'server.immichApiKey': 'http://immich.local:2283',
    });
    assert.equal(config.immichApiKey, 'saved-immich-key');
    assert.equal(config.providers.openrouter.apiKey, '');
    assert.equal(config.providers.cloud_ollama.apiKey, '');
    assert.equal(config.providers.venice.apiKey, '');
    assert.equal(store.describe().enrich.openRouterApiKey.credentialUnavailable, true);
    assert.equal(store.describe().enrich.ollamaApiKey.credentialUnavailable, true);
    assert.equal(store.describe().enrich.veniceApiKey.credentialUnavailable, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ambiguous version 2 credentials migrate quarantined instead of trusting changed environment destinations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      version: 2,
      server: { immichApiKey: 'saved-immich-key' },
      enrich: { openRouterApiKey: 'saved-router-key' },
    }));
    const config = makeConfig();
    config.immichBaseUrl = 'http://restored-immich.example:2283';
    config.providers.openrouter.baseUrl = 'https://restored-router.example/v1';

    const store = new SettingsStore({
      filePath: path,
      config,
      env: {
        IMMICH_BASE_URL: config.immichBaseUrl,
        OPENROUTER_BASE_URL: config.providers.openrouter.baseUrl,
      },
    }).load();

    assert.equal(config.immichApiKey, '');
    assert.equal(config.providers.openrouter.apiKey, '');
    assert.equal(store.describe().server.immichApiKey.credentialUnavailable, true);
    assert.equal(store.describe().enrich.openRouterApiKey.credentialUnavailable, true);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(saved.credentialBindings, {});
    assert.equal(saved.server.immichApiKey, 'saved-immich-key');
    assert.equal(saved.enrich.openRouterApiKey, 'saved-router-key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restored saved credentials quarantine on a changed destination authority', () => {
  const cases = [
    {
      id: 'server.immichApiKey',
      section: 'server',
      key: 'immichApiKey',
      original: 'http://old-immich.example:2283',
      changeConfig: (config) => { config.immichBaseUrl = 'http://new-immich.example:2283'; },
      readCredential: (config) => config.immichApiKey,
    },
    {
      id: 'enrich.openRouterApiKey',
      section: 'enrich',
      key: 'openRouterApiKey',
      original: 'https://old-router.example',
      changeConfig: (config) => { config.providers.openrouter.baseUrl = 'https://new-router.example/v1'; },
      readCredential: (config) => config.providers.openrouter.apiKey,
    },
    {
      id: 'enrich.ollamaApiKey',
      section: 'enrich',
      key: 'ollamaApiKey',
      original: 'https://old-ollama.example',
      changeConfig: (config) => { config.providers.cloud_ollama.baseUrl = 'https://new-ollama.example/api'; },
      readCredential: (config) => config.providers.cloud_ollama.apiKey,
    },
    {
      id: 'enrich.veniceApiKey',
      section: 'enrich',
      key: 'veniceApiKey',
      original: 'https://old-venice.example',
      changeConfig: (config) => { config.providers.venice.baseUrl = 'https://new-venice.example/v1'; },
      readCredential: (config) => config.providers.venice.apiKey,
    },
  ];

  for (const scenario of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, JSON.stringify({
        version: SETTINGS_VERSION,
        credentialBindings: { [scenario.id]: scenario.original },
        [scenario.section]: { [scenario.key]: 'saved-secret' },
      }));
      const config = makeConfig();
      scenario.changeConfig(config);

      const store = new SettingsStore({ filePath: path, config, env: {} }).load();
      const meta = store.describe()[scenario.section][scenario.key];
      assert.equal(scenario.readCredential(config), '', scenario.id);
      assert.equal(meta.configured, false, scenario.id);
      assert.equal(meta.credentialUnavailable, true, scenario.id);
      assert.equal(meta.boundAuthority, scenario.original, scenario.id);
      assert.match(meta.credentialNotice, /will not use it/, scenario.id);

      // An unrelated save must neither activate nor erase the quarantined key.
      store.update({ backup: { keep: 8 } });
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(saved[scenario.section][scenario.key], 'saved-secret', scenario.id);
      assert.equal(saved.credentialBindings[scenario.id], scenario.original, scenario.id);
      assert.equal(scenario.readCredential(config), '', scenario.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a quarantined Immich key can be re-entered, cleared, or recovered by restoring its authority', () => {
  const originalState = {
    version: SETTINGS_VERSION,
    credentialBindings: { 'server.immichApiKey': 'http://old-immich.example:2283' },
    server: { immichApiKey: 'saved-secret' },
  };

  const reenterDir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(reenterDir, 'settings.json');
    writeFileSync(path, JSON.stringify(originalState));
    const config = makeConfig();
    config.immichBaseUrl = 'https://old-immich.example:2283';
    const store = new SettingsStore({ filePath: path, config, env: {} }).load();

    assert.equal(config.immichApiKey, '', 'HTTP to HTTPS remains a distinct authority');
    store.update({ server: { immichApiKey: 'replacement-secret' } });
    assert.equal(config.immichApiKey, 'replacement-secret');
    assert.equal(store.describe().server.immichApiKey.credentialUnavailable, undefined);
    assert.equal(
      JSON.parse(readFileSync(path, 'utf8')).credentialBindings['server.immichApiKey'],
      'https://old-immich.example:2283',
    );
  } finally {
    rmSync(reenterDir, { recursive: true, force: true });
  }

  const clearDir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(clearDir, 'settings.json');
    writeFileSync(path, JSON.stringify(originalState));
    const config = makeConfig();
    config.immichBaseUrl = 'http://new-immich.example:2283';
    config.immichApiKey = '';
    const store = new SettingsStore({ filePath: path, config, env: {} }).load();

    store.update({ server: { immichApiKey: null } });
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(Object.hasOwn(saved.server, 'immichApiKey'), false);
    assert.equal(Object.hasOwn(saved.credentialBindings, 'server.immichApiKey'), false);
    assert.equal(config.immichApiKey, '');
  } finally {
    rmSync(clearDir, { recursive: true, force: true });
  }

  const restoreDir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(restoreDir, 'settings.json');
    writeFileSync(path, JSON.stringify(originalState));
    const config = makeConfig();
    config.immichBaseUrl = 'http://old-immich.example:2283/photos';

    const store = new SettingsStore({ filePath: path, config, env: {} }).load();
    assert.equal(config.immichApiKey, 'saved-secret');
    assert.equal(store.describe().server.immichApiKey.credentialUnavailable, undefined);
  } finally {
    rmSync(restoreDir, { recursive: true, force: true });
  }
});

test('a saved key with no effective destination stays quarantined with an actionable message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      version: SETTINGS_VERSION,
      credentialBindings: { 'server.immichApiKey': 'http://old-immich.example:2283' },
      server: { immichApiKey: 'saved-secret' },
    }));
    const config = makeConfig();
    config.immichBaseUrl = '';

    const store = new SettingsStore({ filePath: path, config, env: {} }).load();
    const meta = store.describe().server.immichApiKey;
    assert.equal(config.immichApiKey, '');
    assert.equal(meta.configured, false);
    assert.equal(meta.credentialUnavailable, true);
    assert.match(meta.credentialNotice, /no destination is configured/);
    assert.throws(
      () => store.update({ server: { immichApiKey: 'replacement' } }),
      /Configure the destination.*before saving/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved provider credentials remain usable when only the destination path changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      version: SETTINGS_VERSION,
      credentialBindings: { 'enrich.openRouterApiKey': 'https://router.example' },
      enrich: { openRouterApiKey: 'saved-secret' },
    }));
    const config = makeConfig();
    config.providers.openrouter.baseUrl = 'https://router.example/compatible/v1';

    assert.doesNotThrow(() => new SettingsStore({ filePath: path, config, env: {} }).load());
    assert.equal(config.providers.openrouter.apiKey, 'saved-secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-entering or clearing a saved credential refreshes or removes its binding', () => {
  withStore((store, config, dir) => {
    store.update({ server: { immichApiKey: 'old-key' } });
    store.update({
      server: {
        immichBaseUrl: 'https://new-immich.example/api',
        immichApiKey: 'new-key',
      },
    });
    store.update({ enrich: { openRouterApiKey: 'router-key' } });
    store.update({ enrich: { openRouterApiKey: null } });

    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.credentialBindings['server.immichApiKey'], 'https://new-immich.example');
    assert.equal(Object.hasOwn(saved.credentialBindings, 'enrich.openRouterApiKey'), false);

    const restartedConfig = makeConfig();
    new SettingsStore({
      filePath: join(dir, 'settings.json'),
      config: restartedConfig,
      env: {},
    }).load();
    assert.equal(restartedConfig.immichBaseUrl, 'https://new-immich.example');
    assert.equal(restartedConfig.immichApiKey, 'new-key');
    assert.equal(config.providers.openrouter.apiKey, '');
  });
});

test('prompt overrides write through to config and validate the tag placeholder', () => {
  withStore((store, config) => {
    store.update({ enrich: { systemPrompt: 'You are a careful photo classifier.' } });
    assert.equal(config.promptOverrides.systemPrompt, 'You are a careful photo classifier.');
    assert.equal(store.describe().enrich.systemPrompt.source, 'settings');

    store.update({ enrich: { userTemplate: 'Classify this. Tags: {approved_tags}' } });
    assert.equal(config.promptOverrides.userTemplate, 'Classify this. Tags: {approved_tags}');

    // The per-photo prompt is useless without the tag list placeholder.
    assert.throws(() => store.update({ enrich: { userTemplate: 'Classify this photo.' } }), SettingsError);
    assert.equal(config.promptOverrides.userTemplate, 'Classify this. Tags: {approved_tags}');

    // Clearing falls back to the built-in files (empty override).
    store.update({ enrich: { systemPrompt: null, userTemplate: null } });
    assert.equal(config.promptOverrides.systemPrompt, '');
    assert.equal(config.promptOverrides.userTemplate, '');

    // The generous multiline cap still has a ceiling.
    assert.throws(() => store.update({ enrich: { systemPrompt: 'x'.repeat(20001) } }), SettingsError);
  });
});

test('boolean fields coerce strings and reject junk', () => {
  withStore((store, config) => {
    store.update({ ambient: { immichMetadataWriteback: true } });
    assert.equal(config.ambient.immichMetadataWriteback, true);
    store.update({ ambient: { immichMetadataWriteback: 'false' } });
    assert.equal(config.ambient.immichMetadataWriteback, false);
    assert.throws(() => store.update({ ambient: { immichMetadataWriteback: 'maybe' } }), SettingsError);
  });
});

test('rejects unknown fields, bad enums, and out-of-range numbers', () => {
  withStore((store) => {
    assert.throws(() => store.update({ voice: { nope: 'x' } }), SettingsError);
    assert.throws(() => store.update({ voice: { ttsProvider: 'siri' } }), SettingsError);
    assert.throws(() => store.update({ voice: { openAiTtsSpeed: 9 } }), SettingsError);
    assert.throws(() => store.update({ other: {} }), SettingsError);
    // a failed update leaves prior state untouched
    assert.equal(store.describe().voice.ttsProvider.value, 'openai');
  });
});

test('settings patches reject inherited and prototype-special keys without changing state', () => {
  withStore((store, config, dir) => {
    const settingsPath = join(dir, 'settings.json');
    const persistedBefore = readFileSync(settingsPath, 'utf8');
    const configBefore = structuredClone(config);
    const constructorBefore = Object.getOwnPropertyDescriptor(Object.prototype, 'constructor');
    let applied = 0;
    let updated = 0;
    store.onApplied = () => { applied += 1; };
    store.onUpdated = () => { updated += 1; };

    for (const source of [
      '{"server":{"constructor":"persisted-poison"}}',
      '{"server":{"toString":"persisted-poison"}}',
      '{"server":{"__proto__":"persisted-poison"}}',
      '{"server":{"prototype":"persisted-poison"}}',
      '{"__proto__":{"constructor":"prototype-poison"}}',
      '{"constructor":{"prototype":"prototype-poison"}}',
      '{"prototype":{"polluted":true}}',
    ]) {
      assert.throws(() => store.update(JSON.parse(source)), SettingsError, source);
    }

    const inheritedRoot = Object.create({ voice: { openAiTtsVoice: 'ash' } });
    assert.throws(() => store.update(inheritedRoot), /Settings patch must be an object/);
    const inheritedSection = Object.create({ openAiTtsVoice: 'ash' });
    assert.throws(() => store.update({ voice: inheritedSection }), /Settings for voice must be an object/);

    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'constructor'), constructorBefore);
    assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
    assert.deepEqual(config, configBefore);
    assert.equal(readFileSync(settingsPath, 'utf8'), persistedBefore);
    assert.equal(applied, 0);
    assert.equal(updated, 0);

    store.update({ voice: { openAiTtsVoice: 'ash' } });
    assert.doesNotThrow(() => migrateSettingsState(JSON.parse(readFileSync(settingsPath, 'utf8'))));
    store.update({ voice: { openAiTtsVoice: null } });
    assert.doesNotThrow(() => migrateSettingsState(JSON.parse(readFileSync(settingsPath, 'utf8'))));
    assert.equal(config.voice.openAiTtsVoice, 'coral');
  });
});

test('location groups: validated, normalized, persisted, clearable', () => {
  withStore((store, config, dir) => {
    store.update({
      insights: {
        locationGroups: [
          { name: ' Bay Area ', cities: ['San Francisco', 'Burlingame', ' Burlingame ', ''] },
          { name: 'Jackson Hole', cities: ['Jackson', 'Moose Wilson Road'] },
        ],
      },
    });
    assert.deepEqual(config.insights.locationGroups, [
      { name: 'Bay Area', cities: ['San Francisco', 'Burlingame'] },
      { name: 'Jackson Hole', cities: ['Jackson', 'Moose Wilson Road'] },
    ]);
    const stored = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(stored.insights.locationGroups.length, 2);

    // Invalid shapes are rejected without touching prior state.
    assert.throws(() => store.update({ insights: { locationGroups: 'nope' } }), SettingsError);
    assert.throws(() => store.update({ insights: { locationGroups: [{ name: '', cities: ['X'] }] } }), SettingsError);
    assert.throws(() => store.update({ insights: { locationGroups: [{ name: 'Empty', cities: [] }] } }), SettingsError);
    assert.throws(() => store.update({
      insights: {
        locationGroups: [
          { name: 'A', cities: ['Oakland'] },
          { name: 'B', cities: ['Oakland'] }, // same city twice
        ],
      },
    }), SettingsError);
    assert.throws(() => store.update({
      insights: {
        locationGroups: [
          { name: 'Same', cities: ['X'] },
          { name: 'same', cities: ['Y'] }, // duplicate name (case-insensitive)
        ],
      },
    }), SettingsError);
    assert.equal(config.insights.locationGroups.length, 2);

    // null clears the override back to the default (none).
    store.update({ insights: { locationGroups: null } });
    assert.deepEqual(config.insights.locationGroups, []);
  });
});

// --- taxonomy override ---

const BUILTIN_TAXONOMY = {
  version: 'v1',
  categories: {
    scene: ['ai/scene/mountains', 'ai/scene/beach'],
    quality: ['ai/quality/sharp'],
  },
  thresholds: { frame_worthy: 0.78 },
  hard_exclusion_tags: [],
};

function withTaxonomyStore(work) {
  return withStore((store, config, dir) => {
    config.taxonomyPath = join(dir, 'taxonomy.json');
    writeFileSync(config.taxonomyPath, JSON.stringify(BUILTIN_TAXONOMY));
    return work(store, config, dir);
  });
}

test('taxonomy override: rejects invalid JSON and structural errors', () => {
  withTaxonomyStore((store) => {
    assert.throws(() => store.update({ enrich: { taxonomyJson: '{not json' } }), SettingsError);
    assert.throws(
      () => store.update({ enrich: { taxonomyJson: JSON.stringify({ version: 'v2', categories: { scene: 'nope' } }) } }),
      SettingsError,
    );
    assert.throws(
      () => store.update({ enrich: { taxonomyJson: JSON.stringify({ ...BUILTIN_TAXONOMY, version: '' }) } }),
      SettingsError,
    );
    // A tag without a namespace fails the shared tag-shape validation.
    const badTag = structuredClone(BUILTIN_TAXONOMY);
    badTag.version = 'v2';
    badTag.categories.scene.push('mountains');
    assert.throws(() => store.update({ enrich: { taxonomyJson: JSON.stringify(badTag) } }), SettingsError);
  });
});

test('taxonomy override: a content change must bump the version', () => {
  withTaxonomyStore((store, config) => {
    const edited = structuredClone(BUILTIN_TAXONOMY);
    edited.categories.scene.push('ai/scene/desert');

    // Same version + changed content vs the built-in file: rejected.
    assert.throws(() => store.update({ enrich: { taxonomyJson: JSON.stringify(edited) } }), /version/);

    // Bumped version: accepted and applied to live config.
    edited.version = 'v1-custom1';
    store.update({ enrich: { taxonomyJson: JSON.stringify(edited) } });
    assert.ok(config.taxonomyOverrideJson.includes('ai/scene/desert'));

    // Second edit against the previous override needs its own bump too.
    const edited2 = structuredClone(edited);
    edited2.categories.scene.push('ai/scene/forest');
    assert.throws(() => store.update({ enrich: { taxonomyJson: JSON.stringify(edited2) } }), /version/);
    edited2.version = 'v1-custom2';
    store.update({ enrich: { taxonomyJson: JSON.stringify(edited2) } });
    assert.ok(config.taxonomyOverrideJson.includes('v1-custom2'));

    // Re-saving identical content (reformatted, keys reordered) is fine.
    const reordered = { thresholds: edited2.thresholds, version: edited2.version, categories: edited2.categories, hard_exclusion_tags: [] };
    store.update({ enrich: { taxonomyJson: JSON.stringify(reordered, null, 2) } });

    // Clearing returns to the built-in taxonomy.
    store.update({ enrich: { taxonomyJson: null } });
    assert.equal(config.taxonomyOverrideJson, '');
  });
});

test('supporter key: valid keys store as a secret, bad keys are rejected, null clears', () => {
  // Throwaway keypair via the module's env override — the production
  // private key never comes anywhere near tests.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.env.PICTARIA_SUPPORT_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' });
  try {
    const payloadText = Buffer.from(JSON.stringify({ v: 1, tier: 'patron', id: 'TESTKEY9', iat: '2026-07-20' }), 'utf8').toString('base64url');
    const signature = sign(null, Buffer.from(payloadText, 'ascii'), privateKey).toString('base64url');
    const token = `PICTARIA.${payloadText}.${signature}`;

    withStore((store, config) => {
      assert.throws(() => store.update({ support: { supporterKey: 'PICTARIA.not.real' } }), SettingsError);
      const described = store.update({ support: { supporterKey: token } });
      assert.equal(config.supporterKey, token);
      assert.equal(described.support.supporterKey.configured, true);
      assert.equal(described.support.supporterKey.value, ''); // secret: never echoed
      store.update({ support: { supporterKey: null } });
      assert.equal(config.supporterKey ?? '', '');
    });
  } finally {
    delete process.env.PICTARIA_SUPPORT_PUBLIC_KEY;
  }
});

test('the legacy ask-model override stays OpenAI-only and never follows a provider switch', () => {
  // Migrating it into the neutral `askModel` would make an OpenAI model
  // name win over whatever model a newly selected provider is configured
  // with — the exact trap the per-command/provider split exists to avoid.
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      voice: { openAiAskModel: 'gpt-4o-mini', openAiAskMaxOutputTokens: 750 },
    }));
    const config = makeConfig();
    const store = new SettingsStore({ filePath: path, config, env: {} }).load();

    // The neutral field stays empty, so a non-OpenAI provider keeps its own model.
    assert.equal(store.describe().voice.askModel.value, '');
    assert.equal(config.voice.openAiAskModel, 'gpt-4o-mini', 'still applies on OpenAI');
    // The token budget IS provider-neutral, so that one does migrate.
    assert.equal(config.voice.askMaxOutputTokens, 750);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(stored.version, SETTINGS_VERSION);
    assert.equal(stored.voice.openAiAskModel, 'gpt-4o-mini');
    assert.equal(stored.voice.askMaxOutputTokens, 750);
    assert.equal(Object.hasOwn(stored.voice, 'openAiAskMaxOutputTokens'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the version 1 fixture migrates deterministically without mutating its input', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/upgrades/settings-v1-legacy.json', import.meta.url), 'utf8'));
  const original = structuredClone(fixture);

  const first = migrateSettingsState(fixture);
  const second = migrateSettingsState(first.state);

  assert.deepEqual(fixture, original);
  assert.equal(first.from, 1);
  assert.equal(first.to, SETTINGS_VERSION);
  assert.equal(first.migrated, true);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.state, first.state);
  assert.equal(first.state.server.openAiApiKey, 'fixture-openai-key');
  assert.equal(first.state.voice.askMaxOutputTokens, 750);
  assert.equal(first.state.voice.openAiAskModel, 'gpt-4o-mini');
});

test('version 3 settings migrate through version 5 without inventing provider configuration', () => {
  const migrated = migrateSettingsState({
    version: 3,
    credentialBindings: {},
    enrich: { defaultProvider: 'local_lmstudio' },
  });

  assert.equal(migrated.from, 3);
  assert.equal(migrated.to, 5);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.state.enrich.defaultProvider, 'local_lmstudio');
  assert.equal(Object.hasOwn(migrated.state.enrich, 'openAiCompatibleBaseUrl'), false);
});

test('version 4 settings migrate to version 5 without inventing an inference host label', () => {
  const migrated = migrateSettingsState({
    version: 4,
    credentialBindings: {},
    enrich: { defaultProvider: 'local_lmstudio' },
  });

  assert.equal(migrated.from, 4);
  assert.equal(migrated.to, 5);
  assert.equal(migrated.migrated, true);
  assert.equal(Object.hasOwn(migrated.state.enrich, 'inferenceHostLabel'), false);
});

test('a migrated settings document survives another save and restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-settings-'));
  try {
    const path = join(dir, 'settings.json');
    const fixture = readFileSync(new URL('./fixtures/upgrades/settings-v1-legacy.json', import.meta.url), 'utf8');
    writeFileSync(path, fixture, { mode: 0o600 });

    const config = makeConfig();
    const store = new SettingsStore({ filePath: path, config, env: {} }).load();
    store.update({ voice: { openAiTtsVoice: 'ash' } });

    const restartedConfig = makeConfig();
    const restarted = new SettingsStore({ filePath: path, config: restartedConfig, env: {} }).load();
    assert.equal(restartedConfig.voice.openAiApiKey, 'fixture-openai-key');
    assert.equal(restartedConfig.voice.openAiAskModel, 'gpt-4o-mini');
    assert.equal(restartedConfig.voice.askMaxOutputTokens, 750);
    assert.equal(restartedConfig.voice.openAiTtsVoice, 'ash');
    assert.equal(restarted.describe().server.openAiApiKey.value, '');
    assert.equal(restarted.describe().server.openAiApiKey.configured, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('future settings versions fail closed with an actionable upgrade message', () => {
  assert.throws(
    () => migrateSettingsState({ version: SETTINGS_VERSION + 1 }),
    /newer than this Pictaria Server supports.*upgrade the server/,
  );
});

test('unknown same-version fields fail with downgrade-safe guidance', () => {
  assert.throws(
    () => migrateSettingsState({
      version: SETTINGS_VERSION,
      credentialBindings: {},
      enrich: { futureProviderSetting: 'future-value' },
    }),
    /may have been written by a newer Pictaria Server.*upgrade the server rather than deleting the setting/,
  );
});

test('the persisted settings contract matches the frozen version 5 snapshot', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/upgrades/settings-contract-v5.json', import.meta.url), 'utf8'));
  assert.deepEqual(settingsContract(), expected);
});

test('the voice budget cannot be set below what it takes to reach a model', () => {
  withStore((store) => {
    // The commands short-circuit to the spoken fallback under 1500 ms, so
    // accepting 1000 would offer a setting that never calls a provider.
    assert.throws(
      () => store.update({ voice: { proseTimeoutMs: 1000 } }),
      (error) => error instanceof SettingsError && /between 2000 and 40000/.test(error.message),
    );
    store.update({ voice: { proseTimeoutMs: 2000 } });
    assert.throws(() => store.update({ voice: { proseTimeoutMs: 45000 } }), SettingsError);
  });
});

test('the env path cannot bypass the voice-budget range Settings enforces', async () => {
  // Compose forwards VOICE_PROSE_TIMEOUT_MS, so .env is a supported
  // deployment path: a value below the commands' short-circuit would
  // silently disable model use, and one above the Frame's abort would
  // guarantee a discarded answer.
  const { loadConfig } = await import('../src/config.mjs');
  assert.equal(loadConfig({ VOICE_PROSE_TIMEOUT_MS: '1000' }).voice.proseTimeoutMs, 2000);
  assert.equal(loadConfig({ VOICE_PROSE_TIMEOUT_MS: '0' }).voice.proseTimeoutMs, 2000);
  assert.equal(loadConfig({ VOICE_PROSE_TIMEOUT_MS: '120000' }).voice.proseTimeoutMs, 40000);
  // Values inside the range pass through untouched.
  assert.equal(loadConfig({ VOICE_PROSE_TIMEOUT_MS: '9000' }).voice.proseTimeoutMs, 9000);
  assert.equal(loadConfig({}).voice.proseTimeoutMs, 25000);
});
