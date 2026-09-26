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
import { EnrichScheduler } from '../../src/enrich/scheduler.mjs';
import { analyzeWithValidationRetry, PROVIDER_RETRY_AFTER_CAP_MS } from '../../src/enrich/runner.mjs';
import { AiRequestScheduler } from '../../src/ai/scheduler.mjs';
import { AiConnections } from '../../src/ai/connections.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { aiBackendKey, AI_RECOVERY_COOLDOWN_MS } from '../../src/curate/ai-limits.mjs';
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
  const runner = (overrides = {}) => new EnrichJobRunner({ repo, immich, taxonomy, config, aiScheduler: scheduler, aiConnections: connections, ...overrides });
  try { await work({ repo, limits, scheduler, config, connections, runner, tick: ms => { now += ms; }, time: () => now }); }
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

test('Enrich overload waits once, then stops for a longer cooldown without waiting or probing again', async () => fixture(async f => {
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
  assert.deepEqual(f.connections.status(p), { state: 'cooldown', reason: 'unavailable', retryAt: f.time() + AI_RECOVERY_COOLDOWN_MS });
  await assert.rejects(f.connections.run(p, () => assert.fail('cooldown request')), { code: 'ai_connection_paused' });
  f.tick(AI_RECOVERY_COOLDOWN_MS);
  for (let i = 0; i < 20; i++) assert.equal(f.connections.describe()[0].state, 'recovery-ready');
  assert.equal(calls, 2);
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return answer(sampleOutput()); };
  const runner = f.runner(); runner.start({ assetIds: ['new'] }); await runner.runPromise;
  assert.equal(runner.status().error, null); assert.equal(calls, 3);
  assert.equal(f.connections.status(p).state, 'ready');
}));

test('a failed scheduled recovery stops once; only the next daily run resumes healthy Enrich', async () => fixture(async f => {
  let calls = 0;
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return rejected(503); };
  const p = f.connections.provider('enrich');
  await assert.rejects(f.connections.run(p, () => p.analyzeImage({ data: Buffer.from('test'), mimeType: 'image/jpeg' },
    { systemPrompt: 'system', userPrompt: 'user', jsonSchema: {} })), { status: 503 });
  f.tick(30_000);
  f.config.enrichSchedule = { enabled: true, time: '00:00', timeZone: 'UTC', photoBudget: 4 };
  const runner = f.runner({ immich: { ...immich,
    listImageAssets: async () => Array.from({ length: 4 }, (_, i) => ({ id: `daily-${i}`, originalPath: `${i}.jpg` })) } });
  const daily = new EnrichScheduler({ runner, repo: f.repo, config: f.config, log: () => {} });
  const today = new Date();
  assert.equal(daily.tick(today), true); await runner.runPromise;
  assert.match(runner.status().error, /cooling down/);
  assert.equal(calls, 2, 'a run starting as recovery must not wait fifteen minutes and retry');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM processing_runs').get().n, 1);
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return answer(sampleOutput()); };
  f.tick(AI_RECOVERY_COOLDOWN_MS);
  assert.equal(daily.tick(today), false, 'cooldown expiry does not restart today’s stopped run');
  assert.equal(calls, 2);
  f.tick(24 * 60 * 60_000);
  assert.equal(daily.tick(new Date(today.getTime() + 24 * 60 * 60_000)), true); await runner.runPromise;
  assert.equal(runner.status().error, null);
  assert.equal(runner.status().counters.succeeded, 4);
  assert.equal(calls, 6);
  assert.equal(f.connections.status(p).state, 'ready');
  daily.stop();
}));

test('shared Enrich only waits in-run through five minutes, preserving longer provider deadlines', async () => {
  for (const delay of [PROVIDER_RETRY_AFTER_CAP_MS, PROVIDER_RETRY_AFTER_CAP_MS + 1000, 24 * 60 * 60_000]) {
    await fixture(async f => {
      let calls = 0, waited = 0;
      f.config.providers.local_lmstudio.fetchImpl = async () => ++calls === 1 ? rejected(429, String(delay / 1000)) : answer(sampleOutput());
      const p = f.connections.provider('enrich'), session = f.scheduler.session(p, 'enrich');
      const retryAt = f.time() + delay;
      try {
        const result = analyzeWithValidationRetry(p, { data: Buffer.from('test'), mimeType: 'image/jpeg' }, {
          taxonomy, systemPrompt: 'system', userPrompt: 'user', jsonSchema: {}, aiSession: session, aiConnections: f.connections,
          retrySleep: async ms => { waited += ms; f.tick(ms); },
        });
        if (delay <= PROVIDER_RETRY_AFTER_CAP_MS) {
          await result; assert.equal(calls, 2); assert.equal(waited, delay);
          assert.equal(f.connections.status(p).state, 'ready');
        } else {
          await assert.rejects(result, { status: 429 });
          assert.equal(calls, 1); assert.equal(waited, 0);
          assert.deepEqual(f.connections.status(p), { state: 'cooldown', reason: 'unavailable', retryAt });
        }
      } finally { session.close(); }
    });
  }
});

