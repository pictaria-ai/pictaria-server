import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateSimilaritySearch } from '../../src/curate/similarity.mjs';
import { ImmichApiError } from '../../src/immich.mjs';
import { REFINEMENT_LIMITS } from '../../src/curate/refinement.mjs';
import { observedRanks, searchItems } from './fixtures/rankContrast.mjs';

async function setup(t, { n = 3, respond, hashes = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'curate-candidate-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  const ids = Array.from({ length: n }, (_, i) => `p${i}`), calls = [];
  let now = Date.now();
  for (const [i, id] of ids.entries()) {
    repo.upsertAsset({ id, fileCreatedAt: new Date(1767225600000 + i * 1000).toISOString(),
      ...(hashes ? { thumbhash: Buffer.alloc(21, i * 90).toString('base64') } : {}) });
    repo.reviewListAdd([id], 'test');
  }
  const config = { curateBurstGrouping: true };
  const immich = { baseUrl: 'http://synthetic', apiKey: 'synthetic', async requestJson(path, args) {
    calls.push({ path, ...args });
    return respond ? respond(args, calls.length) : { assets: { items: ids.map(id => ({ id, type: 'IMAGE' })) } };
  } };
  const curate = new CurateService({ repo, config, immich, metadataOptions: { automatic: false },
    candidateOptions: { enabled: true, now: () => now } });
  curate.similarity = new CurateSimilaritySearch({ curate, now: () => now });
  curate.start = () => {}; // Explicit clock/ticks below; no wall-clock races.
  t.after(async () => { await curate.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); });
  await curate.refresh();
  return { repo, curate, config, immich, ids, calls, refine: curate.refinement, advance: ms => { now += ms; } };
}

function enrichCategories(repo, categories) {
  const schema = { properties: { has_people: { type: 'boolean' },
    people_count: { type: 'string', enum: ['none', 'one', 'couple', 'group', 'unknown'] } } };
  repo.saveRunConfiguration({ id: 'a'.repeat(64), inferenceId: 'b'.repeat(64),
    snapshot: { formatVersion: 1, inference: { contractVersion: 1, jsonSchema: schema } } });
  for (const [i, category] of categories.entries()) repo.recordProcessingRun({ assetId: `p${i}`,
    provider: 'test', model: 'test', promptVersion: 'v1', taxonomyVersion: 'v1', status: 'succeeded',
    configurationId: 'a'.repeat(64), normalizedOutput: { has_people: category !== 'none', people_count: category } });
}

test('strong people conflicts need no searches; filtered views do not restrict background work', async t => {
  const separated = await setup(t);
  enrichCategories(separated.repo, ['none', 'one', 'group']);
  const singles = await separated.curate.openView();
  assert.deepEqual(singles.groups.map(g => g.memberCount), [1,1,1]);
  assert.ok(singles.groups.every(g => g.similarity === null));
  await separated.refine.tick();
  assert.equal(separated.calls.length, 0);
  assert.equal(singles.refinement.pending, 0);

  const s = await setup(t, { n: 6, respond: () => ({ assets: { items:
    ['p3','p4','outside','p5','p0','p1','p2'].map(id => ({ id, type: 'IMAGE' })) } }) });
  const categories = ['one','one','one','couple','couple','one'];
  enrichCategories(s.repo, categories);
  for (const [i, id] of s.ids.entries()) s.repo.upsertAsset({ id,
    fileCreatedAt: new Date(1767225600000 + i * 1000).toISOString(),
    originalPath: `/${categories[i]}-${id}.jpg`, thumbhash: Buffer.alloc(21, i === 5 ? 200 : 0).toString('base64') });
  const couple = await s.curate.openView({ search: 'couple' });
  assert.deepEqual(couple.groups.map(g => g.memberCount), [2]);
  assert.equal(couple.groups[0].similarity, null);
  assert.equal(couple.refinement.pending, 4);
  await s.refine.tick(); assert.equal(s.calls.length, 1);
  s.advance(5000);

  const all = await s.curate.openView();
  assert.equal(all.refinement.pending, 3);
  assert.equal(all.groups.find(g => g.memberCount === 2).similarity, null);
  for (let i = 0; i < 4; i++) { await s.refine.tick(); s.advance(5000); }
  assert.deepEqual(s.calls.map(c => c.body.queryAssetId), ['p0','p1','p2','p5']);
  const entry = Object.values(s.refine.snapshot())[0];
  assert.equal(entry.rows.p0.p5, 1, 'unqueried couple remains inside the original time cohort');
  assert.equal(s.refine.entries.size, 0);
  const refreshed = await s.curate.openView();
  assert.deepEqual(refreshed.groups.map(g => g.memberCount), [4,2]);
  assert.equal(refreshed.refinement.pending, 0);
  assert.equal(s.curate.page(couple.viewId).updatesAvailable, false);
});

test('unconfigured similarity search keeps distant hashes provisionally together', async t => {
  const s = await setup(t, { hashes: true });
  s.immich.apiKey = ''; s.curate.settingsChanged();
  const view = await s.curate.openView(); await s.refine.tick();
  assert.equal(s.calls.length, 0);
  assert.equal(view.groups.length, 1);
  assert.equal(view.groups[0].memberCount, 3);
  assert.equal(view.groups[0].route, 'candidate-unconfirmed');
});

