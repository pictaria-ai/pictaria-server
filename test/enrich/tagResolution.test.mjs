import test from 'node:test';
import assert from 'node:assert/strict';
import { ImmichClient, ImmichApiError } from '../../src/immich.mjs';
import { ensureImmichTagIds, syncTagDecisions } from '../../src/enrich/runner.mjs';

// Full-path value and leaf name are shared by Immich 2.7.5 and 3.2's tag
// responses. This tests the production HTTP client with simulated responses,
// including incomplete successful upserts; it is not live-version acceptance.
const mountain = { id: 'mountain-id', value: 'ai/scene/mountains', name: 'mountains' };
const water = { id: 'water-id', value: 'ai/scene/water', name: 'water' };
const favorite = { id: 'favorite-id', value: 'frame/favorite', name: 'favorite' };

function transport(steps) {
  const calls = [];
  const immich = new ImmichClient({
    baseUrl: 'http://immich.test', apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      const call = { method: options.method, path: new URL(url).pathname,
        body: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      const step = steps[calls.length - 1];
      assert.ok(step, `Unexpected request: ${call.method} ${call.path}`);
      assert.equal(call.method, step.method);
      assert.equal(call.path, '/api/tags');
      if (step.request) assert.deepEqual(call.body, step.request);
      if (step.error) throw step.error;
      return Response.json(step.response, { status: step.status ?? 200 });
    },
  });
  return { immich, calls, assertComplete: () => assert.equal(calls.length, steps.length) };
}

test('existing hierarchical tags need only the initial read', async () => {
  const f = transport([{ method: 'GET', response: [mountain, water] }]);
  assert.deepEqual(await ensureImmichTagIds(f.immich, [mountain.value]), { [mountain.value]: mountain.id });
  f.assertComplete();
});

test('complete upserts resolve all requested tags without a refresh', async () => {
  const f = transport([
    { method: 'GET', response: [favorite] },
    { method: 'PUT', request: { tags: [mountain.value, water.value] }, response: [mountain, water] },
  ]);
  assert.deepEqual(await ensureImmichTagIds(f.immich, [favorite.value, mountain.value, water.value]), {
    [favorite.value]: favorite.id, [mountain.value]: mountain.id, [water.value]: water.id,
  });
  f.assertComplete();
});

for (const wrapped of [false, true]) {
  for (const partial of [false, true]) {
    test(`${partial ? 'partial' : 'empty'} upsert recovers from one ${wrapped ? 'wrapped' : 'array'} tag listing`, async () => {
      const response = tags => wrapped ? { tags } : tags;
      const f = transport([
        { method: 'GET', response: response([favorite]) },
        { method: 'PUT', request: { tags: [mountain.value, water.value] }, response: response(partial ? [mountain] : []) },
        // Deliberately omit already-resolved IDs: the refresh must merge them.
        { method: 'GET', response: response(partial ? [water] : [mountain, water]) },
      ]);
      assert.deepEqual(await ensureImmichTagIds(f.immich, [favorite.value, mountain.value, water.value]), {
        [favorite.value]: favorite.id, [mountain.value]: mountain.id, [water.value]: water.id,
      });
      f.assertComplete(); // No POST /tags, even when the successful upsert is empty.
    });
  }
}

test('unresolved IDs stop tag writes after one refresh instead of silently dropping tags', async () => {
  const f = transport([
    { method: 'GET', response: [] },
    { method: 'PUT', response: [mountain] },
    { method: 'GET', response: [mountain, { value: water.value }] },
  ]);
  await assert.rejects(syncTagDecisions(f.immich, {
    'photo-id': [{ tag: mountain.value }, { tag: water.value }],
  }), { message: `Unable to resolve Immich tag IDs for: ${JSON.stringify([water.value])}` });
  f.assertComplete();
});

for (const stage of ['initial read', 'upsert', 'refresh']) {
  for (const status of [401, 403, 500, null]) {
    test(`${stage} ${status ?? 'transport'} failure propagates without creation or refresh retries`, async () => {
      const steps = [];
      if (stage !== 'initial read') steps.push({ method: 'GET', response: [] });
      if (stage === 'refresh') steps.push({ method: 'PUT', response: [] });
      steps.push({ method: stage === 'upsert' ? 'PUT' : 'GET', status,
        response: { message: 'Unavailable' }, error: status === null ? new Error('connection lost') : undefined });
      const f = transport(steps);
      await assert.rejects(ensureImmichTagIds(f.immich, [mountain.value]), error => {
        assert.ok(error instanceof ImmichApiError);
        assert.equal(error.status, status);
        return true;
      });
      f.assertComplete();
    });
  }
}
