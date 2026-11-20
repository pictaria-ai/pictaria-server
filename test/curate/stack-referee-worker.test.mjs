import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { CurateAiLifecycle, AI_SETTLE_MS } from '../../src/curate/ai-lifecycle.mjs';
import { StackRefereeWorker, STACK_PREVIEW_PAUSE_MS, STACK_MODEL_FAILURE_LIMIT } from '../../src/curate/stack-referee-worker.mjs';
import { CURATE_AI_AVAILABILITY } from '../../src/curate/ai-policy.mjs';
import { refereeCapability } from '../../src/curate/referee-capabilities.mjs';
import { AiRequestScheduler } from '../../src/ai/scheduler.mjs';
import { ImmichClient, ImmichApiError } from '../../src/immich.mjs';
import { ResponseTooLargeError } from '../../src/fetchWithTimeout.mjs';
import { stackRefereeImages } from '../../src/curate/stack-referee-images.mjs';
import { aiBackendKey } from '../../src/curate/ai-limits.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';
import { stackStatus } from '../../public/curate/stack-status.js';
import { evidenceRows } from '../../public/curate/explanation-copy.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const partition = (...groups) => ({ groups: groups.map(ids => ({ ids, reason: 'Same subject and composition.' })) });
const deferred = () => Promise.withResolvers();

async function fixture(work, { count = 4, capability = true, availability } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-stack-worker-')), path = join(dir, 'enrichment.sqlite');
  let now = Date.now(), repo, curate, scheduler;
  const downloads = [], calls = [];
  const config = { enrichEnabled: false, curateBurstGrouping: true, curateStackRefereeEnabled: true, curateKeeperRefereeEnabled: false };
  let answer = partition(['p1', 'p3'], ['p2', 'p4']);
  let download = () => ({ data: png, contentType: 'image/png' });
  const provider = { providerName: 'openai_compatible', modelName: 'synthetic', baseUrl: 'http://synthetic/v1', apiKey: 'PRIVATE PROVIDER KEY',
    async analyzeImages(images, options) { calls.push({ images, options }); return { normalizedOutput: await answer }; } };
  let cap = capability ? { provider: provider.providerName, model: provider.modelName, comparative: true, maxImages: 30 } : null;
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
    curate.stackReferee = new StackRefereeWorker(curate, { capability: typeof capability === 'function' ? capability : () => cap });
  };
  initialize();
  const add = (id, seconds) => { repo.reviewListAdd([id], 'synthetic');
    repo.upsertAsset({ id, fileCreatedAt: new Date(1_700_000_000_000 + seconds * 1000).toISOString() }); };
  for (let i = 0; i < count; i++) add(`a${i}`, i);
  const run = async () => {
    await curate.backgroundTick();
    const job = curate.aiLifecycle.active;
    await job?.work;
    return job?.result;
  };
  const close = async () => { await curate.close(); await scheduler.stop(1000); repo.close(); };
  try { await work({ get repo() { return repo; }, get curate() { return curate; }, config, provider, immich, downloads, calls, add, run,
    advance: (ms = AI_SETTLE_MS) => { now += ms; },
    get cap() { return cap; }, set cap(v) { cap = v; },
    set answer(v) { answer = v; }, set download(v) { download = v; },
    restart: async () => { await close(); initialize(); await curate.refresh(); },
  }); } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
}

test('background worker checks without browser demand or Enrich, publishes non-contiguous splits, and reuses them after restart', async () => fixture(async f => {
  await f.run(); assert.equal(f.curate.aiLifecycle.pending.size, 1);
  f.advance(); assert.equal((await f.run()).state, 'succeeded');
  assert.equal(f.curate.stackReferee.status(f.curate.current.groups[0]).state, 'updated',
    'an accepted check awaiting publication is not an incomplete check');
  await f.curate.refresh();
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), [['a0', 'a2'], ['a1', 'a3']]);
  assert.ok(f.curate.current.groups.every(g => g.stackCheck.state === 'checked'));
  // The page names the split; the model's reason stays with the check, out of the recorded codes.
  assert.ok(f.curate.current.groups.every(g => g.stackCheck.split === true && g.stackCheck.reason === 'Same subject and composition.'));
  assert.ok(f.curate.current.groups.every(g => !g.reasons.includes('Same subject and composition.')));
  assert.equal(f.calls.length, 1); assert.equal(f.downloads.length, 4);
  assert.ok(f.downloads.every(d => d.size === 'preview' && d.options.maxBytes <= 2 * 1024 * 1024 && d.options.signal));
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM asset_tags").get().n, 0);
  const advice = f.repo.db.prepare('SELECT json FROM curate_advice').get().json;
  assert.doesNotMatch(advice, /PRIVATE|http:|base64/);
  assert.equal(JSON.parse(advice).stackCheck.provenance.renditions.length, 4);
  await f.restart(); await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 1, 'split children are not sent recursively or after restart');
  const page = await f.curate.openView();
  assert.ok(page.groups.every(g => g.stackReferee.state === 'checked'));
  f.config.curateStackRefereeEnabled = false; await f.curate.refresh();
  assert.equal(f.curate.current.groups.length, 2, 'disabling the role retains accepted composition');
}));

