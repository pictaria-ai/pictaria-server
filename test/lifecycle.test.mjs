import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { awaitDrain, createLifecycle } from '../src/lifecycle.mjs';
import { SmartAlbumScheduler } from '../src/albums/scheduler.mjs';
import { InsightsCollector } from '../src/insights/collector.mjs';
import { EnrichJobRunner } from '../src/enrich/jobRunner.mjs';
import { RefereeService } from '../src/enrich/refereeService.mjs';
import { annotateBursts } from '../src/enrich/reviewService.mjs';
import { loadTaxonomy } from '../src/enrich/taxonomy.mjs';

// The shutdown contracts: the lifecycle helper itself (tracked timers, the
// drain registry, bounded waits) and each service's stop() — every timer
// owned, every in-flight task drained within a budget, nothing firing into
// a closed world after stop() resolves.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition never became true');
    }
    await sleep(5);
  }
}

function gate() {
  let release;
  const opened = new Promise((resolve) => { release = resolve; });
  return { opened, release };
}

// ---------------------------------------------------------------- awaitDrain

test('awaitDrain: nothing pending and settled promises drain immediately', async () => {
  assert.equal(await awaitDrain(null, 50), true);
  assert.equal(await awaitDrain(Promise.resolve('done'), 50), true);
  // Settled is settled — a rejected drain target still counts as drained.
  const rejected = Promise.reject(new Error('already handled elsewhere'));
  rejected.catch(() => {});
  assert.equal(await awaitDrain(rejected, 50), true);
});

test('awaitDrain gives up (false) when the budget runs out', async () => {
  const started = Date.now();
  assert.equal(await awaitDrain(new Promise(() => {}), 50), false);
  assert.ok(Date.now() - started < 1000, 'must resolve at the budget, not hang');
});

