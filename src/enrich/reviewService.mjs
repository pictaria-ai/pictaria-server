import { createHash } from 'node:crypto';
import { deriveReview, bucketSortComparator, reviewConfig } from './reviewBuckets.mjs';
import { ensureImmichTagIds } from './runner.mjs';
import { tagId, tagValue } from '../immich.mjs';
import { awaitDrain } from '../lifecycle.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';
import { AssetBatchError, validateAssetBatch } from './assetBatch.mjs';
import { ACTION_RULES } from './reviewActions.mjs';

// Review workflow: serve the three-bucket queue, record human decisions
// locally (source of truth), and push tag changes to Immich from a durable
// background worker. Immich tag mutations cost ~0.4s per asset server-side,
// so decisions never wait on Immich.

export { ACTION_RULES } from './reviewActions.mjs';

const BURST_CHAIN_MS = 15000;
const BURST_NEAR_MS = 180000;
const SYNC_IDLE_POLL_MS = 5000;
const SYNC_BACKOFF_CAP_MS = 60000;
// After this many failed attempts a job is parked (dead-lettered) so one
// permanently-broken job — e.g. an asset deleted from Immich — cannot block
// every later decision. Parked jobs are listed, retryable, and dismissable.
const SYNC_MAX_ATTEMPTS = 10;
const REMOTE_FETCH_CONCURRENCY = 8;
const SYNC_ASSET_BATCH_SIZE = 50;

export class ReviewService {
  constructor({ repo, immich, taxonomy, config = null, log = () => {}, verifyDelayMs = 1500 }) {
    this.repo = repo;
    this.immich = immich;
    this.taxonomy = taxonomy;
    this.config = config;
    this.log = log;
    this.verifyDelayMs = verifyDelayMs;
    this._syncWake = null;
    this._syncLastCompletedAt = null;
    this._syncWorkerRunning = false;
    this._syncStopRequested = false;
    this._syncLoopDone = null;
    this._reviewRowsCache = null;
    this._reviewRowsGeneration = -1;
    this._reviewRowsTaxonomyRaw = null;
    this._annotatedRows = null;
  }

  // Assembled review rows, cached against the repository's write generation:
  // the Curate UI, the referee tick, and the status poll all call this, and
  // with no review-relevant write in between the answer cannot change.
  // Every caller gets the SAME array and row objects back. Burst annotation
  // happens once per cached array via annotatedReviewRows(), so consumers see
  // identical stacks; nobody annotates a subset.
  // The taxonomy key is the raw document reference: a Settings taxonomy swap
  // replaces `taxonomy.raw` in place on the shared taxonomy object.
  reviewRows() {
    const generation = this.repo.generation;
    if (
      this._reviewRowsCache !== null &&
      this._reviewRowsGeneration === generation &&
      this._reviewRowsTaxonomyRaw === this.taxonomy.raw
    ) {
      return this._reviewRowsCache;
    }
    const tagsByAsset = this.repo.reviewAssetTagRows();
    const rows = [];
    for (const row of this.repo.reviewListRows()) {
      const tagRows = tagsByAsset[row.asset_id] ?? [];
      const tags = new Set(tagRows.map((tagRow) => tagRow.tag));
      const enriched = row.latest_run_id != null;
      // The latest_success projection carries exactly what deriveReview
      // reads from a normalized output; thresholds apply here, at read time.
      const output = {
        short_caption: row.short_caption,
        quality: { frame_worthy_score: row.frame_score, aesthetic_score: row.aesthetic_score },
        needs_review: Boolean(row.needs_review),
        exclusion_reasons: row.exclusion_reasons_json ? JSON.parse(row.exclusion_reasons_json) : [],
      };
      const review = deriveReview(tags, this.taxonomy, { output });
      if (!enriched) {
        // Sent to Curate without enrichment: no AI signal, so there's no
        // basis for bucketing — every photo is simply a Candidate.
        review.bucket = 'candidates';
        review.reasons = ['not enriched'];
      }
      rows.push({
        assetId: row.asset_id,
        filename: (row.original_path ?? row.asset_id).split('/').pop(),
        originalPath: row.original_path,
        width: row.width,
        height: row.height,
        capturedAt: row.file_created_at,
        thumbhash: row.thumbhash ?? null,
        duplicateId: row.duplicate_id ?? null,
        finishedAt: row.finished_at,
        caption: typeof row.short_caption === 'string' ? row.short_caption : '',
        bucket: review.bucket,
        state: review.state,
        reasons: review.reasons,
        frameScore: review.frameScore,
        aestheticScore: review.aestheticScore,
        aiTags: [...tags].filter((tag) => tag.startsWith('ai/')).sort(),
        frameTags: [...tags].filter((tag) => tag.startsWith('frame/')).sort(),
        refereeRank: row.referee_rank === null || row.referee_rank === undefined ? null : Number(row.referee_rank),
        refereeKeep: Boolean(row.referee_keep),
        refereeEyesClosed: row.referee_eyes_closed ?? null,
        refereeNote: row.referee_note ?? null,
        refereeSubjectGroup:
          row.referee_subject_group === null || row.referee_subject_group === undefined
            ? null
            : Number(row.referee_subject_group),
      });
    }
    this._reviewRowsCache = rows;
    this._reviewRowsGeneration = generation;
    this._reviewRowsTaxonomyRaw = this.taxonomy.raw;
    return rows;
  }