test('a paid result arriving while the comparison is open never changes its membership or selections', async () => fixture(async f => {
  const response = deferred(); f.answer = response.promise;
  await f.run(); f.advance();
  const running = f.run();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  const view = await f.curate.openView(), id = view.groups[0].id;
  assert.equal(f.curate.comparison(view.viewId, id).ids.length, 4);
  response.resolve(partition(['p1', 'p3'], ['p2', 'p4']));
  assert.equal((await running).state, 'succeeded'); await f.curate.refresh();
  assert.equal(f.curate.comparison(view.viewId, id).ids.length, 4);
  assert.equal(f.curate.page(view.viewId).groups[0].memberCount, 4);
  assert.equal(f.curate.page(view.viewId).updatesAvailable, true);
  assert.equal((await f.curate.openView()).groups.length, 2);
}));

test('open comparisons defer requests, and upcoming comparisons receive priority', async () => fixture(async f => {
  f.add('b0', 600); f.add('b1', 601);
  await f.curate.refresh();
  // Synthetic settled similarity isolates AI priority from search scheduling;
  // the real attention/priorities and current-group mapping are exercised.
  f.curate.refinement.enabled = () => true;
  f.curate.refinement.groupStatus = () => ({ state: 'checked', uncertain: true });
  const view = await f.curate.openView();
  f.curate.refinement.views.set(view.viewId, { touched: Date.now(), attentionAt: Date.now(), focus: 'a0', next: ['b0'], visible: [] });
  await f.curate.stackReferee.discover();
  assert.equal(f.curate.aiLifecycle.pending.size, 1);
  const queued = [...f.curate.aiLifecycle.pending.values()][0];
  assert.deepEqual(queued.snapshot.ids, ['b0', 'b1']); assert.equal(queued.plan.priority, true);
}));

test('one initial call plus one retry settles malformed partitions and never repeats on discovery or restart', async () => fixture(async f => {
  f.answer = partition(['p1', 'p2'], ['p2', 'p3', 'p4']);
  await f.run(); f.advance(); assert.equal((await f.run()).reason, 'invalid-answer');
  f.advance(); assert.equal((await f.run()).reason, 'invalid-answer');
  assert.equal(f.calls.length, 2); assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_advice').get().n, 0);
  assert.equal(f.curate.stackReferee.status(f.curate.current.groups[0]).reason, 'invalid-answer');
  await f.restart(); f.advance(); await f.run(); assert.equal(f.calls.length, 2);
}));

for (const failure of ['provider-rejected', 'invalid-answer'])
  test(`${failure} across distinct stacks pauses a whole backlog before queued requests and retries drain`, async () => fixture(async f => {
    for (let i = 0; i < 40; i++) { f.add(`b${i}`, i * 600); f.add(`c${i}`, i * 600 + 1); }
    if (failure === 'provider-rejected') f.provider.analyzeImages = async () => {
      f.calls.push('rejected'); throw new ProviderRequestError('PRIVATE MODEL ERROR', { status: 400 });
    };
    else f.answer = partition(['p1'], ['p1', 'p2']);
    await f.run(); f.advance();
    for (let i = 0; i < STACK_MODEL_FAILURE_LIMIT; i++) assert.equal((await f.run()).reason, failure);
    assert.ok(f.curate.aiLifecycle.pending.size <= 1, 'paused Stack Referee releases the shared queue slots');
    assert.equal(f.curate.stackReferee.activity().reason, 'model-failures');
    const untouched = f.curate.current.byMember.get('b39');
    assert.deepEqual(f.curate.stackReferee.status(untouched), { state: 'paused', reason: 'model-failures', scope: 'configuration' });
    for (let i = 0; i < 5; i++) { f.advance(24 * 60 * 60_000); await f.run(); }
    assert.equal(f.calls.length, 3); assert.equal(f.downloads.length, 6, 'no preparation while paused');
    const markers = () => f.repo.db.prepare("SELECT key,value FROM curate_meta WHERE key GLOB 'stack-model-failure:*'").all();
    assert.equal(markers().length, 3);
    assert.ok(markers().every(row => /^stack-model-failure:[a-f0-9]{64}:[a-f0-9]{64}$/.test(row.key) && row.value === 1));
    assert.doesNotMatch(JSON.stringify(markers()), /PRIVATE|synthetic|http/);
    f.config.curateStackRefereeEnabled = false; await f.run();
    f.config.curateStackRefereeEnabled = true; f.config.curateStackRefereeScope = 'all';
    f.immich.apiKey = 'ANOTHER IMMICH KEY'; await f.restart(); f.advance(); await f.run();
    assert.equal(f.calls.length, 3, 'restart, time, scope, Immich and off/on do not reset the model pause');
    const guard = f.repo.curate.aiLimits, ticket = guard.startProvider(aiBackendKey(f.provider));
    assert.equal(ticket.state, 'started', 'Enrich and other users can still acquire the same provider');
    guard.finish(ticket);
    assert.equal(f.curate.stackReferee.activity().reason, 'model-failures', 'single-image success cannot clear this pause');
    f.config.curateKeeperRefereeEnabled = true;
    let keeperRan = false;
    await f.curate.aiLifecycle.offer({ role: 'keeper', groupId: f.curate.current.byMember.get('b39').id,
      contract: 'synthetic_keeper', prepare: () => ({}), submit: () => ({}), validate: () => ({}),
      accept: () => { keeperRan = true; } });
    f.advance(); await f.run();
    assert.equal(keeperRan, true, 'the independent Photo Referee can use the shared queue and provider');
    assert.equal(f.curate.stackReferee.activity().reason, 'model-failures', 'keeper success cannot clear a Stack Referee pause');
    f.provider.modelName = 'another-model'; f.cap.model = 'another-model';
    f.provider.analyzeImages = async () => { f.calls.push('valid'); return { normalizedOutput: partition(['p1', 'p2']) }; };
    await f.run(); f.advance(); assert.equal((await f.run()).state, 'succeeded');
    assert.equal(f.calls.length, 4); assert.equal(markers().length, 0);
  }, { count: 0, availability: { stack: true, keeper: true } }));

