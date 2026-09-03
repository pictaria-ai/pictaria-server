import test from 'node:test';
import assert from 'node:assert/strict';

import { runBatch } from '../../src/enrich/runner.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';
import { ImmichApiError } from '../../src/immich.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

// runBatch-level coverage for the retry-mode edges the jobRunner tests can't
// reach: the provider-down abort heuristic against known-hard photos, and
// targeted ids whose photos have since left Immich.

const taxonomy = loadV1Taxonomy();

function makeImmich({ missingIds = [] } = {}) {
  const missing = new Set(missingIds);
  return {
    getAsset: async (id) => {
      if (missing.has(id)) {
        throw new ImmichApiError('Asset not found', 404);
      }
      return { id, originalPath: `${id}.jpg` };
    },
    getAssetThumbnail: async () => ({ data: Buffer.from('img'), contentType: 'image/png' }),
  };
}

function makeRepo() {
  const processing = [];
  const missingMarked = [];
  return {
    processing,
    missingMarked,
    upsertAsset() {},
    hasAnySuccessfulRun: () => false,
    hasSuccessfulRun: () => false,
    failureCount: () => 0,
    isAssetDiscarded: () => false,
    recordProcessingRun(row) {
      processing.push(row);
    },
    transaction(work) {
      return work();
    },
    replaceAssetTags() {},
    reviewListAdd: () => 0,
    markAssetsMissing(assetIds) {
      missingMarked.push(...assetIds);
      return assetIds.length;
    },
  };
}

function contentFailingProvider() {
  return {
    providerName: 'venice',
    modelName: 'test-model',
    // A plain error is a content failure (isInfrastructureFailure false):
    // the provider answered, the answer was unusable.
    analyzeImage: async () => {
      throw new Error('schema rejected the response');
    },
  };
}

function infraFailingProvider() {
  return {
    providerName: 'venice',
    modelName: 'test-model',
    analyzeImage: async () => {
      const error = new Error('connect ECONNREFUSED');
      error.name = 'ProviderRequestError';
      error.infrastructure = true;
      throw error;
    },
  };
}

const IDS_9 = Array.from({ length: 9 }, (_, index) => `photo-${index + 1}`);

function batchOptions(overrides = {}) {
  return {
    immich: makeImmich(),
    repo: makeRepo(),
    provider: contentFailingProvider(),
    taxonomy,
    systemPrompt: 'system',
    userTemplate: 'tags: {approved_tags}',
    assetIds: IDS_9,
    maxFailuresPerAsset: 0,
    promptVersion: 'v2',
    ...overrides,
  };
}

test('a normal run of all-content-failures aborts on the provider-down heuristic', async () => {
  await assert.rejects(
    runBatch(batchOptions()),
    /unreachable or misconfigured/,
  );
});

test('retry mode attempts every known-hard photo instead of aborting on content failures', async () => {
  const repo = makeRepo();
  const { counters } = await runBatch(batchOptions({ repo, retryFailureLimited: true }));
  assert.equal(counters.analyzed, 9);
  assert.equal(counters.failed, 9);
  // Content failures keep counting toward each photo's history.
  assert.equal(repo.processing.filter((row) => row.status === 'failed').length, 9);
});

test('retry mode still aborts when the failures are infrastructure — the provider is down', async () => {
  await assert.rejects(
    runBatch(batchOptions({ provider: infraFailingProvider(), retryFailureLimited: true })),
    /unreachable or misconfigured/,
  );
});

test('infrastructure failures increment the folded failed counter used by run history', async () => {
  const repo = makeRepo();
  const { counters } = await runBatch(batchOptions({
    repo,
    provider: infraFailingProvider(),
    assetIds: IDS_9.slice(0, 2),
    retryFailureLimited: true,
  }));
  assert.equal(counters.failed, 2);
  assert.equal(repo.processing.filter((row) => row.status === 'failed_infra').length, 2);
});