test('a day-long provider wait stops Enrich promptly, retains its queue and blocks requests until the full deadline', { timeout: 5000 }, async () => fixture(async f => {
  const day = 24 * 60 * 60_000;
  let calls = 0, finished = 0;
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return rejected(429, String(day / 1000)); };
  const runner = f.runner();
  runner.start({ assetIds: ['first', 'untouched'], onFinished: () => { finished++; } }); await runner.runPromise;
  assert.equal(runner.isRunning(), false); assert.match(runner.status().error, /cooling down/);
  assert.equal(calls, 1); assert.equal(finished, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM processing_runs').get().n, 1);
  assert.equal(f.repo.db.prepare('SELECT status FROM processing_runs').get().status, 'failed_infra');
  f.tick(day - 1);
  const blocked = f.runner(); blocked.start({ assetIds: ['first', 'untouched'] }); await blocked.runPromise;
  assert.equal(calls, 1); assert.equal(blocked.status().liveCounters.failed, 0);
  f.tick(1);
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return answer(sampleOutput()); };
  const resumed = f.runner(); resumed.start({ assetIds: ['first', 'untouched'], onFinished: () => { finished++; } }); await resumed.runPromise;
  assert.equal(resumed.status().error, null); assert.equal(resumed.status().counters.succeeded, 2);
  assert.equal(calls, 3); assert.equal(finished, 1);
}));

test('Cancel and graceful shutdown during Enrich recovery allow later work after the longer cooldown', { timeout: 5000 }, async () => {
  for (const action of ['cancel', 'stop']) await fixture(async f => {
    const p = f.connections.provider('enrich'), key = aiBackendKey(p);
    f.limits.finish(f.limits.startProvider(key), new ProviderRequestError('temporary', { status: 503 }));
    f.tick(30_000);
    const started = Promise.withResolvers(); let calls = 0, finished = 0;
    f.config.providers.local_lmstudio.fetchImpl = async (_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started.resolve();
      });
    };
    const runner = f.runner(); runner.start({ assetIds: ['first', 'untouched'], onFinished: () => { finished++; } });
    await started.promise; await runner[action](); await runner.runPromise;
    assert.equal(runner.isRunning(), false); assert.equal(calls, 1); assert.equal(finished, 0);
    assert.deepEqual(f.connections.status(p), { state: 'cooldown', reason: 'interrupted', retryAt: f.time() + AI_RECOVERY_COOLDOWN_MS });
    f.tick(AI_RECOVERY_COOLDOWN_MS - 1);
    await assert.rejects(f.connections.run(p, () => assert.fail('early recovery')), { code: 'ai_connection_paused' });
    f.tick(1);
    f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return answer(sampleOutput()); };
    const next = f.runner(); next.start({ assetIds: ['first', 'untouched'] }); await next.runPromise;
    assert.equal(next.status().error, null); assert.equal(calls, 3);
  });
});

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

test('a temporary verification failure cools down and status reads never send a request', async () => fixture(async f => {
  let calls = 0;
  f.config.providers.local_lmstudio.fetchImpl = async () => { calls++; return rejected(503); };
  const result = await f.connections.verify('curate');
  assert.equal(result.verified, false); assert.match(result.message, /cooling down/);
  f.tick(AI_RECOVERY_COOLDOWN_MS - 1);
  assert.equal(f.connections.describe()[0].state, 'cooldown');
  f.tick(1);
  for (let i = 0; i < 20; i++) assert.equal(f.connections.describe()[0].state, 'recovery-ready');
  assert.equal(calls, 1);
}));

test('a temporary verification failure cannot automatically reopen an authentication or configuration pause', async () => fixture(async f => {
  const p = f.connections.provider('enrich'), key = aiBackendKey(p);
  f.config.providers.local_lmstudio.fetchImpl = async () => rejected(503);
  for (const [status, reason] of [[401, 'auth'], [404, 'configuration']]) {
    f.limits.finish(f.limits.startProvider(key, { verification: true }), new ProviderRequestError('rejected', { status }));
    assert.equal((await f.connections.verify('enrich')).verified, false);
    f.tick(24 * 60 * 60_000);
    assert.deepEqual(f.connections.status(p), { state: 'paused', reason });
    await assert.rejects(f.connections.run(p, () => assert.fail('unverified connection')), { code: 'ai_connection_paused' });
  }
}));

test('missing saved provider settings have a neutral unconfigured status', async () => fixture(async f => {
  f.config.providers.local_lmstudio.modelName = '';
  for (const row of f.connections.describe()) {
    assert.equal(row.state, 'not-configured'); assert.equal(row.canVerify, false);
    assert.match(row.message, /^Not configured\./);
  }
  assert.equal(f.runner().status().aiConnection.state, 'not-configured');
  assert.match(f.runner().status().aiConnection.message, /^Not configured\./);
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
  assert.deepEqual(f.limits.providerStatus(key), { state: 'cooldown', reason: 'unavailable', retryAt: f.time() + AI_RECOVERY_COOLDOWN_MS });
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
