import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { CurateAiLifecycle, AI_SETTLE_MS } from '../../src/curate/ai-lifecycle.mjs';
import { AiRequestScheduler } from '../../src/ai/scheduler.mjs';
import { StackRefereeWorker } from '../../src/curate/stack-referee-worker.mjs';
import { PhotoRefereeWorker, PHOTO_PREVIEW_PAUSE_MS } from '../../src/curate/photo-referee-worker.mjs';
import { PHOTO_REFEREE_CONTRACT } from '../../src/curate/photo-referee-contract.mjs';
import { refereeCapability } from '../../src/curate/referee-capabilities.mjs';
import { ImmichApiError } from '../../src/immich.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';
import { readPhotoRefereeRecord } from '../../src/curate/photo-referee-results.mjs';
import { CURATE_AI_AVAILABILITY } from '../../src/curate/ai-policy.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const response = (ids, keepers = [ids[0]], groups = [{ ids, keepers, reason: 'Same subject.' }]) => ({ groups,
  photos: ids.map(id => ({ id, eyes_closed: 'unsure', reason: 'Visible quality assessment.' })) });
const until = async predicate => { for (let i = 0; i < 1000 && !predicate(); i++) await new Promise(r => setTimeout(r, 2)); assert.ok(predicate()); };

const uuid = i => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
async function fixture(work, { count = 4, availability = CURATE_AI_AVAILABILITY, capability = refereeCapability,
  assetId = i => `a${String(i).padStart(2, '0')}`, inline = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-photo-worker-')), path = join(dir, 'enrichment.sqlite');
  let repo, curate, scheduler, now = Date.now();
  const calls = [], downloads = [];
  const config = { enrichEnabled: false, curateBurstGrouping: true, curateStackRefereeEnabled: false, curateKeeperRefereeEnabled: true };
  let answer = (_images, prompt) => response(prompt.jsonSchema.properties.photos.items.properties.id.enum);
  let download = () => ({ data: png, contentType: 'image/png' });
  const provider = { providerName: 'openai_compatible', modelName: 'synthetic', baseUrl: 'http://synthetic/v1', apiKey: 'PRIVATE PROVIDER KEY',
    async analyzeImages(images, prompt) { calls.push({ images, prompt }); return { normalizedOutput: await answer(images, prompt) }; } };
  const immich = { baseUrl: 'http://synthetic', apiKey: 'PRIVATE IMMICH KEY',
    async getAssetThumbnail(id, size, options) { downloads.push({ id, size, options }); return download(id, options); } };
  const initialize = () => {
    repo = new Repository(path); repo.initSchema(); repo.curate.aiLimits.now = () => now;
    // Exercise the in-process rebuild with the same isolated database fixture.
    if (inline) repo.databasePath = ':memory:';
    curate = new CurateService({ repo, config, immich, candidateOptions: { enabled: true, now: () => now }, metadataOptions: { automatic: false } });
    curate.start = () => {};
    scheduler = new AiRequestScheduler();
    const execution = new CurateAiExecution({ attempts: repo.curate.aiAttempts, limits: repo.curate.aiLimits,
      getConfig: () => config, availability, scheduler, stopped: () => curate.closed });
    curate.aiLifecycle = new CurateAiLifecycle({ curate, execution, availability, now: () => now, resolveProvider: () => provider });
    curate.stackReferee = new StackRefereeWorker(curate, { capability });
    curate.photoReferee = new PhotoRefereeWorker(curate, { capability });
  };
  initialize();
  const add = (id, seconds) => { repo.reviewListAdd([id], 'synthetic');
    repo.upsertAsset({ id, fileCreatedAt: new Date(1_700_000_000_000 + seconds * 1000).toISOString() }); };
  for (let i = 0; i < count; i++) add(assetId(i), i);
  const run = async () => { await curate.backgroundTick(); const job = curate.aiLifecycle.active; await job?.work; return job?.result; };
  const close = async () => { await curate.close(); await scheduler.stop(1000); repo.close(); };
  try { await work({ get repo() { return repo; }, get curate() { return curate; }, config, provider, immich, calls, downloads, add, run,
    advance: (ms = AI_SETTLE_MS) => { now += ms; }, set answer(v) { answer = v; }, set download(v) { download = v; },
    get group() { return curate.current.groups.find(g => g.ids.includes(assetId(0))); },
    get advice() { return curate.photoReferee.recommendations(curate.current.groups.find(g => g.ids.includes(assetId(0)))); },
    restart: async ({ refresh = true } = {}) => { await close(); initialize(); if (refresh) await curate.refresh(); },
  }); } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
}

for (const keepers of [[], ['p2'], ['p1', 'p3', 'p4']]) test(`background saves ${keepers.length} recommendations without human mutations and reuses after restart`, async () => fixture(async f => {
  f.answer = () => response(['p1', 'p2', 'p3', 'p4'], keepers);
  await f.run(); assert.equal(f.curate.aiLifecycle.pending.size, 1); assert.equal(f.downloads.length, 0);
  f.advance(); assert.equal((await f.run()).state, 'succeeded');
  assert.deepEqual(f.advice.keeperIds, keepers.map(id => `a0${Number(id.slice(1)) - 1}`));
  assert.equal(f.advice.noneRecommended, keepers.length === 0); assert.equal(f.advice.canApplyAll, true);
  assert.equal(f.advice.checkCoverage, 'off'); assert.equal(f.advice.coverage, 'whole-group');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM asset_tags').get().n, 0);
  assert.ok(f.group.ids.every(id => f.repo.curate.photo(id).state === 'undecided'));
  assert.equal(f.calls.length, 1); assert.equal(f.downloads.length, 4);
  assert.ok(f.downloads.every(d => d.size === 'preview' && d.options.maxBytes <= 2 * 1024 * 1024 && d.options.signal));
  const json = f.repo.db.prepare("SELECT json FROM curate_advice WHERE role='keeper'").get().json;
  assert.doesNotMatch(json, /PRIVATE|http:|base64/);
  assert.ok(Buffer.byteLength(json) < 64 * 1024);
  await f.restart(); await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 1);
  f.provider.modelName = 'another-configured-model'; await f.run(); assert.equal(f.calls.length, 1);
  const page = await f.curate.openView();
  assert.equal(page.groups[0].photoReferee.state, 'complete');
  await f.curate.refereeProgress.refresh();
  assert.equal(f.curate.page(page.viewId).refereeProgress.photo.completed, 1);
  assert.equal(f.curate.page(page.viewId).refereeProgress.photo.remaining, 0);
  const comparison = f.curate.comparison(page.viewId, page.groups[0].id);
  assert.deepEqual(comparison.photoRecommendations.keeperIds, f.advice.keeperIds);
  assert.deepEqual(page.groups[0].photoReferee.suggestion, comparison.photoReferee.suggestion);
  assert.equal(page.groups[0].suggestedCover?.id, f.advice.keeperIds[0]);
  assert.equal(page.groups[0].photos[0].id, f.group.ids[0], 'cover does not alter the chronological anchor');
  if (keepers.length) {
    assert.deepEqual(page.groups[0].photoReferee.suggestion.keeperIds, f.advice.keeperIds);
    assert.equal(typeof page.groups[0].photoReferee.suggestion.key, 'string');
  } else assert.equal(page.groups[0].photoReferee.suggestion, undefined);
  assert.doesNotMatch(JSON.stringify(comparison.photoRecommendations), /requestKey|inputKey|PRIVATE|http:/);
  f.config.curateKeeperRefereeEnabled = false; await f.run(); assert.equal(f.advice.state, 'complete');
}));

