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

async function fixture(work, { count = 4, availability = { stack: true, keeper: true }, capability = refereeCapability } = {}) {
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
  for (let i = 0; i < count; i++) add(`a${String(i).padStart(2, '0')}`, i);
  const run = async () => { await curate.backgroundTick(); const job = curate.aiLifecycle.active; await job?.work; return job?.result; };
  const close = async () => { await curate.close(); await scheduler.stop(1000); repo.close(); };
  try { await work({ get repo() { return repo; }, get curate() { return curate; }, config, provider, immich, calls, downloads, add, run,
    advance: (ms = AI_SETTLE_MS) => { now += ms; }, set answer(v) { answer = v; }, set download(v) { download = v; },
    get group() { return curate.current.groups.find(g => g.ids.includes('a00')); },
    get advice() { return curate.photoReferee.recommendations(curate.current.groups.find(g => g.ids.includes('a00'))); },
    restart: async () => { await close(); initialize(); await curate.refresh(); },
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
  const comparison = f.curate.comparison(page.viewId, page.groups[0].id);
  assert.deepEqual(comparison.photoRecommendations.keeperIds, f.advice.keeperIds);
  assert.doesNotMatch(JSON.stringify(comparison.photoRecommendations), /requestKey|inputKey|PRIVATE|synthetic/);
  f.config.curateKeeperRefereeEnabled = false; await f.run(); assert.equal(f.advice.state, 'complete');
}));

test('default server availability keeps the connected worker inert', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
  assert.deepEqual(f.curate.photoReferee.activity(), { state: 'off' });
}, { availability: CURATE_AI_AVAILABILITY }));

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

test('mixed batch withholds global application and does not schedule a tournament or recursive check', async () => fixture(async f => {
  f.answer = (_images, prompt) => {
    const ids = prompt.jsonSchema.properties.photos.items.properties.id.enum;
    return response(ids, [], [{ ids: ids.slice(0, 2), keepers: [ids[0]], reason: 'First subject.' },
      { ids: ids.slice(2), keepers: [ids[2]], reason: 'Second subject.' }]);
  };
  await f.run(); f.advance(); await f.run(); await f.run();
  assert.equal(f.advice.state, 'complete'); assert.equal(f.advice.canApplyAll, false); assert.equal(f.advice.partition, null);
  assert.equal(f.advice.keeperIds.length, 4);
  await f.run(); f.advance(); await f.run(); assert.equal(f.calls.length, 2);
}, { count: 11 }));

test('whole-input mixed recommendations are retained for the later stable-view/UI integration', async () => fixture(async f => {
  f.answer = () => response(['p1', 'p2', 'p3', 'p4'], [], [
    { ids: ['p1', 'p3'], keepers: ['p3'], reason: 'First subject.' },
    { ids: ['p2', 'p4'], keepers: ['p2', 'p4'], reason: 'Second subject.' },
  ]);
  const page = await f.curate.openView();
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  assert.deepEqual(f.advice.partition.map(g => g.ids), [['a00', 'a02'], ['a01', 'a03']]);
  assert.equal(f.curate.page(page.viewId).groups[0].memberCount, 4);
  assert.equal(f.curate.page(page.viewId).updatesAvailable, true);
  assert.equal(f.curate.current.groups.length, 1, 'publishing Photo Referee splits is intentionally not activated in this backend increment');
}));

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

test('approved context is repeated but never recommended, charged, or overwritten', async () => fixture(async f => {
  f.add('kept', 0);
  f.repo.recordDecision({ assetIds: ['kept'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  await f.run(); f.advance(); await f.run(); await f.run();
  assert.deepEqual(f.calls.map(c => c.images.length), [7, 6]);
  assert.equal(f.advice.keeperIds.includes('kept'), false);
  assert.equal(f.repo.curate.photo('kept').state, 'approved');
  const record = readPhotoRefereeRecord(f.repo.curate, f.group.ids);
  assert.deepEqual(record.photoReferee.plan.contextIds, ['kept']);
  assert.equal(record.photoReferee.plan.submittedImages, 13);
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_advice_members WHERE asset_id='kept'").get().n, 0);
  await f.curate.refresh();
  const snapshot = f.curate.aiLifecycle.inputs.capture({ role: 'keeper', groupId: f.group.id, contract: PHOTO_REFEREE_CONTRACT, photoIds: ['a00', 'a01'], includeContext: true });
  assert.deepEqual(snapshot.snapshot.contextIds, ['kept']);
}, { count: 11 }));

test('context cannot be silently dropped to fit a full comparison, regardless of individual batch length', async () => fixture(async f => {
  f.add('kept', 0);
  f.repo.recordDecision({ assetIds: ['kept'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  await f.curate.refresh();
  const capture = f.curate.aiLifecycle.inputs.capture({ role: 'keeper', groupId: f.group.id, contract: PHOTO_REFEREE_CONTRACT,
    photoIds: f.group.ids.slice(0, 10), includeContext: true });
  assert.deepEqual(capture, { state: 'input-limit', reason: 'too-many-images', limit: 30 });
  await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
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
  f.config.curateStackRefereeEnabled = true;
  f.curate.stackReferee.status = () => ({ state: 'waiting' });
  assert.equal(f.advice.canApplyAll, false); assert.equal(f.advice.keeperIds.length, 1);
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
