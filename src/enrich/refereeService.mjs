import { createHash } from 'node:crypto';
import { AiSchedulingCancelled } from '../ai/scheduler.mjs';

import { awaitDrain } from '../lifecycle.mjs';
import { MAX_STACK_MEMBERS } from './reviewService.mjs';
import { fetchImage, PROVIDER_RETRY_AFTER_CAP_MS } from './runner.mjs';
import { buildRefereeRequest, normalizePicks } from './referee-contract.mjs';
import { createCurateAiProvider } from '../curate/ai-config.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

export { REFEREE_PROMPT_VERSION, buildRefereeUserPrompt, refereeJsonSchema, normalizePicks } from './referee-contract.mjs';

// Group referee (Curate's gold star): for each "same moment" group, ONE
// multi-image request ranks the members by keeper quality and explains why.
// Design rules (DESIGN-NOTES §6):
//   - suggestions only — the human decides; nothing here writes decisions
//   - compute is patient: a resumable background worker waiting for the
//     active enrichment run to finish, then working the backlog
//     most-undecided-first (group size breaks ties)
//   - a verdict is keyed to the group's exact membership; when membership
//     changes (new photos arrive), the group is simply refereed again
//   - people beat empty scenes unless technically bad; face counts are
//     injected as text so the model judges quality, not presence
//   - eyes_closed is a required per-photo field with an honest "unsure" out

const POLL_MS = 60000;
const ERROR_BACKOFF_MS = 5 * 60000;
// One request carries a whole group of images (up to the grouping cap), so
// it runs far longer than a single-photo enrichment call.
const REFEREE_TIMEOUT_MS = 20 * 60000;
// Per-image ceiling in original mode: beyond this the member degrades to its
// preview.
export const REFEREE_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// Cumulative ceiling across ONE group's images in original mode. The
// per-image cap alone still lets 10 members buffer ~250MB of raw bytes, and
// building the provider request multiplies raw bytes by roughly 3.5× (×4/3
// for the base64 data URLs plus a full JSON.stringify copy of the request
// body in the transport) — a ~920MB transient spike on a self-hoster's box.
// 96MB bounds that build at roughly 3.5 × 96MB ≈ 350MB peak while still
// carrying three or four full-size 25MB originals per group; members past
// the budget degrade to their previews, mirroring the per-image cap.
export const REFEREE_GROUP_BYTE_BUDGET = 96 * 1024 * 1024;

export function refereeGroupKey(assetIds) {
  return createHash('sha1').update([...assetIds].sort().join('\n')).digest('hex');
}

export class RefereeService {
  constructor({ repo, immich, review, enrichRunner, config, log = () => {}, aiScheduler = null, aiConnections = null }) {
    this.repo = repo;
    this.immich = immich;
    this.review = review;
    this.enrichRunner = enrichRunner;
    this.config = config;
    this.aiScheduler = aiScheduler;
    this.aiConnections = aiConnections;
    this.aiSession = null;
    this.log = log;
    this._timer = null;
    this._tickPromise = null; // in-flight poll, drained by stop()
    this._working = false;
    this._stopped = false;
    this._paused = false; // user pause; deliberately not persisted — Settings toggle is the durable off

    this._lastError = null;
    this._lastErrorAt = 0;
    this._errorBackoffMs = ERROR_BACKOFF_MS;
    this._current = null; // group key being refereed, for status
    this._currentSize = null;
    this._currentStartedAt = null;
    // Stacks judged in the current run — since the queue was last observed
    // empty. Feeds Curate's progress bar as batchDone/(batchDone+remaining):
    // a bar scoped to the work at hand rather than all-time history (which
    // pinned the old bar at ~100% forever). Deliberately in-memory — a
    // restart mid-run just restarts the bar; the all-time count lives in
    // the DB.
    this._batchDone = 0;
    this._recentErrors = []; // newest-first ring buffer for the activity view
    // Budget degrades, counted for the status view so a self-hoster can see
    // the caps working (mirrors the log lines): oversized = a single
    // original past the per-image cap, budget = an original no longer fit
    // the group's remaining byte budget, thumbnail = even the preview no
    // longer fit and the member degraded one more step.
    this._previewFallbacks = { oversized: 0, budget: 0, thumbnail: 0 };
    // Groups deferred because not even thumbnails fit the byte budget —
    // skipped for this process lifetime so one pathological group can't
    // head-of-line block the queue; retried after a restart (or a budget
    // change, which implies one).
    this._deferredGroups = new Map(); // key → { at, reason }
  }

