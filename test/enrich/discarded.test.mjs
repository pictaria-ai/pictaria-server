import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { fileURLToPath } from 'node:url';

import { Repository } from '../../src/enrich/repository.mjs';
import { runBatch } from '../../src/enrich/runner.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { createEnrichRoutes } from '../../src/routes/enrich.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

// Discarding is a human decision that enrichment should stop trying a photo.
// It is local-only, global across run keys, and reversible. These tests cover
// the repository flag, stuck-set and run exclusions, and restore endpoints.

const taxonomy = loadV1Taxonomy();
const ROUTE_ID_1 = '00000000-0000-0000-0000-000000000001';
const ROUTE_ID_2 = '00000000-0000-0000-0000-000000000002';

function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-discard-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  return Promise.resolve(work(repo)).finally(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

const runKey = { provider: 'venice', model: 'm1', promptVersion: 'v2', taxonomyVersion: 'v1' };

function fail(repo, assetId, error = 'content failure') {
  repo.recordProcessingRun({ assetId, ...runKey, status: 'failed', error });
}

test('discard removes a photo from the stuck set; restore brings it back', () => {
  withRepo((repo) => {
    for (const id of ['stuck-a', 'stuck-b']) {
      repo.upsertAsset({ id, originalPath: `/photos/${id}.jpg`, fileCreatedAt: '2024-05-01T10:00:00Z' });
      fail(repo, id, 'Asset media not found');
      fail(repo, id, 'Asset media not found');
    }
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2 }).assetIds,
      ['stuck-a', 'stuck-b'],
    );

    assert.deepEqual(repo.discardAssets(['stuck-a']), { discarded: 1, skippedSuccessful: 0, skippedNotStuck: 0 });
    assert.equal(repo.isAssetDiscarded('stuck-a'), true);
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2 }).assetIds,
      ['stuck-b'],
    );

    // Discarding again is a no-op that keeps the original stamp.
    const stamp = repo.discardedAssets()[0].discardedAt;
    assert.deepEqual(repo.discardAssets(['stuck-a']), { discarded: 0, skippedSuccessful: 0, skippedNotStuck: 0 });
    assert.equal(repo.discardedAssets()[0].discardedAt, stamp);

    // Unlike missing_since, seeing the photo through Immich again does NOT
    // clear the flag — it's a human decision, not a liveness stamp.
    repo.upsertAsset({ id: 'stuck-a', originalPath: '/photos/stuck-a.jpg' });
    assert.equal(repo.isAssetDiscarded('stuck-a'), true);
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2 }).assetIds,
      ['stuck-b'],
    );

    // Restore is the one door back in.
    assert.equal(repo.restoreAssets(['stuck-a']), 1);
    assert.equal(repo.isAssetDiscarded('stuck-a'), false);
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2 }).assetIds.sort(),
      ['stuck-a', 'stuck-b'],
    );
    assert.equal(repo.restoreAssets(['stuck-a']), 0); // already restored
  });
});

test('a photo with a successful run is refused by discard — a stale snapshot cannot lock it out', () => {
  withRepo((repo) => {
    // The review's reproduced race: the popup snapshots a stuck id, the
    // photo enriches successfully in the meantime, the stale Discard lands.
    repo.upsertAsset({ id: 'raced' });
    fail(repo, 'raced');
    fail(repo, 'raced');
    repo.recordProcessingRun({ assetId: 'raced', ...runKey, status: 'succeeded', normalizedOutput: sampleOutput() });

    repo.upsertAsset({ id: 'still-stuck' });
    fail(repo, 'still-stuck');
    fail(repo, 'still-stuck');

    assert.deepEqual(
      repo.discardAssets(['raced', 'still-stuck']),
      { discarded: 1, skippedSuccessful: 1, skippedNotStuck: 0 },
    );
    assert.equal(repo.isAssetDiscarded('raced'), false);
    assert.equal(repo.isAssetDiscarded('still-stuck'), true);
  });
});

