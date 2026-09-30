import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import { EmbeddingStore } from '../../src/embeddings/store.mjs';
import { cosineSimilarity, decodeStoredVector, decodeVector, encodeHalfVector, encodeVector, fromHalf, toHalf } from '../../src/embeddings/vectors.mjs';

const backend = 'immich_ml', model = 'ViT-B-32__openai', calibrationVersion = 1;
const wave = (dims, phase = 0, scale = 1) => Float32Array.from({ length: dims }, (_, i) => scale * Math.sin(i * 0.37 + phase) + 0.1);

function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-embeddings-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  try { return work(repo); } finally { repo.close(); rmSync(dir, { recursive: true, force: true }); }
}

function addAsset(repo, id, { checksum = `sum-${id}`, thumbhash = `hash-${id}` } = {}) {
  repo.upsertAsset({ id, checksum, thumbhash });
}

test('vectors round-trip as little-endian float32 and cosine ignores scale', () => {
  const vector = Float32Array.from([1.5, -2.25, 3.125, 1e-7]);
  const encoded = encodeVector(vector);
  assert.equal(encoded.length, 16);
  assert.equal(encoded.readFloatLE(4), -2.25);
  assert.deepEqual([...decodeVector(encoded)], [...vector]);
  assert.equal(decodeVector(Buffer.alloc(3)), null);
  assert.ok(Math.abs(cosineSimilarity(vector, vector.map((x) => x * 9)) - 1) < 1e-6);
  assert.equal(cosineSimilarity(vector, Float32Array.from([1, 2, 3])), null);
  assert.equal(cosineSimilarity(vector, new Float32Array(4)), null);
});

test('photo vectors are stored as unit-length float16; float32 rows from earlier builds still read', () => {
  // Every finite half value round-trips exactly; float32 input rounds to the nearest half.
  for (let h = 0; h < 0x10000; h++) {
    const value = fromHalf(h);
    if (!Number.isNaN(value) && value !== 0) assert.equal(toHalf(value), h);
  }
  assert.equal(fromHalf(toHalf(0.1)), 0.0999755859375);
  const vector = Float32Array.from([1.5, -2.25, 3.125, 1e-7]);
  const encoded = encodeHalfVector(vector);
  assert.equal(encoded.length, 8);
  const decoded = decodeStoredVector(encoded, 4);
  assert.ok(Math.abs(Math.hypot(...decoded) - 1) < 1e-3, 'stored at unit length');
  assert.ok(cosineSimilarity(decoded, vector) > 0.9999);
  assert.deepEqual([...decodeStoredVector(encodeVector(vector), 4)], [...vector], 'float32 rows read unchanged');
  assert.equal(decodeStoredVector(Buffer.alloc(6), 4), null);
  withRepo((repo) => {
    const store = repo.embeddings;
    const space = store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(512) });
    addAsset(repo, 'a1'); addAsset(repo, 'a2');
    store.save({ assetId: 'a1', spaceId: space.id, source: store.sourceOf('a1'), imageSha256: 'f'.repeat(64), vector: wave(512, 1) });
    assert.equal(repo.db.prepare('SELECT length(vector) AS n FROM asset_embeddings').get().n, 1024, 'two bytes per dimension');
    assert.equal(repo.db.prepare('SELECT length(calibration) AS n FROM embedding_spaces').get().n, 2048, 'calibration stays float32');
    // A float32 row written before float16 storage still counts and reads.
    repo.db.prepare(`INSERT INTO asset_embeddings (asset_id, space_id, source_checksum, source_thumbhash, image_sha256, vector, created_at)
      VALUES ('a2', ?, 'sum-a2', 'hash-a2', ?, ?, '2026-09-28T00:00:00Z')`).run(space.id, 'e'.repeat(64), encodeVector(wave(512, 2)));
    const both = store.vectors(space.id, ['a1', 'a2']);
    assert.equal(both.size, 2);
    assert.ok(Math.abs(cosineSimilarity(both.get('a1'), both.get('a2')) - cosineSimilarity(wave(512, 1), wave(512, 2))) < 1e-4);
  });
});