  // Burst annotations over the FULL row set, computed once per cached array
  // and shared by the Curate grid and the referee's pendingGroups — stack
  // identity is the same everywhere by construction. Grouping a filtered
  // view instead used to chain photos that are not adjacent in the real
  // timeline (their in-between shots were decided or in another bucket),
  // minting stacks the referee could never see and letting human decisions
  // reshape stack identity mid-backlog. The cache key is the rows
  // array itself: reviewRows() returns a new array exactly when a
  // review-relevant write or taxonomy swap invalidates the old one.
  annotatedReviewRows() {
    const rows = this.reviewRows();
    if (this._annotatedRows !== rows) {
      annotateBursts(rows);
      this._annotatedRows = rows;
    }
    return rows;
  }

  assetsResponse(query) {
    // Annotated regardless of the display toggle (the referee shares the
    // annotation); the toggle governs what this response SHOWS, below.
    const rows = this.annotatedReviewRows();
    const grouping = this.config?.curateBurstGrouping !== false;
    const config = reviewConfig(this.taxonomy);
    const displayBuckets = [...config.buckets].sort((a, b) =>
      a.id === 'candidates' ? -1 : b.id === 'candidates' ? 1 : a.fallback ? -1 : b.fallback ? 1 : 0,
    );

    // A stack reviews as ONE unit in ONE place: all its undecided members
    // render in the highest-priority bucket any of them earned (Candidates
    // beats Should Review beats Unlikely — the displayBuckets order). One
    // frame-worthy shot lifts its whole moment into Candidates instead of
    // scattering the moment across tabs as un-comparable fragments. Decided
    // members never affect placement; with grouping off, every photo keeps its
    // own bucket.
    const hoistRank = new Map(displayBuckets.map((bucket, index) => [bucket.id, index]));
    const hoisted = new Map();
    if (grouping) {
      for (const row of rows) {
        if (!row.burstId || row.state !== 'undecided') continue;
        const best = hoisted.get(row.burstId);
        if (best === undefined || (hoistRank.get(row.bucket) ?? Infinity) < (hoistRank.get(best) ?? Infinity)) {
          hoisted.set(row.burstId, row.bucket);
        }
      }
    }
    const bucketOf = (row) => (row.burstId && hoisted.get(row.burstId)) || row.bucket;

    const counts = {};
    let decidedCount = 0;
    for (const row of rows) {
      if (row.state === 'undecided') {
        counts[bucketOf(row)] = (counts[bucketOf(row)] ?? 0) + 1;
      } else {
        decidedCount += 1;
      }
    }

    const view = first(query, 'view', 'candidates');
    const search = first(query, 'q', '').trim().toLowerCase();
    let filtered =
      view === 'decided'
        ? rows.filter((row) => row.state !== 'undecided')
        : rows.filter((row) => row.state === 'undecided' && bucketOf(row) === view);

    if (search) {
      filtered = filtered.filter(
        (row) =>
          (row.filename ?? '').toLowerCase().includes(search) ||
          (row.originalPath ?? '').toLowerCase().includes(search) ||
          (row.caption ?? '').toLowerCase().includes(search) ||
          row.aiTags.some((tag) => tag.toLowerCase().includes(search)) ||
          row.frameTags.some((tag) => tag.toLowerCase().includes(search)) ||
          row.state.toLowerCase() === search ||
          row.reasons.some((reason) => reason.toLowerCase().includes(search)),
      );
    }

    // Review-rhythm filter: work through stacks and singles as separate
    // passes. "Stacks" means a group with 2+ members in THIS view — a lone
    // remnant whose stack-mates are decided or in another bucket reviews
    // like a single (there is nothing on-screen to compare it against).
    const group = first(query, 'group', 'all');
    if (view !== 'decided' && (group === 'stacks' || group === 'singles')) {
      const visibleMembers = new Map();
      if (grouping) {
        for (const row of filtered) {
          if (row.burstId) visibleMembers.set(row.burstId, (visibleMembers.get(row.burstId) ?? 0) + 1);
        }
      }
      const inViewStack = (row) => Boolean(row.burstId) && (visibleMembers.get(row.burstId) ?? 0) >= 2;
      filtered = filtered.filter((row) => inViewStack(row) === (group === 'stacks'));
    }
    const bucketConfig = config.buckets.find((bucket) => bucket.id === view);
    if (view === 'decided') {
      filtered.sort((left, right) => String(right.finishedAt ?? '').localeCompare(String(left.finishedAt ?? '')));
    } else {
      filtered.sort(bucketSortComparator(bucketConfig ?? config.buckets.at(-1)));
      // Stacks render as one card, so a group must never straddle a page:
      // cluster members behind their best-ranked member, and let the page
      // run past the limit to finish the group it ends inside.
      if (grouping) filtered = clusterBursts(filtered);
    }

    const offset = Math.max(0, intFirst(query, 'offset', 0));
    const limit = Math.max(1, Math.min(intFirst(query, 'limit', 100), 400));
    let end = Math.min(offset + limit, filtered.length);
    while (
      grouping &&
      end < filtered.length &&
      filtered[end].burstId &&
      filtered[end].burstId === filtered[end - 1]?.burstId
    ) {
      end += 1;
    }
    return {
      view,
      buckets: displayBuckets.map((bucket) => ({
        id: bucket.id,
        label: bucket.label,
        description: bucket.description,
        count: counts[bucket.id] ?? 0,
      })),
      decidedCount,
      total: filtered.length,
      offset,
      limit,
      sync: this.syncStatus(),
      // With grouping toggled off the response serves a flat queue: the
      // shared rows keep their annotations (the referee still needs them),
      // so the page is served as copies with the burst fields dropped.
      assets: grouping
        ? filtered.slice(offset, end)
        : filtered.slice(offset, end).map(
            ({ burstId, burstSize, burstAssetIds, burstBestAssetId, burstPickSource, burstMemberStates, burstMemberFiles, ...rest }) => rest,
          ),
    };
  }

