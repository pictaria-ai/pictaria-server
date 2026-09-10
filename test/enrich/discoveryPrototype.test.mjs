import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryPrototype } from '../../scripts/prototypes/enrich-discovery.mjs';
import { SyntheticSource, sandbox, history, finish, key, photo, library } from '../../scripts/prototypes/discovery-fixture.mjs';

const options = { runKey: key, limit: 50 };
test('prototype checkpoints a 150k inventory across reopen and publishes only a complete generation', async () => {
  const box = sandbox();
  try {
    const rows = library(150000, false), source = new SyntheticSource(rows);
    let index = new DiscoveryPrototype(box.repo); index.begin();
    assert.deepEqual(await index.step(source), { pages: 2, complete: false });
    assert.throws(() => index.candidates(options), /incomplete/);
    assert.equal(index.state().watermark, 0);
    index = box.reopen();
    assert.equal(index.state().scan.page, 3);
    await assert.rejects(index.step(source, { pageSize: 500 }), /same page size/);
    assert.equal(await finish(index, source), 74);
    assert.equal(source.calls.pages, 150);
    assert.equal(box.repo.db.prepare('SELECT COUNT(*) AS n FROM prototype_inventory').get().n, 150000);
    assert.equal(index.state().watermark, rows[0].updatedAt);
    box.repo.transaction(() => { for (const row of rows.slice(0, -50)) history(box.repo, row); });
    const selected = await index.select(source, options);
    assert.deepEqual(selected.selected.map(r => r.id), rows.slice(-50).map(r => r.id));
    assert.equal(selected.validated, 50);
  } finally { box.close(); }
});

test('SQL eligibility matches production rules before LIMIT, including changed inference, failure limits and discard', async () => {
  const box = sandbox();
  try {
    const rows = library(1100, false), index = new DiscoveryPrototype(box.repo);
    box.repo.transaction(() => {
      for (const [i, row] of rows.entries()) {
        if (i < 400) history(box.repo, row);
        else if (i < 800) { history(box.repo, row, { status: 'failed' }); history(box.repo, row, { status: 'failed' }); }
        else if (i < 1000) history(box.repo, row, { status: null, discarded: true });
        else if (i < 1050) history(box.repo, row, { status: 'failed_infra' });
      }
      history(box.repo, rows[1090], { runKey: { ...key, inferenceId: null } });
    });
    index.begin(); await finish(index, new SyntheticSource(rows));
    for (const runKey of [key, { ...key, inferenceId: 'b'.repeat(64) }, { ...key, inferenceId: null }]) {
      for (const onlyUnenriched of [true, false]) {
        for (const maxFailures of [0, 2]) {
          const expected = box.repo.assetIdsNeedingWork(rows.map(r => r.id), { runKey, skipAnySuccessful: onlyUnenriched, maxFailuresPerAsset: maxFailures }).needy;
          const actual = index.candidates({ runKey, onlyUnenriched, maxFailures, limit: 50 });
          assert.deepEqual(actual.map(r => r.asset_id), rows.filter(r => expected.has(r.id)).slice(0, 50).map(r => r.id));
        }
      }
    }
  } finally { box.close(); }
});

test('same fixtures produce the same eligible selections for Enrich and strengthened Insights inventories', async () => {
  const rows = library(10000);
  const outputs = [];
  for (const mode of ['enrich', 'insights-with-eligibility-columns']) {
    const box = sandbox();
    try {
      const index = box.index(mode), source = new SyntheticSource(rows, mode);
      box.repo.transaction(() => { for (const row of rows.slice(0, 9950)) history(box.repo, row); });
      index.begin(); await finish(index, source);
      outputs.push((await index.select(source, options)).selected.map(r => r.id));
      assert.equal(source.calls.gets, 50); // hidden/stack/video records never reach validation
    } finally { box.close(); }
  }
  assert.deepEqual(outputs[0], outputs[1]);
});

test('validation excludes deletion, hiding and stack changes without consuming the photo budget; restore/new upload refresh', async () => {
  const box = sandbox();
  try {
    const rows = library(12, false), source = new SyntheticSource(rows), index = new DiscoveryPrototype(box.repo);
    index.begin(); await finish(index, source);
    source.remove(rows[0].id); source.change(rows[1].id, { visibility: 'hidden', updatedAt: 100000 });
    source.change(rows[2].id, { stackChild: true, updatedAt: 100000 });
    const selected = await index.select(source, { ...options, limit: 4 });
    assert.deepEqual(selected.selected.map(r => r.id), rows.slice(3, 7).map(r => r.id));
    assert.equal(selected.validated, 7);
    const again = await index.select(source, { ...options, limit: 4 }); assert.equal(again.validated, 4);
    source.add(photo('old-upload', { takenAt: '1990-01-01T00:00:00.000Z', updatedAt: 110000 }));
    source.add({ ...rows[0], updatedAt: 110000 }); // restored asset re-enters the filtered source
    index.begin('delta'); await finish(index, source);
    const all = index.candidates(options).map(r => r.asset_id);
    assert.ok(all.includes('old-upload')); assert.ok(all.includes(rows[0].id));
    assert.ok(!all.includes(rows[1].id)); assert.ok(!all.includes(rows[2].id));
    const watermark = index.state().watermark;
    index.begin('delta'); await finish(index, source); assert.equal(index.state().watermark, watermark);
  } finally { box.close(); }
});

