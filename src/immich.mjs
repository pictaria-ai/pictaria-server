import {
  DEFAULT_MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  errorMessageWithCause,
  readBodyBounded,
} from './fetchWithTimeout.mjs';
import { appendHttpUrlPath, normalizeBaseUrl } from './config.mjs';
import { sanitizeDiagnostic, structuredUpstreamDiagnostic } from './diagnostics.mjs';
import { UpstreamPaginationError, createTraversalBudget, parseProgressingPage } from './pagination.mjs';

// Original files are legitimately large (a RAW-derived JPEG can run tens of
// MB), so original requests get a higher ceiling than the 32MB default that
// bounds JSON and thumbnail responses.
const ORIGINAL_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

// A real Immich error payload is a short JSON message; anything bigger is a
// misrouted endpoint or a proxy error page, and it must not buffer unbounded
// just to decorate the failure we are already reporting.
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const MAX_LIST_ASSETS = 100_000;
const MAX_LIST_OFFSET = 10_000_000;
const MAX_SEARCH_PAGE_SIZE = 1_000;
const LIST_TRAVERSAL_TIMEOUT_MS = 5 * 60 * 1000;

export class ImmichApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ImmichApiError';
    this.status = status;
  }
}

export class ImmichClient {
  constructor({ baseUrl, apiKey, partnerApiKey = '', timeoutMs = 60000, fetchImpl = fetch } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl ?? '');
    this.apiKey = apiKey;
    this.partnerApiKey = partnerApiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async searchMetadata(body, { apiKey = this.apiKey } = {}) {
    return this.requestJson('/search/metadata', { method: 'POST', body, apiKey });
  }

  async listImageAssets({ limit = 25, pageSize = 100, offset = 0, takenAfter = null, takenBefore = null, shouldStop = () => false } = {}) {
    assertBoundedInteger(limit, 0, MAX_LIST_ASSETS, 'limit');
    assertBoundedInteger(offset, 0, MAX_LIST_OFFSET, 'offset');
    assertBoundedInteger(pageSize, 1, MAX_SEARCH_PAGE_SIZE, 'pageSize');

    if (limit === 0) return [];

    const assets = [];
    let page = Math.floor(offset / pageSize) + 1;
    let skipFromFirstPage = offset % pageSize;
    // A progressing upstream may legally return short pages. Bound requests
    // by the worst useful case (one raw item per page), not by an assumption
    // that every page is full. One extra page may be consumed entirely by
    // the within-page offset.
    const maxPages = limit + (skipFromFirstPage > 0 ? 1 : 0);
    const maxPage = page + maxPages;
    const budget = createTraversalBudget({
      label: 'Immich asset listing',
      maxPages,
      maxItems: skipFromFirstPage + limit + pageSize - 1,
      timeoutMs: LIST_TRAVERSAL_TIMEOUT_MS,
    });

    while (assets.length < limit) {
      if (shouldStop()) break;
      budget.beginPage();
      const response = await this.searchMetadata({
        type: 'IMAGE',
        page,
        size: pageSize,
        // Pin the pre-v3 default: Immich v3 otherwise includes hidden and
        // stack-child assets, wasting enrichment spend on duplicates.
        visibility: 'timeline',
        withExif: true,
        ...(takenAfter ? { takenAfter } : {}),
        ...(takenBefore ? { takenBefore } : {}),
      });
      let pageAssets = strictSearchPageAssets(response, pageSize);
      budget.recordItems(pageAssets.length);
      if (pageAssets.length === 0) {
        break;
      }
      if (skipFromFirstPage) {
        pageAssets = pageAssets.slice(skipFromFirstPage);
        skipFromFirstPage = 0;
      }
      assets.push(...pageAssets);
      const nextPage = response?.assets?.nextPage ?? response?.nextPage;
      const parsedPage = parseProgressingPage(nextPage, page, {
        label: 'Immich asset listing',
        maxPage,
      });
      if (parsedPage === null) break;
      page = parsedPage;
    }

    return assets.slice(0, limit);
  }

