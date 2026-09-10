import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsightsRepository } from '../../src/insights/repository.mjs';
import { Repository } from '../../src/enrich/repository.mjs';
import { DiscoveryPrototype, isEligible } from './enrich-discovery.mjs';

export const key = { provider: 'cloud_openai', model: 'fixture', promptVersion: 'v1', taxonomyVersion: 'v1', inferenceId: 'a'.repeat(64) };
export function photo(id, overrides = {}) {
  return { id, type: 'IMAGE', visibility: 'timeline', stackChild: false, deleted: false,
    takenAt: '2026-01-01T00:00:00.000Z', updatedAt: 10000, ...overrides };
}
export class SyntheticSource {
  constructor(rows, mode = 'enrich') {
    this.rows = new Map(rows.map(r => [r.id, { ...r }])); this.mode = mode; this.cache = new Map();
    this.calls = { pages: 0, rows: 0, gets: 0 };
  }
  change(id, patch) { Object.assign(this.rows.get(id), patch); this.cache.clear(); }
  add(row) { this.rows.set(row.id, { ...row }); this.cache.clear(); }
  remove(id) { this.rows.delete(id); this.cache.clear(); }
  async scan({ page, size, updatedAfter }) {
    this.calls.pages++;
    const cacheKey = `${this.mode}:${updatedAfter}`;
    if (!this.cache.has(cacheKey)) this.cache.set(cacheKey, [...this.rows.values()]
      .filter(r => !r.deleted && (this.mode !== 'enrich' || isEligible(r)) && (updatedAfter === null || r.updatedAt > updatedAfter))
      .sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? '') || b.id.localeCompare(a.id)));
    const rows = this.cache.get(cacheKey), items = rows.slice((page - 1) * size, page * size).map(r => ({ ...r }));
    this.calls.rows += items.length;
    return { items, nextPage: page * size < rows.length ? page + 1 : null };
  }
  async get(id) { this.calls.gets++; const row = this.rows.get(id); return row && !row.deleted ? { ...row } : null; }
}
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-discovery-prototype-'));
  const path = join(dir, 'prototype.sqlite'); let repo = new Repository(path); repo.initSchema(); let insights = null;
  return { get repo() { return repo; },
    index(mode = 'enrich') {
      if (mode === 'enrich') return new DiscoveryPrototype(repo);
      insights ??= new InsightsRepository(join(dir, 'insights.sqlite'));
      insights.db.prepare('ATTACH DATABASE ? AS enrich_history').run(path);
      return new DiscoveryPrototype(insights, { historySchema: 'enrich_history', enrichRepo: repo });
    },
    reopen() { repo.close(); repo = new Repository(path); repo.initSchema(); return new DiscoveryPrototype(repo); },
    close() { insights?.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export function history(repo, row, { status = 'succeeded', runKey = key, discarded = false } = {}) {
  const date = '2026-01-01T00:00:00.000Z';
  repo.db.prepare(`INSERT OR IGNORE INTO assets(asset_id,file_created_at,first_seen_at,last_seen_at,enrich_discarded_at)
    VALUES(?,?,?,?,?)`).run(row.id, row.takenAt, date, date, discarded ? date : null);
  if (discarded) repo.db.prepare('UPDATE assets SET enrich_discarded_at=? WHERE asset_id=?').run(date, row.id);
  if (status) repo.db.prepare(`INSERT INTO processing_runs(asset_id,provider,model,prompt_version,taxonomy_version,status,started_at,finished_at,inference_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id, runKey.provider, runKey.model, runKey.promptVersion, runKey.taxonomyVersion, status, date, date, runKey.inferenceId ?? null);
}
export function library(size, extras = true) {
  const rows = Array.from({ length: size }, (_, i) => photo(`photo-${String(i).padStart(7, '0')}`,
    { takenAt: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString(), updatedAt: 10000 + (size - i) * 2000 }));
  if (extras) for (let i = 0; i < Math.floor(size / 20); i++) {
    rows.push(photo(`hidden-${i}`, { visibility: 'hidden' }), photo(`stack-${i}`, { stackChild: true }), photo(`video-${i}`, { type: 'VIDEO' }));
  }
  return rows;
}
export async function finish(index, source, options = {}) {
  let steps = 0;
  do { await index.step(source, options); steps++; } while (index.state().scan);
  return steps;
}