async function saveGroup(f, group = f.group) {
  const page = await f.curate.openView();
  const comparison = f.curate.comparison(page.viewId, group.id);
  const operation = await f.curate.issueDecision(comparison.id);
  const { expiresAt, ...input } = operation;
  return f.curate.applyDecision({ ...input, outcomes: Object.fromEntries(group.ids.map((id, i) => [id, i ? 'reviewed' : 'approve'])) });
}

async function undoGroup(f, receipt) {
  const { expiresAt, ...undo } = receipt.undo;
  return f.curate.applyDecision(undo);
}

// Simulate accepted answers saved by the previous prompt, not new provider output.
function legacyGroups(f, groupsForBatch) {
  const row = f.repo.db.prepare("SELECT input_key,json FROM curate_advice WHERE role='keeper'").get();
  const record = JSON.parse(row.json);
  record.photoReferee.answers.forEach((answer, i) => {
    if (!answer) return;
    delete answer.provenance.promptRevision;
    answer.result.groups = groupsForBatch(answer.result.groups.flatMap(g => g.ids), i);
  });
  record.photoReferee.configurationKey = 'legacy-prompt-configuration';
  f.repo.db.prepare("UPDATE curate_advice SET json=? WHERE role='keeper' AND input_key=?").run(JSON.stringify(record), row.input_key);
  f.repo.curate.bump();
}

for (const variant of ['whole', 'legacy-grouped', 'batches', 'stack-checked']) test(`Save then Undo reuses ${variant} Photo Referee advice instead of another provider call`, async () => fixture(async f => {
  if (variant === 'stack-checked') {
    f.config.curateStackRefereeEnabled = true;
    f.answer = (_images, prompt) => prompt.schemaName === PHOTO_REFEREE_CONTRACT ? response(['p1', 'p2', 'p3', 'p4']) :
      { groups: [{ ids: ['p1', 'p2', 'p3', 'p4'], reason: 'Same subject.' }] };
  }
  await f.run(); f.advance(); await f.run();
  await f.run(); f.advance(); await f.run();
  if (variant === 'legacy-grouped') legacyGroups(f, ids => [
    { ids: ids.slice(0, 2), keepers: [ids[1]], reason: 'First subject.' },
    { ids: ids.slice(2), keepers: [ids[2]], reason: 'Second subject.' },
  ]);
  await f.curate.refresh();
  const expected = f.advice, calls = f.calls.length, downloads = f.downloads.length;
  assert.equal(expected.state, 'complete');
  const originalSnapshot = readPhotoRefereeRecord(f.repo.curate, f.group.ids, { subset: true }).photoReferee.snapshot;
  for (let round = 0; round < 2; round++) {
    const receipt = await saveGroup(f);
    await f.curate.refresh();
    if (round === 1) { await f.restart({ refresh: false }); f.config.curateKeeperRefereeEnabled = false; }
    await undoGroup(f, receipt);
    await f.curate.refresh();
    assert.deepEqual(f.advice, expected, 'advice is immediately usable, before any background tick');
    assert.deepEqual(readPhotoRefereeRecord(f.repo.curate, f.group.ids, { subset: true }).photoReferee.snapshot, originalSnapshot,
      'original request snapshot and provenance are immutable');
    await f.run(); f.advance(); await f.run(); await f.restart();
    assert.deepEqual(f.advice, expected);
    assert.equal(f.calls.length, calls, 'Undo must not ask either referee again');
    assert.equal(f.downloads.length, downloads, 'Undo does not redownload previews');
  }
  // Simulate completed synchronization and expired Undo/comparison leases so
  // this assertion tests the advice pin, not an unrelated pending operation.
  f.repo.db.prepare('UPDATE decision_operations SET settled_at=?').run(Date.now());
  f.advance(31 * 60_000); f.curate.aiLifecycle.inputs.prune();
  assert.ok(f.repo.db.prepare('SELECT 1 FROM curate_ai_inputs WHERE input_key=?').get(originalSnapshot.inputKey),
    'accepted advice still protects its original input accounting');
}, { assetId: uuid, count: variant === 'batches' ? 11 : 4 }));

