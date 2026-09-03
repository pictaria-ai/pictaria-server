import { HttpBodyError, readJsonBody, sendError, sendImage, sendJson } from '../http.mjs';
import { describeResponseFields } from '../enrich/schema.mjs';
import { reviewConfig } from '../enrich/reviewBuckets.mjs';
import { loadPrompts } from '../enrich/runner.mjs';
import { normalizeSliceFilters, resolveSliceAssetIds } from './insights.mjs';
import { AssetBatchError, validateAssetBatch } from '../enrich/assetBatch.mjs';
import {
  ENRICH_QUEUE_DEFAULT_PAGE_SIZE,
  ENRICH_QUEUE_MAX_PAGE_SIZE,
  ENRICH_QUEUE_MAX_ITEMS_GLOBAL,
  ENRICH_RUN_DEFAULT_PAGE_SIZE,
  ENRICH_RUN_MAX_PAGE_SIZE,
} from '../enrich/repository.mjs';

import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

function encodeQueueCursor(id) {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

function decodeQueueCursor(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpBodyError('Invalid enrichment queue cursor.', 400, 'invalid_queue_cursor');
  }
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^[1-9]\d*$/.test(decoded)) {
    throw new HttpBodyError('Invalid enrichment queue cursor.', 400, 'invalid_queue_cursor');
  }
  const id = Number(decoded);
  if (!Number.isSafeInteger(id)) {
    throw new HttpBodyError('Invalid enrichment queue cursor.', 400, 'invalid_queue_cursor');
  }
  return id;
}

function queuePageLimit(value) {
  if (value === null || value === undefined || value === '') return ENRICH_QUEUE_DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(value)) {
    throw new HttpBodyError('Invalid enrichment queue page limit.', 400, 'invalid_queue_limit');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENRICH_QUEUE_MAX_PAGE_SIZE) {
    throw new HttpBodyError(
      `Enrichment queue pages must contain 1-${ENRICH_QUEUE_MAX_PAGE_SIZE} items.`,
      400,
      'invalid_queue_limit',
    );
  }
  return limit;
}

function encodeRunCursor(id) {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}

function decodeRunCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpBodyError('Invalid enrichment run cursor.', 400, 'invalid_run_cursor');
  }
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^[1-9]\d*$/.test(decoded)) {
    throw new HttpBodyError('Invalid enrichment run cursor.', 400, 'invalid_run_cursor');
  }
  const id = Number(decoded);
  if (!Number.isSafeInteger(id)) {
    throw new HttpBodyError('Invalid enrichment run cursor.', 400, 'invalid_run_cursor');
  }
  return id;
}

function runPageLimit(value) {
  if (value === null || value === undefined || value === '') return ENRICH_RUN_DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(value)) {
    throw new HttpBodyError('Invalid enrichment run page limit.', 400, 'invalid_run_limit');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ENRICH_RUN_MAX_PAGE_SIZE) {
    throw new HttpBodyError(
      `Enrichment run pages must contain 1-${ENRICH_RUN_MAX_PAGE_SIZE} items.`,
      400,
      'invalid_run_limit',
    );
  }
  return limit;
}

