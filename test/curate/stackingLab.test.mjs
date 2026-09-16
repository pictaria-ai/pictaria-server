import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partition, timeGroups, decodeHash, hashDistance } from '../../public/curate/stacking-model.js';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';

const hash = (byte) => Buffer.alloc(21, byte).toString('base64');
const photo = (id, time, byte = 0, extra = {}) => ({ id, time, thumbhash: hash(byte), ...extra });
const ids = (groups) => groups.map((g) => g.map((p) => p.id));

test('time baseline is a complete inclusive chain, with undated singles last', () => {
  const rows = Array.from({ length: 30 }, (_, i) => photo(`p${i}`, i * 15000));
  rows.push(photo('unknown-b', null), photo('unknown-a', null));
  assert.deepEqual(timeGroups(rows.reverse(), 15000).map((g) => g.length), [30, 1, 1]);
  assert.equal(timeGroups(rows, 15000).at(-1)[0].id, 'unknown-b');
  assert.equal(timeGroups([photo('a', 0), photo('b', 15001)], 15000).length, 2);
});

test('all-pairs hash rule prevents similarity chaining and can regroup nonadjacent alternatives', () => {
  const chain = [photo('a', 0, 0), photo('b', 1000, 20), photo('c', 2000, 40)];
  assert.deepEqual(ids(partition(chain, { gapMs: 15000, thumbhash: true, threshold: 0.1 }).groups), [['a', 'b'], ['c']]);
  const interleaved = [photo('a', 0, 0), photo('b', 1000, 255), photo('c', 2000, 0)];
  assert.deepEqual(ids(partition(interleaved, { gapMs: 15000, thumbhash: true, threshold: 0.1 }).groups), [['a', 'c'], ['b']]);
});

test('unknown, malformed and different-length hashes are unassessed, not evidence of similarity', () => {
  for (const invalid of [null, '', '***', 'a', 'a'.repeat(129)]) assert.equal(decodeHash(invalid), null);
  const a = photo('a', 0), b = photo('b', 1000, 0, { thumbhash: null });
  assert.equal(hashDistance(decodeHash(a.thumbhash), null), null);
  assert.equal(hashDistance(decodeHash(a.thumbhash), decodeHash(Buffer.alloc(22).toString('base64'))), null);
  const result = partition([a, b], { gapMs: 15000, thumbhash: true });
  assert.equal(result.groups.length, 2);
  assert.match(result.reasons.get('b'), /unavailable/);
  assert.equal(partition([a, b], { gapMs: 15000 }).groups.length, 1);
});

test('count veto requires corroborated supported counts; unknown and contradictory evidence do not invent a count', () => {
  const a = photo('a', 0, 0, { peopleCount: 1, recognizedCount: 1 });
  const b = photo('b', 1000, 0, { peopleCount: 2, recognizedCount: 2 });
  assert.equal(partition([a, b], { gapMs: 15000, people: true }).groups.length, 2);
  assert.equal(partition([a, { ...b, recognizedCount: 1 }], { gapMs: 15000, people: true }).groups.length, 1);
  assert.equal(partition([a, { ...b, peopleCount: null }], { gapMs: 15000, people: true }).groups.length, 1);
});

test('span limits prevent long chains, partitions remain exhaustive and input is immutable', () => {
  const rows = Array.from({ length: 250 }, (_, i) => photo(`p${i}`, i * 1000, i % 255));
  const original = structuredClone(rows);
  for (const threshold of [0, 0.025, 0.1, 0.3]) {
    const value = partition(rows, { gapMs: 15000, spanMs: 180000, thumbhash: true, threshold });
    const flattened = value.groups.flat();
    assert.equal(flattened.length, 250);
    assert.equal(new Set(flattened.map((p) => p.id)).size, 250);
    assert.ok(value.groups.every((g) => g.at(-1).time - g[0].time <= 180000));
  }
  assert.deepEqual(rows, original);
  assert.throws(() => partition([...rows, photo('extra', 999999)], { gapMs: 15000 }), /at most 250/);
  assert.throws(() => partition(rows, { gapMs: NaN }), /Invalid/);
});

test('lab snapshots are stable, bounded, isolated from decisions, and based only on pending cached evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-stacking-lab-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  const service = new CurateService({ repo, config: { curateBurstGrouping: false } });
  const add = (id, time, extra = {}) => {
    repo.upsertAsset({ id, originalPath: `/synthetic/${id}.jpg`, fileCreatedAt: new Date(time).toISOString(), thumbhash: hash(0), ...extra });
    repo.reviewListAdd([id], 'test');
  };
  try {
    add('a', 0); add('b', 1000); add('kept', 2000);
    repo.setManualFrameTags({ assetIds: ['kept'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    for (let i = 0; i < 60; i++) add(`single-${i}`, 600000 * (i + 1));
    const tables = ['manual_overrides', 'asset_tags', 'review_list', 'decision_operations', 'curate_separations', 'curate_leases'];
    const snapshot = () => tables.map((table) => repo.db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    const opening = service.lab.open();
    await assert.rejects(service.lab.open(), /busy/);
    const first = await opening;
    assert.equal(first.total, 61); assert.equal(first.photoCount, 62);
    assert.equal(first.groups.length, 50); assert.equal(first.groups[0].memberCount, 2);
    const comparison = service.lab.comparison(first.viewId, 0);
    assert.deepEqual(comparison.photos.map((p) => p.id), ['a', 'b']);
    assert.equal(comparison.photos[0].thumbhash, hash(0));
    assert.equal(service.timer, undefined); // opening the lab does not activate metadata refresh
    assert.throws(() => service.comparison(first.viewId, '0'), /expired/i);
    add('new', 500);
    assert.deepEqual(service.lab.comparison(first.viewId, 0).photos.map((p) => p.id), ['a', 'b']);
    assert.equal(service.lab.page(first.viewId, 50).groups.length, 11);
    // The only domain mutation was the deliberately added test photo.
    repo.db.prepare('DELETE FROM review_list WHERE asset_id=?').run('new');
    assert.deepEqual(snapshot(), before);
    const reversed = await service.lab.open({ sort: 'newest' });
    assert.equal(reversed.groups[0].photo.id, 'single-59');
    await assert.rejects(service.lab.open({ gapSeconds: 0 }), /1–180/);
    assert.throws(() => service.lab.page(reversed.viewId, -1), /Invalid/);
    assert.throws(() => service.lab.comparison(reversed.viewId, -1), /not found/);
    for (let i = 0; i < 4; i++) await service.lab.open();
    assert.equal(service.lab.views.size, 4);
    assert.throws(() => service.lab.page(first.viewId), /expired/);
    const active = [...service.lab.views.values()][0]; active.expiresAt = 0;
    assert.throws(() => service.lab.page(active.viewId), /expired/);
    for (let i = 0; i < 251; i++) add(`large-${i}`, 999999999 + i);
    const oversized = await service.lab.open({ sort: 'newest' });
    assert.equal(oversized.groups[0].memberCount, 251);
    assert.throws(() => service.lab.comparison(oversized.viewId, 0), /No photos were sampled/);
  } finally { await service.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); }
});