test('429 overloads honor Retry-After and retry the same photo before succeeding', async () => {
  const repo = makeRepo();
  const log = [];
  const sleeps = [];
  let calls = 0;
  const provider = {
    providerName: 'venice',
    modelName: 'test-model',
    analyzeImage: async () => {
      calls += 1;
      if (calls < 3) {
        throw new ProviderRequestError('venice request failed with status 429', {
          status: 429,
          retryAfterMs: 2000,
        });
      }
      return { rawOutput: {}, normalizedOutput: sampleOutput() };
    },
  };

  const { counters } = await runBatch(batchOptions({
    repo,
    provider,
    assetIds: ['photo-1'],
    retrySleep: async (ms) => sleeps.push(ms),
    log: (message) => log.push(message),
  }));

  assert.equal(calls, 3);
  assert.equal(counters.succeeded, 1);
  assert.equal(counters.failed, 0);
  assert.equal(counters.retried, 2);
  assert.equal(sleeps.reduce((total, ms) => total + ms, 0), 4000);
  assert.equal(repo.processing.at(-1).status, 'succeeded');
  assert.ok(log.some((line) => line.includes('429 — retrying in 2s (1/2)')));
  assert.ok(log.some((line) => line.includes('429 — retrying in 2s (2/2)')));
});

test('503 overloads use growing fallback delays when Retry-After is absent', async () => {
  const sleeps = [];
  let calls = 0;
  const provider = {
    providerName: 'openrouter',
    modelName: 'test-model',
    analyzeImage: async () => {
      calls += 1;
      if (calls < 3) throw new ProviderRequestError('temporarily unavailable', { status: 503 });
      return { rawOutput: {}, normalizedOutput: sampleOutput() };
    },
  };

  const { counters } = await runBatch(batchOptions({
    provider,
    assetIds: ['photo-1'],
    retrySleep: async (ms) => sleeps.push(ms),
  }));

  assert.equal(counters.succeeded, 1);
  assert.equal(sleeps.reduce((total, ms) => total + ms, 0), 45000);
});

test('exhausted overload retries produce one infrastructure failure for the photo', async () => {
  const repo = makeRepo();
  let calls = 0;
  const provider = {
    providerName: 'venice',
    modelName: 'test-model',
    analyzeImage: async () => {
      calls += 1;
      throw new ProviderRequestError('still overloaded', { status: 429, retryAfterMs: 0 });
    },
  };

  const { counters } = await runBatch(batchOptions({
    repo,
    provider,
    assetIds: ['photo-1'],
    retrySleep: async () => {},
  }));

  assert.equal(calls, 3);
  assert.equal(counters.failed, 1);
  assert.deepEqual(repo.processing.map((row) => row.status), ['failed_infra']);
});

test('persistent overload stops multiplying capped waits across the provider-down probe', async () => {
  const repo = makeRepo();
  const log = [];
  const sleeps = [];
  let calls = 0;
  const provider = {
    providerName: 'venice',
    modelName: 'test-model',
    analyzeImage: async () => {
      calls += 1;
      throw new ProviderRequestError('quota remains exhausted', { status: 429, retryAfterMs: 300000 });
    },
  };

  await assert.rejects(
    runBatch(batchOptions({
      repo,
      provider,
      retrySleep: async (ms) => sleeps.push(ms),
      log: (message) => log.push(message),
    })),
    /unreachable or misconfigured/,
  );

  // Two photos receive the complete 3-call treatment; the remaining six
  // provider-down probes are single calls, so four capped waits total 20m.
  assert.equal(calls, 12);
  assert.equal(sleeps.reduce((total, ms) => total + ms, 0), 20 * 60000);
  assert.equal(repo.processing.filter((row) => row.status === 'failed_infra').length, 8);
  assert.ok(log.some((line) => line.includes('skipping further overload waits until a request succeeds')));
});

