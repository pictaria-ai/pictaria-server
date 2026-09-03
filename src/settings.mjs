import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

import { writePrivateFileAtomicSync } from './atomicFile.mjs';
import { parseBoundedJsonFileSync } from './boundedFile.mjs';
import { normalizeBaseUrl, normalizeHttpUrl } from './config.mjs';
import { loadTaxonomy, parseTaxonomySource } from './enrich/taxonomy.mjs';
import { parseSupporterKey } from './support/supporterKey.mjs';

// UI-editable settings, persisted to data/settings.json. Precedence:
// settings.json override → environment → built-in default. Overrides are
// applied by mutating the live config object, so changes take effect without
// a restart. Only the fields declared here are editable.
//
// Fields whose value doesn't live at config[section][key] declare a `read`
// (baseline for env/default fallback) and an `apply` (write-through). Port,
// data paths, and APP_PASSWORD deliberately stay environment-only.

export const MAX_SETTINGS_STATE_BYTES = 2 * 1024 * 1024;

const SERVER_FIELDS = {
  immichBaseUrl: {
    env: 'IMMICH_BASE_URL',
    label: 'Immich server URL',
    normalize: normalizeImmichSettingUrl,
    read: (config) => config.immichBaseUrl,
    apply: (config, value) => {
      config.immichBaseUrl = normalizeBaseUrl(value);
    },
  },
  immichPublicUrl: {
    env: 'IMMICH_PUBLIC_URL',
    label: 'Immich public URL',
    normalize: normalizeImmichSettingUrl,
    // Baseline is the env var alone (not the loadConfig fallback), so the
    // apply below can keep following the server URL when this is unset.
    read: (config, env) => normalizeBaseUrl(env.IMMICH_PUBLIC_URL || ''),
    apply: (config, value) => {
      config.immichPublicUrl = normalizeBaseUrl(value) || config.immichBaseUrl;
    },
  },
  immichApiKey: {
    env: 'IMMICH_API_KEY',
    label: 'Immich API key',
    secret: true,
    read: (config) => config.immichApiKey,
    apply: (config, value) => {
      config.immichApiKey = value;
    },
  },
  openAiApiKey: {
    env: 'OPENAI_API_KEY',
    label: 'OpenAI API key',
    secret: true,
    // One key, three consumers: voice TTS/answers, cloud enrichment, Q&A.
    read: (config) => config.voice.openAiApiKey,
    apply: (config, value) => {
      config.voice.openAiApiKey = value;
      config.providers.cloud_openai.apiKey = value;
    },
  },
};

