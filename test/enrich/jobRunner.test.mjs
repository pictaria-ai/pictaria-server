import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { loadTaxonomy } from '../../src/enrich/taxonomy.mjs';

const taxonomy = loadTaxonomy(fileURLToPath(new URL('../../taxonomy/v1.json', import.meta.url)));

function makeConfig() {
  return {
    promptsDir: fileURLToPath(new URL('../../prompts', import.meta.url)),
    promptVersion: 'v1',
    promptOverrides: { systemPrompt: '', userTemplate: '' },
    defaultProvider: 'local_lmstudio',
    imageSource: 'preview',
    maxFailuresPerAsset: 2,
    providers: {
      local_lmstudio: { modelName: 'test-model', baseUrl: 'http://127.0.0.1:9', apiKey: 'lm-studio' },
    },
  };
}

function makeRepo({ alreadyEnriched = true } = {}) {
  const runs = [];
  const processingRuns = [];
  const reviewListCalls = [];
  return {
    runs,
    processingRuns,
    reviewListCalls,
    upsertAsset() {},
    hasAnySuccessfulRun: () => alreadyEnriched,
    hasSuccessfulRun: () => false,
    failureCount: () => 0,
    isAssetDiscarded: () => false,
    recordProcessingRun(row) {
      processingRuns.push(row);
    },
    recordJobRun(row) {
      runs.push(row);
    },
    reviewListAdd(assetIds, source) {
      reviewListCalls.push({ assetIds: [...assetIds], source });
      return assetIds.length;
    },
    markAssetsMissing: () => 0,
    libraryStats: () => ({ enrichedTotal: 0, curatedTotal: 0 }),
  };
}

test('OpenAI-compatible is available only when its URL and model are configured', () => {
  const config = makeConfig();
  config.providers.openai_compatible = {
    baseUrl: 'http://llama.local:8080/v1',
    modelName: 'qwen-vision',
    apiKey: '',
  };
  const runner = new EnrichJobRunner({ repo: makeRepo(), immich: {}, taxonomy, config });
  assert.equal(
    runner.status().available.find((provider) => provider.name === 'openai_compatible').configured,
    true,
  );

  config.providers.openai_compatible.modelName = '';
  assert.equal(
    runner.status().available.find((provider) => provider.name === 'openai_compatible').configured,
    false,
  );
});

async function finished(runner) {
  for (let i = 0; i < 200 && runner.isRunning(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(runner.isRunning(), false, 'run should have finished');
}

test('onFinished fires after a clean targeted run and history records it', async () => {
  const repo = makeRepo();
  const config = makeConfig();
  config.inferenceHostLabel = 'M4 Mac mini · LM Studio';
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config,
  });
  let reopened = 0;
  runner.start({
    assetIds: ['a1', 'a2'],
    skipAnySuccessful: true,
    title: 'Test slice',
    reopenDecided: true,
    onFinished: () => { reopened += 1; },
  });
  config.inferenceHostLabel = 'A different host';
  await finished(runner);

  assert.equal(reopened, 1);
  assert.equal(repo.runs.length, 1);
  assert.equal(repo.runs[0].status, 'finished');
  assert.equal(repo.runs[0].targeted, 2);
  assert.equal(repo.runs[0].promptVersion, 'v1');
  assert.equal(repo.runs[0].inferenceHostLabel, 'M4 Mac mini · LM Studio');
  assert.equal(runner.status().options.reopenDecided, true);
  assert.ok(runner.status().log.some((line) => line.includes('back in the review queue')));
});

test('send-to-Curate lists enriched photos only, one by one as the run reaches them', async () => {
  // Both photos are already enriched: each joins the review list
  // individually when the run skips over it. Failed or never-attempted
  // photos are never listed (see the failed-run test below).
  const repo = makeRepo();
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config: makeConfig(),
  });
  runner.start({ assetIds: ['a1', 'a2'], skipAnySuccessful: true, title: 'Slice', queueItemId: 7 });
  assert.equal(runner.status().options.queueItemId, 7);
  await finished(runner);

  assert.equal(repo.reviewListCalls.length, 2);
  assert.deepEqual(repo.reviewListCalls.flatMap((call) => call.assetIds).sort(), ['a1', 'a2']);
  assert.ok(repo.reviewListCalls.every((call) => call.source === 'enrich'));
  const summary = runner.status().log.find((line) => line.includes('sent to Curate'));
  assert.ok(summary, 'run log should summarize what was listed');
  assert.ok(summary.includes('2 photo(s)'));
});

test('a photo that fails analysis is not listed for review', async () => {
  // Not enriched, and the provider at 127.0.0.1:9 is unreachable → the
  // photo fails. It must stay out of Curate and retry on a later run.
  const repo = makeRepo({ alreadyEnriched: false });
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config: makeConfig(),
  });
  runner.start({ assetIds: ['a1'], skipAnySuccessful: true, title: 'Failing slice' });
  await finished(runner);

  assert.equal(repo.reviewListCalls.length, 0);
});

