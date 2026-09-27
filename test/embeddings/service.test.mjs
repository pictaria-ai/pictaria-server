import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import { EMBEDDING_LIMITS, EmbeddingService } from '../../src/embeddings/service.mjs';
import { startFakeMl } from './fakeMl.mjs';

const photo = (id) => ({ data: Buffer.from(`preview-${id}`), contentType: 'image/jpeg' });
const limits = { ...EMBEDDING_LIMITS, calibrationWaitMs: 200, settleMs: 200, connectionCacheMs: 60_000, testTimeoutMs: 2_000 };

async function withService(work, { enabled = true, model = 'ViT-B-32__openai', url = null, serviceLimits = limits } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-embedding-service-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const ml = await startFakeMl();
  const config = { enrichEmbeddings: { enabled, url: url ?? ml.url, model } };
  const service = new EmbeddingService({ repo, config, limits: serviceLimits });
  try {
    await work({ repo, ml, config, service });
  } finally {
    await ml.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function addAssets(repo, ...ids) {
  for (const id of ids) repo.upsertAsset({ id, checksum: `sum-${id}`, thumbhash: `hash-${id}` });
}

async function run(service, photos, { log = [] } = {}) {
  const session = service.session({ log: (message) => log.push(message) });
  await session.start();
  const outcomes = [];
  for (const [assetId, image] of photos) {
    const pending = session.embed({ assetId, image });
    outcomes.push(pending ? await pending : null);
  }
  await session.close();
  return { session, outcomes, log };
}

test('no session is created while embeddings are off', async () => {
  await withService(async ({ service }) => {
    assert.equal(service.session(), null);
    assert.deepEqual(await service.connection(), { state: 'off' });
    assert.equal(service.status().connection.state, 'off');
  }, { enabled: false });
});

test('a session calibrates, stores one vector per photo and reuses current vectors', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1', 'a2');
    const first = await run(service, [['a1', photo('a1')], ['a2', photo('a2')]]);
    assert.deepEqual(first.outcomes, ['embedded', 'embedded']);
    assert.equal(ml.state.requests[0].bytes > 50_000, true, 'the calibration image is sent first');
    assert.equal(ml.predictions(), 3);
    assert.match(first.log.join('\n'), /image embeddings: on \(ViT-B-32__openai\)/);
    assert.match(first.log.join('\n'), /started a 512-dimension set/);
    assert.match(first.log.at(-1), /2 new, 0 already current, 0 skipped, 0 failed/);
    const space = repo.embeddings.latestSpace({ backend: 'immich_ml', model: 'ViT-B-32__openai' });
    assert.equal(repo.embeddings.vectors(space.id, ['a1', 'a2']).size, 2);
    assert.equal(repo.db.prepare('SELECT image_sha256 FROM asset_embeddings WHERE asset_id=?').get('a1').image_sha256.length, 64);

    // Next run: same calibration → same space; current vectors need no request.
    const second = await run(service, [['a1', photo('a1')], ['a2', photo('a2')]]);
    assert.deepEqual(second.outcomes, [null, null]);
    assert.equal(second.session.counts.current, 2);
    assert.equal(ml.predictions(), 4, 'only the calibration request');
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM embedding_spaces').get().n, 1);
    assert.equal(service.status().lastRun.current, 2);
  });
});

test('changed service output starts a new space and never mixes vectors', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1');
    await run(service, [['a1', photo('a1')]]);
    ml.state.variant = 1; // e.g. an Immich release with different CLIP preprocessing
    const log = [];
    const { outcomes } = await run(service, [['a1', photo('a1')]], { log });
    assert.deepEqual(outcomes, ['embedded'], 'the old vector belongs to the old space');
    assert.match(log.join('\n'), /returns different vectors, so a new set starts/);
    const spaces = repo.db.prepare('SELECT id FROM embedding_spaces ORDER BY id').all().map((row) => row.id);
    assert.equal(spaces.length, 2);
    for (const id of spaces) assert.equal(repo.embeddings.vectors(id, ['a1']).size, 1);
    assert.equal(service.status().coverage.otherVectors, 1);
  });
});

test('photos continue without vectors while the model loads, then embed once ready', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1', 'a2');
    ml.state.delayMs = 400; // longer than the session's calibration wait
    const log = [];
    const session = service.session({ log: (message) => log.push(message) });
    await session.start();
    assert.equal(session.embed({ assetId: 'a1', image: photo('a1') }), null);
    assert.equal(session.counts.waiting, 1);
    assert.match(log.join('\n'), /waiting for the machine-learning service to load the model/);
    await session.calibration;
    ml.state.delayMs = 0;
    assert.equal(await session.embed({ assetId: 'a2', image: photo('a2') }), 'embedded');
    await session.close();
    assert.match(log.at(-1), /1 new, 0 already current, 1 skipped, 0 failed/);
  });
});

test('one request is in flight at a time; busy photos are skipped, not queued', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1', 'a2');
    const session = service.session();
    await session.start();
    ml.state.delayMs = 150;
    const pending = session.embed({ assetId: 'a1', image: photo('a1') });
    assert.equal(session.embed({ assetId: 'a2', image: photo('a2') }), null);
    assert.equal(session.counts.busy, 1);
    await session.settle(pending);
    assert.equal(await pending, 'embedded');
    await session.close();
  });
});