const ENRICH_FIELDS = {
  enabled: {
    env: 'ENRICH_ENABLED',
    label: 'Enable AI enrichment',
    boolean: true,
    read: (config) => config.enrichEnabled,
    apply: (config, value) => {
      config.enrichEnabled = Boolean(value);
    },
  },
  captionWriteback: {
    env: 'CAPTION_WRITEBACK',
    label: 'Write captions to Immich descriptions',
    boolean: true,
    read: (config) => config.captionWriteback,
    apply: (config, value) => {
      config.captionWriteback = Boolean(value);
    },
  },
  defaultProvider: {
    env: 'DEFAULT_PROVIDER',
    label: 'Selected provider',
    // Enum order is dropdown order: local options first, then cloud,
    // alphabetical within each group.
    enum: ['local_lmstudio', 'local_ollama', 'openai_compatible', 'cloud_ollama', 'cloud_openai', 'openrouter', 'venice'],
    read: (config) => config.defaultProvider,
    apply: (config, value) => {
      config.defaultProvider = value;
    },
  },
  imageSource: {
    env: 'IMAGE_SOURCE',
    label: 'Image size sent to models',
    enum: ['preview', 'thumbnail', 'original'],
    read: (config) => config.imageSource,
    apply: (config, value) => {
      config.imageSource = value;
    },
  },
  inferenceHostLabel: {
    env: 'INFERENCE_HOST_LABEL',
    label: 'Inference host label',
    maxLength: 120,
    read: (config) => config.inferenceHostLabel,
    apply: (config, value) => {
      config.inferenceHostLabel = value;
    },
  },
  openAiModel: {
    env: 'OPENAI_MODEL',
    label: 'OpenAI model',
    read: (config) => config.providers.cloud_openai.modelName,
    apply: (config, value) => {
      config.providers.cloud_openai.modelName = value;
    },
  },
  lmStudioBaseUrl: {
    env: 'LMSTUDIO_BASE_URL',
    label: 'LM Studio base URL',
    normalize: normalizeHttpSettingUrl,
    read: (config) => config.providers.local_lmstudio.baseUrl,
    apply: (config, value) => {
      config.providers.local_lmstudio.baseUrl = normalizeHttpSettingUrl(value);
    },
  },
  lmStudioModel: {
    env: 'LMSTUDIO_MODEL',
    label: 'LM Studio model',
    read: (config) => config.providers.local_lmstudio.modelName,
    apply: (config, value) => {
      config.providers.local_lmstudio.modelName = value;
    },
  },
  openAiCompatibleBaseUrl: {
    env: 'OPENAI_COMPATIBLE_BASE_URL',
    label: 'OpenAI-compatible base URL',
    normalize: normalizeHttpSettingUrl,
    read: (config) => config.providers.openai_compatible.baseUrl,
    apply: (config, value) => {
      config.providers.openai_compatible.baseUrl = normalizeHttpSettingUrl(value);
    },
  },
  openAiCompatibleApiKey: {
    env: 'OPENAI_COMPATIBLE_API_KEY',
    label: 'OpenAI-compatible API key',
    secret: true,
    read: (config) => config.providers.openai_compatible.apiKey,
    apply: (config, value) => {
      config.providers.openai_compatible.apiKey = value;
    },
  },
  openAiCompatibleModel: {
    env: 'OPENAI_COMPATIBLE_MODEL',
    label: 'OpenAI-compatible model',
    read: (config) => config.providers.openai_compatible.modelName,
    apply: (config, value) => {
      config.providers.openai_compatible.modelName = value;
    },
  },
  ollamaLocalBaseUrl: {
    env: 'OLLAMA_LOCAL_BASE_URL',
    label: 'Ollama (local) base URL',
    normalize: normalizeHttpSettingUrl,
    read: (config) => config.providers.local_ollama.baseUrl,
    apply: (config, value) => {
      config.providers.local_ollama.baseUrl = normalizeHttpSettingUrl(value);
    },
  },
  ollamaLocalModel: {
    env: 'OLLAMA_LOCAL_MODEL',
    label: 'Ollama (local) model',
    read: (config) => config.providers.local_ollama.modelName,
    apply: (config, value) => {
      config.providers.local_ollama.modelName = value;
    },
  },
  openRouterApiKey: {
    env: 'OPENROUTER_API_KEY',
    label: 'OpenRouter API key',
    secret: true,
    read: (config) => config.providers.openrouter.apiKey,
    apply: (config, value) => {
      config.providers.openrouter.apiKey = value;
    },
  },
  openRouterModel: {
    env: 'OPENROUTER_MODEL',
    label: 'OpenRouter model',
    read: (config) => config.providers.openrouter.modelName,
    apply: (config, value) => {
      config.providers.openrouter.modelName = value;
    },
  },
  ollamaApiKey: {
    env: 'OLLAMA_API_KEY',
    label: 'Ollama API key',
    secret: true,
    read: (config) => config.providers.cloud_ollama.apiKey,
    apply: (config, value) => {
      config.providers.cloud_ollama.apiKey = value;
    },
  },
  ollamaModel: {
    env: 'OLLAMA_MODEL',
    label: 'Ollama model',
    read: (config) => config.providers.cloud_ollama.modelName,
    apply: (config, value) => {
      config.providers.cloud_ollama.modelName = value;
    },
  },
  veniceApiKey: {
    env: 'VENICE_API_KEY',
    label: 'Venice API key',
    secret: true,
    read: (config) => config.providers.venice.apiKey,
    apply: (config, value) => {
      config.providers.venice.apiKey = value;
    },
  },
  veniceModel: {
    env: 'VENICE_MODEL',
    label: 'Venice model',
    read: (config) => config.providers.venice.modelName,
    apply: (config, value) => {
      config.providers.venice.modelName = value;
    },
  },
  // Prompt overrides. Empty means the built-in prompt files (prompts/ dir)
  // are used; a run with either override set records prompt version
  // "<version>-custom" so history stays honest.
  systemPrompt: {
    label: 'System prompt override',
    multiline: true,
    maxLength: 20000,
    read: () => '',
    apply: (config, value) => {
      (config.promptOverrides ??= {}).systemPrompt = value;
    },
  },
  userTemplate: {
    label: 'Per-photo prompt override',
    multiline: true,
    maxLength: 20000,
    validate: (value) => {
      if (value && !value.includes('{approved_tags}')) {
        throw new SettingsError('The per-photo prompt must include {approved_tags} — that placeholder is replaced with the taxonomy tag list.');
      }
    },
    read: () => '',
    apply: (config, value) => {
      (config.promptOverrides ??= {}).userTemplate = value;
    },
  },
  // Taxonomy override: the full taxonomy as strict JSON, validated with the
  // same loader as the shipped file. Empty means the built-in taxonomy.
  // A content change must bump `version` — run history and the
  // skip-already-enriched logic are keyed on it, so reusing a version would
  // silently mix old and new results under one label.
  taxonomyJson: {
    label: 'Taxonomy override',
    multiline: true,
    maxLength: 200000,
    read: () => '',
    validate: (value, store) => validateTaxonomyOverride(value, store),
    apply: (config, value) => {
      config.taxonomyOverrideJson = value;
    },
  },
};

export function validateTaxonomyOverride(value, store) {
  if (!value) {
    return; // cleared: back to the built-in taxonomy
  }
  let candidate;
  try {
    candidate = parseTaxonomySource(value);
  } catch (error) {
    throw new SettingsError(`Taxonomy rejected: ${error.message}`);
  }
  if (!candidate.version) {
    throw new SettingsError('The taxonomy needs a non-empty "version" string.');
  }
  if (!store) {
    return;
  }
  // Compare against what is in force right now (previous override, else the
  // shipped file). If that baseline is unreadable there is nothing to hold
  // the candidate against — the candidate itself already validated.
  let previous;
  try {
    const previousText = store.overrides?.enrich?.taxonomyJson;
    previous = previousText ? parseTaxonomySource(previousText) : loadTaxonomy(store.config.taxonomyPath);
  } catch {
    return;
  }
  if (candidate.version === previous.version
    && canonicalTaxonomyContent(candidate.raw) !== canonicalTaxonomyContent(previous.raw)) {
    throw new SettingsError(
      `The taxonomy content changed but "version" is still ${JSON.stringify(previous.version)} — bump it (for example "${previous.version}-custom1") so run history and re-enrichment can tell old results from new.`,
    );
  }
}