  async listRandomImageAssets({ limit = 25, takenAfter = null, takenBefore = null, shouldStop = () => false } = {}) {
    assertBoundedInteger(limit, 0, MAX_LIST_ASSETS, 'limit');
    if (limit === 0 || shouldStop()) return [];

    const assets = [];
    const seen = new Set();
    let consecutiveDuplicates = 0;
    const maxConsecutiveDuplicates = 3;

    while (assets.length < limit) {
      if (shouldStop()) break;
      const count = Math.min(Math.max(1, limit - assets.length), 250);
      const query = {
        count,
        ...(takenAfter ? { takenAfter } : {}),
        ...(takenBefore ? { takenBefore } : {}),
      };
      const response = await this.searchRandom(query);
      const imageAssets = extractImageAssets(response);
      if (imageAssets.length === 0) {
        break;
      }
      let addedAny = false;
      for (const asset of imageAssets) {
        if (!asset?.id || seen.has(asset.id)) continue;
        seen.add(asset.id);
        assets.push(asset);
        addedAny = true;
        if (assets.length >= limit) break;
      }
      if (!addedAny) {
        consecutiveDuplicates += 1;
        if (consecutiveDuplicates >= maxConsecutiveDuplicates) {
          break;
        }
      } else {
        consecutiveDuplicates = 0;
      }
    }

    return assets.slice(0, limit);
  }

  async getAsset(assetId, { resolvePeople = false } = {}) {
    const response = await this.requestJson(`/assets/${encodeURIComponent(assetId)}`);
    const asset = isPlainObject(response) ? response : { id: assetId };

    // Immich resets people to [] for non-owner callers on GET /assets/:id.
    // If people is empty and a partner API key is configured, re-query with the partner key.
    if (this.partnerApiKey && (!Array.isArray(asset.people) || asset.people.length === 0)) {
      try {
        const partnerAsset = await this.requestJson(`/assets/${encodeURIComponent(assetId)}`, {
          apiKey: this.partnerApiKey,
        });
        if (partnerAsset && Array.isArray(partnerAsset.people) && partnerAsset.people.length > 0) {
          asset.people = partnerAsset.people;
        }
        if ((!Array.isArray(asset.tags) || asset.tags.length === 0) && Array.isArray(partnerAsset?.tags) && partnerAsset.tags.length > 0) {
          asset.tags = partnerAsset.tags;
        }
      } catch {
        // Keep primary response if partner request fails
      }
    } else if (resolvePeople && (!Array.isArray(asset.people) || asset.people.length === 0)) {
      // Optional fallback when partner key is not configured: Immich search joins asset_face directly.
      try {
        const searchResult = await this.searchMetadata({ id: assetId, withPeople: true });
        const match = searchResult?.assets?.items?.[0];
        if (match && Array.isArray(match.people) && match.people.length > 0) {
          asset.people = match.people;
        }
      } catch {
        // Keep primary response if search fallback fails
      }
    }

    return asset;
  }

  // Same endpoint the Immich web UI uses to edit an asset (e.g. its
  // description). Stored in Immich's database; original files are untouched.
  // Immich v3 deprecates PUT /assets/:id for an identical PATCH route (same
  // body, same asset.update permission), but as of v3.1.0 that PATCH is
  // still @ApiExcludeEndpoint — absent from the published API spec — and
  // v2.x has no PATCH route at all. PUT stays until the supported Immich
  // floor is a v3 that publishes PATCH, or Immich schedules PUT's removal.
  async updateAsset(assetId, body) {
    try {
      return await this.requestJson(`/assets/${encodeURIComponent(assetId)}`, { method: 'PUT', body });
    } catch (error) {
      if (
        this.partnerApiKey &&
        error instanceof ImmichApiError &&
        (error.status === 401 || error.status === 403 || (error.status === 400 && /access/i.test(error.message)))
      ) {
        return this.requestJson(`/assets/${encodeURIComponent(assetId)}`, {
          method: 'PUT',
          body,
          apiKey: this.partnerApiKey,
        });
      }
      throw error;
    }
  }

  async getAssetMetadataByKey(assetId, key) {
    try {
      return await this.requestJson(
        `/assets/${encodeURIComponent(assetId)}/metadata/${encodeURIComponent(key)}`,
      );
    } catch (error) {
      if (
        error instanceof ImmichApiError &&
        (error.status === 404 || (error.status === 400 && /not found/i.test(error.message)))
      ) {
        return null;
      }
      throw error;
    }
  }