test('Undo leaves advice unrestored if current material is unavailable after checking prior material', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  const receipt = await saveGroup(f), worker = f.curate.photoReferee, inputs = f.curate.aiLifecycle.inputs;
  const material = inputs.material.bind(inputs), restore = worker.restoreAfterUndo.bind(worker);
  let unavailable = 0, completed = false;
  inputs.material = (snapshot, options) => {
    if (options?.checkGroup === false && !options.restoredHuman) { unavailable++; return { state: 'stale' }; }
    return material(snapshot, options);
  };
  worker.restoreAfterUndo = rows => { restore(rows); completed = true; };
  await undoGroup(f, receipt);
  assert.equal(unavailable, 1); assert.equal(completed, true, 'restoration must handle unavailable material without throwing');
  const record = JSON.parse(f.repo.db.prepare("SELECT json FROM curate_advice WHERE role='keeper'").get().json);
  assert.equal(record.photoReferee.restoredMaterial, undefined);
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM asset_tags WHERE tag LIKE 'frame/%'").get().n, 0);
  assert.equal(f.calls.length, 1);
}, { assetId: uuid }));

for (const change of ['source', 'new-member', 'context', 'newer-human']) test(`Undo does not restore stale advice after ${change} changes`, async () => fixture(async f => {
  if (change === 'context') {
    f.add(uuid(10), 0);
    f.repo.recordDecision({ assetIds: [uuid(10)], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  }
  await f.run(); f.advance(); await f.run();
  const receipt = await saveGroup(f);
  if (change === 'source') f.repo.upsertAsset({ id: uuid(0), checksum: 'changed' });
  if (change === 'new-member') f.add(uuid(20), 2);
  if (change === 'context') f.repo.recordDecision({ assetIds: [uuid(10)], addTags: ['frame/never-show'], removeTags: ['frame/eligible'], action: 'reject' });
  if (change === 'newer-human') {
    f.repo.recordDecision({ assetIds: [uuid(0)], addTags: ['frame/favorite'], removeTags: [], action: 'favorite' });
    await assert.rejects(undoGroup(f, receipt), /newer human/);
  } else await undoGroup(f, receipt);
  await f.curate.refresh();
  assert.ok(f.curate.current.groups.every(g => f.curate.photoReferee.recommendations(g) === null));
  assert.equal(f.calls.length, 1);
}, { assetId: uuid }));

test('Save and Undo during inference still reject the in-flight Photo Referee answer', async () => fixture(async f => {
  const deferred = Promise.withResolvers(); f.answer = () => deferred.promise;
  await f.run(); f.advance(); const running = f.run(); await until(() => f.calls.length === 1);
  const receipt = await saveGroup(f);
  await undoGroup(f, receipt); await f.curate.refresh();
  deferred.resolve(response(['p1', 'p2', 'p3', 'p4']));
  assert.equal((await running).state, 'stale');
  assert.equal(f.advice, null);
}, { assetId: uuid }));

test('Undo preserves accepted batches and resumes only the missing Photo Referee batch', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  assert.equal(f.advice.state, 'partial');
  const expected = f.advice;
  const receipt = await saveGroup(f); await undoGroup(f, receipt); await f.curate.refresh();
  assert.deepEqual(f.advice, expected);
  await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(c => c.images.length), [6, 5]);
  assert.equal(f.advice.state, 'complete');
}, { assetId: uuid, count: 11 }));

test('Undo receipts from before advice restoration still restore human choices safely', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  const receipt = await saveGroup(f);
  const row = f.repo.db.prepare('SELECT before_json FROM decision_operations WHERE id=?').get(receipt.operationId);
  const legacy = JSON.parse(row.before_json).map(({ human, ...before }) => before);
  f.repo.db.prepare('UPDATE decision_operations SET before_json=? WHERE id=?').run(JSON.stringify(legacy), receipt.operationId);
  await undoGroup(f, receipt); await f.curate.refresh();
  assert.ok(f.group.ids.every(id => f.repo.curate.photo(id).state === 'undecided'));
  assert.equal(f.advice, null, 'missing historical signatures cannot authorize advice restoration');
}, { assetId: uuid }));

