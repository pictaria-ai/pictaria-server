// Bounded background composition checks. Browser attention only changes priority;
// completed candidate-member evidence is durable and scoped to its exact inputs.
import { CurateRankStore } from './rank-store.mjs';
import { CANDIDATE_METHOD } from './candidate.mjs';
import { CurateRetryStore } from './retry-store.mjs';
import { problemCode, problemMessage } from './search-problems.mjs';
export const REFINEMENT_LIMITS = Object.freeze({ cohorts: 32, views: 200,
  activeMs: 60_000, attentionMs: 12_000, requestsPerMinute: 30, retryMs: 60_000, retryMaxMs: 15 * 60_000,
  embeddingRetryMs: 15 * 60_000, embeddingRetryMaxMs: 60 * 60_000, embeddingMaxAttempts: 4 });

// Also honor counts retained by the earlier uncapped preview.
const embeddingStopped = error => error?.code === 'similarity_embedding_missing_exhausted' ||
  (error?.code === 'similarity_embedding_missing' && error.attempts >= REFINEMENT_LIMITS.embeddingMaxAttempts);
const failureCode = error => embeddingStopped(error) ? 'similarity_embedding_missing_exhausted' : error.code;

export class CurateRefinement {
  constructor(curate, { now = Date.now } = {}) {
    this.curate = curate;
    this.now = now;
    this.entries = new Map();
    this.views = new Map();
    this.requests = [];
    this.revision = 0;
    this.connection = curate.similarity.connectionKey();
    this.saved = new CurateRankStore(curate.repo.db, this.connection);
    this.retries = new CurateRetryStore(curate.repo.db, this.connection);
    this.retryStorageBlocked = new Set();
    this.metrics = { completedGroups: 0, completionMs: 0 };
  }
  enabled() {
    const c = this.curate;
    return !c.closed && c.config.curateBurstGrouping !== false &&
      Boolean(c.immich?.requestJson && c.immich?.baseUrl && c.immich?.apiKey);
  }
  settingsChanged() {
    const connection = this.curate.similarity.connectionKey();
    if (connection !== this.connection) {
      this.controller?.abort();
      this.saved.reset(connection); this.entries.clear(); this.views.clear();
      this.retries.reset(connection);
      this.connection = connection; this.revision++; this.storageFull = false;
      this.retryStorageBlocked = new Set();
    }
    if (!this.enabled()) { this.controller?.abort(); this.entries.clear(); this.views.clear(); }
  }
  retry() {
    const scopes = new Map((this.curate.current?.scopes ?? []).map(s => [s.id, s]));
    for (const id of new Set([...this.retries.records.keys(), ...this.entries.keys()])) {
      if (!scopes.has(id)) continue;
      const e = this.entries.get(id) ?? { ...scopes.get(id), ...this.retries.read(id) };
      e.retryAt = 0;
      for (const failure of Object.values(e.errors ?? {})) {
        failure.retryAt = 0;
        if (embeddingStopped(failure)) {
          failure.code = 'similarity_embedding_missing'; failure.attempts = 0;
        }
      }
      if (this.retries.records.has(id)) this.checkpoint(e);
    }
  }
  nextReference(entry) {
    if (entry.retryAt > this.now()) return;
    const ready = entry.referenceIds.filter(id => !Object.hasOwn(entry.rows, id) &&
      !embeddingStopped(entry.errors[id]) && !(entry.errors[id]?.retryAt > this.now()));
    return ready.find(id => !entry.errors[id]) ?? ready[0];
  }
  summary(entry) {
    const errors = Object.values(entry.errors);
    const codes = [...new Set([...errors.map(failureCode), ...(entry.failureCode ? [entry.failureCode] : [])])].sort();
    const remaining = entry.referenceIds.filter(id => !Object.hasOwn(entry.rows, id));
    const due = remaining.filter(id => !embeddingStopped(entry.errors[id]))
      .map(id => entry.errors[id]?.retryAt ?? 0);
    const retries = errors.filter(e => !embeddingStopped(e) && e.retryAt > this.now()).map(e => e.retryAt);
    // null means no automatic work remains, not "ready now". Preserve that
    // distinction in the compact durable summary as well as the active pass.
    return { done: Object.keys(entry.rows).length, failedReferences: errors.length, problemCodes: codes,
      eligibleAt: remaining.length && !due.length ? null : Math.max(entry.retryAt, due.length ? Math.min(...due) : 0),
      retryAt: retries.length ? Math.min(...retries) : entry.retryAt > this.now() ? entry.retryAt : null };
  }
  checkpoint(entry) {
    const saved = this.retries.save(entry, this.summary(entry));
    if (saved) this.retryStorageBlocked.delete(entry.id);
    else this.retryStorageBlocked.add(entry.id);
    return saved;
  }
  scopeProgress(scope) {
    const entry = this.entries.get(scope.id);
    return entry ? this.summary(entry) : this.retries.records.get(scope.id) ??
      { done: 0, eligibleAt: 0, failedReferences: 0, problemCodes: [], retryAt: null };
  }
  snapshot() {
    this.settingsChanged();
    if (!this.enabled()) return {};
    return Object.fromEntries((this.curate.current?.scopes ?? []).filter(s => this.saved.has(s.id))
      .map(s => [s.id, this.saved.read(s.id)]));
  }
  admit(scope) {
    if (!scope?.needsRanks || this.saved.has(scope.id) || this.entries.has(scope.id) || this.entries.size >= REFINEMENT_LIMITS.cohorts) return;
    const progress = this.retries.records.get(scope.id);
    if (progress && (progress.eligibleAt === null || progress.eligibleAt > this.now())) return;
    this.entries.set(scope.id, { ...scope, rows: Object.create(null), coverage: Object.create(null), errors: Object.create(null),
      admittedAt: this.now(), failures: 0, retryAt: 0, ...this.retries.read(scope.id) });
  }
  sync() {
    if (!this.enabled() || this.curate.building || !this.curate.current) return;
    const scopes = this.curate.current.scopes ?? [], valid = new Set(scopes.map(s => s.id));
    if (this.saved.prune(valid) || !valid.has(this.storageBlockedId)) this.storageFull = false;
    this.retries.prune(valid);
    for (const id of this.retryStorageBlocked ?? [])
      if (!valid.has(id) || this.saved.has(id)) this.retryStorageBlocked.delete(id);
    for (const id of this.retries.records.keys()) if (this.saved.has(id)) this.retries.delete(id);
    for (const [id, e] of this.entries) if (!this.valid(e) || this.saved.has(id) || !this.needed(e)) this.entries.delete(id);
    // A deferred pass must not monopolize an active slot. Successful rows and
    // individual retry deadlines survive parking and restart, but never enter
    // the grouping engine before the whole pass succeeds.
    for (const [id, e] of this.entries) {
      const at = this.summary(e).eligibleAt;
      if (id !== this.running?.id && (at === null || at > this.now()) && this.checkpoint(e)) this.entries.delete(id);
    }
    const priorities = this.priorities();
    const pending = scopes.filter(s => s.needsRanks && !this.saved.has(s.id))
      .sort((a,b) => (priorities.get(a.id) ?? 2) - (priorities.get(b.id) ?? 2) ||
        (this.scopeProgress(a).eligibleAt ?? Infinity) - (this.scopeProgress(b).eligibleAt ?? Infinity));
    // Make room for an inspected comparison without dropping an in-flight or
    // partially completed pass. The evicted untouched candidate remains queued.
    for (const scope of pending) {
      if (priorities.has(scope.id) && !this.entries.has(scope.id) && this.entries.size >= REFINEMENT_LIMITS.cohorts) {
        const spare = [...this.entries.values()].reverse().find(e => !priorities.has(e.id) && e.id !== this.running?.id && !Object.keys(e.rows).length && !e.failures);
        if (spare) this.entries.delete(spare.id);
      }
      this.admit(scope);
    }
  }
  demand(viewId, groups) {
    if (!this.enabled()) return;
    let view = this.views.get(viewId);
    if (!view) {
      if (this.views.size >= REFINEMENT_LIMITS.views) return;
      view = { anchors: new Set(), groups: new Map(), touched: this.now() }; this.views.set(viewId, view);
    }
    view.touched = this.now();
    for (const group of groups) for (const id of group.ids) {
      const scope = this.curate.current?.scopeByMember?.get(id);
      if (!scope || !scope.referenceIds.includes(id) || (!scope.needsRanks && !this.saved.has(scope.id))) continue;
      // Bound per-view update tracking independently of the background queue.
      if (!view.anchors.has(scope.ids[0]) && view.anchors.size >= REFINEMENT_LIMITS.cohorts) continue;
      view.anchors.add(scope.ids[0]);
      // At most 32 * 40 displayed groups; the group's first member is enough
      // to detect a changed membership ID without retaining whole old stacks.
      if (view.groups.size < REFINEMENT_LIMITS.cohorts * 40)
        view.groups.set(group.id, { id: group.id, ids: [group.ids[0]], route: group.route });
    }
  }
  active() {
    this.sync();
    return new Set((this.curate.current?.scopes ?? []).filter(s => s.needsRanks || this.saved.has(s.id)).map(s => s.id));
  }
  attention(viewId, groups, comparison = null) {
    this.demand(viewId, [...(groups ?? []), ...(comparison ? [comparison] : [])]);
    const view = this.views.get(viewId);
    if (!view) return;
    if (groups) view.visible = groups.map(g => g.ids[0]);
    view.focus = comparison?.ids[0] ?? null;
    view.attentionAt = this.now();
  }
  priorities() {
    const priorities = new Map();
    for (const [id, view] of this.views) {
      if (view.touched + REFINEMENT_LIMITS.activeMs <= this.now()) { this.views.delete(id); continue; }
      if (view.attentionAt + REFINEMENT_LIMITS.attentionMs <= this.now()) continue;
      const scope = id => this.curate.current?.scopeByMember?.get(id)?.id;
      for (const id of view.visible ?? []) {
        const key = scope(id);
        if (key && !priorities.has(key)) priorities.set(key, 1);
      }
      const focus = scope(view.focus);
      if (focus) priorities.set(focus, 0);
    }
    return priorities;
  }
  valid(entry) {
    if (!entry) return false;
    // The worker scope includes full membership, material revisions and human
    // partitions. A newly arriving member invalidates the whole cohort too.
    return entry.ids.every(id => this.curate.current?.scopeByMember?.get(id)?.id === entry.id);
  }
  needed(entry) {
    return this.valid(entry) && this.curate.current.scopeByMember.get(entry.ids[0]).needsRanks;
  }
  groupStatus(group) {
    if (!this.enabled()) return null;
    const first = group.ids[0], current = this.curate.current?.byMember.get(first);
    if (current?.id !== group.id) {
      const pending = [...new Set(group.ids.map(id => this.curate.current?.scopeByMember?.get(id)))].filter(s => s?.needsRanks);
      const problems = pending.map(s => this.scopeProgress(s)).filter(p => p.problemCodes.length);
      return { state: 'updated', pending: pending.length > 0,
        checking: pending.some(s => s.id === this.running?.id || Object.keys(this.entries.get(s.id)?.rows ?? {}).length > 0),
        paused: problems.length > 0,
        ...(problems.length ? { problem: problemMessage(problems[0].problemCodes[0]), problemCode: problems[0].problemCodes[0] } : {}),
        uncertain: group.ids.some(id => this.curate.current?.byMember.get(id)?.route === 'candidate-unconfirmed') };
    }
    // Every unchanged candidate group is contained in one time scope.
    const scope = this.curate.current?.scopeByMember?.get(first);
    if (!scope || !current.ids.some(id => scope.referenceIds.includes(id)) || (!scope.needsRanks && !this.saved.has(scope.id)))
      return group.route === 'manual-budget' ? { state: 'limited' } : null;
    const progress = this.scopeProgress(scope), total = scope.referenceIds.length, done = this.saved.has(scope.id) ? total : progress.done;
    const code = progress.problemCodes[0];
    return { state: done === total && this.saved.has(scope.id) ? 'checked' : code ? 'paused' :
      this.storageFull || this.retryStorageBlocked?.has(scope.id) ? 'limited' : done || scope.id === this.running?.id ? 'checking' : 'waiting',
      ...(code ? { problemCode: code, problem: problemMessage(code), failedReferences: progress.failedReferences, retryAt: progress.retryAt } : {}),
      done, total, ...(done === total && current.route === 'candidate-unconfirmed' ? { uncertain: true } : {}) };
  }
  status(viewId, groups = []) {
    this.sync();
    const scopes = this.enabled() ? (this.curate.current?.scopes ?? []).filter(s => s.needsRanks || this.saved.has(s.id)) : [];
    const pendingScopes = scopes.filter(s => !this.saved.has(s.id));
    const progress = pendingScopes.map(s => ({ ...this.scopeProgress(s), total: s.referenceIds.length }));
    const pending = progress.reduce((n,p) => n + p.total - p.done, 0);
    const failedGroups = progress.filter(p => p.problemCodes.length).length;
    const codes = [...new Set(progress.flatMap(p => p.problemCodes))].sort();
    const retryAt = progress.reduce((earliest, p) => p.retryAt > this.now() ? Math.min(earliest, p.retryAt) : earliest, Infinity);
    const readyToRun = progress.some(p => p.eligibleAt !== null && p.eligibleAt <= this.now());
    const stoppedGroups = progress.filter(p => p.problemCodes.includes('similarity_embedding_missing_exhausted')).length;
    const state = this.curate.backgroundError ? 'paused' : !pendingScopes.length ? 'idle' : this.storageFull || this.retryStorageBlocked?.size ? 'limited' : this.work ? 'searching' : readyToRun ? 'waiting' : 'paused';
    const view = this.views.get(viewId);
    return { state, pending, limited: state === 'limited',
      problem: this.curate.backgroundError || (state === 'limited' ? 'Saved check storage is full. Existing results are preserved.' : codes.length ? codes.map(problemMessage).join(' ') : state === 'paused' ? 'Stack checks paused; retrying automatically.' : null),
      problemCodes: codes, failedGroups, stoppedGroups, failedReferences: progress.reduce((n,p) => n + p.failedReferences, 0),
      retryAt: Number.isFinite(retryAt) ? retryAt : null,
      totalGroups: scopes.length, checkedGroups: scopes.length - pendingScopes.length,
      remainingGroups: pendingScopes.length,
      ready: [...new Map([...(view?.groups.values() ?? []), ...groups].map(g => [g.id, g])).values()]
        .filter(g => this.groupStatus(g)?.state === 'updated').length,
      method: CANDIDATE_METHOD, metrics: this.measurements() };
  }
  measurements() {
    const m = this.curate.similarity.metrics;
    return { requests: m.requests, cacheHits: m.cacheHits, failures: m.failures,
      completedSearches: m.completedSearches, lastSearchMs: m.lastSearchMs,
      averageSearchMs: m.completedSearches ? Math.round(m.searchMs / m.completedSearches) : null,
      completedGroups: this.metrics.completedGroups,
      averageCompletionMs: this.metrics.completedGroups
        ? Math.round(this.metrics.completionMs / this.metrics.completedGroups) : null };
  }
  async tick() {
    this.settingsChanged();
    const active = this.active();
    if (this.work) {
      if (!this.enabled() || !active.has(this.running?.id) || !this.valid(this.running)) this.controller?.abort();
      return;
    }
    if (!this.enabled() || this.curate.metadata.work || this.curate.building) return;
    for (const entry of this.entries.values()) if (entry.referenceIds.every(id => Object.hasOwn(entry.rows, id))) {
      if (entry.retryAt > this.now()) continue;
      try {
        if (!this.publish(entry)) return;
        await this.curate.refresh(); this.sync();
      } catch { this.defer(entry); }
    }
    const lane = this.curate.similarity;
    if (lane.owner || lane.work) return;
    this.requests = this.requests.filter(time => time + 60_000 > this.now());
    const priorities = this.priorities();
    // Re-admitted deferred groups join behind existing work at equal priority;
    // source order must not give the same failed group every available turn.
    const entry = [...this.entries.values()].filter(e => active.has(e.id) && this.needed(e) && this.nextReference(e))
      .sort((a, b) => (priorities.get(a.id) ?? 2) - (priorities.get(b.id) ?? 2))[0];
    if (!entry) return;
    const id = this.nextReference(entry);
    // A cached result costs no Immich work and should not wait on network pacing.
    if (!lane.cached(id) && (lane.nextAt > lane.now() || this.requests.length >= REFINEMENT_LIMITS.requestsPerMinute)) return;
    const connection = this.connection;
    this.controller = new AbortController(); this.running = entry;
    const signal = this.controller.signal;
    this.work = (async () => {
      try {
        if (!lane.cached(id)) this.requests.push(this.now());
        const result = await lane.search(id, { signal });
        // Refresh the material snapshot after asynchronous I/O before accepting
        // a result. Search itself additionally checks its source/connection key.
        await this.curate.refresh();
        if (signal.aborted || !this.enabled() || connection !== this.connection ||
            this.entries.get(entry.id) !== entry || !this.valid(entry) || !this.active().has(entry.id)) return;
        const selected = new Set(entry.ids), row = Object.create(null);
        let outside = 0;
        for (const found of result.ids) {
          if (selected.has(found)) row[found] = outside;
          else outside++;
        }
        // Empty successful results are a completed unknown observation, never a
        // mismatch and never an automatic reason to page/retry the search.
        entry.rows[id] = row;
        entry.coverage[id] = { returned: result.ids.length, limit: result.limit, outside };
        entry.failures = 0; entry.retryAt = 0;
        entry.failureCode = null;
        delete entry.errors[id];
        if (Object.keys(entry.errors).length) this.checkpoint(entry);
        else this.retries.delete(entry.id);
        // Publish one complete matrix. A refreshed view must never consume a
        // mixture of queried and not-yet-queried directions from this pass.
        if (entry.referenceIds.every(id => Object.hasOwn(entry.rows, id))) {
          if (this.publish(entry)) await this.curate.refresh();
        }
      } catch (error) {
        if (!signal.aborted && !['similarity_busy', 'similarity_cooldown', 'similarity_reference_changed'].includes(error.code))
          this.defer(entry, error, Object.hasOwn(entry.rows, id) ? null : id);
      } finally { this.controller = null; this.running = null; }
    })();
    try { await this.work; } finally { this.work = null; }
  }
  defer(entry, error, id = null) {
    if (id) {
      const code = problemCode(error), attempts = Math.min((entry.errors[id]?.attempts ?? 0) + 1, 10);
      const missing = code === 'similarity_embedding_missing';
      const delay = Math.min(missing ? REFINEMENT_LIMITS.embeddingRetryMaxMs : REFINEMENT_LIMITS.retryMaxMs,
        (missing ? REFINEMENT_LIMITS.embeddingRetryMs : REFINEMENT_LIMITS.retryMs) * 2 ** (attempts - 1));
      const stopped = missing && attempts >= REFINEMENT_LIMITS.embeddingMaxAttempts;
      entry.errors[id] = { code: stopped ? 'similarity_embedding_missing_exhausted' : code,
        attempts, retryAt: stopped ? null : this.now() + delay };
      // Other reference/global failures yield the whole slot briefly, including
      // untried members. Persisting this pause prevents restart from undoing it.
      // Missing embeddings already have a long per-photo delay and no shared
      // failure cooldown; their remaining members can continue at normal pace.
      if (!missing) entry.retryAt = this.now() + REFINEMENT_LIMITS.retryMs;
    } else {
      entry.failureCode = 'similarity_save_failed';
      entry.retryAt = this.now() + Math.min(REFINEMENT_LIMITS.retryMaxMs,
        REFINEMENT_LIMITS.retryMs * 2 ** Math.min(entry.failures++, 4));
    }
    this.checkpoint(entry);
  }
  publish(entry) {
    if (!this.saved.save(entry, this.now())) { this.storageFull = true; this.storageBlockedId = entry.id; return false; }
    this.storageFull = false;
    this.retries.delete(entry.id);
    this.retryStorageBlocked?.delete(entry.id);
    this.entries.delete(entry.id);
    this.metrics.completedGroups++;
    this.metrics.completionMs += this.now() - entry.admittedAt;
    this.revision++;
    return true;
  }
  async close() {
    this.controller?.abort();
    await this.work?.catch(() => {});
    this.entries.clear(); this.views.clear();
  }
}
