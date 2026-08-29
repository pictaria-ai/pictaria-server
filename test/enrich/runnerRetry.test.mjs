import test from 'node:test';
import assert from 'node:assert/strict';

import { runBatch } from '../../src/enrich/runner.mjs';
import { ImmichApiError } from '../../src/immich.mjs';
import { loadV1Taxonomy } from './helpers.mjs';

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