test('production availability requires opt-in, then permits background Photo Referee work independently', async () => fixture(async f => {
  f.config.curateKeeperRefereeEnabled = false;
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
  assert.deepEqual(f.curate.photoReferee.activity(), { state: 'off' });
  f.config.curateKeeperRefereeEnabled = true;
  await f.run(); assert.equal(f.curate.aiLifecycle.pending.size, 1);
  f.advance(); assert.equal((await f.run()).state, 'succeeded');
  assert.equal(f.calls.length, 1); assert.equal(f.advice.state, 'complete');
  assert.equal(f.config.enrichEnabled, false); assert.equal(f.config.curateStackRefereeEnabled, false);
}));

test('thirty photos get three scheduled requests, durable partial progress, and no global partition', async () => fixture(async f => {
  await f.run(); assert.equal(f.curate.aiLifecycle.pending.size, 3);
  f.advance(); assert.equal((await f.run()).state, 'succeeded');
  assert.equal(f.advice.state, 'partial'); assert.equal(f.advice.canApplyAll, false); assert.equal(f.advice.noneRecommended, false);
  assert.equal(f.calls.length, 1); assert.equal(f.downloads.length, 30);
  await f.restart(); await f.run(); f.advance(); assert.equal((await f.run()).state, 'succeeded');
  assert.equal((await f.run()).state, 'succeeded');
  assert.equal(f.calls.length, 3); assert.deepEqual(f.calls.map(c => c.images.length), [10, 10, 10]);
  assert.equal(f.advice.state, 'complete'); assert.equal(f.advice.coverage, 'within-batches');
  assert.equal(f.advice.canApplyAll, true); assert.equal(f.advice.partition, null);
  assert.deepEqual(f.advice.keeperIds, ['a00', 'a10', 'a20']);
  assert.equal(f.curate.current.groups.length, 1, 'transport batches do not become visible stacks');
  assert.equal(f.downloads.length, 90, 'only one batch is retained during each full bounded preflight');
  await f.run(); assert.equal(f.calls.length, 3);
}, { count: 30 }));

test('failed batch does not erase another batch or become a None verdict', async () => fixture(async f => {
  f.answer = (images, prompt) => f.calls.length === 1 ? response(prompt.jsonSchema.properties.photos.items.properties.id.enum, []) : {};
  await f.run(); f.advance(); await f.run(); await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 3); assert.equal(f.advice.state, 'partial'); assert.equal(f.advice.noneRecommended, false);
  assert.equal(f.advice.canApplyAll, false); assert.equal(f.advice.batches[0].status, 'valid');
  assert.equal(f.advice.batches[1].status, 'unavailable');
  assert.equal(f.curate.photoReferee.status(f.group).state, 'incomplete');
  await f.restart(); f.advance(); await f.run(); assert.equal(f.calls.length, 3);
}, { count: 11 }));

test('historical mixed batches stay inspectable/manual without changing stack membership', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); f.advance(); await f.run();
  legacyGroups(f, ids => [{ ids: ids.slice(0, 2), keepers: [ids[0]], reason: 'First subject.' },
    { ids: ids.slice(2), keepers: [ids[2]], reason: 'Second subject.' }]);
  await f.curate.refresh();
  assert.equal(f.advice.state, 'complete'); assert.equal(f.advice.canApplyAll, false); assert.equal(f.advice.partition, null);
  assert.equal(f.advice.keeperIds.length, 4); assert.equal(f.curate.current.groups.length, 1);
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 2);
}, { count: 11 }));

for (const inline of [false, true]) test(`historical Photo Referee groups never split stacks (${inline ? 'inline' : 'worker'} rebuild)`, async () => fixture(async f => {
  const page = await f.curate.openView();
  const original = f.group.ids;
  await f.run(); f.advance(); await f.run();
  legacyGroups(f, ids => [
    { ids: ids.slice(0, 2), keepers: [ids[1]], reason: 'First subject.' },
    { ids: [ids[2]], keepers: [ids[2]], reason: 'Another subject.' },
    { ids: [ids[3]], keepers: [], reason: 'Poor quality.' },
  ]);
  await f.curate.refresh();
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), [original]);
  const next = await f.curate.openView();
  assert.equal(next.groups.length, 1); assert.equal(next.groups[0].memberCount, 4);
  assert.equal(f.curate.page(page.viewId).groups[0].memberCount, 4);
  assert.deepEqual(f.advice.keeperIds, ['a01', 'a02']);
  assert.equal(f.advice.partition, null);
  assert.equal(f.group.photoPartition, undefined);
  if (!inline) await f.restart();
  await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 1, 'accepted advice does not get replayed for the prompt change');
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), [original]);
  f.config.curateStackRefereeEnabled = true; f.config.curateStackRefereeScope = 'all';
  assert.equal(f.curate.stackReferee.selection(f.group).selected, true, 'Photo Referee cannot bypass Stack Referee');
  assert.equal(f.advice.canApplyAll, false, 'newly enabled Stack Referee must settle before suggestions apply');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM asset_tags').get().n, 0);
}, { inline }));

