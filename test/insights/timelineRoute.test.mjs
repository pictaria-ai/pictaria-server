import test from 'node:test';
import assert from 'node:assert/strict';

import { createInsightsRoutes } from '../../src/routes/insights.mjs';

function fakeResponse() {
  const out = { statusCode: null, body: null };
  return {
    out,
    writeHead(statusCode) { out.statusCode = statusCode; },
    end(payload) { out.body = payload ? JSON.parse(payload) : null; },
  };
}

test('weekly timeline ignores impossible legacy days instead of throwing', async () => {
  const repo = {
    getMeta() { return null; },
    timelineDays() {
      return [
        { day: '2026-02-31', count: 99, city: 'Invalid', country: null, lat: null, lon: null },
        { day: '2026-03-02', count: 2, city: 'Tokyo', country: 'Japan', lat: null, lon: null },
      ];
    },
    timelinePlaces() { return []; },
  };
  const handler = createInsightsRoutes({
    collector: {},
    repo,
    immich: {},
    config: { insights: { tripAwayKm: 100 } },
    settingsStore: {},
    requireImmich: () => true,
  });
  const response = fakeResponse();

  await handler({ method: 'GET' }, response, new URL('http://x/api/insights/timeline'));

  assert.equal(response.out.statusCode, 200);
  assert.deepEqual(response.out.body.weeks, [{
    week: '2026-03-02',
    count: 2,
    days: 1,
    awayDays: 0,
    city: 'Tokyo',
  }]);
});