test('completed rank contrast separates hash-matched compositions, preserving the original view and bounded evidence', async t => {
  // Only the first eight rows are observed. This ninth row is a synthetic
  // completion with close couple peers; no private photo metadata is used.
  const matrix = [...observedRanks.slice(0, 8), [null,null,null,null,null,null,1,2,null]];
  const ids = Array.from({ length: 9 }, (_, i) => `p${i}`);
  const s = await setup(t, { n: 9, respond: args => ({ assets: {
    items: searchItems(matrix[Number(args.body.queryAssetId.slice(1))], ids),
  } }) });
  enrichCategories(s.repo, ['group','group','group','one','one','one','couple','couple','couple']);
  for (const id of ids) s.repo.updateAssetVisuals(id, { thumbhash: Buffer.alloc(21, 0).toString('base64') });
  const view = await s.curate.openView();
  assert.deepEqual(view.groups.map(g => g.memberCount), [6,3]);
  assert.equal(view.refinement.pending, 6);
  const comparison = s.curate.comparison(view.viewId, view.groups[0].id);
  for (let i = 0; i < 5; i++) {
    await s.refine.tick(); s.advance(5000);
    assert.deepEqual(s.refine.snapshot(), {});
    assert.equal(s.curate.page(view.viewId).updatesAvailable, false);
  }
  await s.refine.tick();
  assert.deepEqual(s.calls.map(c => c.body.queryAssetId), ['p0','p1','p2','p6','p7','p8']);
  assert.ok(s.calls.every(c => c.body.size === 51));
  const evidence = Object.values(s.refine.snapshot())[0];
  assert.deepEqual(evidence.coverage.p0, { returned: 50, limit: 50, outside: 44 });
  assert.equal(evidence.rows.p0.p6, 22, 'original nine-member scope defines outside ranks');
  assert.doesNotMatch(JSON.stringify(evidence), /outside-|originalPath|apiKey/);
  const old = s.curate.page(view.viewId);
  assert.deepEqual(old.groups.map(g => g.memberCount), [6,3]);
  assert.equal(old.refinement.ready, 1);
  assert.equal(s.curate.comparison(view.viewId, view.groups[0].id).ids.length, 6);
  assert.equal(comparison.ids.length, 6);
  const refreshed = await s.curate.openView({ replacesViewId: view.viewId });
  assert.deepEqual(refreshed.groups.map(g => g.memberCount), [3,3,3]);
  assert.match(s.curate.comparison(refreshed.viewId, refreshed.groups[0].id).reasons.join(' '), /contrast outweighs/);
  s.advance(5000); await s.refine.tick(); assert.equal(s.calls.length, 6);
});

test('background work starts without a view and preserves paced requests and open comparisons', async t => {
  const { curate, refine, calls, advance } = await setup(t);
  await curate.backgroundTick(); assert.equal(calls.length, 1);
  const view = await curate.openView();
  await refine.tick(); assert.equal(calls.length, 1);
  await refine.tick(); assert.equal(calls.length, 1);
  advance(5000); await refine.tick(); assert.equal(calls.length, 2);
  advance(5000); await refine.tick(); assert.equal(calls.length, 3);
  await curate.refresh();
  const stable = curate.page(view.viewId);
  const memberships = groups => groups.map(({ similarity, ...rest }) => rest);
  assert.deepEqual(memberships(stable.groups), memberships(view.groups));
  assert.equal(stable.groups[0].similarity.state, 'updated');
  assert.equal(stable.updatesAvailable, true);
  assert.equal(curate.comparison(view.viewId, view.groups[0].id).ids.length, 3);
  const updated = await curate.openView({ replacesViewId: view.viewId });
  assert.equal(updated.groups[0].route, 'candidate-supported');
  advance(5000); await refine.tick(); assert.equal(calls.length, 3, 'reopening does not refetch');
  const evidence = JSON.stringify(refine.snapshot());
  assert.doesNotMatch(evidence, /synthetic|apiKey|http/);
  assert.equal(curate.repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
});

test('open comparisons take the next turn, then visible groups, without interrupting in-flight work', async t => {
  let release;
  const s = await setup(t, { n: 2, respond: (args, n) => n === 1
    ? new Promise(resolve => { release = resolve; }) : { assets: { items: [] } } });
  for (let group = 1; group <= 2; group++) for (let i = 0; i < 2; i++) {
    const id = `extra-${group}-${i}`;
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767225600000 + group * 600_000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'test');
  }
  const view = await s.curate.openView();
  const first = s.refine.tick();
  s.curate.comparison(view.viewId, view.groups[2].id);
  await s.refine.tick();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].signal.aborted, false);
  release({ assets: { items: [] } }); await first;
  s.advance(1999); await s.refine.tick(); assert.equal(s.calls.length, 1);
  s.advance(1); await s.refine.tick();
  assert.equal(s.calls[1].body.queryAssetId, 'extra-2-0');
  // Closing the comparison clears its priority; only the middle card is visible.
  s.curate.page(view.viewId, 0, 50, { visibleGroupIds: [view.groups[1].id], comparisonGroupId: null });
  s.advance(2000); await s.refine.tick();
  assert.equal(s.calls[2].body.queryAssetId, 'extra-1-0');
  // Lost/hidden-page attention expires even if the broader view is still leased.
  s.advance(12_000); await s.refine.tick();
  assert.equal(s.calls[3].body.queryAssetId, 'p1');
  assert.deepEqual(s.curate.store.viewGroups(view.viewId, 0, 50).map(g => g.ids.length), [2,2,2]);
});

test('attention is bounded to groups in the saved view before any demand changes', async t => {
  const s = await setup(t);
  const view = await s.curate.openView();
  const attention = { visibleGroupIds: [view.groups[0].id] };
  assert.doesNotThrow(() => s.curate.page(view.viewId, 0, 50, attention));
  const before = JSON.stringify([...s.refine.views]);
  for (const invalid of [ { visibleGroupIds: Array(51).fill('a') },
    { visibleGroupIds: [view.groups[0].id, view.groups[0].id] },
    { visibleGroupIds: ['outside-view'] }, { visibleGroupIds: [], comparisonGroupId: 'outside-view' },
    { visibleGroupIds: [], comparisonGroupId: {} } ])
    assert.throws(() => s.curate.page(view.viewId, 0, 50, invalid));
  assert.equal(JSON.stringify([...s.refine.views]), before);
  assert.equal(s.calls.length, 0);
});

test('an old card reports uncertainty in any resulting subgroup, not just its first photo', async t => {
  const s = await setup(t, { respond: () => ({ assets: { items: [] } }) });
  const view = await s.curate.openView();
  enrichCategories(s.repo, ['none','one','one']);
  await s.curate.refresh();
  assert.equal(s.curate.page(view.viewId).groups[0].similarity.pending, true);
  await s.refine.tick(); s.advance(2000); await s.refine.tick();
  const status = s.curate.page(view.viewId).groups[0].similarity;
  assert.equal(status.state, 'updated');
  assert.equal(status.pending, false);
  assert.equal(status.uncertain, true);
});