test('discard refuses photos that are not genuinely stuck: missing from Immich or without failure history', () => {
  withRepo((repo) => {
    // The review's second repro: stuck photo leaves the set via
    // missing_since, then the stale popup submits its id. Since the
    // discard stamp survives upsertAsset, stamping it here would block a
    // reappeared photo forever.
    repo.upsertAsset({ id: 'went-missing' });
    fail(repo, 'went-missing');
    fail(repo, 'went-missing');
    repo.markAssetsMissing(['went-missing']);

    // A fresh asset with no failure history at all is not discardable.
    repo.upsertAsset({ id: 'fresh' });

    assert.deepEqual(
      repo.discardAssets(['went-missing', 'fresh']),
      { discarded: 0, skippedSuccessful: 0, skippedNotStuck: 2 },
    );
    assert.equal(repo.isAssetDiscarded('went-missing'), false);
    assert.equal(repo.isAssetDiscarded('fresh'), false);

    // Once the photo reappears (upsertAsset clears missing_since), its
    // failure history makes it eligible again — a fresh, deliberate
    // discard now sticks.
    repo.upsertAsset({ id: 'went-missing' });
    assert.deepEqual(
      repo.discardAssets(['went-missing']),
      { discarded: 1, skippedSuccessful: 0, skippedNotStuck: 0 },
    );
  });
});

test('the discarded listing is capped with an honest total', () => {
  withRepo((repo) => {
    for (let i = 0; i < 7; i += 1) {
      repo.upsertAsset({ id: `bulk-${i}` });
      fail(repo, `bulk-${i}`); // eligibility guard wants failure history
    }
    repo.discardAssets(Array.from({ length: 7 }, (_, i) => `bulk-${i}`));
    assert.equal(repo.discardedCount(), 7);
    assert.equal(repo.discardedAssets().length, 7); // default cap is far higher
    assert.equal(repo.discardedAssets({ limit: 3 }).length, 3);
  });
});

test('discardedAssets lists newest first with the latest failure message', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'p1', originalPath: '/x/p1.jpg', fileCreatedAt: '2023-01-05T00:00:00Z' });
    repo.upsertAsset({ id: 'p2', originalPath: '/x/p2.jpg' });
    fail(repo, 'p1', 'first failure');
    fail(repo, 'p1', 'latest failure');
    // p2's newest failure is infra — surfaced as context even though only
    // content failures make it discard-eligible.
    fail(repo, 'p2', 'older content failure');
    repo.recordProcessingRun({ assetId: 'p2', ...runKey, status: 'failed_infra', error: 'provider unreachable' });

    repo.discardAssets(['p1']);
    repo.db.prepare("UPDATE assets SET enrich_discarded_at = '2030-01-01T00:00:00Z' WHERE asset_id = 'p1'").run();
    repo.discardAssets(['p2']);

    const rows = repo.discardedAssets();
    assert.deepEqual(rows.map((row) => row.assetId), ['p1', 'p2']);
    assert.equal(rows[0].originalPath, '/x/p1.jpg');
    assert.equal(rows[0].fileCreatedAt, '2023-01-05T00:00:00Z');
    assert.equal(rows[0].lastError, 'latest failure');
    assert.equal(rows[1].lastError, 'provider unreachable');
  });
});

test('assetFailureDetails returns rows in input order with the run-key failure message', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'a1', originalPath: '/x/a1.jpg', fileCreatedAt: '2024-02-02T00:00:00Z' });
    repo.upsertAsset({ id: 'a2' });
    fail(repo, 'a1', 'old message');
    fail(repo, 'a1', 'newest message');
    // A failure under a different model must not leak into this run key.
    repo.recordProcessingRun({ assetId: 'a2', ...runKey, model: 'other', status: 'failed', error: 'other-model failure' });

    const rows = repo.assetFailureDetails(['a2', 'a1'], { runKey });
    assert.deepEqual(rows.map((row) => row.assetId), ['a2', 'a1']);
    assert.equal(rows[0].lastError, null);
    assert.equal(rows[1].lastError, 'newest message');
    assert.equal(rows[1].originalPath, '/x/a1.jpg');
    assert.equal(rows[1].fileCreatedAt, '2024-02-02T00:00:00Z');
  });
});

