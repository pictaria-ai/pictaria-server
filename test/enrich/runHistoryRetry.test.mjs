import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createEnrichRoutes } from '../../src/routes/enrich.mjs';

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

function makeHarness({ failures, running = false, startError = null } = {}) {
  const state = { starts: [], requestedRunIds: [] };
  const handler = createEnrichRoutes({
    review: {},
    taxonomy: {},
    captionWriteback: {},
    referee: null,
    requireImmich: () => true,
    config: { enrichEnabled: true },
    immich: {},
    activityLog: null,
    repo: {
      jobRunRetryFailures(id) {
        state.requestedRunIds.push(id);
        return failures === undefined ? null : failures;
      },
    },
    enrichRunner: {
      isRunning: () => running,
      isBusy: () => running,
      start(options) {
        if (startError) throw startError;
        state.starts.push(options);
        return { running: true, options: { targeted: options.assetIds.length } };
      },
    },
  });
  return { handler, state };
}

test('history retry resolves targets server-side and starts a bounded failure-cap bypass', async () => {
  const failures = {
    runId: 17,
    title: 'Summer sweep',
    provider: 'openrouter',
    count: 2,
    assetIds: ['content-failure', 'infra-failure'],
    truncated: false,
  };
  const { handler, state } = makeHarness({ failures });
  const response = fakeResponse();
  await handler(
    jsonRequest({ assetIds: ['client-chosen-id'], provider: 'venice', sendToCurate: false }),
    response,
    new URL('http://x/api/enrich/runs/17/retry'),
  );

  assert.equal(response.out.statusCode, 202);
  assert.deepEqual(state.requestedRunIds, [17]);
  assert.deepEqual(state.starts, [{
    provider: 'openrouter',
    assetIds: ['content-failure', 'infra-failure'],
    skipAnySuccessful: true,
    retryFailureLimited: true,
    retrySourceRunId: 17,
    title: 'Retry failures · Summer sweep',
    sendToCurate: false,
  }]);
  assert.equal(response.out.body.retryableFailures, 2);
  assert.equal(response.out.body.retryTargeted, 2);
  assert.equal(response.out.body.retryTruncated, false);
});

test('history retry reports a stale card cleanly when every failure is now covered', async () => {
  const { handler, state } = makeHarness({
    failures: { runId: 17, title: 'Old run', provider: 'openrouter', count: 0, assetIds: [], truncated: false },
  });
  const response = fakeResponse();
  await handler(jsonRequest(), response, new URL('http://x/api/enrich/runs/17/retry'));

  assert.equal(response.out.statusCode, 200);
  assert.deepEqual(response.out.body, { started: false, retryableFailures: 0 });
  assert.deepEqual(state.starts, []);
});

test('history retry refuses a missing run and a competing active run', async () => {
  const missing = makeHarness();
  const missingResponse = fakeResponse();
  await missing.handler(jsonRequest(), missingResponse, new URL('http://x/api/enrich/runs/404/retry'));
  assert.equal(missingResponse.out.statusCode, 404);
  assert.equal(missingResponse.out.body.error.code, 'run_not_found');

  const busy = makeHarness({ running: true, failures: { count: 1, assetIds: ['a1'] } });
  const busyResponse = fakeResponse();
  await busy.handler(jsonRequest(), busyResponse, new URL('http://x/api/enrich/runs/17/retry'));
  assert.equal(busyResponse.out.statusCode, 409);
  assert.equal(busyResponse.out.body.error.code, 'enrich_run_conflict');
  assert.deepEqual(busy.state.requestedRunIds, []);
});