test('valid grouped replies across four stacks preserve recommendations without splitting or pausing the role', async () => fixture(async f => {
  for (let stack = 1; stack <= 3; stack++) for (let i = 0; i < 6; i++) f.add(`b${stack}-${i}`, stack * 600 + i);
  f.answer = (_images, prompt) => {
    const ids = prompt.jsonSchema.properties.photos.items.properties.id.enum;
    return response(ids, [], [
      { ids: ids.slice(0, 3), keepers: [ids[0]], reason: 'First recommendation.' },
      { ids: ids.slice(3), keepers: [ids[3]], reason: 'Another recommendation.' },
    ]);
  };
  await f.run();
  const original = f.curate.current.groups.map(g => g.ids);
  f.advance(); for (let i = 0; i < 4; i++) assert.equal((await f.run()).state, 'succeeded');
  assert.equal(f.calls.length, 4); assert.equal(f.curate.photoReferee.modelReady(), true);
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_meta WHERE key GLOB 'photo-model-failure:*'").get().n, 0);
  await f.restart(); await f.run(); f.advance(); await f.run();
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), original);
  assert.equal(f.calls.length, 4, 'accepted advice is reused after restart');
  for (const g of f.curate.current.groups) {
    assert.equal(g.ids.length, 6);
    const advice = f.curate.photoReferee.recommendations(g);
    assert.equal(advice.canApplyAll, true); assert.equal(advice.partition, null);
    assert.deepEqual(advice.keeperIds, [g.ids[0], g.ids[3]]);
  }
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM asset_tags').get().n, 0);
}, { count: 6 }));

test('incomplete historical comparisons do not mix old and new prompt batches', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  legacyGroups(f, ids => [{ ids, keepers: [ids[0]], reason: 'Saved older advice.' }]);
  await f.restart(); f.advance(); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.advice.state, 'partial');
  assert.equal(f.curate.photoReferee.status(f.group).reason, 'comparison-changed');
}, { count: 11 }));

test('deterministic work and enabled Stack Referee must settle before Photo Referee discovery', async () => fixture(async f => {
  await f.curate.refresh();
  f.curate.refinement.groupStatus = () => ({ state: 'checking' });
  await f.curate.photoReferee.discover(); assert.equal(f.curate.aiLifecycle.pending.size, 0);
  f.curate.refinement.groupStatus = () => ({ state: 'checked' }); f.config.curateStackRefereeEnabled = true;
  for (const check of [{ state: 'waiting' }, { state: 'checking' }, { state: 'updated' },
    { state: 'paused', scope: 'configuration' }, { state: 'incomplete', reason: 'unknown-capability', scope: 'configuration' }]) {
    f.curate.stackReferee.status = () => check;
    await f.curate.photoReferee.discover(); assert.equal(f.curate.aiLifecycle.pending.size, 0);
  }
  f.curate.stackReferee.status = () => ({ state: 'checked' });
  await f.curate.photoReferee.discover(); assert.equal(f.curate.aiLifecycle.pending.size, 1);
  f.advance(); f.curate.aiLifecycle.tick(); await f.curate.aiLifecycle.active?.work;
  assert.equal(f.advice.checkCoverage, 'checked');
}));

for (const [check, coverage] of [
  [{ state: 'skipped', reason: 'supported-by-grouping' }, 'scope-skipped'],
  [{ state: 'incomplete', reason: 'invalid-answer' }, 'incomplete'],
  [{ state: 'incomplete', reason: 'unsupported-size' }, 'unchecked-size'],
]) test(`eligible advice retains ${coverage} check coverage`, async () => fixture(async f => {
  await f.curate.refresh(); f.config.curateStackRefereeEnabled = true;
  f.curate.stackReferee.status = () => check; f.curate.stackReferee.discover = async () => {};
  await f.run(); f.advance(); await f.run(); if (coverage === 'unchecked-size') await f.run();
  assert.equal(f.advice.checkCoverage, coverage);
}, { count: coverage === 'unchecked-size' ? 11 : 4 }));

test('an unsupported-size label alone cannot bypass the enabled Stack Referee', async () => fixture(async f => {
  await f.curate.refresh(); f.config.curateStackRefereeEnabled = true;
  f.curate.stackReferee.status = () => ({ state: 'incomplete', reason: 'unsupported-size' });
  assert.equal(f.curate.photoReferee.gate(f.group).state, 'paused');
  await f.curate.photoReferee.discover(); assert.equal(f.curate.aiLifecycle.pending.size, 0);
}));

for (const change of ['decision', 'addition', 'connection']) test(`${change} during inference invalidates the whole answer`, async () => fixture(async f => {
  const deferred = Promise.withResolvers(); f.answer = () => deferred.promise;
  await f.run(); f.advance(); const running = f.run(); await until(() => f.calls.length === 1);
  if (change === 'decision') f.repo.recordDecision({ assetIds: ['a00'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  if (change === 'addition') f.add('new', 2);
  if (change === 'connection') f.immich.apiKey = 'ANOTHER PRIVATE KEY';
  deferred.resolve(response(['p1', 'p2', 'p3', 'p4']));
  assert.equal((await running).state, 'stale');
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_advice WHERE role='keeper'").get().n, 0);
}));

test('turning Photo Referee off preserves an already-paid valid answer but prevents subsequent batches', async () => fixture(async f => {
  const deferred = Promise.withResolvers(); f.answer = () => deferred.promise;
  await f.run(); f.advance(); const running = f.run(); await until(() => f.calls.length === 1);
  f.config.curateKeeperRefereeEnabled = false;
  deferred.resolve(response(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']));
  assert.equal((await running).state, 'succeeded');
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.advice.state, 'partial');
}, { count: 11 }));

test('later human decisions invalidate stored recommendations without changing their chosen tags', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  f.repo.recordDecision({ assetIds: ['a00'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  assert.equal(f.advice, null);
  await f.curate.refresh(); const page = await f.curate.openView({ section: 'decided' });
  assert.equal(page.groups[0].photoReferee, null);
  assert.equal(f.curate.comparison(page.viewId, page.groups[0].id).photoRecommendations, null);
}));

test('partial results from a different provider configuration remain inspectable without automatic replay', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); f.provider.modelName = 'changed';
  await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.advice.state, 'partial');
  assert.equal(f.curate.photoReferee.status(f.group).reason, 'comparison-changed');
  await f.restart(); f.advance(); await f.run(); assert.equal(f.calls.length, 1);
}, { count: 11 }));

test('same-size changed rendition cannot be combined with a previous batch', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  f.download = () => ({ data: Buffer.alloc(png.length, 1), contentType: 'image/png' });
  assert.equal((await f.run()).reason, 'preparation-failed');
  assert.equal(f.calls.length, 1); assert.equal(f.advice.state, 'partial');
  assert.equal(f.curate.photoReferee.status(f.group).reason, 'comparison-changed');
  await f.restart(); f.advance(); await f.run(); assert.equal(f.calls.length, 1);
}, { count: 11 }));