test('send-to-Curate off keeps the run out of the review list', async () => {
  const repo = makeRepo();
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config: makeConfig(),
  });
  runner.start({ assetIds: ['a1'], skipAnySuccessful: true, sendToCurate: false });
  await finished(runner);

  assert.equal(repo.reviewListCalls.length, 0);
});

test('live job logs keep a bounded tail with an omission marker', async () => {
  const repo = makeRepo();
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config: makeConfig(),
  });
  runner.start({
    assetIds: Array.from({ length: 600 }, (_, index) => `asset-${index}`),
    skipAnySuccessful: true,
    sendToCurate: false,
    title: 'Large completed slice',
  });
  await finished(runner);

  const log = runner.status().log;
  assert.equal(log.length, 500);
  assert.equal(log[0], '… earlier log entries omitted');
  assert.ok(log.at(-1).includes('run complete'));
});

test('a failed run never touches the review list', async () => {
  const repo = makeRepo();
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async () => { throw new Error('immich down'); } },
    taxonomy,
    config: makeConfig(),
  });
  runner.start({ assetIds: ['a1'] });
  await finished(runner);

  assert.equal(repo.reviewListCalls.length, 0);
});

test('cancel aborts an in-flight provider request and leaves the photo retryable', { timeout: 5000 }, async () => {
  let markRequestStarted;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  const server = createServer((request) => {
    request.resume();
    request.once('end', markRequestStarted);
    // Deliberately never answer: cancellation must tear down the request
    // rather than wait for the provider timeout.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const repo = makeRepo({ alreadyEnriched: false });
  const config = makeConfig();
  config.providers.local_lmstudio.baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  config.providers.local_lmstudio.timeoutMs = 60000;
  const runner = new EnrichJobRunner({
    repo,
    immich: {
      getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }),
      getAssetThumbnail: async () => ({ data: Buffer.from('image'), contentType: 'image/jpeg' }),
    },
    taxonomy,
    config,
  });

  try {
    runner.start({ assetIds: ['a1'], sendToCurate: false });
    await requestStarted;
    assert.equal(runner.cancel(), true);
    await finished(runner);

    assert.equal(repo.processingRuns.length, 1);
    assert.equal(repo.processingRuns[0].status, 'failed_infra');
    assert.equal(repo.runs.length, 1);
    assert.equal(repo.runs[0].status, 'cancelled');
    assert.ok(runner.status().log.some((line) => line.includes('cancelled mid-request')));
    assert.equal(runner.status().error, null);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('cancel during an Immich download stops before provider work without a phantom failure', async () => {
  let markDownloadStarted;
  let finishDownload;
  const downloadStarted = new Promise((resolve) => { markDownloadStarted = resolve; });
  const repo = makeRepo({ alreadyEnriched: false });
  const runner = new EnrichJobRunner({
    repo,
    immich: {
      getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }),
      getAssetThumbnail: () => new Promise((resolve) => {
        finishDownload = () => resolve({ data: Buffer.from('image'), contentType: 'image/jpeg' });
        markDownloadStarted();
      }),
    },
    taxonomy,
    config: makeConfig(),
  });

  runner.start({ assetIds: ['a1'], sendToCurate: false });
  await downloadStarted;
  assert.equal(runner.cancel(), true);
  finishDownload();
  await finished(runner);

  assert.equal(repo.processingRuns.length, 0);
  assert.equal(repo.runs.length, 1);
  assert.equal(repo.runs[0].status, 'cancelled');
  assert.equal(repo.runs[0].counters.failed, 0);
  assert.ok(runner.status().log.some((line) => line.includes('after image download')));
  assert.equal(runner.status().log.some((line) => line.includes('cancelled mid-request')), false);
});

test('onFinished is skipped when the run fails', async () => {
  const repo = makeRepo();
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async () => { throw new Error('immich down'); } },
    taxonomy,
    config: makeConfig(),
  });
  let reopened = 0;
  runner.start({ assetIds: ['a1'], onFinished: () => { reopened += 1; } });
  await finished(runner);

  assert.equal(reopened, 0);
  assert.equal(repo.runs[0].status, 'failed');
  assert.ok(runner.status().log.some((line) => line.includes('the job stays queued')));
});

test('a prompt override marks the run as v1-custom', async () => {
  const config = makeConfig();
  config.promptOverrides.systemPrompt = 'Custom instructions.';
  const repo = makeRepo();
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config,
  });
  runner.start({ assetIds: ['a1'], skipAnySuccessful: true });
  await finished(runner);

  assert.equal(repo.runs[0].promptVersion, 'v1-custom');
});

