import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { deriveState } from '../enrich/reviewBuckets.mjs';
import { CurateError, canonicalJson, fingerprint, validatePartition, validateAdvice, validateSeparationAction } from './contracts.mjs';
import { hasObservationFields, observeAsset, photoEvidence } from './evidence.mjs';
import { GROUPING_METHOD } from './grouping.mjs';
import { CurateMetadataStore } from './metadata.mjs';

export const LEASE_MS = 30 * 60_000;
export const MAX_LEASES = 200;
export const MAX_VIEW_LEASES = 200;
export const MAX_LEASE_BYTES = 5 * 1024 * 1024;
const HOT = `asset_id id,captured_ms time,checksum,duplicate_id duplicateId,rendition_key renditionKey,
 input_key inputKey,material_key materialKey,people_count peopleCount,recognized_count recognizedCount,availability`;

export class CurateRepository {
  constructor(repo) {
    this.repo = repo;
    this.db = repo.db;
    this.schemas = new Map();
    this.statements = new Map();
    this.viewBuilds = new Map();
    this.metadata = new CurateMetadataStore(this);
  }
  prepare(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  generation() {
    return this.prepare("SELECT value FROM curate_meta WHERE key='generation'").get().value;
  }
  bump() {
    this.prepare("UPDATE curate_meta SET value=value+1 WHERE key='generation'").run();
  }
  observe(asset) {
    const old = this.prepare('SELECT json FROM curate_observations WHERE asset_id=?').get(asset.id);
    const json = JSON.stringify(observeAsset(asset, old ? JSON.parse(old.json) : {}));
    if (json !== old?.json) this.prepare('INSERT OR REPLACE INTO curate_observations VALUES(?,?)').run(asset.id, json);
  }
  shouldObserve(asset) {
    return (
      hasObservationFields(asset) && Boolean(this.prepare('SELECT 1 FROM review_list WHERE asset_id=?').get(asset.id))
    );
  }
  mergeMetadataAsset(asset) {
    const row = this.prepare('SELECT * FROM assets WHERE asset_id=?').get(asset.id);
    if (!row) throw new CurateError('Metadata photo is no longer available.');
    // Detail responses can omit optional fields. Preserve source columns unless
    // actually observed; a partial response must not erase known image identity.
    const merged = { id: asset.id };
    for (const [key, column] of Object.entries({
      originalPath: 'original_path',
      checksum: 'checksum',
      fileCreatedAt: 'file_created_at',
      fileModifiedAt: 'file_modified_at',
      width: 'width',
      height: 'height',
      mimeType: 'mime_type',
      updatedAt: 'immich_updated_at',
      thumbhash: 'thumbhash',
      duplicateId: 'duplicate_id',
    }))
      merged[key] = Object.hasOwn(asset, key) ? asset[key] : row[column];
    for (const key of ['people', 'isEdited', 'isTrashed', 'isOffline'])
      if (Object.hasOwn(asset, key)) merged[key] = asset[key];
    const exif = asset.exifInfo;
    if (exif === null) {
      merged.width = merged.height = null;
      merged.exifInfo = { orientation: null };
    } else if (exif && typeof exif === 'object') {
      // Normalize dimensions before upsert's fallback chain, preserving an
      // explicitly cleared dimension and recognizing both Immich field forms.
      for (const [target, primary, alternate] of [
        ['width', 'exifImageWidth', 'imageWidth'],
        ['height', 'exifImageHeight', 'imageHeight'],
      ]) {
        if (Object.hasOwn(exif, primary)) merged[target] = exif[primary];
        else if (Object.hasOwn(exif, alternate)) merged[target] = exif[alternate];
      }
      if (Object.hasOwn(exif, 'orientation')) merged.exifInfo = { orientation: exif.orientation };
    }
    this.repo.upsertAsset(merged);
  }
  schema(id) {
    if (!id) return null;
    if (this.schemas.has(id)) return this.schemas.get(id);
    // SQLite extracts only the two producing fields; never load a full prompt /
    // taxonomy into the worker's per-photo projection or its response cache.
    const row = this.prepare(
      `SELECT json_extract(snapshot_json,'$.inference.jsonSchema.properties.has_people') hp,
      json_extract(snapshot_json,'$.inference.jsonSchema.properties.people_count') pc
      FROM enrich_configurations WHERE id=? AND json_valid(snapshot_json) AND json_extract(snapshot_json,'$.formatVersion')=1 AND json_extract(snapshot_json,'$.inference.contractVersion')=1`,
    ).get(id);
    const schema = row
      ? {
          properties: {
            has_people: row.hp ? JSON.parse(row.hp) : null,
            people_count: row.pc ? JSON.parse(row.pc) : null,
          },
        }
      : null;
    if (this.schemas.size >= 32) this.schemas.delete(this.schemas.keys().next().value);
    this.schemas.set(id, schema);
    return schema;
  }
  project(id) {
    const source = this.prepare(
      `SELECT a.*,ls.run_id,pr.configuration_id,
      json_extract(pr.normalized_output_json,'$.has_people') has_people,
      json_type(pr.normalized_output_json,'$.has_people') people_type,
      json_extract(pr.normalized_output_json,'$.people_count') people_count
      FROM review_list rl JOIN assets a ON a.asset_id=rl.asset_id
      LEFT JOIN latest_success ls ON ls.asset_id=rl.asset_id LEFT JOIN processing_runs pr ON pr.id=ls.run_id
      WHERE rl.asset_id=?`,
    ).get(id);
    if (!source) {
      if (this.prepare('DELETE FROM curate_photos WHERE asset_id=?').run(id).changes) this.bump();
      this.prepare('DELETE FROM curate_dirty WHERE asset_id=?').run(id);
      this.prepare('DELETE FROM curate_metadata WHERE asset_id=?').run(id);
      return;
    }
    const observation = this.prepare('SELECT json FROM curate_observations WHERE asset_id=?').get(id);
    const observed = observation ? JSON.parse(observation.json) : {};
    const duplicateId = source.duplicate_id;
    const projected = photoEvidence({
      asset: source,
      observation: observed,
      configurationId: source.configuration_id,
      schema: this.schema(source.configuration_id),
      output: {
        has_people: ['true', 'false'].includes(source.people_type) ? Boolean(source.has_people) : null,
        people_count: source.people_count,
      },
    });
    const tags = this.prepare('SELECT tag FROM asset_tags WHERE asset_id=? ORDER BY tag')
      .all(id)
      .map((r) => r.tag);
    const lastDecision = this.prepare('SELECT MAX(id) id FROM manual_overrides WHERE asset_id=?').get(id)?.id ?? null;
    const humanKey = fingerprint({ tags: tags.filter((t) => t.startsWith('frame/')), lastDecision });
    const time = Date.parse(source.file_created_at),
      captured = Number.isFinite(time) ? time : null;
    const inputKey = fingerprint({
      image: projected.imageKey,
      facts: projected.factsKey,
      captured,
      duplicate: duplicateId ?? null,
      tags: tags.filter((t) => t.startsWith('ai/')),
    });
    const materialKey = fingerprint({ inputKey, humanKey });
    const old = this.prepare('SELECT material_key FROM curate_photos WHERE asset_id=?').get(id);
    const state = deriveState(new Set(tags));
    this.prepare(`INSERT OR REPLACE INTO curate_photos VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      captured,
      source.checksum,
      duplicateId,
      projected.imageKey,
      projected.renditionKey,
      projected.factsKey,
      inputKey,
      materialKey,
      humanKey,
      state,
      projected.availability,
      projected.peopleCount,
      projected.recognizedCount,
      JSON.stringify(projected.evidence),
    );
    this.metadata.project(id, source, state, observed);
    if (old?.material_key !== materialKey) this.bump();
    this.prepare('DELETE FROM curate_dirty WHERE asset_id=?').run(id);
  }
  flushIds(ids) {
    this.repo.transaction(() => {
      for (const id of ids) if (this.prepare('SELECT 1 FROM curate_dirty WHERE asset_id=?').get(id)) this.project(id);
    });
  }
  async flush({ signal, onSlice = () => {} } = {}) {
    for (;;) {
      signal?.throwIfAborted();
      const rows = this.prepare('SELECT asset_id FROM curate_dirty ORDER BY asset_id LIMIT 100').all();
      if (!rows.length) return;
      const start = performance.now();
      // A transaction contains at most 100 records, but yields sooner between
      // transactions on the 4ms target. Each source record is indivisible.
      let count = 0;
      this.repo.transaction(() => {
        for (const row of rows) {
          this.project(row.asset_id);
          count++;
          if (performance.now() - start >= 4) break;
        }
      });
      onSlice(performance.now() - start);
      await setImmediate();
      if (!count) throw Error('Curate projection made no progress');
    }
  }
  pending() {
    return this.prepare(
      `SELECT asset_id id,captured_ms time,checksum,duplicate_id duplicateId,rendition_key renditionKey,people_count peopleCount,recognized_count recognizedCount,availability FROM curate_photos WHERE state='undecided' ORDER BY captured_ms,asset_id`,
    ).all();
  }
  candidateRows() {
    return this.prepare(`SELECT ${HOT},
      json_extract(evidence_json,'$.category.peopleCategory') peopleCategory,
      json_extract(evidence_json,'$.recognition') recognition,
      json_extract(evidence_json,'$.image.thumbhash') thumbhash
      FROM curate_photos WHERE state='undecided' ORDER BY captured_ms,asset_id`).all();
  }
  separations() {
    const rows = this.prepare(
      `SELECT m.separation_id,m.asset_id,m.partition_no FROM curate_separation_members m
      JOIN curate_separations s ON s.id=m.separation_id AND s.active=1
      JOIN curate_photos p ON p.asset_id=m.asset_id AND p.state='undecided' ORDER BY m.separation_id,m.partition_no,m.asset_id`,
    ).all();
    const byId = new Map();
    for (const r of rows) {
      const parts = byId.get(r.separation_id) ?? new Map();
      if (!parts.has(r.partition_no)) parts.set(r.partition_no, []);
      parts.get(r.partition_no).push(r.asset_id);
      byId.set(r.separation_id, parts);
    }
    return [...byId].map(([id, parts]) => ({ id, partitions: [...parts.values()] }));
  }
  photo(id) {
    return this.prepare(`SELECT ${HOT},state,human_key humanKey FROM curate_photos WHERE asset_id=?`).get(id);
  }
  details(ids) {
    return ids.map((id) => {
      const row = this.prepare(
        `SELECT a.original_path,ls.short_caption,p.state,p.evidence_json,m.checked_at,m.outcome FROM curate_photos p
        JOIN assets a ON a.asset_id=p.asset_id LEFT JOIN latest_success ls ON ls.asset_id=p.asset_id
        LEFT JOIN curate_metadata m ON m.asset_id=p.asset_id WHERE p.asset_id=?`,
      ).get(id);
      if (!row) throw new CurateError('Comparison membership changed. Refresh Curate.');
      return {
        id,
        filename: row.original_path?.split('/').pop() ?? id,
        caption: row.short_caption ?? '',
        tags: this.prepare('SELECT tag FROM asset_tags WHERE asset_id=? ORDER BY tag').all(id).map(r => r.tag),
        state: row.state,
        evidence: JSON.parse(row.evidence_json),
        metadata: { checkedAt: row.checked_at ?? null, outcome: row.outcome ?? 'pending' },
      };
    });
  }
  covers(ids) {
    // Bounded display projection: never expand evidence or a whole stack just
    // to paint its card. Missing source rows do not change saved membership.
    return ids.map(id => {
      const row = this.prepare(`SELECT a.original_path,ls.short_caption FROM assets a
        LEFT JOIN latest_success ls ON ls.asset_id=a.asset_id WHERE a.asset_id=?`).get(id);
      return { id, filename: row?.original_path?.split('/').pop() || id, caption: row?.short_caption ?? '' };
    });
  }
  corrections(offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      throw new CurateError('Invalid corrections page.', 'invalid_curate_query', 400);
    const rows = this.prepare(`SELECT id,revision,created_at createdAt FROM curate_separations
      WHERE active=1 ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(limit + 1, offset);
    return {
      corrections: rows.slice(0, limit).map(row => ({ ...row, active: true,
        action: this.correctionAction(row.id, { display: true }),
        memberCount: this.prepare('SELECT COUNT(*) n FROM curate_separation_members WHERE separation_id=?').get(row.id).n,
        photos: this.covers(this.prepare(`SELECT asset_id FROM curate_separation_members
          WHERE separation_id=? ORDER BY partition_no,asset_id LIMIT 3`).all(row.id).map(r => r.asset_id)),
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  context(ids) {
    const pending = ids.map((id) => this.photo(id)).filter(Boolean),
      times = pending.map((p) => p.time).filter((t) => t !== null);
    if (!times.length) return { ids: [], omitted: false };
    const min = Math.min(...times),
      max = Math.max(...times);
    // The indexed query is bounded even with 30k decided photos. Nearest among
    // returned compatible candidates, not an exhaustive nearest-neighbor claim.
    const rows = this.prepare(
      `SELECT ${HOT} FROM curate_photos INDEXED BY idx_curate_state_time
      WHERE state='approved' AND captured_ms BETWEEN ? AND ? ORDER BY captured_ms,asset_id LIMIT 64`,
    ).all(min - 180000, max + 180000);
    const compatible = rows.filter(
      (r) =>
        r.availability !== 'unavailable' &&
        times.some((t) => Math.abs(t - r.time) <= 180000) &&
        pending.every(
          (p) =>
            !(
              Number.isInteger(p.peopleCount) &&
              Number.isInteger(r.peopleCount) &&
              p.peopleCount !== r.peopleCount &&
              p.recognizedCount === p.peopleCount &&
              r.recognizedCount === r.peopleCount
            ),
        ) &&
        !this.separatedFrom(r.id, ids),
    );
    compatible.sort(
      (a, b) =>
        Math.min(...times.map((t) => Math.abs(t - a.time))) - Math.min(...times.map((t) => Math.abs(t - b.time))) ||
        a.id.localeCompare(b.id),
    );
    return { ids: compatible.slice(0, 8).map((r) => r.id), omitted: rows.length === 64 || compatible.length > 8 };
  }
  separatedFrom(id, ids) {
    const labels = this.prepare(
      `SELECT m.separation_id,m.partition_no FROM curate_separation_members m
      JOIN curate_separations s ON s.id=m.separation_id AND s.active=1 WHERE m.asset_id=?`,
    ).all(id);
    return labels.some((l) =>
      ids.some((other) => {
        const row = this.prepare(
          'SELECT partition_no FROM curate_separation_members WHERE separation_id=? AND asset_id=?',
        ).get(l.separation_id, other);
        return row && row.partition_no !== l.partition_no;
      }),
    );
  }
  pendingScopeChanges(ids) {
    // Check only related dirty candidates through source indexes. An unrelated
    // import cannot invalidate this scope merely by bumping a global counter.
    for (const id of ids) {
      const p = this.photo(id);
      if (!p) return true;
      const has = (where, ...values) =>
        Boolean(
          this.prepare(
            `SELECT 1 FROM assets a JOIN curate_dirty d ON d.asset_id=a.asset_id
        JOIN review_list rl ON rl.asset_id=a.asset_id WHERE ${where} LIMIT 1`,
          ).get(...values),
        );
      if (
        p.time !== null &&
        has(
          'julianday(a.file_created_at) BETWEEN ? AND ?',
          (p.time - 15001) / 86400000 + 2440587.5,
          (p.time + 15001) / 86400000 + 2440587.5,
        )
      )
        return true;
      if (p.checksum && has('a.checksum=?', p.checksum)) return true;
      if (p.duplicateId && has('a.duplicate_id=?', p.duplicateId)) return true;
    }
    return false;
  }
  material(ids) {
    this.flushIds(ids);
    const material = ids.map((id) => {
      const p = this.photo(id);
      if (!p || p.state !== 'undecided' || p.availability === 'unavailable')
        throw new CurateError('A comparison photo changed or is unavailable. Refresh Curate.');
      const constraints = this.prepare(
        `SELECT m.separation_id,m.partition_no,s.revision,s.active FROM curate_separation_members m JOIN curate_separations s ON s.id=m.separation_id WHERE m.asset_id=? ORDER BY m.separation_id`,
      ).all(id);
      return [id, p.materialKey, constraints];
    });
    return fingerprint(material);
  }
  lease(kind, scope, now = Date.now(), reservedBytes = 0) {
    const json = canonicalJson(scope),
      bytes = Buffer.byteLength(json);
    return this.repo.transaction(() => {
      this.pruneScopes(now);
      const count = this.prepare('SELECT COUNT(*) count FROM curate_leases WHERE kind=?').get(kind).count;
      const used = this.prepare(
        `SELECT
        (SELECT COALESCE(SUM(bytes),0) FROM curate_leases) +
        (SELECT COALESCE(SUM(bytes),0) FROM curate_view_snapshots) +
        (SELECT COALESCE(SUM(bytes),0) FROM curate_view_replacements) bytes`,
      ).get().bytes;
      if (count >= (kind === 'view' ? MAX_VIEW_LEASES : MAX_LEASES) || used + bytes + reservedBytes > MAX_LEASE_BYTES)
        throw new CurateError(
          'Too many open Curate views or comparisons. Close an older view or wait for it to expire.',
          'curate_capacity',
          429,
        );
      const id = randomUUID(),
        expiresAt = now + LEASE_MS;
      this.prepare('INSERT INTO curate_leases VALUES(?,?,?,?,?,?)').run(
        id,
        kind,
        fingerprint(scope),
        json,
        bytes,
        expiresAt,
      );
      return { id, expiresAt, ...scope };
    });
  }
  comparisonLease(viewId, scope) {
    return this.repo.transaction(() => {
      this.getLease(viewId, 'view');
      const completeScope = { ...scope, viewId };
      const old = this.prepare(
        "SELECT id,scope_hash,expires_at FROM curate_leases WHERE kind='comparison' AND json_extract(json,'$.viewId')=?",
      ).get(viewId);
      // Retrying the same open preserves its operation ID. Navigating within a
      // view supersedes that view's prior comparison, never another tab's scope.
      if (old?.scope_hash === fingerprint(completeScope) && old.expires_at > Date.now())
        return this.getLease(old.id, 'comparison');
      if (old) this.releaseLease(old.id);
      return this.lease('comparison', completeScope);
    });
  }
  encodedGroup(group, method = GROUPING_METHOD) {
    // Do not store a synthetic single group ID plus a second copy of its UUID.
    return group.ids.length === 1 && group.id === `single:${method}:${group.ids[0]}`
      ? [group.ids[0], '', group.route]
      : [group.id, JSON.stringify(group.ids), group.route];
  }
  decodedGroup(row, method = GROUPING_METHOD) {
    return row.ids_json === ''
      ? { id: `single:${method}:${row.id}`, ids: [row.id], route: row.route }
      : { id: row.id, ids: JSON.parse(row.ids_json), route: row.route };
  }
  pruneScopes(now) {
    this.prepare('DELETE FROM curate_leases WHERE expires_at<=?').run(now);
    this.prepare('DELETE FROM curate_view_replacements WHERE expires_at<=?').run(now);
  }
  viewReplacement(id, now) {
    if (id === null) return {};
    const direct = this.prepare('SELECT * FROM curate_leases WHERE id=? AND expires_at>?').get(id, now);
    if (direct) {
      if (direct.kind !== 'view')
        throw new CurateError('Only a Curate view can be replaced.', 'invalid_curate_query', 400);
      return { previous: direct, rootId: JSON.parse(direct.json).replacementRootId ?? id };
    }
    const alias = this.prepare('SELECT root_id FROM curate_view_replacements WHERE id=? AND expires_at>?').get(id, now);
    if (!alias) return {};
    // Every retired ID points to a stable root. One indexed lookup finds the
    // current successor, without walking or rewriting a growing alias chain.
    const previous = this.prepare(
      "SELECT * FROM curate_leases WHERE kind='view' AND json_extract(json,'$.replacementRootId')=? AND expires_at>?",
    ).get(alias.root_id, now);
    return { previous, rootId: alias.root_id };
  }
  async createView(current, groups, { replacesViewId = null, sort = 'oldest' } = {}) {
    // Identical ordered memberships share an immutable SQLite snapshot across
    // tabs, retries and filters. They never page a moving current index. Hashing
    // and persistence yield, and all retained snapshot bytes count toward 5 MiB.
    const method = current.method ?? GROUPING_METHOD;
    const hash = createHash('sha256').update(method);
    let bytes = 0,
      started = performance.now();
    for (const group of groups) {
      const encoded = JSON.stringify(this.encodedGroup(group, method));
      bytes += Buffer.byteLength(encoded) + 4;
      hash.update(encoded).update('\n');
      if (performance.now() - started >= 4) {
        await setImmediate();
        started = performance.now();
      }
    }
    const snapshotId = hash.digest('hex');
    // A retry with different filters may arrive while its successor snapshot is
    // still being written. Drain that build before superseding its reservation.
    // Recheck both builds after each await: another tab may have started the
    // desired snapshot while we were waiting for this family's predecessor.
    for (;;) {
      const inFlight = this.viewBuilds.get(snapshotId);
      if (inFlight) {
        await inFlight;
        continue;
      }
      const { previous } = this.viewReplacement(replacesViewId, Date.now());
      const work = previous && this.viewBuilds.get(JSON.parse(previous.json).snapshotId);
      if (!work) break;
      await work.catch(() => {});
    }
    const { lease, fresh } = this.repo.transaction(() => {
      // Cleanup before testing existence: the last owner might just have expired.
      const now = Date.now();
      this.pruneScopes(now);
      const { previous, rootId } = this.viewReplacement(replacesViewId, now);
      if (previous) {
        const alias = { id: previous.id, rootId, expiresAt: previous.expires_at };
        this.prepare('INSERT INTO curate_view_replacements VALUES(?,?,?,?)').run(
          alias.id,
          rootId,
          alias.expiresAt,
          Buffer.byteLength(canonicalJson(alias)),
        );
        // Explicit replacement relinquishes this caller's old scope before
        // reserving the new one. Capacity rejection rolls this transaction back,
        // preserving the old view/comparison. Other snapshot owners are untouched.
        this.releaseLease(previous.id);
      }
      const scope = {
        generation: current.generation,
        method,
        evidenceRevision: current.evidenceRevision ?? 0,
        stacks: current.stacks,
        total: groups.length,
        sort,
        snapshotId,
        ...(rootId ? { replacementRootId: rootId } : {}),
      };
      const fresh = !this.prepare('SELECT 1 FROM curate_view_snapshots WHERE id=?').get(snapshotId);
      const lease = this.lease('view', scope, now, fresh ? bytes : 0);
      if (fresh) this.prepare('INSERT INTO curate_view_snapshots(id,bytes) VALUES(?,?)').run(snapshotId, bytes);
      return { lease, fresh };
    });
    if (fresh) {
      const work = this.writeViewSnapshot(snapshotId, groups, method);
      this.viewBuilds.set(snapshotId, work);
      try {
        await work;
      } catch (error) {
        this.releaseLease(lease.id);
        throw error;
      } finally {
        this.viewBuilds.delete(snapshotId);
      }
    }
    return lease;
  }
  async writeViewSnapshot(snapshotId, groups, method = GROUPING_METHOD) {
    const insert = this.prepare('INSERT INTO curate_view_groups VALUES(?,?,?,?,?)');
    let position = 0;
    while (position < groups.length) {
      const started = performance.now();
      this.repo.transaction(() => {
        do {
          insert.run(snapshotId, position, ...this.encodedGroup(groups[position], method));
          position++;
        } while (position < groups.length && performance.now() - started < 4);
      });
      await setImmediate();
    }
    this.prepare('UPDATE curate_view_snapshots SET ready=1 WHERE id=?').run(snapshotId);
  }
  viewGroups(id, offset, limit) {
    const view = this.getLease(id, 'view');
    return this.prepare(
      'SELECT group_id id,ids_json,route FROM curate_view_groups WHERE view_id=? AND position>=? ORDER BY position LIMIT ?',
    )
      .all(view.snapshotId ?? id, offset, limit)
      .map((row) => this.decodedGroup(row, view.method));
  }
  viewGroup(id, groupId) {
    const view = this.getLease(id, 'view');
    const key =
      view.snapshotId && typeof groupId === 'string' && groupId.startsWith(`single:${view.method ?? GROUPING_METHOD}:`)
        ? groupId.slice(`single:${view.method ?? GROUPING_METHOD}:`.length)
        : groupId;
    const row =
      typeof key === 'string' &&
      this.prepare('SELECT group_id id,ids_json,route FROM curate_view_groups WHERE view_id=? AND group_id=?').get(
        view.snapshotId ?? id,
        key,
      );
    return row ? this.decodedGroup(row, view.method) : null;
  }
  getLease(id, kind, now = Date.now()) {
    const row =
      typeof id === 'string' ? this.prepare('SELECT * FROM curate_leases WHERE id=? AND kind=?').get(id, kind) : null;
    if (!row || row.expires_at <= now)
      throw new CurateError('This Curate view expired. Refresh to continue.', 'curate_expired');
    return { id, expiresAt: row.expires_at, ...JSON.parse(row.json) };
  }
  releaseLease(id) {
    this.prepare('DELETE FROM curate_leases WHERE id=?').run(id);
  }
  assertComparison(leaseId, now = Date.now()) {
    const lease = this.getLease(leaseId, 'comparison', now);
    if (this.material(lease.ids) !== lease.material)
      throw new CurateError('Comparison inputs changed. Refresh Curate.');
    return lease;
  }
  correction(id) {
    return typeof id === 'string'
      ? this.prepare('SELECT id,revision,active FROM curate_separations WHERE id=?').get(id)
      : null;
  }
  correctionAction(id, { display = false } = {}) {
    const row = this.prepare('SELECT kind,asset_id FROM curate_separation_actions WHERE separation_id=?').get(id);
    if (!row) return null;
    if (row.kind === 'split') return { kind: 'split' };
    return { kind: 'remove', assetId: row.asset_id, ...(display ? { photo: this.covers([row.asset_id])[0] } : {}) };
  }
  separate(leaseId, partitions, now = Date.now(), action = null) {
    return this.repo.transaction(() => {
      // Same lease is an idempotent correction ID. A different partition cannot
      // silently overwrite an existing correction on retry. Receipts outlive
      // their leases, including a later navigation, reset, or lease cleanup.
      const existing =
        typeof leaseId === 'string' && this.prepare('SELECT * FROM curate_separations WHERE id=?').get(leaseId);
      if (existing) {
        const saved = this.prepare(
          'SELECT asset_id,partition_no FROM curate_separation_members WHERE separation_id=? ORDER BY asset_id',
        ).all(leaseId);
        validatePartition(
          saved.map((row) => row.asset_id),
          partitions,
        );
        const expected = partitions
          .flatMap((p, i) => p.map((asset_id) => ({ asset_id, partition_no: i })))
          .sort((a, b) => a.asset_id.localeCompare(b.asset_id));
        if (fingerprint(saved) !== fingerprint(expected)) throw new CurateError('This correction ID was already used.');
        if (fingerprint(this.correctionAction(leaseId)) !== fingerprint(validateSeparationAction(partitions, action)))
          throw new CurateError('This correction ID was already used with a different action.');
        return { id: leaseId, revision: 1, undoUntil: existing.undo_until };
      }
      const lease = this.getLease(leaseId, 'comparison', now);
      validatePartition(lease.ids, partitions);
      if (partitions.length < 2)
        throw new CurateError('A separation needs at least two parts.', 'invalid_curate_partition', 400);
      const intent = validateSeparationAction(partitions, action);
      this.assertComparison(leaseId, now);
      this.prepare('INSERT INTO curate_separations VALUES(?,1,1,?,?)').run(leaseId, now, now + LEASE_MS);
      const insert = this.prepare('INSERT INTO curate_separation_members VALUES(?,?,?)');
      partitions.forEach((part, i) => part.forEach((id) => insert.run(leaseId, id, i)));
      if (intent) this.prepare('INSERT INTO curate_separation_actions VALUES(?,?,?)').run(leaseId, intent.kind, intent.assetId ?? null);
      this.bump();
      return { id: leaseId, revision: 1, undoUntil: now + LEASE_MS };
    });
  }
  resetSeparation(id, expectedRevision, now = Date.now(), { undo = false } = {}) {
    return this.repo.transaction(() => {
      const row = this.prepare('SELECT * FROM curate_separations WHERE id=?').get(id);
      if (!row || !row.active || row.revision !== expectedRevision || (undo && row.undo_until <= now))
        throw new CurateError('This stack correction changed or its Undo expired.');
      this.prepare('UPDATE curate_separations SET active=0,revision=revision+1 WHERE id=?').run(id);
      this.bump();
      return { id, revision: row.revision + 1, active: false };
    });
  }
  saveAdvice({ role, ids, inputKey, schemaVersion, result }) {
    if (!Array.isArray(ids) || ids.length > 30)
      throw new CurateError('Unsupported AI comparison size.', 'invalid_curate_advice', 400);
    validateAdvice(ids, result, role);
    const json = canonicalJson({ ids, result });
    if (
      Buffer.byteLength(json) > 64 * 1024 ||
      typeof schemaVersion !== 'string' ||
      !schemaVersion ||
      schemaVersion.length > 100
    )
      throw new CurateError('Invalid AI record.', 'invalid_curate_advice', 400);
    return this.repo.transaction(() => {
      this.flushIds(ids);
      const current = fingerprint(ids.map((id) => [id, this.photo(id)?.inputKey]));
      if (
        current !== inputKey ||
        ids.some((id) => this.photo(id)?.state !== 'undecided' || this.photo(id)?.availability === 'unavailable') ||
        ids.some((id) => this.separatedFrom(id, ids))
      )
        throw new CurateError('AI comparison is no longer current.');
      // One current record per overlapping scope and role; no growing raw
      // response history as input revisions or membership change.
      for (const id of ids) {
        this.prepare(
          `DELETE FROM curate_advice WHERE role=? AND input_key IN
          (SELECT input_key FROM curate_advice_members WHERE role=? AND asset_id=?)`,
        ).run(role, role, id);
      }
      this.prepare('INSERT INTO curate_advice VALUES(?,?,?,?)').run(role, inputKey, schemaVersion, json);
      const insert = this.prepare('INSERT INTO curate_advice_members VALUES(?,?,?)');
      for (const id of ids) insert.run(role, inputKey, id);
    });
  }
  advice(role, ids, schemaVersion) {
    this.flushIds(ids);
    if (
      ids.some(
        (id) =>
          this.photo(id)?.state !== 'undecided' ||
          this.photo(id)?.availability === 'unavailable' ||
          this.separatedFrom(id, ids),
      )
    )
      return null;
    const input = fingerprint(ids.map((id) => [id, this.photo(id)?.inputKey]));
    const record = this.prepare('SELECT json FROM curate_advice WHERE role=? AND input_key=? AND schema_version=?').get(
      role,
      input,
      schemaVersion,
    );
    return record ? JSON.parse(record.json).result : null;
  }
}