test('transient preview failures have two bounded attempts and a durable shared pause', async () => fixture(async f => {
  f.download = () => { throw new ImmichApiError('PRIVATE ERROR', 503); };
  await f.run(); f.advance(); await f.run(); assert.equal(f.downloads.length, 1);
  assert.equal(f.curate.photoReferee.activity().reason, 'preview-cooldown');
  await f.restart(); f.advance(); await f.run(); assert.equal(f.downloads.length, 1);
  f.advance(PHOTO_PREVIEW_PAUSE_MS); await f.run(); f.advance(); await f.run(); assert.equal(f.downloads.length, 2);
  f.advance(PHOTO_PREVIEW_PAUSE_MS); await f.run(); f.advance(); await f.run(); assert.equal(f.downloads.length, 2);
  assert.equal(f.calls.length, 0); assert.equal(f.advice, null);
  assert.equal(f.curate.photoReferee.status(f.group).reason, 'preparation-failed');
  f.curate.refereeProgress.invalidate(); await f.curate.refereeProgress.refresh();
  assert.equal(f.curate.refereeProgress.status().photo.incomplete, 1);
  assert.equal(f.curate.refereeProgress.status().photo.remaining, 0, 'exhausted preview attempts leave progress');
}));

for (const type of ['oversize', 'mime', 'missing']) test(`${type} preview settles without automatic rediscovery`, async () => fixture(async f => {
  f.download = () => {
    if (type === 'missing') throw new ImmichApiError('PRIVATE ERROR', 404);
    return { data: type === 'oversize' ? Buffer.alloc(2 * 1024 * 1024 + 1) : png, contentType: type === 'mime' ? 'image/heic' : 'image/png' };
  };
  await f.run(); f.advance(); await f.run(); await f.restart(); f.advance(); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 1); assert.equal(f.advice, null);
}));

test('aggregate preview budget is checked before the first paid request', async () => fixture(async f => {
  f.download = () => ({ data: Buffer.alloc(2 * 1024 * 1024), contentType: 'image/jpeg' });
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 12);
  assert.equal(f.advice, null);
}, { count: 30 }));

test('three distinct rejected comparisons pause Photo Referee while leaving Stack Referee independent', async () => fixture(async f => {
  for (let i = 1; i <= 6; i++) { f.add(`b${i}`, i * 600); f.add(`c${i}`, i * 600 + 1); }
  f.answer = () => { throw new ProviderRequestError('PRIVATE MODEL ERROR', { status: 400 }); };
  await f.run(); f.advance(); for (let i = 0; i < 3; i++) await f.run();
  assert.equal(f.calls.length, 3); assert.equal(f.curate.photoReferee.activity().reason, 'model-failures');
  assert.equal(f.curate.stackReferee.modelReady(), true);
  await f.restart(); f.advance(); await f.run(); assert.equal(f.calls.length, 3);
}));

test('bad batches of one comparison cannot count as three distinct model failures', async () => fixture(async f => {
  f.answer = () => ({});
  await f.run(); f.advance(); for (let i = 0; i < 3; i++) await f.run();
  assert.equal(f.calls.length, 3); assert.equal(f.curate.photoReferee.modelReady(), true);
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_meta WHERE key GLOB 'photo-model-failure:*'").get().n, 1);
}, { count: 30 }));