// Key-order-insensitive content fingerprint, ignoring the version field.
function canonicalTaxonomyContent(raw) {
  const { version, ...rest } = raw;
  return stableStringify(rest);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Weather itself needs no configuration (forecasts come from Open-Meteo,
// keyless); this section is about turning photo GPS into place names.
const AMBIENT_FIELDS = {
  geocodingProvider: { env: 'GEOCODING_PROVIDER', label: 'Geocoding provider', enum: ['', 'geoapify'] },
  geoapifyApiKey: { env: 'GEOAPIFY_API_KEY', label: 'Geoapify API key', secret: true },
  immichMetadataWriteback: { env: 'IMMICH_METADATA_WRITEBACK', label: 'Write location labels back to Immich', boolean: true },
};

const VOICE_FIELDS = {
  // Who answers the two spoken-prose commands ("what's interesting about
  // this photo" and "tell me …"), and with which model. One provider
  // shared by both; models per command, because describing a photo and
  // answering a spoken question want very different sizes.
  proseProvider: {
    env: 'VOICE_PROSE_PROVIDER',
    label: 'Voice answer provider',
    enum: ['cloud_openai', 'local_lmstudio', 'local_ollama', 'openai_compatible', 'cloud_ollama', 'openrouter', 'venice'],
  },
  interestingModel: { env: 'VOICE_INTERESTING_MODEL', label: 'Interesting model' },
  askModel: { env: 'VOICE_ASK_MODEL', label: 'Ask model' },
  // OpenAI's own per-command defaults, used only when the provider IS
  // OpenAI and the neutral model above is empty. Kept as fields (not shown
  // in the UI) so overrides saved before the provider choice existed keep
  // working exactly as they did.
  openAiInterestingModel: { env: 'OPENAI_INTERESTING_MODEL', label: 'OpenAI interesting model' },
  openAiAskModel: { env: 'OPENAI_ASK_MODEL', label: 'OpenAI ask model' },
  proseTimeoutMs: {
    // Capped below the Frame's own abort (45s for "interesting"): a longer
    // budget only guarantees the frame throws away an answer that arrives.
    env: 'VOICE_PROSE_TIMEOUT_MS',
    label: 'Voice answer timeout (ms)',
    // Floor sits above the commands' 1500ms short-circuit: below that they
    // would answer with the fallback line without ever asking a model, so
    // accepting such a value would be offering a setting that cannot work.
    number: { min: 2000, max: 40000 },
  },
  // The token budgets are deliberately settings: if spoken answers come
  // through clipped, raise them here — no code change.
  interestingMaxOutputTokens: { env: 'OPENAI_INTERESTING_MAX_OUTPUT_TOKENS', label: 'Interesting answer budget (max output tokens)', number: { min: 50, max: 4000 } },
  askMaxOutputTokens: { env: 'OPENAI_ASK_MAX_OUTPUT_TOKENS', label: 'Ask answer budget (max output tokens)', number: { min: 50, max: 4000 } },
  ttsProvider: { env: 'TTS_PROVIDER', label: 'TTS provider', enum: ['', 'openai', 'elevenlabs'] },
  openAiTtsModel: { env: 'OPENAI_TTS_MODEL', label: 'OpenAI TTS model' },
  openAiTtsVoice: { env: 'OPENAI_TTS_VOICE', label: 'OpenAI TTS voice' },
  openAiTtsSpeed: { env: 'OPENAI_TTS_SPEED', label: 'Speech speed', number: { min: 0.5, max: 2 } },
  openAiTtsInstructions: { env: 'OPENAI_TTS_INSTRUCTIONS', label: 'Voice instructions' },
  elevenLabsApiKey: { env: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', secret: true },
  elevenLabsTtsModel: { env: 'ELEVENLABS_TTS_MODEL', label: 'ElevenLabs model' },
  elevenLabsVoiceId: { env: 'ELEVENLABS_VOICE_ID', label: 'ElevenLabs voice ID' },
  elevenLabsOutputFormat: { env: 'ELEVENLABS_OUTPUT_FORMAT', label: 'ElevenLabs output format' },
};

// Voice prompt overrides (Settings → Prompts). Empty = built-in template.
// Each override must keep its {placeholder}: that is where the server
// injects the machine-supplied part, and a prompt without it would silently
// answer with no metadata (interesting) or no question (ask).
const PROMPTS_FIELDS = {
  interestingPrompt: {
    label: 'Interesting prompt override',
    multiline: true,
    maxLength: 8000,
    validate: (value) => requirePromptPlaceholder(value, 'interestingPrompt', '{context}', "the photo's date/location/filename lines"),
  },
  askPrompt: {
    label: 'Tell Me prompt override',
    multiline: true,
    maxLength: 8000,
    validate: (value) => requirePromptPlaceholder(value, 'askPrompt', '{question}', 'the spoken question'),
  },
};

function requirePromptPlaceholder(value, key, placeholder, meaning) {
  if (value && !value.includes(placeholder)) {
    throw new SettingsError(`${key} must include ${placeholder} — it is replaced with ${meaning}.`);
  }
}

// The favorites tag redefines the Insights "Favorites" tile for libraries
// curated with tags instead of Immich hearts. Id and value travel together;
// the value is only for display.
const INSIGHTS_FIELDS = {
  favoritesTagId: { env: 'INSIGHTS_FAVORITES_TAG_ID', label: 'Favorites tag ID' },
  favoritesTagValue: { env: 'INSIGHTS_FAVORITES_TAG_VALUE', label: 'Favorites tag' },
  refreshIntervalHours: { env: 'INSIGHTS_REFRESH_HOURS', label: 'Auto-refresh interval (hours)', number: { min: 1, max: 720 } },
  // Trip detection thresholds; recomputed at the next Insights refresh.
  tripAwayKm: { env: 'INSIGHTS_TRIP_AWAY_KM', label: 'Trip distance from home (km)', number: { min: 10, max: 5000 } },
  tripGapDays: { env: 'INSIGHTS_TRIP_GAP_DAYS', label: 'Quiet days allowed inside a trip', number: { min: 0, max: 30 } },
  tripMinDays: { env: 'INSIGHTS_TRIP_MIN_DAYS', label: 'Minimum trip length (days)', number: { min: 1, max: 30 } },
  // User-defined synthetic locations: [{ name, cities: [...] }]. The sweep
  // keeps raw Immich cities; grouping is applied at query time, so editing
  // groups never requires a resweep.
  locationGroups: { label: 'Location groups', json: normalizeLocationGroups },
};

export function normalizeLocationGroups(raw) {
  if (!Array.isArray(raw)) {
    throw new SettingsError('locationGroups must be an array of { name, cities } groups.');
  }
  if (raw.length > 50) {
    throw new SettingsError('Too many location groups (max 50).');
  }
  const seenNames = new Set();
  const seenCities = new Set();
  const groups = [];
  for (const entry of raw) {
    const name = String(entry?.name ?? '').trim();
    if (!name) {
      throw new SettingsError('Every location group needs a name.');
    }
    if (name.length > 60) {
      throw new SettingsError('Group names are limited to 60 characters.');
    }
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      throw new SettingsError(`Duplicate group name: ${name}.`);
    }
    seenNames.add(nameKey);
    const cities = [];
    for (const rawCity of Array.isArray(entry?.cities) ? entry.cities : []) {
      const city = String(rawCity ?? '').trim();
      if (!city || cities.includes(city)) {
        continue;
      }
      if (seenCities.has(city)) {
        throw new SettingsError(`${city} is in more than one group.`);
      }
      seenCities.add(city);
      cities.push(city);
    }
    if (cities.length === 0) {
      throw new SettingsError(`Group "${name}" has no cities.`);
    }
    if (cities.length > 500) {
      throw new SettingsError(`Group "${name}" has too many cities (max 500).`);
    }
    groups.push({ name, cities });
  }
  return groups;
}

// The destination directory stays environment-only (BACKUP_DIR), like all
// data paths; only cadence and retention are editable here.
const BACKUP_FIELDS = {
  enabled: { env: 'BACKUP_ENABLED', label: 'Automatic backups', boolean: true },
  intervalHours: { env: 'BACKUP_INTERVAL_HOURS', label: 'Backup every (hours)', number: { min: 1, max: 168 } },
  keep: { env: 'BACKUP_KEEP', label: 'Backups to keep', number: { min: 1, max: 60 } },
};

const CURATE_FIELDS = {
  burstGrouping: {
    env: 'CURATE_BURST_GROUPING',
    label: 'Group same-moment photos into Stacks',
    boolean: true,
    read: (config) => config.curateBurstGrouping,
    apply: (config, value) => {
      config.curateBurstGrouping = Boolean(value);
    },
  },
  refereeEnabled: {
    env: 'CURATE_REFEREE_ENABLED',
    label: 'AI referee for Stacks',
    boolean: true,
    read: (config) => config.curateRefereeEnabled,
    apply: (config, value) => {
      config.curateRefereeEnabled = Boolean(value);
    },
  },
  refereeProvider: {
    env: 'CURATE_REFEREE_PROVIDER',
    label: 'Referee provider',
    enum: ['', 'local_lmstudio', 'local_ollama', 'openai_compatible', 'cloud_ollama', 'cloud_openai', 'openrouter', 'venice'],
    read: (config) => config.curateRefereeProvider,
    apply: (config, value) => {
      config.curateRefereeProvider = value;
    },
  },
  refereeModel: {
    env: 'CURATE_REFEREE_MODEL',
    label: 'Referee model override',
    read: (config) => config.curateRefereeModel,
    apply: (config, value) => {
      config.curateRefereeModel = value;
    },
  },
};

// The supporter key rides the settings store: entry is a normal settings
// update (validated offline before it persists), removal is the standard
// null-clear, and secret:true keeps the key itself from echoing back through
// describe(). Status for the badge comes from /api/support/status, which
// parses the stored key on demand.
const SUPPORT_FIELDS = {
  supporterKey: {
    label: 'Supporter key',
    secret: true,
    read: (config) => config.supporterKey,
    apply: (config, value) => {
      config.supporterKey = value;
    },
    validate: (value) => {
      if (value && !parseSupporterKey(value)) {
        throw new SettingsError(
          "This doesn't look like a valid Pictaria supporter key — paste the whole PICTARIA.… string from the email, watching for a missing line.",
        );
      }
    },
  },
};

const SECTIONS = {
  server: SERVER_FIELDS,
  enrich: ENRICH_FIELDS,
  curate: CURATE_FIELDS,
  insights: INSIGHTS_FIELDS,
  ambient: AMBIENT_FIELDS,
  voice: VOICE_FIELDS,
  prompts: PROMPTS_FIELDS,
  backup: BACKUP_FIELDS,
  support: SUPPORT_FIELDS,
};

const PROTOTYPE_SPECIAL_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const SETTINGS_VERSION = 5;

// Only credentials whose destination authority can vary belong here. Fixed
// public APIs (OpenAI, ElevenLabs, Geoapify) do not need a stored binding.
// #validateEnvironmentCredentialBindings separately protects environment-only
// local-provider credentials.
const SAVED_CREDENTIAL_BINDINGS = [
  {
    id: 'server.immichApiKey',
    section: 'server',
    key: 'immichApiKey',
    name: 'Immich API key',
    authority: (store, staged) => effectiveSettingsAuthority(store, staged, 'server', 'immichBaseUrl'),
  },
  {
    id: 'enrich.openRouterApiKey',
    section: 'enrich',
    key: 'openRouterApiKey',
    name: 'OpenRouter API key',
    envUrl: 'OPENROUTER_BASE_URL',
    authority: (store) => httpAuthority(store.config.providers.openrouter.baseUrl),
  },
  {
    id: 'enrich.openAiCompatibleApiKey',
    section: 'enrich',
    key: 'openAiCompatibleApiKey',
    name: 'OpenAI-compatible API key',
    envUrl: 'OPENAI_COMPATIBLE_BASE_URL',
    authority: (store, staged) => effectiveSettingsAuthority(
      store,
      staged,
      'enrich',
      'openAiCompatibleBaseUrl',
    ),
  },
  {
    id: 'enrich.ollamaApiKey',
    section: 'enrich',
    key: 'ollamaApiKey',
    name: 'Ollama cloud API key',
    envUrl: 'OLLAMA_BASE_URL',
    authority: (store) => httpAuthority(store.config.providers.cloud_ollama.baseUrl),
  },
  {
    id: 'enrich.veniceApiKey',
    section: 'enrich',
    key: 'veniceApiKey',
    name: 'Venice API key',
    envUrl: 'VENICE_BASE_URL',
    authority: (store) => httpAuthority(store.config.providers.venice.baseUrl),
  },
];

const SAVED_CREDENTIAL_BINDING_IDS = new Set(SAVED_CREDENTIAL_BINDINGS.map(({ id }) => id));
const SAVED_CREDENTIAL_BINDING_BY_FIELD = new Map(
  SAVED_CREDENTIAL_BINDINGS.map((binding) => [`${binding.section}.${binding.key}`, binding]),
);

// Version 1 predates explicit settings migrations. These are the only two
// persisted names that moved before the migration runner existed. Keep this
// list beside the runner so accepting an old name is always paired with an
// explicit destination (rather than silently ignoring it during load).
const VERSION_1_LEGACY_FIELDS = {
  voice: {
    openAiApiKey: { type: 'string' },
    openAiAskMaxOutputTokens: { type: 'number' },
  },
};

const SETTINGS_MIGRATIONS = new Map([
  [1, (state) => {
    const migrated = structuredClone(state);
    migrated.server ??= {};
    migrated.voice ??= {};

    if (Object.hasOwn(migrated.voice, 'openAiApiKey')
      && !Object.hasOwn(migrated.server, 'openAiApiKey')) {
      migrated.server.openAiApiKey = migrated.voice.openAiApiKey;
    }
    delete migrated.voice.openAiApiKey;

    // The token budget is provider-neutral. The old openAiAskModel remains
    // where it is because it is still a supported OpenAI-only fallback; an
    // OpenAI model name must not become the model for Venice/Ollama/LM Studio.
    if (Object.hasOwn(migrated.voice, 'openAiAskMaxOutputTokens')
      && !Object.hasOwn(migrated.voice, 'askMaxOutputTokens')) {
      migrated.voice.askMaxOutputTokens = migrated.voice.openAiAskMaxOutputTokens;
    }
    delete migrated.voice.openAiAskMaxOutputTokens;

    migrated.version = 2;
    return migrated;
  }],
  [2, (state) => {
    const migrated = structuredClone(state);
    // Version 2 did not record where a saved credential was intended to go.
    // SettingsStore binds only destinations evidenced independently during
    // this migration boot; ambiguous legacy values remain quarantined.
    migrated.credentialBindings = {};
    migrated.version = 3;
    return migrated;
  }],
  [3, (state) => {
    const migrated = structuredClone(state);
    migrated.version = 4;
    return migrated;
  }],
  [4, (state) => {
    const migrated = structuredClone(state);
    migrated.version = 5;
    return migrated;
  }],
]);

// The persisted contract intentionally excludes labels and help copy: those
// can improve without forcing a storage migration. It includes every property
// that changes what a stored value means or how environment fallback works.
export function settingsContract() {
  const signatures = [];
  for (const [section, sectionFields] of Object.entries(SECTIONS)) {
    for (const [key, field] of Object.entries(sectionFields)) {
      const type = field.json ? 'json' : field.boolean ? 'boolean' : field.number ? 'number' : 'string';
      const properties = [type];
      if (field.env) properties.push(`env=${field.env}`);
      if (field.secret) properties.push('secret');
      if (field.enum) properties.push(`enum=${JSON.stringify(field.enum)}`);
      if (field.number) properties.push(`range=${field.number.min}..${field.number.max}`);
      if (!field.number && !field.boolean && !field.json) properties.push(`maxLength=${field.maxLength ?? 4000}`);
      signatures.push(`${section}.${key}|${properties.join('|')}`);
    }
  }
  return {
    version: SETTINGS_VERSION,
    credentialBindings: [...SAVED_CREDENTIAL_BINDING_IDS],
    fields: signatures,
  };
}

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsError';
  }
}

