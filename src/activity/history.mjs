import { ACTIVITY_RETENTION_DAYS } from './log.mjs';

export const ACTIVITY_PAGE_LIMIT = 50;
export const ACTIVITY_EXPORT_LIMIT = 5000;

export const ACTIVITY_CATEGORIES = Object.freeze([
  'system',
  'settings',
  'frame',
  'voice',
  'enrich',
  'curation',
]);

export const ACTIVITY_TYPES = Object.freeze([
  'system.start',
  'system.stop',
  'settings.changed',
  'frame.command',
  'voice.command',
  'voice.tell-me',
  'voice.interesting',
  'voice.tts',
  'enrich.photo',
  'enrich.run',
  'curation.favorite',
  'curation.never-show',
  'curation.discard',
  'curation.restore',
  'curation.decision',
  'curation.referee',
]);

const TOKEN_MAX = 128;
const FILTER_TEXT_MAX = 4000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CURSOR_MAX = 768;
const PAGE_LIMIT_MAX = 200;
const SAFE_CURSOR_KEY = /^[1-5]:[A-Za-z0-9_-]{1,256}$/;

export class ActivityQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActivityQueryError';
  }
}

export function createActivityHistory({ repo, now = () => new Date() } = {}) {
  if (!repo?.listActivityHistory) {
    throw new TypeError('repo.listActivityHistory is required');
  }

  function query(rawOptions = {}, { exportLimit = null } = {}) {
    const filters = normalizeFilters(rawOptions);
    const limit = exportLimit === null
      ? boundedInteger(rawOptions.limit, ACTIVITY_PAGE_LIMIT, 1, PAGE_LIMIT_MAX, 'limit')
      : exportLimit;
    const before = rawOptions.cursor ? decodeCursor(rawOptions.cursor) : null;
    const current = normalizeNow(now);
    const operationalSince = new Date(current.getTime() - ACTIVITY_RETENTION_DAYS * DAY_MS).toISOString();
    const result = repo.listActivityHistory({ ...filters, operationalSince, before, limit });
    const voiceSignal = repo.activityVoiceCommandSignal({
      since: new Date(current.getTime() - 7 * DAY_MS).toISOString(),
    });
    return {
      items: result.events,
      nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
      filters,
      retention: {
        operationalDays: ACTIVITY_RETENTION_DAYS,
        domainHistory: 'retained',
      },
      signals: {
        voiceCommands7d: voiceSignal.total,
        unrecognizedVoiceCommands7d: voiceSignal.unrecognized,
      },
    };
  }

  return {
    list(rawOptions = {}) {
      return query(rawOptions);
    },
    export(rawOptions = {}) {
      const result = query({ ...rawOptions, cursor: null }, { exportLimit: ACTIVITY_EXPORT_LIMIT });
      return {
        ...result,
        generatedAt: normalizeNow(now).toISOString(),
        truncated: Boolean(result.nextCursor),
        limit: ACTIVITY_EXPORT_LIMIT,
      };
    },
  };
}

export function activityExportJson(result) {
  return `${JSON.stringify({
    generatedAt: result.generatedAt,
    filters: result.filters,
    retention: result.retention,
    signals: result.signals,
    truncated: result.truncated,
    limit: result.limit,
    events: result.items,
  }, null, 2)}\n`;
}

export function activityExportCsv(result) {
  const columns = [
    'at',
    'category',
    'type',
    'source',
    'deviceId',
    'assetId',
    'provider',
    'model',
    'outcome',
    'summary',
    'retention',
    'detail',
    'export_truncated',
    'export_limit',
  ];
  const rows = result.items.map((event) => columns.map((column) => {
    if (column === 'detail') {
      return csvCell(event.detail === null ? '' : JSON.stringify(event.detail));
    }
    if (column === 'export_truncated') {
      return csvCell(result.truncated ? 'true' : 'false');
    }
    if (column === 'export_limit') {
      return csvCell(result.limit);
    }
    return csvCell(event[column] ?? '');
  }).join(','));
  return `${columns.join(',')}\n${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
}

function normalizeFilters(options) {
  const category = optionalToken(options.category, 'category');
  const type = optionalToken(options.type, 'type');
  if (category && !ACTIVITY_CATEGORIES.includes(category)) {
    throw new ActivityQueryError('Unknown activity category.');
  }
  if (type && !ACTIVITY_TYPES.includes(type)) {
    throw new ActivityQueryError('Unknown activity type.');
  }
  if (category && type && !type.startsWith(`${category}.`)) {
    throw new ActivityQueryError('Activity type does not belong to the selected category.');
  }
  const since = options.since ? normalizeDate(options.since, 'since') : null;
  const until = options.until ? normalizeDate(options.until, 'until') : null;
  if (since && until && since > until) {
    throw new ActivityQueryError('The start time must be before the end time.');
  }
  return {
    category,
    type,
    provider: optionalText(options.provider, 'provider', FILTER_TEXT_MAX),
    model: optionalText(options.model, 'model', FILTER_TEXT_MAX),
    since,
    until,
  };
}

function optionalToken(value, name) {
  const clean = optionalText(value, name);
  if (clean && !/^[a-z][a-z0-9_.-]*$/.test(clean)) {
    throw new ActivityQueryError(`${name} has an invalid format.`);
  }
  return clean;
}

function optionalText(value, name, maxLength = TOKEN_MAX) {
  const clean = String(value ?? '').trim();
  if (clean.length > maxLength) {
    throw new ActivityQueryError(`${name} is too long.`);
  }
  return clean || null;
}

function normalizeDate(value, name) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ActivityQueryError(`${name} must be a valid date and time.`);
  }
  return date.toISOString();
}

function normalizeNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ActivityQueryError('current time must be a valid date and time.');
  }
  return date;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ActivityQueryError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  const encoded = String(cursor ?? '');
  if (!encoded || encoded.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new ActivityQueryError('Activity cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const at = normalizeDate(parsed?.at, 'cursor timestamp');
    const key = String(parsed?.key ?? '');
    if (!SAFE_CURSOR_KEY.test(key)) {
      throw new Error('invalid key');
    }
    return { at, key };
  } catch (error) {
    if (error instanceof ActivityQueryError) {
      throw error;
    }
    throw new ActivityQueryError('Activity cursor is invalid.');
  }
}

// CSV is often opened directly in spreadsheet software. A leading formula
// marker (including tab/CR) must be rendered as text even when it came from a
// locally configured provider or model identifier.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\t\r\n]/.test(text) || /^[ ]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}