export function createEnrichRoutes({ review, enrichRunner, taxonomy, repo, requireImmich, config, immich, captionWriteback, referee, activityLog = null }) {
  const diagnostic = (value) => sanitizeDiagnostic(value instanceof Error ? value.message : value, {
    secrets: configuredSecrets(config, immich),
  });
  // Number of queue items currently having their slice resolved (a single
  // Run, or a Run-all walk deciding its next item). Surfaced in
  // /api/enrich/status as `resolvingSlice` so the Enrich page keeps
  // polling and its controls stay locked through the gap — otherwise an
  // item retired after the last run would sit stale on screen, and
  // competing starts could race the resolution. The start routes 409
  // while it's non-zero: resolution is exclusive, like the run itself,
  // and that holds for every client, not just this page's buttons.
  let sliceResolutions = 0;
  const resolvingQueueItemIds = new Set();
  const runAllPlanIds = new Set();
  // A running model run and an in-flight slice resolution both own the
  // queue: the start routes reject competing requests during either, so a
  // stale second tab can't begin resolving (and review-listing covered
  // photos) only to die at start(). The chain's own next item never
  // passes through here — it starts after the runner is already idle.
  const queueBusy = () => enrichRunner.isRunning() || sliceResolutions > 0;
  // Start one queued item. Shared by the single Run button and the Run-all
  // chain; `chainNext` (if given) fires after this item's clean finish, so
  // a cancel or failure stops the chain with the queue intact.
  async function startQueuedItem(item, { provider, sendToCurate = true, reopenDecided = false, skipAnySuccessful, chainNext } = {}) {
    sliceResolutions += 1;
    resolvingQueueItemIds.add(item.id);
    try {
      return await resolveAndStart(item, { provider, sendToCurate, reopenDecided, skipAnySuccessful, chainNext });
    } finally {
      sliceResolutions -= 1;
      resolvingQueueItemIds.delete(item.id);
    }
  }

  function protectedQueueIds() {
    // A failed/cancelled chain has no callback into this route. The next
    // queue request observes that neither a run nor a resolution remains and
    // releases the stale plan protection before applying normal expiry.
    if (runAllPlanIds.size > 0 && !enrichRunner.isRunning() && sliceResolutions === 0) {
      runAllPlanIds.clear();
    }
    const ids = new Set(resolvingQueueItemIds);
    for (const id of runAllPlanIds) ids.add(id);
    const activeId = enrichRunner.isRunning() ? Number(enrichRunner.status()?.options?.queueItemId) : null;
    if (Number.isSafeInteger(activeId) && activeId > 0) ids.add(activeId);
    return [...ids];
  }

  function maintainQueue() {
    return repo.queueMaintain({ protectedIds: protectedQueueIds() });
  }

  function queuePagePayload(searchParams = null) {
    maintainQueue();
    const afterId = decodeQueueCursor(searchParams?.get('cursor'));
    const limit = queuePageLimit(searchParams?.get('limit'));
    const page = repo.queuePage({ afterId, limit });
    return {
      items: page.items,
      nextCursor: page.nextAfterId === null ? null : encodeQueueCursor(page.nextAfterId),
      total: page.total,
    };
  }

  async function resolveAndStart(item, { provider, sendToCurate, reopenDecided, skipAnySuccessful, chainNext }) {
    const reopen = reopenDecided === true;
    const skip = skipAnySuccessful === undefined ? !reopen : skipAnySuccessful !== false;
    // Skip-aware resolution collects photos the run would analyze, so a capped
    // slice advances across repeat runs instead of re-resolving the same first
    // window forever. Re-open runs
    // stay unfiltered: their finish clears decisions on the whole resolved
    // set, which must include already-enriched photos.
    const filterNeedsWork = reopen ? null : enrichRunner.needsWorkFilter({ provider, skipAnySuccessful: skip });
    const resolved = await resolveSliceAssetIds({ immich, rawFilters: item.filters, filterNeedsWork });
    // Resolution can take a while on a big slice; if the user removed the
    // item in the meantime, that intent wins — no listing, no retirement
    // record, no run.
    if (!repo.queueGet(item.id)) {
      const error = new Error('That queued job was removed while its photos were being resolved.');
      error.code = 'queue_item_removed';
      throw error;
    }
    // The runner review-lists photos it skips as already enriched; filtered
    // resolution drops those before the runner sees them, so list them here
    // (a queue run with Send to Curate includes previously enriched photos —
    // see docs/ENRICH.md).
    if (resolved && sendToCurate !== false && resolved.coveredAssetIds?.length > 0) {
      repo.reviewListAdd(resolved.coveredAssetIds, 'enrich');
    }
    if (!resolved || resolved.assetIds.length === 0) {
      if (resolved && resolved.scannedImages > 0) {
        // Nothing left for this item to analyze, so it removes itself
        // instead of erroring forever — reported honestly: photos stuck at
        // the content-failure limit are unresolved, not covered. The
        // outcome also lands in run history, so a removal that happens mid
        // Run-all chain (after the HTTP response) stays visible.
        repo.queueRemove(item.id);
        const covered = resolved.coveredAssetIds.length;
        const stuck = resolved.failureLimitedCount;
        const discarded = resolved.discardedCount ?? 0;
        enrichRunner.recordCoveredResolution({ title: item.title, provider, covered, failureLimited: stuck, discarded });
        const leftBehind = [
          stuck > 0 ? `${stuck} at the failure limit` : null,
          discarded > 0 ? `${discarded} discarded` : null,
        ].filter(Boolean).join(', ');
        const error = new Error(
          leftBehind
            ? `"${item.title}" has nothing left to analyze — ${covered} already enriched, ${leftBehind} — removed it from the queue.`
            : `"${item.title}" is already fully covered — removed it from the queue.`,
        );
        error.code = 'fully_covered';
        error.covered = covered;
        error.failureLimited = stuck;
        error.discarded = discarded;
        throw error;
      }
      const error = new Error('No photos matched this slice.');
      error.code = 'empty_slice';
      throw error;
    }
    return {
      status: enrichRunner.start({
        provider,
        skipAnySuccessful: skip,
        assetIds: resolved.assetIds,
        sliceTruncated: resolved.truncated,
        title: item.title,
        queueItemId: item.id,
        // Re-opening decided photos only makes sense if results go to Curate.
        sendToCurate: sendToCurate !== false || reopen,
        reopenDecided: reopen,
        // Runs only on a clean finish: cancelled/failed runs leave the item
        // queued (Cancel doubles as pause). Capped slices stay queued so
        // repeat runs walk the rest.
        onFinished: () => {
          if (reopen) {
            // A clean run can still contain photos that failed and were never
            // admitted to Curate. Clear only current review members; if the
            // durable sync queue refuses the work, leave the queue item in
            // place so the user can retry after the backlog drains.
            const currentMembers = repo.reviewListMembership(resolved.assetIds);
            const reopenIds = resolved.assetIds.filter((assetId) => currentMembers.has(assetId));
            if (reopenIds.length > 0) {
              review.applyDecision({ action: 'clear', assetIds: reopenIds });
            }
          }
          if (!resolved.truncated) {
            repo.queueRemove(item.id);
          }
          chainNext?.();
        },
      }),
      truncated: resolved.truncated,
    };
  }

  return async function handleEnrichRoute(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/review/assets') {
      if (!requireImmich(response)) {
        return true;
      }
      sendJson(response, 200, {
        ...review.assetsResponse(url.searchParams),
        // For the lightbox's "Open in Immich" link — same source as /api/insights.
        immichUrl: config.immichPublicUrl || null,
        // Drives Curate's "Enrich is running" note: stacks regroup as photos
        // arrive during a run.
        enrichRunning: enrichRunner.isRunning(),
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/review/decision') {
      const body = await readJsonBody(request);
      if (typeof body?.action !== 'string' || !Array.isArray(body?.asset_ids)) {
        throw new HttpBodyError('Expected action and asset_ids.', 400, 'invalid_decision_request');
      }
      try {
        const assetIds = validateAssetBatch(body.asset_ids, { code: 'invalid_decision_request' });
        sendJson(response, 200, review.applyDecision({ action: body.action, assetIds }));
      } catch (error) {
        if (error instanceof AssetBatchError || error?.code === 'review_sync_backlog_full') {
          sendError(response, error.status ?? 400, error.code, error.message);
          return true;
        }
        throw error;
      }
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/review/sync-status') {
      sendJson(response, 200, review.syncStatus());
      return true;
    }

    // Dead-lettered sync jobs: inspect, retry (one or all), or dismiss.
    if (request.method === 'GET' && url.pathname === '/api/review/sync-dead') {
      sendJson(response, 200, { jobs: review.deadSyncJobs() });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/review/sync-dead/retry') {
      const body = await readJsonBody(request);
      const jobId = body?.id === undefined || body?.id === null ? null : parseSyncJobId(body.id);
      if (jobId === undefined) {
        throw new HttpBodyError('Expected an integer job id (or none to retry all).', 400, 'invalid_sync_job_id');
      }
      sendJson(response, 200, { requeued: review.retryDeadSyncJobs(jobId), sync: review.syncStatus() });
      return true;
    }

    const syncDeadMatch = url.pathname.match(/^\/api\/review\/sync-dead\/(-?\d+)$/);
    if (request.method === 'DELETE' && syncDeadMatch) {
      const jobId = parseSyncJobId(syncDeadMatch[1]);
      if (jobId === undefined) {
        throw new HttpBodyError('Expected a positive integer job id.', 400, 'invalid_sync_job_id');
      }
      const dismissed = review.dismissDeadSyncJob(jobId);
      if (!dismissed) {
        sendError(response, 404, 'sync_job_not_found', 'No dead-lettered sync job with that id.');
        return true;
      }
      sendJson(response, 200, { ok: true, sync: review.syncStatus() });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/review/referee/status') {
      // enrichRunning rides Curate's steady 30s poll, so the stacks-may-change
      // note tracks run state even while the user only looks.
      sendJson(response, 200, {
        ...(referee ? referee.status() : { enabled: false }),
        enrichRunning: enrichRunner.isRunning(),
      });
      return true;
    }

    // Recent judged groups + error trail for the Curate activity popup.
    if (request.method === 'GET' && url.pathname === '/api/review/referee/activity') {
      sendJson(response, 200, referee ? referee.activity() : { groups: [], errors: [] });
      return true;
    }

    // User pause/resume. An in-flight group finishes first (the status shows
    // paused+working while it does); pause lasts until resume or a restart.
    if (request.method === 'POST' && url.pathname === '/api/review/referee/pause') {
      if (!referee) {
        sendError(response, 409, 'referee_unavailable', 'The referee is not available.');
        return true;
      }
      const body = await readJsonBody(request);
      sendJson(response, 200, referee.setPaused(Boolean(body?.paused)));
      return true;
    }

    // Per-photo coverage marks for the Insights browser grid (one call per
    // visible page). Local SQLite only.
    if (request.method === 'POST' && url.pathname === '/api/review/coverage') {
      const body = await readJsonBody(request);
      if (!Array.isArray(body?.assetIds) || body.assetIds.length === 0) {
        sendError(response, 400, 'invalid_coverage_request', 'Expected a non-empty assetIds array.');
        return true;
      }
      sendJson(response, 200, { coverage: repo.coverageFor(body.assetIds.slice(0, 1000)) });
      return true;
    }

    // Whole-slice coverage counts for the slice modal ("120 enriched ·
    // 89 curated"). Resolving the slice pages Immich, so big slices are
    // sampled: the first `max` photos, reported honestly via `truncated`.
    if (request.method === 'POST' && url.pathname === '/api/review/coverage-summary') {
      if (!requireImmich(response)) {
        return true;
      }
      const body = await readJsonBody(request);
      if (!body?.filters || typeof body.filters !== 'object' || Object.keys(body.filters).length === 0) {
        sendError(response, 400, 'invalid_slice', 'At least one slice filter is required.');
        return true;
      }
      const resolved = await resolveSliceAssetIds({ immich, rawFilters: body.filters, max: 5000 });
      if (!resolved) {
        sendError(response, 400, 'invalid_slice', 'Unrecognized slice filters.');
        return true;
      }
      let enriched = 0;
      let curated = 0;
      for (const entry of Object.values(repo.coverageFor(resolved.assetIds))) {
        enriched += entry.enriched ? 1 : 0;
        curated += entry.curated ? 1 : 0;
      }
      sendJson(response, 200, { total: resolved.assetIds.length, enriched, curated, truncated: resolved.truncated });
      return true;
    }

    // "Send to Curate": add a slice to the review list directly — no
    // enrichment involved, so this works with enrichment off. Only photos
    // without a decision surface in the queue; decided photos are untouched.
    if (request.method === 'POST' && url.pathname === '/api/review/send') {
      if (!requireImmich(response)) {
        return true;
      }
      const body = await readJsonBody(request);
      if (!body?.filters || typeof body.filters !== 'object' || Object.keys(body.filters).length === 0) {
        sendError(response, 400, 'invalid_slice', 'At least one slice filter is required.');
        return true;
      }
      const resolved = await resolveSliceAssetIds({ immich, rawFilters: body.filters });
      if (!resolved || resolved.assetIds.length === 0) {
        sendError(response, 400, 'empty_slice', 'No photos matched this slice.');
        return true;
      }
      for (const asset of resolved.assets) {
        repo.upsertAsset(asset);
      }
      const added = repo.reviewListAdd(resolved.assetIds, 'send');
      sendJson(response, 200, {
        total: resolved.assetIds.length,
        added,
        alreadyListed: resolved.assetIds.length - added,
        truncated: resolved.truncated,
      });
      return true;
    }

    const thumbnailMatch = url.pathname.match(/^\/api\/review\/thumbnail\/([^/]+)$/);
    if (request.method === 'GET' && thumbnailMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const image = await review.thumbnail(decodeURIComponent(thumbnailMatch[1]));
      sendImage(response, 200, image.data);
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/enrich/status') {
      sendJson(response, 200, {
        ...enrichRunner.status(),
        enabled: config.enrichEnabled,
        resolvingSlice: sliceResolutions > 0,
        library: repo.libraryStats(),
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/enrich/run') {
      if (!requireImmich(response)) {
        return true;
      }
      if (!config.enrichEnabled) {
        sendError(response, 403, 'enrichment_disabled', 'Enrichment is turned off — enable it in Settings → Enrich.');
        return true;
      }
      const body = await readJsonBody(request);
      // No await between this check and start(): a run or a queued job
      // mid-resolution holds exclusivity either way.
      if (queueBusy()) {
        sendError(response, 409, 'enrich_run_conflict', 'An enrichment run or queued-job resolution is already in progress.');
        return true;
      }
      try {
        sendJson(response, 202, enrichRunner.start(body ?? {}));
      } catch (error) {
        sendError(response, 409, 'enrich_run_conflict', diagnostic(error));
      }
      return true;
    }

    // The stuck set for the retry affordance: photos at the content-failure
    // limit under the active run key. Read-only, database-only — no Immich.
    if (request.method === 'GET' && url.pathname === '/api/enrich/failure-limited') {
      const provider = String(url.searchParams.get('provider') || '').trim() || undefined;
      try {
        sendJson(response, 200, enrichRunner.failureLimitedSummary({ provider }));
      } catch (error) {
        sendError(response, 400, 'invalid_provider', diagnostic(error));
      }
      return true;
    }

    // The discarded reference list, capped so the two rendering surfaces
    // (Enrich popup, Settings) stay bounded; `total` reports the truth.
    const discardedListing = () => {
      const assets = repo.discardedAssets({ limit: 500 });
      const total = repo.discardedCount();
      return { assets, total, truncated: total > assets.length };
    };

    // The stuck strip's details popup exposes the current stuck set as
    // human-readable rows, plus the discarded list for the restore section.
    // It is read-only and database-only; Immich is not involved.
    if (request.method === 'GET' && url.pathname === '/api/enrich/failure-limited/details') {
      const provider = String(url.searchParams.get('provider') || '').trim() || undefined;
      try {
        sendJson(response, 200, {
          ...enrichRunner.failureLimitedDetails({ provider }),
          discarded: discardedListing(),
          // For the rows' "Open in Immich" links — same source as Curate's.
          immichUrl: config.immichPublicUrl || null,
        });
      } catch (error) {
        sendError(response, 400, 'invalid_provider', diagnostic(error));
      }
      return true;
    }

    // The reference list behind Settings → Discarded Photos.
    if (request.method === 'GET' && url.pathname === '/api/enrich/discarded') {
      sendJson(response, 200, {
        ...discardedListing(),
        immichUrl: config.immichPublicUrl || null,
      });
      return true;
    }

    // Discard: a local-only flag — enrichment stops trying these photos,
    // nothing is written to Immich. Restore is the mirror image. Two
    // shapes: `{ all: true, provider }` resolves the CURRENT stuck set on
    // the server (no client snapshot, no display-cap ceiling); an explicit
    // `assetIds` list is re-validated — photos that have since enriched
    // are refused and reported as `skippedSuccessful`.
    if (request.method === 'POST' && url.pathname === '/api/enrich/discarded') {
      const body = await readJsonBody(request);
      if (body?.all === true) {
        try {
          // Two unrelated truncations meet in this response: the
          // operation's 10,000-item cap and the reference listing's
          // 500-row display cap. Distinct keys — `discardTruncated` for
          // the operation ("run Discard all again for the rest"), while
          // top-level `truncated` stays the listing's, consistent with
          // the other discarded endpoints.
          const { truncated: discardTruncated, ...operation } = enrichRunner.discardFailureLimited({ provider: body?.provider });
          activityLog?.assetsDiscarded({
            count: operation.discarded,
            mode: 'all',
            skippedSuccessful: operation.skippedSuccessful,
            skippedNotStuck: operation.skippedNotStuck,
            truncated: discardTruncated,
          });
          sendJson(response, 200, { ...operation, discardTruncated, ...discardedListing() });
        } catch (error) {
          sendError(response, 400, 'invalid_provider', diagnostic(error));
        }
        return true;
      }
      let assetIds;
      try {
        assetIds = validateAssetBatch(body?.assetIds, { code: 'invalid_discard_request' });
      } catch (error) {
        if (!(error instanceof AssetBatchError)) throw error;
        sendError(response, error.status, error.code, `${error.message} Or use all: true.`);
        return true;
      }
      const operation = repo.discardAssets(assetIds);
      activityLog?.assetsDiscarded({
        count: operation.discarded,
        assetId: assetIds.length === 1 ? assetIds[0] : null,
        mode: 'selected',
        skippedSuccessful: operation.skippedSuccessful,
        skippedNotStuck: operation.skippedNotStuck,
      });
      sendJson(response, 200, {
        ...operation,
        ...discardedListing(),
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/enrich/discarded/restore') {
      const body = await readJsonBody(request);
      let assetIds;
      try {
        assetIds = validateAssetBatch(body?.assetIds, { code: 'invalid_restore_request' });
      } catch (error) {
        if (!(error instanceof AssetBatchError)) throw error;
        sendError(response, error.status, error.code, error.message);
        return true;
      }
      const restored = repo.restoreAssets(assetIds);
      activityLog?.assetsRestored({
        count: restored,
        assetId: assetIds.length === 1 ? assetIds[0] : null,
      });
      sendJson(response, 200, {
        restored,
        ...discardedListing(),
      });
      return true;
    }

    // "Send to Enrich" queue: slices wait here until run from the Enrich page.
    if (request.method === 'GET' && url.pathname === '/api/enrich/queue') {
      sendJson(response, 200, queuePagePayload(url.searchParams));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/enrich/queue') {
      const body = await readJsonBody(request);
      const filters = normalizeSliceFilters(body?.filters);
      if (!filters) {
        sendError(response, 400, 'invalid_slice', 'At least one slice filter is required.');
        return true;
      }
      for (const key of ['personIds', 'tagIds', 'cities']) {
        if (Array.isArray(filters[key])) {
          filters[key] = [...new Set(filters[key])].sort();
        }
      }
      try {
        const result = repo.queueAdd({
          title: String(body.title || 'Photo slice').slice(0, 120),
          filters,
          estimatedCount: Number(body.estimatedCount),
          protectedIds: protectedQueueIds(),
        });
        sendJson(response, result.duplicate ? 200 : 201, {
          id: result.id,
          duplicate: result.duplicate,
          ...queuePagePayload(),
        });
      } catch (error) {
        if (error?.code === 'enrich_queue_full' || error?.code === 'enrich_queue_item_too_large') {
          sendError(response, error.status, error.code, diagnostic(error));
          return true;
        }
        throw error;
      }
      return true;
    }

    const queueRunMatch = url.pathname.match(/^\/api\/enrich\/queue\/(\d+)\/run$/);
    if (request.method === 'POST' && queueRunMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      if (!config.enrichEnabled) {
        sendError(response, 403, 'enrichment_disabled', 'Enrichment is turned off — enable it in Settings → Enrich.');
        return true;
      }
      maintainQueue();
      const item = repo.queueGet(Number(queueRunMatch[1]));
      if (!item) {
        sendError(response, 404, 'queue_item_not_found', 'That queued job no longer exists.');
        return true;
      }
      const body = await readJsonBody(request);
      // No await between this check and startQueuedItem (which increments
      // synchronously): one run or resolution at a time, for every client.
      if (queueBusy()) {
        sendError(response, 409, 'enrich_run_conflict', 'An enrichment run or queued-job resolution is already in progress.');
        return true;
      }
      try {
        const { status, truncated } = await startQueuedItem(item, {
          provider: body?.provider,
          sendToCurate: body?.sendToCurate,
          reopenDecided: body?.reopenDecided,
          skipAnySuccessful: body?.skipAnySuccessful,
        });
        sendJson(response, 202, { ...status, queuedRemaining: truncated, ...queuePagePayload() });
      } catch (error) {
        if (error?.code === 'fully_covered') {
          // Not an error to the user: the item found nothing left to do
          // and removed itself.
          sendJson(response, 200, {
            fullyCovered: true,
            message: diagnostic(error),
            covered: error.covered ?? 0,
            failureLimited: error.failureLimited ?? 0,
            discarded: error.discarded ?? 0,
            ...queuePagePayload(),
          });
        } else if (error?.code === 'empty_slice') {
          sendError(response, 400, 'empty_slice', diagnostic(error));
        } else if (error?.code === 'queue_item_removed') {
          sendError(response, 409, 'queue_item_removed', diagnostic(error));
        } else {
          sendError(response, 409, 'enrich_run_conflict', diagnostic(error));
        }
      }
      return true;
    }

    // "Run all": chain the queued items one after another, honoring each
    // item's checkbox states as the UI captured them (the plan). The chain
    // advances only on clean finishes — a failure or cancel stops it with
    // the remaining queue intact, ready to Run all again.
    if (request.method === 'POST' && url.pathname === '/api/enrich/queue/run-all') {
      if (!requireImmich(response)) {
        return true;
      }
      if (!config.enrichEnabled) {
        sendError(response, 403, 'enrichment_disabled', 'Enrichment is turned off — enable it in Settings → Enrich.');
        return true;
      }
      const body = await readJsonBody(request);
      maintainQueue();
      if (!Array.isArray(body?.plan) || body.plan.length === 0) {
        sendError(response, 400, 'empty_plan', 'Nothing to run.');
        return true;
      }
      if (body.plan.length > ENRICH_QUEUE_MAX_ITEMS_GLOBAL) {
        sendError(response, 400, 'invalid_plan', `Run all accepts at most ${ENRICH_QUEUE_MAX_ITEMS_GLOBAL} queued items.`);
        return true;
      }
      const seenPlanIds = new Set();
      const plan = [];
      for (const entry of body.plan) {
        const id = Number(entry?.id);
        if (!Number.isSafeInteger(id) || id <= 0 || seenPlanIds.has(id)) {
          sendError(response, 400, 'invalid_plan', 'Every Run all entry must name one distinct queued item.');
          return true;
        }
        seenPlanIds.add(id);
        plan.push({
          id,
          sendToCurate: entry?.sendToCurate !== false,
          reopenDecided: entry?.reopenDecided === true,
        });
      }
      // No await between this check and startFromPlan → startQueuedItem
      // (which increments synchronously): chains can't interleave with a
      // run or another resolution.
      if (queueBusy()) {
        sendError(response, 409, 'enrich_run_conflict', 'An enrichment run or queued-job resolution is already in progress.');
        return true;
      }
      const provider = body?.provider;
      // Items removed as covered during the synchronous walk, with their
      // photo counts aggregated so the response stays honest about photos
      // stuck at the failure limit (mid-chain removals after the response
      // surface through the queue list and run history instead).
      let coveredRemoved = 0;
      let coveredCount = 0;
      let failureLimitedCount = 0;
      let discardedCount = 0;
      // A chain that dies between items — after the response — must not
      // die silently: record the stop in run history, where outcomes live.
      const recordChainStop = (error) => {
        runAllPlanIds.clear();
        try {
          const message = diagnostic(error);
          const now = new Date().toISOString();
          repo.recordJobRun({
            title: 'Run all',
            provider: String(provider || config.defaultProvider || ''),
            model: null,
            promptVersion: null,
            taxonomyVersion: null,
            inferenceHostLabel: config.inferenceHostLabel,
            targeted: null,
            status: 'failed',
            error: message,
            counters: null,
            log: [`run-all chain stopped: ${message}`],
            startedAt: now,
            finishedAt: now,
          });
        } catch { /* history is best-effort here */ }
      };
      const startFromPlan = async (index) => {
        for (let i = index; i < plan.length; i += 1) {
          const entry = plan[i];
          const queued = repo.queueGet(entry.id);
          if (!queued) {
            runAllPlanIds.delete(entry.id);
            continue; // removed (or finished) since the plan was captured
          }
          try {
            const started = await startQueuedItem(queued, {
              provider,
              sendToCurate: entry.sendToCurate,
              reopenDecided: entry.reopenDecided,
              chainNext: () => {
                runAllPlanIds.delete(entry.id);
                void startFromPlan(i + 1).catch(recordChainStop);
              },
            });
            return { started, index: i };
          } catch (error) {
            if (error?.code === 'fully_covered') {
              runAllPlanIds.delete(entry.id);
              coveredRemoved += 1;
              coveredCount += error.covered ?? 0;
              failureLimitedCount += error.failureLimited ?? 0;
              discardedCount += error.discarded ?? 0;
              continue; // the item removed itself — move on
            }
            if (error?.code === 'empty_slice' || error?.code === 'queue_item_removed') {
              runAllPlanIds.delete(entry.id);
              continue; // nothing left in this slice, or the user pulled it — move on
            }
            throw error; // a run conflict stops the chain
          }
        }
        runAllPlanIds.clear();
        return null;
      };
      try {
        runAllPlanIds.clear();
        for (const entry of plan) runAllPlanIds.add(entry.id);
        const outcome = await startFromPlan(0);
        if (!outcome) {
          if (coveredRemoved > 0) {
            // The whole plan had nothing to analyze — items removed, no run.
            sendJson(response, 200, {
              planned: 0,
              selected: plan.length,
              coveredRemoved,
              covered: coveredCount,
              failureLimited: failureLimitedCount,
              discarded: discardedCount,
              ...queuePagePayload(),
            });
            return true;
          }
          sendError(response, 400, 'nothing_started', 'No queued item had photos to run.');
          return true;
        }
        // planned = jobs the chain will actually attempt (the started one
        // plus later plan entries still in the queue), not the raw
        // selection size — removed/vanished items don't inflate it.
        const planned = 1 + plan.slice(outcome.index + 1).filter((entry) => repo.queueGet(entry.id)).length;
        sendJson(response, 202, {
          ...outcome.started.status,
          planned,
          selected: plan.length,
          coveredRemoved,
          covered: coveredCount,
          failureLimited: failureLimitedCount,
          discarded: discardedCount,
          ...queuePagePayload(),
        });
      } catch (error) {
        if (!enrichRunner.isRunning() && sliceResolutions === 0) runAllPlanIds.clear();
        sendError(response, 409, 'enrich_run_conflict', diagnostic(error));
      }
      return true;
    }

    const queueDeleteMatch = url.pathname.match(/^\/api\/enrich\/queue\/(\d+)$/);
    if (request.method === 'DELETE' && queueDeleteMatch) {
      const queueItemId = Number(queueDeleteMatch[1]);
      maintainQueue();
      // The item behind the active run is load-bearing: a capped, failed,
      // or cancelled run needs it to continue later, so it can't be pulled
      // out from under the run — cancel first. (Removing an item whose
      // slice is merely being resolved stays allowed: resolveAndStart
      // re-checks and honors the removal.)
      if (enrichRunner.isRunning() && enrichRunner.status()?.options?.queueItemId === queueItemId) {
        sendError(response, 409, 'queue_item_running', 'That job is running — cancel the run first.');
        return true;
      }
      sendJson(response, 200, { removed: repo.queueRemove(queueItemId), ...queuePagePayload() });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/enrich/runs') {
      const page = repo.jobRunsPage({
        beforeId: decodeRunCursor(url.searchParams.get('cursor')),
        limit: runPageLimit(url.searchParams.get('limit')),
      });
      sendJson(response, 200, {
        runs: page.runs,
        nextCursor: page.nextBeforeId === null ? null : encodeRunCursor(page.nextBeforeId),
        total: page.total,
      });
      return true;
    }

    const runRetryMatch = url.pathname.match(/^\/api\/enrich\/runs\/(\d+)\/retry$/);
    if (request.method === 'POST' && runRetryMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      if (!config.enrichEnabled) {
        sendError(response, 403, 'enrichment_disabled', 'Enrichment is turned off — enable it in Settings → Enrich.');
        return true;
      }
      const body = await readJsonBody(request);
      if (queueBusy()) {
        sendError(response, 409, 'enrich_run_conflict', 'An enrichment run or queued-job resolution is already in progress.');
        return true;
      }
      const failures = repo.jobRunRetryFailures(Number(runRetryMatch[1]));
      if (!failures) {
        sendError(response, 404, 'run_not_found', 'That run is no longer in the history.');
        return true;
      }
      // Re-evaluated at click time: a stale history card cannot re-run a
      // photo that has since succeeded, disappeared, or been discarded.
      if (failures.count === 0) {
        sendJson(response, 200, { started: false, retryableFailures: 0 });
        return true;
      }
      try {
        const status = enrichRunner.start({
          provider: failures.provider,
          assetIds: failures.assetIds,
          skipAnySuccessful: true,
          retryFailureLimited: true,
          retrySourceRunId: failures.runId,
          title: `Retry failures · ${failures.title}`,
          sendToCurate: body?.sendToCurate !== false,
        });
        sendJson(response, 202, {
          ...status,
          retryableFailures: failures.count,
          retryTargeted: failures.assetIds.length,
          retryTruncated: failures.truncated,
        });
      } catch (error) {
        sendError(response, 409, 'enrich_run_conflict', diagnostic(error));
      }
      return true;
    }

    const runLogMatch = url.pathname.match(/^\/api\/enrich\/runs\/(\d+)\/log$/);
    if (request.method === 'GET' && runLogMatch) {
      const entry = repo.getJobRunLog(Number(runLogMatch[1]));
      if (!entry) {
        sendError(response, 404, 'run_not_found', 'That run is no longer in the history.');
        return true;
      }
      sendJson(response, 200, entry);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/enrich/cancel') {
      sendJson(response, 200, { cancelled: enrichRunner.cancel() });
      return true;
    }

    // Caption search over the local enrichment index (idea albums / word
    // cloud foundations). Pure local reads; works with enrichment off.
    if (request.method === 'GET' && url.pathname === '/api/enrich/captions/search') {
      const query = url.searchParams.get('q') ?? '';
      if (!query.trim()) {
        sendError(response, 400, 'empty_query', 'Provide a search query (?q=…).');
        return true;
      }
      const results = repo.searchCaptions(query, { limit: url.searchParams.get('limit') ?? 100 });
      sendJson(response, 200, { query, total: results.length, results });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/enrich/captions/terms') {
      sendJson(response, 200, { terms: repo.captionTerms({ limit: url.searchParams.get('limit') ?? 150 }) });
      return true;
    }

    // Caption → Immich description writeback (opt-in; see Settings).
    if (request.method === 'GET' && url.pathname === '/api/enrich/captions/writeback') {
      sendJson(response, 200, captionWriteback.status());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/enrich/captions/writeback/backfill') {
      if (!config.captionWriteback) {
        sendError(response, 409, 'writeback_disabled', 'Turn on "Write captions to Immich descriptions" in Settings first.');
        return true;
      }
      if (!requireImmich(response)) {
        return true;
      }
      const queued = captionWriteback.backfill();
      sendJson(response, 202, { queued, ...captionWriteback.status() });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/taxonomy') {
      sendJson(response, 200, {
        version: taxonomy.version,
        buckets: reviewConfig(taxonomy).buckets.map(({ id, label, description }) => ({ id, label, description })),
        thresholds: taxonomy.thresholds,
        categories: Object.fromEntries(
          Object.entries(taxonomy.tagsByCategory).map(([category, tags]) => [category, tags.length]),
        ),
        tags: taxonomy.tagsByCategory,
        hardExclusionTags: [...taxonomy.hardExclusionTags].sort(),
        // The full source document, for the Settings taxonomy editor.
        raw: taxonomy.raw,
        // The response contract: fields every reply must contain (enforced
        // via structured output), with what each one feeds.
        responseFields: describeResponseFields(),
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/enrich/caption') {
      const assetId = url.searchParams.get('assetId') ?? '';
      if (!assetId) {
        sendError(response, 400, 'missing_asset_id', 'assetId is required');
        return true;
      }
      // Full captions stay out of the review-rows payload (scale envelope);
      // the Curate lightbox fetches them one asset at a time, with the
      // enriching provider/model for its attribution note.
      const enrichment = repo.latestEnrichment(assetId);
      sendJson(response, 200, enrichment ?? { caption: null, provider: null, model: null });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/enrich/prompts') {
      // Read from disk on each request so edits to the prompt files show up
      // without a restart. Settings overrides win when set.
      const builtin = loadPrompts(config.promptsDir, config.promptVersion);
      const overrides = config.promptOverrides ?? {};
      sendJson(response, 200, {
        version: overrides.systemPrompt || overrides.userTemplate
          ? `${config.promptVersion}-custom`
          : config.promptVersion,
        systemPrompt: overrides.systemPrompt || builtin.systemPrompt,
        userTemplate: overrides.userTemplate || builtin.userTemplate,
        customized: {
          systemPrompt: Boolean(overrides.systemPrompt),
          userTemplate: Boolean(overrides.userTemplate),
        },
        builtin,
      });
      return true;
    }

    return false;
  };
}

function parseSyncJobId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,18})$/.test(value) || value === '-0') {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) return undefined;
    return parsed >= BigInt(Number.MIN_SAFE_INTEGER) && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  } catch {
    return undefined;
  }
}
