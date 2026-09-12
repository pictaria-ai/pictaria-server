import { UpstreamPaginationError } from '../pagination.mjs';
import { parseImmichVersion } from '../immichCompatibility.mjs';
import { parseSmartAlbumSearchPage } from './searchPage.mjs';
import { legacyMetadataWindows, legacyVisibilityFilters, needsLegacyMetadataTraversal } from './legacyMetadataTraversal.mjs';

const CONTEXT = Symbol('smartAlbumReadContext');
export const MAX_ALBUM_READ_REQUESTS = 500;
const MAX_REQUESTS = MAX_ALBUM_READ_REQUESTS;
const MAX_ITEMS = 500_000;
const DEADLINE_MS = 5 * 60_000;

class ReadLimitError extends UpstreamPaginationError {}

export function albumReadConfig(config) {
  if (config[CONTEXT]) return config;
  return { ...config, [CONTEXT]: { requests: 0, items: 0, started: performance.now(), versions: new WeakMap() } };
}

function context(config) {
  if (!config[CONTEXT]) throw new Error('Smart Album read context is missing.');
  return config[CONTEXT];
}

export async function albumRead(config, read) {
  const state = context(config);
  if (state.requests >= MAX_REQUESTS || performance.now() - state.started >= DEADLINE_MS) {
    throw new ReadLimitError('Smart Album reading reached its request or time limit.');
  }
  state.requests++;
  const response = await read();
  if (performance.now() - state.started >= DEADLINE_MS) throw new ReadLimitError('Smart Album reading reached its time limit.');
  return response;
}

function recordItems(config, count) {
  const state = context(config);
  state.items += count;
  if (state.items > MAX_ITEMS) throw new ReadLimitError('Smart Album reading reached its response-item limit.');
}

async function serverVersion(immich, config) {
  const versions = context(config).versions;
  if (!versions.has(immich)) versions.set(immich, (async () => {
    try {
      const raw = await albumRead(config, () => typeof immich.getServerVersion === 'function'
        ? immich.getServerVersion() : immich.requestJson('/server/version'));
      return parseImmichVersion(raw);
    } catch (error) {
      // An absent endpoint or unparseable payload is genuinely unknown.
      // Network/auth failures remain errors, not compatibility detection.
      if (error instanceof SyntaxError || error?.status === 404 || error?.status === 405) return null;
      throw error;
    }
  })());
  return versions.get(immich);
}

async function metadataPage({ immich, config, body, requirePeople, seenAssetIds, label }) {
  const response = await albumRead(config, () => immich.searchMetadata(body));
  const result = parseSmartAlbumSearchPage(response, body.page, body.size, { requirePeople, seenAssetIds, label });
  recordItems(config, result.items.length);
  return result;
}

// Smart Album callers know filters, selection, and completeness. Only this
// dispatch knows a legacy traversal exists. Removing pre-3.1 support means
// deleting the legacy import/branch and its implementation, not touching jobs.
export async function readMetadataAssets({ immich, config, filters, limit = Infinity,
  accept = () => true, requirePeople = false, allowPartial = false, label = 'Immich metadata search' }) {
  config = albumReadConfig(config);
  const body = { ...filters, type: 'IMAGE', withExif: false };
  const version = await serverVersion(immich, config);
  if (needsLegacyMetadataTraversal(version)) {
    const assets = [], seen = new Set();
    let truncated = false, complete = true;
    for (const variant of legacyVisibilityFilters(body)) {
      const result = await readLegacy({ immich, config, filters: variant, limit: limit - assets.length,
        accept, requirePeople, allowPartial, label });
      for (const asset of result.assets) {
        if (seen.has(asset.id)) throw new UpstreamPaginationError('Immich photo visibility changed while reading this album. Album membership was left unchanged.');
        seen.add(asset.id);
        assets.push(asset);
      }
      truncated ||= result.truncated;
      complete &&= result.complete;
      if (assets.length >= limit) break;
    }
    return { assets, truncated, complete };
  }
  return readOffset({ immich, config, filters: body, limit, accept, requirePeople, allowPartial, label });
}

async function readOffset({ immich, config, filters, limit, accept, requirePeople, allowPartial, label }) {
  const assets = [], seen = new Set();
  const size = requirePeople || !Number.isFinite(limit) ? config.searchPageSize : Math.min(config.searchPageSize, limit);
  let page = 1;
  for (let n = 0; n < config.maxSearchPages; n++) {
    const result = await metadataPage({ immich, config, body: { ...filters, order: 'desc', page, size },
      requirePeople, seenAssetIds: seen, label });
    for (const asset of result.items) if (accept(asset) && assets.length < limit) assets.push(asset);
    if (result.nextPage === null) return { assets, truncated: false, complete: true };
    if (assets.length >= limit) return { assets, truncated: true, complete: true };
    page = result.nextPage;
  }
  if (allowPartial) return { assets, truncated: true, complete: false };
  throw new UpstreamPaginationError(`${label} exceeded its ${config.maxSearchPages}-page traversal limit.`);
}

function statisticFilters(filters) {
  // These fields only affect projection/paging, not which photos match.
  const { withExif, withPeople, page, size, order, ...selection } = filters;
  return selection;
}

async function readLegacy({ immich, config, filters, limit, accept, requirePeople, allowPartial, label }) {
  // Legacy windows cost more than offset pages. Keep their accounting local;
  // all partitions, retries and queries also share the hard 500-request cap.
  const maxRequests = Math.min(MAX_REQUESTS, config.maxSearchPages * 4 + 4);
  let requests = 0;
  async function localRead(fn) {
    if (requests >= maxRequests) throw new ReadLimitError(`${label} reached its ${maxRequests}-request legacy traversal limit.`);
    requests++;
    return fn();
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const assets = [];
    let rawCount = 0, matchedCount = 0, last = null;
    try {
      const windows = legacyMetadataWindows({ filters, fetchPage: body => localRead(() => metadataPage({
        immich, config, body, requirePeople, label,
        // Cross-window overlap is validated by the legacy iterator, not by
        // the ordinary page parser's across-page duplicate check.
        seenAssetIds: new Set(),
      })) });
      for await (const window of windows) {
        rawCount += window.items.length;
        last = window;
        for (const asset of window.items) if (accept(asset)) {
          matchedCount++;
          if (assets.length < limit) assets.push(asset);
        }
        if (assets.length >= limit) break;
      }
    } catch (error) {
      // Only completed matching windows may be useful for add-only results.
      // Exclusion/membership callers never permit partial traversal.
      if (attempt === 0 && allowPartial && error instanceof ReadLimitError && assets.length) {
        return { assets, truncated: true, complete: false };
      }
      throw error;
    }
    const counts = await localRead(() => albumRead(config, () => immich.searchStatistics(statisticFilters(last.coverage))));
    const value = counts?.total;
    const total = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(total) || total < 0) throw new UpstreamPaginationError('Immich returned an invalid matching-photo count. Album membership was left unchanged.');
    if (total === rawCount) return { assets, truncated: !last.exhausted || matchedCount > limit, complete: true };
    // A second attempt is corroboration, not a cross-request snapshot. Never
    // turn a count mismatch into an add-only result: its source is unstable.
  }
  throw new UpstreamPaginationError('Immich photo counts changed while reading this album. Try again after library updates finish. Album membership was left unchanged.');
}