test('spaces are matched by calibration output, not by model name alone', () => {
  withRepo((repo) => {
    const store = repo.embeddings;
    const first = store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(512), now: '2026-09-27T00:00:00Z' });
    assert.equal(first.created, true);
    assert.equal(first.replacesEarlier, false);
    assert.equal(first.dims, 512);
    // Runtime noise (cosine ≈ 0.99999) keeps the same space and marks it verified.
    const noisy = wave(512).map((x, i) => x + 1e-4 * Math.cos(i));
    const again = store.resolveSpace({ backend, model, calibrationVersion, calibration: noisy, now: '2026-09-28T00:00:00Z' });
    assert.equal(again.id, first.id);
    assert.equal(again.created, false);
    assert.equal(store.latestSpace({ backend, model }).verifiedAt, '2026-09-28T00:00:00Z');
    // A preprocessing change under the same model name is a different space.
    const changed = store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(512, 0.6), now: '2026-09-29T00:00:00Z' });
    assert.notEqual(changed.id, first.id);
    assert.equal(changed.replacesEarlier, true);
    assert.equal(store.latestSpace({ backend, model }).id, changed.id);
    // Returning to the earlier output reuses its space rather than a third one.
    assert.equal(store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(512), now: '2026-09-30T00:00:00Z' }).id, first.id);
    assert.equal(store.latestSpace({ backend, model }).id, first.id);
    // Different model or dimensions never share a space.
    assert.notEqual(store.resolveSpace({ backend, model: 'ViT-B-16-SigLIP__webli', calibrationVersion, calibration: wave(512) }).id, first.id);
    assert.equal(store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(768) }).dims, 768);
    assert.equal(store.matchSpace({ backend, model, calibrationVersion, calibration: wave(512, 2) }), null);
  });
});

test('an unstable service stops creating spaces for a model', () => {
  withRepo((repo) => {
    const store = new EmbeddingStore(repo.db, { limits: { spacesPerModel: 3, lookupChunk: 500, coverageCacheMs: 0 } });
    for (let i = 0; i < 3; i++) store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64, i) });
    assert.throws(() => store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64, 9) }), { code: 'ml_unstable_output' });
    // Known outputs remain usable.
    assert.equal(store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64, 1) }).created, false);
  });
});

test('saved vectors are current until the photo’s rendition changes', () => {
  withRepo((repo) => {
    const store = repo.embeddings;
    const space = store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64) });
    addAsset(repo, 'a1'); addAsset(repo, 'a2', { thumbhash: null });
    const vector = wave(64, 1.2, 3);
    store.save({ assetId: 'a1', spaceId: space.id, source: store.sourceOf('a1'), imageSha256: 'f'.repeat(64), vector });
    store.save({ assetId: 'a2', spaceId: space.id, source: store.sourceOf('a2'), imageSha256: 'e'.repeat(64), vector: wave(64, 2) });
    assert.equal(store.isCurrent('a1', space.id), true);
    assert.equal(store.isCurrent('a2', space.id), true, 'missing thumbhashes compare as equal NULLs');
    assert.equal(store.isCurrent('missing', space.id), false);
    const stored = store.vectors(space.id, ['a1', 'a1', 'missing']);
    assert.deepEqual([...stored.keys()], ['a1']);
    assert.ok(cosineSimilarity(stored.get('a1'), vector) > 0.9999, 'float16 keeps the direction');
    // An Immich edit regenerates the preview and its thumbhash.
    addAsset(repo, 'a1', { thumbhash: 'edited' });
    assert.equal(store.isCurrent('a1', space.id), false);
    assert.equal(store.vectors(space.id, ['a1']).size, 0);
    // Replacing the vector makes it current again.
    store.save({ assetId: 'a1', spaceId: space.id, source: store.sourceOf('a1'), imageSha256: 'd'.repeat(64), vector });
    assert.equal(store.isCurrent('a1', space.id), true);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 2);
    assert.throws(() => store.save({ assetId: 'a1', spaceId: space.id, source: {}, imageSha256: 'c'.repeat(64), vector: wave(32) }),
      { code: 'ml_output_changed' });
  });
});

