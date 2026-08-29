import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createFrameRoutes } from '../../src/routes/frame.mjs';

function jsonRequest(body) {
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

test('remote command activity contains only its validated command envelope', async () => {
  const events = [];
  const handler = createFrameRoutes({
    immich: {},
    frameHub: { publishCommand: () => 1 },
    frameLedger: {},
    requireImmich: () => true,
    activityLog: { frameCommand: (event) => events.push(event) },
  });
  const response = fakeResponse();

  await handler(
    jsonRequest({
      command: 'show-album',
      deviceId: 'kitchen',
      albumId: 'album-1',
      albumName: 'PRIVATE ALBUM NAME',
    }),
    response,
    new URL('http://x/api/frame/command'),
  );

  assert.equal(response.out.statusCode, 200);
  assert.deepEqual(events, [{ command: 'show-album', deviceId: 'kitchen', deliveredCount: 1 }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE ALBUM NAME|album-1/);
});