test('cached evidence bypasses network pacing and counters expose bounded aggregate measurements', async t => {
  const s = await setup(t);
  for (const id of s.ids) { s.advance(2000); await s.curate.similarity.search(id); }
  const view = await s.curate.openView();
  s.refine.requests = Array(30).fill(s.curate.similarity.now());
  for (const id of s.ids) await s.refine.tick();
  assert.equal(s.calls.length, 3);
  assert.equal(s.refine.snapshot()[s.curate.current.scopes[0].id].rows.p0.p1, 0);
  const metrics = s.curate.page(view.viewId).refinement.metrics;
  assert.equal(metrics.requests, 3); assert.equal(metrics.cacheHits, 3);
  assert.equal(metrics.failures, 0); assert.equal(metrics.completedGroups, 1);
  assert.equal(metrics.averageCompletionMs, 0);
  assert.equal(typeof metrics.averageSearchMs, 'number');
  assert.doesNotMatch(JSON.stringify(metrics), /synthetic|p0|http/);
});

test('background additions never enlarge an already inspected comparison silently', async t => {
  const { repo, curate } = await setup(t, { hashes: true });
  const view = await curate.openView(); assert.equal(view.groups.length, 1);
  const comparison = curate.comparison(view.viewId, view.groups[0].id);
  repo.upsertAsset({ id: 'new', fileCreatedAt: '2026-01-01T00:00:03Z' });
  repo.reviewListAdd(['new'], 'test');
  await curate.refresh();
  assert.equal(curate.current.groups[0].ids.length, 4);
  assert.equal(curate.page(view.viewId).groups[0].memberCount, 3);
  await assert.rejects(curate.issueDecision(comparison.id), /membership changed/);
});

test('idle/released views keep progressing; stacking off and connection changes cancel partial work', async t => {
  const { curate, refine, calls, advance, config, immich } = await setup(t);
  const view = await curate.openView();
  advance(REFINEMENT_LIMITS.activeMs); await refine.tick(); assert.equal(calls.length, 1);
  curate.page(view.viewId); await refine.tick(); assert.equal(calls.length, 1);
  config.curateBurstGrouping = false; curate.settingsChanged();
  advance(5000); await refine.tick(); assert.equal(calls.length, 1); assert.equal(refine.entries.size, 0);
  config.curateBurstGrouping = true;
  const replacement = await curate.openView({ replacesViewId: view.viewId });
  immich.apiKey = 'changed'; curate.settingsChanged();
  assert.equal(refine.entries.size, 0); assert.equal(refine.views.size, 0);
  curate.page(replacement.viewId); await refine.tick(); assert.equal(calls.length, 2);
  curate.store.releaseLease(replacement.viewId); advance(5000); await refine.tick(); assert.equal(calls.length, 3);
});

test('thirty new searches per minute and 40 per cohort; known local similarity skips network', async t => {
  const s = await setup(t, { n: 32 });
  const view = await s.curate.openView();
  for (let i = 0; i < 30; i++) {
    if (i) s.advance(2000);
    s.curate.page(view.viewId); await s.refine.tick();
  }
  assert.equal(s.calls.length, 30);
  await s.refine.tick(); assert.equal(s.calls.length, 30);
  s.advance(2000); await s.refine.tick(); assert.equal(s.calls.length, 31);
  const local = await setup(t, { n: 2 });
  for (const id of local.ids) local.repo.upsertAsset({ id, fileCreatedAt: '2026-01-01', thumbhash: Buffer.alloc(21, 10).toString('base64') });
  await local.curate.openView(); await local.refine.tick(); assert.equal(local.calls.length, 0);
  const oversized = await setup(t, { n: 41 });
  const large = await oversized.curate.openView(); await oversized.refine.tick();
  assert.equal(large.groups[0].memberCount, 41); assert.equal(oversized.calls.length, 0);
});

test('failures remain visible while other references progress; only explicit Refresh resets backoff', async t => {
  const { curate, refine, calls, advance } = await setup(t, { n: 2, respond: () => { throw Error('private upstream detail'); } });
  const view = await curate.openView(); await refine.tick();
  assert.equal(refine.status().state, 'paused');
  assert.equal(refine.status().failedGroups, 1);
  assert.match(refine.status().problem, /Could not load/);
  assert.doesNotMatch(JSON.stringify(curate.page(view.viewId)), /private upstream/);
  advance(35000); await refine.tick(); assert.equal(calls.length, 1, 'failed group yields its slot for a minute');
  advance(25000); await refine.tick();
  assert.deepEqual(calls.map(c => c.body.queryAssetId), ['p0', 'p1']);
  assert.equal(refine.status().state, 'paused');
  await curate.openView({ replacesViewId: view.viewId });
  await refine.tick(); assert.equal(calls.length, 2, 'opening or filtering does not reset retries');
  await assert.rejects(curate.openView({ retryChecks: 'false' }), /Invalid/);
  await curate.openView({ retryChecks: true });
  await refine.tick(); assert.equal(calls.length, 2, 'explicit retry still respects lane cooldown');
  advance(30000); await refine.tick(); assert.equal(calls.length, 3);
});

test('changed cohort after I/O discards result; no unrelated IDs in retained matrix', async t => {
  let release;
  const s = await setup(t, { respond: () => new Promise(resolve => { release = resolve; }) });
  const view = await s.curate.openView();
  const work = s.refine.tick();
  s.repo.upsertAsset({ id: 'new', fileCreatedAt: '2026-01-01T00:00:02Z' }); s.repo.reviewListAdd(['new'], 'test');
  release({ assets: { items: [{ id: 'outside-private', type: 'IMAGE' }, { id: 'p1', type: 'IMAGE' }] } });
  await work;
  assert.ok([...s.refine.entries.values()].every(e => Object.keys(e.rows).length === 0));
  assert.doesNotMatch(JSON.stringify(s.refine.snapshot()), /outside-private/);
  assert.equal(s.curate.page(view.viewId).groups[0].memberCount, 3);
});

test('inactive completed ranks persist and source changes invalidate whole cohorts', async t => {
  const s = await setup(t);
  const view = await s.curate.openView();
  for (let i = 0; i < 3; i++) { await s.refine.tick(); s.advance(5000); }
  const oldRevision = s.refine.revision;
  s.advance(24 * 60 * 60_000); s.refine.snapshot();
  assert.equal(s.refine.entries.size, 0); assert.equal(s.refine.revision, oldRevision);
  assert.equal(s.refine.saved.records.size, 1);
  await s.curate.refresh();
  await s.refine.tick(); assert.equal(s.calls.length, 3);
  s.repo.upsertAsset({ id: 'p1', fileCreatedAt: '2026-01-01T00:00:01Z', checksum: 'changed' });
  await s.curate.refresh(); s.advance(5000); await s.refine.tick();
  assert.equal(s.refine.entries.size, 1, 'background processing admits the revised candidate');
  assert.ok([...s.refine.entries.values()].every(e => s.refine.valid(e)));
});