  applyDecision({ action, assetIds }) {
    if (!(action in ACTION_RULES)) {
      throw new AssetBatchError(`Unsupported action: ${action}`, { code: 'invalid_decision_request' });
    }
    const cleanIds = validateAssetBatch(assetIds, { code: 'invalid_decision_request' });
    const members = this.repo.reviewListMembership(cleanIds);
    if (members.size !== cleanIds.length) {
      throw new AssetBatchError('Every selected asset must still be in the current review set.', {
        code: 'review_assets_not_current',
        status: 409,
      });
    }
    const rule = ACTION_RULES[action];
    this.repo.recordDecision({ assetIds: cleanIds, addTags: rule.add, removeTags: rule.remove, action });
    this.wakeSyncWorker();
    return { ok: true, action, assetCount: cleanIds.length, sync: this.syncStatus() };
  }

  syncStatus() {
    const pending = this.repo.pendingSyncJobCount();
    const head = pending ? this.repo.nextSyncJob() : null;
    let lastError = null;
    if (head?.invalidReason) {
      lastError = head.invalidReason;
    } else if (head && head.attempts > 0 && head.lastError) {
      lastError = `${head.action} for ${head.assetIds.length} asset(s) failing (attempt ${head.attempts}, will keep retrying): ${head.lastError}`;
    }
    return { pending, dead: this.repo.deadSyncJobCount(), lastError, lastCompletedAt: this._syncLastCompletedAt };
  }

  deadSyncJobs() {
    return this.repo.deadSyncJobs();
  }

  retryDeadSyncJobs(jobId = null) {
    const requeued = this.repo.retryDeadSyncJobs(jobId);
    if (requeued > 0) {
      this.wakeSyncWorker();
    }
    return requeued;
  }

  dismissDeadSyncJob(jobId) {
    return this.repo.dismissDeadSyncJob(jobId);
  }

  async thumbnail(assetId) {
    return this.immich.getAssetThumbnail(assetId, 'preview');
  }

  wakeSyncWorker() {
    if (this._syncWake) {
      const wake = this._syncWake;
      this._syncWake = null;
      wake();
    }
  }

  startSyncWorker() {
    // A stopped worker must be restartable (settings toggles, tests) — a
    // stale stop request would make the fresh loop exit on entry.
    this._syncStopRequested = false;
    if (this._syncWorkerRunning) {
      return;
    }
    this._syncWorkerRunning = true;
    this._syncLoopDone = this.#syncWorkerLoop();
  }

  // Shutdown drain: signal the loop, wake an idle sleep, and resolve when the
  // in-flight push (if any) finishes — jobs are durable, so anything still
  // queued simply resumes on the next start. The wait is bounded so a stalled
  // Immich call can never hang shutdown; the server's force-exit timer stays
  // the backstop.
  async stopSyncWorker(timeoutMs = 3000) {
    this._syncStopRequested = true;
    this.wakeSyncWorker();
    if (!this._syncLoopDone) {
      return true;
    }
    // Returns false on give-up so the lifecycle registry can warn by name —
    // a stalled Immich push is exactly the laggard worth a breadcrumb.
    return awaitDrain(this._syncLoopDone, timeoutMs);
  }

