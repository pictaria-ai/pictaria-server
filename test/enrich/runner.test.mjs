import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import { analyzeWithValidationRetry, buildUserPrompt, runBatch } from '../../src/enrich/runner.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();

function fakeImmich(assets) {
  return {
    async listImageAssets() {
      return assets;
    },
    async getAsset(assetId) {
      return { id: assetId };
    },
    async getAssetThumbnail(assetId) {
      return { data: Buffer.from(`bytes-${assetId}`), contentType: 'image/jpeg' };
    },
    async getAssetOriginal(assetId) {
      return { data: Buffer.from(`orig-${assetId}`), contentType: 'image/jpeg' };
    },
  };
}

function fakeProvider({ providerName = 'cloud_openai', results = null, failOnFirst = false } = {}) {
  const calls = [];
  return {
    providerName,
    modelName: 'test-model',
    calls,
    async analyzeImage(image, { userPrompt }) {
      calls.push({ assetId: image.assetId, userPrompt });
      if (failOnFirst && calls.length === 1) {
        return { rawOutput: {}, normalizedOutput: { invalid: true } };
      }
      const output = results?.[image.assetId] ?? sampleOutput();
      return { rawOutput: { id: `raw-${image.assetId}` }, normalizedOutput: output };
    },
  };
}

function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-runner-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  return Promise.resolve(work(repo)).finally(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

const baseOptions = {
  taxonomy,
  systemPrompt: 'system',
  userTemplate: 'Approved tags:\n{approved_tags}',
  promptVersion: 'v1',
};

test('buildUserPrompt embeds the approved model tags', () => {
  const prompt = buildUserPrompt('tags:\n{approved_tags}', taxonomy);

  assert.ok(prompt.includes('ai/quality/frame-worthy'));
  assert.ok(prompt.includes('frame/review'));
  assert.ok(!prompt.includes('frame/eligible'));
});

test('runBatch analyzes assets, records runs, and persists tag decisions', async () => {
  await withRepo(async (repo) => {
    const provider = fakeProvider();
    const { counters } = await runBatch({
      ...baseOptions,
      immich: fakeImmich([{ id: 'a1' }, { id: 'a2' }]),
      repo,
      provider,
      limit: 2,
    });

    assert.equal(counters.analyzed, 2);
    assert.equal(counters.succeeded, 2);
    assert.equal(counters.failed, 0);
    assert.equal(repo.hasAnySuccessfulRun('a1'), true);
    const tags = repo.loadAssetTagsFor(['a1'], { prefix: 'ai/' });
    assert.ok(tags.a1.includes('ai/quality/frame-worthy'));
  });
});

test('runBatch skips assets with matching successful runs', async () => {
  await withRepo(async (repo) => {
    const provider = fakeProvider();
    const immich = fakeImmich([{ id: 'a1' }]);
    await runBatch({ ...baseOptions, immich, repo, provider, limit: 1 });
    const { counters } = await runBatch({ ...baseOptions, immich, repo, provider, limit: 1 });

    assert.equal(counters.analyzed, 0);
    assert.equal(counters.skippedSuccessful, 1);
    assert.equal(provider.calls.length, 1);
  });
});

test('runBatch respects the per-asset failure circuit breaker', async () => {
  await withRepo(async (repo) => {
    const provider = {
      providerName: 'cloud_openai',
      modelName: 'test-model',
      async analyzeImage() {
        throw new Error('provider down');
      },
    };
    const immich = fakeImmich([{ id: 'a1' }]);
    await runBatch({ ...baseOptions, immich, repo, provider, limit: 1, maxFailuresPerAsset: 2 });
    await runBatch({ ...baseOptions, immich, repo, provider, limit: 1, maxFailuresPerAsset: 2 });
    const { counters } = await runBatch({ ...baseOptions, immich, repo, provider, limit: 1, maxFailuresPerAsset: 2 });

    assert.equal(counters.skippedFailureLimit, 1);
    assert.equal(counters.analyzed, 0);
  });
});

test('lm studio validation failures retry once with the stricter prompt', async () => {
  const provider = fakeProvider({ providerName: 'local_lmstudio', failOnFirst: true });
  const { normalized, retryCount } = await analyzeWithValidationRetry(
    provider,
    { data: Buffer.from('x'), mimeType: 'image/jpeg', assetId: 'a1' },
    {
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonSchema: {},
      taxonomy,
    },
  );

  assert.equal(retryCount, 1);
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[1].userPrompt.includes('Local retry instructions'));
  assert.ok(provider.calls[1].userPrompt.includes('do not prefix either value with "Full caption:" or "Short caption:"'));
  assert.equal(normalized.caption, sampleOutput().caption);
});