test('publish the landscape matrix once; active completed evidence survives cache age and repeated Refresh', async t => {
  const ranks = [[null,3,5,1,2], [2,null,1,3,4], [9,2,null,23,8], [1,3,5,null,2], [1,6,5,2,null]];
  const s = await setup(t, { n: 5, hashes: true, respond: args => {
    const reference = Number(args.body.queryAssetId.slice(1));
    const items = Array.from({ length: 50 }, (_, n) => ({ id: `outside-${n}`, type: 'IMAGE' }));
    ranks[reference].forEach((rank, n) => { if (rank) items[rank - 1] = { id: `p${n}`, type: 'IMAGE' }; });
    return { assets: { items } };
  } });
  // Explicitly distant descriptors for this five-photo regression.
  for (const [i, id] of s.ids.entries()) s.repo.updateAssetVisuals(id, { thumbhash: Buffer.alloc(21, i * 45).toString('base64') });
  let view = await s.curate.openView();
  const original = view.groups.map(g => g.id);
  assert.equal(original.length, 1);
  for (let i = 0; i < 4; i++) {
    await s.refine.tick(); s.advance(5000);
    assert.equal(s.refine.revision, 0);
    assert.deepEqual(s.refine.snapshot(), {});
    const status = s.curate.page(view.viewId);
    assert.equal(status.updatesAvailable, false);
    assert.deepEqual(status.groups[0].similarity, { state: 'checking', done: i + 1, total: 5 });
    view = await s.curate.openView({ replacesViewId: view.viewId });
    assert.deepEqual(view.groups.map(g => g.id), original, 'Refresh cannot publish a partial split');
  }
  await s.refine.tick();
  assert.equal(s.refine.revision, 1);
  assert.equal(s.curate.page(view.viewId).refinement.ready, 1);
  view = await s.curate.openView({ replacesViewId: view.viewId });
  assert.deepEqual(view.groups.map(g => g.memberCount), [5]);
  assert.equal(view.groups[0].similarity.state, 'checked');
  // Keep using the page beyond the original ten-minute admission lifetime.
  for (let i = 0; i < 25; i++) {
    s.advance(30_000); s.curate.page(view.viewId); await s.refine.tick();
    view = await s.curate.openView({ replacesViewId: view.viewId });
    assert.deepEqual(view.groups.map(g => g.memberCount), [5]);
    assert.equal(view.updatesAvailable, false);
  }
  assert.equal(s.calls.length, 5, 'an active completed pass is not re-run on a timer');
});

test('finished checks that change no grouping and work in another view do not advertise irrelevant updates', async t => {
  const s = await setup(t, { n: 3, hashes: true, respond: () => ({ assets: { items: [] } }) });
  s.repo.upsertAsset({ id: 'alone', fileCreatedAt: '2026-02-01', originalPath: '/alone.jpg' });
  s.repo.reviewListAdd(['alone'], 'test');
  const view = await s.curate.openView();
  const other = await s.curate.openView({ search: 'alone' });
  assert.equal(other.groups.length, 1);
  assert.equal(other.refinement.pending, 3);
  for (let i = 0; i < 3; i++) { await s.refine.tick(); s.advance(5000); }
  const checked = s.curate.page(view.viewId);
  assert.equal(checked.groups[0].similarity.state, 'checked');
  assert.equal(checked.groups[0].similarity.uncertain, true);
  assert.equal(checked.groups[0].memberCount, 3);
  assert.equal(checked.groups[0].route, 'candidate-unconfirmed');
  assert.equal(checked.refinement.ready, 0);
  assert.equal(checked.updatesAvailable, false);
  assert.equal(s.curate.page(other.viewId).updatesAvailable, false);
});

test('failed partial pass stays unpublished and resumes on explicit retry', async t => {
  const s = await setup(t, { n: 3, hashes: true, respond: (args, n) => {
    if (n === 2) throw Error('synthetic failure');
    return { assets: { items: ['p0', 'p1', 'p2'].map(id => ({ id, type: 'IMAGE' })) } };
  } });
  let view = await s.curate.openView();
  await s.refine.tick(); s.advance(5000); await s.refine.tick();
  assert.equal(s.curate.page(view.viewId).groups[0].similarity.state, 'paused');
  assert.equal(s.curate.page(view.viewId).groups[0].memberCount, 3);
  assert.equal(s.curate.current.groups[0].route, 'candidate-unconfirmed');
  assert.deepEqual(s.refine.snapshot(), {});
  assert.equal(s.refine.revision, 0);
  s.advance(60_000); await s.refine.tick(); assert.equal(s.calls.length, 3);
  assert.deepEqual(s.refine.snapshot(), {}, 'healthy reference is retained but not published');
  view = await s.curate.openView({ replacesViewId: view.viewId, retryChecks: true });
  await s.refine.tick(); s.advance(5000); await s.refine.tick();
  assert.equal(s.refine.revision, 1);
  assert.equal(s.curate.page(view.viewId).refinement.ready, 1);
  assert.equal(s.calls.length, 4);
});

test('a finished merge prompts only its view; excess candidates wait without exceeding the active bound', async t => {
  const s = await setup(t, { hashes: true });
  s.repo.upsertAsset({ id: 'alone', fileCreatedAt: '2026-02-01', originalPath: '/alone.jpg' });
  s.repo.reviewListAdd(['alone'], 'test');
  const view = await s.curate.openView(), other = await s.curate.openView({ search: 'alone' });
  for (let i = 0; i < 3; i++) { await s.refine.tick(); s.advance(5000); }
  assert.equal(s.curate.page(view.viewId).refinement.ready, 1);
  assert.equal(s.curate.page(other.viewId).updatesAvailable, false);
  const many = await setup(t, { n: 2 });
  for (let n = 1; n <= 32; n++) for (let i = 0; i < 2; i++) {
    const id = `extra-${n}-${i}`;
    many.repo.upsertAsset({ id, fileCreatedAt: new Date(1767225600000 + n * 600_000 + i * 1000).toISOString() });
    many.repo.reviewListAdd([id], 'test');
  }
  const full = await many.curate.openView();
  assert.equal(many.refine.entries.size, REFINEMENT_LIMITS.cohorts);
  assert.equal(full.refinement.totalGroups, 33);
  assert.equal(full.refinement.limited, false);
  assert.equal(full.groups.at(-1).similarity.state, 'waiting');
});

