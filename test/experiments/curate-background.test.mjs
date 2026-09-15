import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPhotos, groupPhotosInBackground, planRequest } from '../../experiments/curate-v13/grouping.mjs';
import { BackgroundGroups } from '../../experiments/curate-v13/background.mjs';
import { planKeeperBatches, collectKeeperBatches } from '../../experiments/curate-v13/batching.mjs';
import { fixtures, dataset } from '../../experiments/curate-v13/fixtures.mjs';
import { DecisionSpike } from '../../experiments/curate-v13/decisions.mjs';
import { freshLineage, supersede, reserve, finish } from '../../experiments/curate-v13/scheduling.mjs';

test('cooperative grouping preserves every fixture and metric across yield boundaries', async () => {
  for (const fixture of fixtures) {
    const options = { semanticVeto: true, lookbackDistance: 0.05 };
    const before = structuredClone(fixture.photos);
    let yields = 0;
    const actual = await groupPhotosInBackground(fixture.photos, options, { sliceMs: 0, yieldNow: async () => { yields++; } });
    assert.deepEqual(actual, groupPhotos(fixture.photos, options), fixture.name);
    assert.deepEqual(fixture.photos, before);
    assert.ok(yields >= fixture.photos.length);
  }
});

test('cooperative grouping cancels obsolete work and does not publish a partial index', async () => {
  const controller = new AbortController();
  let yields = 0;
  await assert.rejects(groupPhotosInBackground(dataset(1000), {}, {
    sliceMs: 0, signal: controller.signal, yieldNow: async () => { if (++yields === 2) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(yields, 2);
  await assert.rejects(groupPhotosInBackground([], {}, { sliceMs: -1 }));
});

test('background publication keeps old reads stable, coalesces loaders and discards canceled results', async () => {
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const builder = new BackgroundGroups({ build: async (rows, options, runtime) => {
    if (rows[0]?.id === 'obsolete') { started(); await hold; }
    return groupPhotosInBackground(rows, options, runtime);
  } });
  const rows = dataset(2);
  await builder.request(() => ({ rows, revision: 'old' }));
  const old = builder.current;
  const pending = builder.request(() => ({ rows: [{ ...rows[0], id: 'obsolete' }], revision: 'obsolete' }));
  await began;
  let skippedLoads = 0;
  const skipped = builder.request(() => { skippedLoads++; return { rows, revision: 'skipped' }; });
  const latest = builder.request(() => ({ rows: dataset(3), revision: 'latest' }));
  assert.equal(builder.current, old);
  assert.equal(builder.page().revision, 'old');
  assert.deepEqual(await skipped, { published: false, reason: 'superseded' });
  release();
  assert.equal((await pending).published, false);
  assert.equal((await latest).published, true);
  assert.equal(skippedLoads, 0);
  assert.equal(builder.current.revision, 'latest');
  assert.equal(old.revision, 'old');
  assert.equal(builder.page().groups[0].memberCount, 3);
  assert.equal(builder.page().groups[0].ids, undefined); // bounded list summary
  await assert.rejects(builder.request(() => { throw Error('snapshot unavailable'); }));
  assert.equal(builder.current.revision, 'latest');
  assert.throws(() => builder.page(0, 1000));
  builder.close();
  await assert.rejects(builder.request(() => ({ rows, revision: 'closed' })));
});

test('manual decision and unrelated metadata writes progress during grouping without changing inspected scope', async () => {
  const db = new DecisionSpike();
  try {
    const rows = dataset(60);
    db.seed(rows); const ids = rows.slice(0, 30).map(p => p.id); db.scope('view', ids);
    const snapshot = db.snapshot('view');
    let receipt;
    const result = await groupPhotosInBackground(rows, {}, { sliceMs: 0, yieldNow: async () => {
      if (receipt) return;
      // Representative Enrich metadata write outside the inspected decision tags.
      db.db.prepare('UPDATE photos SET tags=? WHERE id=?').run('["ai/scene/outdoors"]', ids[0]);
      receipt = db.apply({ requestId: 'human', snapshot,
        outcomes: Object.fromEntries(ids.map((id, i) => [id, i < 2 ? 'approve' : 'reviewed'])) });
    } });
    assert.equal(receipt.requestId, 'human');
    assert.deepEqual(result, groupPhotos(rows));
    assert.ok(JSON.parse(db.photo(ids[0]).tags).includes('ai/scene/outdoors'));
  } finally { db.close(); }
});

test('provider limits gate full checks; three keeper batches preserve every input and multiple keepers', () => {
  const rows = dataset(30), ids = rows.map(p => p.id);
  const group = groupPhotos(rows).groups[0], sizes = Object.fromEntries(ids.map(id => [id, 1000]));
  assert.equal(planRequest(group, sizes, { role: 'check', check: true, maxImages: 10 }).state, 'manual-provider');
  assert.equal(planRequest(group, sizes, { role: 'keeper', referee: true, maxImages: null }).state, 'unsupported-provider');
  const plan = planKeeperBatches(group, sizes, { orderedIds: ids, maxImages: 10, referee: true });
  assert.deepEqual(plan.requests.map(r => r.length), [10, 10, 10]);
  assert.deepEqual(plan.requests.flat(), ids);
  const answers = plan.requests.map(r => ({ status: 'valid', output: { groups: [{ ids: r, keepers: r.slice(0, 2), reason: 'Two useful alternatives.' }] } }));
  const result = collectKeeperBatches(plan, answers);
  assert.equal(result.state, 'complete');
  assert.equal(result.keeperIds.length, 6);
  assert.equal(result.wholeGroupCompared, false);
  assert.equal(result.coverage, 'within-batches');
  assert.equal(result.groups, undefined); // cannot masquerade as a global partition
  assert.equal(planKeeperBatches(group, sizes, { orderedIds: ids, maxImages: 10, referee: true, check: true }).state, 'waiting-for-check');
  assert.equal(planKeeperBatches(group, sizes, { orderedIds: ids, maxImages: 10, referee: false }).state, 'disabled');
  assert.throws(() => planKeeperBatches(group, sizes, { orderedIds: [...ids].fill(ids[0]), maxImages: 10 }));
});

test('batch failures never become a complete verdict or a zero-keeper judgment for missing members', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const plan = { state: 'ready', requests: [ids.slice(0, 2), ids.slice(2)], coverage: 'within-batches', groupId: 'g' };
  const valid = { status: 'valid', output: { groups: [{ ids: ['a', 'b'], keepers: [], reason: 'None recommended.' }] } };
  const failed = collectKeeperBatches(plan, [valid, { status: 'provider-error' }]);
  assert.equal(failed.state, 'partial');
  assert.equal(failed.batches[0].status, 'valid');
  assert.equal(failed.batches[1].status, 'unavailable');
  const wrongIds = collectKeeperBatches(plan, [valid, valid]);
  assert.equal(wrongIds.state, 'partial');
  assert.equal(wrongIds.batches[1].status, 'invalid-answer');
  assert.throws(() => collectKeeperBatches(plan, [valid]));
  const whole = collectKeeperBatches({ ...plan, requests: [['a', 'b']], coverage: 'whole-group' }, [valid]);
  assert.equal(whole.wholeGroupCompared, true);
  assert.equal(whole.state, 'complete');
});

test('batch layout avoids a singleton tail without dropping or reordering photos', () => {
  const rows = dataset(11), ids = rows.map(p => p.id), group = groupPhotos(rows).groups[0];
  const sizes = Object.fromEntries(ids.map(id => [id, 1000]));
  const plan = planKeeperBatches(group, sizes, { orderedIds: ids, maxImages: 10, referee: true });
  assert.deepEqual(plan.requests.map(r => r.length), [6, 5]);
  assert.deepEqual(plan.requests.flat(), ids);
  const small = { ...group, ids: ids.slice(0, 3), pendingIds: ids.slice(0, 3) };
  assert.equal(planKeeperBatches(small, sizes, { orderedIds: small.ids, maxImages: 2, referee: true }).state, 'manual-batch-layout');
});

test('three-batch plans reserve three automatic slots and cannot hide cost behind one job', () => {
  const state = freshLineage(), backend = {};
  supersede(state, 'first', 0);
  assert.equal(reserve(state, backend, 30000, { requestCount: 3 }), 'reserved');
  assert.equal(state.submissions.length, 3);
  finish(state, backend, 31000, { success: true });
  const restored = JSON.parse(JSON.stringify(state));
  supersede(restored, 'replacement', 40000);
  assert.equal(reserve(restored, backend, 70000), 'manual-recheck');
  assert.equal(restored.active, null);
  assert.equal(restored.attempts.replacement, undefined);
  assert.equal(reserve(restored, backend, 1900000, { requestCount: 3 }), 'reserved');
  assert.equal(restored.submissions.length, 3);
  assert.throws(() => reserve(freshLineage(), {}, 0, { requestCount: 0 }));
});