test('every local provider gets the stricter-prompt retry, not just lm studio', async () => {
  const provider = fakeProvider({ providerName: 'local_ollama', failOnFirst: true });
  const { retryCount } = await analyzeWithValidationRetry(
    provider,
    { data: Buffer.from('x'), mimeType: 'image/jpeg', assetId: 'a1' },
    { systemPrompt: 'system', userPrompt: 'user', jsonSchema: {}, taxonomy },
  );

  assert.equal(retryCount, 1);
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[1].userPrompt.includes('Local retry instructions'));
});

test('a generic compatible endpoint can opt into the local-model validation retry', async () => {
  const provider = fakeProvider({ providerName: 'openai_compatible', failOnFirst: true });
  provider.retryValidationOnce = true;
  const { retryCount } = await analyzeWithValidationRetry(
    provider,
    { data: Buffer.from('x'), mimeType: 'image/jpeg', assetId: 'a1' },
    { systemPrompt: 'system', userPrompt: 'user', jsonSchema: {}, taxonomy },
  );

  assert.equal(retryCount, 1);
  assert.equal(provider.calls.length, 2);
});

test('cloud validation failures do not retry', async () => {
  const provider = fakeProvider({ providerName: 'cloud_openai', failOnFirst: true });

  await assert.rejects(
    () => analyzeWithValidationRetry(
      provider,
      { data: Buffer.from('x'), mimeType: 'image/jpeg', assetId: 'a1' },
      { systemPrompt: 'system', userPrompt: 'user', jsonSchema: {}, taxonomy },
    ),
    /missing fields/,
  );
  assert.equal(provider.calls.length, 1);
});

test('maxAnalyzed stops the batch early', async () => {
  await withRepo(async (repo) => {
    const provider = fakeProvider();
    const { counters } = await runBatch({
      ...baseOptions,
      immich: fakeImmich([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]),
      repo,
      provider,
      limit: 3,
      maxAnalyzed: 2,
    });

    assert.equal(counters.analyzed, 2);
  });
});