  async #syncWorkerLoop() {
    for (;;) {
      if (this._syncStopRequested) {
        this._syncWorkerRunning = false;
        return;
      }
      let job;
      try {
        job = this.repo.nextSyncJob();
      } catch (error) {
        const message = sanitizeDiagnostic(error instanceof Error ? error.message : error, {
          secrets: configuredSecrets(this.config, this.immich),
        });
        this.log(`immich sync queue read failed; worker remains available and will retry: ${message}`);
        await this.#sleep(SYNC_BACKOFF_CAP_MS);
        continue;
      }
      if (job === null) {
        await this.#sleep(SYNC_IDLE_POLL_MS);
        continue;
      }
      if (job.invalidReason) {
        try {
          this.repo.deadLetterSyncJob(job.id, job.invalidReason);
          this.log(`immich sync parked malformed restored job ${job.id}: ${job.invalidReason}`);
        } catch (error) {
          const message = sanitizeDiagnostic(error instanceof Error ? error.message : error, {
            secrets: configuredSecrets(this.config, this.immich),
          });
          this.log(`immich sync could not park malformed restored job ${job.id}; worker will retry: ${message}`);
          await this.#sleep(SYNC_BACKOFF_CAP_MS);
        }
        continue;
      }
      try {
        const assetIds = job.assetIds.slice(0, SYNC_ASSET_BATCH_SIZE);
        await this.pushDecisionToImmich({ ...job, assetIds });
        this.repo.completeSyncJobSlice(job.id, assetIds.length);
        this._syncLastCompletedAt = new Date().toISOString();
      } catch (error) {
        const message = sanitizeDiagnostic(error instanceof Error ? error.message : error, {
          secrets: configuredSecrets(this.config, this.immich),
        });
        if (job.attempts + 1 >= SYNC_MAX_ATTEMPTS) {
          this.repo.deadLetterSyncJob(job.id, message);
          this.log(
            `immich sync dead-lettered after ${job.attempts + 1} attempts (${job.action}, ${job.assetIds.length} asset(s)): ${message}`,
          );
          continue; // the queue moves on — the parked job no longer blocks it
        }
        this.repo.recordSyncJobFailure(job.id, message);
        // Head-of-line blocking while retrying is intentional: jobs apply in
        // order. Only dead-lettering releases the head.
        const backoff = Math.min(SYNC_BACKOFF_CAP_MS, 2 ** Math.min(job.attempts + 1, 6) * 1000);
        this.log(`immich sync failed (attempt ${job.attempts + 1}), retrying in ${backoff / 1000}s: ${message}`);
        await this.#sleep(backoff);
      }
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      this._syncWake = resolve;
      const timer = setTimeout(() => {
        if (this._syncWake === resolve) {
          this._syncWake = null;
        }
        resolve();
      }, ms);
      timer.unref?.();
    });
  }

  async pushDecisionToImmich(job) {
    if (job.assetIds.length > SYNC_ASSET_BATCH_SIZE) {
      throw new Error(`Review sync work exceeded the ${SYNC_ASSET_BATCH_SIZE}-asset worker slice.`);
    }
    const existingTagIds = tagMap(await this.immich.listTags());
    const tagIds = { ...existingTagIds };
    if (job.add.length > 0) {
      Object.assign(tagIds, await ensureImmichTagIds(this.immich, job.add));
    }
    const assetIds = job.assetIds;
    for (const tag of job.remove) {
      const immichTagId = existingTagIds[tag];
      if (immichTagId) {
        await this.immich.untagAssets({ tagId: immichTagId, assetIds });
      }
    }
    // One mutation event, not one per tag: Immich's per-mutation background
    // jobs race each other and can drop tags applied in rapid succession.
    const addIds = job.add.map((tag) => tagIds[tag]).filter(Boolean);
    if (addIds.length > 0) {
      await this.immich.tagAssetsBulk({ assetIds, tagIds: addIds });
    }
    await this.syncAiTagsForAssets(assetIds, tagIds);
    await this.verifyAndRepairTags(job);
  }

  // Immich can report a successful mutation before every requested addition
  // or removal is visible on the asset. Verify the complete final state after
  // a short settle and repair once; if it is still inconsistent, throw so the
  // durable queue retries the whole (idempotent) job. A never-show decision
  // must not complete while the remote photo is still eligible.
  async verifyAndRepairTags(job) {
    const localTagsByAsset = this.repo.loadAssetTagsFor(job.assetIds, { prefix: 'ai/' });
    const expectedByAsset = new Map(
      job.assetIds.map((assetId) => [assetId, [...(localTagsByAsset[assetId] ?? []), ...job.add]]),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await sleep(this.verifyDelayMs);
      const missingByAsset = new Map();
      const retainedByAsset = new Map();
      const retainedTagIdsByAsset = new Map();
      for (const assetId of job.assetIds) {
        const remoteAsset = await this.immich.getAsset(assetId);
        if (!Array.isArray(remoteAsset?.tags)) {
          throw new Error(
            'Immich did not expose asset tags. Enable Tags under Account Settings → Features for the API-key account, confirm the key includes tag.read, tag.create, and tag.asset, then retry.',
          );
        }
        const remoteTagIds = tagMap(remoteAsset.tags);
        const remoteTags = new Set(remoteAsset.tags.map((tag) => tagValue(tag)).filter(Boolean));
        const missing = (expectedByAsset.get(assetId) ?? []).filter((tag) => !remoteTags.has(tag));
        if (missing.length > 0) {
          missingByAsset.set(assetId, missing);
        }
        const retained = job.remove.filter((tag) => remoteTags.has(tag));
        if (retained.length > 0) {
          retainedByAsset.set(assetId, retained);
          retainedTagIdsByAsset.set(
            assetId,
            retained.map((tag) => remoteTagIds[tag]).filter(Boolean),
          );
        }
      }
      if (missingByAsset.size === 0 && retainedByAsset.size === 0) {
        return;
      }
      if (attempt === 1) {
        const problems = [];
        if (missingByAsset.size > 0) {
          problems.push(`Missing: ${[...missingByAsset.entries()]
            .map(([assetId, tags]) => `${assetId}: ${tags.join(', ')}`)
            .join(' | ')}`);
        }
        if (retainedByAsset.size > 0) {
          problems.push(`Still present: ${[...retainedByAsset.entries()]
            .map(([assetId, tags]) => `${assetId}: ${tags.join(', ')}`)
            .join(' | ')}`);
        }
        throw new Error(
          `Immich did not retain all requested tags after a repair attempt. Confirm Tags is enabled for the API-key account and that the affected photos are owned by or writable to that account, then retry. ${problems.join(' | ')}`,
        );
      }
      const inconsistentAssets = new Set([...missingByAsset.keys(), ...retainedByAsset.keys()]);
      this.log(`immich tag state is still inconsistent on ${inconsistentAssets.size} asset(s); repairing`);
      if (retainedByAsset.size > 0) {
        const assetsByTagId = new Map();
        for (const [assetId, retainedTagIds] of retainedTagIdsByAsset) {
          for (const retainedTagId of retainedTagIds) {
            push(assetsByTagId, retainedTagId, assetId);
          }
        }
        for (const [retainedTagId, assetIds] of assetsByTagId) {
          await this.immich.untagAssets({ tagId: retainedTagId, assetIds });
        }
      }
      if (missingByAsset.size > 0) {
        const allMissing = [...new Set([...missingByAsset.values()].flat())].sort();
        const resolved = await ensureImmichTagIds(this.immich, allMissing);
        for (const [assetId, missing] of missingByAsset) {
          await this.immich.tagAssetsBulk({
            assetIds: [assetId],
            tagIds: missing.map((tag) => resolved[tag]).filter(Boolean),
          });
        }
      }
    }
  }

  // Reconcile ai/* tags in Immich with the local source of truth for the
  // decided assets: parallel reads, then one grouped write per tag.
  async syncAiTagsForAssets(assetIds, knownTagIds) {
    const localTagsByAsset = this.repo.loadAssetTagsFor(assetIds, { prefix: 'ai/' });
    const allLocalTags = [...new Set(assetIds.flatMap((assetId) => localTagsByAsset[assetId] ?? []))].sort();
    const tagIds = { ...knownTagIds };
    if (allLocalTags.length > 0) {
      Object.assign(tagIds, await ensureImmichTagIds(this.immich, allLocalTags));
    }

    const remoteMaps = await mapWithConcurrency(assetIds, REMOTE_FETCH_CONCURRENCY, async (assetId) => {
      const remoteAsset = await this.immich.getAsset(assetId);
      return tagMap(Array.isArray(remoteAsset?.tags) ? remoteAsset.tags : []);
    });

    const removalsByTagId = new Map();
    const additionTagIdsByAsset = new Map();
    assetIds.forEach((assetId, index) => {
      const remoteTagIds = remoteMaps[index];
      const remoteAiTags = new Set(Object.keys(remoteTagIds).filter((tag) => tag.startsWith('ai/')));
      const localAiTags = new Set(localTagsByAsset[assetId] ?? []);
      for (const tag of remoteAiTags) {
        if (!localAiTags.has(tag)) {
          const immichTagId = remoteTagIds[tag] ?? tagIds[tag];
          if (immichTagId) {
            push(removalsByTagId, immichTagId, assetId);
          }
        }
      }
      const additions = [...localAiTags]
        .filter((tag) => !remoteAiTags.has(tag) && tagIds[tag])
        .map((tag) => tagIds[tag])
        .sort();
      if (additions.length > 0) {
        additionTagIdsByAsset.set(assetId, additions);
      }
    });

    for (const [immichTagId, ids] of [...removalsByTagId.entries()].sort()) {
      await this.immich.untagAssets({ tagId: immichTagId, assetIds: ids });
    }
    // Group assets sharing the same addition set into one bulk call: fewer
    // mutation events per asset means Immich's background jobs cannot race.
    const assetsByAdditionSet = new Map();
    for (const [assetId, additions] of additionTagIdsByAsset) {
      push(assetsByAdditionSet, JSON.stringify(additions), assetId);
    }
    for (const [signature, ids] of [...assetsByAdditionSet.entries()].sort()) {
      await this.immich.tagAssetsBulk({ assetIds: ids, tagIds: JSON.parse(signature) });
    }
  }
}