test('previews are loaded on demand when Enrich downloaded another rendition', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1');
    const session = service.session();
    await session.start();
    let loads = 0;
    const outcome = await session.embed({ assetId: 'a1', loadImage: async () => { loads++; return photo('a1'); } });
    assert.equal(outcome, 'embedded');
    assert.equal(loads, 1);
    assert.equal(ml.state.requests.at(-1).bytes, photo('a1').data.length);
    // A failed preview download is one failed photo, not a service failure.
    addAssets(repo, 'a2');
    assert.equal(await session.embed({ assetId: 'a2', loadImage: async () => { throw new Error('Immich 404'); } }), 'failed');
    assert.equal(session.stopped, null);
    await session.close();
  });
});

test('repeated service failures pause the session; a rejected image does not', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1', 'a2', 'a3', 'a4', 'a5', 'a6');
    const log = [];
    const session = service.session({ log: (message) => log.push(message) });
    await session.start();
    ml.state.status = 400;
    for (const id of ['a1', 'a2', 'a3']) assert.equal(await session.embed({ assetId: id, image: photo(id) }), 'failed');
    assert.equal(session.stopped, null);
    ml.state.status = 503;
    for (const id of ['a4', 'a5', 'a6']) assert.equal(await session.embed({ assetId: id, image: photo(id) }), 'failed');
    assert.equal(session.stopped, 'ml_unavailable');
    ml.state.status = null;
    assert.equal(session.embed({ assetId: 'a1', image: photo('a1') }), null);
    assert.equal(session.counts.paused, 1);
    await session.close();
    assert.match(log.join('\n'), /paused for the rest of this run: The machine-learning service is temporarily unavailable/);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 0);
  });
});

test('an unreachable or unset service pauses quietly without throwing', async () => {
  await withService(async ({ service }) => {
    const log = [];
    const session = service.session({ log: (message) => log.push(message) });
    await session.start();
    assert.equal(session.stopped, 'ml_unreachable');
    assert.equal(session.embed({ assetId: 'a1', image: photo('a1') }), null);
    await session.close();
    assert.match(log.join('\n'), /image embeddings paused for this run: Could not reach the machine-learning service/);
  }, { url: 'http://127.0.0.1:9' });
  await withService(async ({ service }) => {
    const log = [];
    const session = service.session({ log: (message) => log.push(message) });
    await session.start();
    assert.equal(session.stopped, 'ml_not_configured');
    await session.close();
    assert.equal(log.length, 1);
    assert.deepEqual(service.status().connection, { state: 'not_configured' });
  }, { url: '' });
});

test('closing a cancelled run aborts in-flight work and keeps no partial vector', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1');
    const session = service.session();
    await session.start();
    ml.state.delayMs = 1_000;
    const pending = session.embed({ assetId: 'a1', image: photo('a1') });
    const started = Date.now();
    await session.close({ cancelled: true });
    assert.equal(await pending, 'cancelled');
    assert.ok(Date.now() - started < 500);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 0);
  });
});

test('the model is captured when the run starts', async () => {
  await withService(async ({ repo, ml, config, service }) => {
    addAssets(repo, 'a1');
    const session = service.session();
    await session.start();
    config.enrichEmbeddings.model = 'ViT-B-16-SigLIP__webli';
    assert.equal(await session.embed({ assetId: 'a1', image: photo('a1') }), 'embedded');
    await session.close();
    assert.deepEqual(new Set(ml.state.requests.map((request) => request.model)), new Set(['ViT-B-32__openai']));
  });
});

test('Test connection checks draft values without storing anything', async () => {
  await withService(async ({ repo, ml, service }) => {
    const result = await service.test({ url: ml.url, model: 'ViT-B-16-SigLIP__webli' });
    assert.deepEqual({ ...result, elapsedMs: typeof result.elapsedMs }, {
      ok: true, model: 'ViT-B-16-SigLIP__webli', dims: 512, elapsedMs: 'number', vectors: 'first-set' });
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM embedding_spaces').get().n, 0);
    await run(service, []);
    assert.equal((await service.test({})).vectors, 'reused');
    ml.state.variant = 3;
    assert.equal((await service.test({})).vectors, 'new-set');
    await assert.rejects(service.test({ model: 'bad name!' }), { code: 'ml_invalid_model' });
    await assert.rejects(service.test({ url: 'ftp://nope' }), { code: 'ml_invalid_url' });
    await assert.rejects(service.test({ model: 'Unknown__model' }), { code: 'ml_model_failed' });
    ml.state.delayMs = 100;
    const slow = service.test({});
    await assert.rejects(service.test({}), { code: 'ml_test_busy' });
    await slow;
  });
});

test('the home-page connection state is cached and reports the failure kind', async () => {
  await withService(async ({ ml, service }) => {
    assert.equal((await service.connection()).state, 'connected');
    ml.state.pong = 'nope';
    assert.equal((await service.connection()).state, 'connected', 'cached for a minute');
    const refreshed = await service.connection({ refresh: true });
    assert.equal(refreshed.state, 'not_immich');
    assert.match(refreshed.message, /not as the Immich machine-learning service/);
    assert.equal(service.status().connection.state, 'not_immich');
  });
});