  start() {
    if (this._timer) return;
    // Stored so stop() can drain the in-flight poll; tick() never rejects.
    // While a group verdict is in flight (_working), later polls must not
    // overwrite the drain handle with an instantly-settled no-op tick — or
    // stop() would report "drained" while minutes of model work continue.
    this._timer = setInterval(() => {
      if (!this._working) {
        this._tickPromise = this.tick();
      }
    }, POLL_MS);
    this._timer.unref?.();
  }

  // Shutdown drain: stop the poll, signal preparation and the contiguous block,
  // and wait briefly for an in-flight
  // group. A group verdict is minutes of model work with no abort handle,
  // so the budget is deliberately short: a laggard is abandoned, not
  // awaited to the end — verdicts are recomputable and the caller warns by
  // name. Returns false when the wait gave up.
  async stop(timeoutMs = 3000) {
    this._stopped = true;
    this.aiSession?.close();
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return awaitDrain(this._tickPromise, timeoutMs);
  }

  enabled() {
    // Retain the released Enrich dependency until PIC-372 deliberately migrates
    // inactive preferences. Stacks off must also stop this legacy worker.
    return this.config.curateBurstGrouping !== false
      && Boolean(this.config.enrichEnabled) && Boolean(this.config.curateRefereeEnabled);
  }

  canStartWork() {
    // Keep the released readiness rule until cutover: photos from one burst
    // need not be adjacent in the Enrich queue. A shared turn alone cannot
    // prove membership is settled, even on an independent provider.
    return !this._stopped && !this._paused && this.enabled() && !this.enrichRunner.isRunning();
  }

  // Pause is cooperative: a submitted request may finish, but photo preparation
  // stops before another download/submission. Lasts until resume or restart.
  setPaused(paused) {
    const next = Boolean(paused);
    if (next !== this._paused) {
      this._paused = next;
      if (next) this.aiSession?.close();
      this.log(next ? 'referee: paused by user' : 'referee: resumed by user');
    }
    return this.status();
  }

  // Groups worth refereeing: 2+ members, at least 2 undecided (nothing to
  // choose otherwise), not already refereed with this exact membership.
  // Grouping comes from the SHARED full-set annotation (annotatedReviewRows)
  // — the exact stacks Curate renders — so a stack the grid shows unjudged
  // is referee-visible by construction. Both halves of that have failed
  // before: the referee alone once capped groups at 8 and silently skipped
  // bigger ones (the cap now lives in the grouping layer, chunking oversized
  // moments at their largest time gaps — the size guard below is
  // defense-in-depth only). The grid also once grouped its FILTERED view and
  // minted stacks the full timeline does not contain, which the referee could
  // never judge.
  pendingGroups() {
    const rows = this.review.annotatedReviewRows();
    const byBurst = new Map();
    for (const row of rows) {
      if (!row.burstId) continue;
      (byBurst.get(row.burstId) ?? byBurst.set(row.burstId, []).get(row.burstId)).push(row);
    }
    const groups = [];
    for (const members of byBurst.values()) {
      if (members.length < 2 || members.length > MAX_STACK_MEMBERS) continue;
      const undecided = members.filter((m) => m.state === 'undecided');
      if (undecided.length < 2) continue;
      // Every member already judged: this is a judged group (or a subject
      // split of one) — nothing new for the referee until membership grows.
      if (members.every((m) => Number.isFinite(m.refereeRank))) continue;
      const key = refereeGroupKey(members.map((m) => m.assetId));
      groups.push({ key, members, undecidedCount: undecided.length });
    }
    groups.sort((a, b) => b.undecidedCount - a.undecidedCount || b.members.length - a.members.length);
    return groups;
  }

