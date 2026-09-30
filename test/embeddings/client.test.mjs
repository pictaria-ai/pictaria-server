import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { ImmichMlClient, ML_LIMITS, parseVisualEmbedding } from '../../src/embeddings/client.mjs';
import { startFakeMl, vectorFor } from './fakeMl.mjs';

const image = { data: Buffer.from('synthetic-preview-bytes'), contentType: 'image/jpeg' };

async function withFake(work, options) {
  const ml = await startFakeMl(options);
  try { await work(ml, new ImmichMlClient({ baseUrl: ml.url })); } finally { await ml.close(); }
}

test('ping accepts only the Immich machine-learning pong', async () => {
  await withFake(async (ml, client) => {
    assert.equal(await client.ping(), true);
    ml.state.pong = 'hello';
    await assert.rejects(client.ping(), { code: 'ml_not_immich' });
  });
});

test('embedImage sends Immich’s multipart request and parses the JSON-string vector', async () => {
  await withFake(async (ml, client) => {
    const vector = await client.embedImage(image, { model: 'ViT-B-32__openai' });
    assert.ok(vector instanceof Float32Array);
    assert.equal(vector.length, 512);
    assert.deepEqual([...vector], [...Float32Array.from(vectorFor(image.data, 'ViT-B-32__openai'))]);
    const [request] = ml.state.requests;
    assert.deepEqual(request.entries, { clip: { visual: { modelName: 'ViT-B-32__openai' } } });
    assert.equal(request.bytes, image.data.length);
    assert.equal(request.contentType, 'image/jpeg');
    assert.ok(request.filename, 'the image part is a file upload, as FastAPI File() expects');
  });
});

test('a plain JSON array is also accepted; malformed vectors are rejected', () => {
  const values = Array.from({ length: 64 }, (_, i) => i / 64 - 0.5);
  assert.equal(parseVisualEmbedding(JSON.stringify({ clip: values })).length, 64);
  assert.equal(parseVisualEmbedding(JSON.stringify({ clip: JSON.stringify(values) })).length, 64);
  for (const body of [
    'not json',
    JSON.stringify({ clip: 'not json' }),
    JSON.stringify({ clip: values.slice(0, ML_LIMITS.minDims - 1) }),
    JSON.stringify({ clip: Array(ML_LIMITS.maxDims + 1).fill(0.1) }),
    JSON.stringify({ clip: values.map(() => 0) }),
    JSON.stringify({ clip: [...values.slice(1), 'x'] }),
    JSON.stringify({ clip: [...values.slice(1), 1e40] }),
    JSON.stringify({ facial_recognition: [] }),
    'null',
  ]) assert.throws(() => parseVisualEmbedding(body), { code: 'ml_invalid_response' }, body.slice(0, 40));
});

test('HTTP failures map to stable codes; only a rejected image is photo-specific', async () => {
  await withFake(async (ml, client) => {
    const expectations = [
      [400, 'ml_image_rejected', false],
      [422, 'ml_invalid_request', true],
      [500, 'ml_model_failed', true],
      [503, 'ml_unavailable', true],
      [418, 'ml_http_error', true],
    ];
    for (const [status, code, service] of expectations) {
      ml.state.status = status;
      await assert.rejects(client.embedImage(image, { model: 'ViT-B-32__openai' }), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.service, service);
        return true;
      });
    }
    ml.state.status = 500;
    ml.state.raw = '{"detail":"Failed to load model \'ViT-B-32__openai\'"}';
    await assert.rejects(client.embedImage(image, { model: 'ViT-B-32__openai' }), /Failed to load model/);
    ml.state.status = null; ml.state.raw = null;
    // An unknown model makes Immich raise an unhandled 500 with a plain-text body.
    await assert.rejects(client.embedImage(image, { model: 'Not-A-Model__x' }), { code: 'ml_model_failed' });
  });
});

test('the wrong service, an unreachable host, timeouts and cancellation are distinguished', async () => {
  await withFake(async (ml) => {
    const wrongPath = new ImmichMlClient({ baseUrl: `${ml.url}/somewhere-else` });
    await assert.rejects(wrongPath.embedImage(image, { model: 'ViT-B-32__openai' }), { code: 'ml_not_immich' });
    ml.state.delayMs = 300;
    const client = new ImmichMlClient({ baseUrl: ml.url });
    await assert.rejects(client.embedImage(image, { model: 'ViT-B-32__openai', timeoutMs: 50 }), { code: 'ml_timeout' });
    const controller = new AbortController();
    const pending = client.embedImage(image, { model: 'ViT-B-32__openai', signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: 'ml_cancelled', service: false });
  });
  const closed = new ImmichMlClient({ baseUrl: 'http://127.0.0.1:9' });
  await assert.rejects(closed.ping(), { code: 'ml_unreachable' });
  await assert.rejects(new ImmichMlClient({ baseUrl: '' }).ping(), { code: 'ml_not_configured' });
});

test('redirects are refused and oversized responses are not buffered', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/ping') response.writeHead(302, { location: 'http://example.invalid/ping' }).end();
    else response.writeHead(200, { 'content-type': 'application/json' }).end(`{"clip":"${'1,'.repeat(ML_LIMITS.responseBytes)}"}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new ImmichMlClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await assert.rejects(client.ping(), { code: 'ml_unreachable' });
    await assert.rejects(client.embedImage(image, { model: 'ViT-B-32__openai' }), { code: 'ml_invalid_response' });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('cancelling mid-upload never leaves an unhandled rejection (server would shut down)', async (t) => {
  const rejections = [];
  const record = (reason) => rejections.push(reason);
  process.on('unhandledRejection', record);
  t.after(() => process.removeListener('unhandledRejection', record));
  await withFake(async (ml, client) => {
    ml.state.delayMs = 150;
    const large = { data: Buffer.alloc(2 * 1024 * 1024, 7), contentType: 'image/jpeg' };
    for (let i = 0; i < 4; i++) {
      const controller = new AbortController();
      const pending = client.embedImage(large, { model: 'ViT-B-32__openai', signal: controller.signal });
      await Promise.resolve();
      controller.abort();
      await assert.rejects(pending, { code: 'ml_cancelled' });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  assert.deepEqual(rejections, []);
});