test('coverage reports the latest space for the model and retained earlier vectors', () => {
  withRepo((repo) => {
    const store = new EmbeddingStore(repo.db, { limits: { spacesPerModel: 8, lookupChunk: 1, coverageCacheMs: 0 } });
    assert.deepEqual(store.coverage({ backend, model }), { space: null, vectors: 0, current: 0, otherVectors: 0 });
    const old = store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64) });
    for (const id of ['a1', 'a2', 'a3']) {
      addAsset(repo, id);
      store.save({ assetId: id, spaceId: old.id, source: store.sourceOf(id), imageSha256: '0'.repeat(64), vector: wave(64, id.length) });
    }
    const current = store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64, 1.1) });
    store.save({ assetId: 'a1', spaceId: current.id, source: store.sourceOf('a1'), imageSha256: '1'.repeat(64), vector: wave(64, 3) });
    store.save({ assetId: 'a2', spaceId: current.id, source: store.sourceOf('a2'), imageSha256: '2'.repeat(64), vector: wave(64, 4) });
    addAsset(repo, 'a2', { thumbhash: 'edited' });
    const coverage = store.coverage({ backend, model });
    assert.equal(coverage.vectors, 2);
    assert.equal(coverage.current, 1);
    assert.equal(coverage.otherVectors, 3);
    assert.equal(coverage.space.dims, 64);
    assert.equal(store.vectors(current.id, ['a1', 'a2', 'a3']).size, 1, 'chunked lookups exclude stale and absent photos');
  });
});

test('the schema rejects impossible vectors and survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-embeddings-'));
  try {
    const path = join(dir, 'enrichment.sqlite');
    let repo = new Repository(path);
    repo.initSchema();
    const space = repo.embeddings.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64) });
    assert.throws(() => repo.db.prepare(`INSERT INTO asset_embeddings (asset_id, space_id, image_sha256, vector, created_at)
      VALUES ('x', ?, 'h', x'', 'now')`).run(space.id), /CHECK constraint failed/);
    addAsset(repo, 'a1');
    repo.embeddings.save({ assetId: 'a1', spaceId: space.id, source: repo.embeddings.sourceOf('a1'), imageSha256: 'a'.repeat(64), vector: wave(64) });
    repo.close();
    repo = new Repository(path);
    assert.equal(repo.initSchema().applied.length, 0);
    assert.equal(repo.embeddings.vectors(space.id, ['a1']).size, 1);
    repo.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('currency is exact with bytes in hand and excludes deleted photos and corrupted rows', () => {
  withRepo((repo) => {
    const store = new EmbeddingStore(repo.db, { limits: { spacesPerModel: 8, lookupChunk: 500, coverageCacheMs: 0 } });
    const space = store.resolveSpace({ backend, model, calibrationVersion, calibration: wave(64) });
    addAsset(repo, 'a1'); addAsset(repo, 'a2');
    store.save({ assetId: 'a1', spaceId: space.id, source: store.sourceOf('a1'), imageSha256: 'a'.repeat(64), vector: wave(64, 1) });
    store.save({ assetId: 'a2', spaceId: space.id, source: store.sourceOf('a2'), imageSha256: 'b'.repeat(64), vector: wave(64, 2) });
    assert.equal(store.isCurrent('a1', space.id, { imageSha256: 'a'.repeat(64) }), true);
    assert.equal(store.isCurrent('a1', space.id, { imageSha256: 'c'.repeat(64) }), false, 'different bytes are not current');
    assert.throws(() => store.save({ assetId: 'a1', spaceId: space.id, source: {}, imageSha256: 'not-a-hash', vector: wave(64) }));

    // Adoption only applies to identical bytes.
    addAsset(repo, 'a1', { thumbhash: 'edited' });
    assert.equal(store.adopt({ assetId: 'a1', spaceId: space.id, source: store.sourceOf('a1'), imageSha256: 'c'.repeat(64) }), false);
    assert.equal(store.isCurrent('a1', space.id), false);
    assert.equal(store.adopt({ assetId: 'a1', spaceId: space.id, source: store.sourceOf('a1'), imageSha256: 'a'.repeat(64) }), true);
    assert.equal(store.isCurrent('a1', space.id), true);

    // A photo Immich no longer has is never current.
    repo.markAssetsMissing(['a2']);
    assert.equal(store.isCurrent('a2', space.id), false);
    assert.deepEqual([...store.vectors(space.id, ['a1', 'a2']).keys()], ['a1']);
    assert.equal(store.coverage({ backend, model }).current, 1);

    // A row whose bytes no longer match its space is excluded on read.
    repo.db.prepare('UPDATE asset_embeddings SET vector=? WHERE asset_id=?').run(Buffer.alloc(32), 'a1');
    assert.equal(store.vectors(space.id, ['a1']).size, 0);
  });
});
