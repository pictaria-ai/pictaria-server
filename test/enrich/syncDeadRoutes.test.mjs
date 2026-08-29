import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createEnrichRoutes } from '../../src/routes/enrich.mjs';

function jsonRequest(body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  return request;
}

function deleteRequest() {
  return { method: 'DELETE', headers: {} };
}

function fakeResponse() {
  const out = { statusCode: null, body: null };
  return {
    out,
    writeHead(statusCode) { out.statusCode = statusCode; },
    end(payload) { out.body = payload ? JSON.parse(payload) : null; },
  };
}

function harness() {
  const retried = [];
  const dismissed = [];
  const review = {
    retryDeadSyncJobs(id) { retried.push(id); return 1; },
    dismissDeadSyncJob(id) { dismissed.push(id); return true; },
    syncStatus() { return { pending: 0, dead: 0 }; },
  };
  return {
    retried,
    dismissed,
    handler: createEnrichRoutes({
      review,
      enrichRunner: {},
      taxonomy: {},
      repo: {},
      requireImmich: () => true,
      config: {},
      immich: {},
      captionWriteback: {},
      referee: null,
    }),
  };
}

test('dead-letter recovery accepts every signed SQLite row identity', async () => {
  const { handler, retried, dismissed } = harness();

  for (const id of ['0', '-1', '-9223372036854775808']) {
    const retryResponse = fakeResponse();
    assert.equal(await handler(
      jsonRequest({ id }),
      retryResponse,
      new URL('http://x/api/review/sync-dead/retry'),
    ), true);
    assert.equal(retryResponse.out.statusCode, 200);

    const deleteResponse = fakeResponse();
    assert.equal(await handler(
      deleteRequest(),
      deleteResponse,
      new URL(`http://x/api/review/sync-dead/${id}`),
    ), true);
    assert.equal(deleteResponse.out.statusCode, 200);
  }

  assert.deepEqual(retried, [0, -1, '-9223372036854775808']);
  assert.deepEqual(dismissed, [0, -1, '-9223372036854775808']);
});