test('assetIdsNeedingWork classifies discarded photos and drops them from needy', () => {
  withRepo((repo) => {
    for (const id of ['d1', 'd2', 'ok', 'done']) {
      repo.upsertAsset({ id });
    }
    repo.recordProcessingRun({ assetId: 'done', ...runKey, status: 'succeeded', normalizedOutput: sampleOutput() });
    // d2 is discarded AND at the failure limit — discarded classification
    // wins so the two counts never double-report one photo.
    fail(repo, 'd1');
    fail(repo, 'd2');
    fail(repo, 'd2');
    repo.discardAssets(['d1', 'd2']);

    const result = repo.assetIdsNeedingWork(['d1', 'd2', 'ok', 'done'], {
      runKey,
      skipAnySuccessful: true,
      maxFailuresPerAsset: 2,
    });
    assert.deepEqual([...result.needy], ['ok']);
    assert.deepEqual([...result.successful], ['done']);
    assert.deepEqual([...result.discarded].sort(), ['d1', 'd2']);
    assert.deepEqual([...result.failureLimited], []);

    // Successful wins over discarded, matching the runner's check order.
    repo.recordProcessingRun({ assetId: 'd1', ...runKey, status: 'succeeded', normalizedOutput: sampleOutput() });
    const after = repo.assetIdsNeedingWork(['d1'], { runKey, skipAnySuccessful: true, maxFailuresPerAsset: 2 });
    assert.deepEqual([...after.successful], ['d1']);
    assert.deepEqual([...after.discarded], []);
  });
});

test('a run skips discarded photos with its own counter', async () => {
  await withRepo(async (repo) => {
    repo.upsertAsset({ id: 'a1' });
    fail(repo, 'a1');
    repo.discardAssets(['a1']);
    const calls = [];
    const provider = {
      providerName: 'cloud_openai',
      modelName: 'test-model',
      async analyzeImage(image) {
        calls.push(image.assetId);
        return { rawOutput: {}, normalizedOutput: sampleOutput() };
      },
    };
    const { counters } = await runBatch({
      taxonomy,
      systemPrompt: 'system',
      userTemplate: 'Approved tags:\n{approved_tags}',
      promptVersion: 'v1',
      immich: {
        async listImageAssets() { return [{ id: 'a1' }, { id: 'a2' }]; },
        async getAsset(assetId) { return { id: assetId }; },
        async getAssetThumbnail(assetId) { return { data: Buffer.from(`bytes-${assetId}`), contentType: 'image/jpeg' }; },
      },
      repo,
      provider,
      limit: 2,
    });

    assert.equal(counters.skippedDiscarded, 1);
    assert.equal(counters.analyzed, 1);
    assert.deepEqual(calls, ['a2']); // the discarded photo never reached the provider
  });
});

// --- endpoint tests ---

function jsonRequest(method, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
  request.method = method;
  request.headers = { 'content-type': 'application/json' };
  return request;
}

function fakeResponse() {
  const out = { statusCode: null, body: null };
  return {
    out,
    writeHead(statusCode) { out.statusCode = statusCode; },
    end(payload) { out.body = payload ? JSON.parse(payload) : null; },
  };
}

