import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OutputValidationError, enrichmentJsonSchema, validateAiOutput } from './schema.mjs';
import { approvedModelTags } from './taxonomy.mjs';
import { mapOutputToTags } from './mapTags.mjs';
import { ImmichApiError, tagId, tagValue } from '../immich.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';
import { createTraversalBudget } from '../pagination.mjs';

// Batch enrichment orchestration: fetch assets from Immich, classify each
// image with a vision provider, validate against the taxonomy, and persist
// runs and tag decisions locally. Immich tag writes are opt-in (applyTags).

export function loadPrompts(promptsDir, promptVersion = 'v1') {
  return {
    systemPrompt: readFileSync(join(promptsDir, `${promptVersion}_system.txt`), 'utf8'),
    userTemplate: readFileSync(join(promptsDir, `${promptVersion}_user_template.txt`), 'utf8'),
  };
}

export function buildUserPrompt(userTemplate, taxonomy) {
  return userTemplate.replaceAll('{approved_tags}', approvedModelTags(taxonomy).join('\n'));
}

// maxBytes tightens the download cap for original-class fetches only (the
// referee's per-image ceiling); thumbnails and previews are small and keep
// the Immich client's default.
export async function fetchImage(immich, assetId, imageSource, { maxBytes = null } = {}) {
  if (imageSource === 'original') {
    return immich.getAssetOriginal(assetId, maxBytes === null ? undefined : { maxBytes });
  }
  const size = imageSource === 'thumbnail' ? 'thumbnail' : 'preview';
  // maxBytes applies to every source: a preview can be config-dependently
  // large in Immich, and budgeted callers (the referee's group ceiling)
  // need the download to abort rather than buffer past their cap.
  return immich.getAssetThumbnail(assetId, size, maxBytes === null ? undefined : { maxBytes });
}

// Abort a run when this many photos fail before anything succeeds — that
// pattern means the provider is down (e.g. LM Studio's server not started),
// not that the photos are hard.
const PROVIDER_DOWN_FAILURE_LIMIT = 8;
const MAX_ENRICH_TRAVERSAL_WINDOWS = 1_000;
const MAX_ENRICH_TRAVERSAL_ITEMS = 100_000;
const ENRICH_TRAVERSAL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TARGETED_ASSETS = 10_000;

// Environment failures (provider outage, Immich downtime) record as
// 'failed_infra', which never counts toward an asset's permanent failure
// allowance — only failures the provider pinned on this request's content do.
// Rerunning a job after an outage therefore retries every affected asset.
function isInfrastructureFailure(error) {
  if (error?.name === 'ProviderRequestError') {
    return error.infrastructure === true;
  }
  if (error?.name === 'ImmichApiError') {
    // A 4xx from Immich is about this asset (deleted, bad id); a network
    // failure (status null) or 5xx is Immich's problem.
    return error.status === null || error.status === 429 || error.status >= 500;
  }
  return false;
}

const LOCAL_RETRY_SUFFIX =
  '\n\nLocal retry instructions: return only the strongest, clearly visible tags. ' +
  'Use no more than 20 candidate_tags and no more than 6 exclusion_reasons. ' +
  'Do not include weak, speculative, duplicate, or near-duplicate tags. ' +
  'Keep each reason short. Return only caption text in caption and short_caption: ' +
  'do not prefix either value with "Full caption:" or "Short caption:", and do not use caption placeholder text.';