export class SettingsStore {
  constructor({ filePath, config, env = process.env }) {
    this.filePath = filePath;
    this.config = config;
    this.env = env;
    // Called after every update() so the server can re-point long-lived
    // objects (e.g. the shared Immich client) at the new config values.
    this.onApplied = null;
    // Receives only the names of override fields whose persisted value
    // changed. Values never cross this boundary: it feeds the privacy-safe
    // activity log after persistence and live application both succeed.
    this.onUpdated = null;
    // Snapshot of env+default values as loadConfig resolved them, so clearing
    // an override can fall back to what the environment provided.
    this.baseline = {};
    this.overrides = {};
    this.credentialBindings = {};
    // A persisted key whose destination no longer matches remains on disk so
    // restoring the original authority can recover it, but is unavailable to
    // every live consumer until the authority matches or the key is re-entered.
    this.credentialBindingIssues = new Map();
    for (const [section, fields] of Object.entries(SECTIONS)) {
      config[section] ??= {};
      this.baseline[section] = {};
      for (const [key, field] of Object.entries(fields)) {
        this.baseline[section][key] = field.read
          ? field.read(config, env) ?? ''
          : config[section][key] ?? '';
      }
      this.overrides[section] = {};
    }
  }

  load() {
    let needsInitialState = false;
    let migrated = false;
    try {
      const result = migrateSettingsState(parseBoundedJsonFileSync(this.filePath, {
        maxBytes: MAX_SETTINGS_STATE_BYTES,
        label: 'Settings state',
      }));
      const parsed = result.state;
      migrated = result.migrated;
      this.credentialBindings = structuredClone(parsed.credentialBindings);
      for (const [section, fields] of Object.entries(SECTIONS)) {
        const stored = parsed?.[section];
        if (!stored || typeof stored !== 'object') {
          continue;
        }
        for (const key of Object.keys(fields)) {
          if (Object.hasOwn(stored, key)) {
            this.overrides[section][key] = stored[key];
          }
        }
      }
      if (result.from < 3) {
        this.#bindLegacySavedCredentials();
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      needsInitialState = true;
    }
    this.#validateEnvironmentCredentialBindings(this.overrides, { atStartup: true });
    this.credentialBindingIssues = this.#savedCredentialBindingIssues(
      this.overrides,
      this.credentialBindings,
    );
    // settings.json is persistent application state, even when the user has
    // not saved an override yet. Materialize the empty versioned document on
    // a genuinely fresh volume so the first automatic backup is complete.
    // PersistentStateGuard runs before this store during normal server boot
    // and refuses an established installation whose settings disappeared.
    // Keeping that decision in one global inventory avoids overlapping
    // markers and leaves its documented destructive-reset path unambiguous.
    if (needsInitialState || migrated) {
      this.#persist();
    }
    this.#applyAll();
    return this;
  }

