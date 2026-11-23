import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { createServer, request as httpRequest } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { AnthropicProvider, createProvider, enrichmentProviderConfiguration, ProviderRequestError } from '../../src/enrich/providers.mjs';
import { anthropicJsonSchema, validateAnthropicOutput } from '../../src/enrich/anthropicContract.mjs';
import { enrichmentJsonSchema } from '../../src/enrich/schema.mjs';
import { refereeJsonSchema } from '../../src/enrich/referee-contract.mjs';
import { createStackRefereeRequest, stackRefereeSupport } from '../../src/curate/stack-referee-contract.mjs';
import { refereeCapability } from '../../src/curate/referee-capabilities.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

const image = { data: Buffer.from('synthetic photo'), mimeType: 'image/webp' };
const schema = { type: 'object', additionalProperties: false, required: ['caption'],
  properties: { caption: { type: 'string', minLength: 1, maxLength: 20 } } };
const prompts = { systemPrompt: 'system', userPrompt: 'user', jsonSchema: schema };
const envelope = (output = { caption: 'Lake' }, stop_reason = 'end_turn') => ({ stop_reason,
  content: [{ type: 'thinking', thinking: 'never expose reasoning' }, { type: 'text', text: JSON.stringify(output) }] });
function fixture(body = envelope(), status = 200, headers = {}) {
  const calls = [];
  const provider = createProvider('cloud_anthropic', { apiKey: 'synthetic-credential', modelName: 'claude-haiku-5-5',
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify(body), { status, headers });
    } });
  return { provider, calls };
}

test('Claude Enrich sends Messages with projected structured outputs, native WebP and no sampling or tools', async () => {
  const { provider, calls } = fixture();
  assert.deepEqual((await provider.analyzeImage(image, prompts)).normalizedOutput, { caption: 'Lake' });
  const { url, headers, body, redirect } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(headers.Authorization, 'Bearer synthetic-credential');
  assert.equal(headers['anthropic-version'], '2026-10-21');
  assert.equal(redirect, 'error');
  assert.deepEqual(body, { model: 'claude-haiku-5-5', system: 'system', max_tokens: 8192,
    thinking: { type: 'disabled' }, output_config: { effort: 'low', format: { type: 'json_schema', schema: anthropicJsonSchema(schema) } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: image.data.toString('base64') } },
      { type: 'text', text: 'user' },
    ] }] });
  const identity = enrichmentProviderConfiguration(provider);
  assert.equal(identity.temperature, null);
  assert.equal(identity.apiVersion, '2026-10-21');
  assert.doesNotMatch(JSON.stringify(identity), /synthetic-credential/);
});

test('thinking is model-specific by exact ID; unfamiliar and date-suffixed IDs omit it', async () => {
  const cases = [ ['claude-haiku-5-5', { type: 'disabled' }], ['claude-sonnet-5-5', { type: 'between_tools' }],
    ['claude-opus-5-5', { type: 'adaptive', display: 'omitted' }], ['claude-fable-5-2', { type: 'adaptive', display: 'omitted' }],
    ['claude-opus-4-6', undefined], ['claude-sonnet-5-5-20261101', undefined], ['future-model', undefined] ];
  for (const [model, thinking] of cases) {
    const { provider, calls } = fixture(); provider.modelName = model;
    await provider.analyzeImage(image, prompts);
    assert.deepEqual(calls[0].body.thinking, thinking, model);
    assert.equal(calls[0].body.output_config.effort, 'low');
  }
});

test('Curate keepers and stack partitions send ordered multiple images and enforce their original schemas', async () => {
  const photos = [1, 2].map(photo => ({ photo, rank: photo, subject_group: 1, keep: photo === 1, eyes_closed: 'no', note: '' }));
  const { provider, calls } = fixture(envelope({ same_subject: true, photos }));
  await provider.analyzeImages([image, { ...image, data: Buffer.from('second') }], { ...prompts, jsonSchema: refereeJsonSchema(2) });
  assert.equal(calls[0].body.messages[0].content.length, 3);
  assert.equal(calls[0].body.messages[0].content[1].source.data, Buffer.from('second').toString('base64'));
  assert.equal(calls[0].body.output_config.format.schema.properties.photos.minItems, undefined);
  assert.throws(() => validateAnthropicOutput({ same_subject: true, photos: photos.slice(0, 1) }, refereeJsonSchema(2)));
  const stack = fixture(envelope({ groups: [{ ids: ['p1', 'p2'], reason: 'Same view.' }] }));
  const capability = refereeCapability(stack.provider);
  assert.equal(capability.maxImages, 10);
  assert.equal(stackRefereeSupport(stack.provider, capability, 11).state, 'unsupported-size');
  const request = createStackRefereeRequest({ provider: stack.provider, capability, inputKey: 'a'.repeat(64),
    images: ['asset-a', 'asset-b'].map(assetId => ({ ...image, assetId })) });
  assert.deepEqual(request.validate(await request.submit()).result.groups[0].ids, ['asset-a', 'asset-b']);
  assert.equal(stack.calls[0].body.output_config.format.schema.properties.groups.maxItems, undefined);
});

