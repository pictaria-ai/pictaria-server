import { CurateError, fingerprint } from './contracts.mjs';

export const SIMILARITY_LIMITS = Object.freeze({
  results: 50, timeoutMs: 15_000, responseBytes: 2 * 1024 * 1024,
  cacheEntries: 40, cacheMs: 10 * 60_000, minIntervalMs: 5_000, failureIntervalMs: 30_000,
});

// An explicit, read-only search lane shared by Curate callers. No polling,
// pagination, fallback, retry, or connection to grouping/keeper decisions.
export class CurateSimilaritySearch {
  constructor({ curate, now = Date.now, timeoutMs = SIMILARITY_LIMITS.timeoutMs }) {
    this.curate = curate;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
    this.nextAt = 0;
  }
  connectionKey() {
    const client = this.curate.immich;
    return fingerprint([client?.baseUrl ?? null, client?.apiKey ?? null]);
  }
  settingsChanged() {
    const key = this.connectionKey();
    if (this.connection !== key) {
      this.controller?.abort();
      this.cache.clear();
      this.connection = key;
    }
  }
  sourceKey(id) {
    const row = this.curate.repo.db.prepare(`SELECT checksum,file_modified_at,thumbhash,missing_since
      FROM assets WHERE asset_id=?`).get(id);
    if (!row || row.missing_since || !this.curate.repo.reviewListMembership([id]).has(id))
      throw new CurateError('The reference photo is no longer available for this experiment. Rebuild time groups.', 'similarity_reference_changed');
    return fingerprint(row);
  }
  async search(referenceId, { signal } = {}) {
    if (typeof referenceId !== 'string' || !referenceId || referenceId.length > 128)
      throw new CurateError('Invalid similarity reference.', 'invalid_curate_query', 400);
    signal?.throwIfAborted();
    if (this.closed || this.curate.closed)
      throw new CurateError('Similarity search is stopping.', 'similarity_unavailable', 503);
    const original = this.curate.immich;
    if (!original?.requestJson || !original.baseUrl || !original.apiKey)
      throw new CurateError('Configure the Immich connection before checking similarity.', 'similarity_unavailable', 503);
    this.settingsChanged();
    const connection = this.connection, source = this.sourceKey(referenceId);
    const key = fingerprint([connection, referenceId, source]);
    for (const [id, value] of this.cache) if (value.checkedAt + SIMILARITY_LIMITS.cacheMs <= this.now()) this.cache.delete(id);
    const cached = this.cache.get(key);
    if (cached) return { ...cached, ids: [...cached.ids], cached: true };
    if (this.work)
      throw new CurateError('Another similarity search is running. Try again when it finishes.', 'similarity_busy', 503);
    if (this.nextAt > this.now())
      throw new CurateError(`Please wait ${Math.ceil((this.nextAt - this.now()) / 1000)} seconds before another similarity search.`, 'similarity_cooldown', 429);
    this.nextAt = this.now() + SIMILARITY_LIMITS.minIntervalMs;
    this.controller = new AbortController();
    const deadline = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const client = original.clone?.() ?? original;
    this.work = this.run(client, referenceId, deadline, connection, source);
    try {
      const value = await this.work;
      if (this.cache.size >= SIMILARITY_LIMITS.cacheEntries) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, value);
      return { ...value, ids: [...value.ids], cached: false };
    } finally { this.work = null; this.controller = null; }
  }
  async run(client, referenceId, signal, connection, source) {
    const started = performance.now();
    try {
      const response = await client.requestJson('/search/smart', {
        method: 'POST', body: { queryAssetId: referenceId, type: 'IMAGE', visibility: 'timeline',
          size: SIMILARITY_LIMITS.results + 1, withExif: false },
        signal, maxBytes: SIMILARITY_LIMITS.responseBytes,
      });
      signal.throwIfAborted();
      if (connection !== this.connectionKey() || source !== this.sourceKey(referenceId))
        throw new CurateError('The reference photo or Immich connection changed. Check similarity again.', 'similarity_reference_changed');
      const items = response?.assets?.items;
      if (!Array.isArray(items) || items.length > SIMILARITY_LIMITS.results + 1 ||
          items.some(p => !p || typeof p.id !== 'string' || !p.id || p.id.length > 128 || p.type !== 'IMAGE') ||
          new Set(items.map(p => p.id)).size !== items.length)
        throw new CurateError('Immich returned an unusable similarity ranking. No ranks were assigned.', 'similarity_invalid_response', 502);
      // Do not expose/store full asset DTOs or page through the library. The
      // reference may be absent or appear anywhere in the returned order.
      const ids = items.filter(p => p.id !== referenceId).slice(0, SIMILARITY_LIMITS.results).map(p => p.id);
      return { referenceId, ids, limit: SIMILARITY_LIMITS.results, checkedAt: this.now(),
        elapsedMs: Math.round(performance.now() - started) };
    } catch (error) {
      this.nextAt = Math.max(this.nextAt, this.now() + SIMILARITY_LIMITS.failureIntervalMs);
      if (error instanceof CurateError) throw error;
      const message = signal.aborted ? 'Similarity search was interrupted or timed out. Try again when ready.'
        : [401, 403].includes(error.status) ? 'Immich denied this search. Check the API key’s asset.read permission.'
        : [400, 404, 422].includes(error.status) ? 'Immich could not search from this photo. Check that Smart Search is enabled and has processed the reference photo.'
        : error.status === 429 ? 'Immich is busy. Wait before trying again.'
        : 'Could not load similarity ranks from Immich. Try again later.';
      // Never return upstream bodies, credentials, URLs, or unrelated photos.
      throw new CurateError(message, 'similarity_unavailable', 503);
    }
  }
  async close() {
    this.closed = true;
    this.controller?.abort();
    this.cache.clear();
    await this.work?.catch(() => {});
  }
}