  describe() {
    const result = {};
    for (const [section, fields] of Object.entries(SECTIONS)) {
      result[section] = {};
      for (const [key, field] of Object.entries(fields)) {
        const effective = this.#effective(section, key);
        const binding = SAVED_CREDENTIAL_BINDING_BY_FIELD.get(`${section}.${key}`);
        const bindingIssue = binding ? this.credentialBindingIssues.get(binding.id) : null;
        result[section][key] = {
          label: field.label,
          secret: Boolean(field.secret),
          value: field.secret ? '' : effective,
          configured: field.secret ? Boolean(effective) : undefined,
          source: this.#source(section, key, field),
          ...(bindingIssue ? {
            credentialUnavailable: true,
            credentialNotice: bindingIssue.notice,
            ...(bindingIssue.expected ? { boundAuthority: bindingIssue.expected } : {}),
          } : {}),
          ...(field.enum ? { options: field.enum } : {}),
        };
      }
    }
    return result;
  }

  // patch shape: { voice: { ttsProvider: 'openai', openAiApiKey: 'sk-…' } }.
  // null clears an override (falls back to environment/default). Secrets are
  // never echoed back, so an untouched secret simply isn't in the patch.
  update(patch) {
    if (!isRecord(patch)) {
      throw new SettingsError('Settings patch must be an object.');
    }
    const staged = structuredClone(this.overrides);
    const stagedBindings = structuredClone(this.credentialBindings);
    for (const [section, values] of Object.entries(patch)) {
      if (PROTOTYPE_SPECIAL_KEYS.has(section) || !Object.hasOwn(SECTIONS, section)) {
        throw new SettingsError(`Unknown settings section: ${section}.`);
      }
      const fields = SECTIONS[section];
      if (!isRecord(values)) {
        throw new SettingsError(`Settings for ${section} must be an object.`);
      }
      for (const [key, raw] of Object.entries(values)) {
        if (PROTOTYPE_SPECIAL_KEYS.has(key) || !Object.hasOwn(fields, key)) {
          throw new SettingsError(`Unknown ${section} setting: ${key}.`);
        }
        const field = fields[key];
        if (raw === null) {
          delete staged[section][key];
          continue;
        }
        staged[section][key] = coerce(field, key, raw, this);
      }
    }
    this.#stageSavedCredentialBindings(patch, staged, stagedBindings);
    this.#validateAuthorityChanges(patch, staged);
    validateCurrentSettingsOverrides(staged, stagedBindings);
    const changedFields = [];
    for (const [section, fields] of Object.entries(SECTIONS)) {
      for (const key of Object.keys(fields)) {
        const beforePresent = Object.hasOwn(this.overrides[section], key);
        const afterPresent = Object.hasOwn(staged[section], key);
        if (beforePresent !== afterPresent || (afterPresent && !isDeepStrictEqual(this.overrides[section][key], staged[section][key]))) {
          changedFields.push(`${section}.${key}`);
        }
      }
    }
    this.#persist(staged, stagedBindings);
    this.overrides = staged;
    this.credentialBindings = stagedBindings;
    this.credentialBindingIssues = this.#savedCredentialBindingIssues(staged, stagedBindings);
    this.#applyAll();
    this.onApplied?.();
    if (changedFields.length > 0) {
      this.onUpdated?.(changedFields);
    }
    return this.describe();
  }