  status() {
    const stats = this.repo.refereeStats();
    let remaining = null;
    try {
      if (this.enabled()) {
        const pending = this.pendingGroups();
        // A deferred key that is no longer pending — its members decided by
        // hand, or its membership changed (which mints a new key) — is done
        // or retryable, not deferred: prune before reporting so the strip's
        // warning clears. The Activity view keeps the historical entry.
        const pendingKeys = new Set(pending.map((g) => g.key));
        for (const key of this._deferredGroups.keys()) {
          if (!pendingKeys.has(key)) this._deferredGroups.delete(key);
        }
        remaining = pending.filter((g) => !this.repo.refereeHasGroup(g.key) && !this._deferredGroups.has(g.key)).length;
      }
    } catch {
      remaining = null;
    }
    // An empty queue ends the run wherever we notice it — the tick loop
    // covers normal drains, but the queue can also empty without judging
    // (the human decides the pending stacks themselves while the referee is
    // idle or paused), and a stale "5 of 5" bar must not survive that. A
    // disabled referee ends the run too: remaining is null while disabled,
    // so the empty-queue check can't see it, and without this a mid-run
    // disable → re-enable would resurrect the old count.
    if (!this.enabled() || (remaining === 0 && !this._working)) {
      this._batchDone = 0;
    }
    return {
      aiConnection: this.connectionStatus(),
      enabled: this.enabled(),
      working: this._working,
      paused: this._paused,
      current: this._current,
      currentSize: this._currentSize,
      currentForMs: this._currentStartedAt ? Date.now() - this._currentStartedAt : null,
      scheduling: this.aiSession?.status() ?? { state: 'idle', reason: null },
      yielding: !this._stopped && !this._paused && this.enabled()
        && (this.aiSession?.status().state === 'waiting' || (!this._working && this.enrichRunner.isRunning())),
      remaining,
      batchDone: this._batchDone,
      lastError: this._lastError,
      previewFallbacks: { ...this._previewFallbacks },
      deferredGroups: this._deferredGroups.size,
      ...stats,
    };
  }

  connectionStatus() {
    if (!this.aiConnections) return null;
    try { return this.aiConnections.status(this.makeProvider()); }
    catch { return { state: 'paused', reason: 'configuration' }; }
  }

  async tick() {
    if (this._working || !this.canStartWork()) return;
    const connection = this.connectionStatus();
    if (connection && !['ready', 'recovery-ready'].includes(connection.state)) return;
    if (this._lastError && Date.now() - this._lastErrorAt < this._errorBackoffMs) return;
    this._working = true;
    try {
      // Keep selecting while work remains. The shared scheduler admits one
      // request at a time and yields between groups; preparation rechecks the
      // live controls, including waiting for Enrich to finish.
      while (this.canStartWork()) {
        const group = this.pendingGroups().find(
          (g) => !this.repo.refereeHasGroup(g.key) && !this._deferredGroups.has(g.key),
        );
        if (!group) {
          this._batchDone = 0; // queue drained — the run is over
          break;
        }
        // false = deferred for size, or stopped during preparation. Neither is
        // judged or counted. Recheck the current gates before another group.
        if (await this.refereeGroup(group)) {
          this._batchDone += 1;
        }
      }
    } catch (error) {
      this._lastError = sanitizeDiagnostic(error instanceof Error ? error.message : error, {
        secrets: configuredSecrets(this.config, this.immich),
      });
      this._lastErrorAt = Date.now();
      this._errorBackoffMs = Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0
        ? Math.min(error.retryAfterMs, PROVIDER_RETRY_AFTER_CAP_MS)
        : ERROR_BACKOFF_MS;
      this._recentErrors.unshift({ at: new Date().toISOString(), message: this._lastError });
      this._recentErrors.length = Math.min(this._recentErrors.length, 50);
      this.log(`referee: ${this._lastError} — backing off for ${formatBackoff(this._errorBackoffMs)}`);
    } finally {
      this._working = false;
      this._current = null;
      this._currentSize = null;
      // Without this, an idle status reports currentForMs as time since the
      // LAST group started (current: null, currentForMs: minutes — nonsense).
      this._currentStartedAt = null;
    }
  }

  activity(limit = 20) {
    return {
      groups: this.repo.refereeRecentGroups(limit),
      errors: this._recentErrors.slice(0, limit),
    };
  }

  makeProvider() {
    return createCurateAiProvider(this.config, { minimumTimeoutMs: REFEREE_TIMEOUT_MS });
  }

