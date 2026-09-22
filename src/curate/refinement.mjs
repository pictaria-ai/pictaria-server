// Bounded, demand-driven composition evidence. This stores only candidate-member
// ranks; unrelated search results stay in the existing short-lived search cache.
import { CANDIDATE_METHOD } from './candidate.mjs';
export const REFINEMENT_LIMITS = Object.freeze({ cohorts: 32, views: 200,
  activeMs: 60_000, cacheMs: 10 * 60_000, requestsPerMinute: 8 });

export class CurateRefinement {
  constructor(curate, { now = Date.now } = {}) {
    this.curate = curate;
    this.now = now;
    this.entries = new Map();
    this.views = new Map();
    this.requests = [];
    this.revision = 0;
    this.connection = curate.similarity.connectionKey();
  }
  enabled() {
    const c = this.curate;
    return !c.closed && c.config.curateBurstGrouping !== false &&
      Boolean(c.immich?.requestJson && c.immich?.baseUrl && c.immich?.apiKey);
  }
  settingsChanged() {
    const connection = this.curate.similarity.connectionKey();
    if (connection !== this.connection || !this.enabled()) {
      this.controller?.abort();
      if (this.entries.size) this.revision++;
      this.entries.clear(); this.views.clear(); this.problem = null;
      this.connection = connection;
    }
  }
  retry() { this.problem = null; }
  expire() {
    // Keep completed evidence for active views, including replacement views.
    // Expiring a matrix and rebuilding it row by row made stacks split/rejoin.
    this.active();
    let changed = false;
    for (const [key, entry] of this.entries) if (entry.touchedAt + REFINEMENT_LIMITS.cacheMs <= this.now()) {
      this.entries.delete(key); changed ||= entry.complete;
    }
    if (changed) this.revision++;
  }
  snapshot() {
    this.settingsChanged(); this.expire();
    return Object.fromEntries([...this.entries].filter(([, e]) => e.complete)
      .map(([id, e]) => [id, { rows: { ...e.rows }, coverage: { ...e.coverage } }]));
  }
  admit(scope) {
    if (!scope?.needsRanks || this.entries.has(scope.id) || this.entries.size >= REFINEMENT_LIMITS.cohorts) return;
    this.entries.set(scope.id, { ...scope, rows: Object.create(null), coverage: Object.create(null), touchedAt: this.now(), complete: false });
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
      if (!scope || !scope.referenceIds.includes(id) || (!scope.needsRanks && !this.entries.has(scope.id))) continue;
      // Retain a bounded representative so a metadata refresh can renew the
      // cohort revision without requiring the user to page through it again.
      if (!view.anchors.has(scope.ids[0]) && view.anchors.size >= REFINEMENT_LIMITS.cohorts) continue;
      view.anchors.add(scope.ids[0]);
      // At most 32 * 40 displayed groups; the group's first member is enough
      // to detect a changed membership ID without retaining whole old stacks.
      if (view.groups.size < REFINEMENT_LIMITS.cohorts * 40)
        view.groups.set(group.id, { id: group.id, ids: [group.ids[0]], route: group.route });
      this.admit(scope);
      const entry = this.entries.get(scope.id);
      if (entry) entry.touchedAt = this.now();
    }
  }
  active() {
    const ids = new Set();
    for (const [id, view] of this.views) {
      if (view.touched + REFINEMENT_LIMITS.activeMs <= this.now()) { this.views.delete(id); continue; }
      try { this.curate.store.getLease(id, 'view'); }
      catch { this.views.delete(id); continue; }
      for (const anchor of view.anchors) {
        const scope = this.curate.current?.scopeByMember?.get(anchor);
        if (scope && (scope.needsRanks || this.entries.has(scope.id))) {
          this.admit(scope); ids.add(scope.id);
          const entry = this.entries.get(scope.id);
          if (entry) entry.touchedAt = this.now();
        }
      }
    }
    return ids;
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
    if (current?.id !== group.id)
      return { state: 'updated' };
    // Every unchanged candidate group is contained in one time scope.
    const scope = this.curate.current?.scopeByMember?.get(first), entry = this.entries.get(scope?.id);
    if (!scope || !current.ids.some(id => scope.referenceIds.includes(id)) || (!scope.needsRanks && !entry))
      return group.route === 'manual-budget' ? { state: 'limited' } : null;
    const total = scope.referenceIds.length, done = Object.keys(entry?.rows ?? {}).length;
    return { state: done === total ? 'checked' : this.problem ? 'paused' :
      !entry ? 'limited' : done || scope.id === this.running?.id ? 'checking' : 'waiting',
      done, total, ...(done === total && current.route === 'candidate-unconfirmed' ? { uncertain: true } : {}) };
  }
  status(viewId, groups = []) {
    const all = this.active(), view = this.views.get(viewId);
    const active = viewId ? new Set([...(view?.anchors ?? []), ...groups.filter(g => this.groupStatus(g)).map(g => g.ids[0])].flatMap(id => {
      const scope = this.curate.current?.scopeByMember?.get(id);
      return scope && (scope.needsRanks || this.entries.has(scope.id)) ? [scope.id] : [];
    })) : all;
    const entries = [...active].map(id => this.entries.get(id)).filter(Boolean);
    const pending = entries.reduce((n, e) => n + e.referenceIds.length - Object.keys(e.rows).length, 0);
    const limited = [...active].some(id => !this.entries.has(id));
    return { state: (pending || limited) && this.problem ? 'paused' :
      this.work && active.has(this.running?.id) ? 'searching' : pending || limited ? 'waiting' : 'idle',
      problem: (pending || limited) ? this.problem ?? null : null, pending, limited,
      totalGroups: active.size, checkedGroups: entries.filter(e => e.complete).length,
      ready: [...(view?.groups.values() ?? [])].filter(g => this.groupStatus(g)?.state === 'updated').length,
      method: CANDIDATE_METHOD };
  }
  async tick() {
    this.settingsChanged(); this.expire();
    const active = this.active();
    if (!this.curate.building) for (const [id, entry] of this.entries) if (!this.valid(entry) || (!entry.complete && !this.needed(entry))) {
      this.entries.delete(id);
      if (entry.complete) this.revision++;
    }
    if (this.work) {
      if (!active.has(this.running?.id) || !this.valid(this.running)) this.controller?.abort();
      return;
    }
    if (!this.enabled() || this.problem || this.curate.metadata.work || this.curate.building) return;
    const lane = this.curate.similarity;
    if (lane.owner || lane.work || lane.nextAt > lane.now()) return;
    this.requests = this.requests.filter(time => time + 60_000 > this.now());
    if (this.requests.length >= REFINEMENT_LIMITS.requestsPerMinute) return;
    const entry = [...active].map(id => this.entries.get(id)).find(e => e && this.needed(e) &&
      e.referenceIds.some(id => !Object.hasOwn(e.rows, id)));
    if (!entry) return;
    const id = entry.referenceIds.find(id => !Object.hasOwn(entry.rows, id));
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
        entry.touchedAt = this.now();
        // Publish one complete matrix. A refreshed view must never consume a
        // mixture of queried and not-yet-queried directions from this pass.
        if (entry.referenceIds.every(id => Object.hasOwn(entry.rows, id))) {
          entry.complete = true;
          this.revision++;
          await this.curate.refresh();
        }
      } catch (error) {
        if (!signal.aborted && !['similarity_busy', 'similarity_cooldown', 'similarity_reference_changed'].includes(error.code))
          this.problem = 'Similarity search paused. You can keep curating; Refresh retries when ready.';
      } finally { this.controller = null; this.running = null; }
    })();
    try { await this.work; } finally { this.work = null; }
  }
  async close() {
    this.controller?.abort();
    await this.work?.catch(() => {});
    this.entries.clear(); this.views.clear();
  }
}