  #validateAuthorityChanges(patch, staged) {
    const changedAuthority = (section, key) => {
      const before = this.#effective(section, key);
      const after = Object.hasOwn(staged[section], key)
        ? staged[section][key]
        : this.baseline[section][key];
      return httpAuthority(before) !== httpAuthority(after);
    };

    if (changedAuthority('server', 'immichBaseUrl')) {
      const keyWasProvided = Object.hasOwn(patch?.server ?? {}, 'immichApiKey');
      const activeKey = this.#effective('server', 'immichApiKey');
      if (activeKey && !keyWasProvided) {
        throw new SettingsError('Changing the Immich server requires re-entering or clearing its API key.');
      }
    }
    this.#validateEnvironmentCredentialBindings(staged);
  }

  #bindLegacySavedCredentials() {
    for (const binding of SAVED_CREDENTIAL_BINDINGS) {
      if (!this.overrides[binding.section]?.[binding.key]) {
        continue;
      }
      // Version 2 did not persist credential provenance. A saved Immich URL
      // independently evidences that key's destination. Provider URLs lived
      // only in the environment, so even a current built-in URL cannot prove
      // what a restored key targeted on its previous host.
      const destinationIsEvidenced = binding.id === 'server.immichApiKey'
        && Object.hasOwn(this.overrides.server, 'immichBaseUrl');
      if (destinationIsEvidenced) {
        const authority = binding.authority(this, this.overrides);
        if (authority) {
          this.credentialBindings[binding.id] = authority;
        }
      }
    }
  }

  #stageSavedCredentialBindings(patch, staged, stagedBindings) {
    for (const binding of SAVED_CREDENTIAL_BINDINGS) {
      if (!Object.hasOwn(patch?.[binding.section] ?? {}, binding.key)) {
        continue;
      }
      const savedCredential = staged[binding.section]?.[binding.key];
      if (savedCredential) {
        const authority = binding.authority(this, staged);
        if (!authority) {
          throw new SettingsError(`Configure the destination for ${binding.name} before saving it.`);
        }
        stagedBindings[binding.id] = authority;
      } else {
        delete stagedBindings[binding.id];
      }
    }
  }

  #savedCredentialBindingIssues(staged, stagedBindings) {
    const issues = new Map();
    for (const binding of SAVED_CREDENTIAL_BINDINGS) {
      const savedCredential = staged[binding.section]?.[binding.key];
      if (!savedCredential) {
        continue;
      }
      const expected = stagedBindings[binding.id];
      const effective = binding.authority(this, staged);
      if (expected && expected === effective) {
        continue;
      }
      let notice;
      if (!expected) {
        notice = `This saved ${binding.name} has no recorded destination and is unavailable. Re-enter it for the current destination.`;
      } else if (!effective) {
        notice = `This saved ${binding.name} is bound to ${expected}, but no destination is configured. Configure the destination and re-enter the credential.`;
      } else {
        notice = `This saved ${binding.name} is bound to ${expected}, not ${effective}, so Pictaria will not use it. Restore the original destination or re-enter the credential for this one.`;
      }
      issues.set(binding.id, { expected, effective, notice });
    }
    return issues;
  }

  #validateEnvironmentCredentialBindings(staged, { atStartup = false } = {}) {
    this.#validateImmichCredentialBinding(staged, { atStartup });
    for (const provider of [
      {
        name: 'LM Studio',
        envKey: 'LMSTUDIO_API_KEY',
        envUrl: 'LMSTUDIO_BASE_URL',
        urlKey: 'lmStudioBaseUrl',
      },
      {
        name: 'Local Ollama',
        envKey: 'OLLAMA_LOCAL_API_KEY',
        envUrl: 'OLLAMA_LOCAL_BASE_URL',
        urlKey: 'ollamaLocalBaseUrl',
      },
      {
        name: 'OpenAI-compatible provider',
        envKey: 'OPENAI_COMPATIBLE_API_KEY',
        envUrl: 'OPENAI_COMPATIBLE_BASE_URL',
        urlKey: 'openAiCompatibleBaseUrl',
      },
    ]) {
      if (!this.env[provider.envKey]) {
        continue;
      }
      const effectiveUrl = Object.hasOwn(staged.enrich, provider.urlKey)
        ? staged.enrich[provider.urlKey]
        : this.baseline.enrich[provider.urlKey];
      if (httpAuthority(effectiveUrl) === httpAuthority(this.baseline.enrich[provider.urlKey])) {
        continue;
      }
      if (atStartup) {
        throw new SettingsError(
          `An environment-backed ${provider.name} API key cannot be used with the saved ${provider.name} URL on a different server. Before restarting, set ${provider.envUrl} to that saved server, remove enrich.${provider.urlKey} from settings.json while Pictaria is stopped, or remove ${provider.envKey} if that server does not require it.`,
        );
      }
      throw new SettingsError(
        `${provider.name} has an environment-backed API key; change its URL and key together in the environment, then restart.`,
      );
    }
  }

  #validateImmichCredentialBinding(staged, { atStartup = false } = {}) {
    const usesBaselineKey = !Object.hasOwn(staged.server, 'immichApiKey');
    if (!usesBaselineKey || !this.baseline.server.immichApiKey) {
      return;
    }
    const effectiveUrl = Object.hasOwn(staged.server, 'immichBaseUrl')
      ? staged.server.immichBaseUrl
      : this.baseline.server.immichBaseUrl;
    if (httpAuthority(effectiveUrl) !== httpAuthority(this.baseline.server.immichBaseUrl)) {
      if (atStartup) {
        throw new SettingsError(
          'An environment-backed Immich API key cannot be used with the saved Immich URL on a different server. Before restarting, either set IMMICH_BASE_URL to that saved server, or while Pictaria is stopped, remove server.immichBaseUrl from settings.json or add server.immichApiKey for the saved server.',
        );
      }
      throw new SettingsError(
        'An environment-backed Immich API key cannot be used with a Settings URL on a different server. Restore the environment Immich URL or save a replacement API key for this server.',
      );
    }
  }

  #effective(section, key) {
    const binding = SAVED_CREDENTIAL_BINDING_BY_FIELD.get(`${section}.${key}`);
    if (binding && this.credentialBindingIssues.has(binding.id)) {
      return '';
    }
    return Object.hasOwn(this.overrides[section], key)
      ? this.overrides[section][key]
      : this.baseline[section][key];
  }

  #source(section, key, field) {
    if (Object.hasOwn(this.overrides[section], key)) {
      return 'settings';
    }
    return this.env[field.env] ? 'environment' : 'default';
  }

  #applyAll() {
    for (const [section, fields] of Object.entries(SECTIONS)) {
      for (const [key, field] of Object.entries(fields)) {
        const value = this.#effective(section, key);
        if (field.apply) {
          field.apply(this.config, value);
        } else {
          this.config[section][key] = value;
        }
      }
    }
  }

  #persist(overrides = this.overrides, credentialBindings = this.credentialBindings) {
    const payload = serializeSettingsState({
      version: SETTINGS_VERSION,
      credentialBindings,
      ...overrides,
    });
    writePrivateFileAtomicSync(this.filePath, payload, { encoding: 'utf8' });
  }

}