test('all shipped schemas project without mutation and retain local limits and exact enum spelling', async () => {
  const original = enrichmentJsonSchema(loadV1Taxonomy());
  const copy = structuredClone(original);
  const { provider, calls } = fixture(envelope(sampleOutput()));
  await provider.analyzeImage(image, { ...prompts, jsonSchema: original });
  assert.deepEqual(original, copy);
  const projected = calls[0].body.output_config.format.schema;
  assert.equal(projected.properties.quality.properties.aesthetic_score.maximum, undefined);
  assert.match(projected.properties.quality.properties.aesthetic_score.description, /maximum: 1/);
  for (const mutate of [out => out.quality.aesthetic_score = 2, out => out.people_count = 'NONE',
    out => out.caption = 'x'.repeat(10000), out => out.extra = 'not in schema', out => delete out.is_photo]) {
    const bad = sampleOutput(); mutate(bad);
    const f = fixture(envelope(bad));
    await assert.rejects(f.provider.analyzeImage(image, { ...prompts, jsonSchema: original }), { status: 200, invalidResponse: true, infrastructure: false });
  }
  await assert.rejects(provider.analyzeImage(image, { ...prompts, jsonSchema: { ...schema, anyOf: [] } }), { connectionReason: 'configuration' });
  assert.equal(calls.length, 1, 'unsupported schema is rejected before dispatch');
});

test('voice requests omit JSON schema, preserve their budgets and ignore thinking blocks', async () => {
  for (const [images, budget] of [[[image], 420], [[], 600]]) {
    const { provider, calls } = fixture({ stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: 'private' }, { type: 'text', text: 'A lake.' }, { type: 'text', text: 'In the hills.' }] });
    provider.modelName = 'claude-opus-5-5';
    assert.equal((await provider.generateProse({ ...prompts, images, maxOutputTokens: budget })).text, 'A lake.\nIn the hills.');
    assert.deepEqual(calls[0].body.output_config, { effort: 'low' });
    assert.equal(calls[0].body.max_tokens, budget);
    assert.equal(calls[0].body.messages[0].content.length, images.length + 1);
  }
});

test('refusals are bounded content failures; voice uses fixed refusal text; truncation never becomes an answer', async () => {
  const refusal = fixture(envelope({ caption: 'looks valid' }, 'refusal'));
  await assert.rejects(refusal.provider.analyzeImage(image, prompts), { status: 200, infrastructure: false, invalidResponse: false, message: 'Claude declined this request (refusal).' });
  assert.equal((await refusal.provider.generateProse({ ...prompts, maxOutputTokens: 600 })).text, 'I cannot answer that request.');
  for (const stop of ['max_tokens', 'model_context_window_exceeded', 'tool_use', 'pause_turn', undefined]) {
    const body = envelope(); body.stop_reason = stop;
    const { provider } = fixture(body);
    await assert.rejects(provider.analyzeImage(image, prompts), { status: 200, invalidResponse: true, infrastructure: false });
    await assert.rejects(provider.generateProse({ ...prompts, maxOutputTokens: 420 }), { invalidResponse: true });
  }
  for (const content of [[], [{ type: 'thinking', thinking: 'hidden' }], [{ type: 'text', text: '```json\n{}\n```' }]]) {
    await assert.rejects(fixture({ stop_reason: 'end_turn', content }).provider.analyzeImage(image, prompts), { invalidResponse: true });
  }
});

