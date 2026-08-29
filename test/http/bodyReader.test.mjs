import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

import { DEFAULT_JSON_BODY_TIMEOUT_MS, readJsonBody } from '../../src/http.mjs';

test('ordinary JSON readers install the secure default elapsed deadline', async () => {
  const request = new PassThrough();
  request.headers = { 'content-type': 'application/json' };
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let installedDelay = null;
  const fakeTimer = { unref() {} };

  globalThis.setTimeout = (_callback, delay) => {
    installedDelay = delay;
    return fakeTimer;
  };
  globalThis.clearTimeout = (timer) => assert.equal(timer, fakeTimer);
  try {
    const result = readJsonBody(request);
    request.end('{}');
    assert.deepEqual(await result, {});
    assert.equal(installedDelay, DEFAULT_JSON_BODY_TIMEOUT_MS);
    assert.equal(DEFAULT_JSON_BODY_TIMEOUT_MS, 30_000);
    assertNoBodyListeners(request);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('explicit invalid body deadlines fail loudly without installing listeners', async () => {
  for (const timeoutMs of [null, 0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const request = new PassThrough();
    request.headers = { 'content-type': 'application/json' };
    const result = readJsonBody(request, { timeoutMs });

    assert.ok(result instanceof Promise);
    request.end('{}');
    await assert.rejects(
      result,
      (error) => error instanceof TypeError && error.message === 'timeoutMs must be a finite positive number.',
    );
    assertNoBodyListeners(request);
  }
});

test('a completed bounded JSON body parses and clears its deadline', async () => {
  const request = Readable.from([Buffer.from('{"password":"ok"}')]);
  request.headers = { 'content-type': 'application/json' };

  assert.deepEqual(await readJsonBody(request, { maxBytes: 64, timeoutMs: 50 }), { password: 'ok' });
  assertNoBodyListeners(request);
});

test('an oversized body rejects and cleans every reader listener', async () => {
  const request = new PassThrough();
  request.headers = { 'content-type': 'application/json' };
  const result = readJsonBody(request, { maxBytes: 4, timeoutMs: 100 });

  request.write('12345');
  await assert.rejects(result, (error) => error.status === 413 && error.code === 'payload_too_large');
  assertNoBodyListeners(request);
});

test('an incomplete body times out and cleans every reader listener', async () => {
  const request = new PassThrough();
  request.headers = { 'content-type': 'application/json' };
  // readJsonBody deliberately unreferences its production timeout so an idle
  // partial socket cannot keep shutdown open. Keep this isolated test process
  // alive long enough to observe that deadline on platforms with no other
  // referenced handles.
  const keepAlive = setTimeout(() => {}, 100);

  try {
    await assert.rejects(
      readJsonBody(request, { maxBytes: 64, timeoutMs: 10 }),
      (error) => error.status === 408 && error.code === 'request_body_timeout',
    );
    assertNoBodyListeners(request);
  } finally {
    clearTimeout(keepAlive);
  }
});

function assertNoBodyListeners(request) {
  for (const eventName of ['data', 'end', 'error', 'aborted']) {
    assert.equal(request.listenerCount(eventName), 0, `${eventName} listener leaked`);
  }
}