test('leases decode candidate singles across restart and old projections are upgraded lazily', async t => {
  const s = await setup(t, { n: 1 });
  s.repo.db.prepare("UPDATE curate_photos SET evidence_json=json_remove(evidence_json,'$.category')").run();
  await s.curate.close();
  const next = new CurateService({ repo: s.repo, candidateOptions: { enabled: true }, metadataOptions: { automatic: false } });
  next.start = () => {}; t.after(() => next.close());
  const view = await next.openView();
  assert.match(view.groups[0].id, /single:candidate-3:/);
  assert.equal(next.comparison(view.viewId, view.groups[0].id).ids[0], 'p0');
  assert.equal(s.repo.db.prepare("SELECT json_type(evidence_json,'$.category') type FROM curate_photos").get().type, 'object');
});


test('known image edits invalidate shared cached searches; people-only refresh renews all visible cohort demand', async t => {
  const s = await setup(t, { n: 2 });
  const later = ['q0', 'q1'];
  for (const [i, id] of later.entries()) {
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767226200000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'test');
  }
  const view = await s.curate.openView();
  await s.refine.tick();
  assert.ok(s.curate.similarity.cached('p0'));
  s.repo.curate.mergeMetadataAsset({ id: 'p0', isEdited: true });
  s.repo.curate.mergeMetadataAsset({ id: 'q0', people: [{ id: 'person-a' }] });
  await s.curate.refresh();
  assert.equal(s.curate.similarity.cached('p0'), null);
  // Heartbeat only reads the first card; the second candidate still renews.
  s.curate.page(view.viewId, 0, 1); s.advance(5000); await s.refine.tick();
  assert.equal(s.refine.active().size, 2);
  assert.ok([...s.refine.active()].every(id => s.refine.entries.has(id)));
});

test('the shared lane waits for lab ownership and continues after browser attention expires', async t => {
  let release;
  const s = await setup(t, { respond: () => new Promise(resolve => { release = resolve; }) });
  await s.curate.openView();
  const owner = s.curate.similarity.reserve();
  await s.refine.tick(); assert.equal(s.calls.length, 0);
  s.curate.similarity.release(owner);
  const work = s.refine.tick(); assert.equal(s.calls.length, 1);
  s.advance(REFINEMENT_LIMITS.activeMs); await s.refine.tick();
  assert.equal(s.calls[0].signal.aborted, false);
  release({ assets: { items: [] } }); await work;
  assert.equal([...s.refine.entries.values()][0].rows.p0 !== undefined, true);
});

test('a post-change view cannot reuse a background rebuild captured before the change', async t => {
  const s = await setup(t);
  let release, captured;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { captured = resolve; });
  const rebuild = s.curate.rebuild.bind(s.curate);
  let first = true;
  s.curate.rebuild = async () => {
    const result = await rebuild();
    if (first) { first = false; captured(); await gate; }
    return result;
  };
  const background = s.curate.refresh(); await ready;
  s.repo.upsertAsset({ id: 'new', fileCreatedAt: '2026-01-01T00:00:03Z' });
  s.repo.reviewListAdd(['new'], 'test');
  const afterChange = s.curate.openView(); release(); await background;
  const view = await afterChange;
  assert.equal(view.groups.reduce((n, g) => n + g.memberCount, 0), 4);
});

test('background processing drains more than 32 scopes without views or Load more', async t => {
  const s = await setup(t, { n: 2 });
  for (let n = 1; n < 60; n++) for (let i = 0; i < 2; i++) {
    const id = `backlog-${n}-${i}`;
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767225600000 + n * 600_000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'test');
  }
  for (let i = 0; i < 120; i++) {
    await s.curate.backgroundTick(); s.advance(2000);
    assert.ok(s.refine.entries.size <= 32);
  }
  assert.equal(s.refine.views.size, 0);
  assert.equal(s.calls.length, 120);
  assert.equal(s.refine.saved.records.size, 60);
  assert.equal(s.refine.status().remainingGroups, 0);
  assert.equal(s.refine.entries.size, 0);
  // Later Enrich arrivals are picked up with the same server loop.
  for (const [i,id] of ['arrival-a','arrival-b'].entries()) {
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767305600000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'enrich');
  }
  for (let i = 0; i < 2; i++) { await s.curate.backgroundTick(); s.advance(2000); }
  assert.equal(s.calls.length, 122);
  assert.equal(s.refine.status().checkedGroups, 61);
});

test('server start refreshes metadata and checks without opening a browser', async t => {
  const s = await setup(t, { n: 2 });
  const reads = [];
  s.immich.getAsset = async id => { reads.push(id); return { id, people: [] }; };
  s.curate.metadata.automatic = true;
  CurateService.prototype.start.call(s.curate);
  const deadline = Date.now() + 6000;
  while (!s.calls.length) {
    assert.ok(Date.now() < deadline, 'startup did not start checks');
    await new Promise(r => setTimeout(r, 20));
  }
  assert.deepEqual(reads.sort(), s.ids);
  assert.equal(s.refine.views.size, 0);
  assert.equal(s.curate.repo.db.prepare("SELECT count(*) n FROM curate_leases").get().n, 0);
});

test('completed evidence survives service and database restart, while changed connections cannot reuse it', async t => {
  const s = await setup(t);
  for (let i = 0; i < 3; i++) { await s.curate.backgroundTick(); s.advance(2000); }
  const grouping = s.curate.current.groups.map(g => g.id);
  await s.curate.close();
  const repo = new Repository(s.repo.databasePath); repo.initSchema();
  const next = new CurateService({ repo, config: s.config, immich: s.immich,
    metadataOptions: { automatic: false }, candidateOptions: { enabled: true } });
  next.start = () => {};
  t.after(async () => { await next.close(); repo.close(); });
  await next.backgroundTick();
  assert.deepEqual(next.current.groups.map(g => g.id), grouping);
  assert.equal(s.calls.length, 3, 'restart does not request another completed matrix');
  assert.equal(next.refinement.status().checkedGroups, 1);
  s.immich.apiKey = 'new-connection'; next.settingsChanged();
  assert.equal(next.refinement.saved.records.size, 0);
  await next.backgroundTick();
  assert.equal(s.calls.length, 4);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
});