export function validateSettingsPersistentState(filePath) {
  try {
    const migrated = migrateSettingsState(parseBoundedJsonFileSync(filePath, {
      maxBytes: MAX_SETTINGS_STATE_BYTES,
      label: 'Settings state',
    }));
    serializeSettingsState(migrated.state);
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: `settings.json is unreadable: ${error.message}` };
  }
}

function serializeSettingsState(state) {
  const pretty = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(pretty, 'utf8') <= MAX_SETTINGS_STATE_BYTES) {
    return pretty;
  }
  // A compact legacy document can legitimately expand when normalized and
  // pretty-printed during migration. Preserve it in compact canonical JSON
  // rather than accepting it in backup validation and then failing startup.
  const compact = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(compact, 'utf8') <= MAX_SETTINGS_STATE_BYTES) {
    return compact;
  }
  throw new SettingsError(`Settings state exceeds the ${MAX_SETTINGS_STATE_BYTES}-byte limit.`);
}

export function migrateSettingsState(value) {
  if (!isRecord(value) || !Number.isInteger(value.version) || value.version < 1) {
    throw new Error('expected a versioned settings object');
  }
  if (value.version > SETTINGS_VERSION) {
    throw new Error(
      `settings version ${value.version} is newer than this Pictaria Server supports (latest ${SETTINGS_VERSION}); upgrade the server rather than editing settings.json`,
    );
  }

  let state = structuredClone(value);
  const from = state.version;
  while (state.version < SETTINGS_VERSION) {
    validateSettingsShape(state, state.version);
    const migration = SETTINGS_MIGRATIONS.get(state.version);
    if (!migration) {
      throw new Error(`no settings migration exists from version ${state.version}`);
    }
    state = migration(state);
  }
  return {
    state: normalizeCurrentSettingsState(state),
    migrated: from !== SETTINGS_VERSION,
    from,
    to: SETTINGS_VERSION,
  };
}

