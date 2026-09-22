import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateSimilaritySearch } from '../../src/curate/similarity.mjs';
import { REFINEMENT_LIMITS } from '../../src/curate/refinement.mjs';

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

test('strong people conflicts need no searches; resolved visible cards do not admit other work', async t => {
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
  assert.equal(couple.refinement.pending, 0);
  await s.refine.tick(); assert.equal(s.calls.length, 0);

  const all = await s.curate.openView();
  assert.equal(all.refinement.pending, 4);
  assert.equal(all.groups.find(g => g.memberCount === 2).similarity, null);
  for (let i = 0; i < 4; i++) { await s.refine.tick(); s.advance(5000); }
  assert.deepEqual(s.calls.map(c => c.body.queryAssetId), ['p0','p1','p2','p5']);
  const entry = [...s.refine.entries.values()][0];
  assert.equal(entry.rows.p0.p5, 1, 'unqueried couple remains inside the original time cohort');
  assert.equal(entry.complete, true);
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

test('no searches on rebuild/startup; visible preview demand admits only paced, cached requests', async t => {
  const { curate, refine, calls, advance } = await setup(t);
  await refine.tick(); assert.equal(calls.length, 0);
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

test('stacking off, replaced/idle views, connection changes and closing stop automatic work', async t => {
  const { curate, refine, calls, advance, config, immich } = await setup(t);
  const view = await curate.openView();
  advance(REFINEMENT_LIMITS.activeMs); await refine.tick(); assert.equal(calls.length, 0);
  curate.page(view.viewId); await refine.tick(); assert.equal(calls.length, 1);
  config.curateBurstGrouping = false; curate.settingsChanged();
  advance(5000); await refine.tick(); assert.equal(calls.length, 1); assert.equal(refine.entries.size, 0);
  config.curateBurstGrouping = true;
  const replacement = await curate.openView({ replacesViewId: view.viewId });
  immich.apiKey = 'changed'; curate.settingsChanged();
  assert.equal(refine.entries.size, 0); assert.equal(refine.views.size, 0);
  curate.page(replacement.viewId); await refine.tick(); assert.equal(calls.length, 2);
  curate.store.releaseLease(replacement.viewId); advance(5000); await refine.tick(); assert.equal(calls.length, 2);
});

test('eight new searches per minute and 40 per cohort; known local similarity skips network', async t => {
  const s = await setup(t, { n: 12 });
  const view = await s.curate.openView();
  for (let i = 0; i < 12; i++) { s.curate.page(view.viewId); await s.refine.tick(); s.advance(5000); }
  assert.equal(s.calls.length, 8);
  await s.refine.tick(); assert.equal(s.calls.length, 9);
  const local = await setup(t, { n: 2 });
  for (const id of local.ids) local.repo.upsertAsset({ id, fileCreatedAt: '2026-01-01', thumbhash: Buffer.alloc(21, 10).toString('base64') });
  await local.curate.openView(); await local.refine.tick(); assert.equal(local.calls.length, 0);
  const oversized = await setup(t, { n: 41 });
  const large = await oversized.curate.openView(); await oversized.refine.tick();
  assert.equal(large.groups[0].memberCount, 41); assert.equal(oversized.calls.length, 0);
});

test('failure pauses without automatic retries; explicit Refresh retries after lane cooldown', async t => {
  const { curate, refine, calls, advance } = await setup(t, { respond: () => { throw Error('private upstream detail'); } });
  const view = await curate.openView(); await refine.tick();
  assert.equal(refine.status().state, 'paused'); assert.doesNotMatch(JSON.stringify(curate.page(view.viewId)), /private upstream/);
  advance(35000); await refine.tick(); assert.equal(calls.length, 1);
  await curate.openView({ replacesViewId: view.viewId }); await refine.tick(); assert.equal(calls.length, 2);
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

test('inactive completed ranks expire and source changes invalidate whole cohorts', async t => {
  const s = await setup(t);
  const view = await s.curate.openView();
  for (let i = 0; i < 3; i++) { await s.refine.tick(); s.advance(5000); }
  const oldRevision = s.refine.revision;
  s.advance(REFINEMENT_LIMITS.cacheMs); s.refine.snapshot();
  assert.equal(s.refine.entries.size, 0); assert.ok(s.refine.revision > oldRevision);
  await s.curate.refresh();
  s.curate.page(view.viewId); await s.refine.tick();
  s.repo.upsertAsset({ id: 'p1', fileCreatedAt: '2026-01-01T00:00:01Z', checksum: 'changed' });
  await s.curate.refresh(); s.advance(5000); await s.refine.tick();
  assert.equal(s.refine.entries.size, 1, 'active view re-admits the revised candidate');
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
  assert.equal(other.refinement.pending, 0);
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
  s.advance(35_000); await s.refine.tick(); assert.equal(s.calls.length, 2);
  view = await s.curate.openView({ replacesViewId: view.viewId });
  await s.refine.tick(); s.advance(5000); await s.refine.tick();
  assert.equal(s.refine.revision, 1);
  assert.equal(s.curate.page(view.viewId).refinement.ready, 1);
  assert.equal(s.calls.length, 4);
});

test('a finished merge prompts only its view; capacity limits are visible without exceeding the bound', async t => {
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
  assert.equal(full.refinement.limited, true);
  assert.equal(full.groups.at(-1).similarity.state, 'limited');
});

test('leases decode candidate singles across restart and old projections are upgraded lazily', async t => {
  const s = await setup(t, { n: 1 });
  s.repo.db.prepare("UPDATE curate_photos SET evidence_json=json_remove(evidence_json,'$.category')").run();
  await s.curate.close();
  const next = new CurateService({ repo: s.repo, candidateOptions: { enabled: true }, metadataOptions: { automatic: false } });
  next.start = () => {}; t.after(() => next.close());
  const view = await next.openView();
  assert.match(view.groups[0].id, /single:candidate-2:/);
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

test('the shared lane waits for lab ownership and aborts an idle in-flight preview request', async t => {
  let release;
  const s = await setup(t, { respond: () => new Promise(resolve => { release = resolve; }) });
  await s.curate.openView();
  const owner = s.curate.similarity.reserve();
  await s.refine.tick(); assert.equal(s.calls.length, 0);
  s.curate.similarity.release(owner);
  const work = s.refine.tick(); assert.equal(s.calls.length, 1);
  s.advance(REFINEMENT_LIMITS.activeMs); await s.refine.tick();
  assert.equal(s.calls[0].signal.aborted, true);
  release({ assets: { items: [] } }); await work;
  assert.ok([...s.refine.entries.values()].every(e => Object.keys(e.rows).length === 0));
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