  async upsertAssetMetadata(assetId, items) {
    try {
      return await this.requestJson(`/assets/${encodeURIComponent(assetId)}/metadata`, {
        method: 'PUT',
        body: { items },
      });
    } catch (error) {
      if (
        this.partnerApiKey &&
        error instanceof ImmichApiError &&
        (error.status === 401 || error.status === 403 || (error.status === 400 && /access/i.test(error.message)))
      ) {
        return this.requestJson(`/assets/${encodeURIComponent(assetId)}/metadata`, {
          method: 'PUT',
          body: { items },
          apiKey: this.partnerApiKey,
        });
      }
      throw error;
    }
  }

  async searchSmart(body) {
    return this.requestJson('/search/smart', { method: 'POST', body });
  }

  async searchRandom(body) {
    return this.requestJson('/search/random', { method: 'POST', body });
  }

  async searchStatistics(body) {
    return this.requestJson('/search/statistics', { method: 'POST', body });
  }

  async searchPeople(name) {
    const response = await this.requestJson(
      `/search/person?name=${encodeURIComponent(name)}&withHidden=false`,
    );
    return Array.isArray(response) ? response : [];
  }

  async getPeople({ page = 1, size = 500, withHidden = false } = {}) {
    const params = new URLSearchParams({ page: String(page), size: String(size), withHidden: String(withHidden) });
    return this.requestJson(`/people?${params}`);
  }

  async getPersonStatistics(personId) {
    return this.requestJson(`/people/${encodeURIComponent(personId)}/statistics`);
  }

  async getPersonThumbnail(personId) {
    return this.requestBytes(`/people/${encodeURIComponent(personId)}/thumbnail`);
  }

  async getTimelineBuckets(size = 'MONTH') {
    const response = await this.requestJson(`/timeline/buckets?size=${encodeURIComponent(size)}`);
    return Array.isArray(response) ? response : [];
  }

  async getAlbums() {
    const response = await this.requestJson('/albums');
    return Array.isArray(response) ? response : [];
  }

  async createAlbum({ albumName, assetIds = [], description = '' }) {
    return this.requestJson('/albums', {
      method: 'POST',
      body: { albumName, assetIds, description },
    });
  }

  async deleteAlbum(albumId) {
    return this.requestJson(`/albums/${encodeURIComponent(albumId)}`, { method: 'DELETE' });
  }

  async addAssetsToAlbum(albumId, assetIds) {
    if (assetIds.length === 0) {
      return undefined;
    }
    return this.requestJson(`/albums/${encodeURIComponent(albumId)}/assets`, {
      method: 'PUT',
      body: { ids: assetIds },
    });
  }

  async removeAssetsFromAlbum(albumId, assetIds) {
    if (assetIds.length === 0) {
      return undefined;
    }
    return this.requestJson(`/albums/${encodeURIComponent(albumId)}/assets`, {
      method: 'DELETE',
      body: { ids: assetIds },
    });
  }

  // Like getAssetOriginal, callers with a byte budget (the referee's group
  // ceiling) can pass maxBytes: past it the download aborts with a
  // ResponseTooLargeError instead of buffering. Without it the default
  // response ceiling applies.
  async getAssetThumbnail(assetId, size = 'preview', { maxBytes } = {}) {
    try {
      return await this.requestBytes(
        `/assets/${encodeURIComponent(assetId)}/thumbnail?size=${encodeURIComponent(size)}`,
        maxBytes === undefined ? {} : { maxBytes },
      );
    } catch (error) {
      if (this.partnerApiKey && error instanceof ImmichApiError && (error.status === 401 || error.status === 403)) {
        return this.requestBytes(
          `/assets/${encodeURIComponent(assetId)}/thumbnail?size=${encodeURIComponent(size)}`,
          { ...(maxBytes === undefined ? {} : { maxBytes }), apiKey: this.partnerApiKey },
        );
      }
      throw error;
    }
  }

  // Callers with a tighter budget than the original-class default (e.g. the
  // referee's per-image ceiling) pass their own maxBytes; past it the download
  // aborts with a ResponseTooLargeError instead of buffering.
  async getAssetOriginal(assetId, { maxBytes = ORIGINAL_MAX_RESPONSE_BYTES } = {}) {
    try {
      return await this.requestBytes(`/assets/${encodeURIComponent(assetId)}/original`, { maxBytes });
    } catch (error) {
      if (this.partnerApiKey && error instanceof ImmichApiError && (error.status === 401 || error.status === 403)) {
        return this.requestBytes(`/assets/${encodeURIComponent(assetId)}/original`, { maxBytes, apiKey: this.partnerApiKey });
      }
      throw error;
    }
  }