function validateSettingsShape(value, version) {
  const allowedTopLevel = new Set([
    'version',
    ...Object.keys(SECTIONS),
    ...(version >= 3 ? ['credentialBindings'] : []),
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(
        `unknown settings section: ${key}; settings.json may have been written by a newer Pictaria Server — upgrade the server rather than deleting the section`,
      );
    }
  }
  for (const [section, fields] of Object.entries(SECTIONS)) {
    if (!Object.hasOwn(value, section)) {
      continue;
    }
    if (!isRecord(value[section])) {
      throw new Error(`settings section ${section} must be an object`);
    }
    const legacy = version === 1 ? VERSION_1_LEGACY_FIELDS[section] ?? {} : {};
    for (const key of Object.keys(value[section])) {
      if (!Object.hasOwn(fields, key) && !Object.hasOwn(legacy, key)) {
        throw new Error(
          `unknown ${section} setting: ${key}; settings.json may have been written by a newer Pictaria Server — upgrade the server rather than deleting the setting`,
        );
      }
    }
  }
}

function normalizeCurrentSettingsState(value) {
  if (value.version !== SETTINGS_VERSION) {
    throw new Error(`expected settings version ${SETTINGS_VERSION} object`);
  }
  validateSettingsShape(value, SETTINGS_VERSION);
  const normalized = {
    version: SETTINGS_VERSION,
    credentialBindings: normalizeCredentialBindings(value.credentialBindings),
  };
  for (const [section, fields] of Object.entries(SECTIONS)) {
    if (!Object.hasOwn(value, section)) {
      continue;
    }
    normalized[section] = {};
    for (const [key, raw] of Object.entries(value[section])) {
      try {
        normalized[section][key] = coercePersisted(fields[key], key, raw);
      } catch (error) {
        throw new Error(`invalid ${section}.${key}: ${error.message}`);
      }
    }
  }
  for (const binding of SAVED_CREDENTIAL_BINDINGS) {
    const credential = normalized[binding.section]?.[binding.key];
    if (!credential && Object.hasOwn(normalized.credentialBindings, binding.id)) {
      throw new Error(`credential binding ${binding.id} has no saved credential`);
    }
  }
  return normalized;
}

function validateCurrentSettingsOverrides(overrides, credentialBindings) {
  try {
    normalizeCurrentSettingsState({
      version: SETTINGS_VERSION,
      credentialBindings,
      ...overrides,
    });
  } catch (error) {
    if (error instanceof SettingsError) {
      throw error;
    }
    throw new SettingsError(`Settings patch would create invalid persistent state: ${error.message}`);
  }
}

function normalizeCredentialBindings(value) {
  if (!isRecord(value)) {
    throw new Error('credentialBindings must be an object');
  }
  const normalized = {};
  for (const [id, authority] of Object.entries(value)) {
    if (PROTOTYPE_SPECIAL_KEYS.has(id) || !SAVED_CREDENTIAL_BINDING_IDS.has(id)) {
      throw new Error(`unknown credential binding: ${id}`);
    }
    if (typeof authority !== 'string' || !authority || authority.length > 2048) {
      throw new Error(`credential binding ${id} must be a non-empty HTTP authority`);
    }
    let canonical;
    try {
      canonical = httpAuthority(authority);
    } catch {
      throw new Error(`credential binding ${id} must be a valid HTTP authority`);
    }
    if (canonical !== authority) {
      throw new Error(`credential binding ${id} must contain only its normalized HTTP authority`);
    }
    normalized[id] = canonical;
  }
  return normalized;
}

function coercePersisted(field, key, raw) {
  if (field.json) {
    if (raw === null || typeof raw !== 'object') {
      throw new SettingsError(`${key} must be JSON data.`);
    }
  } else if (field.boolean) {
    if (typeof raw !== 'boolean') {
      throw new SettingsError(`${key} must be true or false.`);
    }
  } else if (field.number) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new SettingsError(`${key} must be a number.`);
    }
  } else if (typeof raw !== 'string') {
    throw new SettingsError(`${key} must be a string.`);
  }
  return coerce(field, key, raw);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// `store` gives validators context beyond the value itself (the taxonomy
// version rule compares against the currently active taxonomy).
function coerce(field, key, raw, store = null) {
  if (field.json) {
    return field.json(raw);
  }
  if (field.boolean) {
    if (typeof raw === 'boolean') {
      return raw;
    }
    const text = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) {
      return true;
    }
    if (['false', '0', 'no', 'off', ''].includes(text)) {
      return false;
    }
    throw new SettingsError(`${key} must be true or false.`);
  }
  if (field.number) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < field.number.min || value > field.number.max) {
      throw new SettingsError(`${key} must be a number between ${field.number.min} and ${field.number.max}.`);
    }
    return value;
  }
  const value = String(raw).trim();
  if (field.enum && !field.enum.includes(value)) {
    throw new SettingsError(`${key} must be one of: ${field.enum.filter(Boolean).join(', ')} (or empty).`);
  }
  if (value.length > (field.maxLength ?? 4000)) {
    throw new SettingsError(`${key} is too long.`);
  }
  field.validate?.(value, store);
  // Normalization happens BEFORE the override is stored, so describe()
  // echoes the corrected value back to the UI — a scheme-less Immich URL
  // must round-trip as http://…, not look accepted as typed.
  return field.normalize ? field.normalize(value) : value;
}

export function defaultSettingsPath(rootDir) {
  return join(rootDir, 'data', 'settings.json');
}

function normalizeHttpSettingUrl(value) {
  try {
    return normalizeHttpUrl(value);
  } catch (error) {
    throw new SettingsError(error instanceof Error ? error.message : String(error));
  }
}

function normalizeImmichSettingUrl(value) {
  try {
    return normalizeBaseUrl(value);
  } catch (error) {
    throw new SettingsError(error instanceof Error ? error.message : String(error));
  }
}

function httpAuthority(value) {
  const normalized = normalizeHttpSettingUrl(value);
  return normalized ? new URL(normalized).origin : '';
}

function effectiveSettingsAuthority(store, staged, section, key) {
  const value = Object.hasOwn(staged[section], key)
    ? staged[section][key]
    : store.baseline[section][key];
  return httpAuthority(value);
}