  // The configured aggregate ceiling for one group's images, every source
  // counted. REFEREE_GROUP_BUDGET_MB lowers it for small containers.
  groupByteBudget() {
    const configured = Number(this.config.curateRefereeGroupBudgetBytes);
    return Number.isFinite(configured) && configured > 0 ? configured : REFEREE_GROUP_BYTE_BUDGET;
  }

  // The degradation chain for one member, best rendition first. Original
  // mode walks original → preview → thumbnail; preview mode preview →
  // thumbnail; thumbnail mode has nowhere left to degrade.
  memberSourceChain() {
    const source = this.config.imageSource ?? 'preview';
    if (source === 'original') return ['original', 'preview', 'thumbnail'];
    if (source === 'thumbnail') return ['thumbnail'];
    return ['preview', 'thumbnail'];
  }

  // One greedy pass over the whole group, members starting at
  // chain[startRung] and individually degrading below it when a rendition
  // won't fit what's left of the budget. Every fetch — every source, every
  // fallback — carries a maxBytes cap, so the Immich client aborts an
  // over-cap download instead of buffering it; bytes never exceed the
  // budget before they're counted. Returns { images, stats } or null when
  // some member cannot fit even the chain's smallest rendition — the
  // caller then retries the whole group one tier lower (greedy allocation
  // is order-sensitive: an early member keeping its big preview can starve
  // a later member whose thumbnail would have fit had everyone degraded).
  // Degrade counters accumulate in `stats`, not on the instance, so a
  // discarded attempt never pollutes the diagnostics.
  async attemptGroupFetch(group, chain, startRung, budget) {
    const images = [];
    const stats = { oversized: 0, budget: 0, thumbnail: 0 };
    let groupBytes = 0;
    for (const member of group.members) {
      let fetched = null;
      for (let rung = startRung; rung < chain.length && !fetched; rung += 1) {
        // A setting/pause/shutdown can change during the preceding download.
        // Stop before another fetch (including a smaller-rendition fallback).
        if (!this.canStartWork()) return { cancelled: true };
        const source = chain[rung];
        const cap = Math.min(REFEREE_MAX_IMAGE_BYTES, budget - groupBytes);
        if (cap <= 0) return null;
        try {
          fetched = await fetchImage(this.immich, member.assetId, source, { maxBytes: cap });
        } catch (error) {
          if (error?.name !== 'ResponseTooLargeError') {
            throw error;
          }
          const next = chain[rung + 1];
          const cause = cap < REFEREE_MAX_IMAGE_BYTES
            ? `would push the group past its ${Math.round(budget / 1024 / 1024)}MB byte budget`
            : `exceeds ${Math.round(REFEREE_MAX_IMAGE_BYTES / 1024 / 1024)}MB`;
          if (!next) {
            this.log(`referee: ${member.assetId} ${source} ${cause}; nothing smaller to try`);
            return null;
          }
          if (source === 'original') {
            stats[cap < REFEREE_MAX_IMAGE_BYTES ? 'budget' : 'oversized'] += 1;
          } else {
            stats.thumbnail += 1;
          }
          this.log(`referee: ${member.assetId} ${source} ${cause}; using ${next} instead`);
        }
      }
      groupBytes += fetched.data?.byteLength ?? 0;
      images.push({ data: fetched.data, mimeType: fetched.contentType, assetId: member.assetId });
    }
    return { images, stats };
  }

  async refereeGroup(group) {
    if (!this.canStartWork()) return false;
    const provider = this.makeProvider();
    if (!this.aiScheduler) return this.performGroup(group, provider);
    const session = this.aiScheduler.session(provider, 'curate', { eligible: () => this.canStartWork() });
    this.aiSession = session;
    try {
      // Claim the turn before downloads, so preparation cannot hoard a whole
      // stack's renditions while a long local Enrich request is running.
      return await session.run(() => {
        // The queue may have changed during a long Enrich turn. Re-select on
        // the next tick iteration instead of judging a no-longer-pending group.
        if (!this.pendingGroups().some(candidate => candidate.key === group.key)) return false;
        return this.performGroup(group, provider);
      });
    } catch (error) {
      if (error instanceof AiSchedulingCancelled) return false;
      throw error;
    } finally {
      session.close();
      if (this.aiSession === session) this.aiSession = null;
    }
  }