  async getPartnerUserId() {
    if (!this.partnerApiKey) {
      return null;
    }
    if (this._partnerUserId !== undefined) {
      return this._partnerUserId;
    }
    try {
      const user = await this.requestJson('/users/me', { apiKey: this.partnerApiKey });
      this._partnerUserId = user?.id ?? null;
    } catch {
      this._partnerUserId = null;
    }
    return this._partnerUserId;
  }

  async partitionAssetIdsByOwner(assetIds, { remoteAssets = null } = {}) {
    if (!this.partnerApiKey || !Array.isArray(assetIds) || assetIds.length === 0) {
      return [{ apiKey: this.apiKey, assetIds: Array.isArray(assetIds) ? [...assetIds] : [] }];
    }
    const partnerUserId = await this.getPartnerUserId();
    if (!partnerUserId) {
      return [{ apiKey: this.apiKey, assetIds: [...assetIds] }];
    }
    const assetMap = remoteAssets instanceof Map
      ? remoteAssets
      : new Map(Array.isArray(remoteAssets) ? remoteAssets.map((a) => [a.id, a]) : []);

    const primaryIds = [];
    const partnerIds = [];
    for (const assetId of assetIds) {
      let asset = assetMap.get(assetId);
      if (!asset) {
        try {
          asset = await this.getAsset(assetId);
          assetMap.set(assetId, asset);
        } catch {
          // If fetch fails, keep under primary key
        }
      }
      if (asset?.ownerId === partnerUserId) {
        partnerIds.push(assetId);
      } else {
        primaryIds.push(assetId);
      }
    }
    const partitions = [];
    if (primaryIds.length > 0) {
      partitions.push({ apiKey: this.apiKey, assetIds: primaryIds, isPartner: false });
    }
    if (partnerIds.length > 0) {
      partitions.push({ apiKey: this.partnerApiKey, assetIds: partnerIds, isPartner: true });
    }
    return partitions;
  }

  async listTags({ strict = false, apiKey = this.apiKey } = {}) {
    const response = await this.requestJson('/tags', { apiKey });
    if (Array.isArray(response)) {
      return response;
    }
    if (isPlainObject(response) && Array.isArray(response.tags)) {
      return response.tags;
    }
    if (strict) {
      throw new UpstreamPaginationError('Immich tag listing returned an invalid response.');
    }
    return [];
  }

  async upsertTags(tags, { apiKey = this.apiKey } = {}) {
    if (!tags.length) {
      return [];
    }
    const response = await this.requestJson('/tags', { method: 'PUT', body: { tags }, apiKey });
    if (Array.isArray(response)) {
      return response;
    }
    return isPlainObject(response) && Array.isArray(response.tags) ? response.tags : [];
  }

  async createTag(tag, { apiKey = this.apiKey } = {}) {
    return this.requestJson('/tags', { method: 'POST', body: { name: tag }, apiKey });
  }

  async tagAssetsBulk({ assetIds, tagIds, apiKey = this.apiKey }) {
    if (!assetIds.length || !tagIds.length) {
      return { count: 0 };
    }
    return this.requestJson('/tags/assets', { method: 'PUT', body: { assetIds, tagIds }, apiKey });
  }

  async untagAssets({ tagId, assetIds, apiKey = this.apiKey }) {
    if (!assetIds.length) {
      return [];
    }
    const response = await this.requestJson(`/tags/${encodeURIComponent(tagId)}/assets`, {
      method: 'DELETE',
      body: { ids: assetIds },
      apiKey,
    });
    return Array.isArray(response) ? response : [];
  }

  async requestJson(path, { method = 'GET', body = null, apiKey = this.apiKey } = {}) {
    const { buffer } = await this.#request(path, { method, body, accept: 'application/json', apiKey });
    const text = buffer.toString('utf8');
    return text ? JSON.parse(text) : null;
  }