test('a successful provider response re-enables overload retries after suppression', async () => {
  const repo = makeRepo();
  const log = [];
  const sleeps = [];
  const callsByAsset = new Map();
  const provider = {
    providerName: 'venice',
    modelName: 'test-model',
    analyzeImage: async (image) => {
      const calls = (callsByAsset.get(image.assetId) ?? 0) + 1;
      callsByAsset.set(image.assetId, calls);
      if (['photo-1', 'photo-2', 'photo-3'].includes(image.assetId) || (image.assetId === 'photo-5' && calls < 3)) {
        throw new ProviderRequestError('temporary overload', { status: 429, retryAfterMs: 0 });
      }
      return { rawOutput: {}, normalizedOutput: sampleOutput() };
    },
  };

  const { counters } = await runBatch(batchOptions({
    repo,
    provider,
    assetIds: IDS_9.slice(0, 5),
    retrySleep: async (ms) => sleeps.push(ms),
    log: (message) => log.push(message),
  }));

  assert.deepEqual(Object.fromEntries(callsByAsset), {
    'photo-1': 3,
    'photo-2': 3,
    'photo-3': 1,
    'photo-4': 1,
    'photo-5': 3,
  });
  assert.equal(counters.succeeded, 2);
  assert.equal(counters.failed, 3);
  // Retry-After: 0 gets the polite one-second floor: four waits before
  // suppression and two after the successful photo resets the breaker.
  assert.equal(sleeps.reduce((total, ms) => total + ms, 0), 6000);
  assert.ok(log.some((line) => line.includes('overload retries re-enabled')));
});

test('other provider errors are not retried merely because they are infrastructure failures', async () => {
  const repo = makeRepo();
  let calls = 0;
  const provider = {
    providerName: 'openrouter',
    modelName: 'test-model',
    analyzeImage: async () => {
      calls += 1;
      throw new ProviderRequestError('internal provider failure', { status: 500, retryAfterMs: 1000 });
    },
  };

  const { counters } = await runBatch(batchOptions({
    repo,
    provider,
    assetIds: ['photo-1'],
    retrySleep: async () => { throw new Error('must not wait'); },
  }));

  assert.equal(calls, 1);
  assert.equal(counters.failed, 1);
  assert.deepEqual(repo.processing.map((row) => row.status), ['failed_infra']);
});

test('cancellation during an overload wait stops without recording a photo failure', async () => {
  const repo = makeRepo();
  const log = [];
  let cancelRequested = false;
  let calls = 0;
  const provider = {
    providerName: 'venice',
    modelName: 'test-model',
    analyzeImage: async () => {
      calls += 1;
      throw new ProviderRequestError('overloaded', { status: 429, retryAfterMs: 30000 });
    },
  };

  const { counters } = await runBatch(batchOptions({
    repo,
    provider,
    assetIds: ['photo-1'],
    shouldStop: () => cancelRequested,
    retrySleep: async () => { cancelRequested = true; },
    log: (message) => log.push(message),
  }));

  assert.equal(calls, 1);
  assert.equal(counters.failed, 0);
  assert.equal(repo.processing.length, 0);
  assert.ok(log.some((line) => line.includes('cancellation requested during provider retry wait')));
});

test('run persistence and logs redact reflected active integration secrets', async () => {
  const secret = 'runner:test/+ key';
  const repo = makeRepo();
  const log = [];
  const provider = {
    apiKey: secret,
    providerName: 'venice',
    modelName: 'test-model',
    analyzeImage: async () => {
      throw new Error(`upstream echoed ${secret} and ${encodeURIComponent(secret)}; Authorization: Bearer reflected-value`);
    },
  };

  await assert.rejects(
    runBatch(batchOptions({ repo, provider, log: (message) => log.push(message) })),
    (error) => {
      assert.doesNotMatch(error.message, /runner:test|runner%3Atest|reflected-value/i);
      return true;
    },
  );
  assert.equal(repo.processing.length, 8);
  for (const diagnostic of [...repo.processing.map((row) => row.error), ...log]) {
    assert.doesNotMatch(diagnostic, /runner:test|runner%3Atest|reflected-value/i);
    assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 512);
  }
});

test('a targeted id no longer in Immich is skipped, not fatal to the batch', async () => {
  const repo = makeRepo();
  const log = [];
  const { counters } = await runBatch(batchOptions({
    repo,
    immich: makeImmich({ missingIds: ['photo-gone'] }),
    assetIds: ['photo-gone', 'photo-here'],
    retryFailureLimited: true,
    log: (message) => log.push(message),
  }));
  // The missing photo never reaches analysis; the present one is attempted.
  assert.equal(counters.analyzed, 1);
  assert.equal(counters.failed, 1);
  assert.ok(log.some((line) => line.includes('skipped 1 no longer in Immich')));
  assert.ok(repo.processing.every((row) => row.assetId === 'photo-here'));
  // The confirmed-gone id is stamped so it leaves the stuck set for good.
  assert.deepEqual(repo.missingMarked, ['photo-gone']);
});
