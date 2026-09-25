import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as turn } from 'node:timers/promises';
import { Repository } from '../../src/enrich/repository.mjs';
import { RefereeService } from '../../src/enrich/refereeService.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { analyzeWithValidationRetry } from '../../src/enrich/runner.mjs';
import { AiRequestScheduler } from '../../src/ai/scheduler.mjs';
import { AiConnections } from '../../src/ai/connections.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { aiBackendKey } from '../../src/curate/ai-limits.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';
import { loadV1Taxonomy, sampleOutput } from '../enrich/helpers.mjs';

const taxonomy = loadV1Taxonomy();
const providerOptions = { modelName: 'test-model', baseUrl: 'http://model.test:8000/v1', apiKey: 'synthetic-secret' };
const immich = { getAsset: async id => ({ id, originalPath: `${id}.jpg` }),
  getAssetThumbnail: async () => ({ data: Buffer.from('synthetic'), contentType: 'image/jpeg' }) };
const answer = output => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(output) } }] }) });
const rejected = (status, retryAfter = null) => ({ ok: false, status, headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}),
  text: async () => 'synthetic rejection' });
async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-ai-protection-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  let now = 100_000;
  const limits = repo.curate.aiLimits; limits.now = () => now;
  const scheduler = new AiRequestScheduler({ now: () => now });
  const config = { promptsDir: fileURLToPath(new URL('../../prompts', import.meta.url)), promptVersion: 'v1', promptOverrides: {},
    defaultProvider: 'local_lmstudio', imageSource: 'preview', maxFailuresPerAsset: 2,
    enrichEnabled: true, curateBurstGrouping: true, curateStackRefereeEnabled: true, curateKeeperRefereeEnabled: true,
    providers: { local_lmstudio: { ...providerOptions, fetchImpl: async () => answer(sampleOutput()) } } };
  const connections = new AiConnections({ limits, scheduler, getConfig: () => config });
  const runner = () => new EnrichJobRunner({ repo, immich, taxonomy, config, aiScheduler: scheduler, aiConnections: connections });
  try { await work({ repo, limits, scheduler, config, connections, runner, tick: ms => { now += ms; } }); }
  finally { await connections.stop(20); await scheduler.stop(20); repo.close(); rmSync(dir, { recursive: true, force: true }); }
}
function executor(f) { return new CurateAiExecution({ attempts: f.repo.curate.aiAttempts, limits: f.limits,
  scheduler: f.scheduler, getConfig: () => f.config, availability: { stack: true, keeper: true } }); }
function job(provider, submit = async () => ({})) { return { role: 'stack', provider, backendKey: aiBackendKey(provider), inputKey: 'a'.repeat(64),
  photoIds: ['a', 'b'], isCurrent: () => true, prepare: async check => check(), submit, validate: x => x, accept: () => {} }; }

test('first authentication failure stops Enrich, preserves the queue and blocks affected Curate without charging it', async () => fixture(async f => {
  let calls = 0, finished = 0;
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return rejected(401); };
  const runner = f.runner();
  runner.start({ assetIds: Array.from({ length: 50 }, (_, i) => `p${i}`), onFinished: () => { finished++; } });
  await runner.runPromise;
  assert.equal(calls, 1); assert.equal(finished, 0);
  assert.match(runner.status().error, /API key/);
  assert.equal(runner.status().aiConnection.state, 'paused');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM processing_runs').get().n, 1);
  assert.equal(f.repo.db.prepare('SELECT status FROM processing_runs').get().status, 'failed_infra');
  const p = f.connections.provider('curate');
  assert.equal((await executor(f).run(job(p, () => assert.fail('paused request')))).state, 'provider-paused');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 0);
  const again = f.runner(); again.start({ assetIds: ['new'] }); await again.runPromise;
  assert.equal(calls, 1); assert.equal(again.status().liveCounters.failed, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM processing_runs').get().n, 1);
  assert.doesNotMatch(JSON.stringify(f.connections.describe()), /synthetic-secret|model\.test/);
  const independent = { ...p, baseUrl: 'http://independent.test:8000/v1' };
  assert.deepEqual(await f.connections.run(independent, async () => ({ ok: true })), { ok: true });
}));

