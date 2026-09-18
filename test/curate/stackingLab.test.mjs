import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partition, timeGroups, decodeHash, hashDistance } from '../../public/curate/stacking-model.js';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { labPeopleEvidence, labRecognizedIds } from '../../src/curate/lab-evidence.mjs';

const hash = (byte) => Buffer.alloc(21, byte).toString('base64');
const photo = (id, time, byte = 0, extra = {}) => ({ id, time, thumbhash: hash(byte), ...extra });
const ids = (groups) => groups.map((g) => g.map((p) => p.id));
const schema = { properties: {
  has_people: { type: 'boolean' },
  people_count: { type: 'string', enum: ['none', 'one', 'couple', 'group', 'unknown'] },
} };

test('lab accepts Group as a producing category, while unsupported and conflicting evidence stays unknown', () => {
  for (const category of ['none', 'one', 'couple', 'group']) {
    assert.deepEqual(labPeopleEvidence({ people_count: category, has_people: category !== 'none' }, schema, 'saved'),
      { peopleCategory: category, peopleStatus: 'known' });
  }
  const group = { people_count: 'group', has_people: true };
  assert.equal(labPeopleEvidence(group, null, 'saved').peopleStatus, 'unsupported');
  assert.equal(labPeopleEvidence(group, schema, null).peopleCategory, null);
  assert.equal(labPeopleEvidence({ ...group, has_people: false }, schema, 'saved').peopleStatus, 'conflicting');
  assert.equal(labPeopleEvidence({ ...group, has_people: 'true' }, schema, 'saved').peopleCategory, null);
  assert.equal(labPeopleEvidence({ ...group, people_count: 'unknown' }, schema, 'saved').peopleStatus, 'unknown');
  assert.equal(labPeopleEvidence({ ...group, people_count: 3 }, schema, 'saved').peopleCategory, null);
});

test('lab identity evidence preserves unknown and bounds cached identity lists', () => {
  const observation = (ids, omitted = false) => JSON.stringify({ ids, omitted });
  assert.deepEqual(labRecognizedIds(observation(['b', 'a', 'a'])), ['a', 'b']);
  assert.deepEqual(labRecognizedIds(observation([])), []);
  for (const value of [null, '{}', 'invalid', observation(null), observation(['a'], true),
    observation(['']), observation([7]), observation(['a'.repeat(129)]),
    observation(Array(101).fill('a')), ' '.repeat(4097)]) assert.equal(labRecognizedIds(value), null);
});

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

test('categories separate None/One/Couple/Group without requiring face recognition; unknown cannot bridge conflicts', () => {
  const rows = ['none', 'one', 'couple', 'group'].map((peopleCategory, i) =>
    photo(String(i), i * 1000, 0, { peopleCategory, recognizedCount: 0 }));
  assert.equal(partition(rows, { gapMs: 15000, people: true }).groups.length, 4);
  assert.equal(partition(rows, { gapMs: 15000, people: false }).groups.length, 1);
  assert.equal(partition([rows[3], { ...rows[3], id: 'another-group', recognizedCount: 7 }],
    { gapMs: 15000, people: true }).groups.length, 1);
  const unknown = photo('unknown', 1500);
  assert.deepEqual(ids(partition([rows[1], unknown, rows[2]], { gapMs: 15000, people: true }).groups),
    [['1', 'unknown'], ['2']]);
});