test('recordInterrupted writes an interrupted run to history while running', async () => {
  const repo = makeRepo();
  // An immich whose getAsset never resolves keeps the run in flight.
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: () => new Promise(() => {}) },
    taxonomy,
    config: makeConfig(),
  });
  assert.equal(runner.recordInterrupted(), false); // idle: nothing to record
  runner.start({ assetIds: ['a1'], title: 'Interrupted slice' });
  assert.equal(runner.isRunning(), true);

  assert.equal(runner.recordInterrupted(), true);
  assert.equal(repo.runs.length, 1);
  assert.equal(repo.runs[0].status, 'interrupted');
  assert.equal(repo.runs[0].title, 'Interrupted slice');
  assert.ok(runner.status().log.some((line) => line.includes('run interrupted')));
  assert.equal(runner.recordInterrupted(), false, 'the terminal row is idempotent');
  assert.equal(repo.runs.length, 1);
});

test('needsWorkFilter resolves the run key start() would use and delegates to the repo in batch', () => {
  const repo = makeRepo();
  const delegated = [];
  const verdict = { needy: new Set(['a2']), successful: new Set(['a1']), failureLimited: new Set() };
  repo.assetIdsNeedingWork = (assetIds, options) => {
    delegated.push({ assetIds, options });
    return verdict;
  };
  const runner = new EnrichJobRunner({ repo, immich: {}, taxonomy, config: makeConfig() });

  const filter = runner.needsWorkFilter({ skipAnySuccessful: true });
  assert.equal(filter(['a1', 'a2']), verdict); // classification passes through intact
  assert.equal(delegated.length, 1);
  assert.deepEqual(delegated[0].assetIds, ['a1', 'a2']);
  assert.deepEqual(delegated[0].options, {
    runKey: {
      provider: 'local_lmstudio',
      model: 'test-model',
      promptVersion: 'v1',
      taxonomyVersion: taxonomy.version,
    },
    skipAnySuccessful: true,
    maxFailuresPerAsset: 2,
  });

  assert.throws(() => runner.needsWorkFilter({ provider: 'nope' }), /Unknown provider/);
});

test('recordCoveredResolution writes a zero-analysis history row with the resolved run key', () => {
  const repo = makeRepo();
  const config = makeConfig();
  config.inferenceHostLabel = 'Home GPU';
  const runner = new EnrichJobRunner({ repo, immich: {}, taxonomy, config });

  runner.recordCoveredResolution({ title: 'Paris', covered: 998, failureLimited: 2 });

  assert.equal(repo.runs.length, 1);
  const row = repo.runs[0];
  assert.equal(row.title, 'Paris');
  assert.equal(row.status, 'finished');
  assert.equal(row.provider, 'local_lmstudio'); // default provider resolved
  assert.equal(row.model, 'test-model');
  assert.equal(row.promptVersion, 'v1');
  assert.equal(row.taxonomyVersion, taxonomy.version);
  assert.equal(row.inferenceHostLabel, 'Home GPU');
  assert.equal(row.targeted, 0);
  assert.equal(row.counters.analyzed, 0);
  assert.equal(row.counters.skippedSuccessful, 998);
  assert.equal(row.counters.skippedFailureLimit, 2);
  assert.ok(row.startedAt && row.finishedAt);
  assert.match(row.log[0], /998 already enriched, 2 at the failure limit/);
});

test('retryFailureLimited runs a stuck photo with the failure cap off', async () => {
  // failureCount says the photo is far past the limit; without the retry
  // flag the run would skip it (see the companion test below). With the
  // flag, the cap is 0 for this run, so the photo is attempted — and fails
  // against the unreachable provider, proving the bypass reached runBatch
  // while the failure history keeps counting.
  const repo = makeRepo({ alreadyEnriched: false });
  repo.failureCount = () => 5;
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config: makeConfig(),
  });
  runner.start({ assetIds: ['a1'], retryFailureLimited: true, sendToCurate: false });
  assert.equal(runner.status().title, 'Retry failed photos');
  assert.equal(runner.status().options.retryFailureLimited, true);
  await finished(runner);

  assert.equal(repo.runs.length, 1);
  assert.equal(repo.runs[0].counters.analyzed, 1);
  assert.equal(repo.runs[0].counters.skippedFailureLimit, 0);
  assert.ok(runner.status().log.some((line) => line.includes('failure cap is off')));
});

test('the same stuck photo is skipped without the retry flag', async () => {
  const repo = makeRepo({ alreadyEnriched: false });
  repo.failureCount = () => 5;
  const runner = new EnrichJobRunner({
    repo,
    immich: { getAsset: async (id) => ({ id, originalPath: `${id}.jpg` }) },
    taxonomy,
    config: makeConfig(),
  });
  runner.start({ assetIds: ['a1'], sendToCurate: false });
  await finished(runner);

  assert.equal(repo.runs[0].counters.analyzed, 0);
  assert.equal(repo.runs[0].counters.skippedFailureLimit, 1);
});

test('retryFailureLimited without an asset list is refused', () => {
  const runner = new EnrichJobRunner({
    repo: makeRepo(),
    immich: {},
    taxonomy,
    config: makeConfig(),
  });
  assert.throws(() => runner.start({ retryFailureLimited: true }), /explicit asset list/);
  assert.equal(runner.isRunning(), false);
});