test('documented errors retain HTTP status, safe details and retry hints; spend caps and key scope pause configuration', async () => {
  for (const status of [400, 401, 402, 403, 404, 408, 409, 413, 429, 500, 504, 529]) {
    const { provider } = fixture({ error: { type: 'api_error', message: 'Synthetic service error' } }, status, { 'retry-after': '7' });
    await assert.rejects(provider.analyzeImage(image, prompts), error => {
      assert.ok(error instanceof ProviderRequestError); assert.equal(error.status, status);
      assert.equal(error.infrastructure, status !== 413); assert.equal(error.retryAfterMs, 7000);
      assert.equal(error.connectionReason, [400, 402, 404].includes(status) ? 'configuration' : [408, 409].includes(status) ? 'unavailable' : null);
      return true;
    });
  }
  for (const [status, error, pattern] of [
    [400, { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace. Set a workspace header.' }, /scoped to one workspace/],
    [429, { type: 'rate_limit_error', message: 'Spend limit', details: { error_code: 'enforced_spend_limit_reached' } }, /Spend limit/],
  ]) await assert.rejects(fixture({ error }, status).provider.analyzeImage(image, prompts), err => {
    assert.equal(err.connectionReason, 'configuration'); assert.match(err.message, pattern); return true;
  });
  await assert.rejects(fixture({ error: { type: 'rate_limit_error' } }, 429).provider.analyzeImage(image, prompts), { connectionReason: null });
  const { provider } = fixture({ error: { message: 'Authorization: Bearer synthetic-credential; echoed synthetic-credential' } }, 401);
  await assert.rejects(provider.analyzeImage(image, prompts), err => { assert.doesNotMatch(err.message, /synthetic-credential/); return true; });
  provider.fetchImpl = async () => { throw new Error('Transport echoed synthetic-credential'); };
  await assert.rejects(provider.analyzeImage(image, prompts), err => { assert.doesNotMatch(err.message, /synthetic-credential/); return true; });
});

test('400s pinned to an image block are content failures while other validation errors pause configuration', async () => {
  for (const message of ['messages.0.content.0.image.source: image dimensions exceed 8000 pixels',
    'messages.0.content.2.image: Could not decode image', 'messages.12.content.0.image.source.data: invalid base64']) {
    await assert.rejects(fixture({ error: { type: 'invalid_request_error', message } }, 400).provider.analyzeImage(image, prompts),
      { status: 400, infrastructure: false, connectionReason: null });
  }
  for (const message of ['output_config.format.schema: unsupported constraint', 'model: unavailable model',
    'You have reached your specified API usage limits.', 'Unrecognized request validation error']) {
    await assert.rejects(fixture({ error: { type: 'invalid_request_error', message } }, 400).provider.analyzeImage(image, prompts),
      { status: 400, infrastructure: true, connectionReason: 'configuration' });
  }
});

test('images accept the four documented media types, reject originals and encoded oversize before network', async () => {
  const { provider, calls } = fixture();
  for (const mimeType of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) await provider.analyzeImage({ ...image, mimeType }, prompts);
  await assert.rejects(provider.analyzeImage({ ...image, mimeType: 'image/heic' }, prompts), { status: 400, infrastructure: false });
  await assert.rejects(provider.analyzeImage({ ...image, data: Buffer.alloc(7_500_001) }, prompts), { status: 413, infrastructure: false });
  assert.equal(calls.length, 4);
});

test('shared fetch transport caps responses and honors cancellation without leaking credentials', async () => {
  const f = fixture({ excess: 'x'.repeat(2 * 1024 * 1024) });
  await assert.rejects(f.provider.analyzeImage(image, prompts), /limit/);
  const started = Promise.withResolvers(), controller = new AbortController();
  f.provider.fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('synthetic-credential')), { once: true }); started.resolve();
  });
  const pending = f.provider.analyzeImage(image, { ...prompts, signal: controller.signal });
  await started.promise; controller.abort();
  await assert.rejects(pending, { cancelled: true, message: 'cloud_anthropic request failed: cancelled' });
});

test('default Node transport applies Claude error classification, response cap and in-flight cancellation', async t => {
  // Redirect only this test process's HTTPS primitive to loopback. The adapter
  // still uses its fixed production URL and its real nodePostJson transport.
  let responseBody = JSON.stringify({ error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace.' } });
  let status = 400, hold = false, onRequest = () => {};
  const server = createServer((req, res) => {
    req.resume(); res.writeHead(status, { 'Content-Type': 'application/json' });
    if (hold) { res.write('{'); onRequest(); } else res.end(responseBody);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = https.request;
  https.request = (url, options, callback) => {
    assert.equal(url.href, 'https://api.anthropic.com/v1/messages');
    return httpRequest(`http://127.0.0.1:${server.address().port}/messages`, options, callback);
  };
  syncBuiltinESMExports();
  t.after(async () => { https.request = original; syncBuiltinESMExports(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const provider = new AnthropicProvider({ apiKey: 'synthetic-credential', modelName: 'claude-haiku-5-5' });
  await assert.rejects(provider.analyzeImage(image, prompts), { status: 400, connectionReason: 'configuration' });
  responseBody = JSON.stringify({ error: { type: 'invalid_request_error', message: 'messages.0.content.0.image.source: image dimensions exceed 8000 pixels' } });
  await assert.rejects(provider.analyzeImage(image, prompts), { status: 400, infrastructure: false, connectionReason: null });
  status = 200; responseBody = JSON.stringify({ excess: 'x'.repeat(2 * 1024 * 1024) });
  await assert.rejects(provider.analyzeImage(image, prompts), /limit/);
  hold = true; const started = Promise.withResolvers(); onRequest = started.resolve;
  const controller = new AbortController(), pending = provider.analyzeImage(image, { ...prompts, signal: controller.signal });
  await started.promise; controller.abort();
  await assert.rejects(pending, { cancelled: true });
});