export async function analyzeWithValidationRetry(provider, image, { systemPrompt, userPrompt, jsonSchema, taxonomy, log = () => {} }) {
  const prompts = [userPrompt];
  // Every local provider (local_*), plus generic endpoints that explicitly
  // opt in, earns one retry with stricter instructions before a validation
  // failure is recorded. The generic endpoint may be remote, but its primary
  // use is small operator-hosted servers such as llama.cpp.
  if (provider.providerName?.startsWith('local_') || provider.retryValidationOnce === true) {
    prompts.push(`${userPrompt}${LOCAL_RETRY_SUFFIX}`);
  }

  let lastError = null;
  for (let attemptIndex = 0; attemptIndex < prompts.length; attemptIndex += 1) {
    try {
      const result = await provider.analyzeImage(image, {
        systemPrompt,
        userPrompt: prompts[attemptIndex],
        jsonSchema,
      });
      const normalized = validateAiOutput(result.normalizedOutput, taxonomy);
      const decisions = mapOutputToTags(normalized, taxonomy);
      return { result, normalized, decisions, retryCount: attemptIndex };
    } catch (error) {
      if (!(error instanceof OutputValidationError)) {
        throw error;
      }
      lastError = error;
      if (attemptIndex + 1 < prompts.length) {
        log(`retrying with stricter local prompt after validation failure: ${error.message}`);
      }
    }
  }
  throw lastError ?? new Error('model analysis did not run');
}