test('failed searches retry automatically with backoff, leaving other candidates free to progress', async t => {
  let failing = true;
  const s = await setup(t, { n: 2, respond: args => {
    if (args.body.queryAssetId === 'p0' && failing) throw Error('upstream failure');
    return { assets: { items: [] } };
  } });
  for (const [i,id] of ['other-a','other-b'].entries()) {
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767226200000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'test');
  }
  await s.curate.backgroundTick();
  s.advance(35_000); await s.curate.backgroundTick();
  s.advance(2000); await s.curate.backgroundTick();
  s.advance(2000); await s.curate.backgroundTick();
  assert.deepEqual(s.calls.map(c => c.body.queryAssetId), ['p0', 'other-a', 'other-b']);
  s.advance(21_000); await s.curate.backgroundTick();
  assert.equal(s.calls.at(-1).body.queryAssetId, 'p1');
  s.advance(2000); await s.curate.backgroundTick();
  assert.equal(s.calls.length, 5);
  assert.equal(s.refine.status().state, 'paused');
  s.advance(119_999); await s.curate.backgroundTick(); assert.equal(s.calls.length, 5);
  failing = false;
  s.advance(1); await s.curate.backgroundTick();
  s.advance(2000); await s.curate.backgroundTick();
  assert.equal(s.calls.length, 6);
  assert.equal(s.refine.status().checkedGroups, 2);
});

test('a full evidence cache pauses publication without repeating completed searches', async t => {
  const s = await setup(t);
  const limits = s.refine.saved.limits;
  s.refine.saved.limits = { ...limits, bytes: 1 };
  for (let i = 0; i < 3; i++) { await s.curate.backgroundTick(); s.advance(2000); }
  assert.equal(s.refine.status().state, 'limited');
  assert.equal(s.refine.saved.records.size, 0);
  for (let i = 0; i < 5; i++) { await s.curate.backgroundTick(); s.advance(60_000); }
  assert.equal(s.calls.length, 3);
  assert.equal(s.curate.current.groups[0].route, 'candidate-unconfirmed');
  s.refine.saved.limits = limits;
  await s.curate.backgroundTick();
  assert.equal(s.refine.status().state, 'idle');
  assert.equal(s.refine.saved.records.size, 1);
  assert.equal(s.calls.length, 3);
});

test('turning Stacks off cancels an in-flight background request and does not publish its result', async t => {
  let release;
  const s = await setup(t, { respond: () => new Promise(resolve => { release = resolve; }) });
  const work = s.refine.tick();
  assert.equal(s.calls.length, 1);
  s.config.curateBurstGrouping = false; s.curate.settingsChanged();
  assert.equal(s.calls[0].signal.aborted, true);
  release({ assets: { items: s.ids.map(id => ({ id, type: 'IMAGE' })) } });
  await work;
  assert.equal(s.refine.saved.records.size, 0);
  assert.equal(s.refine.entries.size, 0);
  await s.curate.backgroundTick(); assert.equal(s.calls.length, 1);
});

test('missing embeddings park partial evidence across restart, then publish once after recovery', async t => {
  let failing = true;
  const s = await setup(t, { respond: args => {
    if (args.body.queryAssetId === 'p0' && failing) throw new ImmichApiError('Asset private-photo has no embedding secret', 400);
    return { assets: { items: ['p0','p1','p2'].map(id => ({ id, type: 'IMAGE' })) } };
  } });
  const view = await s.curate.openView();
  for (let i = 0; i < 3; i++) { await s.curate.backgroundTick(); s.advance(2000); }
  const status = s.refine.status();
  assert.equal(status.state, 'paused'); assert.equal(status.pending, 1);
  assert.equal(status.failedGroups, 1); assert.equal(status.failedReferences, 1);
  assert.deepEqual(status.problemCodes, ['similarity_embedding_missing']);
  assert.match(status.problem, /Immich has no search embedding/);
  assert.equal(s.curate.page(view.viewId).groups[0].similarity.problemCode, 'similarity_embedding_missing');
  assert.deepEqual(s.refine.snapshot(), {}); assert.equal(s.refine.revision, 0);
  assert.equal(s.refine.entries.size, 0, 'deferred scope releases its active slot');
  assert.equal(s.refine.retries.records.size, 1);
  assert.doesNotMatch(JSON.stringify(s.repo.db.prepare('SELECT * FROM curate_rank_retries').all()), /private-photo|secret/);
  const now = s.refine.now;
  await s.curate.close();
  const repo = new Repository(s.repo.databasePath); repo.initSchema();
  const next = new CurateService({ repo, config: s.config, immich: s.immich,
    metadataOptions: { automatic: false }, candidateOptions: { enabled: true, now } });
  next.start = () => {};
  next.similarity = new CurateSimilaritySearch({ curate: next, now });
  t.after(async () => { await next.close(); repo.close(); });
  await next.backgroundTick();
  assert.equal(s.calls.length, 3, 'restart preserves successful rows and missing-reference backoff');
  assert.equal(next.refinement.status().failedReferences, 1);
  assert.equal(next.refinement.status().retryAt, status.retryAt);
  await next.openView({ retryChecks: false }); await next.backgroundTick(); assert.equal(s.calls.length, 3);
  s.advance(status.retryAt - now() - 1); await next.backgroundTick(); assert.equal(s.calls.length, 3);
  failing = false; s.advance(1); await next.backgroundTick();
  assert.deepEqual(s.calls.map(c => c.body.queryAssetId), ['p0','p1','p2','p0']);
  assert.equal(next.refinement.revision, 1); assert.equal(next.refinement.status().checkedGroups, 1);
  assert.equal(next.refinement.status().failedGroups, 0); assert.equal(next.refinement.status().problem, null);
  assert.equal(next.refinement.retries.records.size, 0);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
});

