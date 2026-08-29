import { extractImageAssets } from '../immich.mjs';
import {
  FRAME_ELIGIBLE_TAG,
  getRequiredFrameEligibleTagId,
} from '../frame/tags.mjs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MONTH_NAMES = new Map([
  ['january', 1],
  ['jan', 1],
  ['february', 2],
  ['feb', 2],
  ['march', 3],
  ['mar', 3],
  ['april', 4],
  ['apr', 4],
  ['may', 5],
  ['june', 6],
  ['jun', 6],
  ['july', 7],
  ['jul', 7],
  ['august', 8],
  ['aug', 8],
  ['september', 9],
  ['sep', 9],
  ['sept', 9],
  ['october', 10],
  ['oct', 10],
  ['november', 11],
  ['nov', 11],
  ['december', 12],
  ['dec', 12],
]);

export class PhotoShowSearchError extends Error {
  constructor(message, status = 400, code = 'show_search_error') {
    super(message);
    this.name = 'PhotoShowSearchError';
    this.status = status;
    this.code = code;
  }
}

export function validateShowSearchRequest(body) {
  const query = typeof body?.query === 'string' ? body.query.trim() : '';

  if (!query) {
    return { error: 'Search query is required.' };
  }

  if (query.length > 300) {
    return { error: 'Search query is too long.' };
  }

  return {
    value: {
      frameEligibleOnly: body?.frameEligibleOnly !== false,
      limit: clampLimit(body?.limit),
      query,
    },
  };
}

export async function searchShowPhotos({ frameEligibleOnly = true, immich, limit = DEFAULT_LIMIT, query }) {
  const parsed = parseShowSearchQuery(query);

  if (!parsed.personName && !parsed.place && !parsed.dateRange) {
    throw new PhotoShowSearchError('Try a search like “show Alice in Paris in 2025”.', 400, 'empty_show_search');
  }

  const tagIds = frameEligibleOnly ? [await getRequiredFrameEligibleTagId(immich, createFrameEligibleTagMissingError)] : undefined;
  const person = parsed.personName ? await resolveSinglePerson(immich, parsed.personName) : null;
  const baseSearch = {
    isArchived: false,
    size: limit,
    type: 'IMAGE',
    visibility: 'timeline',
    withExif: true,
    ...(tagIds ? { tagIds } : {}),
    ...(person ? { personIds: [person.id] } : {}),
    ...(parsed.dateRange ?? {}),
  };

  const assets = await searchAssets(immich, baseSearch, parsed.place, limit);

  return {
    query,
    displayTitle: buildDisplayTitle({ parsed, person }),
    spokenSummary: buildSpokenSummary({ assets, parsed, person }),
    criteria: {
      dateRange: parsed.dateRange ?? null,
      frameEligibleOnly,
      limit,
      people: person ? [{ id: person.id, name: person.name }] : [],
      place: parsed.place,
    },
    assets: assets.slice(0, limit),
    warnings: [],
  };
}