export async function runBatch({
  immich,
  repo,
  provider,
  taxonomy,
  systemPrompt,
  userTemplate,
  limit = 5,
  offset = 0,
  assetIds = null,
  skipAi = false,
  reprocess = false,
  skipAnySuccessful = false,
  maxAnalyzed = null,
  maxFailuresPerAsset = 2,
  retryFailureLimited = false,
  imageSource = 'preview',
  promptVersion = 'v1',
  applyTags = false,
  dryRun = true,
  listForReview = false,
  captionWriteback = false,
  shouldStop = () => false,
  log = () => {},
  now = Date.now,
}) {
  const diagnosticSecrets = configuredSecrets(immich, provider);
  if (maxAnalyzed !== null && maxAnalyzed < 1) {
    throw new Error('maxAnalyzed must be greater than 0');
  }
  if (offset < 0) {
    throw new Error('offset must be 0 or greater');
  }
  if (reprocess && skipAnySuccessful) {
    throw new Error('reprocess and skipAnySuccessful cannot be used together');
  }
  if (maxFailuresPerAsset < 0) {
    throw new Error('maxFailuresPerAsset must be 0 or greater');
  }

  if (assetIds) {
    assetIds = dedupeAssetIds(assetIds);
    if (assetIds.length > MAX_TARGETED_ASSETS) {
      throw new Error(`assetIds must contain ${MAX_TARGETED_ASSETS} or fewer unique entries`);
    }
  }

  // Only Immich traversal time belongs to this deadline. Provider inference
  // can legitimately take minutes per photo and must not make the next
  // otherwise-healthy metadata window look like a stalled traversal.
  let traversalFetchElapsedMs = 0;
  const traversal = createTraversalBudget({
    label: 'Immich enrichment scan',
    maxPages: assetIds ? Math.ceil(Math.max(1, assetIds.length) / 8) : MAX_ENRICH_TRAVERSAL_WINDOWS,
    maxItems: assetIds ? MAX_TARGETED_ASSETS : MAX_ENRICH_TRAVERSAL_ITEMS,
    timeoutMs: ENRICH_TRAVERSAL_TIMEOUT_MS,
    now: () => traversalFetchElapsedMs,
  });
  const chargeImmichFetch = async (work) => {
    const startedAt = now();
    try {
      return await work();
    } finally {
      traversalFetchElapsedMs += Math.max(0, now() - startedAt);
    }
  };
  const seenAssetIds = new Set();

  const fetchWindow = async (windowOffset) => {
    let fetched;
    if (assetIds) {
      const targeted = await fetchAssetsChunked(immich, assetIds, {
        shouldStop,
        traversal,
        chargeImmichFetch,
      });
      fetched = targeted.assets;
      log(
        `fetched ${fetched.length} image assets (targeted)`
        + (targeted.missingIds.length > 0 ? `; skipped ${targeted.missingIds.length} no longer in Immich` : ''),
      );
      // Stamp the confirmed-gone ids so their old failure rows stop feeding
      // the retry strip; upsertAsset un-stamps any photo that reappears.
      repo.markAssetsMissing(targeted.missingIds);
    } else {
      if (shouldStop()) return { assets: [], fetchedCount: 0, stopped: true };
      traversal.beginPage();
      fetched = await chargeImmichFetch(
        () => immich.listImageAssets({ limit, offset: windowOffset, shouldStop }),
      );
      traversal.recordItems(fetched.length);
      log(`fetched ${fetched.length} image assets starting at offset ${windowOffset}`);
    }
    const uniqueAssets = fetched.filter((asset) => {
      if (seenAssetIds.has(asset.id)) return false;
      seenAssetIds.add(asset.id);
      return true;
    });
    for (const asset of uniqueAssets) {
      repo.upsertAsset(asset);
    }
    return { assets: uniqueAssets, fetchedCount: fetched.length, stopped: shouldStop() };
  };

  let windowOffset = offset;
  let window = await fetchWindow(windowOffset);
  let assets = window.assets;

  if (skipAi) {
    log('skipped AI analysis; persisted asset rows only');
    return { counters: emptyCounters(), assetDecisions: {}, listedForReview: 0 };
  }

  const userPrompt = buildUserPrompt(userTemplate, taxonomy);
  const jsonSchema = enrichmentJsonSchema(taxonomy);
  const runKey = {
    provider: provider.providerName,
    model: provider.modelName,
    promptVersion,
    taxonomyVersion: taxonomy.version,
  };

  const assetDecisions = {};
  const counters = emptyCounters();
  let analyzed = 0;
  let scanned = 0;
  let stopped = false;
  let listedForReview = 0;
  let infraFailed = 0;

  while (true) {
    const scanTotal = scanned + assets.length;
    for (const [index, asset] of assets.entries()) {
      if (shouldStop()) {
        log('stopping early: cancellation requested');
        stopped = true;
        break;
      }
      const assetId = asset.id;
      const position = `[${scanned + index + 1}/${scanTotal}]`;

      if (skipAnySuccessful && repo.hasAnySuccessfulRun(assetId)) {
        counters.skippedSuccessful += 1;
        // Already enriched, so it belongs in Curate just like a fresh success.
        if (listForReview) listedForReview += repo.reviewListAdd([assetId], 'enrich');
        log(`${position} skipping ${assetId}; successful run already exists`);
        continue;
      }
      if (!reprocess && repo.hasSuccessfulRun({ assetId, ...runKey })) {
        counters.skippedSuccessful += 1;
        if (listForReview) listedForReview += repo.reviewListAdd([assetId], 'enrich');
        log(`${position} skipping ${assetId}; matching successful run already exists`);
        continue;
      }
      // A human discard is unconditional — it holds even for retry runs
      // and reprocessing; Restore is the one door back in.
      if (repo.isAssetDiscarded(assetId)) {
        counters.skippedDiscarded += 1;
        log(`${position} skipping ${assetId}; discarded from enrichment`);
        continue;
      }
      if (
        !reprocess &&
        maxFailuresPerAsset > 0 &&
        repo.failureCount({ assetId, ...runKey }) >= maxFailuresPerAsset
      ) {
        counters.skippedFailureLimit += 1;
        log(`${position} skipping ${assetId}; reached ${maxFailuresPerAsset} failed run(s)`);
        continue;
      }
      if (maxAnalyzed !== null && analyzed >= maxAnalyzed) {
        log(`stopped after ${analyzed} analyzed asset(s)`);
        stopped = true;
        break;
      }

      analyzed += 1;
      counters.analyzed += 1;
      log(`${position} analyzing ${assetId}`);
      try {
        let image;
        try {
          image = await fetchImage(immich, assetId, imageSource);
        } catch (fetchError) {
          // An original past the download cap is still enrichable — degrade
          // to the preview (same fallback the referee uses) instead of
          // burning the asset's failure allowance on its file size.
          if (fetchError?.name === 'ResponseTooLargeError' && imageSource === 'original') {
            log(`${position} original for ${assetId} exceeds the download cap; using preview`);
            image = await fetchImage(immich, assetId, 'preview');
          } else {
            throw fetchError;
          }
        }
        const { normalized, decisions, retryCount } = await analyzeWithValidationRetry(
          provider,
          { data: image.data, mimeType: image.contentType, assetId },
          { systemPrompt, userPrompt, jsonSchema, taxonomy, log },
        );
        // One transaction: a run may never read as 'succeeded' without its
        // tags, caption index, review listing, and caption-writeback marker.
        // A failure at any write rolls the whole asset back to unprocessed.
        listedForReview += repo.transaction(() => {
          repo.recordProcessingRun({
            assetId,
            ...runKey,
            status: 'succeeded',
            normalizedOutput: normalized,
          });
          repo.replaceAssetTags({
            assetId,
            decisions,
            model: provider.modelName,
            taxonomyVersion: taxonomy.version,
          });
          let listed = 0;
          if (listForReview) {
            // "Send to Curate" on: each photo joins the review queue as it
            // finishes, so Curate fills while a long run is still going. Only
            // enriched photos are ever listed — failures stay with the queue
            // item and re-enter when a later run enriches them.
            listed = repo.reviewListAdd([assetId], 'enrich');
          }
          if (captionWriteback && typeof normalized.caption === 'string' && normalized.caption.trim()) {
            repo.captionWritebackEnqueue([assetId]);
          }
          return listed;
        });
        assetDecisions[assetId] = decisions;
        counters.succeeded += 1;
        counters.retried += retryCount;
        log(`  tags: ${decisions.map((decision) => decision.tag).join(', ') || '(none)'}`);
        log(`  caption: ${typeof normalized.caption === 'string' && normalized.caption ? normalized.caption : '(none)'}`);
      } catch (error) {
        const infrastructure = isInfrastructureFailure(error);
        const diagnostic = sanitizeDiagnostic(error instanceof Error ? error.message : error, {
          secrets: diagnosticSecrets,
        });
        repo.recordProcessingRun({
          assetId,
          ...runKey,
          status: infrastructure ? 'failed_infra' : 'failed',
          error: diagnostic,
        });
        counters.failed += 1;
        if (infrastructure) {
          infraFailed += 1;
        }
        log(`  failed: ${diagnostic}`);
        // Every photo failing from the start means the provider is down or
        // misconfigured, not that the photos are hard — stop before burning
        // a per-asset failure strike on the whole slice. A retry batch is
        // known-hard photos, so content failures are the expected outcome
        // there: in retry mode only infrastructure failures (unreachable,
        // 5xx) count toward the abort, keeping dead-provider protection
        // without tripping on the photos being themselves.
        const abortFailures = retryFailureLimited ? infraFailed : counters.failed;
        if (counters.succeeded === 0 && abortFailures >= PROVIDER_DOWN_FAILURE_LIMIT) {
          throw new Error(
            `the first ${counters.failed} photos all failed — the provider looks unreachable or misconfigured `
            + `(last error: ${diagnostic}). `
            + 'Nothing succeeded, so the job can simply be run again once the provider is back.',
          );
        }
      }
    }
    scanned += assets.length;

    // A window is only a page of the scan, not the unit of work: while an
    // analysis budget remains unfilled, keep fetching the next window. Without
    // a budget (or with targeted assetIds), one window is the whole request.
    if (stopped || window.stopped || assetIds || maxAnalyzed === null || analyzed >= maxAnalyzed) {
      break;
    }
    if (window.fetchedCount < limit) {
      log(`no more assets to scan; analyzed ${analyzed} of ${maxAnalyzed} requested`);
      break;
    }
    windowOffset += window.fetchedCount;
    window = await fetchWindow(windowOffset);
    assets = window.assets;
    if (window.fetchedCount === 0) {
      log(`no more assets to scan; analyzed ${analyzed} of ${maxAnalyzed} requested`);
      break;
    }
  }

  if (applyTags && !dryRun) {
    await syncTagDecisions(immich, assetDecisions);
    log('applied mapped tags to Immich');
  } else {
    log('dry run complete; no Immich tags were written');
  }

  return { counters, assetDecisions, listedForReview };
}

