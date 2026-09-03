import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createEnrichRoutes } from '../../src/routes/enrich.mjs';

function getRequest() {
  const request = Readable.from([]);
  request.method = 'GET';
  request.headers = {};
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

function makeHarness() {
  const calls = [];
  const handler = createEnrichRoutes({
    review: {},
    enrichRunner: { isRunning: () => false },
    taxonomy: {},
    repo: {
      jobRunsPage(options) {
        calls.push(options);
        const newest = options.beforeId === null;
        return {
          runs: newest
            ? Array.from({ length: options.limit }, (_, index) => ({ id: 50 - index }))
            : Array.from({ length: options.limit }, (_, index) => ({ id: options.beforeId - index - 1 })),
          nextBeforeId: newest ? 31 : 26,
          total: 50,
        };
      },
    },
    requireImmich: () => true,
    config: { enrichEnabled: true },
    immich: {},
    captionWriteback: {},
    referee: null,
  });
  return { handler, calls };
}

test('run history route returns bounded opaque cursor pages', async () => {
  const { handler, calls } = makeHarness();
  let response = fakeResponse();
  await handler(getRequest(), response, new URL('http://x/api/enrich/runs'));

  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.runs.length, 20);
  assert.equal(response.out.body.total, 50);
  assert.ok(response.out.body.nextCursor);
  assert.deepEqual(calls[0], { beforeId: null, limit: 20 });
  const firstCursor = response.out.body.nextCursor;

  response = fakeResponse();
  await handler(getRequest(), response, new URL(`http://x/api/enrich/runs?limit=5&cursor=${firstCursor}`));
  assert.equal(response.out.statusCode, 200);
  assert.deepEqual(response.out.body.runs.map((run) => run.id), [30, 29, 28, 27, 26]);
  assert.deepEqual(calls[1], { beforeId: 31, limit: 5 });
  assert.ok(response.out.body.nextCursor);
});

test('run history route rejects malformed cursors and out-of-range limits', async () => {
  const { handler, calls } = makeHarness();
  await assert.rejects(
    () => handler(getRequest(), fakeResponse(), new URL('http://x/api/enrich/runs?cursor=not-a-cursor')),
    (error) => error.code === 'invalid_run_cursor' && error.status === 400,
  );
  await assert.rejects(
    () => handler(getRequest(), fakeResponse(), new URL('http://x/api/enrich/runs?limit=51')),
    (error) => error.code === 'invalid_run_limit' && error.status === 400,
  );
  assert.deepEqual(calls, []);
});