test('Enrich overload retry honors the full delay, spends one recovery, and then stays paused', async () => fixture(async f => {
  let calls = 0, waited = 0;
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return rejected(429, '65'); };
  const p = f.connections.provider('enrich'), session = f.scheduler.session(p, 'enrich');
  try {
    await assert.rejects(analyzeWithValidationRetry(p, { data: Buffer.from('test'), mimeType: 'image/jpeg' }, {
      taxonomy, systemPrompt: 'system', userPrompt: 'user', jsonSchema: {}, aiSession: session, aiConnections: f.connections,
      retrySleep: async ms => { waited += ms; f.tick(ms); },
    }), { status: 429 });
  } finally { session.close(); }
  assert.equal(calls, 2); assert.equal(waited, 65_000);
  assert.deepEqual(f.connections.status(p), { state: 'paused', reason: 'unavailable' });
  f.tick(3_600_000);
  await assert.rejects(f.connections.run(p, () => assert.fail('no hourly probe')), { code: 'ai_connection_paused' });
  assert.equal(calls, 2);
}));

test('verification is one scheduled synthetic-image call, shared across roles, and never refunds attempts', async () => fixture(async f => {
  const p = f.connections.provider('enrich');
  const ticket = f.limits.start(job(p), f.repo.curate.aiAttempts);
  f.limits.finish(ticket, new ProviderRequestError('unauthorized', { status: 401 }));
  f.repo.curate.aiAttempts.finish(ticket, 'failed');
  const calls = [];
  f.config.providers.local_lmstudio.fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return answer({ ok: true });
  };
  assert.ok(f.connections.describe().every(row => row.state === 'paused' && row.canVerify));
  assert.equal((await f.connections.verify('enrich')).verified, true);
  assert.equal(calls.length, 1);
  const images = calls[0].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'image_url');
  assert.equal(images.length, 1); assert.match(images[0].image_url.url, /^data:image\/png;base64,/);
  assert.ok(f.connections.describe().every(row => row.state === 'ready'));
  assert.equal(f.repo.curate.aiAttempts.status('stack', 'a'.repeat(64)).attempts, 1);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 2);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM processing_runs').get().n, 0);
}));

test('queued verification is cancelled on saved model changes and cannot bypass a live owner', async () => fixture(async f => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers(); let calls = 0;
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return answer({ ok: true }); };
  const p = f.connections.provider('enrich'), session = f.scheduler.session(p, 'enrich');
  const held = session.run(() => f.connections.run(p, async () => { started.resolve(); await gate.promise; }));
  await started.promise;
  const check = f.connections.verify('enrich'); await turn();
  assert.equal(f.limits.startProvider(aiBackendKey(p), { verification: true }).state, 'provider-busy');
  assert.equal((await f.connections.verify('curate')).verified, false);
  f.config.providers.local_lmstudio.modelName = 'changed-model'; f.scheduler.refresh();
  assert.equal((await check).verified, false); assert.equal(calls, 0);
  gate.resolve(); await held; session.close();
}));

test('a failed verification stays paused and refresh/status reads never send a request', async () => fixture(async f => {
  let calls = 0;
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return rejected(503); };
  const result = await f.connections.verify('curate');
  assert.equal(result.verified, false); assert.match(result.message, /paused/);
  f.tick(1_000_000);
  for (let i = 0; i < 20; i++) assert.equal(f.connections.describe()[0].state, 'paused');
  assert.equal(calls, 1);
}));

test('ordinary content rejections and malformed model answers do not pause the shared connection', async () => fixture(async f => {
  for (const response of [rejected(400), answer('not an enrichment object'),
    { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'private broken json' } }] }) }]) {
    f.config.providers.local_lmstudio.fetchImpl = async () => response;
    const p = f.connections.provider('enrich');
    try { await f.connections.run(p, () => p.analyzeImage({ data: Buffer.from('test'), mimeType: 'image/jpeg' },
      { systemPrompt: 'system', userPrompt: 'user', jsonSchema: {} })); }
    catch (error) { assert.doesNotMatch(error.message, /private broken json/); }
    assert.equal(f.connections.status(p).state, 'ready');
  }
}));