export async function syncTagDecisions(immich, assetDecisions) {
  const allTags = [...new Set(Object.values(assetDecisions).flat().map((decision) => decision.tag))].sort();
  if (allTags.length === 0) {
    return;
  }
  const tagIds = await ensureImmichTagIds(immich, allTags);
  for (const [assetId, decisions] of Object.entries(assetDecisions)) {
    const ids = decisions.map((decision) => tagIds[decision.tag]).filter(Boolean);
    if (ids.length > 0) {
      await immich.tagAssetsBulk({ assetIds: [assetId], tagIds: ids });
    }
  }
}

export async function ensureImmichTagIds(immich, tags) {
  const existing = tagMap(await immich.listTags());
  const missing = tags.filter((tag) => !(tag in existing));
  if (missing.length > 0) {
    Object.assign(existing, tagMap(await immich.upsertTags(missing)));
  }
  for (const tag of tags.filter((candidate) => !(candidate in existing))) {
    const created = await immich.createTag(tag);
    const value = tagValue(created);
    const identifier = tagId(created);
    if (value && identifier) {
      existing[value] = identifier;
    }
  }
  const unresolved = tags.filter((tag) => !(tag in existing));
  if (unresolved.length > 0) {
    throw new Error(`Unable to resolve Immich tag IDs for: ${JSON.stringify(unresolved)}`);
  }
  return Object.fromEntries(tags.map((tag) => [tag, existing[tag]]));
}

