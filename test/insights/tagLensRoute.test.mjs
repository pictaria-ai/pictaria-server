import test from 'node:test';
import assert from 'node:assert/strict';

import { createInsightsRoutes } from '../../src/routes/insights.mjs';
import { MAX_INSIGHTS_TAG_ID_LENGTH } from '../../src/insights/repository.mjs';

function fakeResponse() {
  const out = { statusCode: null, body: null };
  return {
    out,
    writeHead(statusCode) { out.statusCode = statusCode; },
    end(payload) { out.body = payload ? JSON.parse(payload) : null; },
  };
}

function makeHarness() {
  const state = { requireImmich: 0, searches: [], writes: [] };
  const repo = {
    hasKnownTag: (id) => id === 'known-tag',
    getMeta(key) {
      if (key === 'snapshot') {
        return { generatedAt: 'generation-1', years: [{ year: 2020 }, { year: 2021 }] };
      }
      return null;
    },
    setMeta: (key, value) => state.writes.push({ key, value }),
  };
  const handler = createInsightsRoutes({
    collector: {},
    repo,
    immich: {
      async searchStatistics(query) {
        state.searches.push(query);
        return { total: query.takenAfter.startsWith('2020') ? 2 : 3 };
      },
    },
    config: { insights: { statConcurrency: 2 } },
    settingsStore: {},
    requireImmich: () => { state.requireImmich += 1; return true; },
  });
  return { handler, state };
}

async function requestLens(handler, id) {
  const response = fakeResponse();
  const url = new URL('http://x/api/insights/lens');
  url.searchParams.set('type', 'tag');
  url.searchParams.set('id', id);
  await handler({ method: 'GET' }, response, url);
  return response.out;
}

test('tag lenses reject unknown IDs before upstream work or persistent cache access', async () => {
  const { handler, state } = makeHarness();

  const unknown = await requestLens(handler, 'unknown-tag');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.error.code, 'tag_not_found');

  const overlong = await requestLens(handler, 'x'.repeat(MAX_INSIGHTS_TAG_ID_LENGTH + 1));
  assert.equal(overlong.statusCode, 400);
  assert.equal(overlong.body.error.code, 'invalid_lens');

  assert.equal(state.requireImmich, 0);
  assert.deepEqual(state.searches, []);
  assert.deepEqual(state.writes, []);

  const known = await requestLens(handler, 'known-tag');
  assert.equal(known.statusCode, 200);
  assert.deepEqual(known.body.years, [{ year: 2020, count: 2 }, { year: 2021, count: 3 }]);
  assert.equal(state.requireImmich, 1);
  assert.equal(state.searches.length, 2);
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0].key, 'tagLens:known-tag');
});
