import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createVoiceRoutes } from '../../src/routes/voice.mjs';

function jsonRequest(body = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = 'POST';
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

function makeHarness({ immich = {} } = {}) {
  const events = [];
  const usage = [];
  const activityLog = {
    assetFavorited: (event) => events.push({ type: 'favorite', ...event }),
    assetHidden: (event) => events.push({ type: 'never-show', ...event }),
    voiceAnswer: (event) => events.push({ type: 'answer', ...event }),
    voiceCommand: (event) => events.push({ type: 'command', ...event }),
    voiceTts: (event) => events.push({ type: 'tts', ...event }),
  };
  const config = {
    voice: {
      askMaxOutputTokens: 600,
      openAiTtsModel: 'gpt-4o-mini-tts',
      proseTimeoutMs: 1,
      ttsProvider: 'openai',
    },
    providers: {},
    ambient: { immichMetadataWriteback: false },
    prompts: {},
  };
  return {
    events,
    handler: createVoiceRoutes({
      activityLog,
      config,
      immich,
      requireImmich: () => true,
      voiceMetrics: { record: (label, context) => usage.push({ label, ...context }) },
    }),
    usage,
  };
}

test('voice activity never receives transcripts, questions, or TTS text', async () => {
  const { events, handler, usage } = makeHarness();
  const secret = 'PRIVATE SPOKEN WORDS';

  let response = fakeResponse();
  await handler(
    jsonRequest({ label: secret, deviceId: 'kitchen', transcript: secret }),
    response,
    new URL('http://x/api/voice/command-used'),
  );
  assert.equal(response.out.statusCode, 200);

  response = fakeResponse();
  await handler(
    jsonRequest({ question: secret }),
    response,
    new URL('http://x/api/voice/ask'),
  );
  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.fallback, true);

  response = fakeResponse();
  await handler(
    jsonRequest({ text: secret }),
    response,
    new URL('http://x/api/voice/tts'),
  );
  assert.equal(response.out.statusCode, 503);

  assert.deepEqual(events, [
    { type: 'command', label: 'unrecognized', deviceId: 'kitchen' },
    { type: 'answer', kind: 'tell-me', provider: null, model: null, outcome: 'fallback' },
    { type: 'tts', provider: 'openai', model: 'gpt-4o-mini-tts', outcome: 'failed' },
  ]);
  assert.deepEqual(usage, [{ label: 'unrecognized', deviceId: 'kitchen' }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE SPOKEN WORDS/);
  assert.doesNotMatch(JSON.stringify(usage), /PRIVATE SPOKEN WORDS/);
});

test('favorite and never-show activity follows the final Immich mutation outcome', async () => {
  const immich = {
    async upsertTags(values) {
      return values.map((value) => ({ id: `id-${value}`, value }));
    },
    async tagAssetsBulk() {},
    async listTags() { return [{ id: 'eligible', value: 'frame/eligible' }]; },
    async untagAssets() {},
  };
  const { events, handler } = makeHarness({ immich });

  let response = fakeResponse();
  await handler(jsonRequest(), response, new URL('http://x/api/assets/asset-1/favorite'));
  assert.equal(response.out.statusCode, 200);

  response = fakeResponse();
  await handler(jsonRequest(), response, new URL('http://x/api/assets/asset-2/never-show'));
  assert.equal(response.out.statusCode, 200);

  assert.deepEqual(events, [
    { type: 'favorite', assetId: 'asset-1' },
    { type: 'never-show', assetId: 'asset-2' },
  ]);
});

test('failed Frame curation is recorded without exposing the provider error', async () => {
  const { events, handler } = makeHarness({
    immich: {
      async upsertTags() { throw new Error('PRIVATE PROVIDER ERROR'); },
    },
  });
  const response = fakeResponse();

  await assert.rejects(
    handler(jsonRequest(), response, new URL('http://x/api/assets/asset-1/favorite')),
    /PRIVATE PROVIDER ERROR/,
  );
  assert.deepEqual(events, [{ type: 'favorite', assetId: 'asset-1', outcome: 'failed' }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE PROVIDER ERROR/);
});