test('maxAnalyzed keeps fetching windows until the budget is met', async () => {
  await withRepo(async (repo) => {
    const provider = fakeProvider();
    const library = ['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => ({ id }));
    const immich = {
      ...fakeImmich(library),
      async listImageAssets({ limit, offset }) {
        return library.slice(offset, offset + limit);
      },
    };

    // Enrich the first four so the opening windows are pure skips.
    await runBatch({ ...baseOptions, immich, repo, provider, assetIds: ['a1', 'a2', 'a3', 'a4'] });

    const { counters } = await runBatch({
      ...baseOptions,
      immich,
      repo,
      provider,
      limit: 2,
      maxAnalyzed: 1,
      skipAnySuccessful: true,
    });

    assert.equal(counters.analyzed, 1);
    assert.equal(counters.succeeded, 1);
    assert.equal(counters.skippedSuccessful, 4);
    assert.equal(repo.hasAnySuccessfulRun('a5'), true);
  });
});

test('maxAnalyzed charges raw window progress but analyzes duplicate asset IDs only once', async () => {
  await withRepo(async (repo) => {
    const provider = fakeProvider();
    const offsets = [];
    const immich = {
      ...fakeImmich([]),
      async listImageAssets({ offset }) {
        offsets.push(offset);
        return offset === 0
          ? [{ id: 'a1' }, { id: 'a1' }]
          : [{ id: 'a1' }, { id: 'a2' }];
      },
    };

    const { counters } = await runBatch({
      ...baseOptions,
      immich,
      repo,
      provider,
      limit: 2,
      maxAnalyzed: 2,
    });

    assert.deepEqual(offsets, [0, 2]);
    assert.deepEqual(provider.calls.map((call) => call.assetId), ['a1', 'a2']);
    assert.equal(counters.analyzed, 2);
  });
});

test('provider latency does not consume the Immich traversal deadline', async () => {
  await withRepo(async (repo) => {
    let clock = 0;
    const offsets = [];
    const immich = {
      ...fakeImmich([]),
      async listImageAssets({ offset }) {
        offsets.push(offset);
        return offset < 2 ? [{ id: `a${offset + 1}` }] : [];
      },
    };
    const provider = fakeProvider();
    const analyzeImage = provider.analyzeImage.bind(provider);
    provider.analyzeImage = async (...args) => {
      const result = await analyzeImage(...args);
      clock += 11 * 60 * 1000;
      return result;
    };

    const { counters } = await runBatch({
      ...baseOptions,
      immich,
      repo,
      provider,
      limit: 1,
      maxAnalyzed: 2,
      now: () => clock,
    });

    assert.equal(counters.analyzed, 2);
    assert.deepEqual(offsets, [0, 1]);
  });
});

test('slow Immich traversal time still trips the aggregate deadline', async () => {
  await withRepo(async (repo) => {
    let clock = 0;
    const immich = {
      ...fakeImmich([]),
      async listImageAssets() {
        clock += 10 * 60 * 1000;
        return [{ id: 'a1' }];
      },
    };

    await assert.rejects(
      () => runBatch({
        ...baseOptions,
        immich,
        repo,
        provider: fakeProvider(),
        limit: 1,
        now: () => clock,
      }),
      /traversal deadline/,
    );
  });
});

test('targeted runs deduplicate IDs before fetching or provider work', async () => {
  await withRepo(async (repo) => {
    const provider = fakeProvider();
    const fetched = [];
    const immich = {
      ...fakeImmich([]),
      async getAsset(assetId) {
        fetched.push(assetId);
        return { id: assetId };
      },
    };

    await runBatch({
      ...baseOptions,
      immich,
      repo,
      provider,
      assetIds: [' a1 ', 'a1', 'a2', 'a2'],
    });

    assert.deepEqual(fetched, ['a1', 'a2']);
    assert.deepEqual(provider.calls.map((call) => call.assetId), ['a1', 'a2']);
  });
});

test('without maxAnalyzed a single window is still the whole run', async () => {
  await withRepo(async (repo) => {
    const provider = fakeProvider();
    const library = ['a1', 'a2', 'a3', 'a4'].map((id) => ({ id }));
    const calls = [];
    const immich = {
      ...fakeImmich(library),
      async listImageAssets({ limit, offset }) {
        calls.push(offset);
        return library.slice(offset, offset + limit);
      },
    };

    const { counters } = await runBatch({ ...baseOptions, immich, repo, provider, limit: 2 });

    assert.equal(counters.analyzed, 2);
    assert.deepEqual(calls, [0]);
  });
});

test('listForReview adds each photo to the review list as it succeeds', async () => {
  await withRepo(async (repo) => {
    const lines = [];
    await runBatch({
      ...baseOptions,
      immich: fakeImmich([{ id: 'r1' }, { id: 'r2' }]),
      repo,
      provider: fakeProvider(),
      limit: 2,
      listForReview: true,
      log: (message) => lines.push(message),
    });
    assert.deepEqual(repo.reviewListRows().map((row) => row.asset_id).sort(), ['r1', 'r2']);
    assert.ok(lines.some((line) => line.includes('caption: A mountain lake under a bright sky.')));
  });
});

test('a run aborts fast when every photo fails from the start (provider down)', async () => {
  await withRepo(async (repo) => {
    const library = Array.from({ length: 30 }, (_, i) => ({ id: `dead-${i}` }));
    const deadProvider = {
      providerName: 'local_lmstudio',
      modelName: 'm',
      async analyzeImage() {
        throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:1234');
      },
    };
    await assert.rejects(
      runBatch({ ...baseOptions, immich: fakeImmich(library), repo, provider: deadProvider, limit: 30 }),
      /provider looks unreachable/,
    );
    // Only the fail-fast window burned a failure strike, not the whole slice.
    const failures = repo.db.prepare("SELECT COUNT(*) AS n FROM processing_runs WHERE status = 'failed'").get();
    assert.equal(Number(failures.n), 8);
  });
});

test('captionWriteback queues each captioned success for description sync', async () => {
  await withRepo(async (repo) => {
    await runBatch({
      ...baseOptions,
      immich: fakeImmich([{ id: 'r1' }, { id: 'r2' }]),
      repo,
      provider: fakeProvider(),
      limit: 2,
      captionWriteback: true,
    });
    assert.equal(repo.captionWritebackCounts().pending, 2);

    // Off by default: nothing queues without the option.
    await runBatch({
      ...baseOptions,
      immich: fakeImmich([{ id: 'r3' }]),
      repo,
      provider: fakeProvider(),
      limit: 1,
    });
    assert.equal(repo.captionWritebackCounts().pending, 2);
  });
});

test('without listForReview an enrichment run stays out of the review list', async () => {
  await withRepo(async (repo) => {
    await runBatch({
      ...baseOptions,
      immich: fakeImmich([{ id: 'r1' }]),
      repo,
      provider: fakeProvider(),
      limit: 1,
    });
    assert.equal(repo.reviewListRows().length, 0);
  });
});