function makeRoutesHarness() {
  const state = { activity: [], discardCalls: [], restoreCalls: [], discardAllCalls: [], discardedList: [{ assetId: 'gone', originalPath: '/x/gone.jpg' }] };
  const handler = createEnrichRoutes({
    review: {},
    taxonomy: {},
    captionWriteback: {},
    referee: null,
    requireImmich: () => true,
    config: { enrichEnabled: true, immichPublicUrl: 'http://immich.local:2283' },
    immich: {},
    activityLog: {
      assetsDiscarded: (event) => state.activity.push({ type: 'discard', ...event }),
      assetsRestored: (event) => state.activity.push({ type: 'restore', ...event }),
    },
    repo: {
      discardAssets: (ids) => { state.discardCalls.push(ids); return { discarded: ids.length, skippedSuccessful: 0, skippedNotStuck: 0 }; },
      restoreAssets: (ids) => { state.restoreCalls.push(ids); return ids.length; },
      discardedAssets: () => state.discardedList,
      discardedCount: () => state.discardedList.length,
    },
    enrichRunner: {
      isRunning: () => false,
      failureLimitedDetails: ({ provider } = {}) => ({
        provider: provider ?? 'venice',
        model: 'm1',
        count: 1,
        truncated: false,
        rows: [{ assetId: 'stuck-a', originalPath: '/x/a.jpg', lastError: 'Asset media not found' }],
      }),
      discardFailureLimited: ({ provider } = {}) => {
        state.discardAllCalls.push({ provider });
        // truncated: true here is the OPERATION's 10,000 cap — the response
        // must not let the reference listing's display cap overwrite it.
        return { provider: provider ?? 'venice', model: 'm1', count: 3, truncated: true, discarded: 2, skippedSuccessful: 1, skippedNotStuck: 0 };
      },
    },
  });
  return { handler, state };
}

test('failure-limited details carries rows, the discarded list, and the Immich link base', async () => {
  const { handler } = makeRoutesHarness();
  const response = fakeResponse();
  await handler(jsonRequest('GET'), response, new URL('http://x/api/enrich/failure-limited/details?provider=venice'));

  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.provider, 'venice');
  assert.equal(response.out.body.rows[0].lastError, 'Asset media not found');
  assert.deepEqual(response.out.body.discarded.assets.map((asset) => asset.assetId), ['gone']);
  assert.equal(response.out.body.discarded.total, 1);
  assert.equal(response.out.body.discarded.truncated, false);
  assert.equal(response.out.body.immichUrl, 'http://immich.local:2283');
});

test('all: true routes to the server-side discard of the current stuck set', async () => {
  const { handler, state } = makeRoutesHarness();
  const response = fakeResponse();
  await handler(jsonRequest('POST', { all: true, provider: 'venice' }), response, new URL('http://x/api/enrich/discarded'));

  assert.equal(response.out.statusCode, 200);
  assert.deepEqual(state.discardAllCalls, [{ provider: 'venice' }]);
  assert.deepEqual(state.discardCalls, []); // no client-supplied id path
  assert.equal(response.out.body.discarded, 2);
  assert.equal(response.out.body.skippedSuccessful, 1);
  assert.equal(response.out.body.count, 3);
  assert.equal(response.out.body.total, 1); // the listing rides along
  // The two truncations stay distinct: the operation hit its cap, the
  // one-row reference listing did not.
  assert.equal(response.out.body.discardTruncated, true);
  assert.equal(response.out.body.truncated, false);
  assert.deepEqual(state.activity, [{
    type: 'discard',
    count: 2,
    mode: 'all',
    skippedSuccessful: 1,
    skippedNotStuck: 0,
    truncated: true,
  }]);
});

