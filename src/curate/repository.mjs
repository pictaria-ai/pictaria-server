import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { deriveState } from '../enrich/reviewBuckets.mjs';
import { CurateError, canonicalJson, fingerprint, validatePartition, validateAdvice } from './contracts.mjs';
import { observeAsset, photoEvidence } from './evidence.mjs';

export const LEASE_MS = 30 * 60_000;
export const MAX_LEASES = 200;
export const MAX_LEASE_BYTES = 5 * 1024 * 1024;
const HOT = `asset_id id,captured_ms time,checksum,duplicate_id duplicateId,rendition_key renditionKey,
 input_key inputKey,material_key materialKey,people_count peopleCount,recognized_count recognizedCount,availability`;

export class CurateRepository {
  constructor(repo) {
    this.repo = repo;
    this.db = repo.db;
    this.schemas = new Map();
    this.statements = new Map();
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
      return;
    }
    const observation = this.prepare('SELECT json FROM curate_observations WHERE asset_id=?').get(id);
    const observed = observation ? JSON.parse(observation.json) : {};
    const duplicateId = Object.hasOwn(observed, 'duplicateId') ? observed.duplicateId : source.duplicate_id;
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
      deriveState(new Set(tags)),
      projected.availability,
      projected.peopleCount,
      projected.recognizedCount,
      JSON.stringify(projected.evidence),
    );
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
        `SELECT a.original_path,ls.short_caption,p.state,p.evidence_json FROM curate_photos p
        JOIN assets a ON a.asset_id=p.asset_id LEFT JOIN latest_success ls ON ls.asset_id=p.asset_id WHERE p.asset_id=?`,
      ).get(id);
      if (!row) throw new CurateError('Comparison membership changed. Refresh Curate.');
      return {
        id,
        filename: row.original_path?.split('/').pop() ?? id,
        caption: row.short_caption ?? '',
        state: row.state,
        evidence: JSON.parse(row.evidence_json),
      };
    });
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
      bytes = Buffer.byteLength(json) + reservedBytes;
    return this.repo.transaction(() => {
      this.prepare('DELETE FROM curate_leases WHERE expires_at<=?').run(now);
      const used = this.prepare('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM curate_leases').get();
      if (used.count >= MAX_LEASES || used.bytes + bytes > MAX_LEASE_BYTES)
        throw new CurateError(
          'Too many open Curate comparisons. Close or wait for older comparisons to expire.',
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
  async createView(current, groups) {
    const bytes = groups.reduce(
      (n, g) => n + Buffer.byteLength(JSON.stringify(g.ids)) + Buffer.byteLength(g.id) + Buffer.byteLength(g.route),
      0,
    );
    const lease = this.lease(
      'view',
      { generation: current.generation, stacks: current.stacks, total: groups.length },
      Date.now(),
      bytes,
    );
    const insert = this.prepare('INSERT INTO curate_view_groups VALUES(?,?,?,?,?)');
    try {
      let position = 0;
      while (position < groups.length) {
        const started = performance.now();
        this.repo.transaction(() => {
          do {
            const g = groups[position];
            insert.run(lease.id, position, g.id, JSON.stringify(g.ids), g.route);
            position++;
          } while (position < groups.length && performance.now() - started < 4);
        });
        await setImmediate();
      }
      return lease;
    } catch (error) {
      this.releaseLease(lease.id);
      throw error;
    }
  }
  viewGroups(id, offset, limit) {
    return this.prepare(
      'SELECT group_id id,ids_json,route FROM curate_view_groups WHERE view_id=? AND position>=? ORDER BY position LIMIT ?',
    )
      .all(id, offset, limit)
      .map((r) => ({ id: r.id, ids: JSON.parse(r.ids_json), route: r.route }));
  }
  viewGroup(id, groupId) {
    const row =
      typeof groupId === 'string' &&
      this.prepare('SELECT group_id id,ids_json,route FROM curate_view_groups WHERE view_id=? AND group_id=?').get(
        id,
        groupId,
      );
    return row ? { id: row.id, ids: JSON.parse(row.ids_json), route: row.route } : null;
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
    return this.prepare('SELECT id,revision,active FROM curate_separations WHERE id=?').get(id);
  }
  separate(leaseId, partitions, now = Date.now()) {
    return this.repo.transaction(() => {
      const lease = this.getLease(leaseId, 'comparison', now);
      validatePartition(lease.ids, partitions);
      if (partitions.length < 2)
        throw new CurateError('A separation needs at least two parts.', 'invalid_curate_partition', 400);
      // Same lease is an idempotent correction ID. A different partition cannot
      // silently overwrite an existing correction on retry.
      const existing = this.prepare('SELECT * FROM curate_separations WHERE id=?').get(leaseId);
      if (existing) {
        const saved = this.prepare(
          'SELECT asset_id,partition_no FROM curate_separation_members WHERE separation_id=? ORDER BY asset_id',
        ).all(leaseId);
        const expected = partitions
          .flatMap((p, i) => p.map((asset_id) => ({ asset_id, partition_no: i })))
          .sort((a, b) => a.asset_id.localeCompare(b.asset_id));
        if (fingerprint(saved) !== fingerprint(expected) || !existing.active)
          throw new CurateError('This correction ID was already used.');
        return { id: leaseId, revision: existing.revision, undoUntil: existing.undo_until };
      }
      this.assertComparison(leaseId, now);
      this.prepare('INSERT INTO curate_separations VALUES(?,1,1,?,?)').run(leaseId, now, now + LEASE_MS);
      const insert = this.prepare('INSERT INTO curate_separation_members VALUES(?,?,?)');
      partitions.forEach((part, i) => part.forEach((id) => insert.run(leaseId, id, i)));
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