test('more than 32 missing-embedding scopes cannot starve later healthy scopes', async t => {
  const s = await setup(t, { n: 0, respond: args => {
    const [, group, member] = args.body.queryAssetId.split('-');
    if (+group < 40 && member === '0') throw new ImmichApiError('Asset private has no embedding', 400);
    return { assets: { items: [] } };
  } });
  for (let n = 0; n < 60; n++) for (let i = 0; i < 2; i++) {
    const id = `backlog-${n}-${i}`;
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767225600000 + n * 600_000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'test');
  }
  for (let i = 0; i < 120; i++) {
    await s.curate.backgroundTick(); s.advance(2000);
    assert.ok(s.refine.entries.size <= 32);
  }
  const status = s.refine.status();
  assert.equal(s.calls.length, 120); assert.equal(status.checkedGroups, 20);
  assert.equal(status.failedGroups, 40); assert.equal(status.failedReferences, 40);
  assert.equal(status.remainingGroups, 40); assert.equal(status.pending, 40);
  assert.equal(s.refine.entries.size, 0); assert.equal(s.refine.retries.records.size, 40);
  assert.equal(s.refine.views.size, 0); assert.equal(status.state, 'paused');
});

test('unavailable references yield to healthy groups and try unqueried members before retries', async t => {
  const s = await setup(t, { n: 4, respond: args => {
    if (args.body.queryAssetId.startsWith('p'))
      throw new ImmichApiError('Not found or no asset.read access', 400);
    return { assets: { items: [] } };
  } });
  for (let i = 0; i < 4; i++) {
    const id = `healthy-${i}`;
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767226200000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'test');
  }
  await s.curate.backgroundTick();
  s.advance(2000); await s.curate.backgroundTick();
  assert.equal(s.calls[1]?.body.queryAssetId, 'healthy-0', 'the next turn belongs to a healthy group');
  for (let i = 0; i < 3; i++) { s.advance(2000); await s.curate.backgroundTick(); }
  assert.equal(s.refine.status().checkedGroups, 1);
  assert.equal(s.refine.status().failedGroups, 1);
  assert.equal(s.refine.saved.records.size, 1, 'failed group never publishes partial evidence');
  s.advance(52_000); await s.curate.backgroundTick();
  assert.equal(s.calls.at(-1).body.queryAssetId, 'p1', 'unqueried members precede due retries');
  s.advance(60_000); await s.curate.backgroundTick();
  assert.equal(s.calls.at(-1).body.queryAssetId, 'p2');
  s.advance(60_000); await s.curate.backgroundTick();
  assert.equal(s.calls.at(-1).body.queryAssetId, 'p3');
});

test('more than 32 wholly unavailable scopes release slots for healthy work', async t => {
  const s = await setup(t, { n: 0, respond: args => {
    if (+args.body.queryAssetId.split('-')[1] < 36)
      throw new ImmichApiError('Not found or no asset.read access', 400);
    return { assets: { items: [] } };
  } });
  for (let n = 0; n < 40; n++) for (let i = 0; i < 4; i++) {
    const id = `queue-${n}-${i}`;
    s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767225600000 + n * 600_000 + i * 1000).toISOString() });
    s.repo.reviewListAdd([id], 'test');
  }
  for (let i = 0; i < 100; i++) {
    await s.curate.backgroundTick(); s.advance(2000);
    assert.ok(s.refine.entries.size <= 32);
  }
  assert.equal(s.refine.status().checkedGroups, 4);
  assert.equal(s.refine.status().failedGroups, 36);
  assert.equal(s.refine.saved.records.size, 4);
});

test('unavailable group pause survives restart without retrying its first reference ahead of unqueried photos', async t => {
  const s = await setup(t, { n: 4, respond: () => {
    throw new ImmichApiError('Not found or no asset.read access', 400);
  } });
  await s.curate.backgroundTick();
  const now = s.refine.now;
  await s.curate.close();
  const repo = new Repository(s.repo.databasePath); repo.initSchema();
  const next = new CurateService({ repo, config: s.config, immich: s.immich,
    metadataOptions: { automatic: false }, candidateOptions: { enabled: true, now } });
  next.start = () => {};
  next.similarity = new CurateSimilaritySearch({ curate: next, now });
  t.after(async () => { await next.close(); repo.close(); });
  await next.backgroundTick();
  assert.equal(next.refinement.entries.size, 0);
  s.advance(59_999); await next.backgroundTick(); assert.equal(s.calls.length, 1);
  s.advance(1); await next.backgroundTick();
  assert.deepEqual(s.calls.map(c => c.body.queryAssetId), ['p0', 'p1']);
  assert.deepEqual(next.refinement.snapshot(), {});
});

test('global search failures retain cooldown but yield the next turn to another group', async t => {
  for (const status of [401, 403, 429, 500]) await t.test(String(status), async t => {
    const s = await setup(t, { n: 4, respond: args => {
      if (args.body.queryAssetId.startsWith('p')) throw new ImmichApiError('private upstream detail', status);
      return { assets: { items: [] } };
    } });
    for (let i = 0; i < 2; i++) {
      const id = `healthy-${i}`;
      s.repo.upsertAsset({ id, fileCreatedAt: new Date(1767226200000 + i * 1000).toISOString() });
      s.repo.reviewListAdd([id], 'test');
    }
    await s.curate.backgroundTick();
    s.advance(29_999); await s.curate.backgroundTick(); assert.equal(s.calls.length, 1);
    s.advance(1); await s.curate.backgroundTick();
    assert.equal(s.calls[1]?.body.queryAssetId, 'healthy-0');
    s.advance(2000); await s.curate.backgroundTick();
    assert.equal(s.refine.status().checkedGroups, 1);
    assert.equal(s.refine.status().failedGroups, 1);
    assert.doesNotMatch(JSON.stringify(s.refine.status()), /private upstream detail/);
  });
});