test('failed and malformed refresh pages preserve committed inventory, checkpoint, and watermark', async () => {
  const box = sandbox();
  try {
    const index = new DiscoveryPrototype(box.repo), source = new SyntheticSource(library(20, false));
    index.begin(); await finish(index, source);
    const committed = index.candidates(options), watermark = index.state().watermark;
    source.add(photo('new', { updatedAt: watermark + 5000 }));
    index.begin('full'); await index.step(source, { pageSize: 5, maxPages: 1 });
    const saved = index.state();
    await assert.rejects(index.step({ scan: async () => { throw Error('offline'); } }, { pageSize: 5 }), /offline/);
    assert.deepEqual(index.state(), saved); assert.deepEqual(index.candidates(options), committed);
    await assert.rejects(index.step({ scan: async () => ({ items: [], nextPage: 1 }) }, { pageSize: 5 }), /Invalid upstream/);
    assert.deepEqual(index.state(), saved);
    await finish(index, source, { pageSize: 5 });
    assert.equal(index.state().watermark, watermark + 5000);
    assert.ok(index.candidates(options).some(r => r.asset_id === 'new'));
  } finally { box.close(); }
});

test('periodic full reconciliation recovers access changes with no updatedAt change and null-date ordering is stable', async () => {
  const box = sandbox();
  try {
    const source = new SyntheticSource([photo('null-a', { takenAt: null }), photo('null-z', { takenAt: null }), photo('dated')]);
    const index = new DiscoveryPrototype(box.repo); index.begin(); await finish(index, source);
    assert.deepEqual(index.candidates(options).map(r => r.asset_id), ['dated', 'null-z', 'null-a']);
    source.remove('dated'); await index.select(source, options);
    source.add(photo('dated', { updatedAt: 10000 }));
    index.begin('delta'); await finish(index, source);
    assert.ok(!index.candidates(options).some(r => r.asset_id === 'dated')); // negative cache stays until reconciliation
    index.begin('full'); await finish(index, source);
    assert.equal(index.candidates(options)[0].asset_id, 'dated');
    const cursor = index.candidates({ ...options, limit: 2 }).at(-1);
    assert.deepEqual(index.candidates({ ...options, after: cursor }).map(r => r.asset_id), ['null-a']);
  } finally { box.close(); }
});

test('prototype exposes the large equal-timestamp overlap limitation rather than claiming a cheap warm refresh', async () => {
  const box = sandbox();
  try {
    const source = new SyntheticSource(library(10000, false).map(r => ({ ...r, updatedAt: 10000 })));
    const index = new DiscoveryPrototype(box.repo); index.begin(); await finish(index, source);
    const before = source.calls.pages;
    index.begin('delta'); await finish(index, source);
    assert.equal(source.calls.pages - before, 10);
    assert.equal(index.state().watermark, 10000);
  } finally { box.close(); }
});


test('prototype sweep sends only its newly successful work to Curate', async () => {
  const box = sandbox();
  try {
    const rows = [photo('already-enriched'), photo('new-success'), photo('new-failure')];
    history(box.repo, rows[0]);
    const index = new DiscoveryPrototype(box.repo); index.begin(); await finish(index, new SyntheticSource(rows));
    const called = [];
    const result = await index.run(new SyntheticSource(rows), options, { sendToCurate: true, process: async asset => {
      called.push(asset.id); const status = asset.id === 'new-success' ? 'succeeded' : 'failed';
      history(box.repo, asset, { status }); return status;
    } });
    assert.deepEqual(called.sort(), ['new-failure', 'new-success']);
    assert.equal(result.succeeded, 1); assert.equal(result.failed, 1); assert.equal(result.listed, 1);
    assert.deepEqual(box.repo.db.prepare('SELECT asset_id FROM review_list').all().map(r => r.asset_id), ['new-success']);
  } finally { box.close(); }
});


test('mutable offset pagination requires reconciliation even when a pass reaches the end', async () => {
  const box = sandbox();
  try {
    const rows = library(4, false), source = new SyntheticSource(rows), index = new DiscoveryPrototype(box.repo);
    index.begin(); await index.step(source, { pageSize: 2, maxPages: 1 });
    source.remove(rows[0].id); // page two shifts left; the next offset misses row 2
    await finish(index, source, { pageSize: 2 });
    assert.ok(!index.candidates(options).some(r => r.asset_id === rows[2].id));
    index.begin('full'); await finish(index, source, { pageSize: 2 });
    assert.ok(index.candidates(options).some(r => r.asset_id === rows[2].id));
    assert.ok(!index.candidates(options).some(r => r.asset_id === rows[0].id));
  } finally { box.close(); }
});