test('retries count one stack, a valid check resets the streak, and partial streaks survive restart', async () => fixture(async f => {
  f.answer = partition(['p1'], ['p1', 'p2']);
  await f.run(); f.advance(); await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 2);
  const count = () => f.repo.db.prepare("SELECT COUNT(*) n FROM curate_meta WHERE key GLOB 'stack-model-failure:*'").get().n;
  assert.equal(count(), 1, 'the automatic retry is not another stack');
  await f.restart(); assert.equal(count(), 1);
  f.add('b0', 600); f.add('b1', 601); await f.run(); f.advance(); await f.run();
  assert.equal(count(), 2);
  f.answer = partition(['p1', 'p2']);
  f.advance(); assert.equal((await f.run()).state, 'succeeded');
  assert.equal(count(), 0, 'a successful retry is still a successful check');
  f.add('c0', 1200); f.add('c1', 1201); f.answer = partition(['p1'], ['p1', 'p2']);
  await f.run(); f.advance(); await f.run();
  assert.equal(count(), 1, 'failures after success start a new streak');
}, { count: 2 }));

test('failure accounting uses the pinned model even when Settings changes during a request', async () => fixture(async f => {
  f.answer = partition(['p1'], ['p1', 'p2']);
  await f.run(); f.advance(); await f.run();
  const response = deferred(); f.answer = response.promise;
  f.advance(); const running = f.run();
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  f.provider.modelName = 'new-model'; f.cap.model = 'new-model';
  response.resolve(partition(['p1'], ['p1', 'p2']));
  await running;
  assert.equal(f.repo.db.prepare("SELECT COUNT(*) n FROM curate_meta WHERE key GLOB 'stack-model-failure:*'").get().n, 1,
    'both failures belong to the old model and same stack');
  assert.equal(f.curate.stackReferee.modelBlocked(f.provider), false);
}, { count: 2 }));

for (const [label, failure] of [
  ['missing preview', () => { throw new ImmichApiError('PRIVATE UPSTREAM DETAILS', 404); }],
  ['forbidden preview', () => { throw new ImmichApiError('PRIVATE UPSTREAM DETAILS', 403); }],
  ['oversized preview', () => { throw new ResponseTooLargeError('PRIVATE UPSTREAM DETAILS'); }],
  ['unsupported MIME', () => ({ data: png, contentType: 'image/tiff' })],
  ['adapter error', () => { throw new Error('PRIVATE UPSTREAM DETAILS'); }],
]) test(`${label} settles without spending a call, including across restart`, async () => fixture(async f => {
  f.download = failure;
  await f.run(); f.advance(); assert.equal((await f.run()).reason, 'preparation-failed');
  for (let i = 0; i < 3; i++) { f.advance(STACK_PREVIEW_PAUSE_MS); await f.run(); }
  await f.restart(); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, label === 'unsupported MIME' ? 4 : 1);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempts').get().n, 0);
  const row = f.repo.db.prepare('SELECT json FROM curate_ai_inputs').get().json;
  assert.doesNotMatch(row, /PRIVATE|http:/);
  assert.equal(JSON.parse(row).outcome.reason, 'preparation-failed');
}));