// "Same moment" grouping, three signals united into one group per photo set:
//   1. capture time — adjacent shots within BURST_CHAIN_MS always chain
//      (classic burst); shots BURST_CHAIN_MS..BURST_NEAR_MS apart chain only
//      when they also look alike (thumbhash ≤ THUMBHASH_NEAR_SCENE). Time
//      chains are transitive, so an unconditional multi-minute gap glued
//      whole sightseeing walks into 20-40 photo groups — the similarity
//      condition keeps re-framed shots together without chaining a stroll.
//   2. thumbhash — near-identical images on the same day (re-shoots minutes
//      or hours apart, double-uploads with different timestamps)
//   3. Immich's duplicateId — its own duplicate-detection job, when run
// Thumbhash matching is deliberately conservative: calibrated on real-library
// data, distance ≤ THUMBHASH_NEAR_DUP covers ~95% of Immich-confirmed
// duplicate pairs while touching ~0.03% of unrelated same-day pairs. It finds
// the *same image*, not similar scenes — visually-similar thresholds overlap
// unrelated photos badly day-wide, which is why THUMBHASH_NEAR_SCENE is only
// consulted for time-adjacent pairs, where the prior is already high.
// When at least one member has a frame-worthy score, the highest scorer is
// suggested as the best pick (aesthetic score breaks ties) — the basis for
// "Keep best, skip rest". Suggestion only; the human decides.
export const THUMBHASH_NEAR_DUP = 0.025;
export const THUMBHASH_NEAR_SCENE = 0.1;
// Exact all-pairs matching preserves the established grouping contract for
// ordinary shooting days. Dense import/timelapse days switch to a bounded,
// deterministic candidate window, and the full annotation rebuild has one
// hard distance-call budget. Exact byte duplicates are still joined before
// that window, so graceful degradation can only miss a near-duplicate; it
// can never manufacture a false-positive stack.
export const THUMBHASH_ALL_PAIRS_MAX_ITEMS = 256;
export const THUMBHASH_COMPARISON_BUDGET = 250_000;
export const THUMBHASH_NEIGHBOR_WINDOW = 8;
export const THUMBHASH_MAX_BYTES = 64;