test('shutdown deadlines keep a handle-less child alive until both bounds settle', () => {
  const lifecycleUrl = new URL('../src/lifecycle.mjs', import.meta.url).href;
  const script = `
    const { awaitDrain, createLifecycle } = await import(${JSON.stringify(lifecycleUrl)});
    if (await awaitDrain(new Promise(() => {}), 25) !== false) {
      throw new Error('awaitDrain did not report its timeout');
    }
    const lifecycle = createLifecycle({ warn: () => {} });
    lifecycle.register('stalled', 25, () => new Promise(() => {}));
    const [result] = await lifecycle.drainServices();
    if (result.status !== 'fulfilled' || result.value !== 'timeout') {
      throw new Error('drainServices did not report its timeout');
    }
    process.stdout.write('resumed');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(
    child.status,
    0,
    `child failed before both bounded waits resumed (signal=${child.signal}):\n${child.stderr}`,
  );
  assert.equal(child.stdout, 'resumed');
});

// ------------------------------------------------------------ tracked timers

test('lifecycle timers fire normally but never after clearTimers', async () => {
  const lifecycle = createLifecycle({ warn: () => {} });
  const fired = [];
  lifecycle.setTimeout(() => fired.push('fast-timeout'), 10);
  lifecycle.setInterval(() => fired.push('fast-interval'), 15);
  await sleep(40);
  assert.ok(fired.includes('fast-timeout'));
  assert.ok(fired.includes('fast-interval'));

  lifecycle.setTimeout(() => fired.push('late-timeout'), 30);
  lifecycle.setInterval(() => fired.push('late-interval'), 30);
  lifecycle.clearTimers();
  assert.equal(lifecycle.stopped, true);
  await sleep(90);
  assert.equal(fired.includes('late-timeout'), false, 'cleared timeout must not fire');
  assert.equal(fired.includes('late-interval'), false, 'cleared interval must not fire');
});

// ------------------------------------------------------------ drain registry

test('drainServices names its laggards and survives broken stop()s', async () => {
  const warnings = [];
  const lifecycle = createLifecycle({ warn: (message) => warnings.push(message) });
  const stopped = [];

  lifecycle.register('clean', 100, async (timeoutMs) => {
    stopped.push(['clean', timeoutMs]);
    return true;
  });
  lifecycle.register('gave-up', 50, async () => false); // bounded wait that timed out internally
  lifecycle.register('ignores-budget', 50, () => new Promise(() => {})); // never resolves
  lifecycle.register('throws-sync', 50, () => { throw new Error('kapow'); });
  lifecycle.register('rejects', 50, async () => { throw new Error('splat'); });

  await lifecycle.drainServices();

  assert.deepEqual(stopped, [['clean', 100]], 'stop() receives its own budget');
  assert.ok(warnings.some((w) => w.includes('gave-up') && w.includes('did not drain within 50ms')));
  assert.ok(warnings.some((w) => w.includes('ignores-budget') && w.includes('did not drain')));
  assert.ok(warnings.some((w) => w.includes('throws-sync') && w.includes('kapow')));
  assert.ok(warnings.some((w) => w.includes('rejects') && w.includes('splat')));
  assert.equal(warnings.some((w) => w.includes('clean')), false, 'a clean drain is silent');
});

// ---------------------------------------------------- SmartAlbumScheduler

test('scheduler stop() before the boot kick leaves the store untouched (the probe)', async () => {
  const calls = [];
  const store = { listJobs: async () => { calls.push(Date.now()); return []; } };
  const scheduler = new SmartAlbumScheduler({ immich: {}, store, config: {}, bootDelayMs: 40, intervalMs: 60_000 });
  scheduler.start();
  assert.equal(await scheduler.stop(), true);
  // Well past the boot delay: the old unowned setTimeout would fire here.
  await sleep(120);
  assert.equal(calls.length, 0, 'no tick may fire after stop()');
});

test('scheduler stop() drains an in-flight tick, bounded', async () => {
  const { opened, release } = gate();
  let inFlight = false;
  let finished = false;
  const store = {
    listJobs: async () => {
      inFlight = true;
      await opened;
      finished = true;
      return [];
    },
  };
  const scheduler = new SmartAlbumScheduler({ immich: {}, store, config: {}, bootDelayMs: 5, intervalMs: 60_000 });
  scheduler.start();
  await waitFor(() => inFlight);

  // Bounded: the hung tick makes stop() give up at its budget...
  assert.equal(await scheduler.stop(50), false);
  // ...and once the tick can finish, a later drain sees it settled.
  release();
  assert.equal(await scheduler.stop(1000), true);
  assert.equal(finished, true);
});

// ------------------------------------------------------- InsightsCollector

function collectorFixture({ searchMetadata }) {
  const repoCalls = [];
  let closed = false;
  const repo = {
    getMeta: () => {
      if (closed) throw new Error('database is closed');
      return null;
    },
    beginSweepStaging: () => repoCalls.push('begin'),
    insertAssets: () => repoCalls.push('insert'),
    abortSweepStaging: () => repoCalls.push('abort'),
  };
  const collector = new InsightsCollector({
    repo,
    immich: { baseUrl: 'http://immich.test', apiKey: 'k', searchMetadata },
    config: { sweepPageSize: 10, maxSweepPages: 5, refreshIntervalHours: 24 },
  });
  return { collector, repoCalls, close: () => { closed = true; } };
}

test('collector stop() cancels and drains the in-flight run, then guards the closed repo', async () => {
  const { opened, release } = gate();
  let sweeping = false;
  const { collector, repoCalls, close } = collectorFixture({
    searchMetadata: async () => {
      sweeping = true;
      await opened;
      return { assets: { items: [], nextPage: null } };
    },
  });
  collector.startAutoRefresh();
  collector.checkSoon();
  collector.start();
  await waitFor(() => sweeping);

  const stopPromise = collector.stop(2000);
  release();
  assert.equal(await stopPromise, true);

  assert.equal(collector.isRunning(), false);
  assert.equal(collector.state.phase, 'cancelled');
  assert.ok(repoCalls.includes('abort'), 'a cancelled sweep drops its staging');
  assert.equal(collector.timer, null);
  assert.equal(collector.bootTimer, null);
  assert.equal(collector.soonTimer, null);

  // Post-shutdown pokes must not reach the (now closed) database.
  close();
  assert.doesNotThrow(() => collector.checkStaleness());
  assert.doesNotThrow(() => collector.checkSoon());
  assert.equal(collector.soonTimer, null, 'no timer may be armed after stop()');
  assert.throws(() => collector.start(), /shutting down/);
  assert.equal(collector.isRunning(), false);
});

test('collector stop() gives up (false) on a run stuck in a stalled Immich call', async () => {
  const { opened, release } = gate();
  const { collector } = collectorFixture({
    searchMetadata: async () => {
      await opened;
      return { assets: { items: [], nextPage: null } };
    },
  });
  collector.start();
  assert.equal(await collector.stop(50), false);
  release(); // let the dangling run settle before the test ends
  await collector.runPromise;
});

// --------------------------------------------------------- EnrichJobRunner

const taxonomy = loadTaxonomy(fileURLToPath(new URL('../taxonomy/v1.json', import.meta.url)));

function runnerFixture({ getAsset }) {
  const runs = [];
  const repo = {
    runs,
    upsertAsset() {},
    hasAnySuccessfulRun: () => true,
    hasSuccessfulRun: () => false,
    failureCount: () => 0,
    recordProcessingRun() {},
    recordJobRun(row) { runs.push(row); },
    reviewListAdd: (assetIds) => assetIds.length,
    markAssetsMissing: () => 0,
    libraryStats: () => ({ enrichedTotal: 0, curatedTotal: 0 }),
  };
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset },
    taxonomy,
    config: {
      promptsDir: fileURLToPath(new URL('../prompts', import.meta.url)),
      promptVersion: 'v1',
      promptOverrides: { systemPrompt: '', userTemplate: '' },
      defaultProvider: 'local_lmstudio',
      imageSource: 'preview',
      maxFailuresPerAsset: 2,
      providers: {
        local_lmstudio: { modelName: 'test-model', baseUrl: 'http://127.0.0.1:9', apiKey: 'lm-studio' },
      },
    },
  });
  return { runner, runs };
}

test('jobRunner stop() cancels and drains the run — one cancelled record, no interrupted one', async () => {
  const { opened, release } = gate();
  let fetching = false;
  const { runner, runs } = runnerFixture({
    getAsset: async (id) => {
      fetching = true;
      await opened;
      return { id, originalPath: `${id}.jpg` };
    },
  });
  runner.start({ assetIds: ['a1', 'a2'], title: 'Drain test' });
  await waitFor(() => fetching);

  const stopPromise = runner.stop(3000);
  release();
  assert.equal(await stopPromise, true);

  assert.equal(runner.isRunning(), false);
  assert.equal(runs.length, 1, 'exactly one history row');
  assert.equal(runs[0].status, 'cancelled');
});

test('jobRunner stop() past its budget records the run as interrupted', async () => {
  const { opened, release } = gate();
  const { runner, runs } = runnerFixture({
    getAsset: async (id) => {
      await opened;
      return { id, originalPath: `${id}.jpg` };
    },
  });
  runner.start({ assetIds: ['a1'], title: 'Stuck run' });

  assert.equal(await runner.stop(50), false);
  assert.ok(runs.some((run) => run.status === 'interrupted'), 'a stuck run must not vanish from history');

  release(); // let the dangling run settle before the test ends
  await runner.runPromise;
  assert.equal(runner.isRunning(), false);
});

test('jobRunner stop() while idle is an immediate true', async () => {
  const { runner, runs } = runnerFixture({ getAsset: async () => ({}) });
  assert.equal(await runner.stop(50), true);
  assert.equal(runs.length, 0);
});

// ---------------------------------------------------------- RefereeService

function refereeFixture({ getAssetThumbnail }) {
  const recorded = new Set();
  const service = new RefereeService({
    repo: {
      refereeHasGroup: (key) => recorded.has(key),
      refereeRecordGroup: ({ groupKey }) => { recorded.add(groupKey); },
      refereeStats: () => ({ groups: recorded.size, photos: recorded.size * 2 }),
    },
    immich: { getAssetThumbnail },
    review: {
      annotatedReviewRows: () =>
        annotateBursts([
          { assetId: 'g1', capturedAt: '2026-07-01T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.8, filename: 'g1.jpg' },
          { assetId: 'g2', capturedAt: '2026-07-01T10:00:05.000Z', state: 'undecided', aiTags: [], frameScore: 0.7, filename: 'g2.jpg' },
        ]),
    },
    enrichRunner: { isRunning: () => false },
    config: { enrichEnabled: true, curateRefereeEnabled: true, defaultProvider: 'x', providers: {} },
  });
  service.makeProvider = () => ({
    providerName: 'fake',
    modelName: 'fake-vl',
    analyzeImages: async () => ({
      normalizedOutput: {
        same_subject: true,
        photos: [
          { photo: 1, rank: 1, keep: true, eyes_closed: 'no', note: 'sharp' },
          { photo: 2, rank: 2, keep: false, eyes_closed: 'no', note: 'soft' },
        ],
      },
    }),
  });
  return { service, recorded };
}

test('referee stop() drains the in-flight group and halts the contiguous block', async () => {
  const { opened, release } = gate();
  let fetching = false;
  const { service, recorded } = refereeFixture({
    getAssetThumbnail: async (assetId) => {
      fetching = true;
      await opened;
      return { data: Buffer.from(assetId), contentType: 'image/jpeg' };
    },
  });
  // What start()'s interval callback does; POLL_MS is 60s, too slow to wait for.
  service._tickPromise = service.tick();
  await waitFor(() => fetching);

  const stopPromise = service.stop(2000);
  release();
  assert.equal(await stopPromise, true);
  assert.equal(recorded.size, 1, 'the in-flight verdict lands; no next group starts');
  assert.equal(service._timer, null);
  assert.equal(service.status().working, false);
});

test('referee stop() gives up (false) on a group stuck in a long provider call', async () => {
  const { opened, release } = gate();
  const { service } = refereeFixture({
    getAssetThumbnail: async (assetId) => {
      await opened;
      return { data: Buffer.from(assetId), contentType: 'image/jpeg' };
    },
  });
  service._tickPromise = service.tick();
  assert.equal(await service.stop(50), false);
  release(); // let the dangling tick settle before the test ends
  await service._tickPromise;
});
