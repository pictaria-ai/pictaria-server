import { Worker } from 'node:worker_threads';
import { groupPhotos } from './grouping.mjs';
import { CurateError } from './contracts.mjs';
import { setImmediate } from 'node:timers/promises';

export class CurateService {
  constructor({ repo, config = {}, immich = null }) {
    this.repo = repo;
    this.store = repo.curate;
    this.config = config;
    this.immich = immich;
    this.current = null;
    this.building = null;
    this.worker = null;
    this.closed = false;
    this.metrics = { maxProjectionSliceMs: 0, rebuildMs: 0 };
    this.abort = new AbortController();
  }
  async refresh() {
    if (this.closed) throw new CurateError('Curate is stopping.', 'curate_unavailable', 503);
    if (this.building) return this.building;
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
    if (this.current?.generation === this.store.generation() && this.current.stacks === stacks) return this.current;
    let result;
    if (this.repo.databasePath === ':memory:') {
      // test-only SQLite cannot be shared with a read-only worker
      result = {
        generation: this.store.generation(),
        ...groupPhotos(this.store.pending(), { stacks, separations: this.store.separations() }),
      };
    } else
      result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
          workerData: { path: this.repo.databasePath, stacks },
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
    // No await between complete replacement and publication. A concurrent
    // source change remains queued in curate_dirty for the next rebuild.
    const byId = new Map(),
      byMember = new Map();
    for (const group of result.groups) {
      byId.set(group.id, group);
      for (const id of group.ids) byMember.set(id, group);
    }
    this.current = { ...result, stacks, byId, byMember };
    this.metrics.rebuildMs = performance.now() - start;
    return this.current;
  }
  async openView({ kind = 'all', search = '', replacesViewId = null } = {}) {
    if (!['all', 'stacks', 'singles'].includes(kind) || typeof search !== 'string' || search.length > 200)
      throw new CurateError('Invalid Curate filter.', 'invalid_curate_query', 400);
    if (
      replacesViewId !== null &&
      (typeof replacesViewId !== 'string' || !replacesViewId || replacesViewId.length > 128)
    )
      throw new CurateError('Invalid previous Curate view.', 'invalid_curate_query', 400);
    const current = await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refresh().catch(() => {
          this.backgroundError = 'Curate refresh failed; the previous view is still available.';
        });
      }, 1000);
      this.timer.unref();
    }
    let groups = current.groups.filter((g) => kind === 'all' || g.ids.length > 1 === (kind === 'stacks'));
    if (search.trim()) {
      const term =
        '%' + search.trim().toLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_') + '%';
      const matches = new Set(
        this.repo.db
          .prepare(
            `SELECT p.asset_id FROM curate_photos p JOIN assets a ON a.asset_id=p.asset_id
        LEFT JOIN latest_success ls ON ls.asset_id=p.asset_id WHERE p.state='undecided' AND
        (lower(a.original_path) LIKE ? ESCAPE '\\' OR lower(ls.short_caption) LIKE ? ESCAPE '\\'
        OR EXISTS(SELECT 1 FROM asset_tags t WHERE t.asset_id=p.asset_id AND lower(t.tag) LIKE ? ESCAPE '\\'))`,
          )
          .all(term, term, term)
          .map((r) => r.asset_id),
      );
      groups = groups.filter((g) => g.ids.some((id) => matches.has(id)));
    }
    // Paging stores order/whole memberships, not expanded photos/provenance.
    // Capacity failure is explicit; no page silently drops part of a stack.
    const lease = await this.store.createView(current, groups, { replacesViewId });
    return this.page(lease.id);
  }
  page(viewId, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new CurateError('Invalid Curate page.', 'invalid_curate_query', 400);
    const view = this.store.getLease(viewId, 'view');
    return {
      viewId,
      expiresAt: view.expiresAt,
      total: view.total,
      offset,
      updatesAvailable:
        view.generation !== this.store.generation() ||
        view.stacks !== (this.config.curateBurstGrouping !== false) ||
        Boolean(this.repo.db.prepare('SELECT 1 FROM curate_dirty LIMIT 1').get()),
      groups: this.store
        .viewGroups(viewId, offset, limit)
        .map((g) => ({ id: g.id, memberCount: g.ids.length, route: g.route })),
      nextOffset: offset + limit < view.total ? offset + limit : null,
    };
  }
  comparison(viewId, groupId) {
    const view = this.store.getLease(viewId, 'view');
    const group = this.store.viewGroup(view.id, groupId);
    if (!group) throw new CurateError('Group is not in this view.', 'curate_group_missing', 404);
    this.assertMembership(group.ids);
    const material = this.store.material(group.ids);
    if (this.store.pendingScopeChanges(group.ids)) throw new CurateError('This stack is updating. Refresh Curate.');
    const context = this.store.context(group.ids);
    const lease = this.store.comparisonLease(viewId, {
      groupId,
      ids: group.ids,
      material,
      mode: 'manual',
      contextIds: context.ids,
      contextOmitted: context.omitted,
    });
    return {
      ...lease,
      photos: this.store.details(group.ids.slice(0, 50)),
      photoNextOffset: group.ids.length > 50 ? 50 : null,
      context: this.store.details(context.ids),
      contextReadOnly: true,
      automaticKeeperEligible: group.ids.length >= 2,
      // Reasons use the applicable current calculation. Old view membership is
      // never replaced by a newer machine proposal when a comparison opens.
      reasons: this.current?.byId.get(groupId)?.reasons ?? ['Membership preserved from the opened Curate view.'],
    };
  }
  comparisonPhotos(comparisonId, offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new CurateError('Invalid comparison page.', 'invalid_curate_query', 400);
    const comparison = this.store.assertComparison(comparisonId);
    this.assertMembership(comparison.ids);
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
  async separate(leaseId, partitions) {
    // A committed receipt is independent of lease expiry, current membership,
    // and rebuild health. Replay must not require a new scope or remote work.
    if (this.store.correction(leaseId)) return this.store.separate(leaseId, partitions);
    await this.refresh();
    if (this.store.correction(leaseId)) return this.store.separate(leaseId, partitions);
    const lease = this.store.getLease(leaseId, 'comparison');
    // A machine split of the same inspected set is fine; additions are not.
    // Current per-photo human/input checks still run inside the transaction.
    this.store.assertComparison(leaseId);
    this.assertMembership(lease.ids);
    if (this.store.pendingScopeChanges(lease.ids)) throw new CurateError('This stack is updating. Refresh Curate.');
    const result = this.store.separate(leaseId, partitions);
    if (!this.closed) await this.refresh();
    return result;
  }
  async reset(id, revision, { undo = false } = {}) {
    const result = this.store.resetSeparation(id, revision, Date.now(), { undo });
    if (!this.closed) await this.refresh();
    return result;
  }
  // Explicit bounded background adapter for missing/re-check evidence. Ordinary
  // list/page/comparison reads never perform remote per-card fetches. Existing
  // Enrich/Curate ingestion automatically records metadata they already fetch.
  async refreshMetadata(ids) {
    if (this.metadataWork) throw new CurateError('A metadata refresh is already running.', 'curate_busy', 409);
    const work = this.runMetadataRefresh(ids);
    this.metadataWork = work;
    try {
      return await work;
    } finally {
      if (this.metadataWork === work) this.metadataWork = null;
    }
  }
  async runMetadataRefresh(ids) {
    if (
      !Array.isArray(ids) ||
      ids.length > 500 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !id || id.length > 128)
    )
      throw new CurateError('Metadata refresh needs at most 500 distinct photos.', 'invalid_curate_query', 400);
    if (!this.immich) throw new CurateError('Immich is not configured.', 'curate_unavailable', 503);
    const members = this.repo.reviewListMembership(ids);
    if (members.size !== ids.length) throw new CurateError('Metadata refresh must target review photos.');
    let cursor = 0,
      failedBatch = false;
    const result = { updated: 0, unavailable: 0 };
    const work = async () => {
      while (cursor < ids.length && !this.closed && !failedBatch) {
        const id = ids[cursor++];
        try {
          const asset = await this.immich.getAsset(id);
          if (asset?.id !== id) throw Error('Immich returned a different photo.');
          if (this.closed) return;
          this.repo.transaction(() => this.repo.upsertAsset(asset));
          result.updated++;
        } catch (error) {
          if (this.closed) return;
          if (error.status === 404 || error.status === 410) {
            this.repo.db
              .prepare('UPDATE assets SET missing_since=? WHERE asset_id=?')
              .run(new Date().toISOString(), id);
            result.unavailable++;
          } else {
            failedBatch = true;
            throw error;
          } // transport/auth failure is not evidence of deletion
        }
        await setImmediate();
      }
    };
    const outcomes = await Promise.allSettled([work(), work()]);
    const failed = outcomes.find((o) => o.status === 'rejected');
    if (failed) throw failed.reason;
    if (!this.closed) await this.refresh();
    return result;
  }
  async close() {
    clearInterval(this.timer);
    this.closed = true;
    this.abort.abort();
    if (this.worker) await this.worker.terminate();
    await this.building?.catch(() => {});
  }
}
