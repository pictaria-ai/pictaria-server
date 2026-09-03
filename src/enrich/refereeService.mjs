import { createHash } from 'node:crypto';

import { awaitDrain } from '../lifecycle.mjs';
import { MAX_STACK_MEMBERS } from './reviewService.mjs';
import { fetchImage, PROVIDER_RETRY_AFTER_CAP_MS } from './runner.mjs';
import { createProvider } from './providers.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

// Group referee (Curate's gold star): for each "same moment" group, ONE
// multi-image request ranks the members by keeper quality and explains why.
// Design rules (DESIGN-NOTES §6):
//   - suggestions only — the human decides; nothing here writes decisions
//   - compute is patient: a resumable background worker that yields to
//     enrichment (never both on the model at once) and works the backlog
//     most-undecided-first (group size breaks ties)
//   - a verdict is keyed to the group's exact membership; when membership
//     changes (new photos arrive), the group is simply refereed again
//   - people beat empty scenes unless technically bad; face counts are
//     injected as text so the model judges quality, not presence
//   - eyes_closed is a required per-photo field with an honest "unsure" out
export const REFEREE_PROMPT_VERSION = 'referee-v2';

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

const SYSTEM_PROMPT = [
  'You are a photo-culling referee. You receive several photos taken moments apart',
  '(a burst, re-shoots, or duplicates) and rank them by which is most worth keeping',
  'for display in a home photo frame.',
  '',
  'Ranking rules, in priority order:',
  '1. A photo that clearly shows people beats a photo of the same scene without',
  '   people — unless the people shot is technically bad (badly blurred, person',
  '   cut off, all eyes closed).',
  '2. Among photos of people: everyone sharp, eyes open, and natural expressions',
  '   beat blinks, grimaces, and motion blur.',
  '3. Otherwise judge sharpness, composition, and overall appeal.',
  '',
  'For every photo, check each clearly visible face for closed eyes or mid-blink.',
  'Use "unsure" when faces are too small to judge confidently.',
  'Also assign every photo a subject_group number. Photos of essentially the',
  'same subject share a number (start at 1). Use a second group ONLY when the',
  'set clearly contains different subjects — e.g. shots of people AND separate',
  'shots of just the scenery, or two genuinely different scenes. Near-identical',
  'shots, re-framings, and small zoom changes are the SAME subject. When in',
  'doubt, use one group.',
  'Mark keep=true for the best photo of each subject_group.',
  'Keep each note short (one sentence) and concrete: it is shown to the user as',
  'the reason for the pick.',
  'Return strict JSON only.',
].join('\n');

export function refereeJsonSchema(memberCount) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['same_subject', 'photos'],
    properties: {
      same_subject: {
        type: 'boolean',
        description: 'Whether all photos show essentially the same subject (vs a mixed set that merely shares a time and place).',
      },
      photos: {
        type: 'array',
        minItems: memberCount,
        maxItems: memberCount,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['photo', 'rank', 'keep', 'eyes_closed', 'note', 'subject_group'],
          properties: {
            photo: { type: 'integer', description: '1-based index of the photo, in the order provided.' },
            rank: { type: 'integer', description: '1 = most worth keeping.' },
            subject_group: { type: 'integer', minimum: 1, description: 'Photos of the same subject share a number; a clearly different subject gets the next number. When in doubt, 1.' },
            keep: { type: 'boolean' },
            eyes_closed: { type: 'string', enum: ['yes', 'no', 'unsure'] },
            note: { type: 'string' },
          },
        },
      },
    },
  };
}

export function refereeGroupKey(assetIds) {
  return createHash('sha1').update([...assetIds].sort().join('\n')).digest('hex');
}

export function buildRefereeUserPrompt(members) {
  const lines = members.map((member, index) => {
    const facts = [];
    if (member.capturedAt) facts.push(`taken ${String(member.capturedAt).replace('T', ' ').slice(0, 19)}`);
    facts.push(describePeople(member));
    return `Photo ${index + 1}: ${facts.filter(Boolean).join(' · ')}`;
  });
  return [
    `These ${members.length} photos were taken within minutes of each other.`,
    'Known facts from face detection and prior analysis:',
    ...lines,
    '',
    'Rank them by keeper quality following your rules, check faces for closed',
    'eyes, and pick the best 1-2 to keep.',
  ].join('\n');
}

function describePeople(member) {
  const tags = member.aiTags ?? [];
  if (tags.includes('ai/people/group')) return '3+ people detected';
  if (tags.includes('ai/people/couple')) return '2 people detected';
  if (tags.includes('ai/people/one')) return '1 person detected';
  if (tags.includes('ai/people/none')) return 'no people detected';
  return 'people unknown (not yet analyzed)';
}