// Stacks are capped: a "same moment" group larger than MAX_STACK_MEMBERS is
// split into chunks at its largest internal capture-time gaps, repeatedly,
// until every chunk fits. Two reasons: the referee sends a whole stack to the
// model in ONE multi-image request, and ranking quality (and request size)
// degrades past ~10 images; and in practice oversized groups are walk chains
// glued by transitive time-chaining, not true bursts — their largest gaps are
// natural seams. Before this cap lived here, it lived in the referee alone
// (max 8), which silently skipped bigger groups forever and made Curate's
// unrefereed-stack count disagree with the referee's "remaining". Chunking is
// deterministic (capture order, earliest-largest-gap tiebreak) so stack
// identity — and the referee verdicts keyed to exact membership — stays
// stable between polls. A 1-photo chunk simply renders as a single card.
// LIKELY TO BE REVISED: the known costs are per-chunk gold picks (the referee
// never compares across chunks, so "Keep best, skip rest" keeps one photo per
// chunk of a true oversized burst) and extra verdict churn when membership
// growth moves a chunk boundary. If those bite, the candidates are referee
// sub-batching with a winners round, or smarter chain-breaking upstream.
// See docs/ENRICH.md "Stacks and the AI referee".
export const MAX_STACK_MEMBERS = 10;

export function chunkByLargestGap(nodes, max = MAX_STACK_MEMBERS) {
  // Iterative worklist, not recursion: a chained run can be arbitrarily long
  // (a timelapse folder forms ONE union group), and recursing per split blew
  // the call stack at ~10k members.
  const chunks = [];
  const work = [nodes];
  while (work.length > 0) {
    const run = work.pop();
    if (run.length <= max) {
      chunks.push(run);
      continue;
    }
    // Largest internal gap wins; among EQUAL largest gaps, the boundary
    // nearest the middle wins. Without that tie-break a uniform run (a
    // same-timestamp import batch, a fixed-interval timelapse) keeps
    // "winning" at its first gap and peels one photo per split — unstacking
    // almost the whole run into single cards. Middlemost halves it instead.
    const middle = (run.length - 2) / 2; // split boundaries range 0..len-2
    let splitAfter = -1;
    let bestGap = -Infinity;
    for (let i = 0; i < run.length - 1; i++) {
      const gap = run[i + 1].time - run[i].time; // NaN when either side is untimed
      if (!Number.isFinite(gap)) continue;
      if (gap > bestGap || (gap === bestGap && Math.abs(i - middle) < Math.abs(splitAfter - middle))) {
        bestGap = gap;
        splitAfter = i;
      }
    }
    // No usable gap at all (untimed members, e.g. an Immich duplicate
    // group): halve.
    if (splitAfter === -1) splitAfter = Math.ceil(run.length / 2) - 1;
    // Right pushed first so the left half pops next: chunks emit in capture
    // order.
    work.push(run.slice(splitAfter + 1), run.slice(0, splitAfter + 1));
  }
  return chunks;
}

// Rows can arrive still carrying annotations from another consumer (the
// review-row cache hands every caller the same objects): a member whose
// group is absent from THIS view must not keep a stale stack. undefined
// (rather than delete) serializes identically — JSON.stringify drops it.
export function resetBurstAnnotations(rows) {
  for (const row of rows) {
    if (row.burstId === undefined) continue;
    row.burstId = undefined;
    row.burstSize = undefined;
    row.burstAssetIds = undefined;
    row.burstBestAssetId = undefined;
    row.burstPickSource = undefined;
    row.burstMemberStates = undefined;
    row.burstMemberFiles = undefined;
  }
  return rows;
}