  async performGroup(group, provider) {
    if (!this.canStartWork()) return false;
    this._current = group.key;
    this._currentSize = group.members.length;
    this._currentStartedAt = Date.now();
    const started = Date.now();
    const budget = this.groupByteBudget();
    const chain = this.memberSourceChain();
    // fetchImage returns { data, contentType }; providers expect mimeType
    // (same remap the enrich runner does — without it the data URL comes
    // out as data:undefined and LM Studio rejects the request).
    // Original mode has no upper bound on file size (a single RAW-derived
    // original can run hundreds of MB), and even previews can be large
    // config-dependently — while building the provider request multiplies
    // raw bytes by roughly 3.5×. Two caps bound the aggregate on EVERY
    // path: each image at most REFEREE_MAX_IMAGE_BYTES, and the whole group
    // at most the byte budget. Members degrade original → preview →
    // thumbnail as the budget tightens; when greedy per-member degradation
    // still can't seat everyone (an early member's kept preview can starve
    // a later member's thumbnail), the WHOLE group retries one tier lower
    // before giving up. Bounded memory beats a marginally sharper judge
    // input.
    let result = null;
    for (let startRung = 0; startRung < chain.length && !result; startRung += 1) {
      if (startRung > 0) {
        this.log(`referee: group won't fit with per-member degradation; retrying every member at ${chain[startRung]} size`);
      }
      result = await this.attemptGroupFetch(group, chain, startRung, budget);
      if (result?.cancelled) return false;
      if (result && startRung > 0) {
        // A whole-tier restart degraded every member below the configured
        // source — count them so the diagnostics reflect what was sent.
        result.stats[chain[startRung] === 'thumbnail' ? 'thumbnail' : 'budget'] += group.members.length;
      }
    }
    // Downloads are read-only; a stopped preparation is neither a provider
    // failure nor a permanent size deferral. Already-submitted calls may finish.
    if (!this.canStartWork()) return false;
    if (!result) {
      // A verdict is keyed to the group's exact membership — judging a
      // subset would be wrong, so the group defers instead of exceeding
      // the ceiling. Skipped for this process lifetime (no head-of-line
      // blocking); surfaced in status and the activity error view.
      const reason = `${group.members.length}-photo group cannot fit the ${Math.round(budget / 1024 / 1024)}MB byte budget even with every member at thumbnail size`;
      this._deferredGroups.set(group.key, { at: new Date().toISOString(), reason });
      this._recentErrors.unshift({ at: new Date().toISOString(), message: `deferred: ${reason}` });
      this._recentErrors.length = Math.min(this._recentErrors.length, 50);
      this.log(`referee: deferred — ${reason}`);
      return false;
    }
    // Diagnostics merge only from the attempt that actually produced the
    // provider request; discarded attempts don't count.
    this._previewFallbacks.oversized += result.stats.oversized;
    this._previewFallbacks.budget += result.stats.budget;
    this._previewFallbacks.thumbnail += result.stats.thumbnail;
    const images = result.images;
    const submit = () => provider.analyzeImages(images, buildRefereeRequest(group.members));
    const { normalizedOutput } = await (this.aiConnections ? this.aiConnections.run(provider, submit) : submit());
    const picks = normalizePicks(normalizedOutput, group.members);
    this.repo.refereeRecordGroup({
      groupKey: group.key,
      memberCount: group.members.length,
      sameSubject: typeof normalizedOutput.same_subject === 'boolean' ? normalizedOutput.same_subject : null,
      provider: provider.providerName,
      model: provider.modelName,
      picks,
      durationMs: Date.now() - started,
    });
    this._lastError = null;
    this._errorBackoffMs = ERROR_BACKOFF_MS;
    const best = picks.find((pick) => pick.rank === 1);
    this.log(
      `referee: ranked ${group.members.length}-photo group in ${Math.round((Date.now() - started) / 1000)}s`
      + (best ? ` — best: ${group.members.find((m) => m.assetId === best.assetId)?.filename ?? best.assetId}` : ''),
    );
    return true;
  }
}

function formatBackoff(ms) {
  if (ms >= 60000 && ms % 60000 === 0) return `${ms / 60000}m`;
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}