export class RefereeService {
  constructor({ repo, immich, review, enrichRunner, config, log = () => {} }) {
    this.repo = repo;
    this.immich = immich;
    this.review = review;
    this.enrichRunner = enrichRunner;
    this.config = config;
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

  // Shutdown drain: stop the poll, signal the worker (the contiguous block
  // checks _stopped between groups), and wait briefly for an in-flight
  // group. A group verdict is minutes of model work with no abort handle,
  // so the budget is deliberately short: a laggard is abandoned, not
  // awaited to the end — verdicts are recomputable and the caller warns by
  // name. Returns false when the wait gave up.
  async stop(timeoutMs = 3000) {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    return awaitDrain(this._tickPromise, timeoutMs);
  }

  enabled() {
    return Boolean(this.config.enrichEnabled) && Boolean(this.config.curateRefereeEnabled);
  }

  // Pause is cooperative: an in-flight group always finishes (its verdict is
  // minutes of model work — throwing it away helps nobody), then the worker
  // idles until resumed. Lasts until resume or a server restart.
  setPaused(paused) {
    const next = Boolean(paused);
    if (next !== this._paused) {
      this._paused = next;
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
      enabled: this.enabled(),
      working: this._working,
      paused: this._paused,
      current: this._current,
      currentSize: this._currentSize,
      currentForMs: this._currentStartedAt ? Date.now() - this._currentStartedAt : null,
      yielding: !this._working && !this._paused && this.enabled() && this.enrichRunner.isRunning(),
      remaining,
      batchDone: this._batchDone,
      lastError: this._lastError,
      previewFallbacks: { ...this._previewFallbacks },
      deferredGroups: this._deferredGroups.size,
      ...stats,
    };
  }

  async tick() {
    if (this._working || this._stopped || this._paused || !this.enabled()) return;
    if (this.enrichRunner.isRunning()) return; // the model belongs to enrichment
    if (this._lastError && Date.now() - this._lastErrorAt < this._errorBackoffMs) return;
    this._working = true;
    try {
      // Contiguous block: keep going while there is work and the model is
      // free — re-checked before every group so enrichment never waits for
      // more than the group in flight.
      while (!this._stopped && !this._paused && this.enabled() && !this.enrichRunner.isRunning()) {
        const group = this.pendingGroups().find(
          (g) => !this.repo.refereeHasGroup(g.key) && !this._deferredGroups.has(g.key),
        );
        if (!group) {
          this._batchDone = 0; // queue drained — the run is over
          break;
        }
        // false = deferred (couldn't fit the byte budget) — not judged, and
        // deliberately not counted; the worker moves on to the next group.
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
    const name = this.config.curateRefereeProvider || this.config.defaultProvider;
    const options = { ...(this.config.providers?.[name] ?? {}) };
    if (this.config.curateRefereeModel) options.modelName = this.config.curateRefereeModel;
    // Only ever raise the timeout — a user-configured longer one wins.
    options.timeoutMs = Math.max(Number(options.timeoutMs) || 0, REFEREE_TIMEOUT_MS);
    return createProvider(name, options);
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
    const provider = this.makeProvider();
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
      if (result && startRung > 0) {
        // A whole-tier restart degraded every member below the configured
        // source — count them so the diagnostics reflect what was sent.
        result.stats[chain[startRung] === 'thumbnail' ? 'thumbnail' : 'budget'] += group.members.length;
      }
    }
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
    const { normalizedOutput } = await provider.analyzeImages(images, {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildRefereeUserPrompt(group.members),
      jsonSchema: refereeJsonSchema(group.members.length),
      schemaName: 'pictaria_group_referee',
    });
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

// Turn the model's photo-indexed answers into asset-keyed picks, defending
// against duplicate/missing indices: every member ends up with exactly one
// rank, holes filled in model order.
export function normalizePicks(output, members) {
  const answers = Array.isArray(output?.photos) ? output.photos : [];
  const byIndex = new Map();
  for (const answer of answers) {
    const index = Number(answer?.photo);
    if (Number.isInteger(index) && index >= 1 && index <= members.length && !byIndex.has(index)) {
      byIndex.set(index, answer);
    }
  }
  const usedRanks = new Set();
  const picks = members.map((member, position) => {
    const answer = byIndex.get(position + 1) ?? {};
    let rank = Number.isInteger(Number(answer.rank)) ? Number(answer.rank) : null;
    if (rank === null || rank < 1 || rank > members.length || usedRanks.has(rank)) rank = null;
    if (rank !== null) usedRanks.add(rank);
    return {
      assetId: member.assetId,
      rank,
      keep: Boolean(answer.keep),
      eyesClosed: ['yes', 'no', 'unsure'].includes(answer.eyes_closed) ? answer.eyes_closed : null,
      note: typeof answer.note === 'string' ? answer.note.slice(0, 300) : null,
      subjectGroup:
        Number.isInteger(Number(answer.subject_group)) && Number(answer.subject_group) >= 1 && Number(answer.subject_group) <= members.length
          ? Number(answer.subject_group)
          : 1,
    };
  });
  let nextFree = 1;
  for (const pick of picks) {
    if (pick.rank !== null) continue;
    while (usedRanks.has(nextFree)) nextFree += 1;
    pick.rank = nextFree;
    usedRanks.add(nextFree);
  }
  return picks;
}