test('discard and restore endpoints validate ids and report counts', async () => {
  const { handler, state } = makeRoutesHarness();

  let response = fakeResponse();
  await handler(jsonRequest('POST', { assetIds: [ROUTE_ID_1, ROUTE_ID_1, ROUTE_ID_2] }), response, new URL('http://x/api/enrich/discarded'));
  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.discarded, 2);
  assert.deepEqual(state.discardCalls, [[ROUTE_ID_1, ROUTE_ID_2]]);

  response = fakeResponse();
  await handler(jsonRequest('POST', { assetIds: [ROUTE_ID_1] }), response, new URL('http://x/api/enrich/discarded/restore'));
  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.restored, 1);
  assert.deepEqual(state.restoreCalls, [[ROUTE_ID_1]]);
  assert.deepEqual(state.activity, [
    {
      type: 'discard',
      count: 2,
      assetId: null,
      mode: 'selected',
      skippedSuccessful: 0,
      skippedNotStuck: 0,
    },
    { type: 'restore', count: 1, assetId: ROUTE_ID_1 },
  ]);

  response = fakeResponse();
  await handler(jsonRequest('POST', { assetIds: [ROUTE_ID_1, ' malformed '] }), response, new URL('http://x/api/enrich/discarded'));
  assert.equal(response.out.statusCode, 400);
  assert.equal(response.out.body.error.code, 'invalid_discard_request');
  assert.equal(state.discardCalls.length, 1, 'mixed invalid batches must be atomic');

  response = fakeResponse();
  await handler(jsonRequest('POST', { assetIds: Array(1001).fill(ROUTE_ID_1) }), response, new URL('http://x/api/enrich/discarded/restore'));
  assert.equal(response.out.statusCode, 400);
  assert.equal(response.out.body.error.code, 'invalid_restore_request');

  // Empty or missing ids are a 400, not a silent no-op.
  response = fakeResponse();
  await handler(jsonRequest('POST', { assetIds: [] }), response, new URL('http://x/api/enrich/discarded'));
  assert.equal(response.out.statusCode, 400);
  assert.equal(response.out.body.error.code, 'invalid_discard_request');

  response = fakeResponse();
  await handler(jsonRequest('POST', {}), response, new URL('http://x/api/enrich/discarded/restore'));
  assert.equal(response.out.statusCode, 400);
  assert.equal(response.out.body.error.code, 'invalid_restore_request');
});

test('the discarded reference list endpoint returns assets and the Immich link base', async () => {
  const { handler } = makeRoutesHarness();
  const response = fakeResponse();
  await handler(jsonRequest('GET'), response, new URL('http://x/api/enrich/discarded'));

  assert.equal(response.out.statusCode, 200);
  assert.deepEqual(response.out.body.assets.map((asset) => asset.assetId), ['gone']);
  assert.equal(response.out.body.total, 1);
  assert.equal(response.out.body.truncated, false);
  assert.equal(response.out.body.immichUrl, 'http://immich.local:2283');
});

test('discardFailureLimited resolves the stuck set itself and inherits the no-success guard', async () => {
  await withRepo((repo) => {
    const runner = new EnrichJobRunner({
      repo,
      immich: {},
      taxonomy,
      config: {
        promptsDir: fileURLToPath(new URL('../../prompts', import.meta.url)),
        promptVersion: 'v2',
        promptOverrides: { systemPrompt: '', userTemplate: '' },
        defaultProvider: 'venice',
        imageSource: 'preview',
        maxFailuresPerAsset: 2,
        providers: { venice: { modelName: 'm1', baseUrl: 'http://127.0.0.1:9', apiKey: 'k' } },
      },
    });
    // Two stuck under the active run key (venice/m1/v2/<taxonomy>), one
    // covered since — the covered one must survive Discard all untouched.
    const key = { provider: 'venice', model: 'm1', promptVersion: 'v2', taxonomyVersion: taxonomy.version };
    for (const id of ['da-1', 'da-2', 'da-covered']) {
      repo.upsertAsset({ id });
      repo.recordProcessingRun({ assetId: id, ...key, status: 'failed', error: 'x' });
      repo.recordProcessingRun({ assetId: id, ...key, status: 'failed', error: 'x' });
    }
    repo.recordProcessingRun({ assetId: 'da-covered', ...key, status: 'succeeded', normalizedOutput: sampleOutput() });

    const result = runner.discardFailureLimited({});
    assert.equal(result.provider, 'venice');
    assert.equal(result.count, 2);
    assert.equal(result.discarded, 2);
    assert.equal(result.skippedSuccessful, 0); // covered photo was never in the resolved set
    assert.equal(result.skippedNotStuck, 0);
    assert.equal(repo.isAssetDiscarded('da-1'), true);
    assert.equal(repo.isAssetDiscarded('da-2'), true);
    assert.equal(repo.isAssetDiscarded('da-covered'), false);
  });
});
