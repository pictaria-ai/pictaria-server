import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { ImmichApiError } from '../immich.mjs';
import { parseProgressingPage } from '../pagination.mjs';
import { workEligibility } from './eligibility.mjs';

export const DISCOVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS enrich_inventory (
  asset_id TEXT PRIMARY KEY, taken_at TEXT NOT NULL, updated_at INTEGER NOT NULL, eligible INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrich_inventory_selection ON enrich_inventory(eligible, taken_at DESC, asset_id DESC);
CREATE TABLE IF NOT EXISTS enrich_inventory_stage (
  asset_id TEXT PRIMARY KEY, taken_at TEXT NOT NULL, updated_at INTEGER NOT NULL, eligible INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS enrich_discovery (
  id INTEGER PRIMARY KEY CHECK(id=1), source_key TEXT NOT NULL, state_json TEXT NOT NULL,
  lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
);`;

const PAGE_SIZE = 1000;
const RECONCILE_MS = 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const MAX_PAGES = 2000;
const MAX_REFRESH_MS = 10 * 60 * 1000;
const MAX_VALIDATIONS = 10000;
const REJECTION_BURST = 100;
const VISIBILITIES = ['timeline', 'archive', 'hidden'];

export class DiscoveryIncompleteError extends Error {
  constructor() {
    super('Library discovery is incomplete. Progress is saved. Run Enrich again to continue.');
    this.name = 'DiscoveryIncompleteError';
    this.code = 'enrich_discovery_incomplete';
  }
}

function normalize(asset) {
  const updated = typeof asset?.updatedAt === 'string' ? Date.parse(asset.updatedAt) : NaN;
  const takenMs = asset?.fileCreatedAt == null ? null
    : typeof asset.fileCreatedAt === 'string' ? Date.parse(asset.fileCreatedAt) : NaN;
  if (typeof asset?.id !== 'string' || !asset.id || asset.id.length > 200 || !Number.isFinite(updated)
      || (takenMs !== null && !Number.isFinite(takenMs))
      || !['IMAGE', 'VIDEO', 'AUDIO', 'OTHER'].includes(asset.type)
      || !['timeline', 'archive', 'hidden', 'locked'].includes(asset.visibility)
      || typeof asset.isTrashed !== 'boolean') throw new Error('Immich returned incomplete discovery metadata.');
  const taken = takenMs === null ? '' : new Date(takenMs).toISOString();
  return { id: asset.id, taken, updated, eligible: asset.type === 'IMAGE' && asset.visibility === 'timeline' && !asset.isTrashed ? 1 : 0 };
}

// Owns only a rebuildable inventory. Never deletes processing history or human
// decisions. The server's run slot is the primary owner; the durable lease also
// prevents a second process from interleaving refresh transactions.
export class EnrichDiscovery {
  constructor(repo, immich, { shouldStop = () => false, log = () => {}, now = Date.now,
    maxPages = MAX_PAGES, maxRefreshMs = MAX_REFRESH_MS, maxValidations = MAX_VALIDATIONS,
    rejectionBurst = REJECTION_BURST } = {}) {
    Object.assign(this, { repo, immich, shouldStop, log, now, maxPages, maxRefreshMs, maxValidations, rejectionBurst });
    this.db = repo.db;
    this.sourceKey = createHash('sha256').update(JSON.stringify([immich.baseUrl, immich.apiKey])).digest('hex');
    this.lease = randomUUID(); this.owned = false;
    this.after = null; this.buffer = []; this.seen = new Set(); this.reconciled = false;
    this.diagnostics = { pages: 0, scanned: 0, candidates: 0, validated: 0, rejected: 0 };
  }
  state() { return JSON.parse(this.db.prepare('SELECT state_json FROM enrich_discovery WHERE id=1').get().state_json); }
  save(state) {
    const result = this.db.prepare('UPDATE enrich_discovery SET state_json=?, lease_until=? WHERE id=1 AND lease=? AND source_key=?')
      .run(JSON.stringify(state), this.now() + LEASE_MS, this.lease, this.sourceKey);
    if (!result.changes) throw new Error('Enrich discovery ownership changed; start the run again.');
  }
  acquire() {
    this.repo.transaction(() => {
      const row = this.db.prepare('SELECT * FROM enrich_discovery WHERE id=1').get();
      if (row?.lease && row.lease_until > this.now()) throw new Error('Another library discovery is running; try again shortly.');
      if (!row || row.source_key !== this.sourceKey) {
        this.db.exec('DELETE FROM enrich_inventory; DELETE FROM enrich_inventory_stage; DELETE FROM enrich_discovery;');
        this.db.prepare('INSERT INTO enrich_discovery(id,source_key,state_json) VALUES(1,?,?)')
          .run(this.sourceKey, JSON.stringify({ ready: false, watermark: null, fullAt: null, scan: null }));
      }
      this.db.prepare('UPDATE enrich_discovery SET lease=?,lease_until=? WHERE id=1').run(this.lease, this.now() + LEASE_MS);
    });
    this.owned = true;
    // A provider may take longer than the lease. Refresh while this run owns it;
    // crashes stop this heartbeat, allowing a later process to resume.
    this.heartbeat = setInterval(() => {
      try { this.db.prepare('UPDATE enrich_discovery SET lease_until=? WHERE id=1 AND lease=?')
        .run(this.now() + LEASE_MS, this.lease); } catch { /* next checkpoint verifies ownership */ }
    }, 30000);
    this.heartbeat.unref();
  }
  close() {
    clearInterval(this.heartbeat);
    if (this.owned) this.db.prepare('UPDATE enrich_discovery SET lease=NULL,lease_until=0 WHERE id=1 AND lease=?').run(this.lease);
    this.owned = false;
  }
  begin(kind) {
    const state = this.state();
    state.scan = { kind, partition: 0, page: 1, maxUpdated: null,
      // Strict progress avoids replaying an arbitrarily large equal-timestamp
      // boundary on every run. Late same-millisecond updates are reconciled by
      // the daily full pass; local time is NEVER an incremental watermark.
      after: kind === 'delta' && state.watermark !== null ? state.watermark + 1 : null };
    this.repo.transaction(() => { this.db.exec('DELETE FROM enrich_inventory_stage'); this.save(state); });
  }
  async prepare() {
    this.acquire();
    const state = this.state();
    const resumed = !!state.scan;
    if (!state.scan) this.begin(!state.ready || state.fullAt === null || this.now() - state.fullAt >= RECONCILE_MS ? 'full' : 'delta');
    const full = this.state().scan.kind === 'full';
    await this.refresh();
    // A resumed pass may be old. Follow it with a new incremental pass so
    // uploads arriving before its saved offset are not delayed another run.
    if (!this.shouldStop() && (resumed || full)) { this.begin('delta'); await this.refresh(); }
  }
  async refresh() {
    const started = this.now(); let pages = 0;
    while (this.state().scan && !this.shouldStop()) {
      if (pages >= this.maxPages || this.now() - started >= this.maxRefreshMs) throw new DiscoveryIncompleteError();
      const state = this.state(), scan = state.scan;
      const response = await this.immich.searchMetadata({ page: scan.page, size: PAGE_SIZE,
        visibility: VISIBILITIES[scan.partition], ...(scan.kind === 'full' ? { type: 'IMAGE' } : { withDeleted: true }),
        ...(scan.after === null ? {} : { updatedAfter: new Date(scan.after).toISOString() }),
        order: 'desc', withExif: false });
      if (this.shouldStop()) return;
      const items = response?.assets?.items;
      if (!Array.isArray(items) || items.length > PAGE_SIZE || !Object.hasOwn(response.assets, 'nextPage')) {
        throw new Error('Immich returned an invalid discovery page.');
      }
      const next = parseProgressingPage(response.assets.nextPage, scan.page, { label: 'Immich discovery', maxPage: Number.MAX_SAFE_INTEGER });
      if (next !== null && (!items.length || next !== scan.page + 1)) throw new Error('Immich returned an incomplete discovery page sequence.');
      const rows = items.map(normalize);
      this.repo.transaction(() => {
        const insert = this.db.prepare(`INSERT INTO enrich_inventory_stage VALUES(?,?,?,?) ON CONFLICT(asset_id)
          DO UPDATE SET taken_at=excluded.taken_at,updated_at=excluded.updated_at,eligible=excluded.eligible
          WHERE excluded.updated_at >= enrich_inventory_stage.updated_at`);
        for (const row of rows) {
          insert.run(row.id, row.taken, row.updated, row.eligible);
          scan.maxUpdated = Math.max(scan.maxUpdated ?? row.updated, row.updated);
        }
        if (next !== null) scan.page = next;
        else if (scan.kind === 'delta' && scan.partition < VISIBILITIES.length - 1) { scan.partition++; scan.page = 1; }
        else {
          if (scan.kind === 'full') this.db.exec('DELETE FROM enrich_inventory');
          this.db.exec(`INSERT INTO enrich_inventory SELECT * FROM enrich_inventory_stage WHERE true
            ON CONFLICT(asset_id) DO UPDATE SET taken_at=excluded.taken_at,updated_at=excluded.updated_at,eligible=excluded.eligible
            WHERE excluded.updated_at > enrich_inventory.updated_at`);
          if (scan.kind === 'full') state.fullAt = this.now();
          // Full scans contain only timeline images. Keep a later watermark
          // already observed in another visibility partition, including when
          // the entire timeline has since been emptied.
          if (scan.maxUpdated !== null) state.watermark = Math.max(state.watermark ?? scan.maxUpdated, scan.maxUpdated);
          state.ready = true; state.scan = null;
          this.db.exec('DELETE FROM enrich_inventory_stage');
        }
        this.save(state);
      });
      pages++; this.diagnostics.pages++; this.diagnostics.scanned += rows.length;
      if (pages === 1 || pages % 20 === 0) this.log(`Library discovery: ${this.diagnostics.scanned} metadata records scanned; progress saved.`);
      await yieldToLoop();
    }
  }
  candidates(options) {
    const predicate = workEligibility(options);
    const cursor = this.after ? 'AND (i.taken_at < ? OR (i.taken_at = ? AND i.asset_id < ?))' : '';
    const params = this.after ? [this.after.taken_at, this.after.taken_at, this.after.asset_id] : [];
    return this.db.prepare(`SELECT i.asset_id,i.taken_at FROM enrich_inventory i LEFT JOIN assets a ON a.asset_id=i.asset_id
      WHERE i.eligible=1 AND ${predicate.sql} ${cursor} ORDER BY i.taken_at DESC,i.asset_id DESC LIMIT 100`)
      .all(...predicate.params, ...params);
  }
  async next(options) {
    let rejected = 0;
    while (!this.shouldStop()) {
      if (this.diagnostics.validated >= this.maxValidations) throw new DiscoveryIncompleteError();
      if (!this.buffer.length) this.buffer = this.candidates(options);
      const row = this.buffer.shift();
      if (!row) return null;
      this.after = row;
      if (this.seen.has(row.asset_id)) continue;
      this.seen.add(row.asset_id); this.diagnostics.candidates++;
      let asset;
      try { asset = await this.immich.getAsset(row.asset_id); }
      catch (error) {
        if (error instanceof ImmichApiError && (error.status === 404
          || (error.status === 400 && /not found/i.test(error.message)))) asset = null;
        else throw error;
      }
      if (this.shouldStop()) return null;
      this.diagnostics.validated++;
      const current = asset ? normalize(asset) : null;
      if (current && current.id !== row.asset_id) throw new Error('Immich returned the wrong discovery asset.');
      if (current?.eligible) {
        this.save(this.state());
        return asset;
      }
      this.repo.transaction(() => {
        // Also verifies that a different process has not acquired the lease.
        this.save(this.state());
        this.db.prepare('UPDATE enrich_inventory SET eligible=0 WHERE asset_id=?').run(row.asset_id);
        if (!current) this.repo.markAssetsMissing([row.asset_id]);
      });
      rejected++; this.diagnostics.rejected++;
      if (rejected >= this.rejectionBurst && !this.reconciled) {
        this.log('Library changed during discovery; refreshing the inventory before continuing.');
        this.begin('full'); await this.refresh();
        if (this.shouldStop()) return null;
        this.reconciled = true; this.buffer = []; this.after = null;
      }
    }
    return null;
  }
  summary() {
    const d = this.diagnostics;
    return `Library discovery: ${d.pages} metadata pages, ${d.scanned} scanned, ${d.candidates} candidates, ${d.validated} validated, ${d.rejected} rejected.`;
  }
}