export function annotateBursts(rows, { metrics = null } = {}) {
  resetBurstAnnotations(rows);
  const nodes = rows.map((row) => ({
    row,
    time: row.capturedAt ? Date.parse(row.capturedAt) : NaN,
    day: row.capturedAt ? String(row.capturedAt).slice(0, 10) : null,
    hash: decodeThumbhash(row.thumbhash),
    parent: -1,
  }));

  const find = (i) => {
    let root = i;
    while (nodes[root].parent !== -1) root = nodes[root].parent;
    while (nodes[i].parent !== -1) {
      const next = nodes[i].parent;
      nodes[i].parent = root;
      i = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) nodes[rb].parent = ra;
  };
  let thumbhashComparisons = 0;
  let boundedFallbackDays = 0;
  const compareThumbhash = (left, right, threshold) => {
    if (thumbhashComparisons >= THUMBHASH_COMPARISON_BUDGET) return false;
    thumbhashComparisons += 1;
    return thumbhashDistance(left, right) <= threshold;
  };

  // 1. Time chains: adjacent-in-time photos chain unconditionally inside the
  // tight window, and inside the wide window only when they look alike.
  const timed = nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => Number.isFinite(node.time))
    .sort((left, right) => left.node.time - right.node.time);
  for (let i = 1; i < timed.length; i++) {
    const gapMs = timed[i].node.time - timed[i - 1].node.time;
    if (
      gapMs <= BURST_CHAIN_MS ||
      (gapMs <= BURST_NEAR_MS &&
        compareThumbhash(timed[i - 1].node.hash, timed[i].node.hash, THUMBHASH_NEAR_SCENE))
    ) {
      union(timed[i - 1].index, timed[i].index);
    }
  }

  // 2. Near-identical thumbhashes, bounded to the same day for precision.
  const byDay = new Map();
  timed.forEach(({ node, index }) => {
    if (node.hash && node.day) {
      const list = byDay.get(node.day) ?? [];
      list.push(index);
      byDay.set(node.day, list);
    }
  });
  for (const indices of byDay.values()) {
    const pairCount = (indices.length * (indices.length - 1)) / 2;
    const exact =
      indices.length <= THUMBHASH_ALL_PAIRS_MAX_ITEMS &&
      pairCount <= THUMBHASH_COMPARISON_BUDGET - thumbhashComparisons;
    if (exact) {
      for (let i = 0; i < indices.length; i++) {
        for (let j = i + 1; j < indices.length; j++) {
          if (compareThumbhash(nodes[indices[i]].hash, nodes[indices[j]].hash, THUMBHASH_NEAR_DUP)) {
            union(indices[i], indices[j]);
          }
        }
      }
      continue;
    }

    boundedFallbackDays += 1;
    // Preserve byte-identical duplicates anywhere in the day without a
    // distance call. Canonicalizing decoded bytes also joins equivalent
    // base64 spellings.
    const exactHashes = new Map();
    const byLength = new Map();
    for (const index of indices) {
      const hash = nodes[index].hash;
      const key = Buffer.from(hash).toString('base64');
      const first = exactHashes.get(key);
      if (first === undefined) exactHashes.set(key, index);
      else union(first, index);
      const sum = hash.reduce((total, byte) => total + byte, 0);
      const list = byLength.get(hash.length) ?? [];
      list.push({ index, sum, assetId: String(nodes[index].row.assetId ?? '') });
      byLength.set(hash.length, list);
    }

    // Byte-sum distance is a necessary lower bound on L1 distance. Sorting
    // by it lets a fixed neighbor window find strong nearby candidates with
    // no false positives; the full thumbhash distance remains the gate.
    for (const [length, candidates] of byLength) {
      candidates.sort((left, right) => left.sum - right.sum || left.assetId.localeCompare(right.assetId) || left.index - right.index);
      const maxSumDistance = length * 255 * THUMBHASH_NEAR_DUP;
      for (let i = 0; i < candidates.length && thumbhashComparisons < THUMBHASH_COMPARISON_BUDGET; i++) {
        const end = Math.min(candidates.length, i + 1 + THUMBHASH_NEIGHBOR_WINDOW);
        for (let j = i + 1; j < end && thumbhashComparisons < THUMBHASH_COMPARISON_BUDGET; j++) {
          if (candidates[j].sum - candidates[i].sum > maxSumDistance) break;
          if (compareThumbhash(
            nodes[candidates[i].index].hash,
            nodes[candidates[j].index].hash,
            THUMBHASH_NEAR_DUP,
          )) {
            union(candidates[i].index, candidates[j].index);
          }
        }
      }
    }
  }
  if (metrics && typeof metrics === 'object') {
    metrics.thumbhashComparisons = thumbhashComparisons;
    metrics.boundedFallbackDays = boundedFallbackDays;
  }

  // 3. Immich's own duplicate groups (timestamp-independent).
  const byDuplicate = new Map();
  nodes.forEach((node, index) => {
    if (node.row.duplicateId) {
      const first = byDuplicate.get(node.row.duplicateId);
      if (first === undefined) byDuplicate.set(node.row.duplicateId, index);
      else union(first, index);
    }
  });

  // Annotate groups of two or more, members in capture order.
  const groups = new Map();
  nodes.forEach((node, index) => {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(node);
    groups.set(root, list);
  });
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) =>
      String(left.row.capturedAt ?? '9999').localeCompare(String(right.row.capturedAt ?? '9999')),
    );
    for (const members of chunkByLargestGap(group)) {
      if (members.length < 2) continue;
      // Referee-v2 subject splitting: when the referee judged every present
      // member and put them in different subject groups (people vs the empty
      // scene), the moment renders as one stack PER SUBJECT, each with its own
      // best pick. A subject with a single photo simply leaves the stack.
      for (const partition of splitBySubject(members)) {
        if (partition.length < 2) continue;
        const ids = partition.map((member) => member.row.assetId);
        // The star's confidence ladder: a referee verdict (gold — the model saw
        // the group side by side) beats per-photo scores (silver); no signal at
        // all means no star. Ranks come from the group's last refereeing; if
        // some members are absent from this view, the best *present* rank wins.
        const refereed = partition.filter((member) => Number.isFinite(member.row.refereeRank));
        let bestAssetId = null;
        let pickSource = null;
        if (refereed.length > 0) {
          const best = refereed.reduce((leader, member) =>
            member.row.refereeRank < leader.row.refereeRank ? member : leader,
          );
          bestAssetId = best.row.assetId;
          pickSource = 'referee';
        } else {
          const best = partition.reduce((leader, member) =>
            burstScore(member.row) > burstScore(leader.row) ? member : leader,
          );
          bestAssetId = typeof best.row.frameScore === 'number' ? best.row.assetId : null;
          pickSource = bestAssetId ? 'score' : null;
        }
        // Member decision states and filenames let the UI distinguish a live
        // stack from a remnant (siblings already decided) and render decided
        // siblings in the compare view without another fetch.
        const memberStates = {};
        const memberFiles = {};
        for (const { row } of partition) {
          memberStates[row.assetId] = row.state;
          memberFiles[row.assetId] = row.filename;
        }
        // The id derives from exact membership (same photos → same id,
        // always). While an enrichment run streams photos in, groups regrow
        // and re-chunk on every arrival; a positional counter could otherwise
        // make a client holding different regenerations combine unrelated
        // stacks under one recycled id.
        const burstId = `burst-${createHash('sha1').update([...ids].sort().join('\n')).digest('hex').slice(0, 12)}`;
        for (const { row } of partition) {
          row.burstId = burstId;
          row.burstSize = partition.length;
          row.burstAssetIds = ids;
          row.burstBestAssetId = bestAssetId;
          row.burstPickSource = pickSource;
          row.burstMemberStates = memberStates;
          row.burstMemberFiles = memberFiles;
        }
      }
    }
  }
  return rows;
}

