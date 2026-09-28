import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import { EMBEDDING_LIMITS, EmbeddingService, PredictionLane } from '../../src/embeddings/service.mjs';
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
    assert.match(first.log.at(-1), /2 new, 0 already current, 0 skipped, 0 too slow, 0 failed/);
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
    assert.match(log.at(-1), /1 new, 0 already current, 1 skipped, 0 too slow, 0 failed/);
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
      ok: true, model: 'ViT-B-16-SigLIP__webli', dims: 768, elapsedMs: 'number', vectors: 'first-set' });
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

test('closing never waits for an unabortable preview download', async () => {
  await withService(async ({ repo, service }) => {
    addAssets(repo, 'a1');
    const session = service.session();
    await session.start();
    let finish;
    const download = new Promise((resolve) => { finish = resolve; });
    const pending = session.embed({ assetId: 'a1', loadImage: () => download });
    const started = Date.now();
    await session.close({ cancelled: true });
    assert.ok(Date.now() - started < 900, 'bounded by closeGraceMs');
    finish(photo('a1'));
    assert.equal(await pending, 'cancelled', 'a late download is never embedded or stored');
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 0);
  }, { serviceLimits: { ...limits, closeGraceMs: 200 } });
});

test('a model download that outlasts Test connection explains itself', async () => {
  await withService(async ({ ml, service }) => {
    ml.state.delayMs = 300;
    await assert.rejects(service.test({}), (error) => {
      assert.equal(error.code, 'ml_timeout');
      assert.match(error.message, /first use downloads it inside this request; try again in a few minutes/);
      return true;
    });
  }, { serviceLimits: { ...limits, testTimeoutMs: 100 } });
});

test('work still running when the photo’s wait expires is aborted, drained and counted as too slow', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1', 'a2', 'a3', 'a4');
    const log = [];
    const session = service.session({ log: (message) => log.push(message) });
    await session.start();
    ml.state.delayMs = 400; // slower than settleMs (60 ms here)
    for (const id of ['a1', 'a2', 'a3']) {
      const pending = session.embed({ assetId: id, image: photo(id) });
      const started = Date.now();
      await session.settle(pending);
      assert.ok(Date.now() - started < 300, 'the wait is bounded and the request aborted');
      assert.equal(await pending, 'late');
      assert.equal(session.request, null, 'nothing left running between photos');
    }
    assert.equal(session.counts.late, 3);
    assert.equal(session.stopped, 'ml_late');
    assert.equal(session.embed({ assetId: 'a4', image: photo('a4') }), null);
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 0, 'late answers are never stored');
    assert.match(log.join('\n'), /paused for the rest of this run: the machine-learning service took longer than 0 seconds/);
    assert.match(log.at(-1), /3 too slow/);
    assert.ok(service.status().lastRun.wait.maxMs < 300);
  }, { serviceLimits: { ...limits, settleMs: 60 } });
});

test('an expired wait also aborts a preview download in progress', async () => {
  await withService(async ({ repo, service }) => {
    addAssets(repo, 'a1');
    const session = service.session();
    await session.start();
    let aborted = false;
    const pending = session.embed({ assetId: 'a1', loadImage: (signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }) });
    await session.settle(pending);
    assert.equal(aborted, true);
    assert.equal(await pending, 'late');
    await session.close();
  }, { serviceLimits: { ...limits, settleMs: 50 } });
});

test('database failures stop the session as storage problems, not machine-learning ones', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1', 'a2');
    const log = [];
    const session = service.session({ log: (message) => log.push(message) });
    await session.start();
    const original = repo.embeddings.save;
    repo.embeddings.save = () => { throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' }); };
    assert.equal(await session.embed({ assetId: 'a1', image: photo('a1') }), 'storage-error');
    repo.embeddings.save = original;
    assert.equal(session.stopped, 'storage_error');
    assert.equal(session.counts.failed, 0, 'not counted as a machine-learning failure');
    assert.equal(session.embed({ assetId: 'a2', image: photo('a2') }), null);
    await session.close();
    assert.match(log.join('\n'), /Enrich database rejected an embedding read or write \(database or disk is full\)\. This is a storage problem/);
    assert.match(errors.join('\n'), /\[Pictaria\] Image embeddings could not read or write the Enrich database: database or disk is full/);
    assert.equal(service.status().lastRun.stopped, 'storage_error');
    assert.match(service.status().lastRun.reason, /storage problem/);
    assert.equal(ml.predictions(), 2, 'the calibration and the one request that could not be saved');
  });
  // Reads fail the same way.
  await withService(async ({ repo, service }) => {
    const session = service.session({ log: () => {} });
    await session.start();
    repo.embeddings.isCurrent = () => { throw new Error('database disk image is malformed'); };
    assert.equal(session.embed({ assetId: 'a1', image: photo('a1') }), null);
    assert.equal(session.stopped, 'storage_error');
    await session.close();
  });
});

