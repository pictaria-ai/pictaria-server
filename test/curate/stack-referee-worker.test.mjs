import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { CurateAiLifecycle, AI_SETTLE_MS } from '../../src/curate/ai-lifecycle.mjs';
import { StackRefereeWorker, STACK_PREVIEW_PAUSE_MS } from '../../src/curate/stack-referee-worker.mjs';
import { CURATE_AI_AVAILABILITY } from '../../src/curate/ai-policy.mjs';
import { AiRequestScheduler } from '../../src/ai/scheduler.mjs';
import { ImmichClient, ImmichApiError } from '../../src/immich.mjs';
import { ResponseTooLargeError } from '../../src/fetchWithTimeout.mjs';
import { stackRefereeImages } from '../../src/curate/stack-referee-images.mjs';
import { aiBackendKey } from '../../src/curate/ai-limits.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const partition = (...groups) => ({ groups: groups.map(ids => ({ ids, reason: 'Same subject and composition.' })) });
const deferred = () => Promise.withResolvers();

async function fixture(work, { count = 4, capability = true, availability = { stack: true, keeper: false } } = {}) {
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
    curate.stackReferee = new StackRefereeWorker(curate, { capability: () => cap });
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
  await f.curate.refresh();
  assert.deepEqual(f.curate.current.groups.map(g => g.ids), [['a0', 'a2'], ['a1', 'a3']]);
  assert.ok(f.curate.current.groups.every(g => g.stackCheck.state === 'checked'));
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
  assert.equal(f.curate.stackReferee.status(f.curate.current.groups[0]).reason, supported ? 'unsupported-size' : 'unknown-capability');
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

test('a keep-together answer is still a completed check and does not repeat on scope or role toggles', async () => fixture(async f => {
  f.answer = partition(['p1', 'p2', 'p3', 'p4']);
  await f.run(); f.advance(); await f.run(); await f.curate.refresh();
  assert.equal(f.curate.current.groups.length, 1);
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

test('production availability still prevents discovery and calls', async () => fixture(async f => {
  await f.run(); f.advance(); await f.run();
  assert.equal(f.calls.length, 0); assert.equal(f.downloads.length, 0);
  assert.equal(f.curate.aiLifecycle.pending.size, 0);
}, { availability: CURATE_AI_AVAILABILITY }));

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