function tagMap(tagResponses) {
  const mapping = {};
  for (const response of tagResponses) {
    const value = tagValue(response);
    const identifier = tagId(response);
    if (value && identifier) {
      mapping[value] = identifier;
    }
  }
  return mapping;
}

// Targeted runs can carry ~1000 ids; fetch metadata with bounded concurrency
// instead of one burst of parallel requests against Immich. Targeted ids can
// be stale — a slice or failure history captured a photo since deleted from
// Immich — so a missing asset is skipped and counted, never allowed to
// reject the whole batch before any analysis starts.
async function fetchAssetsChunked(
  immich,
  assetIds,
  {
    concurrency = 8,
    shouldStop = () => false,
    traversal,
    chargeImmichFetch = async (work) => work(),
  } = {},
) {
  const fetched = [];
  const missingIds = [];
  for (let start = 0; start < assetIds.length; start += concurrency) {
    if (shouldStop()) break;
    const chunk = assetIds.slice(start, start + concurrency);
    traversal?.beginPage();
    const results = await chargeImmichFetch(
      () => Promise.all(chunk.map(async (assetId) => {
        try {
          return { assetId, asset: await immich.getAsset(assetId) };
        } catch (error) {
          if (
            error instanceof ImmichApiError &&
            (error.status === 404 || (error.status === 400 && /not found|invalid/i.test(error.message)))
          ) {
            return { assetId, asset: null };
          }
          throw error;
        }
      })),
    );
    traversal?.recordItems(chunk.length);
    for (const result of results) {
      if (result.asset) {
        fetched.push(result.asset);
      } else {
        missingIds.push(result.assetId);
      }
    }
  }
  return { assets: fetched, missingIds };
}

function dedupeAssetIds(values) {
  const seen = new Set();
  const ids = [];
  for (const value of values) {
    const id = String(value ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function emptyCounters() {
  return {
    analyzed: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    skippedSuccessful: 0,
    skippedFailureLimit: 0,
    skippedDiscarded: 0,
  };
}
