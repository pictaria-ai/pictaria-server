import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const settingsPath = resolvePath(env.SETTINGS_PATH, join(ROOT_DIR, 'data', 'settings.json'));
  const persistentStateInventoryPath = join(dirname(settingsPath), 'persistent-state.json');
  const config = {
    rootDir: ROOT_DIR,
    host: env.HOST || '0.0.0.0',
    port: parseInteger(env.PORT, 4080),
    appPassword: env.APP_PASSWORD || '',
    // Open mode is retained for deliberate trusted-network deployments, but
    // an empty password by itself must never opt into it. server.mjs validates
    // this independent signal before creating any state or opening a socket.
    allowInsecureOpen: parseBoolean(env.ALLOW_INSECURE_OPEN),
    // Adds `Secure` to the browser session cookie so it is never sent over
    // plain HTTP. Opt-in: the server itself only speaks HTTP, so this is for
    // installs reached exclusively through an HTTPS reverse proxy.
    sessionCookieSecure: parseBoolean(env.SESSION_COOKIE_SECURE),
    // Browser pages and cookie sessions accept local/VPN-style names by
    // default. Public custom domains must be named explicitly to prevent an
    // arbitrary DNS-rebinding Host from becoming its own CSRF trust anchor.
    browserAllowedHosts: env.BROWSER_ALLOWED_HOSTS || '',
    // Forwarded client addresses are security-sensitive and therefore remain
    // environment-only. Empty means the direct TCP peer is always the client.
    trustedProxyIps: env.TRUSTED_PROXY_IPS || '',
    immichBaseUrl: normalizeBaseUrl(env.IMMICH_BASE_URL || ''),
    // Browser-facing Immich URL for deep links (e.g. person pages); falls back
    // to the server-side URL, which is right whenever both are on the same LAN.
    immichPublicUrl: normalizeBaseUrl(env.IMMICH_PUBLIC_URL || env.IMMICH_BASE_URL || ''),
    immichApiKey: env.IMMICH_API_KEY || '',
    requestTimeoutMs: parseInteger(env.REQUEST_TIMEOUT_MS, 60000),
    databasePath: resolvePath(env.DATABASE_PATH, join(ROOT_DIR, 'data', 'enrichment.sqlite')),
    settingsPath,
    persistentState: {
      // The inventory follows SETTINGS_PATH so custom data layouts need no
      // second environment option. Its marker is intentionally outside the
      // backed-up inventory and makes deletion of the inventory itself loud.
      inventoryPath: persistentStateInventoryPath,
      markerPath: `${persistentStateInventoryPath}.initialized`,
      // The settings-specific initialized marker is accepted as one-time
      // migration input; the shared guard removes it only after sealing the
      // global inventory.
      legacySettingsMarkerPath: `${settingsPath}.initialized`,
    },
    // Per-installation entropy for browser-session signatures. Keeping this
    // beside settings.json naturally lands it in the Docker /data volume and
    // follows custom SETTINGS_PATH deployments without another env option.
    sessionSecretPath: join(dirname(settingsPath), 'session-secret'),
    wakeWordModelsDir: resolvePath(env.WAKE_WORD_MODELS_DIR, join(ROOT_DIR, 'data', 'wake-word-models')),
    taxonomyPath: resolvePath(env.TAXONOMY_PATH, join(ROOT_DIR, 'taxonomy', 'v1.json')),
    promptsDir: resolvePath(env.PROMPTS_DIR, join(ROOT_DIR, 'prompts')),
    promptVersion: env.PROMPT_VERSION || 'v2',
    // Settings-only overrides for the prompt files; empty = use the files.
    promptOverrides: { systemPrompt: '', userTemplate: '' },
    // Automatic snapshots of the irreplaceable data files. The destination
    // stays environment-only (it's a data path); cadence and retention are
    // Settings-editable. Default dir is on the same disk — real safety
    // means pointing BACKUP_DIR at another machine or a synced folder.
    backup: {
      // BACKUP_DIR_DEFAULT relocates the *default* (trusted, no adoption)
      // destination — it is how the Docker image points the built-in
      // default at the /data volume without making it look user-selected.
      // Users set BACKUP_DIR, never BACKUP_DIR_DEFAULT.
      dir: resolvePath(env.BACKUP_DIR, resolvePath(env.BACKUP_DIR_DEFAULT, join(ROOT_DIR, 'data', 'backups'))),
      // A custom destination is where mounts live: it must be adopted
      // explicitly before backups write to it (see src/backup.mjs), while
      // the default is trusted implicitly.
      dirIsCustom: Boolean(env.BACKUP_DIR),
      enabled: env.BACKUP_ENABLED === undefined ? true : parseBoolean(env.BACKUP_ENABLED),
      intervalHours: clamp(parseInteger(env.BACKUP_INTERVAL_HOURS, 24), 1, 168),
      keep: clamp(parseInteger(env.BACKUP_KEEP, 7), 1, 60),
    },
    // Off by default because a run sends the selected image rendition to its
    // chosen model. Voice Interesting is a separate user-invoked model path.
    enrichEnabled: parseBoolean(env.ENRICH_ENABLED),
    enrichSchedule: {
      enabled: parseBoolean(env.ENRICH_SCHEDULE_ENABLED),
      time: normalizeDailyTime(env.ENRICH_SCHEDULE_TIME, '03:00'),
      timeZone: normalizeTimeZone(
        env.ENRICH_SCHEDULE_TIME_ZONE,
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      ),
      photoBudget: clamp(parseInteger(env.ENRICH_SCHEDULE_PHOTO_BUDGET, 100), 1, 10000),
    },
    // On by default: Curate collapses same-moment photos into stacked cards.
    curateBurstGrouping:
      env.CURATE_BURST_GROUPING === undefined ? true : parseBoolean(env.CURATE_BURST_GROUPING),
    // Group referee (gold star): off by default — it sends grouped photos to
    // the chosen model whenever enrichment is idle. Provider/model empty =
    // the enrichment defaults; a smaller vision model works well here.
    curateRefereeEnabled: parseBoolean(env.CURATE_REFEREE_ENABLED),
    curateRefereeProvider: env.CURATE_REFEREE_PROVIDER || '',
    curateRefereeModel: env.CURATE_REFEREE_MODEL || '',
    // Aggregate byte ceiling per referee group (all sources count). The
    // default suits a machine with a few GB free; small self-hosted
    // containers can lower it. Clamped to [8MB, 2GB].
    curateRefereeGroupBudgetBytes:
      clamp(parseInteger(env.REFEREE_GROUP_BUDGET_MB, 96), 8, 2048) * 1024 * 1024,
    // Also off by default: copying enrichment captions into Immich's
    // description field mutates the user's Immich library. It fills empty
    // descriptions or updates our own earlier writes after a final read; the
    // Immich API cannot make that read and update atomic.
    captionWriteback: parseBoolean(env.CAPTION_WRITEBACK),
    defaultProvider: env.DEFAULT_PROVIDER || 'cloud_openai',
    imageSource: env.IMAGE_SOURCE || 'preview',
    // Optional operator-authored context copied into each run summary. This
    // deliberately describes the inference host without probing hardware or
    // deriving identity from a provider URL.
    inferenceHostLabel: String(env.INFERENCE_HOST_LABEL || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    maxFailuresPerAsset: parseInteger(env.MAX_FAILURES_PER_ASSET, 2),
    albums: {
      dataFile: resolvePath(env.ALBUMS_DATA_FILE, join(ROOT_DIR, 'data', 'smart-albums.json')),
      searchPageSize: clamp(parseInteger(env.ALBUMS_SEARCH_PAGE_SIZE, 1000), 1, 1000),
      maxSearchPages: clamp(parseInteger(env.ALBUMS_MAX_SEARCH_PAGES, 25), 1, 500),
    },
    frame: {
      dbPath: resolvePath(env.FRAME_DB_PATH, join(ROOT_DIR, 'data', 'frame.db')),
    },
    insights: {
      dbPath: resolvePath(env.INSIGHTS_DB_PATH, join(ROOT_DIR, 'data', 'insights.sqlite')),
      sweepPageSize: clamp(parseInteger(env.INSIGHTS_SWEEP_PAGE_SIZE, 1000), 1, 1000),
      maxSweepPages: clamp(parseInteger(env.INSIGHTS_MAX_SWEEP_PAGES, 1000), 1, 10000),
      refreshIntervalHours: clamp(parseInteger(env.INSIGHTS_REFRESH_HOURS, 24), 1, 24 * 30),
      topPeople: clamp(parseInteger(env.INSIGHTS_TOP_PEOPLE, 15), 1, 100),
      maxTagCounts: clamp(parseInteger(env.INSIGHTS_MAX_TAG_COUNTS, 250), 0, 2000),
      statConcurrency: clamp(parseInteger(env.INSIGHTS_STAT_CONCURRENCY, 4), 1, 16),
      // Optional tag that stands in for Immich favorites (settings-editable).
      favoritesTagId: env.INSIGHTS_FAVORITES_TAG_ID || '',
      favoritesTagValue: env.INSIGHTS_FAVORITES_TAG_VALUE || '',
      // Synthetic locations (settings-editable only; no env form).
      locationGroups: [],
      // Trip detection: how far from home counts as "away", how many quiet
      // days may sit inside one trip, and the minimum away-days for a trip.
      tripAwayKm: clamp(parseInteger(env.INSIGHTS_TRIP_AWAY_KM, 100), 10, 5000),
      tripGapDays: clamp(parseInteger(env.INSIGHTS_TRIP_GAP_DAYS, 3), 0, 30),
      tripMinDays: clamp(parseInteger(env.INSIGHTS_TRIP_MIN_DAYS, 2), 1, 30),
    },
    voice: {
      sttProvider: env.STT_PROVIDER || '',
      ttsProvider: env.TTS_PROVIDER || '',
      openAiApiKey: env.OPENAI_API_KEY || '',
      openAiRequestTimeoutMs: parseInteger(env.OPENAI_REQUEST_TIMEOUT_MS, 30000),
      // Which provider answers the two spoken-prose commands ("what's
      // interesting about this photo", "tell me …"). One explicit choice
      // shared by both; OpenAI by default, which is where they have always
      // gone. Deliberately independent of the enrichment provider: voice
      // needs an answer in seconds, enrichment can take minutes.
      proseProvider: env.VOICE_PROSE_PROVIDER || 'cloud_openai',
      // The interactive budget for those commands. The frame stands silent
      // until the answer lands, so this is far shorter than the enrichment
      // timeouts a local model may legitimately need.
      // Clamped to the same range Settings enforces: below 2s the command
      // short-circuits to its spoken fallback without ever reaching a
      // model, and above 40s Pictaria Frame has already abandoned the
      // request. Compose forwards this variable, so the env path is a
      // supported deployment path and must not be able to bypass it.
      proseTimeoutMs: clamp(parseInteger(env.VOICE_PROSE_TIMEOUT_MS, 25000), 2000, 40000),
      // Per-command models: a large vision model can describe a photo while
      // something small and quick handles spoken questions. Empty means
      // "whatever this provider is configured to use" — except on OpenAI,
      // which keeps the historical per-command defaults below so existing
      // installs answer exactly as they did before.
      interestingModel: env.VOICE_INTERESTING_MODEL || '',
      askModel: env.VOICE_ASK_MODEL || '',
      openAiInterestingModel: env.OPENAI_INTERESTING_MODEL || 'gpt-5.5',
      openAiInterestingImageDetail: env.OPENAI_INTERESTING_IMAGE_DETAIL || 'high',
      interestingMaxOutputTokens: parseInteger(env.OPENAI_INTERESTING_MAX_OUTPUT_TOKENS, 420),
      openAiAskModel: env.OPENAI_ASK_MODEL || 'gpt-5.4-nano',
      askMaxOutputTokens: parseInteger(env.OPENAI_ASK_MAX_OUTPUT_TOKENS, 600),
      openAiTtsModel: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      openAiTtsVoice: env.OPENAI_TTS_VOICE || 'coral',
      openAiTtsFormat: env.OPENAI_TTS_FORMAT || 'mp3',
      // Clamped like the Settings field: an out-of-range env value would
      // otherwise pass straight through to the provider.
      openAiTtsSpeed: clamp(parseFloatEnv(env.OPENAI_TTS_SPEED, 1.17), 0.5, 2),
      openAiTtsInstructions: env.OPENAI_TTS_INSTRUCTIONS || '',
      elevenLabsApiKey: env.ELEVENLABS_API_KEY || '',
      elevenLabsRequestTimeoutMs: parseInteger(env.ELEVENLABS_REQUEST_TIMEOUT_MS, 30000),
      elevenLabsTtsModel: env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2',
      elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID || '',
      elevenLabsOutputFormat: env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128',
    },
    // Voice prompt overrides (Settings → Prompts). Empty = the built-in
    // templates in src/voice/promptTemplates.mjs. Settings-only, no env.
    prompts: {
      interestingPrompt: '',
      askPrompt: '',
    },
    ambient: {
      weatherDefaultLocation: env.WEATHER_DEFAULT_LOCATION || '',
      geocodingProvider: env.GEOCODING_PROVIDER || '',
      geoapifyApiKey: env.GEOAPIFY_API_KEY || '',
      geocodingTimeoutMs: parseInteger(env.GEOCODING_TIMEOUT_MS, 8000),
      geocodingCoordinatePrecision: parseInteger(env.GEOCODING_COORDINATE_PRECISION, 3),
      immichMetadataWriteback: parseBoolean(env.IMMICH_METADATA_WRITEBACK),
      immichLocationMetadataKey: env.IMMICH_LOCATION_METADATA_KEY || 'pictaria.locationEnrichment',
    },
    providers: {
      cloud_openai: {
        apiKey: env.OPENAI_API_KEY || '',
        modelName: env.OPENAI_MODEL || 'gpt-5.5',
      },
      local_lmstudio: {
        apiKey: env.LMSTUDIO_API_KEY || 'lm-studio',
        modelName: env.LMSTUDIO_MODEL || '',
        baseUrl: normalizeHttpUrl(env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1'),
        // 2400 gives long tag-lists + captions headroom: the 1600 cap was
        // truncating verbose responses mid-JSON (~5k chars), failing photos
        // that had nothing wrong with them.
        maxTokens: parseOptionalInteger(env.LMSTUDIO_MAX_TOKENS, 2400),
        temperature: parseFloatEnv(env.LMSTUDIO_TEMPERATURE, 0),
      },
      openai_compatible: {
        // Generic OpenAI-style chat endpoint (for example llama.cpp). Both
        // URL and model are deliberately empty until the operator selects a
        // service; authentication is optional for trusted-network servers.
        apiKey: env.OPENAI_COMPATIBLE_API_KEY || '',
        modelName: env.OPENAI_COMPATIBLE_MODEL || '',
        baseUrl: normalizeHttpUrl(env.OPENAI_COMPATIBLE_BASE_URL || ''),
      },
      local_ollama: {
        // Optional: local Ollama needs no auth; set only behind a proxy.
        apiKey: env.OLLAMA_LOCAL_API_KEY || '',
        modelName: env.OLLAMA_LOCAL_MODEL || '',
        baseUrl: normalizeHttpUrl(env.OLLAMA_LOCAL_BASE_URL || 'http://127.0.0.1:11434'),
      },
      openrouter: {
        apiKey: env.OPENROUTER_API_KEY || '',
        modelName: env.OPENROUTER_MODEL || 'qwen/qwen3-vl-32b-instruct',
        baseUrl: normalizeHttpUrl(env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
      },
      cloud_ollama: {
        apiKey: env.OLLAMA_API_KEY || '',
        modelName: env.OLLAMA_MODEL || 'qwen3.5:cloud',
        baseUrl: normalizeHttpUrl(env.OLLAMA_BASE_URL || 'https://ollama.com'),
      },
      venice: {
        apiKey: env.VENICE_API_KEY || '',
        // Deliberately no default: Venice's catalog moves fast and only some
        // models accept images — the user picks a vision-capable model.
        modelName: env.VENICE_MODEL || '',
        baseUrl: normalizeHttpUrl(env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1'),
      },
    },
  };
  validatePersistentStatePaths(config);
  return config;
}

function normalizeDailyTime(value, fallback) {
  const text = String(value || '').trim();
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return fallback;
  return text;
}

function normalizeTimeZone(value, fallback) {
  const candidate = String(value || fallback || 'UTC').trim();
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format();
    return candidate;
  } catch {
    return 'UTC';
  }
}

export function validatePersistentStatePaths(config) {
  const generated = [
    { label: 'persistent-state inventory', path: config.persistentState.inventoryPath },
    { label: 'persistent-state marker', path: config.persistentState.markerPath },
    { label: 'legacy settings marker', path: config.persistentState.legacySettingsMarkerPath },
  ];
  const configured = [
    { label: 'DATABASE_PATH', path: config.databasePath },
    { label: 'SETTINGS_PATH', path: config.settingsPath },
    { label: 'FRAME_DB_PATH', path: config.frame.dbPath },
    { label: 'INSIGHTS_DB_PATH', path: config.insights.dbPath },
    { label: 'ALBUMS_DATA_FILE', path: config.albums.dataFile },
    { label: 'WAKE_WORD_MODELS_DIR', path: config.wakeWordModelsDir },
    { label: 'BACKUP_DIR/BACKUP_DIR_DEFAULT', path: config.backup.dir },
  ];
  for (const generatedPath of generated) {
    const collision = configured.find((target) => pathsCollide(target.path, generatedPath.path));
    if (collision) {
      throw new Error(
        `Persistent-state path collision: ${collision.label} and the generated `
        + `${generatedPath.label} both resolve to ${generatedPath.path}. `
        + 'Choose a different configured persistent-state path.',
      );
    }
  }
  return config;
}

function pathsCollide(left, right) {
  if (canonicalPathKey(left) === canonicalPathKey(right)) {
    return true;
  }
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev
      && leftStat.ino === rightStat.ino
      && (leftStat.dev !== 0 || leftStat.ino !== 0);
  } catch {
    return false;
  }
}

// Resolve every existing ancestor so aliases such as /volume-link/data and
// /real-volume/data compare as one location even before the leaf exists.
// The normal macOS and Windows filesystems are case-insensitive; folding only
// there catches filename-case aliases without rejecting distinct Linux paths.
function canonicalPathKey(inputPath) {
  let ancestor = resolve(inputPath);
  const suffix = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  try {
    ancestor = realpathSync.native(ancestor);
  } catch {
    // resolve() already supplied the best lexical identity available.
  }
  const canonical = resolve(ancestor, ...suffix);
  return process.platform === 'darwin' || process.platform === 'win32'
    ? canonical.toLowerCase()
    : canonical;
}

export function validateServerAuthConfig(config) {
  if (!config.appPassword && !config.allowInsecureOpen) {
    throw new Error(
      'APP_PASSWORD is empty. Set a non-empty APP_PASSWORD, or set '
      + 'ALLOW_INSECURE_OPEN=true to deliberately run without authentication.',
    );
  }
  return config;
}

export function missingImmichSettings(config) {
  const missing = [];
  if (!config.immichBaseUrl) {
    missing.push('IMMICH_BASE_URL');
  }
  if (!config.immichApiKey) {
    missing.push('IMMICH_API_KEY');
  }
  return missing;
}

export function normalizeBaseUrl(value) {
  return normalizeHttpUrl(value).replace(/\/api$/, '');
}

export function normalizeHttpUrl(value) {
  const trimmed = String(value).trim().replace(/\/+$/, '');
  if (!trimmed) {
    return trimmed;
  }
  // A scheme-less host ("immich.local:2283") is accepted by the UI but silently
  // breaks every fetch. Default to http://, the normal LAN case. Provider
  // authorities are HTTP-only security boundaries: reject embedded
  // credentials, fragments, and alternate URL schemes.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Server URL must be a valid HTTP or HTTPS URL.');
  }
  // URL.search/hash are both empty for a bare trailing `?`/`#`, even though
  // those delimiters still reinterpret a suffix appended by a caller. Check
  // the serialized URL so empty query and fragment markers fail closed too.
  const hasQueryOrFragment = parsed.href.includes('?') || parsed.href.includes('#');
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || hasQueryOrFragment) {
    throw new Error('Server URL must use HTTP or HTTPS without credentials, a query, or a fragment.');
  }
  return candidate;
}

export function appendHttpUrlPath(baseUrl, endpoint) {
  const target = new URL(normalizeHttpUrl(baseUrl));
  const configuredOrigin = target.origin;
  // Parse only the endpoint's path and query against a fixed dummy origin,
  // then copy those components onto the configured base. An endpoint can
  // never replace the configured authority, while intentional base paths and
  // endpoint query parameters are preserved.
  const parsedEndpoint = new URL(String(endpoint).replace(/^\/+/, ''), 'http://pictaria.invalid/');
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = `${basePath}/${parsedEndpoint.pathname.replace(/^\/+/, '')}`;
  target.search = parsedEndpoint.search;
  target.hash = '';
  if (target.origin !== configuredOrigin) {
    throw new Error('Endpoint path changed the configured server origin.');
  }
  return target.href;
}

function resolvePath(value, fallback) {
  if (!value) {
    return fallback;
  }
  return resolve(ROOT_DIR, String(value));
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalInteger(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (['none', 'null', 'off'].includes(String(value).toLowerCase())) {
    return null;
  }
  return parseInteger(value, fallback);
}

function parseFloatEnv(value, fallback) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
