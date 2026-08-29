import crypto from 'node:crypto';

import { UpstreamPaginationError, parseProgressingPage } from '../pagination.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const ADD_BATCH_SIZE = 50;
const REMOVE_BATCH_SIZE = 50;
const NEVER_SHOW_TAG_VALUE = 'frame/never-show';
export const DEFAULT_MAX_RESULTS = 50;
export const MAX_RESULTS_LIMIT = 5000;
export const MAX_SMART_ALBUM_FILTER_ITEMS = 25;
export const MAX_SMART_ALBUM_ID_LENGTH = 200;
export const MAX_SMART_ALBUM_VALUE_LENGTH = 200;
export const MAX_SMART_ALBUM_QUERY_LENGTH = 1000;
export const MAX_SMART_ALBUM_NAME_LENGTH = 200;
export const MAX_SMART_ALBUM_UPSTREAM_REQUESTS = 500;
const PARTIAL_TRAVERSAL_WARNING = 'Search reached the configured page limit. Results include only the matching photos found so far; existing album members will be preserved during reconciliation because the full result could not be confirmed.';

export class SmartAlbumValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmartAlbumValidationError';
    this.code = 'invalid_smart_album';
    this.status = 400;
  }
}

export function validateCreateRequest(body) {
  const query = String(body?.query || '').trim();
  const albumName = String(body?.albumName || '').trim();
  const smart = Boolean(body?.smart);
  const bestOf = Boolean(body?.bestOf);
  const intervalDays = Number(body?.intervalDays ?? 7);
  const includeAllResults = Boolean(body?.includeAllResults);
  const maxResults = includeAllResults ? null : Number(body?.maxResults ?? DEFAULT_MAX_RESULTS);
  let filters;
  try {
    assertBoundedString(query, 'Ranked search', MAX_SMART_ALBUM_QUERY_LENGTH);
    assertBoundedString(albumName, 'Album name', MAX_SMART_ALBUM_NAME_LENGTH);
    filters = normalizeFilters(body?.filters || {});
  } catch (error) {
    if (error instanceof SmartAlbumValidationError) {
      return { error: error.message };
    }
    throw error;
  }

  if (!albumName) {
    return { error: 'Album name is required.' };
  }

  if (!query && !hasFilters(filters)) {
    return { error: 'Add a ranked search or at least one structured filter.' };
  }

  if (bestOf && !query) {
    return { error: 'Best of needs an Immich text search to corroborate.' };
  }

  const validationError = getSearchValidationError({ query, filters });
  if (validationError) {
    return { error: validationError };
  }

  if (smart && (!Number.isFinite(intervalDays) || intervalDays < 1 || intervalDays > 365)) {
    return { error: 'Smart interval must be between 1 and 365 days.' };
  }

  if (!includeAllResults && (!Number.isFinite(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_LIMIT)) {
    return { error: `Top photo limit must be between 1 and ${MAX_RESULTS_LIMIT}.` };
  }

  return {
    value: {
      query,
      albumName,
      smart,
      bestOf,
      intervalDays: smart ? Math.round(intervalDays) : 0,
      includeAllResults,
      maxResults: includeAllResults ? null : Math.round(maxResults),
      filters,
    },
  };
}

export function validateJobPatch(body) {
  const patch = {};

  if (Object.hasOwn(body || {}, 'enabled')) {
    patch.enabled = Boolean(body.enabled);
  }

  if (Object.hasOwn(body || {}, 'smart')) {
    patch.smart = Boolean(body.smart);
  }

  if (Object.hasOwn(body || {}, 'intervalDays')) {
    const intervalDays = Number(body.intervalDays);
    if (!Number.isFinite(intervalDays) || intervalDays < 1 || intervalDays > 365) {
      return { error: 'Smart interval must be between 1 and 365 days.' };
    }
    patch.intervalDays = Math.round(intervalDays);
  }

  if (Object.hasOwn(body || {}, 'maxResults')) {
    const maxResults = Number(body.maxResults);
    if (!Number.isFinite(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS_LIMIT) {
      return { error: `Top photo limit must be between 1 and ${MAX_RESULTS_LIMIT}.` };
    }
    patch.maxResults = Math.round(maxResults);
  }

  if (Object.hasOwn(body || {}, 'includeAllResults')) {
    patch.includeAllResults = Boolean(body.includeAllResults);
  }

  return { value: patch };
}

export async function previewSearch({
  immich,
  config,
  enrichRepo = null,
  query,
  filters = {},
  bestOf = false,
  includeAllResults = false,
  maxResults = DEFAULT_MAX_RESULTS,
  previewLimit = 20,
}) {
  const normalizedFilters = normalizeFilters(filters);
  assertBoundedString(String(query || '').trim(), 'Ranked search', MAX_SMART_ALBUM_QUERY_LENGTH);
  validateSearchOptions({ query, filters: normalizedFilters });
  const resolved = await resolveAlbumAssets({
    immich,
    config,
    enrichRepo,
    query,
    filters: normalizedFilters,
    includeAllResults,
    maxResults,
    bestOf,
  });

  return {
    query,
    filters: normalizedFilters,
    mode: resolved.bestOf ? 'best-of' : query ? 'smart' : 'metadata',
    rankedCount: resolved.assetIds.length,
    includeAllResults,
    maxResults: includeAllResults ? null : maxResults,
    truncated: resolved.truncated,
    reconciliationComplete: resolved.reconciliationComplete,
    warnings: resolved.warnings,
    bestOf: resolved.bestOf,
    assets: resolved.assets.slice(0, previewLimit).map(summarizeAsset),
  };
}

export async function createSmartAlbumJob({ immich, store, config, enrichRepo = null, input }) {
  assertBoundedString(String(input.query || '').trim(), 'Ranked search', MAX_SMART_ALBUM_QUERY_LENGTH);
  assertBoundedString(String(input.albumName || '').trim(), 'Album name', MAX_SMART_ALBUM_NAME_LENGTH);
  const filters = normalizeFilters(input.filters);
  validateSearchOptions({ query: input.query, filters });
  const resolved = await resolveAlbumAssets({
    immich,
    config,
    enrichRepo,
    query: input.query,
    filters,
    includeAllResults: input.includeAllResults,
    maxResults: input.maxResults,
    bestOf: input.bestOf,
  });
  const matchedIds = resolved.assetIds;
  const assetIdsToAdd = matchedIds;
  const description = describeManagedAlbum({ ...input, filters });
  const album = await immich.createAlbum({
    albumName: input.albumName,
    description,
  });

  const albumId = album?.id;
  if (!albumId) {
    throw new Error('Immich did not return an album ID.');
  }

  const now = new Date();
  const job = {
    id: crypto.randomUUID(),
    albumId,
    albumName: input.albumName,
    query: input.query,
    filters,
    smart: input.smart,
    bestOf: Boolean(input.bestOf),
    enabled: input.smart,
    intervalDays: input.intervalDays || 0,
    includeAllResults: input.includeAllResults,
    maxResults: input.maxResults,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastRunAt: null,
    lastSuccessAt: null,
    nextRunAt: input.smart ? computeNextRunAt(now, input.intervalDays).toISOString() : null,
    lastError: null,
    lastResult: null,
  };

  // Store the job before adding assets so a partial add failure never leaves an
  // orphan Immich album with no job record; a retry can run the job instead.
  try {
    await store.addJob(job);
  } catch (error) {
    // The album exists in Immich but its job record could not persist:
    // compensate by deleting the just-created (still empty) album. If the
    // delete also fails, surface the orphan ID so it can be removed by hand.
    try {
      await immich.deleteAlbum(albumId);
    } catch {
      console.error(
        `[Pictaria] Orphan Immich album ${albumId} ("${input.albumName}"): job persistence failed and the compensating delete also failed — remove it in Immich by hand.`,
      );
    }
    throw error;
  }

  try {
    const addedCount = await addAssetsInBatches(immich, albumId, assetIdsToAdd);
    const updated = await store.updateJob(job.id, () => ({
      lastRunAt: now.toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastResult: {
        rankedCount: matchedIds.length,
        addedCount,
        removedCount: 0,
        skippedCount: resolved.foundCount - assetIdsToAdd.length,
        truncated: resolved.truncated,
        reconciliationComplete: resolved.reconciliationComplete,
        warnings: resolved.warnings,
        ...(resolved.bestOf ? { bestOf: resolved.bestOf } : {}),
      },
    }));
    return updated ?? job;
  } catch (error) {
    await store.updateJob(job.id, () => ({
      lastRunAt: now.toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  }
}

// One execution per job at a time, regardless of caller (scheduler tick,
// manual API run, or both at once). In-memory is enough: the server is a
// single process and Smart Album jobs live in one store.
const activeJobRuns = new Set();

export class SmartAlbumRunInProgressError extends Error {
  constructor(jobId) {
    super(`Smart album job ${jobId} is already running.`);
    this.name = 'SmartAlbumRunInProgressError';
    this.code = 'job_running';
  }
}

export async function runSmartAlbumJob({ immich, store, config, enrichRepo = null, jobId }) {
  const job = await store.getJob(jobId);

  if (!job) {
    return null;
  }

  if (activeJobRuns.has(job.id)) {
    throw new SmartAlbumRunInProgressError(job.id);
  }
  activeJobRuns.add(job.id);
  try {
    return await executeSmartAlbumJob({ immich, store, config, enrichRepo, job });
  } finally {
    activeJobRuns.delete(job.id);
  }
}

async function executeSmartAlbumJob({ immich, store, config, enrichRepo, job }) {
  const jobId = job.id;
  const startedAt = new Date();

  try {
    assertBoundedString(String(job.query || '').trim(), 'Ranked search', MAX_SMART_ALBUM_QUERY_LENGTH);
    assertBoundedString(String(job.albumName || '').trim(), 'Album name', MAX_SMART_ALBUM_NAME_LENGTH);
    const filters = normalizeFilters(job.filters || {});
    const resolved = await resolveAlbumAssets({
      immich,
      config,
      enrichRepo,
      query: job.query,
      filters,
      includeAllResults: job.includeAllResults,
      maxResults: job.maxResults || DEFAULT_MAX_RESULTS,
      bestOf: job.bestOf,
      includeAlbumRead: true,
    });
    const existingIds = await searchAlbumAssetIds({ immich, config, albumId: job.albumId });
    const matchedIds = resolved.assetIds;
    const desiredIds = new Set(matchedIds);
    const newIds = matchedIds.filter((assetId) => !existingIds.has(assetId));
    const addedCount = await addAssetsInBatches(immich, job.albumId, newIds);
    let removedCount = 0;
    if (resolved.reconciliationComplete) {
      // Reconcile to the exact desired membership: anything in the album that
      // no longer matches — fell below a ranked cap, metadata changed, or
      // carries a blanket-exclusion tag — comes out. A trustworthy prefix from
      // a capped All-results traversal can add matches, but cannot prove that
      // an absent ID is no longer a match, so that case preserves every member.
      const removeIds = [...existingIds].filter((assetId) => !desiredIds.has(assetId));
      removedCount = await removeAssetsInBatches(immich, job.albumId, removeIds);
    }
    const nextRunAt = job.smart && job.enabled && job.intervalDays
      ? computeNextRunAt(startedAt, job.intervalDays).toISOString()
      : null;

    return store.updateJob(jobId, () => ({
      lastRunAt: startedAt.toISOString(),
      lastSuccessAt: new Date().toISOString(),
      nextRunAt,
      lastError: null,
      lastResult: {
        rankedCount: matchedIds.length,
        addedCount,
        // All reconciliation removals: no-longer-matching, ranked-out, and
        // blanket-excluded assets alike.
        removedCount,
        skippedCount: resolved.foundCount - newIds.length,
        truncated: resolved.truncated,
        reconciliationComplete: resolved.reconciliationComplete,
        warnings: resolved.warnings,
        ...(resolved.bestOf ? { bestOf: resolved.bestOf } : {}),
      },
    }));
  } catch (error) {
    const nextRunAt = job.smart && job.enabled && job.intervalDays
      ? computeNextRunAt(startedAt, job.intervalDays).toISOString()
      : null;

    await store.updateJob(jobId, () => ({
      lastRunAt: startedAt.toISOString(),
      nextRunAt,
      lastError: error instanceof Error ? error.message : String(error),
    }));

    throw error;
  }
}

export async function searchAllAssets({ immich, config, query = '', filters = {}, maxResults = DEFAULT_MAX_RESULTS }) {
  const normalizedQuery = String(query || '').trim();
  assertBoundedString(normalizedQuery, 'Ranked search', MAX_SMART_ALBUM_QUERY_LENGTH);
  const normalizedFilters = normalizeFilters(filters);

  validateSearchOptions({ query: normalizedQuery, filters: normalizedFilters });

  if (!normalizedQuery && shouldExpandMetadataSearch(normalizedFilters)) {
    return searchExpandedMetadataAssets({ immich, config, filters: normalizedFilters, maxResults });
  }

  return searchPagedAssets({
    immich,
    config,
    query: normalizedQuery,
    filters: normalizedFilters,
    maxResults,
  });
}

// One resolution path for preview/create/run: search (plain or Best of),
// apply blanket exclusions, and report counts the same way for both modes.
async function resolveAlbumAssets({
  immich,
  config,
  enrichRepo,
  query,
  filters,
  includeAllResults,
  maxResults,
  bestOf,
  includeAlbumRead = false,
}) {
  const normalizedFilters = normalizeFilters(filters);
  const normalizedQuery = String(query || '').trim();
  assertBoundedString(normalizedQuery, 'Ranked search', MAX_SMART_ALBUM_QUERY_LENGTH);
  assertSmartAlbumWorkBudget({ config, query: normalizedQuery, filters: normalizedFilters, includeAlbumRead });
  const excluded = await searchExcludedAssetIds({ immich, config, filters: normalizedFilters });

  if (bestOf && normalizedQuery) {
    if (!enrichRepo) {
      throw new Error('Best of needs the enrichment database, which is not available here.');
    }
    const result = await searchBestOfAssets({
      immich,
      config,
      enrichRepo,
      query: normalizedQuery,
      filters: normalizedFilters,
      maxResults: includeAllResults ? null : maxResults,
      excludedAssetIds: excluded.assetIds,
    });
    const cap = includeAllResults
      ? MAX_RESULTS_LIMIT
      : Math.max(1, Math.min(Math.round(maxResults || DEFAULT_MAX_RESULTS), MAX_RESULTS_LIMIT));
    // Exclusions were applied inside the collection loop (excluded photos
    // never consumed headroom), so the cap slices eligible assets only.
    const assets = result.assets.slice(0, cap);
    return {
      assets,
      assetIds: assets.map((asset) => asset.id),
      foundCount: result.assets.length,
      truncated: result.truncated,
      reconciliationComplete: result.reconciliationComplete,
      warnings: result.reconciliationComplete
        ? excluded.warnings
        : [...excluded.warnings, PARTIAL_TRAVERSAL_WARNING],
      excludedAssetIds: excluded.assetIds,
      bestOf: result.stats,
    };
  }

  const searchResult = await searchAllAssets({
    immich,
    config,
    query: normalizedQuery,
    filters: normalizedFilters,
    maxResults: includeAllResults ? null : maxResults,
  });
  const assets = searchResult.assets.filter((asset) => !excluded.assetIds.has(asset.id));
  return {
    assets,
    assetIds: assets.map((asset) => asset.id),
    foundCount: searchResult.assetIds.length,
    truncated: searchResult.truncated,
    reconciliationComplete: searchResult.reconciliationComplete,
    warnings: searchResult.reconciliationComplete
      ? excluded.warnings
      : [...excluded.warnings, PARTIAL_TRAVERSAL_WARNING],
    excludedAssetIds: excluded.assetIds,
    bestOf: null,
  };
}

// --- Best of: corroborated semantic search ---
//
// Immich's smart search ranks the whole library and never says where real
// matches end, so a capped album fills its tail with noise. Best of pages the
// same search but keeps only hits the local enrichment data corroborates
// (ai/* tags or caption words matching the query), stops paging once the
// corroboration rate collapses, and ranks what survives by this library's own
// quality signals instead of raw search order.
const BEST_OF_MIN_PAGE_RATE = 0.4; // a page this uncorroborated is tail noise…
const BEST_OF_LOW_PAGES = 2; // …once it happens on consecutive pages
const BEST_OF_HEADROOM = 3; // collect up to 3×cap so rank-time drops (never-show) can't starve the cap

// excludedAssetIds (blanket exclusions, resolved by the caller) are skipped
// DURING collection so they never count toward collectLimit — filtering after
// the loop could underfill an album while eligible photos sat unread past the
// point where collection stopped.
export async function searchBestOfAssets({ immich, config, enrichRepo, query, filters = {}, maxResults = DEFAULT_MAX_RESULTS, excludedAssetIds = new Set() }) {
  const normalizedQuery = String(query || '').trim();
  const normalizedFilters = normalizeFilters(filters);
  const cap = maxResults === null
    ? MAX_RESULTS_LIMIT
    : Math.max(1, Math.min(Math.round(maxResults), MAX_RESULTS_LIMIT));
  const collectLimit = Math.min(cap * BEST_OF_HEADROOM, MAX_RESULTS_LIMIT);
  const signals = buildBestOfSignals(enrichRepo, normalizedQuery);

  const survivors = new Map();
  const seen = new Set();
  let droppedExcluded = 0;
  let droppedLowSignal = 0;
  let notEnriched = 0;
  let pagesScanned = 0;
  let firstPageRate = null;
  let lowStreak = 0;
  let cutoff = 'page-limit';
  let page = 1;
  const seenPageAssetIds = new Set();
  // Density is measured per full page, so the page size must not shrink to the
  // cap the way the plain path's does.
  const pageSize = config.searchPageSize;

  while (pagesScanned < config.maxSearchPages) {
    const response = await immich.searchSmart({
      ...buildSearchFilters(normalizedFilters),
      query: normalizedQuery,
      page,
      size: pageSize,
      type: 'IMAGE',
      visibility: 'timeline',
      withExif: false,
    });
    const { items, nextPage } = parseSmartAlbumSearchPage(response, page, pageSize, {
      label: 'Immich Best of search',
      seenAssetIds: seenPageAssetIds,
    });
    const rawAssets = items.filter(isImageAsset);
    pagesScanned += 1;
    collectBestOfSignalsFor(
      enrichRepo,
      signals,
      rawAssets.map((asset) => asset.id).filter((id) => !seen.has(id)),
    );

    let enrichedOnPage = 0;
    let corroboratedOnPage = 0;
    for (const asset of rawAssets) {
      if (seen.has(asset.id)) {
        continue;
      }
      seen.add(asset.id);
      // Excluded photos can never join the album: skip them before any
      // counting so they neither consume headroom nor vote on page density.
      if (excludedAssetIds.has(asset.id)) {
        droppedExcluded += 1;
        continue;
      }
      if (!signals.enriched.has(asset.id)) {
        notEnriched += 1;
        continue;
      }
      enrichedOnPage += 1;
      if (assetIsCorroborated(asset.id, signals)) {
        corroboratedOnPage += 1;
        if (survivors.size < collectLimit) {
          survivors.set(asset.id, asset);
        }
      } else {
        droppedLowSignal += 1;
      }
    }

    if (nextPage === null) {
      cutoff = 'exhausted';
      break;
    }
    if (survivors.size >= collectLimit) {
      cutoff = 'enough';
      break;
    }

    // A page with no enriched photos says nothing about density either way.
    if (enrichedOnPage > 0) {
      const rate = corroboratedOnPage / enrichedOnPage;
      if (firstPageRate === null) {
        firstPageRate = rate;
      }
      if (rate < Math.max(BEST_OF_MIN_PAGE_RATE, firstPageRate / 2)) {
        lowStreak += 1;
        if (lowStreak >= BEST_OF_LOW_PAGES) {
          cutoff = 'faded';
          break;
        }
      } else {
        lowStreak = 0;
      }
    }

    page = nextPage;
  }

  if (cutoff === 'page-limit' && maxResults !== null) {
    throw new UpstreamPaginationError(
      `Immich Best of search exceeded its ${config.maxSearchPages}-page traversal limit.`,
    );
  }

  // frame/* decisions are only consulted for ranking, so fetch them for the
  // survivors alone.
  signals.frameTags = enrichRepo.loadAssetTagsFor([...survivors.keys()], { prefix: 'frame/' });
  const { ranked, droppedNeverShow } = rankBestOfSurvivors([...survivors.values()], signals);

  return {
    assets: ranked,
    assetIds: ranked.map((asset) => asset.id),
    truncated: cutoff === 'page-limit' || cutoff === 'enough',
    reconciliationComplete: cutoff !== 'page-limit',
    stats: {
      corroborated: ranked.length,
      droppedExcluded,
      droppedLowSignal,
      droppedNeverShow,
      notEnriched,
      pagesScanned,
      cutoff,
      firstPageRate,
    },
  };
}

// Query-level signals are bounded up front (top FTS caption hits); the
// per-candidate signals (ai tags, enrichment, quality) start empty and
// accrue page by page via collectBestOfSignalsFor, so the enrichment-DB
// work tracks the candidate set instead of the whole library. frameTags is
// filled for the survivors alone, just before ranking.
function buildBestOfSignals(enrichRepo, query) {
  return {
    captionHits: new Set(enrichRepo.searchCaptions(query, { limit: 1000 }).map((row) => row.assetId)),
    aiTags: {},
    frameTags: {},
    enriched: new Set(),
    quality: new Map(),
    tokens: tokenizeBestOfQuery(query),
  };
}

function collectBestOfSignalsFor(enrichRepo, signals, assetIds) {
  if (assetIds.length === 0) {
    return;
  }
  Object.assign(signals.aiTags, enrichRepo.loadAssetTagsFor(assetIds, { prefix: 'ai/' }));
  for (const row of enrichRepo.latestSuccessFor(assetIds)) {
    signals.enriched.add(row.asset_id);
    signals.quality.set(row.asset_id, {
      frame: typeof row.frame_score === 'number' ? row.frame_score : null,
      aesthetic: typeof row.aesthetic_score === 'number' ? row.aesthetic_score : null,
    });
  }
}

function assetIsCorroborated(assetId, signals) {
  if (signals.captionHits.has(assetId)) {
    return true;
  }
  const tags = signals.aiTags[assetId];
  if (!Array.isArray(tags)) {
    return false;
  }
  return tags.some((tag) =>
    tag
      .toLowerCase()
      .split(/[/_\-\s]+/)
      .slice(1) // drop the "ai" prefix segment
      .some((word) => signals.tokens.some((token) => bestOfTermsMatch(token, word))),
  );
}

function tokenizeBestOfQuery(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
}

// Loose stem match: singular/plural collapse plus a prefix match for longer
// words ("ski" should not claim "skyline", but "skiing" may claim "ski trip").
function bestOfTermsMatch(token, word) {
  const a = token.endsWith('s') ? token.slice(0, -1) : token;
  const b = word.endsWith('s') ? word.slice(0, -1) : word;
  if (a === b) {
    return true;
  }
  return (a.length >= 5 && b.startsWith(a)) || (b.length >= 5 && a.startsWith(b));
}

// Human decisions outrank model scores: Curate favorites first, then kept
// photos, then undecided; photos a human passed over ("reviewed") sink, and
// never-show is out entirely. Immich search order is the final tie-break so
// equal photos keep their relevance order.
function rankBestOfSurvivors(assets, signals) {
  const scored = [];
  let droppedNeverShow = 0;
  for (const [index, asset] of assets.entries()) {
    const frameTagList = signals.frameTags[asset.id] ?? [];
    if (frameTagList.includes('frame/never-show')) {
      droppedNeverShow += 1;
      continue;
    }
    const humanTier = frameTagList.includes('frame/favorite')
      ? 3
      : frameTagList.includes('frame/eligible')
        ? 2
        : frameTagList.includes('frame/reviewed')
          ? 0
          : 1;
    const scores = signals.quality.get(asset.id) ?? {};
    scored.push({
      asset,
      index,
      humanTier,
      frame: typeof scores.frame === 'number' ? scores.frame : -1,
      aesthetic: typeof scores.aesthetic === 'number' ? scores.aesthetic : -1,
      heart: asset.isFavorite ? 1 : 0,
    });
  }
  scored.sort(
    (a, b) =>
      b.humanTier - a.humanTier ||
      b.frame - a.frame ||
      b.aesthetic - a.aesthetic ||
      b.heart - a.heart ||
      a.index - b.index,
  );
  return { ranked: scored.map((entry) => entry.asset), droppedNeverShow };
}

async function searchExpandedMetadataAssets({ immich, config, filters, maxResults }) {
  const assetMap = new Map();
  const includeAllResults = maxResults === null;
  const resultLimit = includeAllResults ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(Math.round(maxResults), MAX_RESULTS_LIMIT));
  let truncated = false;
  let reconciliationComplete = true;
  const variants = buildPeopleFilterVariants(filters)
    .flatMap((variant) => buildCityFilterVariants(variant))
    .flatMap((variant) => buildCountryFilterVariants(variant));

  for (const variant of variants) {
    if (assetMap.size >= resultLimit) {
      break;
    }

    const result = await searchTagModeAssets({
      immich,
      config,
      filters: variant,
      maxResults: includeAllResults ? null : resultLimit - assetMap.size,
      allowPartialTraversal: includeAllResults,
    });
    truncated = truncated || result.truncated;
    reconciliationComplete = reconciliationComplete && result.reconciliationComplete;

    for (const asset of result.assets) {
      if (assetMap.size < resultLimit) {
        assetMap.set(asset.id, asset);
      }
    }
  }

  return toSearchResult(assetMap, truncated, reconciliationComplete);
}

async function searchTagModeAssets({ immich, config, filters, maxResults, allowPartialTraversal = maxResults === null }) {
  if (filters.tagIds.length <= 1) {
    return searchPagedAssets({
      immich,
      config,
      query: '',
      filters,
      maxResults,
      allowPartialTraversal,
    });
  }

  if (filters.tagMatchMode === 'any') {
    return searchAnyTagAssets({ immich, config, filters, maxResults, allowPartialTraversal });
  }

  return searchAllTagAssets({ immich, config, filters, maxResults, allowPartialTraversal });
}

async function searchAnyTagAssets({ immich, config, filters, maxResults, allowPartialTraversal }) {
  const assetMap = new Map();
  const includeAllResults = maxResults === null;
  const resultLimit = includeAllResults ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(Math.round(maxResults), MAX_RESULTS_LIMIT));
  let truncated = false;
  let reconciliationComplete = true;

  for (const tagId of filters.tagIds) {
    if (assetMap.size >= resultLimit) {
      break;
    }

    const result = await searchPagedAssets({
      immich,
      config,
      query: '',
      filters: withSingleTag(filters, tagId),
      maxResults: includeAllResults ? null : resultLimit - assetMap.size,
      allowPartialTraversal,
    });
    truncated = truncated || result.truncated;
    reconciliationComplete = reconciliationComplete && result.reconciliationComplete;

    for (const asset of result.assets) {
      if (assetMap.size < resultLimit) {
        assetMap.set(asset.id, asset);
      }
    }
  }

  return toSearchResult(assetMap, truncated, reconciliationComplete);
}

async function searchAllTagAssets({ immich, config, filters, maxResults, allowPartialTraversal }) {
  let truncated = false;
  let reconciliationComplete = true;
  const [firstTagId, ...remainingTagIds] = filters.tagIds;
  const firstResult = await searchPagedAssets({
    immich,
    config,
    query: '',
    filters: withSingleTag(filters, firstTagId),
    maxResults: null,
    allowPartialTraversal,
  });
  truncated = truncated || firstResult.truncated;
  reconciliationComplete = reconciliationComplete && firstResult.reconciliationComplete;
  const assetMap = new Map(firstResult.assets.map((asset) => [asset.id, asset]));

  for (const tagId of remainingTagIds) {
    const result = await searchPagedAssets({
      immich,
      config,
      query: '',
      filters: withSingleTag(filters, tagId),
      maxResults: null,
      allowPartialTraversal,
    });
    truncated = truncated || result.truncated;
    reconciliationComplete = reconciliationComplete && result.reconciliationComplete;
    const matchingIds = new Set(result.assetIds);

    for (const assetId of assetMap.keys()) {
      if (!matchingIds.has(assetId)) {
        assetMap.delete(assetId);
      }
    }
  }

  return limitSearchResult(assetMap, maxResults, truncated, reconciliationComplete);
}

async function searchPagedAssets({
  immich,
  config,
  query = '',
  filters = {},
  maxResults = DEFAULT_MAX_RESULTS,
  allowPartialTraversal = maxResults === null,
}) {
  const assetMap = new Map();
  const includeAllResults = maxResults === null;
  const resultLimit = includeAllResults ? Number.POSITIVE_INFINITY : Math.max(1, Math.min(Math.round(maxResults), MAX_RESULTS_LIMIT));
  let page = 1;
  const normalizedQuery = String(query || '').trim();
  const normalizedFilters = normalizeFilters(filters);
  const searchMethod = normalizedQuery ? 'searchSmart' : 'searchMetadata';
  const shouldFilterPeopleOnly = !normalizedQuery && normalizedFilters.peopleOnly;
  const seenPageAssetIds = new Set();
  // Immich page numbers are relative to the requested size, so the size must stay
  // constant across pages of one search or later requests re-read earlier windows.
  const pageSize = shouldFilterPeopleOnly || includeAllResults
    ? config.searchPageSize
    : Math.max(1, Math.min(config.searchPageSize, resultLimit));

  for (let pagesFetched = 0; pagesFetched < config.maxSearchPages && assetMap.size < resultLimit; pagesFetched += 1) {
    const response = await immich[searchMethod]({
      ...buildSearchFilters(normalizedFilters),
      ...(normalizedQuery ? { query: normalizedQuery } : { order: 'desc' }),
      page,
      size: pageSize,
      type: 'IMAGE',
      visibility: 'timeline',
      withExif: false,
      ...(shouldFilterPeopleOnly ? { withPeople: true } : {}),
    });
    const { items, nextPage } = parseSmartAlbumSearchPage(response, page, pageSize, {
      label: `Immich ${normalizedQuery ? 'smart' : 'metadata'} search`,
      requirePeople: shouldFilterPeopleOnly,
      seenAssetIds: seenPageAssetIds,
    });
    const rawAssets = items.filter(isImageAsset);
    const assets = rawAssets.filter((asset) => assetMatchesPeopleOnly(asset, normalizedFilters));

    for (const asset of assets) {
      if (assetMap.size < resultLimit) {
        assetMap.set(asset.id, asset);
      }
    }

    if (nextPage === null) {
      return toSearchResult(assetMap, false);
    }

    page = nextPage;
  }

  if (assetMap.size >= resultLimit) {
    return toSearchResult(assetMap, true);
  }
  if (allowPartialTraversal) {
    return toSearchResult(assetMap, true, false);
  }
  throw new UpstreamPaginationError(
    `Immich ${normalizedQuery ? 'smart' : 'metadata'} search exceeded its ${config.maxSearchPages}-page traversal limit.`,
  );
}

async function searchAlbumAssetIds({ immich, config, albumId }) {
  const assetIds = new Set();
  const seenPageAssetIds = new Set();
  let page = 1;

  for (let pagesFetched = 0; pagesFetched < config.maxSearchPages; pagesFetched += 1) {
    const response = await immich.searchMetadata({
      albumIds: [albumId],
      order: 'desc',
      page,
      size: config.searchPageSize,
      type: 'IMAGE',
      withExif: false,
    });
    const { items, nextPage } = parseSmartAlbumSearchPage(response, page, config.searchPageSize, {
      label: 'Immich Smart Album membership search',
      seenAssetIds: seenPageAssetIds,
    });
    const assets = items.filter(isImageAsset);

    for (const asset of assets) {
      assetIds.add(asset.id);
    }

    if (nextPage === null) {
      return assetIds;
    }

    page = nextPage;
  }

  throw new UpstreamPaginationError(
    `Immich Smart Album membership search exceeded its ${config.maxSearchPages}-page traversal limit.`,
  );
}

// Deliberately no visibility filter here: blanket-excluded assets should be
// found and excluded/removed regardless of archive/hidden status.
async function searchExcludedAssetIds({ immich, config, filters }) {
  const { tagIds, unresolvedValues } = await resolveExclusionTagIds(immich, filters);
  const warnings = unresolvedValues.map(
    (value) => `Blanket exclusion tag not found in Immich, so it is not excluding anything: ${value}`,
  );

  if (tagIds.length === 0) {
    return { assetIds: new Set(), warnings };
  }

  const assetIds = new Set();

  for (const tagId of tagIds) {
    let page = 1;
    const seenPageAssetIds = new Set();

    for (let pagesFetched = 0; pagesFetched < config.maxSearchPages; pagesFetched += 1) {
      const response = await immich.searchMetadata({
        tagIds: [tagId],
        order: 'desc',
        page,
        size: config.searchPageSize,
        type: 'IMAGE',
        withExif: false,
      });
      const { items, nextPage } = parseSmartAlbumSearchPage(response, page, config.searchPageSize, {
        label: 'Immich blanket-exclusion search',
        seenAssetIds: seenPageAssetIds,
      });
      const assets = items.filter(isImageAsset);

      for (const asset of assets) {
        assetIds.add(asset.id);
      }

      if (nextPage === null) {
        break;
      }

      page = nextPage;

      if (pagesFetched === config.maxSearchPages - 1) {
        throw new UpstreamPaginationError(
          `Immich blanket-exclusion search exceeded its ${config.maxSearchPages}-page traversal limit.`,
        );
      }
    }
  }

  return { assetIds, warnings };
}

async function resolveExclusionTagIds(immich, filters) {
  if (filters.excludeTagsConfigured && filters.excludeTagIds.length === 0 && filters.excludeTagValues.length === 0) {
    return { tagIds: [], unresolvedValues: [] };
  }

  const ids = new Set(filters.excludeTagsConfigured ? filters.excludeTagIds : []);
  const values = filters.excludeTagsConfigured ? filters.excludeTagValues : [NEVER_SHOW_TAG_VALUE];
  const unresolvedValues = [];

  if (values.length > 0 && typeof immich.listTags === 'function') {
    const tags = await immich.listTags({ strict: true });
    if (!Array.isArray(tags) || tags.some((tag) => (
      !tag
      || typeof tag !== 'object'
      || Array.isArray(tag)
      || typeof tag.id !== 'string'
      || !tag.id.trim()
      || ![tag.value, tag.name].some((candidate) => typeof candidate === 'string' && candidate.trim())
    ))) {
      throw new UpstreamPaginationError('Immich tag listing returned an invalid tag entry.');
    }
    for (const value of values) {
      const tag = Array.isArray(tags)
        ? tags.find((candidate) => tagMatchesValue(candidate, value))
        : null;
      if (tag?.id) {
        ids.add(tag.id);
      } else {
        unresolvedValues.push(value);
      }
    }
  }

  return { tagIds: [...ids], unresolvedValues };
}

export function normalizeFilters(filters, { enforceLimits = true } = {}) {
  if (enforceLimits) {
    validateFilterInput(filters);
  }
  const peopleMatchMode = filters?.peopleMatchMode === 'any' ? 'any' : 'all';
  const tagMatchMode = filters?.tagMatchMode === 'any' ? 'any' : 'all';
  const people = Array.isArray(filters?.people)
    ? filters.people
        .map((person) => ({
          id: String(person?.id || '').trim(),
          name: String(person?.name || '').trim(),
        }))
        .filter((person) => person.id)
    : [];
  const personIds = dedupe([
    ...people.map((person) => person.id),
    ...(Array.isArray(filters?.personIds) ? filters.personIds.map((id) => String(id || '').trim()) : []),
  ].filter(Boolean));
  const peopleById = new Map();
  for (const person of people) {
    if (!peopleById.has(person.id)) peopleById.set(person.id, person);
  }
  const tags = Array.isArray(filters?.tags)
    ? filters.tags
        .map((tag) => ({
          id: String(tag?.id || '').trim(),
          name: String(tag?.name || '').trim(),
          value: String(tag?.value || tag?.name || '').trim(),
        }))
        .filter((tag) => tag.id)
    : [];
  const tagIds = dedupe([
    ...tags.map((tag) => tag.id),
    ...(Array.isArray(filters?.tagIds) ? filters.tagIds.map((id) => String(id || '').trim()) : []),
  ].filter(Boolean));
  const tagsById = new Map();
  for (const tag of tags) {
    if (!tagsById.has(tag.id)) tagsById.set(tag.id, tag);
  }
  // Trust an explicit flag first: normalized output always contains the exclude
  // keys, so re-normalizing (store load, job runs) must not mistake an untouched
  // default for "explicitly configured: none" — that would silently drop the
  // frame/never-show safety net for pre-v2 jobs.
  const excludeTagsConfigured = typeof filters?.excludeTagsConfigured === 'boolean'
    ? filters.excludeTagsConfigured
    : Object.hasOwn(filters || {}, 'excludeTags')
      || Object.hasOwn(filters || {}, 'excludeTagIds')
      || Object.hasOwn(filters || {}, 'excludeTagValues');
  const excludeTags = Array.isArray(filters?.excludeTags)
    ? filters.excludeTags
        .map((tag) => ({
          id: String(tag?.id || '').trim(),
          name: String(tag?.name || '').trim(),
          value: String(tag?.value || tag?.name || '').trim(),
        }))
        .filter((tag) => tag.id || tag.value)
    : [];
  const excludeTagIds = dedupe([
    ...excludeTags.map((tag) => tag.id),
    ...(Array.isArray(filters?.excludeTagIds) ? filters.excludeTagIds.map((id) => String(id || '').trim()) : []),
  ].filter(Boolean));
  const excludeTagValues = dedupe([
    ...excludeTags.map((tag) => tag.value || tag.name),
    ...(Array.isArray(filters?.excludeTagValues) ? filters.excludeTagValues.map((value) => String(value || '').trim()) : []),
  ].filter(Boolean));

  // Cities OR: `cities` (multi) folds together with the legacy single `city`.
  // A single entry stays on `city` so existing jobs round-trip unchanged.
  const cities = dedupe([
    cleanOptionalString(filters?.city),
    ...(Array.isArray(filters?.cities) ? filters.cities.map((value) => cleanOptionalString(value)) : []),
  ].filter(Boolean));

  // Countries OR mirrors cities: `countries` (multi) folds together with the
  // legacy single `country`; a single entry stays on `country`.
  const countries = dedupe([
    cleanOptionalString(filters?.country),
    ...(Array.isArray(filters?.countries) ? filters.countries.map((value) => cleanOptionalString(value)) : []),
  ].filter(Boolean));

  if (enforceLimits) {
    for (const [label, values] of [
      ['people', personIds],
      ['tags', tagIds],
      ['excluded tag ids', excludeTagIds],
      ['excluded tag values', excludeTagValues],
      ['cities', cities],
      ['countries', countries],
    ]) {
      assertBoundedCollection(values, label);
    }
  }

  return {
    people: personIds.map((id) => peopleById.get(id) || { id, name: '' }),
    personIds,
    peopleMatchMode,
    peopleOnly: Boolean(filters?.peopleOnly),
    tags: tagIds.map((id) => tagsById.get(id) || { id, name: '', value: '' }),
    tagIds,
    tagMatchMode,
    excludeTags: normalizeExcludeTags(excludeTags, excludeTagIds, excludeTagValues),
    excludeTagIds,
    excludeTagValues,
    excludeTagsConfigured,
    city: cities.length === 1 ? cities[0] : null,
    cities,
    state: cleanOptionalString(filters?.state),
    country: countries.length === 1 ? countries[0] : null,
    countries,
    make: cleanOptionalString(filters?.make),
    model: cleanOptionalString(filters?.model),
    takenAfter: normalizeDateFilter(filters?.takenAfter, 'start'),
    takenBefore: normalizeDateFilter(filters?.takenBefore, 'end'),
  };
}

function validateSearchOptions({ query, filters }) {
  const validationError = getSearchValidationError({ query, filters });
  if (validationError) {
    throw new Error(validationError);
  }
}

export function getSearchValidationError({ query, filters }) {
  const normalizedQuery = String(query || '').trim();

  if (normalizedQuery && filters.peopleMatchMode === 'any' && filters.personIds.length > 1) {
    return 'People OR is only supported for filter-only albums.';
  }

  if (normalizedQuery && filters.tagMatchMode === 'any' && filters.tagIds.length > 1) {
    return 'Tag OR is only supported for filter-only albums.';
  }

  if (normalizedQuery && filters.cities?.length > 1) {
    return 'Multiple cities are only supported for filter-only albums.';
  }

  if (normalizedQuery && filters.countries?.length > 1) {
    return 'Multiple countries are only supported for filter-only albums.';
  }

  // A city or state alongside several countries is ambiguous — which
  // country would the city belong to? — so the combination is rejected.
  if (filters.countries?.length > 1 && (filters.city || filters.cities?.length || filters.state)) {
    return 'Multiple countries cannot be combined with a city or state.';
  }

  if (filters.peopleOnly) {
    if (normalizedQuery) {
      return 'Only this person is only supported for filter-only albums.';
    }

    if (filters.peopleMatchMode === 'any') {
      return 'Only this person cannot be combined with people OR.';
    }

    if (filters.personIds.length !== 1) {
      return 'Only this person requires exactly one selected person.';
    }
  }

  return null;
}

export function hasFilters(filters) {
  return Boolean(
    filters.personIds?.length ||
    filters.tagIds?.length ||
    filters.city ||
    filters.cities?.length ||
    filters.state ||
    filters.country ||
    filters.countries?.length ||
    filters.make ||
    filters.model ||
    filters.takenAfter ||
    filters.takenBefore,
  );
}

export function computeNextRunAt(fromDate, intervalDays) {
  return new Date(fromDate.getTime() + intervalDays * DAY_MS);
}

export function jobIsDue(job, now = new Date()) {
  return Boolean(
    job.smart &&
    job.enabled &&
    !job.scheduleQuarantined &&
    job.nextRunAt &&
    new Date(job.nextRunAt).getTime() <= now.getTime(),
  );
}

function toSearchResult(assetMap, truncated, reconciliationComplete = true) {
  const assets = [...assetMap.values()];

  return {
    assets,
    assetIds: assets.map((asset) => asset.id),
    truncated,
    reconciliationComplete,
  };
}

function limitSearchResult(assetMap, maxResults, truncated, reconciliationComplete = true) {
  if (maxResults === null) {
    return toSearchResult(assetMap, truncated, reconciliationComplete);
  }

  const resultLimit = Math.max(1, Math.min(Math.round(maxResults), MAX_RESULTS_LIMIT));
  return toSearchResult(
    new Map([...assetMap.entries()].slice(0, resultLimit)),
    truncated || assetMap.size > resultLimit,
    reconciliationComplete,
  );
}

function shouldExpandMetadataSearch(filters) {
  return Boolean(
    filters.peopleMatchMode === 'any' && filters.personIds.length > 1 ||
    filters.tagIds.length > 1 ||
    filters.cities.length > 1 ||
    filters.countries.length > 1
  );
}

// Cities are always OR: one single-city search per member, results unioned
// (an asset has one city, so no dedup pressure).
function buildCityFilterVariants(filters) {
  if (!Array.isArray(filters.cities) || filters.cities.length <= 1) {
    return [filters];
  }
  return filters.cities.map((city) => ({ ...filters, city, cities: [city] }));
}

// Countries are always OR, mirroring cities: one single-country search per
// member, results unioned (an asset has one country).
function buildCountryFilterVariants(filters) {
  if (!Array.isArray(filters.countries) || filters.countries.length <= 1) {
    return [filters];
  }
  return filters.countries.map((country) => ({ ...filters, country, countries: [country] }));
}

function buildPeopleFilterVariants(filters) {
  if (filters.peopleMatchMode !== 'any' || filters.personIds.length <= 1) {
    return [filters];
  }

  return filters.personIds.map((personId) => {
    const person = filters.people.find((candidate) => candidate.id === personId) || { id: personId, name: '' };
    return {
      ...filters,
      people: [person],
      personIds: [personId],
      peopleMatchMode: 'all',
    };
  });
}

function withSingleTag(filters, tagId) {
  const tag = filters.tags.find((candidate) => candidate.id === tagId) || { id: tagId, name: '', value: '' };
  return {
    ...filters,
    tags: [tag],
    tagIds: [tagId],
    tagMatchMode: 'all',
  };
}

function normalizeExcludeTags(excludeTags, excludeTagIds, excludeTagValues) {
  const tagsByKey = new Map();
  const knownValues = new Set();

  for (const tag of excludeTags) {
    const key = tag.id || tag.value;
    if (!tagsByKey.has(key)) tagsByKey.set(key, tag);
    if (tag.value) knownValues.add(tag.value);
    if (tag.name) knownValues.add(tag.name);
  }

  for (const id of excludeTagIds) {
    if (!tagsByKey.has(id)) {
      tagsByKey.set(id, { id, name: '', value: '' });
    }
  }

  for (const value of excludeTagValues) {
    if (!knownValues.has(value)) {
      tagsByKey.set(value, { id: '', name: value, value });
      knownValues.add(value);
    }
  }

  return [...tagsByKey.values()];
}

export function assertSmartAlbumWorkBudget({ config, query = '', filters, includeAlbumRead = false }) {
  const pages = Number(config?.maxSearchPages);
  if (!Number.isSafeInteger(pages) || pages < 1) {
    throw new SmartAlbumValidationError('Smart Album search page configuration is invalid.');
  }

  const peopleVariants = filters.peopleMatchMode === 'any' && filters.personIds.length > 1
    ? filters.personIds.length
    : 1;
  const cityVariants = filters.cities.length > 1 ? filters.cities.length : 1;
  const countryVariants = filters.countries.length > 1 ? filters.countries.length : 1;
  const tagVariants = filters.tagIds.length > 1 ? filters.tagIds.length : 1;
  const searchVariants = String(query || '').trim()
    ? 1
    : peopleVariants * cityVariants * countryVariants * tagVariants;

  const exclusionValues = filters.excludeTagsConfigured ? filters.excludeTagValues.length : 1;
  const exclusionTags = filters.excludeTagsConfigured
    ? filters.excludeTagIds.length + filters.excludeTagValues.length
    : 1;
  const plannedRequests = searchVariants * pages
    + exclusionTags * pages
    + (exclusionValues > 0 ? 1 : 0)
    + (includeAlbumRead ? pages : 0);

  if (!Number.isSafeInteger(plannedRequests) || plannedRequests > MAX_SMART_ALBUM_UPSTREAM_REQUESTS) {
    throw new SmartAlbumValidationError(
      `Smart Album filters could require ${plannedRequests} upstream requests; the limit is ${MAX_SMART_ALBUM_UPSTREAM_REQUESTS}. Reduce people, tags, cities, or countries.`,
    );
  }
  return { plannedRequests, searchVariants };
}

function validateFilterInput(filters) {
  const source = filters && typeof filters === 'object' ? filters : {};
  for (const key of ['people', 'personIds', 'tags', 'tagIds', 'excludeTags', 'excludeTagIds', 'excludeTagValues', 'cities', 'countries']) {
    if (source[key] !== undefined && !Array.isArray(source[key])) {
      throw new SmartAlbumValidationError(`${key} must be an array.`);
    }
    if (Array.isArray(source[key])) {
      assertBoundedCollection(source[key], key);
    }
  }

  for (const person of source.people ?? []) {
    assertBoundedString(String(person?.id || '').trim(), 'Person id', MAX_SMART_ALBUM_ID_LENGTH);
    assertBoundedString(String(person?.name || '').trim(), 'Person name', MAX_SMART_ALBUM_VALUE_LENGTH);
  }
  for (const tag of [...(source.tags ?? []), ...(source.excludeTags ?? [])]) {
    assertBoundedString(String(tag?.id || '').trim(), 'Tag id', MAX_SMART_ALBUM_ID_LENGTH);
    assertBoundedString(String(tag?.name || '').trim(), 'Tag name', MAX_SMART_ALBUM_VALUE_LENGTH);
    assertBoundedString(String(tag?.value || '').trim(), 'Tag value', MAX_SMART_ALBUM_VALUE_LENGTH);
  }
  for (const key of ['personIds', 'tagIds', 'excludeTagIds']) {
    for (const value of source[key] ?? []) {
      assertBoundedString(String(value || '').trim(), `${key} entry`, MAX_SMART_ALBUM_ID_LENGTH);
    }
  }
  for (const key of ['excludeTagValues', 'cities', 'countries']) {
    for (const value of source[key] ?? []) {
      assertBoundedString(String(value || '').trim(), `${key} entry`, MAX_SMART_ALBUM_VALUE_LENGTH);
    }
  }
  for (const key of ['city', 'state', 'country', 'make', 'model', 'takenAfter', 'takenBefore']) {
    assertBoundedString(String(source[key] || '').trim(), key, MAX_SMART_ALBUM_VALUE_LENGTH);
  }
}

function assertBoundedCollection(values, label) {
  if (values.length > MAX_SMART_ALBUM_FILTER_ITEMS) {
    throw new SmartAlbumValidationError(`${label} is limited to ${MAX_SMART_ALBUM_FILTER_ITEMS} entries.`);
  }
}

function assertBoundedString(value, label, maxLength) {
  if (value.length > maxLength) {
    throw new SmartAlbumValidationError(`${label} is limited to ${maxLength} characters.`);
  }
}

function buildSearchFilters(filters) {
  return {
    ...(filters.personIds.length > 0 ? { personIds: filters.personIds } : {}),
    ...(filters.tagIds.length > 0 ? { tagIds: filters.tagIds } : {}),
    ...(filters.city ? { city: filters.city } : {}),
    ...(filters.state ? { state: filters.state } : {}),
    ...(filters.country ? { country: filters.country } : {}),
    ...(filters.make ? { make: filters.make } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.takenAfter ? { takenAfter: filters.takenAfter } : {}),
    ...(filters.takenBefore ? { takenBefore: filters.takenBefore } : {}),
  };
}

function assetMatchesPeopleOnly(asset, filters) {
  if (!filters.peopleOnly) {
    return true;
  }

  const selectedPersonId = filters.personIds[0];
  const assetPersonIds = dedupe((Array.isArray(asset.people) ? asset.people : [])
    .map((person) => person?.id || person?.personId || person?.person?.id || '')
    .filter(Boolean));

  return assetPersonIds.length === 1 && assetPersonIds[0] === selectedPersonId;
}

function describeManagedAlbum(input) {
  const parts = ['Managed by Pictaria Smart Albums.'];

  if (input.query) {
    parts.push(`Query: ${input.query}.`);
  }

  if (input.bestOf) {
    parts.push('Best of: corroborated against enrichment data and ranked by library signals.');
  }

  const filters = describeFilters(input.filters);
  if (filters) {
    parts.push(`Filters: ${filters}.`);
  }

  parts.push(input.includeAllResults ? 'All results.' : `Max photos: ${input.maxResults}.`);
  return parts.join(' ');
}

function describeFilters(filters) {
  const parts = [];

  if (filters.people?.length) {
    if (filters.peopleOnly && filters.people.length === 1) {
      parts.push(`people=${filters.people[0].name || filters.people[0].id} only`);
    } else {
      const joiner = filters.peopleMatchMode === 'any' ? ' OR ' : ' AND ';
      parts.push(`people=${filters.people.map((person) => person.name || person.id).join(joiner)}`);
    }
  }

  if (filters.tags?.length) {
    const joiner = filters.tagMatchMode === 'any' ? ' OR ' : ' AND ';
    parts.push(`tags=${filters.tags.map((tag) => tag.value || tag.name || tag.id).join(joiner)}`);
  }

  if (filters.cities?.length > 1) {
    parts.push(`city=${filters.cities.join(' OR ')}`);
  }

  if (filters.countries?.length > 1) {
    parts.push(`country=${filters.countries.join(' OR ')}`);
  }

  for (const key of ['city', 'state', 'country', 'make', 'model', 'takenAfter', 'takenBefore']) {
    if (filters[key]) {
      parts.push(`${key}=${filters[key]}`);
    }
  }

  return parts.join('; ');
}

function parseSmartAlbumSearchPage(response, currentPage, pageSize, {
  label,
  requirePeople = false,
  seenAssetIds = new Set(),
} = {}) {
  const responseObject = response && typeof response === 'object' && !Array.isArray(response)
    ? response
    : null;
  const assetsObject = responseObject?.assets
    && typeof responseObject.assets === 'object'
    && !Array.isArray(responseObject.assets)
    ? responseObject.assets
    : null;
  const representations = [
    ...(Array.isArray(response) ? [{ kind: 'array', items: response }] : []),
    ...(Array.isArray(responseObject?.assets) ? [{ kind: 'assets', items: responseObject.assets }] : []),
    ...(Array.isArray(assetsObject?.items) ? [{ kind: 'assets.items', items: assetsObject.items }] : []),
    ...(Array.isArray(responseObject?.items) ? [{ kind: 'items', items: responseObject.items }] : []),
    ...(Array.isArray(responseObject?.data) ? [{ kind: 'data', items: responseObject.data }] : []),
  ];
  if (representations.length !== 1 || representations[0].items.length > pageSize) {
    throw new UpstreamPaginationError(`${label} returned an invalid or oversized item page.`);
  }
  const [{ kind, items }] = representations;
  if (items.some((asset) => (
    !asset
    || typeof asset !== 'object'
    || Array.isArray(asset)
    || typeof asset.id !== 'string'
    || !asset.id.trim()
    || (Object.hasOwn(asset, 'type') && (
      typeof asset.type !== 'string'
      || asset.type.trim().toUpperCase() !== 'IMAGE'
    ))
    || (requirePeople && (
      !Array.isArray(asset.people)
      || asset.people.some((person) => !validAssetPerson(person))
    ))
  ))) {
    throw new UpstreamPaginationError(`${label} returned an invalid asset entry.`);
  }

  const pageIds = items.map((asset) => asset.id);
  const uniquePageIds = new Set(pageIds);
  if (uniquePageIds.size !== pageIds.length || pageIds.some((assetId) => seenAssetIds.has(assetId))) {
    throw new UpstreamPaginationError(`${label} returned repeated asset entries.`);
  }

  const hasNestedCursor = Boolean(assetsObject && Object.hasOwn(assetsObject, 'nextPage'));
  const hasTopLevelCursor = Boolean(responseObject && Object.hasOwn(responseObject, 'nextPage'));
  if (hasNestedCursor && hasTopLevelCursor) {
    throw new UpstreamPaginationError(`${label} returned conflicting next-page fields.`);
  }
  if (kind === 'assets.items' && !hasNestedCursor && !hasTopLevelCursor) {
    throw new UpstreamPaginationError(`${label} omitted its next-page field.`);
  }
  if (kind !== 'assets.items' && hasNestedCursor) {
    throw new UpstreamPaginationError(`${label} returned pagination for a different item container.`);
  }
  const nextPage = parseProgressingPage(
    hasNestedCursor ? assetsObject.nextPage : hasTopLevelCursor ? responseObject.nextPage : null,
    currentPage,
    { label },
  );
  if (nextPage !== null && nextPage !== currentPage + 1) {
    throw new UpstreamPaginationError(`${label} returned a non-sequential next page.`);
  }
  if (items.length === 0 && nextPage !== null) {
    throw new UpstreamPaginationError(`${label} returned an empty page with a continuation.`);
  }
  for (const assetId of pageIds) {
    seenAssetIds.add(assetId);
  }
  return { items, nextPage };
}

function validAssetPerson(person) {
  if (!person || typeof person !== 'object' || Array.isArray(person)) {
    return false;
  }
  const id = person.id ?? person.personId ?? person.person?.id;
  return typeof id === 'string' && Boolean(id.trim());
}

function cleanOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function normalizeDateFilter(value, boundary) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return boundary === 'end'
      ? `${normalized}T23:59:59.999Z`
      : `${normalized}T00:00:00.000Z`;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function tagMatchesValue(tag, value) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  const candidates = [
    tag?.value,
    tag?.name,
  ];

  return candidates.some((candidate) => String(candidate || '').trim().toLowerCase() === normalizedValue);
}

async function addAssetsInBatches(immich, albumId, assetIds) {
  let addedCount = 0;

  for (let index = 0; index < assetIds.length; index += ADD_BATCH_SIZE) {
    const batch = assetIds.slice(index, index + ADD_BATCH_SIZE);
    const result = await immich.addAssetsToAlbum(albumId, batch);
    addedCount += countBulkSuccesses(result, batch.length);
  }

  return addedCount;
}

async function removeAssetsInBatches(immich, albumId, assetIds) {
  if (typeof immich.removeAssetsFromAlbum !== 'function') {
    return 0;
  }

  let removedCount = 0;

  for (let index = 0; index < assetIds.length; index += REMOVE_BATCH_SIZE) {
    const batch = assetIds.slice(index, index + REMOVE_BATCH_SIZE);
    const result = await immich.removeAssetsFromAlbum(albumId, batch);
    removedCount += countBulkSuccesses(result, batch.length);
  }

  return removedCount;
}

// Immich bulk asset endpoints return per-asset results; count real successes so
// job stats stay honest, falling back to the batch size for older responses.
function countBulkSuccesses(result, fallbackCount) {
  return Array.isArray(result) ? result.filter((entry) => entry?.success).length : fallbackCount;
}

function isImageAsset(asset) {
  return !asset.type || String(asset.type).toUpperCase() === 'IMAGE';
}

function summarizeAsset(asset) {
  return {
    id: asset.id,
    originalFileName: asset.originalFileName || asset.originalPath?.split('/').pop() || asset.id,
    localDateTime: asset.localDateTime || asset.fileCreatedAt || asset.createdAt || null,
    type: asset.type || 'IMAGE',
  };
}