// Partition a time/visual group by the referee's subject groups. Splits only
// when every present member carries a verdict (a group awaiting judgment, or
// with new unjudged members, stays whole) and at least two subjects exist.
// v1 verdicts have no subject_group — treated as one subject, never split.
function splitBySubject(members) {
  if (!members.every((member) => Number.isFinite(member.row.refereeRank))) {
    return [members];
  }
  const bySubject = new Map();
  for (const member of members) {
    const subject = Number.isFinite(member.row.refereeSubjectGroup) ? member.row.refereeSubjectGroup : 1;
    (bySubject.get(subject) ?? bySubject.set(subject, []).get(subject)).push(member);
  }
  if (bySubject.size < 2) {
    return [members];
  }
  return [...bySubject.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}

function decodeThumbhash(value) {
  // Real ThumbHash descriptors are only a few dozen bytes. Check the encoded
  // envelope before Buffer decoding so a malformed/restored database value
  // cannot turn one bounded comparison into attacker-sized allocation/work.
  const maxEncodedLength = Math.ceil(THUMBHASH_MAX_BYTES / 3) * 4;
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maxEncodedLength ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length > 0 && decoded.length <= THUMBHASH_MAX_BYTES ? Uint8Array.from(decoded) : null;
  } catch {
    return null;
  }
}

// Normalized L1 distance over the raw thumbhash bytes. Different lengths
// mean different aspect ratios — treated as far apart.
export function thumbhashDistance(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) {
    return 1;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / (a.length * 255);
}

// Reorder a sorted list so every group's members sit together, at the
// position of the group's highest-ranked member. Rows outside groups keep
// their positions relative to the groups around them.
export function clusterBursts(rows) {
  const byBurst = new Map();
  for (const row of rows) {
    if (row.burstId) {
      const list = byBurst.get(row.burstId) ?? [];
      list.push(row);
      byBurst.set(row.burstId, list);
    }
  }
  const emitted = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.burstId) {
      out.push(row);
    } else if (!emitted.has(row.burstId)) {
      emitted.add(row.burstId);
      out.push(...byBurst.get(row.burstId));
    }
  }
  return out;
}

// Frame-worthy score dominates; aesthetic score breaks ties. Rows without
// scores (e.g. sent to Curate without enrichment) sort last.
function burstScore(row) {
  const frame = typeof row.frameScore === 'number' ? row.frameScore : -1;
  const aesthetic = typeof row.aestheticScore === 'number' ? row.aestheticScore : -1;
  return frame * 1000 + aesthetic;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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

function push(map, key, value) {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function first(query, name, fallback) {
  const value = query.get?.(name) ?? query[name];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function intFirst(query, name, fallback) {
  const parsed = Number.parseInt(first(query, name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