test('identical preview bytes under changed metadata are adopted without a request', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1');
    await run(service, [['a1', photo('a1')]]);
    const requests = ml.predictions();
    // An Immich edit can change the thumbhash while the unedited preview stays identical.
    repo.upsertAsset({ id: 'a1', checksum: 'sum-a1', thumbhash: 'edited-hash' });
    const space = repo.embeddings.latestSpace({ backend: 'immich_ml', model: 'ViT-B-32__openai' });
    assert.equal(repo.embeddings.isCurrent('a1', space.id), false);
    const second = await run(service, [['a1', photo('a1')]]);
    assert.deepEqual(second.outcomes, ['current']);
    assert.equal(ml.predictions(), requests + 1, 'only the calibration');
    assert.equal(repo.embeddings.isCurrent('a1', space.id), true);
    assert.equal(repo.db.prepare('SELECT source_thumbhash FROM asset_embeddings').get().source_thumbhash, 'edited-hash');
  });
});

test('changed preview bytes under unchanged metadata are re-embedded when the bytes are in hand', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1');
    await run(service, [['a1', photo('a1')]]);
    const before = repo.db.prepare('SELECT image_sha256, hex(vector) AS vector FROM asset_embeddings').get();
    // e.g. Immich's preview size or format changed and previews were regenerated.
    const regenerated = { data: Buffer.from('regenerated-preview-a1'), contentType: 'image/webp' };
    const second = await run(service, [['a1', regenerated]]);
    assert.deepEqual(second.outcomes, ['embedded']);
    const after = repo.db.prepare('SELECT image_sha256, hex(vector) AS vector FROM asset_embeddings').get();
    assert.notEqual(after.image_sha256, before.image_sha256);
    assert.notEqual(after.vector, before.vector);
    assert.equal(ml.state.requests.at(-1).contentType, 'image/webp');
  });
});

test('a known model returning the wrong number of dimensions is rejected before storage', async () => {
  await withService(async ({ repo, ml, service }) => {
    ml.state.dims = 768; // e.g. a proxy routing to a service running a different model
    const log = [];
    const session = service.session({ log: (message) => log.push(message) });
    await session.start();
    assert.equal(session.stopped, 'ml_invalid_response');
    assert.match(log.join('\n'), /returned 768 values; ViT-B-32__openai produces 512/);
    await session.close();
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM embedding_spaces').get().n, 0);
  });
});

test('no new embedding starts once the run has been cancelled', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1');
    const run = new AbortController();
    const session = service.session({ signal: run.signal });
    await session.start();
    const before = ml.predictions();
    run.abort();
    assert.equal(session.embed({ assetId: 'a1', image: photo('a1') }), null);
    assert.equal(session.counts.paused, 1);
    await session.close({ cancelled: true });
    assert.equal(ml.predictions(), before);
  });
});

