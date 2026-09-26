import { reviewConfig } from '../enrich/reviewBuckets.mjs';
import { Worker } from 'node:worker_threads';
import { groupPhotos } from './grouping.mjs';
import { settledCandidateGroups, rememberSettledGroups } from './settled-groups.mjs';
import { CurateRefinement } from './refinement.mjs';
import { CurateError } from './contracts.mjs';
import { CurateMetadataRefresher } from './metadata.mjs';
import { StackingLab } from './lab.mjs';
import { CurateSimilaritySearch } from './similarity.mjs';

export class CurateService {
  constructor({ repo, config = {}, immich = null, metadataOptions = {}, candidateOptions = {}, review = null }) {
    this.repo = repo;
    this.review = review;
    this.store = repo.curate;
    this.config = config;
    this.immich = immich;
    this.current = null;
    this.building = null;
    this.worker = null;
    this.closed = false;
    this.metrics = { maxProjectionSliceMs: 0, rebuildMs: 0 };
    this.abort = new AbortController();
    this.metadata = new CurateMetadataRefresher({ curate: this, ...metadataOptions });
    this.similarity = new CurateSimilaritySearch({ curate: this });
    this.lab = new StackingLab(this);
    this.candidateEnabled = candidateOptions.enabled === true;
    this.refinement = this.candidateEnabled ? new CurateRefinement(this, candidateOptions) : null;
    if (this.candidateEnabled) this.repo.db.prepare(`INSERT OR IGNORE INTO curate_dirty(asset_id)
      SELECT asset_id FROM curate_photos WHERE json_type(evidence_json,'$.category') IS NULL`).run();
  }
  async refresh() {
    if (this.closed) throw new CurateError('Curate is stopping.', 'curate_unavailable', 503);
    if (this.building) {
      await this.building;
      // A background worker may have taken its read snapshot before the caller
      // saved/undid a decision. Do not open a replacement view from that older
      // result. This also catches newly queued source changes during the read.
      if (this.current?.generation !== this.store.generation() ||
          this.current.stacks !== (this.config.curateBurstGrouping !== false) ||
          this.current.evidenceRevision !== (this.refinement?.revision ?? 0) ||
          this.repo.db.prepare('SELECT 1 FROM curate_dirty LIMIT 1').get()) return this.refresh();
      return this.current;
    }
    this.building = this.rebuild().finally(() => {
      this.building = null;
    });
    return this.building;
  }
  async rebuild() {
    const start = performance.now();
    await this.store.flush({
      signal: this.abort.signal,
      onSlice: (ms) => {
        this.metrics.maxProjectionSliceMs = Math.max(ms, this.metrics.maxProjectionSliceMs);
      },
    });
    const stacks = this.config.curateBurstGrouping !== false;
    this.refinement?.settingsChanged();
    const evidenceRevision = this.refinement?.revision ?? 0;
    if (this.current?.generation === this.store.generation() && this.current.stacks === stacks &&
        this.current.evidenceRevision === evidenceRevision) return this.current;
    let result;
    if (this.repo.databasePath === ':memory:') {
      // test-only SQLite cannot be shared with a read-only worker
      result = {
        generation: this.store.generation(),
        ...(this.candidateEnabled ? settledCandidateGroups(this.store, { stacks, connection: this.refinement?.connection })
          : groupPhotos(this.store.pending(), { stacks, separations: this.store.separations() })),
      };
    } else
      result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
          workerData: { path: this.repo.databasePath, stacks, candidate: this.candidateEnabled, rankConnection: this.refinement?.connection },
          // Server/test-runner flags (including --input-type) need not be valid worker flags.
          execArgv: [],
        });
        this.worker = worker;
        let received;
        worker.once('message', (value) => {
          received = value;
        });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          if (this.worker === worker) this.worker = null;
          if (code !== 0 || !received) reject(Error('Curate rebuild worker stopped.'));
          else resolve(received);
        });
      });
    this.abort.signal.throwIfAborted();
    if (this.refinement) result.retentionLimited = await rememberSettledGroups(this.store, this.refinement.saved, result, this.refinement.now());
    this.abort.signal.throwIfAborted();
    // No await between complete replacement and publication. A concurrent
    // source change remains queued in curate_dirty for the next rebuild.
    const byId = new Map(),
      byMember = new Map();
    for (const group of result.groups) {
      byId.set(group.id, group);
      for (const id of group.ids) byMember.set(id, group);
    }
    const scopeByMember = new Map();
    for (const scope of result.scopes ?? []) for (const id of scope.ids) scopeByMember.set(id, scope);
    this.current = { ...result, stacks, byId, byMember, scopeByMember, evidenceRevision };
    this.metrics.rebuildMs = performance.now() - start;
    return this.current;
  }
  async openView({ kind = 'all', search = '', sort = 'oldest', section = 'pending', category = 'all', replacesViewId = null } = {}) {
    if (!['pending', 'decided'].includes(section) || typeof category !== 'string' ||
        !['all', ...this.categories().map(b => b.id)].includes(category) ||
        !['all', 'stacks', 'singles'].includes(kind) || !['oldest', 'newest'].includes(sort) ||
        typeof search !== 'string' || search.length > 200)
      throw new CurateError('Invalid Curate filter.', 'invalid_curate_query', 400);
    if (
      replacesViewId !== null &&
      (typeof replacesViewId !== 'string' || !replacesViewId || replacesViewId.length > 128)
    )
      throw new CurateError('Invalid previous Curate view.', 'invalid_curate_query', 400);
    const current = await this.refresh();
    this.start();
    const rows = section === 'pending' && category !== 'all' ? this.review?.reviewRows() ?? [] : [];
    const byPhoto = new Map(rows.map(row => [row.assetId, row]));
    // Decided photos are individual human outcomes, never pending stacks.
    let groups = section === 'decided'
      ? this.repo.db.prepare(`SELECT asset_id,captured_ms FROM curate_photos
          WHERE state<>'undecided' AND availability<>'unavailable'
          ORDER BY captured_ms IS NULL,captured_ms,asset_id`).all().map(row => ({
            id: `single:decided:${row.asset_id}`, ids: [row.asset_id], capturedMs: row.captured_ms, route: 'decided',
          }))
      : current.groups.filter(g => kind === 'all' || (g.ids.length > 1) === (kind === 'stacks'));
    if (section === 'pending' && category !== 'all') {
      // Categories select whole comparisons. A mixed stack belongs to the
      // highest-priority category earned by any member, as in released Curate.
      const priority = new Map(this.categories().map((b, i) => [b.id, i]));
      groups = groups.filter(g => g.ids.map(id => byPhoto.get(id)?.bucket ?? 'candidates')
        .sort((a,b) => (priority.get(a) ?? Infinity) - (priority.get(b) ?? Infinity))[0] === category);
    }
    if (search.trim()) {
      const term = '%' + search.trim().toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%';
      const matches = new Set(this.repo.db.prepare(`SELECT p.asset_id FROM curate_photos p JOIN assets a ON a.asset_id=p.asset_id
        LEFT JOIN latest_success ls ON ls.asset_id=p.asset_id WHERE
        (lower(a.original_path) LIKE ? ESCAPE '\\' OR lower(ls.short_caption) LIKE ? ESCAPE '\\'
        OR EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=p.asset_id AND lower(t.tag) LIKE ? ESCAPE '\\'))`)
        .all(term, term, term).map(r => r.asset_id));
      groups = groups.filter(g => g.ids.some(id => matches.has(id)));
    }
    // Grouping emits comparisons in earliest-capture order, with equal dates
    // resolved by the first member's ID. Reverse only the dated groups: unknown
    // dates stay last. This linear pass leaves membership/member order intact.
    if (sort === 'newest') {
      const dated = [], undated = [];
      for (const group of groups) (group.capturedMs === null ? undated : dated).push(group);
      groups = dated.reverse().concat(undated);
    }
    // Paging stores order/whole memberships, not expanded photos/provenance.
    // Capacity failure is explicit; no page silently drops part of a stack.
    const lease = await this.store.createView(section === 'decided' ? { ...current, method: 'decided' } : current, groups, { replacesViewId, sort, section, category });
    this.metadata.wake();
    return this.page(lease.id);
  }
  categories() {
    return reviewConfig(this.review?.taxonomy ?? {}).buckets.sort((a,b) =>
      a.id === 'candidates' ? -1 : b.id === 'candidates' ? 1 : a.fallback ? -1 : b.fallback ? 1 : 0)
      .map(({id,label}) => ({id,label}));
  }
  page(viewId, offset = 0, limit = 50, attention = null) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new CurateError('Invalid Curate page.', 'invalid_curate_query', 400);
    const view = this.store.getLease(viewId, 'view');
    const groups = this.store.viewGroups(viewId, offset, limit);
    let visible = groups, comparison = null;
    if (attention !== null) {
      const ids = attention?.visibleGroupIds, focus = attention?.comparisonGroupId ?? null;
      if (!Array.isArray(ids) || ids.length > 50 || new Set(ids).size !== ids.length ||
          ids.some(id => typeof id !== 'string' || !id || id.length > 128) ||
          (focus !== null && (typeof focus !== 'string' || !focus || focus.length > 128)))
        throw new CurateError('Invalid Curate attention.', 'invalid_curate_query', 400);
      const lookup = id => {
        const group = this.store.viewGroup(viewId, id);
        if (!group) throw new CurateError('Group is not in this view.', 'curate_group_missing', 404);
        return group;
      };
      visible = ids.map(lookup);
      comparison = focus === null ? null : lookup(focus);
    }
    if (view.section !== 'decided') this.refinement?.demand(viewId, groups);
    if (view.section !== 'decided') this.refinement?.attention(viewId, visible, comparison);
    const refinement = this.refinement?.status(viewId, view.section === 'decided' ? [] : groups) ?? null;
    return {
      viewId,
      expiresAt: view.expiresAt,
      total: view.total,
      counts: view.counts ?? null,
      sort: view.sort ?? 'oldest',
      section: view.section ?? 'pending', category: view.category ?? 'all', categories: this.categories(),
      immichUrl: this.config.immichPublicUrl || null,
      offset,
      metadata: this.metadata.status(),
      refinement,
      updatesAvailable:
        view.generation !== this.store.generation() ||
        Boolean(refinement?.ready) ||
        view.stacks !== (this.config.curateBurstGrouping !== false) ||
        Boolean(this.repo.db.prepare('SELECT 1 FROM curate_dirty LIMIT 1').get()),
      groups: groups.map((g) => ({ id: g.id, memberCount: g.ids.length, route: g.route,
          similarity: view.section === 'decided' ? null : this.refinement?.groupStatus(g) ?? null,
          photos: this.store.covers(g.ids.slice(0, 3)) })),
      nextOffset: offset + limit < view.total ? offset + limit : null,
    };
  }
  comparison(viewId, groupId) {
    const view = this.store.getLease(viewId, 'view');
    const group = this.store.viewGroup(view.id, groupId);
    if (!group) throw new CurateError('Group is not in this view.', 'curate_group_missing', 404);
    const reviewState = view.section === 'decided' ? 'decided' : 'pending';
    this.assertDecisionScope(group.ids, reviewState);
    const material = this.store.material(group.ids, reviewState);
    if (this.store.pendingScopeChanges(group.ids)) throw new CurateError('This stack is updating. Refresh Curate.');
    const context = reviewState === 'decided' ? { ids: [], omitted: false } : this.store.context(group.ids);
    this.store.metadata.request(context.ids, this.metadata.now());
    this.metadata.wake();
    const lease = this.store.comparisonLease(viewId, {
      groupId,
      ...(reviewState === 'decided' ? { reviewState } : {}),
      ids: group.ids,
      material,
      mode: 'manual',
      contextIds: context.ids,
      contextOmitted: context.omitted,
    });
    if (reviewState !== 'decided') this.refinement?.attention(viewId, null, group);
    return {
      ...lease,
      photos: this.store.details(group.ids.slice(0, 50)),
      photoNextOffset: group.ids.length > 50 ? 50 : null,
      context: this.store.details(context.ids),
      contextReadOnly: true,
      automaticKeeperEligible: group.ids.length >= 2,
      algorithm: view.method,
      similarity: this.refinement?.groupStatus(group) ?? null,
      // Reasons use the applicable current calculation. Old view membership is
      // never replaced by a newer machine proposal when a comparison opens.
      reasons: this.current?.byId.get(groupId)?.reasons ?? ['Membership preserved from the opened Curate view.'],
    };
  }
  comparisonPhotos(comparisonId, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new CurateError('Invalid comparison page.', 'invalid_curate_query', 400);
    const comparison = this.store.assertComparison(comparisonId);
    this.assertDecisionScope(comparison.ids, comparison.reviewState, comparison.singlesOnly);
    if (this.store.pendingScopeChanges(comparison.ids))
      throw new CurateError('This stack is updating. Refresh Curate.');
    return {
      comparisonId,
      total: comparison.ids.length,
      offset,
      photos: this.store.details(comparison.ids.slice(offset, offset + limit)),
      nextOffset: offset + limit < comparison.ids.length ? offset + limit : null,
    };
  }
  assertMembership(ids) {
    const inspected = new Set(ids);
    if (
      !this.current ||
      ids.some(
        (id) =>
          !this.current.byMember.has(id) || this.current.byMember.get(id).ids.some((member) => !inspected.has(member)),
      )
    ) {
      throw new CurateError('Comparison membership changed. Refresh Curate.');
    }
  }
  async separate(leaseId, partitions, action = null) {
    // A committed receipt is independent of lease expiry, current membership,
    // and rebuild health. Replay must not require a new scope or remote work.
    if (this.store.correction(leaseId)) return this.store.separate(leaseId, partitions, Date.now(), action);
    await this.refresh();
    if (this.store.correction(leaseId)) return this.store.separate(leaseId, partitions, Date.now(), action);
    const lease = this.store.getLease(leaseId, 'comparison');
    // A machine split of the same inspected set is fine; additions are not.
    // Current per-photo human/input checks still run inside the transaction.
    this.store.assertComparison(leaseId);
    this.assertMembership(lease.ids);
    if (this.store.pendingScopeChanges(lease.ids)) throw new CurateError('This stack is updating. Refresh Curate.');
    const result = this.store.separate(leaseId, partitions, Date.now(), action);
    if (!this.closed) await this.refresh();
    return result;
  }
  async reset(id, revision, { undo = false } = {}) {
    const result = this.store.resetSeparation(id, revision, Date.now(), { undo });
    if (!this.closed) await this.refresh();
    return result;
  }
  async selection(viewId, groupIds) {
    if (!Array.isArray(groupIds) || !groupIds.length || groupIds.length > 1000 ||
        new Set(groupIds).size !== groupIds.length || groupIds.some(id => typeof id !== 'string' || id.length > 128))
      throw new CurateError('Select up to 1,000 shown single photos.', 'invalid_curate_query', 400);
    await this.refresh();
    const view = this.store.getLease(viewId, 'view');
    const groups = groupIds.map(id => this.store.viewGroup(viewId, id));
    if (groups.some(g => !g || g.ids.length !== 1))
      throw new CurateError('Bulk actions apply only to shown single photos.', 'invalid_curate_query', 400);
    const ids = groups.flatMap(g => g.ids), reviewState = view.section === 'decided' ? 'decided' : 'pending';
    this.assertDecisionScope(ids, reviewState);
    if (reviewState === 'pending' && ids.some(id => this.current.byMember.get(id)?.ids.length !== 1))
      throw new CurateError('A selected photo is now in a stack. Refresh Curate.');
    const material = this.store.material(ids, reviewState);
    return this.store.comparisonLease(viewId, { ids, material, reviewState, singlesOnly: true, mode: 'manual', contextIds: [] });
  }
  async issueDecision(comparisonId, mode = 'manual') {
    await this.refresh();
    const comparison = this.store.assertComparison(comparisonId);
    this.assertDecisionScope(comparison.ids, comparison.reviewState, comparison.singlesOnly);
    return this.repo.decisions.issue(comparison, mode);
  }
  assertDecisionScope(ids, reviewState = 'pending', singlesOnly = false) {
    if (reviewState === 'decided') {
      if (ids.some(id => !this.store.photo(id) || this.store.photo(id).state === 'undecided'))
        throw new CurateError('A decided photo changed. Refresh Curate.');
    } else {
      this.assertMembership(ids);
      if (singlesOnly && ids.some(id => this.current.byMember.get(id)?.ids.length !== 1))
        throw new CurateError('A selected photo is now in a stack. Refresh Curate.');
    }
    if (this.store.pendingScopeChanges(ids)) throw new CurateError('This stack is updating. Refresh Curate.');
  }
  async applyDecision(input) {
    const replay = this.repo.decisions.replay(input);
    if (replay) return replay;
    // Undo checks human state/availability, and need not rebuild groupings.
    if (input.kind !== 'undo') await this.refresh();
    return this.repo.decisions.apply(input, (ids, reviewState, singlesOnly) => this.assertDecisionScope(ids, reviewState, singlesOnly));
  }
  async backgroundTick() {
    if (this.backgroundWork || this.closed) return;
    this.backgroundWork = (async () => {
      this.metadata.settingsChanged();
      if (!this.refinement?.enabled() && !this.metadata.demanded() && !this.aiLifecycle?.pending.size && !this.aiLifecycle?.active) return;
      await this.refresh();
      this.metadata.wake();
      await this.refinement?.tick();
      this.aiLifecycle?.tick();
      if (Date.now() >= (this.nextAiMaintenance ?? 0)) {
        this.aiLifecycle?.maintain();
        this.nextAiMaintenance = Date.now() + 60_000;
      }
    })();
    try { await this.backgroundWork; this.backgroundError = null; }
    catch { this.backgroundError = 'Curate checks paused. Background processing will retry.'; }
    finally { this.backgroundWork = null; }
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.backgroundTick(); }, 1000);
    void this.backgroundTick();
    this.timer.unref();
  }
  settingsChanged() {
    this.metadata.settingsChanged();
    this.similarity.settingsChanged();
    this.refinement?.settingsChanged();
    this.aiLifecycle?.settingsChanged();
  }
  requestMetadataRefresh(ids) {
    this.store.metadata.request(ids, this.metadata.now(), { force: true });
    this.metadata.wake();
    return this.metadata.status();
  }
  async close() {
    clearInterval(this.timer);
    this.closed = true;
    this.aiLifecycle?.close();
    this.abort.abort();
    await this.similarity.close();
    await this.refinement?.close();
    await this.lab.close();
    await this.metadata.close();
    if (this.worker) await this.worker.terminate();
    await this.building?.catch(() => {});
    await this.backgroundWork?.catch(() => {});
  }
}