  async requestBytes(path, { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, apiKey = this.apiKey } = {}) {
    const { buffer, contentType } = await this.#request(path, {
      method: 'GET',
      body: null,
      accept: 'image/*, application/octet-stream',
      maxBytes,
      apiKey,
    });
    return {
      data: buffer,
      contentType: contentType ?? 'application/octet-stream',
    };
  }

  // The deadline covers the WHOLE exchange — connect, headers, and body — so
  // an Immich that returns headers and then stalls mid-body times out instead
  // of hanging the caller forever. The body is consumed here, inside the
  // timer's window, bounded by maxBytes (a runaway body aborts instead of
  // exhausting process memory), and returned fully buffered.
  async #request(path, { method, body, accept, maxBytes = DEFAULT_MAX_RESPONSE_BYTES, apiKey = this.apiKey }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = appendHttpUrlPath(this.baseUrl, `/api/${String(path).replace(/^\/+/, '')}`);
    try {
      const response = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: accept,
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: body === null ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        throw new ImmichApiError(await readErrorMessage(response, apiKey), response.status);
      }
      // Injected fetchImpl doubles without a body stream (tests) read whole.
      const buffer = typeof response.body?.getReader === 'function'
        ? await readBodyBounded(response, maxBytes, 'Immich')
        : Buffer.from(await response.arrayBuffer());
      return {
        buffer,
        contentType: response.headers.get('content-type'),
      };
    } catch (error) {
      // ResponseTooLargeError passes through unwrapped so callers can react
      // to "too big" specifically (the referee degrades to the preview).
      if (error instanceof ImmichApiError || error instanceof ResponseTooLargeError) {
        throw error;
      }
      const reason = error?.name === 'AbortError'
        ? `timed out after ${this.timeoutMs}ms`
        : errorMessageWithCause(error);
      throw new ImmichApiError(`Immich request failed: ${sanitizeDiagnostic(reason, { secrets: [this.apiKey] })}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function strictSearchPageAssets(response, pageSize) {
  const items = Array.isArray(response)
    ? response
    : Array.isArray(response?.assets)
      ? response.assets
      : response?.assets?.items ?? response?.items;
  if (!Array.isArray(items) || items.length > pageSize) {
    throw new UpstreamPaginationError('Immich asset listing returned an invalid or oversized item page.');
  }
  if (items.some((asset) => !isPlainObject(asset) || typeof asset.id !== 'string' || !asset.id)) {
    throw new UpstreamPaginationError('Immich asset listing returned an invalid asset entry.');
  }
  return items;
}

export function extractAssets(response) {
  const candidates = [
    response,
    response?.assets,
    response?.assets?.items,
    response?.items,
    response?.data,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((asset) => isPlainObject(asset) && typeof asset.id === 'string');
    }
  }
  return [];
}

// Search responses vary by endpoint and Immich version; this narrows any of
// them to the IMAGE assets the frame features can display.
export function extractImageAssets(response) {
  if (Array.isArray(response)) {
    return response.filter((asset) => asset?.type === 'IMAGE');
  }
  const assets = Array.isArray(response?.assets)
    ? response.assets
    : response?.assets?.items ?? response?.items ?? [];
  return assets.filter((asset) => asset?.type === 'IMAGE');
}

export function tagId(tagResponse) {
  return typeof tagResponse?.id === 'string' ? tagResponse.id : null;
}

export function tagValue(tagResponse) {
  for (const key of ['value', 'name']) {
    if (typeof tagResponse?.[key] === 'string') {
      return tagResponse[key];
    }
  }
  return null;
}

// Best-effort detail for a failed request. Reads the body BOUNDED — an error
// response can carry an arbitrarily large body — and never throws: a
// too-large or unparsable body degrades to the generic status message. (A
// throw here would mask the real failure; a ResponseTooLargeError in
// particular would escape #request unwrapped and read as "image too big" to
// callers that degrade on it.)
async function readErrorMessage(response, apiKey) {
  try {
    // Injected fetchImpl doubles without a body stream (tests) read whole.
    const body = typeof response.body?.getReader === 'function'
      ? JSON.parse((await readBodyBounded(response, ERROR_BODY_MAX_BYTES, 'Immich')).toString('utf8'))
      : await response.json();
    return structuredUpstreamDiagnostic(body, {
      secrets: [apiKey],
      fallback: `Immich request failed with status ${response.status}`,
    });
  } catch {
    // fall through
  }
  return `Immich request failed with status ${response.status}`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
