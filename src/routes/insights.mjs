import { readJsonBody, sendError, sendImage, sendJson } from '../http.mjs';
import { SettingsError } from '../settings.mjs';
import { MAX_INSIGHTS_TAG_ID_LENGTH } from '../insights/repository.mjs';
import { createTraversalBudget, parseProgressingPage, UpstreamPaginationError } from '../pagination.mjs';
import { isValidCalendarDay } from '../insights/dates.mjs';

const PHOTOS_MAX_PAGE_SIZE = 200;
const SLICE_MAX_PAGES = 1_000;
const SLICE_MAX_ITEMS = 250_000;
const SLICE_TRAVERSAL_TIMEOUT_MS = 2 * 60_000;

export function createInsightsRoutes({ collector, repo, immich, config, settingsStore, requireImmich }) {
  return async function handleInsightsRoute(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/insights') {
      sendJson(response, 200, {
        snapshot: collector.snapshot(),
        status: collector.status(),
        immichUrl: config.immichPublicUrl || null,
        favoritesTag: favoritesTagInfo({ repo, config }),
        locationGroups: config.insights.locationGroups,
      });
      return true;
    }

    // Synthetic locations: user-defined city groups, persisted in settings
    // and mirrored into the insights DB for query-time relabeling. Editing
    // groups refreshes the snapshot's Places board immediately — no resweep.
    if (url.pathname === '/api/insights/location-groups') {
      if (request.method === 'GET') {
        sendJson(response, 200, { groups: config.insights.locationGroups });
        return true;
      }
      if (request.method === 'PUT') {
        const body = await readJsonBody(request);
        try {
          settingsStore.update({ insights: { locationGroups: body?.groups ?? [] } });
        } catch (error) {
          if (error instanceof SettingsError) {
            sendError(response, 400, 'invalid_location_groups', error.message);
            return true;
          }
          throw error;
        }
        // settingsStore.onApplied mirrors the groups into the insights DB and
        // refreshes the snapshot's Places board — this route and the generic
        // settings API share that one application path.
        const snapshot = repo.getMeta('snapshot');
        sendJson(response, 200, {
          groups: config.insights.locationGroups,
          places: snapshot?.places ?? null,
        });
        return true;
      }
    }

    // Distinct raw cities for the settings group editor: dominant region for
    // homonym disambiguation, counts, centroids for "add nearby".
    if (request.method === 'GET' && url.pathname === '/api/insights/cities') {
      sendJson(response, 200, { cities: repo.citySummaries() });
      return true;
    }

    // Complete named-people list for the lens search: the snapshot carries
    // only the top few, so without this the lens dropdown can't find anyone
    // below that cutoff.
    if (request.method === 'GET' && url.pathname === '/api/insights/people') {
      sendJson(response, 200, { people: repo.topPeople(10000) });
      return true;
    }

    // Location card: a raw city or a group label.
    if (request.method === 'GET' && url.pathname === '/api/insights/place') {
      const name = String(url.searchParams.get('name') || '').trim();
      const detail = name ? repo.placeDetail(name) : null;
      if (!detail) {
        sendError(response, 404, 'place_not_found', 'No swept photos for this place.');
        return true;
      }
      sendJson(response, 200, detail);
      return true;
    }

    // Redefine the Favorites tile as "photos with this tag" — for libraries
    // curated with a tag instead of Immich hearts. Persisted in settings so
    // every browser sees it; counted immediately and again on every sweep.
    if (url.pathname === '/api/insights/favorites-tag') {
      if (request.method === 'PUT') {
        if (!requireImmich(response)) {
          return true;
        }
        const body = await readJsonBody(request);
        const id = String(body?.id ?? '').trim();
        const value = String(body?.value ?? '').trim();
        if (!id) {
          sendError(response, 400, 'invalid_favorites_tag', 'A tag id is required.');
          return true;
        }
        // Count first: if Immich rejects the tag id, nothing is persisted.
        const stats = await immich.searchStatistics({ tagIds: [id] });
        const count = Number(stats?.total ?? 0);
        settingsStore.update({ insights: { favoritesTagId: id, favoritesTagValue: value } });
        repo.setMeta('favoritesTag', { id, value, count });
        sendJson(response, 200, { favoritesTag: { id, value, count } });
        return true;
      }
      if (request.method === 'DELETE') {
        settingsStore.update({ insights: { favoritesTagId: null, favoritesTagValue: null } });
        repo.setMeta('favoritesTag', null);
        sendJson(response, 200, { favoritesTag: favoritesTagInfo({ repo, config }) });
        return true;
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/insights/status') {
      sendJson(response, 200, collector.status());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/insights/refresh') {
      if (!requireImmich(response)) {
        return true;
      }
      try {
        sendJson(response, 202, collector.start());
      } catch (error) {
        sendError(response, 409, 'insights_refresh_conflict', error instanceof Error ? error.message : String(error));
      }
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/insights/cancel') {
      sendJson(response, 200, { cancelled: collector.cancel() });
      return true;
    }

    // Insight → photos: run a slice's filters against Immich and return a page
    // of assets for the browser grid. Thumbnails load through the existing
    // authenticated asset-thumbnail proxy.
    if (request.method === 'POST' && url.pathname === '/api/insights/photos') {
      if (!requireImmich(response)) {
        return true;
      }
      const body = await readJsonBody(request);
      const filters = normalizeSliceFilters(body?.filters);
      if (!filters) {
        sendError(response, 400, 'invalid_slice', 'At least one slice filter is required.');
        return true;
      }
      const size = clampInt(body?.size, 1, PHOTOS_MAX_PAGE_SIZE, 100);
      // Multi-city slices (synthetic locations) page through the member
      // cities sequentially — Immich's search takes a single city.
      if (Array.isArray(filters.cities)) {
        const result = await searchCitiesPage({ immich, filters, cursor: body?.page, size });
        sendJson(response, 200, result);
        return true;
      }
      const page = clampInt(body?.page, 1, 10_000, 1);
      const result = await immich.searchMetadata({
        ...filters,
        order: 'desc',
        page,
        size,
        withExif: false,
      });
      const nextPage = result?.assets?.nextPage;
      sendJson(response, 200, {
        items: mapPhotoItems(result),
        page,
        nextPage: nextPage === null || nextPage === undefined ? null : Number(nextPage),
      });
      return true;
    }

    // Year drill-down: everything from the local sweep, including people
    // (the asset_people join table replaced v2's live per-person queries).
    const yearMatch = url.pathname.match(/^\/api\/insights\/year\/(\d{4})$/);
    if (request.method === 'GET' && yearMatch) {
      const year = Number(yearMatch[1]);
      const detail = repo.yearDetail(year);
      if (detail.count === 0) {
        sendError(response, 404, 'year_not_found', `No swept assets for ${year}.`);
        return true;
      }
      detail.people = repo.peopleForYear(year, config.insights.topPeople);
      // Honor the user-defined favorites tag: the sweep only knows Immich
      // hearts, so the tag count comes from one cached statistics call.
      if (config.insights.favoritesTagId) {
        detail.favorites = await yearFavoritesTagCount({ repo, immich, config, year });
      }
      sendJson(response, 200, detail);
      return true;
    }

    // Month drill inside the year panel: the People and Places lists scoped
    // to one month, from the same local-sweep sources as the year detail.
    // An empty month returns empty lists rather than 404 — the client only
    // asks for months the histogram shows as non-empty.
    const monthMatch = url.pathname.match(/^\/api\/insights\/year\/(\d{4})\/month\/(\d{1,2})$/);
    if (request.method === 'GET' && monthMatch) {
      const year = Number(monthMatch[1]);
      const month = Number(monthMatch[2]);
      if (month < 1 || month > 12) {
        sendError(response, 400, 'invalid_month', 'Month must be between 1 and 12.');
        return true;
      }
      const detail = repo.monthDetail(year, month);
      detail.people = repo.peopleForMonth(year, month, config.insights.topPeople);
      sendJson(response, 200, detail);
      return true;
    }

    // Person card: span, top places, and strongest connections for one named
    // person — all local SQL over the sweep join table.
    const personMatch = url.pathname.match(/^\/api\/insights\/person\/([^/]+)$/);
    if (request.method === 'GET' && personMatch) {
      const detail = repo.personDetail(decodeURIComponent(personMatch[1]));
      if (!detail) {
        sendError(response, 404, 'person_not_found', 'No swept photos for this person.');
        return true;
      }
      sendJson(response, 200, detail);
      return true;
    }

    // Timeline: without a range, a weekly overview of the whole collection
    // (for the brush strip); with from/to, per-day location detail (for the
    // ribbon). All local SQL against the sweep.
    if (request.method === 'GET' && url.pathname === '/api/insights/timeline') {
      const from = String(url.searchParams.get('from') || '').trim();
      const to = String(url.searchParams.get('to') || '').trim();
      const home = repo.getMeta('snapshot')?.superlatives?.home ?? null;
      const allDays = repo.timelineDays()
        .filter((entry) => isValidCalendarDay(entry?.day))
        .map((entry) => classifyDay(entry, home, config.insights.tripAwayKm));
      if (/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        sendJson(response, 200, {
          days: allDays
            .filter((entry) => entry.day >= from && entry.day <= to)
            .map(({ day, count, city, country, away }) => ({ day, count, city, country, away })),
          // Per-place truth for the Locations list (each photo under its own
          // label, images only) — the day rows above carry one dominant
          // label per day, which is right for the ribbon but not for counts.
          places: repo.timelinePlaces(from, to),
        });
        return true;
      }
      const weeks = new Map();
      for (const entry of allDays) {
        const week = weekStart(entry.day);
        if (!week) continue;
        const slot = weeks.get(week) ?? { week, count: 0, days: 0, awayDays: 0, cities: new Map() };
        slot.count += entry.count;
        slot.days += 1;
        if (entry.away) {
          slot.awayDays += 1;
        }
        if (entry.city) {
          slot.cities.set(entry.city, (slot.cities.get(entry.city) ?? 0) + entry.count);
        }
        weeks.set(week, slot);
      }
      sendJson(response, 200, {
        weeks: [...weeks.values()]
          .sort((a, b) => (a.week < b.week ? -1 : 1))
          .map(({ cities, ...slot }) => ({
            ...slot,
            city: [...cities.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
          })),
      });
      return true;
    }

    // Histogram lens: per-year counts for one person/place/tag. People and
    // places are local SQL; tags need live Immich counts, cached per snapshot.
    if (request.method === 'GET' && url.pathname === '/api/insights/lens') {
      const type = String(url.searchParams.get('type') || '');
      const id = String(url.searchParams.get('id') || '').trim();
      const name = String(url.searchParams.get('name') || '').trim();
      if (type === 'person' && id) {
        sendJson(response, 200, { years: repo.personYearHistogram(id) });
        return true;
      }
      if (type === 'city' && name) {
        sendJson(response, 200, { years: repo.placeYearHistogram({ city: name }) });
        return true;
      }
      if (type === 'country' && name) {
        sendJson(response, 200, { years: repo.placeYearHistogram({ country: name }) });
        return true;
      }
      if (type === 'tag' && id) {
        if (id.length > MAX_INSIGHTS_TAG_ID_LENGTH) {
          sendError(response, 400, 'invalid_lens', 'The tag id is too long.');
          return true;
        }
        if (!repo.hasKnownTag(id)) {
          sendError(response, 404, 'tag_not_found', 'This tag is not in the current Insights snapshot.');
          return true;
        }
        if (!requireImmich(response)) {
          return true;
        }
        sendJson(response, 200, { years: await tagLens({ repo, immich, config, tagId: id }) });
        return true;
      }
      sendError(response, 400, 'invalid_lens', 'Expected type=person|city|country|tag with an id or name.');
      return true;
    }

    const faceMatch = url.pathname.match(/^\/api\/insights\/people\/([^/]+)\/thumbnail$/);
    if (request.method === 'GET' && faceMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const image = await immich.getPersonThumbnail(decodeURIComponent(faceMatch[1]));
      response.setHeader('Cache-Control', 'private, max-age=86400');
      sendImage(response, 200, image.data);
      return true;
    }

    return false;
  };
}

function mapPhotoItems(result) {
  const items = result?.assets?.items;
  if (!Array.isArray(items)) {
    throw new UpstreamPaginationError('Immich slice resolution returned an invalid items page.');
  }
  return items.map((asset) => ({
    id: asset.id,
    type: asset.type ?? 'IMAGE',
    takenAt: asset.localDateTime ?? asset.fileCreatedAt ?? null,
    // Carried so slice resolution can upsert asset metadata locally
    // ("Send to Curate" needs filenames without per-asset Immich calls).
    originalPath: asset.originalPath ?? null,
    fileCreatedAt: asset.fileCreatedAt ?? null,
  }));
}

// Resolve a slice to a flat image-asset-id list — used by "Send to Enrich".
// Caps at `max`: with skip-already-enriched on, repeat sends walk the rest.
// An optional `filterNeedsWork` batch filter (ids → { needy, successful,
// failureLimited } sets) makes the cap collect photos that still need
// work: pages keep coming until `max` photos survive the filter or the
// slice is exhausted, so repeat runs on a capped slice genuinely advance
// instead of re-resolving the same first window. To keep `truncated` exact,
// scanning continues after `max` until one more needy
// photo turns up (truncated) or the slice ends (not), so a finished run
// can truthfully retire its queue item. `coveredAssetIds` carries every
// scanned already-successful id (the caller review-lists them, standing in
// for the runner's skip path), `failureLimitedCount` and `discardedCount`
// keep "fully covered" honest, and zero surviving ids with a non-zero
// `scannedImages` means "nothing left to analyze", as opposed to a slice
// matching nothing at all.
export async function resolveSliceAssetIds({ immich, rawFilters, max = 1000, filterNeedsWork = null }) {
  const filters = normalizeSliceFilters(rawFilters);
  if (!filters) {
    return null;
  }
  const ids = [];
  const assets = [];
  const coveredAssetIds = [];
  let cursor;
  let truncated = false;
  let scannedImages = 0;
  let failureLimitedCount = 0;
  let discardedCount = 0;
  const budget = createTraversalBudget({
    label: 'Immich slice resolution',
    maxPages: SLICE_MAX_PAGES,
    maxItems: SLICE_MAX_ITEMS,
    timeoutMs: SLICE_TRAVERSAL_TIMEOUT_MS,
  });
  while (true) {
    // Unfiltered, fetch just past the remaining need so an overflow item
    // marks truncation. Filtered, always fetch full pages: most of a page
    // may be dropped, and each page is a single batched needs-work query.
    const size = filterNeedsWork ? 1000 : Math.min(1000, max - ids.length + 1);
    let items;
    let next;
    if (Array.isArray(filters.cities)) {
      const result = await searchCitiesPage({ immich, filters, cursor, size, budget });
      items = result.items;
      next = result.nextPage;
    } else {
      const page = typeof cursor === 'number' ? cursor : 1;
      budget.beginPage();
      const result = await immich.searchMetadata({ ...filters, order: 'desc', page, size, withExif: false });
      items = mapPhotoItems(result);
      budget.recordItems(items.length);
      const nextPage = result?.assets?.nextPage;
      next = parseProgressingPage(nextPage, page, { label: 'Immich slice resolution' });
    }
    const images = items.filter((item) => item.type === 'IMAGE'); // enrichment analyzes images only
    scannedImages += images.length;
    let wanted = images;
    if (filterNeedsWork && images.length > 0) {
      const verdict = await filterNeedsWork(images.map((item) => item.id));
      wanted = images.filter((item) => verdict.needy.has(item.id));
      coveredAssetIds.push(...verdict.successful);
      failureLimitedCount += verdict.failureLimited.size;
      discardedCount += verdict.discarded?.size ?? 0;
    }
    for (const item of wanted) {
      if (ids.length >= max) {
        truncated = true;
        break;
      }
      ids.push(item.id);
      assets.push({ id: item.id, originalPath: item.originalPath, fileCreatedAt: item.fileCreatedAt });
    }
    if (truncated || next === null) {
      break;
    }
    cursor = next;
  }
  return { assetIds: ids, assets, truncated, scannedImages, coveredAssetIds, failureLimitedCount, discardedCount };
}

// One "page" of a multi-city slice: pages through member cities in order,
// with an object cursor { ci, p } the client echoes back verbatim. Exhausting
// one city hands the cursor to the next; empty cities are skipped inline.
export async function searchCitiesPage({ immich, filters, cursor, size, budget = null }) {
  const { cities, ...rest } = filters;
  const traversal = budget ?? createTraversalBudget({
    label: 'Immich multi-city search',
    maxPages: SLICE_MAX_PAGES,
    maxItems: SLICE_MAX_ITEMS,
    timeoutMs: SLICE_TRAVERSAL_TIMEOUT_MS,
  });
  let cityIndex = 0;
  let page = 1;
  if (cursor && typeof cursor === 'object') {
    cityIndex = clampInt(cursor.ci, 0, cities.length - 1, 0);
    page = clampInt(cursor.p, 1, 10_000, 1);
  }
  while (cityIndex < cities.length) {
    traversal.beginPage();
    const result = await immich.searchMetadata({
      ...rest,
      city: cities[cityIndex],
      order: 'desc',
      page,
      size,
      withExif: false,
    });
    const items = mapPhotoItems(result);
    traversal.recordItems(items.length);
    const nextPage = result?.assets?.nextPage;
    if (nextPage !== null && nextPage !== undefined) {
      return {
        items,
        page: { ci: cityIndex, p: page },
        nextPage: {
          ci: cityIndex,
          p: parseProgressingPage(nextPage, page, { label: 'Immich multi-city search' }),
        },
      };
    }
    const moreCities = cityIndex + 1 < cities.length;
    if (items.length > 0) {
      return { items, page: { ci: cityIndex, p: page }, nextPage: moreCities ? { ci: cityIndex + 1, p: 1 } : null };
    }
    // This city had nothing (left): fall through to the next one.
    cityIndex += 1;
    page = 1;
  }
  return { items: [], page: cursor ?? { ci: 0, p: 1 }, nextPage: null };
}

async function yearFavoritesTagCount({ repo, immich, config, year }) {
  const tagId = config.insights.favoritesTagId;
  const snapshot = repo.getMeta('snapshot');
  const cacheKey = `yearFavTag:${year}`;
  const cached = repo.getMeta(cacheKey);
  if (cached && cached.generatedAt === snapshot?.generatedAt && cached.tagId === tagId) {
    return cached.count;
  }
  try {
    const stats = await immich.searchStatistics({
      tagIds: [tagId],
      takenAfter: `${year}-01-01T00:00:00.000Z`,
      takenBefore: `${year}-12-31T23:59:59.999Z`,
    });
    const count = Number(stats?.total ?? 0);
    repo.setMeta(cacheKey, { generatedAt: snapshot?.generatedAt ?? null, tagId, count });
    return count;
  } catch {
    return 0;
  }
}

function classifyDay(entry, home, awayKm) {
  if (!home || entry.lat === null) {
    return { ...entry, away: false };
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(entry.lat - home.lat);
  const dLon = toRad(entry.lon - home.lon);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(home.lat)) * Math.cos(toRad(entry.lat)) * Math.sin(dLon / 2) ** 2;
  const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return { ...entry, away: distanceKm > awayKm };
}

// Monday of the week containing the given YYYY-MM-DD day.
function weekStart(day) {
  if (!isValidCalendarDay(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function favoritesTagInfo({ repo, config }) {
  const id = config.insights.favoritesTagId;
  if (!id) {
    return null;
  }
  const meta = repo.getMeta('favoritesTag');
  return {
    id,
    value: config.insights.favoritesTagValue || meta?.value || '',
    count: meta && meta.id === id ? Number(meta.count ?? 0) : null,
  };
}

// Per-year counts for one tag: one statistics call per snapshot year the
// first time, then served from the meta cache until the next sweep.
async function tagLens({ repo, immich, config, tagId }) {
  const snapshot = repo.getMeta('snapshot');
  const cacheKey = `tagLens:${tagId}`;
  const cached = repo.getMeta(cacheKey);
  if (cached && cached.generatedAt === snapshot?.generatedAt) {
    return cached.years;
  }
  const snapshotYears = (snapshot?.years ?? []).map((entry) => entry.year);
  const years = [];
  await mapWithConcurrency(snapshotYears, config.insights.statConcurrency, async (year) => {
    const stats = await immich.searchStatistics({
      tagIds: [tagId],
      takenAfter: `${year}-01-01T00:00:00.000Z`,
      takenBefore: `${year}-12-31T23:59:59.999Z`,
    });
    const count = Number(stats?.total ?? 0);
    if (count > 0) {
      years.push({ year, count });
    }
  });
  years.sort((a, b) => a.year - b.year);
  repo.setMeta(cacheKey, { generatedAt: snapshot?.generatedAt ?? null, years });
  return years;
}

// Whitelist and shape the slice filters this endpoint will forward to Immich.
// `day` expands to a takenAfter/takenBefore day window.
export function normalizeSliceFilters(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const filters = {};
  const ids = (value) => (Array.isArray(value) ? value.map((id) => String(id || '').trim()).filter(Boolean) : []);
  const personIds = ids(raw.personIds);
  const tagIds = ids(raw.tagIds);
  if (personIds.length > 0) {
    filters.personIds = personIds;
  }
  if (tagIds.length > 0) {
    filters.tagIds = tagIds;
  }
  // A synthetic location's member cities (OR). Never forwarded to Immich
  // as-is — the photos route fans out one search per city.
  const cities = ids(raw.cities).slice(0, 500);
  if (cities.length > 0) {
    filters.cities = cities;
  }
  for (const key of ['city', 'state', 'country', 'make', 'model']) {
    // Explicit null on a location field means "field is unset" — Immich's
    // metadata search honors it (how "No location" and country-only slices
    // open exactly the photos their list rows counted).
    if (raw[key] === null && key !== 'make' && key !== 'model') {
      filters[key] = null;
      continue;
    }
    const value = String(raw[key] ?? '').trim();
    if (value) {
      filters[key] = value;
    }
  }
  if (typeof raw.isFavorite === 'boolean') {
    filters.isFavorite = raw.isFavorite;
  }
  const day = String(raw.day ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    filters.takenAfter = `${day}T00:00:00.000Z`;
    filters.takenBefore = `${day}T23:59:59.999Z`;
  } else {
    for (const [key, boundary] of [['takenAfter', 'start'], ['takenBefore', 'end']]) {
      const value = String(raw[key] ?? '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        filters[key] = boundary === 'end' ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
      } else if (value && !Number.isNaN(Date.parse(value))) {
        filters[key] = new Date(value).toISOString();
      }
    }
  }
  if (String(raw.type ?? '').toUpperCase() === 'IMAGE' || String(raw.type ?? '').toUpperCase() === 'VIDEO') {
    filters.type = String(raw.type).toUpperCase();
  }
  return Object.keys(filters).length > 0 ? filters : null;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

async function mapWithConcurrency(items, concurrency, work) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await work(item);
    }
  });
  await Promise.all(workers);
}