test('identity experiment separates disjoint people independently, without forcing unknown or overlapping lists apart', () => {
  const a = photo('a', 0, 0, { peopleCategory: 'one', recognizedIds: ['person-a'] });
  const b = photo('b', 1000, 0, { peopleCategory: 'one', recognizedIds: ['person-b'] });
  const couple = photo('couple', 2000, 0, { peopleCategory: 'couple', recognizedIds: ['person-a', 'person-b'] });
  const rows = [a, b, couple], original = structuredClone(rows);
  assert.equal(partition(rows, { gapMs: 15000 }).groups.length, 1);
  assert.deepEqual(ids(partition(rows, { gapMs: 15000, people: true }).groups), [['a', 'b'], ['couple']]);
  const result = partition(rows, { gapMs: 15000, identities: true });
  assert.deepEqual(ids(result.groups), [['a'], ['b', 'couple']]);
  assert.match(result.reasons.get('b'), /different recognized people/);
  assert.equal(partition(rows, { gapMs: 15000, identities: true, people: true }).groups.length, 3);
  // No Enrich provenance is needed; matching IDs do not override time or hashes.
  assert.equal(partition([a, { ...b, peopleCategory: null }], { gapMs: 15000, identities: true }).groups.length, 2);
  assert.equal(partition([a, { ...b, recognizedIds: a.recognizedIds }], { gapMs: 500, identities: true }).groups.length, 2);
  assert.equal(partition([a, { ...b, recognizedIds: a.recognizedIds, thumbhash: hash(255) }],
    { gapMs: 15000, identities: true, thumbhash: true }).groups.length, 2);
  // Neither unknown observations nor an overlapping pair can bridge a known conflict.
  for (const recognizedIds of [null, [], ['person-a', 'person-b']]) {
    const middle = photo('middle', 500, 0, { recognizedIds });
    assert.deepEqual(ids(partition([a, middle, b], { gapMs: 15000, identities: true }).groups),
      [['a', 'middle'], ['b']]);
  }
  assert.deepEqual(rows, original);
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
    repo.saveRunConfiguration({ id: 'a'.repeat(64), inferenceId: 'b'.repeat(64),
      snapshot: { formatVersion: 1, inference: { contractVersion: 1, jsonSchema: schema } } });
    for (const [assetId, category] of [['a', 'one'], ['b', 'group']]) {
      repo.curate.observe({ id: assetId, people: [] });
      repo.recordProcessingRun({ assetId, provider: 'test', model: 'test', promptVersion: 'v1',
        taxonomyVersion: 'v1', status: 'succeeded', configurationId: 'a'.repeat(64),
        normalizedOutput: { has_people: true, people_count: category } });
    }
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
    assert.deepEqual(comparison.photos.map(p => [p.peopleCategory, p.recognizedCount]), [['one', 0], ['group', 0]]);
    assert.deepEqual(comparison.photos.map(p => p.recognizedIds), [[], []]);
    assert.equal(partition(comparison.photos, { gapMs: 15000, people: true }).groups.length, 2);
    assert.equal(repo.curate.photo('b').peopleCount, null, 'production exact-count projection is unchanged');
    assert.equal(service.timer, undefined); // opening the lab does not activate metadata refresh
    assert.throws(() => service.comparison(first.viewId, '0'), /expired/i);
    add('new', 500);
    assert.deepEqual(service.lab.comparison(first.viewId, 0).photos.map((p) => p.id), ['a', 'b']);
    assert.equal(service.lab.page(first.viewId, 50).groups.length, 11);
    // The only domain mutation was the deliberately added test photo.
    repo.db.prepare('DELETE FROM review_list WHERE asset_id=?').run('new');
    assert.deepEqual(snapshot(), before);
    repo.curate.observe({ id: 'a', people: [{ id: 'person-a' }] });
    repo.curate.observe({ id: 'b', people: [{ id: 'person-b' }, { id: 'person-b' }] });
    const reversed = await service.lab.open({ sort: 'newest' });
    assert.equal(reversed.groups[0].photo.id, 'single-59');
    const refreshed = service.lab.comparison(reversed.viewId, reversed.total - 1);
    assert.deepEqual(refreshed.photos.map(p => p.recognizedIds), [['person-a'], ['person-b']]);
    assert.equal(partition(refreshed.photos, { gapMs: 15000, identities: true }).groups.length, 2);
    assert.deepEqual(service.lab.comparison(first.viewId, 0).photos.map(p => p.recognizedIds), [[], []],
      'recognition changes do not alter an open experiment');
    const calls = [];
    service.immich = { async getAsset(id) {
      calls.push(id);
      return { id, fileCreatedAt: new Date(id === 'a' ? 0 : 1000).toISOString(),
        ...(id === 'a' ? { people: [{ id: 'fresh-person' }] } : {}) };
    } };
    const live = await service.lab.refreshRecognition(first.viewId, 0);
    assert.deepEqual(calls.sort(), ['a', 'b']);
    assert.deepEqual(live.photos.map(p => [p.recognizedIds, p.recognitionStatus]),
      [[['fresh-person'], 'loaded'], [null, 'not-returned']]);
    assert.deepEqual(service.lab.comparison(first.viewId, 0).photos.map(p => p.recognizedIds), [[], []]);
    assert.deepEqual(snapshot(), before, 'recognition reads never create decisions or leases');
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
