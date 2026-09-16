import test from 'node:test';
import assert from 'node:assert/strict';
import { CurateClient, decisionSummary } from '../../public/curate/client.js';

function storage() {
  const data = new Map();
  return { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v) };
}
const operation = {
  operationId: 'issued',
  expiresAt: 42,
  kind: 'decision',
  mode: 'manual',
  snapshot: { ids: ['a', 'b'] },
};

test('lost response survives reload and replays the exact keeper set without reissuing', async () => {
  const saved = storage(),
    bodies = [];
  const first = new CurateClient({
    storage: saved,
    api: async (path, body) => {
      if (path === 'operations') return operation;
      bodies.push(body);
      throw new TypeError('Connection lost after acceptance');
    },
  });
  await assert.rejects(first.decide('comparison', { a: 'approve', b: 'reviewed' }), /Connection lost/);
  assert.equal(Object.hasOwn(bodies[0], 'expiresAt'), false);
  await assert.rejects(first.decide('comparison', { a: 'reviewed', b: 'approve' }), /Resolve/);
  const reloaded = new CurateClient({
    storage: saved,
    api: async (path, body) => {
      assert.equal(path, 'operations/apply');
      bodies.push(body);
      return { operationId: 'issued', savedLocally: true };
    },
  });
  assert.equal((await reloaded.retry()).result.savedLocally, true);
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(reloaded.saved.pending, null);
});
test('deterministic conflicts clear the outbox; unavailable storage prevents a mutation', async () => {
  let writes = 0;
  const c = new CurateClient({
    storage: storage(),
    api: async (path) => {
      if (path === 'operations') return operation;
      writes++;
      throw Object.assign(Error('New human decision'), { status: 409 });
    },
  });
  await assert.rejects(c.decide('c', { a: 'approve', b: 'reviewed' }), /New human/);
  assert.equal(c.saved.pending, null);
  c.storage.setItem = () => {
    throw Error('Storage unavailable');
  };
  await assert.rejects(c.decide('c', { a: 'approve', b: 'reviewed' }), /Storage unavailable/);
  assert.equal(writes, 1);
});
test('view replacements serialize, and failure retains the last replacement token', async () => {
  let release,
    count = 0;
  const calls = [];
  const c = new CurateClient({
    storage: storage(),
    api: async (path, body) => {
      calls.push(body);
      count++;
      if (count === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      if (count === 3) throw Error('Capacity');
      return { viewId: `view${count}` };
    },
  });
  const a = c.open({ kind: 'all' }),
    b = c.open({ kind: 'singles' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  await Promise.all([a, b]);
  assert.equal(calls[1].replacesViewId, 'view1');
  await assert.rejects(c.open({ kind: 'stacks' }), /Capacity/);
  assert.equal(c.saved.viewId, 'view2');
});
test('comparison loads all pages and rejects missing or duplicate membership', async () => {
  const c = new CurateClient({
    storage: storage(),
    api: async (path) =>
      path === 'comparisons'
        ? { id: 'c', ids: ['a', 'b', 'c'], photos: [{ id: 'a' }], photoNextOffset: 1 }
        : { photos: [{ id: 'b' }, { id: 'c' }], nextOffset: null },
  });
  assert.deepEqual(
    (await c.comparison('v', 'g')).photos.map((p) => p.id),
    ['a', 'b', 'c'],
  );
  c.api = async () => ({ id: 'c', ids: ['a', 'b'], photos: [{ id: 'a' }, { id: 'a' }], photoNextOffset: null });
  await assert.rejects(c.comparison('v', 'g'), /complete comparison/);
});
test('a reset with a lost acknowledgment reconciles current correction state separately from receipt', async () => {
  const c = new CurateClient({
    storage: storage(),
    api: async (path) => {
      if (path === 'separations/reset') throw Object.assign(Error('Already reset'), { status: 409 });
      return { correction: { id: 's', active: 0, revision: 2 } };
    },
  });
  const result = await c.mutate('separations/reset', { id: 's', revision: 1 }, 'reset');
  assert.equal(result.result.active, 0);
  assert.equal(c.saved.pending, null);
});
test('oversized groups stay whole without eagerly fetching unbounded detail pages', async () => {
  let calls = 0;
  const ids = Array.from({ length: 1001 }, (_, i) => String(i));
  const c = new CurateClient({
    storage: storage(),
    api: async () => {
      calls++;
      return { id: 'large', ids, photos: ids.slice(0, 50).map((id) => ({ id })), photoNextOffset: 50 };
    },
  });
  const comparison = await c.comparison('v', 'g');
  assert.equal(comparison.oversized, true);
  assert.equal(comparison.ids.length, 1001);
  assert.equal(comparison.photos.length, 50);
  assert.equal(calls, 1);
});
test('action copy distinguishes reviewed remainder, multiple keepers and Never show', () => {
  assert.equal(decisionSummary({ a: 'approve', b: 'favorite', c: 'reviewed' }), 'Keep 2, mark 1 reviewed');
  assert.equal(decisionSummary({ a: 'reviewed', b: 'reviewed' }), 'Mark all 2 reviewed');
  assert.equal(decisionSummary({ a: 'approve', b: 'reject' }), 'Keep 1, never show 1');
  assert.equal(decisionSummary({ a: 'approve' }), 'Keep');
  assert.equal(decisionSummary({ a: 'reviewed' }), 'Mark reviewed');
  assert.equal(decisionSummary({ a: 'favorite' }), 'Keep as favorite');
  assert.equal(decisionSummary({ a: 'reject' }), 'Never show');
});
