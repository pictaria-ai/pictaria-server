import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';

import { createVoiceRoutes } from '../../src/routes/voice.mjs';

// Route-level guard for both voice-deadline failure modes: the budget must
// bound the response, and an expired budget must not start new Immich work.

function jsonRequest(method = 'POST') {
  const request = Readable.from([Buffer.from('{}')]);
  request.method = method;
  return request;
}

function fakeResponse() {
  const out = { statusCode: null, body: null, at: null };
  return {
    out,
    writeHead(statusCode) { out.statusCode = statusCode; },
    end(payload) {
      out.body = payload ? JSON.parse(payload) : null;
      out.at = Date.now();
    },
  };
}

function makeHarness({ assetDelayMs = 0, thumbnailDelayMs = 0, proseTimeoutMs = 2000, metadataWriteback = false } = {}) {
  const calls = [];
  const activity = [];
  const immich = {
    async getAssetMetadataByKey() {
      calls.push('getAssetMetadataByKey');
      return null;
    },
    async upsertAssetMetadata() {
      calls.push('upsertAssetMetadata');
      return null;
    },
    async getAsset(id) {
      calls.push('getAsset');
      await new Promise((resolve) => setTimeout(resolve, assetDelayMs));
      return { id, originalPath: 'photo.jpg', exifInfo: {} };
    },
    async getAssetThumbnail(id) {
      calls.push('getAssetThumbnail');
      await new Promise((resolve) => setTimeout(resolve, thumbnailDelayMs));
      return { data: Buffer.from('img'), contentType: 'image/jpeg' };
    },
  };
  const handler = createVoiceRoutes({
    immich,
    requireImmich: () => true,
    activityLog: { voiceAnswer: (event) => activity.push(event) },
    config: {
      voice: {
        proseProvider: 'local_ollama',
        proseTimeoutMs,
        interestingMaxOutputTokens: 420,
        openAiInterestingImageDetail: 'high',
      },
      // Pointed at a port that discards: any provider call would hang, so
      // reaching one at all shows up as a blown deadline.
      providers: { local_ollama: { modelName: 'm', baseUrl: 'http://127.0.0.1:9' } },
      ambient: { immichMetadataWriteback: metadataWriteback, immichLocationMetadataKey: 'pictaria.locationEnrichment' },
      prompts: {},
    },
  });
  return { handler, calls, activity };
}

test('a stalled Immich returns the spoken fallback within the budget, and starts nothing after it', async () => {
  // Delays are sized so the abandoned chain WOULD reach the next stage
  // shortly after the response: asserting immediately would pass even when
  // later work still starts, which is exactly how this regressed before.
  const { handler, calls, activity } = makeHarness({ assetDelayMs: 300, proseTimeoutMs: 100 });
  const response = fakeResponse();
  const started = Date.now();

  await handler(jsonRequest(), response, new URL('http://x/api/assets/a1/interesting'));
  const elapsed = response.out.at - started;

  assert.equal(response.out.statusCode, 200, 'a timeout is spoken, not raised as an error');
  assert.equal(response.out.body.fallback, true);
  assert.match(response.out.body.speakText, /could not think of something in time/);
  // Bounded by the budget, not by Immich's own 60s ceiling.
  assert.ok(elapsed < 250, `answered in ${elapsed}ms, expected close to the 100ms budget`);
  assert.deepEqual(calls, ['getAsset'], 'no thumbnail fetch at response time');
  assert.deepEqual(activity, [{ kind: 'interesting', assetId: 'a1', outcome: 'fallback' }]);

  // Past the point where the abandoned getAsset resolves: the expired
  // budget must not let it start the next fetch. (The in-flight stage
  // itself cannot be cancelled — the Immich client takes no abort signal —
  // but no NEW work may begin.)
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(calls, ['getAsset'], 'the abandoned chain must not start new Immich work');
});

test('a stalled preview also falls back, without reaching a provider', async () => {
  const { handler, calls } = makeHarness({ thumbnailDelayMs: 5000, proseTimeoutMs: 2000 });
  const response = fakeResponse();
  const started = Date.now();

  await handler(jsonRequest(), response, new URL('http://x/api/assets/a1/interesting'));
  const elapsed = response.out.at - started;

  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.fallback, true);
  assert.ok(elapsed < 3500, `answered in ${elapsed}ms`);
  assert.deepEqual(calls, ['getAsset', 'getAssetThumbnail']);
  // No model was contacted: the provider points at a discard port, so a
  // provider call would have pushed this far past the budget.
  assert.equal(response.out.body.model, null);
  assert.equal(response.out.body.provider, null);
});

test('an expired budget starts no metadata read or writeback either', async () => {
  // The nested stages inside getEnrichedAsset reach outside the process —
  // Geoapify, and an Immich WRITE when writeback is on. Bounding only the
  // route-level stages left these running behind an answer nobody is
  // waiting for; the earlier harness could not see it because writeback
  // was off.
  const { handler, calls } = makeHarness({ assetDelayMs: 300, proseTimeoutMs: 100, metadataWriteback: true });
  const response = fakeResponse();

  await handler(jsonRequest(), response, new URL('http://x/api/assets/a1/interesting'));
  assert.equal(response.out.body.fallback, true);

  // Past the point where the abandoned getAsset resolves.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(
    calls,
    ['getAsset'],
    'no metadata read, no writeback, no thumbnail after the deadline',
  );
});

test('with budget to spare, the enrichment stages still run', async () => {
  // The deadline guard must not quietly disable writeback on the happy path.
  const { handler, calls } = makeHarness({ proseTimeoutMs: 30000, metadataWriteback: true });
  const response = fakeResponse();

  await handler(jsonRequest(), response, new URL('http://x/api/assets/a1/interesting'));

  assert.ok(calls.includes('getAssetMetadataByKey'), 'metadata is read when there is time');
  assert.ok(calls.includes('getAssetThumbnail'), 'the preview is fetched when there is time');
});
