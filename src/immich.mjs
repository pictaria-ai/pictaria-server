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
  constructor({ baseUrl, apiKey, timeoutMs = 60000, fetchImpl = fetch } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl ?? '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async searchMetadata(body) {
    return this.requestJson('/search/metadata', { method: 'POST', body });
  }

  async listImageAssets({ limit = 25, pageSize = 100, offset = 0, shouldStop = () => false } = {}) {
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

  async getAsset(assetId) {
    const response = await this.requestJson(`/assets/${encodeURIComponent(assetId)}`);
    return isPlainObject(response) ? response : { id: assetId };
  }

  // Same endpoint the Immich web UI uses to edit an asset (e.g. its
  // description). Stored in Immich's database; original files are untouched.
  // Immich v3 deprecates PUT /assets/:id for an identical PATCH route (same
  // body, same asset.update permission), but as of v3.1.0 that PATCH is
  // still @ApiExcludeEndpoint — absent from the published API spec — and
  // v2.x has no PATCH route at all. PUT stays until the supported Immich
  // floor is a v3 that publishes PATCH, or Immich schedules PUT's removal.
  async updateAsset(assetId, body) {
    return this.requestJson(`/assets/${encodeURIComponent(assetId)}`, { method: 'PUT', body });
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
    return this.requestJson(`/assets/${encodeURIComponent(assetId)}/metadata`, {
      method: 'PUT',
      body: { items },
    });
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
    return this.requestBytes(
      `/assets/${encodeURIComponent(assetId)}/thumbnail?size=${encodeURIComponent(size)}`,
      maxBytes === undefined ? {} : { maxBytes },
    );
  }

  // Callers with a tighter budget than the original-class default (e.g. the
  // referee's per-image ceiling) pass their own maxBytes; past it the download
  // aborts with a ResponseTooLargeError instead of buffering.
  async getAssetOriginal(assetId, { maxBytes = ORIGINAL_MAX_RESPONSE_BYTES } = {}) {
    return this.requestBytes(`/assets/${encodeURIComponent(assetId)}/original`, { maxBytes });
  }

  async listTags({ strict = false } = {}) {
    const response = await this.requestJson('/tags');
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

  async upsertTags(tags) {
    if (!tags.length) {
      return [];
    }
    const response = await this.requestJson('/tags', { method: 'PUT', body: { tags } });
    if (Array.isArray(response)) {
      return response;
    }
    return isPlainObject(response) && Array.isArray(response.tags) ? response.tags : [];
  }

  async createTag(tag) {
    return this.requestJson('/tags', { method: 'POST', body: { name: tag } });
  }

  async tagAssetsBulk({ assetIds, tagIds }) {
    if (!assetIds.length || !tagIds.length) {
      return { count: 0 };
    }
    return this.requestJson('/tags/assets', { method: 'PUT', body: { assetIds, tagIds } });
  }

  async untagAssets({ tagId, assetIds }) {
    if (!assetIds.length) {
      return [];
    }
    const response = await this.requestJson(`/tags/${encodeURIComponent(tagId)}/assets`, {
      method: 'DELETE',
      body: { ids: assetIds },
    });
    return Array.isArray(response) ? response : [];
  }

  async requestJson(path, { method = 'GET', body = null } = {}) {
    const { buffer } = await this.#request(path, { method, body, accept: 'application/json' });
    const text = buffer.toString('utf8');
    return text ? JSON.parse(text) : null;
  }

  async requestBytes(path, { maxBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
    const { buffer, contentType } = await this.#request(path, {
      method: 'GET',
      body: null,
      accept: 'image/*, application/octet-stream',
      maxBytes,
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
  async #request(path, { method, body, accept, maxBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
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
          'x-api-key': this.apiKey,
        },
        body: body === null ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        throw new ImmichApiError(await readErrorMessage(response, this.apiKey), response.status);
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