test('parked failures invalidate on exact source or connection changes', async t => {
  for (const mode of ['source', 'connection']) await t.test(mode, async t => {
    const s = await setup(t, { n: 2, respond: () => { throw new ImmichApiError('Asset private has no embedding', 400); } });
    for (let i = 0; i < 2; i++) { await s.curate.backgroundTick(); s.advance(2000); }
    const old = [...s.refine.retries.records.keys()][0];
    if (mode === 'source') s.repo.updateAssetVisuals('p0', { thumbhash: Buffer.alloc(21, 12).toString('base64') });
    else { s.immich.apiKey = 'replacement'; s.curate.settingsChanged(); }
    await s.curate.backgroundTick();
    assert.equal(s.calls.length, 3);
    assert.equal(mode === 'source' ? s.refine.retries.records.has(old) : s.refine.status().failedReferences === 2, false);
    assert.deepEqual(s.refine.snapshot(), {});
  });
});

test('retry storage limits are visible, preserve active evidence and recover when space is available', async t => {
  const s = await setup(t, { n: 2, respond: () => { throw new ImmichApiError('Asset private has no embedding', 400); } });
  const limits = s.refine.retries.limits;
  s.refine.retries.limits = { ...limits, bytes: 1 };
  for (let i = 0; i < 2; i++) { await s.curate.backgroundTick(); s.advance(2000); }
  assert.equal(s.refine.status().state, 'limited'); assert.equal(s.refine.entries.size, 1);
  assert.equal(s.refine.retries.records.size, 0); assert.equal(s.refine.status().failedReferences, 2);
  s.refine.retries.limits = limits;
  await s.curate.backgroundTick();
  assert.equal(s.refine.status().state, 'paused'); assert.equal(s.refine.entries.size, 0);
  assert.equal(s.refine.retries.records.size, 1); assert.equal(s.calls.length, 2);
});

test('missing embeddings stop after three automatic retries, survive restart and resume only explicitly', async t => {
  let failing = true;
  const s = await setup(t, { n: 2, respond: args => {
    if (args.body.queryAssetId === 'p0' && failing) throw new ImmichApiError('Asset private has no embedding', 400);
    return { assets: { items: [] } };
  } });
  await s.curate.backgroundTick();
  assert.equal(s.refine.status().retryAt - s.refine.now(), 15 * 60_000);
  s.advance(2000); await s.curate.backgroundTick();
  for (const delay of [30, 60]) {
    s.advance(s.refine.status().retryAt - s.refine.now()); await s.curate.backgroundTick();
    assert.equal(s.refine.status().retryAt - s.refine.now(), delay * 60_000);
  }
  s.advance(s.refine.status().retryAt - s.refine.now()); await s.curate.backgroundTick();
  const stopped = s.refine.status();
  assert.equal(s.calls.length, 5, 'initial attempt plus three retries, and one healthy reference');
  assert.equal(stopped.state, 'paused'); assert.equal(stopped.retryAt, null);
  assert.equal(stopped.stoppedGroups, 1); assert.equal(stopped.pending, 1);
  assert.match(stopped.problem, /Automatic retries stopped/);
  assert.equal(s.refine.entries.size, 0); assert.deepEqual(s.refine.snapshot(), {});
  s.advance(7 * 24 * 60 * 60_000); await s.curate.backgroundTick();
  await s.curate.openView(); await s.curate.backgroundTick(); assert.equal(s.calls.length, 5);

  const now = s.refine.now;
  await s.curate.close();
  const repo = new Repository(s.repo.databasePath); repo.initSchema();
  const next = new CurateService({ repo, config: s.config, immich: s.immich,
    metadataOptions: { automatic: false }, candidateOptions: { enabled: true, now } });
  next.start = () => {}; next.similarity = new CurateSimilaritySearch({ curate: next, now });
  t.after(async () => { await next.close(); repo.close(); });
  await next.backgroundTick();
  const view = await next.openView(); await next.backgroundTick();
  assert.equal(s.calls.length, 5, 'neither restart nor opening a view resumes exhausted work');
  assert.equal(next.refinement.status().stoppedGroups, 1);
  assert.equal(view.groups[0].similarity.problemCode, 'similarity_embedding_missing_exhausted');
  assert.equal(view.groups[0].similarity.retryAt, null);
  assert.equal(next.refinement.entries.size, 0);

  for (const [i,id] of ['healthy-new-a','healthy-new-b'].entries()) {
    repo.upsertAsset({ id, fileCreatedAt: new Date(1767226200000 + i * 1000).toISOString() });
    repo.reviewListAdd([id], 'test');
  }
  for (let i = 0; i < 2; i++) { await next.backgroundTick(); s.advance(2000); }
  assert.equal(next.refinement.status().checkedGroups, 1, 'new healthy scopes continue after others exhaust retries');
  assert.equal(s.calls.length, 7);

  await next.openView({ retryChecks: true }); await next.backgroundTick();
  assert.equal(s.calls.length, 8);
  assert.equal(next.refinement.status().stoppedGroups, 0);
  assert.equal(next.refinement.status().retryAt - now(), 15 * 60_000, 'manual retry starts a fresh bounded cycle');
  failing = false;
  s.advance(15 * 60_000); await next.backgroundTick();
  assert.equal(s.calls.length, 9);
  assert.equal(next.refinement.status().checkedGroups, 2);
  assert.equal(next.refinement.status().remainingGroups, 0);
  assert.equal(next.refinement.retries.records.size, 0);
});

test('attempt counts retained by the uncapped preview do not license another automatic search', async t => {
  const s = await setup(t, { n: 2, respond: () => { throw new ImmichApiError('Asset private has no embedding', 400); } });
  await s.curate.backgroundTick(); s.advance(2000); await s.curate.backgroundTick();
  s.refine.sync();
  const [id] = s.refine.retries.records.keys();
  const entry = { ...s.curate.current.scopes.find(scope => scope.id === id), ...s.refine.retries.read(id) };
  for (const error of Object.values(entry.errors)) { error.attempts = 8; error.retryAt = 0; }
  s.refine.retries.save(entry, { done: 0, failedReferences: 2, problemCodes: ['similarity_embedding_missing'], eligibleAt: 0, retryAt: 0 });
  s.advance(60 * 60_000); await s.curate.backgroundTick();
  assert.equal(s.calls.length, 2); assert.equal(s.refine.status().stoppedGroups, 1);
  assert.equal(s.refine.status().retryAt, null); assert.equal(s.refine.entries.size, 0);
  await s.curate.openView({ retryChecks: true }); await s.curate.backgroundTick();
  assert.equal(s.calls.length, 3); assert.equal(s.refine.status().retryAt - s.refine.now(), 15 * 60_000);
});