test('the prediction lane serves one request at a time by priority, then arrival, and drops aborted waiters', async () => {
  const lane = new PredictionLane();
  const order = [];
  let finishFirst;
  const first = lane.run(() => new Promise((resolve) => { finishFirst = () => { order.push('first'); resolve(); }; }), { priority: 0 });
  const lab = lane.run(async () => { order.push('lab'); }, { priority: 0 });
  const test = lane.run(async () => { order.push('test'); }, { priority: 1 });
  const aborted = new AbortController();
  const dropped = lane.run(async () => { order.push('dropped'); }, { priority: 2, signal: aborted.signal });
  const enrich = lane.run(async () => { order.push('enrich'); }, { priority: 2 });
  const impatient = lane.run(async () => { order.push('impatient'); }, { priority: 1, waitMs: 20 });
  aborted.abort();
  await assert.rejects(dropped, { name: 'AbortError' });
  await assert.rejects(impatient, { code: 'ml_busy' });
  assert.equal(lane.busy, true);
  finishFirst();
  await Promise.all([first, lab, test, enrich]);
  assert.deepEqual(order, ['first', 'enrich', 'test', 'lab']);
  assert.equal(lane.busy, false);
  await assert.rejects(lane.run(async () => { throw new Error('work failed'); }), /work failed/);
  assert.equal(lane.busy, false, 'released after failed work');
  const early = new AbortController(); early.abort();
  await assert.rejects(lane.run(async () => order.push('never'), { signal: early.signal }), { name: 'AbortError' });
  assert.equal(order.includes('never'), false);
});

test('Enrich starting during a lab photo preempts it: never two predictions in flight', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1', 'a2');
    const lab = service.labPass();
    await lab.start({ waitForModel: true });
    Object.assign(ml.state, { slowAfter: 1, slowMs: 600 });
    const labPhoto = lab.embed({ assetId: 'a1', image: photo('a1') });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ml.state.inFlight, 1);
    const log = [];
    const enrich = service.session({ log: (message) => log.push(message) });
    assert.equal(lab.stopped, 'preempted');
    assert.equal(await labPhoto, 'cancelled');
    Object.assign(ml.state, { slowAfter: 0, slowMs: 0 });
    await enrich.start();
    assert.ok(enrich.space, 'Enrich calibrated after the lab request drained');
    assert.equal(await enrich.embed({ assetId: 'a2', image: photo('a2') }), 'embedded');
    await Promise.all([lab.close(), enrich.close()]);
    assert.equal(ml.state.maxInFlight, 1);
    assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM asset_embeddings WHERE asset_id='a1'").get().n, 0);
    assert.match(lab.reason, /An Enrich run started embedding photos/);
  }, { enabled: true });
});

test('a connection test waits for an in-flight calibration instead of overlapping it, or reports busy', async () => {
  await withService(async ({ ml, service }) => {
    Object.assign(ml.state, { slowAfter: 0, slowMs: 400 });
    const enrich = service.session();
    const starting = enrich.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(ml.state.inFlight, 1);
    const result = await service.test({});
    assert.equal(result.ok, true);
    await starting;
    await enrich.close();
    assert.equal(ml.state.maxInFlight, 1);
  }, { serviceLimits: { ...limits, calibrationWaitMs: 2_000 } });
  await withService(async ({ ml, service }) => {
    Object.assign(ml.state, { slowAfter: 0, slowMs: 500 });
    const enrich = service.session();
    const starting = enrich.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = ml.predictions();
    await assert.rejects(service.test({}), { code: 'ml_busy' });
    assert.equal(ml.predictions(), before, 'the test never reached the service');
    await starting;
    await enrich.close();
    assert.equal(ml.state.maxInFlight, 1);
  }, { serviceLimits: { ...limits, calibrationWaitMs: 2_000, testLaneWaitMs: 50 } });
});

test('a lab pass cannot start while Enrich holds the service, and its waiting request is dropped when cancelled', async () => {
  await withService(async ({ repo, ml, service }) => {
    addAssets(repo, 'a1');
    const enrich = service.session();
    await enrich.start();
    assert.throws(() => service.labPass(), { code: 'ml_busy' });
    Object.assign(ml.state, { slowAfter: 0, slowMs: 400 });
    const photoRequest = enrich.embed({ assetId: 'a1', image: photo('a1') });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A second Enrich-priority waiter behind it, cancelled before its turn.
    const waiter = new AbortController();
    let ran = false;
    const queued = service.lane.run(async () => { ran = true; }, { priority: 2, signal: waiter.signal });
    waiter.abort();
    await assert.rejects(queued, { name: 'AbortError' });
    assert.equal(await photoRequest, 'embedded');
    assert.equal(ran, false, 'the cancelled waiter never ran');
    assert.equal(ml.predictions(), 2, 'the calibration and the one photo');
    await enrich.close();
    assert.equal(ml.state.maxInFlight, 1);
  }, { enabled: true });
});
