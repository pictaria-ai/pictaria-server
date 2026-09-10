// PIC-311 feasibility prototype. Synthetic databases only; no production imports
// this module. The source adapter is deliberately NOT an Immich implementation.
// See docs/ENRICH-DISCOVERY-PROTOTYPE.md for unproven upstream guarantees.
export class DiscoveryPrototype {
  constructor(repo, { historySchema = 'main', enrichRepo = repo } = {}) {
    if (!['main', 'enrich_history'].includes(historySchema)) throw Error('Unknown prototype history schema');
    this.historySchema = historySchema; this.enrichRepo = enrichRepo;
    this.repo = repo;
    this.db = repo.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prototype_inventory (
        asset_id TEXT PRIMARY KEY, taken_at TEXT, updated_at INTEGER NOT NULL,
        eligible INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prototype_inventory_order
        ON prototype_inventory(eligible, taken_at DESC, asset_id DESC);
      CREATE TABLE IF NOT EXISTS prototype_stage (
        asset_id TEXT PRIMARY KEY, taken_at TEXT, updated_at INTEGER NOT NULL,
        eligible INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prototype_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO prototype_state VALUES (1, '{"ready":false,"watermark":0,"scan":null}');
    `);
  }
  state() { return JSON.parse(this.db.prepare('SELECT value FROM prototype_state WHERE id=1').get().value); }
  save(state) { this.db.prepare('UPDATE prototype_state SET value=? WHERE id=1').run(JSON.stringify(state)); }
  begin(kind = 'full') {
    if (!['full', 'delta'].includes(kind)) throw Error('Unknown scan kind');
    const state = this.state();
    if (state.scan) throw Error('Resume the unfinished scan first');
    if (kind === 'delta' && !state.ready) throw Error('Full inventory required');
    // Source timestamps only. Empty delta passes do not advance the watermark.
    state.scan = { kind, page: 1, after: kind === 'delta' ? Math.max(0, state.watermark - 1000) : null,
      maxUpdated: state.watermark, rows: 0 };
    this.repo.transaction(() => { this.db.exec('DELETE FROM prototype_stage'); this.save(state); });
  }
  async step(source, { maxPages = 2, pageSize = 1000 } = {}) {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100 ||
        !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw Error('Invalid page budget');
    let pages = 0;
    while (this.state().scan && pages < maxPages) {
      const state = this.state(), scan = state.scan;
      if (scan.pageSize && scan.pageSize !== pageSize) throw Error('Resume with the same page size');
      scan.pageSize = pageSize;
      const page = await source.scan({ page: scan.page, size: pageSize, updatedAfter: scan.after });
      if (!Array.isArray(page.items) || page.items.length > pageSize ||
          (page.nextPage !== null && (!Number.isInteger(page.nextPage) || page.nextPage <= scan.page))) {
        throw Error('Invalid upstream page');
      }
      const rows = page.items.map(asset => {
        if (typeof asset.id !== 'string' || !asset.id || !Number.isSafeInteger(asset.updatedAt) || asset.updatedAt < 0 ||
            (asset.takenAt !== null && (typeof asset.takenAt !== 'string' || !Number.isFinite(Date.parse(asset.takenAt))))) {
          throw Error('Invalid upstream asset');
        }
        return { ...asset, eligible: isEligible(asset) ? 1 : 0 };
      });
      this.repo.transaction(() => {
        const insert = this.db.prepare(`INSERT INTO prototype_stage VALUES(?,?,?,?)
          ON CONFLICT(asset_id) DO UPDATE SET taken_at=excluded.taken_at,
          updated_at=excluded.updated_at, eligible=excluded.eligible
          WHERE excluded.updated_at >= prototype_stage.updated_at`);
        for (const row of rows) {
          insert.run(row.id, row.takenAt, row.updatedAt, row.eligible);
          scan.maxUpdated = Math.max(scan.maxUpdated, row.updatedAt);
        }
        scan.rows += rows.length;
        scan.page = page.nextPage;
        if (scan.page === null) {
          if (scan.kind === 'full') this.db.exec('DELETE FROM prototype_inventory');
          this.db.exec(`INSERT INTO prototype_inventory SELECT * FROM prototype_stage WHERE true
            ON CONFLICT(asset_id) DO UPDATE SET taken_at=excluded.taken_at,
            updated_at=excluded.updated_at, eligible=excluded.eligible
            WHERE excluded.updated_at > prototype_inventory.updated_at`);
          state.ready = true; state.watermark = scan.maxUpdated;
          state.lastScan = { kind: scan.kind, rows: scan.rows }; state.scan = null;
          this.db.exec('DELETE FROM prototype_stage');
        }
        this.save(state);
      });
      pages++;
    }
    return { pages, complete: !this.state().scan };
  }
  candidates({ runKey, onlyUnenriched = true, maxFailures = 2, limit = 50, after = null }) {
    if (!this.state().ready) throw Error('Inventory incomplete; no completeness claim is possible');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(maxFailures) || maxFailures < 0) throw Error('Invalid selection budget');
    // Prototype-only mirror, checked against Repository.assetIdsNeedingWork.
    // Production should share an eligibility builder with that repository API.
    const match = runKey.inferenceId ? { sql: 'p.inference_id = ?', args: [runKey.inferenceId] }
      : { sql: 'p.provider=? AND p.model=? AND p.prompt_version=? AND p.taxonomy_version=?',
        args: [runKey.provider, runKey.model, runKey.promptVersion, runKey.taxonomyVersion] };
    const success = onlyUnenriched ? '1=1' : match.sql;
    const args = onlyUnenriched ? [] : [...match.args];
    const failures = maxFailures ? `AND (SELECT COUNT(*) FROM ${this.historySchema}.processing_runs p
      WHERE p.asset_id=i.asset_id AND p.status='failed' AND ${match.sql}) < ?` : '';
    if (maxFailures) args.push(...match.args, maxFailures);
    // ISO capture timestamps; null dates last, with deterministic ID ties.
    const cursor = after ? `AND (COALESCE(i.taken_at,'') < ? OR (COALESCE(i.taken_at,'') = ? AND i.asset_id < ?))` : '';
    if (after) args.push(after.taken_at ?? '', after.taken_at ?? '', after.asset_id);
    return this.db.prepare(`SELECT i.* FROM prototype_inventory i
      LEFT JOIN ${this.historySchema}.assets a ON a.asset_id=i.asset_id
      WHERE i.eligible=1 AND a.enrich_discarded_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM ${this.historySchema}.processing_runs p WHERE p.asset_id=i.asset_id AND p.status='succeeded' AND ${success})
      ${failures} ${cursor} ORDER BY i.taken_at DESC, i.asset_id DESC LIMIT ?`).all(...args, limit);
  }
  async run(source, options, { process, sendToCurate = false }) {
    // Simulated dispatch contract only: no provider/scheduler integration.
    const result = await this.select(source, options); let succeeded = 0, failed = 0, listed = 0;
    for (const asset of result.selected) {
      const outcome = await process(asset);
      if (outcome === 'succeeded') {
        succeeded++;
        if (sendToCurate) listed += this.enrichRepo.reviewListAdd([asset.id], 'enrich');
      } else failed++;
    }
    return { ...result, succeeded, failed, listed };
  }
  async select(source, options) {
    const selected = []; let after = null, candidates = 0, validated = 0;
    // Budget validation separately; rejecting candidates never consumes the AI budget.
    const maxValidations = options.maxValidations ?? 1000;
    while (selected.length < options.limit && validated < maxValidations) {
      const rows = this.candidates({ ...options, after, limit: Math.min(100, maxValidations - validated) });
      if (!rows.length) break;
      for (const row of rows) {
        after = row; candidates++; validated++;
        const asset = await source.get(row.asset_id); // null means confirmed absent, errors propagate
        if (asset && asset.id !== row.asset_id) throw Error('Upstream returned the wrong asset');
        if (!asset || !isEligible(asset)) {
          this.db.prepare('UPDATE prototype_inventory SET eligible=0 WHERE asset_id=?').run(row.asset_id);
          continue;
        }
        selected.push(asset);
        if (selected.length === options.limit || validated === maxValidations) break;
      }
    }
    return { selected, candidates, validated, limited: validated === maxValidations && selected.length < options.limit };
  }
}
export function isEligible(asset) {
  return asset.type === 'IMAGE' && asset.visibility === 'timeline' && !asset.stackChild && !asset.deleted;
}