test('an Immich outage pauses queued stacks and discovery across restart, then the entire library recovers', async () => fixture(async f => {
  for (let i = 0; i < 8; i++) { f.add(`b${i}`, i * 600); f.add(`c${i}`, i * 600 + 1); }
  f.answer = partition(['p1', 'p2']);
  const client = new ImmichClient({ baseUrl: 'http://synthetic', apiKey: 'PRIVATE IMMICH KEY', fetchImpl: async () => {
    throw new TypeError('PRIVATE NETWORK DETAILS');
  } });
  f.download = (id, options) => client.getAssetThumbnail(id, 'preview', options);
  await f.run(); assert.equal(f.curate.aiLifecycle.pending.size, 8);
  f.advance(); assert.equal((await f.run()).reason, 'preparation-failed');
  assert.equal(f.curate.aiLifecycle.pending.size, 7, 'already queued work exists');
  for (let i = 0; i < 3; i++) { f.advance(); await f.run(); }
  assert.equal(f.downloads.length, 1, 'queued work cannot drain during the pause');
  assert.ok(f.curate.current.groups.every(g => f.curate.stackReferee.status(g).reason === 'preview-cooldown'));
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempts').get().n, 0);
  const row = f.repo.db.prepare('SELECT json FROM curate_ai_inputs').get().json;
  assert.equal(JSON.parse(row).preparationFailures, 1); assert.equal(JSON.parse(row).outcome, undefined);
  assert.doesNotMatch(row, /PRIVATE|http:/);
  await f.restart(); await f.run();
  assert.equal(f.downloads.length, 1, 'restart preserves the original pause');
  f.download = () => ({ data: png, contentType: 'image/png' });
  f.advance(STACK_PREVIEW_PAUSE_MS);
  for (let i = 0; i < 10; i++) { await f.run(); f.advance(); }
  await f.curate.refresh();
  assert.equal(f.calls.length, 8); assert.equal(f.downloads.length, 17);
  assert.ok(f.curate.current.groups.every(g => g.stackCheck?.state === 'checked'));
  await f.restart(); f.advance(STACK_PREVIEW_PAUSE_MS); await f.run();
  assert.equal(f.calls.length, 8, 'successful checks do not repeat');
}, { count: 0 }));

for (const [label, error] of [
  ['HTTP 408', new ImmichApiError('PRIVATE DETAILS', 408)],
  ['HTTP 429', new ImmichApiError('PRIVATE DETAILS', 429)],
  ['HTTP 503', new ImmichApiError('PRIVATE DETAILS', 503)],
  ['preparation deadline', new DOMException('PRIVATE DETAILS', 'TimeoutError')],
]) test(`${label} allows only one preparation retry, including restart and model changes`, async () => fixture(async f => {
  f.download = () => { throw error; };
  await f.run(); f.advance(); await f.run();
  assert.equal(f.downloads.length, 1);
  await f.restart(); await f.run(); assert.equal(f.downloads.length, 1);
  f.advance(STACK_PREVIEW_PAUSE_MS); await f.run(); f.advance(); await f.run();
  assert.equal(f.downloads.length, 2);
  assert.equal(f.curate.stackReferee.status(f.curate.current.groups[0]).reason, 'preparation-failed');
  f.config.curateStackRefereeEnabled = false; await f.run(); f.config.curateStackRefereeEnabled = true;
  f.provider.modelName = 'another-model'; f.cap.model = 'another-model';
  await f.restart();
  for (let i = 0; i < 3; i++) { f.advance(STACK_PREVIEW_PAUSE_MS); await f.run(); }
  assert.equal(f.downloads.length, 2); assert.equal(f.calls.length, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempts').get().n, 0);
  assert.equal(JSON.parse(f.repo.db.prepare('SELECT json FROM curate_ai_inputs').get().json).preparationFailures, 2);
}));

test('a second failed preparation also pauses other queued stacks, without settling them', async () => fixture(async f => {
  f.download = () => { throw new ImmichApiError('PRIVATE DETAILS', 503); };
  await f.run(); f.advance(); await f.run();
  f.advance(STACK_PREVIEW_PAUSE_MS); await f.run();
  f.add('b0', 600); f.add('b1', 601); await f.run();
  f.advance(); await f.run();
  assert.equal(f.downloads.length, 2);
  f.advance(); await f.run();
  assert.equal(f.downloads.length, 2);
  const group = f.curate.current.byMember.get('b0');
  assert.equal(f.curate.stackReferee.status(group).reason, 'preview-cooldown');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 1);
  f.download = () => ({ data: png, contentType: 'image/png' }); f.answer = partition(['p1', 'p2']);
  f.advance(STACK_PREVIEW_PAUSE_MS); await f.run();
  assert.equal(f.calls.length, 1, 'unaffected queued stack can recover');
}));

for (const change of ['role-off', 'connection']) test(`${change} during a failed download records neither a failure nor a pause`, async () => fixture(async f => {
  f.download = () => {
    if (change === 'role-off') f.config.curateStackRefereeEnabled = false;
    else f.immich.baseUrl = 'http://changed';
    throw new ImmichApiError('PRIVATE DETAILS');
  };
  await f.run(); f.advance(); assert.equal((await f.run()).state, change === 'role-off' ? 'disabled' : 'stale');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 0);
  assert.equal(f.curate.stackReferee.previewsReady(), true);
}));