test('selected whole-stack context is never recommended, charged, or overwritten', async () => fixture(async f => {
  f.add('kept', 0);
  f.repo.recordDecision({ assetIds: ['kept'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  await f.run(); f.advance(); await f.run(); await f.run();
  assert.deepEqual(f.calls.map(c => c.images.length), [9]);
  assert.equal(f.advice.keeperIds.includes('kept'), false);
  assert.equal(f.repo.curate.photo('kept').state, 'approved');
  const record = readPhotoRefereeRecord(f.repo.curate, f.group.ids);
  assert.deepEqual(record.photoReferee.plan.contextIds, ['kept']);
  assert.equal(record.photoReferee.plan.submittedImages, 9);
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_advice_members WHERE asset_id='kept'").get().n, 0);
  await f.curate.refresh();
  const snapshot = f.curate.photoReferee.capture(f.group);
  assert.deepEqual(snapshot.snapshot.contextIds, ['kept']);
}, { count: 8 }));

test('thirty pending photos omit nearby context and retain three complete comparisons', async () => fixture(async f => {
  f.add('kept', 0);
  f.repo.recordDecision({ assetIds: ['kept'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  await f.curate.refresh();
  const capture = f.curate.photoReferee.capture(f.group, f.group.ids.slice(0, 10));
  assert.equal(capture.state, 'captured'); assert.deepEqual(capture.snapshot.contextIds, []);
  await f.run(); f.advance(); await f.run(); await f.run(); await f.run();
  assert.deepEqual(f.calls.map(c => c.images.length), [10, 10, 10]);
  assert.equal(f.advice.state, 'complete');
  assert.equal(f.downloads.some(d => d.id === 'kept'), false);
}, { count: 30 }));

test('no submission while focused, and role-off during preflight stops before inference', async () => fixture(async f => {
  await f.curate.refresh(); f.curate.refinement.isFocused = () => true;
  await f.run(); f.advance(); await f.run(); assert.equal(f.downloads.length, 0);
  f.curate.refinement.isFocused = () => false;
  f.download = () => { f.config.curateKeeperRefereeEnabled = false; return { data: png, contentType: 'image/png' }; };
  await f.run(); f.advance(); assert.equal((await f.run()).state, 'disabled');
  assert.equal(f.downloads.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.advice, null);
}));

test('late Stack Referee work blocks queued Photo Referee preparation and in-flight acceptance', async () => fixture(async f => {
  await f.run(); f.advance(); f.config.curateStackRefereeEnabled = true;
  f.curate.stackReferee.discover = async () => {};
  f.curate.stackReferee.status = () => ({ state: 'waiting' });
  await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
  f.curate.stackReferee.status = () => ({ state: 'checked' });
  const deferred = Promise.withResolvers(); f.answer = () => deferred.promise;
  const running = f.run(); await until(() => f.calls.length === 1);
  f.curate.stackReferee.status = () => ({ state: 'waiting' });
  deferred.resolve(response(['p1', 'p2', 'p3', 'p4']));
  assert.equal((await running).state, 'stale'); assert.equal(f.advice, null);
}));

test('a newly pending check disables application of earlier recommendations', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); assert.equal(f.advice.canApplyAll, true);
  assert.ok(f.curate.photoReferee.status(f.group).suggestion);
  f.config.curateStackRefereeEnabled = true;
  f.curate.stackReferee.status = () => ({ state: 'waiting' });
  assert.equal(f.advice.canApplyAll, false); assert.equal(f.advice.keeperIds.length, 1);
  assert.equal(f.curate.photoReferee.status(f.group).suggestion, undefined);
}));

test('actual Stack Referee partitions feed Photo Referee only after publication, with no calls for singles', async () => fixture(async f => {
  f.config.curateStackRefereeEnabled = true;
  f.answer = (_images, prompt) => prompt.schemaName === PHOTO_REFEREE_CONTRACT ? response(['p1', 'p2']) :
    { groups: [{ ids: ['p1', 'p3'], reason: 'Same subject.' }, { ids: ['p2'], reason: 'Another subject.' },
      { ids: ['p4'], reason: 'Separate composition.' }] };
  await f.run(); assert.equal(f.curate.aiLifecycle.pending.size, 1);
  f.advance(); await f.run(); assert.equal(f.calls.length, 1);
  assert.notEqual(f.calls[0].prompt.schemaName, PHOTO_REFEREE_CONTRACT);
  await f.run(); assert.deepEqual(f.group.ids, ['a00', 'a02']);
  f.advance(); await f.run(); assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].prompt.schemaName, PHOTO_REFEREE_CONTRACT);
  assert.equal(f.advice.checkCoverage, 'checked'); assert.deepEqual(f.advice.keeperIds, ['a00']);
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 2);
}));

test('provider authentication pause blocks every remaining batch before downloads', async () => fixture(async f => {
  f.answer = () => { throw new ProviderRequestError('PRIVATE AUTH ERROR', { status: 401 }); };
  await f.run(); f.advance(); await f.run(); const fetched = f.downloads.length;
  f.advance(); await f.run(); await f.restart(); f.advance(); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.downloads.length, fetched);
  assert.equal(f.curate.photoReferee.activity().reason, 'provider-auth');
  assert.equal(f.advice, null);
}, { count: 11 }));

test('unknown model capability neither downloads nor blocks discovery of future configured work', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); assert.equal(f.downloads.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.curate.photoReferee.activity().reason, 'unknown-capability');
  f.curate.photoReferee.capability = refereeCapability;
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 1);
}, { capability: () => null }));