export function parseShowSearchQuery(query) {
  let working = cleanQuery(query);
  const { dateRange, label: dateLabel } = extractDateRange(working);

  if (dateLabel) {
    working = working
      .replace(new RegExp(`\\b(?:in|from|during)?\\s*${escapeRegExp(dateLabel)}\\b`, 'i'), ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  working = stripLeadingPhotoWords(working);

  let personName = '';
  let place = '';

  const leadingPlace = working.match(/^(?:in|at|near|around)\s+(.+)$/i);
  if (leadingPlace) {
    place = cleanEntity(leadingPlace[1]);
  } else {
    const placeMatch = working.match(/\b(?:in|at|near|around)\s+(.+)$/i);
    if (placeMatch?.index !== undefined) {
      personName = cleanEntity(working.slice(0, placeMatch.index));
      place = cleanEntity(placeMatch[1]);
    } else {
      personName = cleanEntity(working);
    }
  }

  return {
    dateRange,
    dateLabel,
    personName,
    place,
  };
}

async function searchAssets(immich, baseSearch, place, limit) {
  if (place) {
    const metadataAssets = extractImageAssets(await immich.searchMetadata({
      ...baseSearch,
      city: place,
      page: 1,
      size: Math.min(Math.max(limit * 2, limit), MAX_LIMIT),
    }));
    const metadataPlaceMatches = filterAssetsByPlace(metadataAssets, place);

    if (metadataPlaceMatches.length > 0) {
      return shuffleAssets(metadataPlaceMatches).slice(0, limit);
    }

    try {
      const smartAssets = extractImageAssets(await immich.searchSmart({
        ...baseSearch,
        page: 1,
        query: place,
        size: Math.min(Math.max(limit * 2, limit), MAX_LIMIT),
      }));

      const smartPlaceMatches = filterAssetsByPlace(smartAssets, place);

      if (smartPlaceMatches.length > 0) {
        return shuffleAssets(smartPlaceMatches).slice(0, limit);
      }
    } catch (error) {
      console.warn('[Pictaria] Immich smart search failed; falling back to metadata city search.', summarizeError(error));
    }

    return [];
  }

  return shuffleAssets(extractImageAssets(await immich.searchRandom(baseSearch))).slice(0, limit);
}

function filterAssetsByPlace(assets, place) {
  const normalizedPlace = normalizeEntity(place);

  if (!normalizedPlace) {
    return assets;
  }

  return assets.filter((asset) => {
    const candidates = [
      asset?.city,
      asset?.state,
      asset?.country,
      asset?.locationLabel,
      asset?.exifInfo?.city,
      asset?.exifInfo?.state,
      asset?.exifInfo?.country,
    ].map(normalizeEntity);

    return candidates.some((candidate) => candidate === normalizedPlace);
  });
}

function createFrameEligibleTagMissingError() {
  return new PhotoShowSearchError(
    `The ${FRAME_ELIGIBLE_TAG} tag was not found in Immich.`,
    503,
    'frame_eligible_tag_missing',
  );
}

async function resolveSinglePerson(immich, personName) {
  const people = await immich.searchPeople(personName);
  const normalizedName = normalizeEntity(personName);
  const exactMatches = people.filter((person) => normalizeEntity(person?.name) === normalizedName);
  const matches = exactMatches.length > 0 ? exactMatches : people.filter((person) => person?.id && person?.name);

  if (matches.length === 0) {
    throw new PhotoShowSearchError(`I couldn't find a person named ${personName}.`, 404, 'person_not_found');
  }

  if (matches.length > 1) {
    throw new PhotoShowSearchError(`I found more than one person named ${personName}.`, 409, 'person_ambiguous');
  }

  return matches[0];
}

function buildDisplayTitle({ parsed, person }) {
  const parts = [];

  if (person?.name) {
    parts.push(person.name);
  }

  if (parsed.place) {
    parts.push(person?.name ? `in ${toDisplayText(parsed.place)}` : toDisplayText(parsed.place));
  }

  if (parsed.dateLabel) {
    parts.push(`in ${parsed.dateLabel}`);
  }

  return parts.length > 0 ? parts.join(' ') : toDisplayText(parsed.personName || parsed.place || 'Search results');
}

function buildSpokenSummary({ assets, parsed, person }) {
  const countText = assets.length === 1 ? '1 photo' : `${assets.length} photos`;
  return `Showing ${countText} for ${buildDisplayTitle({ parsed, person })}.`;
}

function cleanQuery(query) {
  return String(query || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^show(?:\s+me)?(?:\s+(?:photos|pictures|pics|images))?(?:\s+of)?\s+/i, '')
    .trim();
}

function stripLeadingPhotoWords(value) {
  return value
    .replace(/^(?:me\s+)?(?:photos|pictures|pics|images)\s+(?:of\s+)?/i, '')
    .replace(/^of\s+/i, '')
    .trim();
}

function cleanEntity(value) {
  return String(value || '')
    .replace(/\b(?:photos|pictures|pics|images)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^of\s+/i, '')
    .replace(/\s+(?:photos|pictures|pics|images)$/i, '')
    .trim();
}

function extractDateRange(value) {
  const monthYearMatch = String(value || '').match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(19\d{2}|20\d{2})\b/i,
  );

  if (monthYearMatch) {
    const month = MONTH_NAMES.get(monthYearMatch[1].toLowerCase());
    const year = Number.parseInt(monthYearMatch[2], 10);

    if (month) {
      const nextMonth = month === 12 ? 1 : month + 1;
      const nextYear = month === 12 ? year + 1 : year;

      return {
        dateRange: {
          takenAfter: `${year}-${padMonth(month)}-01T00:00:00.000Z`,
          takenBefore: `${nextYear}-${padMonth(nextMonth)}-01T00:00:00.000Z`,
        },
        label: monthYearMatch[0],
      };
    }
  }

  const match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
  if (!match) {
    return { dateRange: null, label: '' };
  }

  const year = Number.parseInt(match[1], 10);
  return {
    dateRange: {
      takenAfter: `${year}-01-01T00:00:00.000Z`,
      takenBefore: `${year + 1}-01-01T00:00:00.000Z`,
    },
    label: String(year),
  };
}

function padMonth(month) {
  return String(month).padStart(2, '0');
}

function clampLimit(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_LIMIT), 10);

  if (!Number.isFinite(parsed)) {
    return DEFAULT_LIMIT;
  }

  return Math.min(MAX_LIMIT, Math.max(1, parsed));
}

function shuffleAssets(assets) {
  const shuffled = [...assets];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled;
}

function toDisplayText(value) {
  return String(value || '')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function normalizeEntity(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