test('shutdown aborting an in-flight Immich download records neither a failure nor a pause', async () => fixture(async f => {
  const started = deferred();
  const client = new ImmichClient({ baseUrl: 'http://synthetic', apiKey: 'PRIVATE IMMICH KEY', fetchImpl: async (_url, { signal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  f.download = (id, options) => client.getAssetThumbnail(id, 'preview', options);
  await f.run(); f.advance(); const running = f.run();
  await started.promise; await f.curate.close();
  assert.equal((await running).state, 'stopped');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 0);
  assert.equal(f.curate.stackReferee.previewsReady(), true);
  assert.equal(f.calls.length, 0);
}));

for (const supported of [false, true]) test(`${supported ? 'confirmed small' : 'unknown'} capability is derived without records or preparation`, async () => fixture(async f => {
  if (supported) f.cap.maxImages = 2;
  await f.run(); f.advance(); await f.run();
  const status = f.curate.stackReferee.status(f.curate.current.groups[0]);
  assert.equal(status.reason, supported ? 'unsupported-size' : 'unknown-capability');
  assert.equal(status.limit, supported ? 2 : undefined, 'the AI check step can name the photo limit');
  await f.restart(); await f.run(); assert.equal(f.downloads.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 0);
  f.cap = { provider: f.provider.providerName, model: f.provider.modelName, comparative: true, maxImages: 30 };
  await f.run(); f.advance(); assert.equal((await f.run()).state, 'succeeded', 'new supported configuration can remove a non-paid limitation');
}, { capability: supported }));

test('toggle-off between previews stops preparation without recording a failure or spending an attempt', async () => fixture(async f => {
  f.download = () => { f.config.curateStackRefereeEnabled = false; return { data: png, contentType: 'image/png' }; };
  await f.run(); f.advance(); assert.equal((await f.run()).state, 'disabled');
  assert.equal(f.downloads.length, 1); assert.equal(f.calls.length, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 0);
}));

for (const change of ['decision', 'addition', 'connection']) test(`${change} during inference discards the answer`, async () => fixture(async f => {
  const response = deferred(); f.answer = response.promise;
  await f.run(); f.advance(); const running = f.run();
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  if (change === 'decision') f.repo.recordDecision({ assetIds: ['a0'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  if (change === 'addition') f.add('new', 2);
  if (change === 'connection') f.immich.baseUrl = 'http://changed';
  response.resolve(partition(['p1', 'p2', 'p3', 'p4']));
  assert.equal((await running).state, 'stale');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_advice').get().n, 0);
}));

test('accepted partitions tolerate decided-member subtraction but invalidate changed facts or newly joined photos', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  f.repo.recordDecision({ assetIds: ['a0'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  await f.curate.refresh();
  assert.ok(f.curate.current.groups.every(g => g.stackCheck?.state === 'checked'));
  assert.deepEqual(f.curate.current.groups.flatMap(g => g.ids).sort(), ['a1', 'a2', 'a3']);
  await f.run(); assert.equal(f.calls.length, 1);
  f.add('new', 2); await f.curate.refresh();
  assert.ok(f.curate.current.groups.every(g => !g.stackCheck));
}));

test('changed source identity invalidates a saved check even when membership is unchanged', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  f.repo.upsertAsset({ id: 'a0', fileCreatedAt: new Date(1_700_000_000_000).toISOString(), checksum: 'changed' });
  await f.curate.refresh(); assert.ok(f.curate.current.groups.every(g => !g.stackCheck));
}));

// PIC-371: a single photo shows Kept apart only when the answer divided the
// photos it compared, not when decisions shrink a confirmed stack.
const pageStatus = (f, group) => stackStatus({ memberCount: group.ids.length, route: group.route, reasons: group.reasons,
  stackReferee: f.curate.stackReferee.status(group) });
test('a confirmed stack that decisions shrink to one photo is not kept apart; a split-off photo is', async () => {
  await fixture(async f => {
    f.answer = partition(['p1', 'p2', 'p3', 'p4']);
    await f.run(); f.advance(); await f.run(); await f.curate.refresh();
    f.repo.recordDecision({ assetIds: ['a0', 'a1', 'a2'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
    await f.curate.refresh();
    const [left] = f.curate.current.groups;
    assert.deepEqual(left.ids, ['a3']);
    assert.deepEqual(f.curate.stackReferee.status(left), { state: 'checked', inputKey: left.stackCheck.inputKey,
      reason: 'Same subject and composition.', split: false });
    assert.equal(pageStatus(f, left).badge, null);
    assert.equal(evidenceRows({ ids: left.ids, reasons: left.reasons, stackReferee: left.stackCheck })[0].value,
      'Grouped it with nearby photos: Same subject and composition.');
  });
  await fixture(async f => {
    f.answer = partition(['p1'], ['p2', 'p3', 'p4']);
    await f.run(); f.advance(); await f.run(); await f.curate.refresh();
    const single = f.curate.current.groups.find(g => g.ids.length === 1);
    assert.equal(pageStatus(f, single).badge, 'apart');
    assert.equal(pageStatus(f, f.curate.current.groups.find(g => g.ids.length === 3)).badge, 'ai-checked');
    f.repo.recordDecision({ assetIds: ['a1', 'a2', 'a3'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
    await f.curate.refresh();
    assert.equal(pageStatus(f, f.curate.current.groups[0]).badge, 'apart', 'decisions cannot undo a split');
  });
});

test('a keep-together answer is still a completed check and does not repeat on scope or role toggles', async () => fixture(async f => {
  f.answer = partition(['p1', 'p2', 'p3', 'p4']);
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  assert.equal(f.curate.current.groups.length, 1);
  assert.equal(f.curate.current.groups[0].stackCheck.split, false);
  f.config.curateStackRefereeScope = 'all'; await f.run();
  f.config.curateStackRefereeEnabled = false; await f.run();
  f.config.curateStackRefereeEnabled = true; f.advance(); await f.run();
  assert.equal(f.calls.length, 1);
  f.config.curateBurstGrouping = false; await f.curate.refresh();
  assert.equal(f.curate.current.groups.length, 4);
  assert.ok(f.curate.current.groups.every(g => !g.stackCheck));
  f.config.curateBurstGrouping = true; await f.curate.refresh(); await f.run();
  assert.equal(f.curate.current.groups.length, 1); assert.equal(f.calls.length, 1);
}));

test('AI splits never become deterministic cached composition, and new human separations invalidate the check', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  const scope = f.curate.current.scopes[0];
  const rows = Object.fromEntries(scope.ids.map(id => [id, Object.fromEntries(scope.ids.filter(other => id !== other).map(other => [other, 0]))]));
  f.curate.refinement.saved.save({ ...scope, rows, coverage: {} }, Date.now());
  f.curate.refinement.revision++; await f.curate.refresh();
  assert.equal(f.curate.refinement.saved.read(scope.id).settled.groups.length, 1);
  assert.equal(f.curate.current.groups.length, 2);
  const view = await f.curate.openView();
  const comparison = f.curate.comparison(view.viewId, view.groups[0].id);
  await f.curate.separate(comparison.id, comparison.ids.map(id => [id]));
  assert.ok(f.curate.current.groups.every(g => !g.stackCheck), 'constraints invalidate the whole recorded check');
  assert.ok(f.curate.current.groups.every(g => !g.ids.includes('a0') || !g.ids.includes('a2')));
}));

test('provider changes while queued are checked before downloads and do not create a retry loop', async () => fixture(async f => {
  await f.run(); f.provider.modelName = 'changed'; f.advance(); await f.run();
  assert.equal(f.downloads.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.curate.aiLifecycle.pending.size, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 0);
}));

test('production availability still requires an explicit Stack Referee preference', async () => fixture(async f => {
  f.config.curateStackRefereeEnabled = false;
  await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
  assert.equal(f.curate.aiLifecycle.pending.size, 0);
}, { availability: CURATE_AI_AVAILABILITY }));

test('production role and adapter gates honor a chosen non-Venice model and retain the split after restart', async () => fixture(async f => {
  // This model has not been individually allowlisted. It remains the user's choice.
  assert.equal(f.provider.providerName, 'openai_compatible');
  // Synthetic previews and model answers exercise the server's real capability
  // and role gates, scheduler, preparation, validation, storage and rebuild path.
  await f.run(); f.advance(); assert.equal((await f.run()).state, 'succeeded');
  await f.curate.refresh();
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), [['a0', 'a2'], ['a1', 'a3']]);
  assert.ok(f.curate.current.groups.every(g => f.curate.stackReferee.status(g).state === 'checked'));
  await f.restart(); f.advance(); await f.run();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), [['a0', 'a2'], ['a1', 'a3']]);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM asset_tags').get().n, 0);
}, { capability: refereeCapability }));

test('preview reads enforce streaming byte limits and abort signals, without an original or thumbnail fallback', async () => {
  const paths = [];
  const client = new ImmichClient({ baseUrl: 'http://synthetic', apiKey: 'synthetic', fetchImpl: async (url, options) => {
    paths.push(url); assert.ok(options.signal);
    return new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } });
  } });
  await assert.rejects(stackRefereeImages(client, ['a', 'b'], () => {}, new AbortController().signal), { name: 'ResponseTooLargeError' });
  assert.equal(paths.length, 1); assert.match(paths[0], /thumbnail\?size=preview$/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stackRefereeImages(client, ['a', 'b'], () => {}, controller.signal));
  assert.equal(paths.length, 1);
});

test('a caller can abort an in-progress preview exchange', { timeout: 2000 }, async () => {
  const started = deferred(), controller = new AbortController();
  const client = new ImmichClient({ baseUrl: 'http://synthetic', apiKey: 'synthetic', fetchImpl: async (_url, { signal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const pending = stackRefereeImages(client, ['a', 'b'], () => {}, controller.signal);
  await started.promise; controller.abort(); await assert.rejects(pending, /cancelled/);
});

test('supported scope is skipped by default, all-stacks includes it, and still-pending similarity waits', async () => fixture(async f => {
  await f.curate.refresh();
  const group = f.curate.current.groups[0]; group.route = 'candidate-supported';
  await f.curate.stackReferee.discover(); assert.equal(f.curate.aiLifecycle.pending.size, 0);
  assert.equal(f.curate.stackReferee.status(group).reason, 'supported-by-grouping');
  f.config.curateStackRefereeScope = 'all';
  f.curate.refinement.groupStatus = () => ({ state: 'checking' });
  await f.curate.stackReferee.discover(); assert.equal(f.curate.aiLifecycle.pending.size, 0);
  f.curate.refinement.groupStatus = () => ({ state: 'incomplete' });
  await f.curate.stackReferee.discover(); assert.equal(f.curate.aiLifecycle.pending.size, 1);
}));

test('groups beyond the discovery window are reached even when earlier work cannot run', async () => fixture(async f => {
  for (let i = 0; i < 35; i++) { f.add(`b${i}`, i * 600); f.add(`c${i}`, i * 600 + 1); }
  await f.run(); await f.run(); await f.run();
  const last = f.curate.current.byMember.get('b34');
  assert.equal(f.curate.stackReferee.status(last).reason, 'unknown-capability');
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
}, { count: 0, capability: false }));

test('unsupported adapter/configuration is visible globally even when no work was admitted', async () => fixture(async f => {
  await f.run();
  assert.deepEqual(f.curate.stackReferee.activity(), { state: 'paused', reason: 'unknown-capability', scope: 'configuration' });
  const group = f.curate.current.groups[0];
  assert.equal(f.curate.stackReferee.status(group).scope, 'configuration');
  f.curate.aiLifecycle.resolveProvider = () => { throw new Error('PRIVATE CREDENTIAL ERROR'); };
  const status = f.curate.stackReferee.activity();
  assert.equal(status.reason, 'configuration'); assert.equal(status.scope, 'configuration');
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE/);
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
}, { capability: false }));

test('provider pauses and request allowances have honest card and global status without raw diagnostics', async () => fixture(async f => {
  await f.run();
  assert.equal(f.curate.stackReferee.activity().state, 'waiting');
  const guard = f.repo.curate.aiLimits;
  const ticket = guard.startProvider(aiBackendKey(f.provider));
  guard.finish(ticket, new ProviderRequestError('PRIVATE DIAGNOSTICS', { status: 401 }));
  const view = await f.curate.openView();
  assert.equal(view.stackRefereeActivity.state, 'paused');
  assert.equal(view.groups[0].stackReferee.reason, 'provider-auth');
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE/);
  const captured = f.curate.stackReferee.capture(f.curate.current.groups[0]);
  f.repo.db.prepare('INSERT INTO curate_ai_skipped_inputs VALUES(?,?,?)').run('stack', captured.snapshot.inputKey, Date.now());
  assert.equal(f.curate.stackReferee.status(f.curate.current.groups[0]).reason, 'photo-limit');
}));

test('a successful badge is withheld during source rebuild and is absent from Decided comparisons', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  const group = f.curate.current.groups[0];
  assert.equal(f.curate.stackReferee.status(group).state, 'checked');
  f.repo.upsertAsset({ id: 'a0', fileCreatedAt: new Date(1_700_000_000_000).toISOString(), checksum: 'changed' });
  assert.equal(f.curate.stackReferee.status(group).state, 'updated');
  await f.curate.refresh();
  assert.notEqual(f.curate.stackReferee.status(f.curate.current.byMember.get('a0')).state, 'checked');
  f.repo.recordDecision({ assetIds: ['a0'], addTags: ['frame/eligible', 'frame/reviewed'], removeTags: [], action: 'approve' });
  const view = await f.curate.openView({ section: 'decided' });
  assert.equal(view.groups[0].stackReferee, null);
  assert.equal(f.curate.comparison(view.viewId, view.groups[0].id).stackReferee, null);
}));

test('unrelated imports and Save & next preserve checked badges before the background rebuild', async () => fixture(async f => {
  for (let g = 0; g < 4; g++) for (let p = 0; p < 2; p++)
    f.add(`00000000-0000-4000-8000-${String(g * 2 + p + 1).padStart(12, '0')}`, g * 600 + p);
  f.answer = partition(['p1', 'p2']);
  await f.run(); f.advance();
  for (let g = 0; g < 4; g++) await f.run();
  const view = await f.curate.openView();
  assert.equal(view.groups.length, 4);
  const states = () => f.curate.page(view.viewId).groups.map(g => g.stackReferee.state);
  assert.deepEqual(states(), Array(4).fill('checked'));
  f.add('unrelated', 5 * 86400);
  assert.deepEqual(states(), Array(4).fill('checked'), 'a distant dirty photo does not hide any badge');
  f.repo.curate.flushIds(['unrelated']);
  assert.notEqual(f.curate.current.generation, f.repo.curate.generation());
  assert.deepEqual(states(), Array(4).fill('checked'), 'a projected distant photo does not hide any badge');
  const first = f.curate.comparison(view.viewId, view.groups[0].id);
  const { expiresAt, ...operation } = await f.curate.issueDecision(first.id);
  await f.curate.applyDecision({ ...operation, outcomes: Object.fromEntries(first.ids.map(id => [id, 'approve'])) });
  const published = f.curate.current;
  const next = f.curate.comparison(view.viewId, view.groups[1].id);
  assert.equal(next.stackReferee.state, 'checked');
  assert.equal(f.curate.current, published, 'opening the next comparison did not rebuild the library');
  assert.equal(f.calls.length, 4, 'status reads never repeat checks');
}, { count: 0 }));

test('split children keep valid checks through sibling decisions and role-off', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  const group = f.curate.current.byMember.get('a0');
  f.repo.recordDecision({ assetIds: ['a1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  assert.equal(f.curate.stackReferee.status(group).state, 'checked');
  f.config.curateStackRefereeEnabled = false;
  f.add('unrelated', 5 * 86400);
  assert.equal(f.curate.stackReferee.status(group).state, 'checked');
  assert.equal(f.calls.length, 1);
}));

test('disabled referee without saved advice stays off during unrelated or local changes', async () => fixture(async f => {
  f.config.curateStackRefereeEnabled = false;
  await f.curate.refresh();
  const group = f.curate.current.groups[0];
  f.add('unrelated', 5 * 86400);
  assert.equal(f.curate.stackReferee.status(group).state, 'off');
  f.repo.curate.flushIds(['unrelated']);
  assert.equal(f.curate.stackReferee.status(group).state, 'off');
  f.repo.upsertAsset({ id: 'a0', checksum: 'changed' });
  assert.equal(f.curate.stackReferee.status(group).state, 'off');
}, { availability: CURATE_AI_AVAILABILITY }));

for (const change of ['import', 'decision'])
  test(`queued checks remain neutral during a pending ${change}, then return to waiting`, async () => fixture(async f => {
    f.add('b0', 600); f.add('b1', 601);
    await f.run();
    const groups = f.curate.current.groups;
    assert.equal(groups.length, 2);
    assert.ok(groups.every(g => f.curate.stackReferee.status(g).state === 'waiting'));
    const pending = [...f.curate.aiLifecycle.pending.keys()];
    if (change === 'import') f.add('unrelated', 5 * 86400);
    else f.repo.recordDecision({ assetIds: ['a0'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    assert.ok(groups.every(g => f.curate.stackReferee.status(g).state === 'updated'));
    assert.deepEqual([...f.curate.aiLifecycle.pending.keys()], pending, 'status reads do not settle or requeue work');
    await f.curate.refresh();
    assert.ok(f.curate.current.groups.filter(g => g.ids.length > 1)
      .every(g => f.curate.stackReferee.status(g).state === 'waiting'));
    assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
  }));

test('a real capture limit stays incomplete rather than becoming a neutral update', async () => fixture(async f => {
  await f.curate.refresh();
  assert.equal(f.curate.current.groups[0].ids.length, 31);
  assert.deepEqual(f.curate.stackReferee.status(f.curate.current.groups[0]),
    { state: 'incomplete', reason: 'too-many-images' });
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
}, { count: 31 }));

for (const change of ['image', 'availability', 'separation', 'nearby'])
  test(`${change} changes withhold a saved badge before the next rebuild, including split siblings`, async () => fixture(async f => {
    await f.run(); f.advance(); await f.run(); await f.curate.refresh();
    const group = f.curate.current.byMember.get('a0');
    if (change === 'image') f.repo.upsertAsset({ id: 'a1', checksum: 'changed',
      fileCreatedAt: new Date(1_700_000_000_000 + 5 * 86400000).toISOString() });
    if (change === 'availability') f.repo.upsertAsset({ id: 'a1', isOffline: true });
    if (change === 'nearby') f.add('nearby', 60); // Beyond the old 15-second scope, inside the candidate span.
    if (change === 'separation') {
      const view = await f.curate.openView();
      const sibling = f.curate.comparison(view.viewId, f.curate.current.byMember.get('a1').id);
      f.repo.curate.separate(sibling.id, sibling.ids.map(id => [id]));
    }
    const published = f.curate.current;
    assert.equal(f.curate.stackReferee.status(group).state, 'updated');
    assert.equal(f.curate.current, published, 'status does not change the open grouping');
    f.config.curateStackRefereeEnabled = false;
    assert.equal(f.curate.stackReferee.status(group).state, 'updated', 'role-off does not certify stale evidence');
    assert.equal(f.calls.length, 1);
  }));
