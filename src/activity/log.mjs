import { isSupportedFrameCommand } from '../frame/remote.mjs';
import { normalizeVoiceUsageLabel } from '../voice/usageLabels.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

export const ACTIVITY_RETENTION_DAYS = 90;
export const ACTIVITY_DETAIL_MAX_BYTES = 8 * 1024;

const PRUNE_INTERVAL_MS = DAY_MS;
const FIELD_MAX = 128;
const ASSET_ID_MAX = 256;
const SUMMARY_MAX = 500;
const DETAIL_STRING_MAX = 500;
const DETAIL_MAX_DEPTH = 4;
const DETAIL_MAX_KEYS = 32;
const DETAIL_KEY_MAX = 64;
const SAFE_SHUTDOWN_REASONS = new Set(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']);
const SAFE_VOICE_OUTCOMES = new Set(['succeeded', 'fallback', 'failed']);

// Best-effort structured activity writer. Observability must never become a
// dependency of the action being observed: every prune/insert is caught and
// reduced to a warning, while reads remain explicit so an Activity page can
// report an unavailable store honestly.
export function createActivityLog({
  repo,
  logger = console,
  now = () => new Date(),
  retentionDays = ACTIVITY_RETENTION_DAYS,
  setIntervalFn = null,
} = {}) {
  const retentionMs = Math.max(1, Math.floor(Number(retentionDays) || ACTIVITY_RETENTION_DAYS)) * DAY_MS;
  let lastPrunedAt = null;

  function warn(operation, error) {
    logger.warn?.(
      `[Pictaria] Activity log ${operation} failed; the server operation continues. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  function pruneIfDue(force = false) {
    try {
      const current = normalizeDate(now());
      if (!force && lastPrunedAt && current.getTime() - lastPrunedAt.getTime() < PRUNE_INTERVAL_MS) {
        return true;
      }
      repo.pruneActivityEvents(retentionCutoff(current, retentionMs));
      lastPrunedAt = current;
      return true;
    } catch (error) {
      warn('retention prune', error);
      return false;
    }
  }

  function record(event) {
    // A failed prune must not suppress the event; it will retry on the next
    // write because lastPrunedAt advances only after a successful delete.
    pruneIfDue();
    try {
      const normalized = normalizeEvent(event, now());
      repo.recordActivityEvent(normalized);
      return true;
    } catch (error) {
      warn('write', error);
      return false;
    }
  }

  // Startup pruning is synchronous and best-effort. In production the
  // caller supplies the tracked lifecycle scheduler, so long-lived quiet
  // servers still enforce the retention window and shutdown clears the timer.
  // Runtime activity failures cannot stop the operation being observed;
  // startup schema validation remains part of the normal fail-closed DB boot.
  pruneIfDue(true);
  setIntervalFn?.(() => pruneIfDue(true), PRUNE_INTERVAL_MS);

  return {
    retentionDays: Math.max(1, Math.floor(Number(retentionDays) || ACTIVITY_RETENTION_DAYS)),
    systemStarted({ serverVersion } = {}) {
      return record({
        category: 'system',
        type: 'system.start',
        source: 'server',
        outcome: 'succeeded',
        summary: 'Pictaria Server started',
        detail: { serverVersion: boundedString(serverVersion, FIELD_MAX) },
      });
    },
    systemStopping({ reason, exitCode } = {}) {
      const safeReason = SAFE_SHUTDOWN_REASONS.has(reason) ? reason : 'other';
      return record({
        category: 'system',
        type: 'system.stop',
        source: 'server',
        outcome: Number(exitCode) === 0 ? 'succeeded' : 'failed',
        summary: 'Pictaria Server stopping',
        detail: { reason: safeReason, exitCode: boundedCount(exitCode) },
      });
    },
    settingsChanged({ fields } = {}) {
      const safeFields = [...new Set(
        (Array.isArray(fields) ? fields : [])
          .map((field) => String(field ?? '').trim())
          .filter((field) => /^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(field))
          .map((field) => field.slice(0, FIELD_MAX)),
      )].sort();
      const visibleFields = safeFields.slice(0, DETAIL_MAX_KEYS);
      return record({
        category: 'settings',
        type: 'settings.changed',
        source: 'web',
        outcome: 'succeeded',
        summary: `${safeFields.length} setting field${safeFields.length === 1 ? '' : 's'} changed`,
        detail: {
          fields: visibleFields,
          truncated: safeFields.length > visibleFields.length,
        },
      });
    },
    frameCommand({ command, target, deviceId, deliveredCount } = {}) {
      const safeCommand = isSupportedFrameCommand(command) ? command : 'other';
      const safeTarget = target === 'left' || target === 'right' ? target : null;
      const count = boundedCount(deliveredCount);
      return record({
        category: 'frame',
        type: 'frame.command',
        source: 'remote',
        deviceId,
        outcome: count > 0 ? 'delivered' : 'undelivered',
        summary: `Frame command: ${safeCommand}`,
        detail: {
          command: safeCommand,
          deliveredCount: count,
          ...(safeTarget ? { target: safeTarget } : {}),
        },
      });
    },
    voiceCommand({ label, deviceId } = {}) {
      const safeLabel = normalizeVoiceUsageLabel(label);
      return record({
        category: 'voice',
        type: 'voice.command',
        source: 'frame',
        deviceId,
        // The server knows only that Frame reported the label. Local actions
        // such as navigation happen on-device, so claiming success here
        // would be stronger than the evidence.
        outcome: 'reported',
        summary: `Voice command used: ${safeLabel}`,
        detail: { command: safeLabel },
      });
    },
    voiceAnswer({ kind, assetId, provider, model, outcome } = {}) {
      const safeKind = kind === 'interesting' ? 'interesting' : 'tell-me';
      const safeOutcome = SAFE_VOICE_OUTCOMES.has(outcome) ? outcome : 'failed';
      return record({
        category: 'voice',
        type: `voice.${safeKind}`,
        source: 'frame',
        assetId: safeKind === 'interesting' ? assetId : null,
        provider,
        model,
        outcome: safeOutcome,
        summary: safeKind === 'interesting' ? 'Interesting answer requested' : 'Tell Me answer requested',
      });
    },
    voiceTts({ provider, model, outcome } = {}) {
      return record({
        category: 'voice',
        type: 'voice.tts',
        source: 'frame',
        provider,
        model,
        outcome: SAFE_VOICE_OUTCOMES.has(outcome) ? outcome : 'failed',
        summary: 'Voice answer synthesized',
      });
    },
    assetFavorited({ assetId, outcome = 'succeeded' } = {}) {
      return record({
        category: 'curation',
        type: 'curation.favorite',
        source: 'frame',
        assetId,
        outcome: outcome === 'succeeded' ? 'succeeded' : 'failed',
        summary: 'Photo favorited from Frame',
      });
    },
    assetHidden({ assetId, outcome = 'succeeded' } = {}) {
      return record({
        category: 'curation',
        type: 'curation.never-show',
        source: 'frame',
        assetId,
        outcome: outcome === 'succeeded' ? 'succeeded' : 'failed',
        summary: 'Photo hidden from Frame',
      });
    },
    assetsDiscarded({ count, assetId, mode, skippedSuccessful, skippedNotStuck, truncated } = {}) {
      return record({
        category: 'curation',
        type: 'curation.discard',
        source: 'enrich',
        assetId,
        outcome: 'succeeded',
        summary: `${boundedCount(count)} photo${boundedCount(count) === 1 ? '' : 's'} discarded from Enrich`,
        detail: {
          count: boundedCount(count),
          mode: mode === 'all' ? 'all' : 'selected',
          skippedSuccessful: boundedCount(skippedSuccessful),
          skippedNotStuck: boundedCount(skippedNotStuck),
          truncated: truncated === true,
        },
      });
    },
    assetsRestored({ count, assetId } = {}) {
      return record({
        category: 'curation',
        type: 'curation.restore',
        source: 'enrich',
        assetId,
        outcome: 'succeeded',
        summary: `${boundedCount(count)} photo${boundedCount(count) === 1 ? '' : 's'} restored to Enrich`,
        detail: { count: boundedCount(count) },
      });
    },
    list(options = {}) {
      pruneIfDue();
      const cutoff = retentionCutoff(normalizeDate(now()), retentionMs);
      const requestedSince = options.since ? normalizeDate(options.since).toISOString() : null;
      return repo.listActivityEvents({
        ...options,
        since: requestedSince && requestedSince > cutoff ? requestedSince : cutoff,
      });
    },
  };
}

function boundedCount(value) {
  try {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count))) : 0;
  } catch {
    return 0;
  }
}

function retentionCutoff(now, retentionMs) {
  return new Date(now.getTime() - retentionMs).toISOString();
}

function normalizeEvent(event, at) {
  if (!isPlainObject(event)) {
    throw new TypeError('event must be an object');
  }
  const category = requiredToken(event.category, 'category');
  const type = requiredToken(event.type, 'type');
  if (!type.startsWith(`${category}.`)) {
    throw new TypeError('event type must start with its category');
  }
  const summary = requiredString(event.summary, 'summary', SUMMARY_MAX);
  const detailJson = serializeDetail(event.detail);
  return {
    at: normalizeDate(at).toISOString(),
    category,
    type,
    source: optionalString(event.source, FIELD_MAX),
    deviceId: optionalString(event.deviceId, FIELD_MAX),
    assetId: optionalString(event.assetId, ASSET_ID_MAX),
    provider: optionalString(event.provider, FIELD_MAX),
    model: optionalString(event.model, FIELD_MAX),
    outcome: optionalString(event.outcome, FIELD_MAX),
    summary,
    detailJson,
  };
}

function requiredToken(value, name) {
  const clean = requiredString(value, name, FIELD_MAX);
  if (!/^[a-z][a-z0-9_.-]*$/.test(clean)) {
    throw new TypeError(`${name} has an invalid format`);
  }
  return clean;
}

function requiredString(value, name, maxLength) {
  const clean = String(value ?? '').trim();
  if (!clean) {
    throw new TypeError(`${name} is required`);
  }
  return clean.slice(0, maxLength);
}

function optionalString(value, maxLength) {
  const clean = String(value ?? '').trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function boundedString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function serializeDetail(detail) {
  if (detail === undefined || detail === null) {
    return null;
  }
  const normalized = normalizeDetailValue(detail, 0);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > ACTIVITY_DETAIL_MAX_BYTES) {
    throw new TypeError(`detail exceeds ${ACTIVITY_DETAIL_MAX_BYTES} bytes`);
  }
  return json;
}

function normalizeDetailValue(value, depth) {
  if (depth > DETAIL_MAX_DEPTH) {
    throw new TypeError(`detail exceeds ${DETAIL_MAX_DEPTH} levels`);
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('detail numbers must be finite');
    }
    return value;
  }
  if (typeof value === 'string') {
    return value.slice(0, DETAIL_STRING_MAX);
  }
  if (Array.isArray(value)) {
    if (value.length > DETAIL_MAX_KEYS) {
      throw new TypeError(`detail arrays are limited to ${DETAIL_MAX_KEYS} entries`);
    }
    return value.map((entry) => normalizeDetailValue(entry, depth + 1));
  }
  if (!isPlainObject(value)) {
    throw new TypeError('detail contains an unsupported value');
  }
  const entries = Object.entries(value);
  if (entries.length > DETAIL_MAX_KEYS) {
    throw new TypeError(`detail objects are limited to ${DETAIL_MAX_KEYS} keys`);
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => [
      requiredDetailKey(key),
      normalizeDetailValue(entry, depth + 1),
    ]),
  );
}

function requiredDetailKey(value) {
  const clean = requiredString(value, 'detail key', DETAIL_KEY_MAX);
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(clean)) {
    throw new TypeError('detail key has an invalid format');
  }
  return clean;
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('activity time is invalid');
  }
  return date;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