test('shared approved context does not replace another stack’s record or consume photo charges', async () => fixture(async f => {
  f.add('b0', 100); f.add('b1', 101); f.add('kept', 0);
  f.repo.recordDecision({ assetIds: ['kept'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  f.answer = (_images, prompt) => response(prompt.jsonSchema.properties.photos.items.properties.id.enum);
  await f.run(); f.advance(); await f.run(); await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_advice WHERE role='keeper'").get().n, 2);
  assert.equal(f.advice.state, 'complete');
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_ai_photo_charges WHERE role='keeper'").get().n, 6,
    'only the six pending photos are charged; shared read-only context is exempt');
}));

for (const [count, expectedBatches, expectedReferences] of [
  [6, [6], 2], [8, [8], 2], [9, [9], 1], [10, [10], 0],
  [11, [6, 5], 0], [15, [8, 7], 0], [20, [10, 10], 0], [30, [10, 10, 10], 0],
]) test(`${count} pending photos keep their comparison coverage after eight nearby photos are approved`, async () => fixture(async f => {
  const references = Array.from({ length: 8 }, (_, i) => `kept${i}`);
  for (let i = 0; i < references.length; i++) f.add(references[i], -100 + i);
  f.repo.recordDecision({ assetIds: references, addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  const selected = [...references].reverse().slice(0, expectedReferences);
  f.download = id => {
    assert.ok(!references.includes(id) || selected.includes(id), 'omitted reference previews must not be fetched');
    return { data: png, contentType: 'image/png' };
  };
  await f.run(); assert.equal(f.curate.aiLifecycle.pending.size, expectedBatches.length);
  assert.ok([...f.curate.aiLifecycle.pending.values()].every(job =>
    JSON.stringify(job.snapshot.contextIds) === JSON.stringify(selected)), 'lifecycle charges and validates only selected context');
  f.advance();
  for (const _ of expectedBatches) assert.equal((await f.run()).state, 'succeeded');
  const record = readPhotoRefereeRecord(f.repo.curate, f.group.ids), plan = record.photoReferee.plan;
  assert.deepEqual(plan.requests.map(r => r.ids.length), expectedBatches);
  assert.deepEqual(plan.contextIds, selected); assert.deepEqual(record.photoReferee.snapshot.contextIds, selected);
  assert.deepEqual(f.calls.map(c => c.images.length), expectedBatches.map(n => n + expectedReferences));
  assert.deepEqual(f.calls.map(c => c.prompt.jsonSchema.properties.groups.items.properties.keepers.items.enum.length), expectedBatches);
  assert.equal(f.advice.state, 'complete'); assert.equal(f.advice.wholeGroupCompared, expectedBatches.length === 1);
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_ai_photo_charges WHERE role='keeper'").get().n, count);
  assert.ok(references.every(id => f.repo.curate.photo(id).state === 'approved'));
  const calls = f.calls.length;
  await f.restart(); await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, calls, 'restart reuses the plan with selected context');
}, { count }));

test('changes to a selected reference during inference still invalidate the paid answer', async () => fixture(async f => {
  f.add('kept', -10);
  f.repo.recordDecision({ assetIds: ['kept'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  const deferred = Promise.withResolvers(); f.answer = () => deferred.promise;
  await f.run(); f.advance(); const running = f.run(); await until(() => f.calls.length === 1);
  assert.equal(f.calls[0].images.length, 9);
  f.repo.upsertAsset({ id: 'kept', fileCreatedAt: new Date(1_700_000_000_000 - 10_000).toISOString(), checksum: 'changed' });
  deferred.resolve(response(Array.from({ length: 9 }, (_, i) => `p${i + 1}`)));
  assert.equal((await running).state, 'stale'); assert.equal(f.advice, null);
}, { count: 8 }));

test('invalid provider configuration still reports one configuration pause before reference capture', async () => fixture(async f => {
  await f.curate.refresh();
  f.curate.aiLifecycle.resolveProvider = () => { throw new Error('PRIVATE CONFIGURATION ERROR'); };
  assert.deepEqual(f.curate.photoReferee.status(f.group), { state: 'paused', reason: 'configuration', scope: 'configuration' });
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
}));

for (const change of ['new-member', 'source', 'context', 'decision']) test(`historical grouped advice rejects changed ${change} inputs`, async () => fixture(async f => {
  if (change === 'context') {
    f.add('reference', -10);
    f.repo.recordDecision({ assetIds: ['reference'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  }
  await f.run(); f.advance(); await f.run();
  legacyGroups(f, ids => [{ ids: [ids[0], ids[1], ...ids.slice(4)], keepers: [ids[0]], reason: 'First subject.' },
    { ids: [ids[2], ids[3]], keepers: [ids[2]], reason: 'Second subject.' }]);
  await f.curate.refresh();
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), [['a00', 'a01', 'a02', 'a03']]);
  assert.deepEqual(f.advice.keeperIds, ['a00', 'a02']);
  if (change === 'new-member') f.add('new', 2);
  if (change === 'source') f.repo.upsertAsset({ id: 'a02', checksum: 'changed' });
  if (change === 'context') f.repo.recordDecision({ assetIds: ['reference'], addTags: ['frame/never-show'], removeTags: ['frame/eligible'], action: 'reject' });
  if (change === 'decision') f.repo.recordDecision({ assetIds: ['a00'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  assert.equal(f.advice, null);
  await f.curate.refresh();
  assert.ok(f.curate.current.groups.every(g => f.curate.photoReferee.recommendations(g) === null));
  assert.ok(f.curate.current.groups.every(g => !g.photoPartition));
}));

test('a separate read-only reference subject does not split or relabel the pending comparison', async () => fixture(async f => {
  f.add('reference', -10);
  f.repo.recordDecision({ assetIds: ['reference'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  f.answer = () => response(['p1', 'p2', 'p3', 'p4', 'p5'], ['p3']);
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  assert.equal(f.curate.current.groups.length, 1); assert.equal(f.group.photoPartition, undefined);
  assert.deepEqual(f.advice.keeperIds, ['a02']);
  assert.ok(f.advice.batches[0].assessments.every(p => p.id !== 'reference'));
}));