test('shared protected Enrich still yields its ten-call turn to queued Curate', async () => fixture(async f => {
  const started = Promise.withResolvers(), gate = Promise.withResolvers(), order = [];
  f.config.providers.local_lmstudio.fetchImpl = async () => {
    order.push('enrich');
    if (order.length === 1) { started.resolve(); await gate.promise; }
    return answer(sampleOutput());
  };
  const runner = f.runner(); runner.start({ assetIds: Array.from({ length: 11 }, (_, i) => `p${i}`) });
  await started.promise;
  const check = executor(f).run(job(f.connections.provider('curate'), async () => { order.push('curate'); return {}; }));
  await turn(); gate.resolve();
  assert.equal((await check).state, 'succeeded'); await runner.runPromise;
  assert.equal(runner.status().error, null);
  assert.deepEqual(order, [...Array(10).fill('enrich'), 'curate', 'enrich']);
}));

test('a recovered stale completion cannot clear a newer failure', async () => fixture(async f => {
  const key = aiBackendKey(f.connections.provider('enrich'));
  const old = f.limits.startProvider(key);
  f.limits.recoverInterrupted(f.repo.curate.aiAttempts); f.tick(30_000);
  const recovery = f.limits.startProvider(key);
  f.limits.finish(recovery, new ProviderRequestError('unavailable', { status: 503 }));
  assert.equal(f.limits.finish(old), false);
  assert.deepEqual(f.limits.providerStatus(key), { state: 'paused', reason: 'unavailable' });
}));

test('a nondefault per-run provider has its own saved verification target', async () => fixture(async f => {
  let calls = 0;
  f.config.providers.openai_compatible = { baseUrl: 'http://other.test/v1', modelName: 'other', apiKey: 'other-secret',
    fetchImpl: async () => { calls++; return answer({ ok: true }); } };
  const p = f.connections.provider('provider:openai_compatible');
  f.limits.finish(f.limits.startProvider(aiBackendKey(p)), new ProviderRequestError('denied', { status: 403 }));
  assert.equal(f.connections.describe().find(row => row.target === 'provider:openai_compatible').state, 'paused');
  assert.equal(f.connections.describe()[0].state, 'ready');
  assert.equal((await f.connections.verify('provider:openai_compatible')).verified, true);
  assert.equal(f.config.defaultProvider, 'local_lmstudio'); assert.equal(calls, 1);
  await assert.rejects(f.connections.verify('provider:unconfigured'), /Unknown AI connection/);
}));

test('an explicit rejected or malformed verification does not clear an authentication pause', async () => fixture(async f => {
  for (const response of [rejected(400), answer({ unexpected: true })]) {
    const p = f.connections.provider('enrich');
    f.limits.finish(f.limits.startProvider(aiBackendKey(p), { verification: true }), new ProviderRequestError('denied', { status: 401 }));
    f.config.providers.local_lmstudio.fetchImpl = async () => response;
    assert.equal((await f.connections.verify('enrich')).verified, false);
    assert.deepEqual(f.connections.status(p), { state: 'paused', reason: 'configuration' });
  }
}));


test('legacy referee polling honors the same provider pause and makes no downloads or paid calls', async () => fixture(async f => {
  const p = f.connections.provider('curate');
  f.limits.finish(f.limits.startProvider(aiBackendKey(p)), new ProviderRequestError('denied', { status: 401 }));
  f.config.curateRefereeEnabled = true;
  const referee = new RefereeService({ repo: f.repo, immich: { getAssetThumbnail: () => assert.fail('download while paused') },
    review: {}, enrichRunner: { isRunning: () => false }, config: f.config, aiScheduler: f.scheduler, aiConnections: f.connections });
  referee.pendingGroups = () => { assert.fail('should stop before selecting groups'); };
  for (let i = 0; i < 4; i++) await referee.tick();
  assert.equal(referee.connectionStatus().state, 'paused');
  assert.equal(referee._lastError, null, 'blocked polling does not accumulate repeated errors');
}));
