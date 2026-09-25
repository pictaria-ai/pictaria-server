import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { CurateAiLimits, aiBackendKey, AI_WINDOW_MS } from '../../src/curate/ai-limits.mjs';

const key = n => n.toString(16).padStart(64, '0');
const backendKey = key(100);
const unavailable = () => new ProviderRequestError('PRIVATE response', { timeout: true });
async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-ai-limits-')), handles = [];
  let time = 1_000_000;
  const open = () => {
    const repo = new Repository(join(dir, 'enrich.sqlite')); repo.initSchema(); handles.push(repo);
    const limits = new CurateAiLimits(repo, { now: () => time });
    return { repo, limits, attempts: repo.curate.aiAttempts };
  };
  const f = open();
  const config = { curateBurstGrouping: true, curateStackRefereeEnabled: true, curateKeeperRefereeEnabled: true };
  let requests = 0, prepared = 0;
  const job = (n = 1, photoIds = ['a', 'b'], extra = {}) => ({ role: 'stack', inputKey: key(n), backendKey, photoIds,
    isCurrent: () => true, prepare: async checkpoint => { prepared++; checkpoint(); checkpoint(); },
    submit: async () => { requests++; return 'answer'; }, validate: x => x, accept: () => {}, ...extra });
  const execution = (owner = f) => new CurateAiExecution({ ...owner, getConfig: () => config,
    availability: { stack: true, keeper: true }, admit: () => true });
  try { await work({ ...f, open, job, execution, config, tick: ms => { time += ms; },
    counts: () => ({ requests, prepared }), time: () => time }); }
  finally { for (const repo of handles) { try { repo.close(); } catch {} }
    rmSync(dir, { recursive: true, force: true }); }
}

test('backend identity uses pinned endpoint and credentials, never model alone', () => {
  const p = { providerName: 'venice', baseUrl: 'https://provider.test/v1/', apiKey: 'private-key', modelName: 'one' };
  assert.equal(aiBackendKey(p), aiBackendKey({ ...p, baseUrl: 'https://provider.test/v1', modelName: 'two' }));
  assert.notEqual(aiBackendKey(p), aiBackendKey({ ...p, apiKey: 'corrected-key' }));
  assert.notEqual(aiBackendKey(p), aiBackendKey({ ...p, baseUrl: 'https://other.test/v1' }));
  assert.match(aiBackendKey({ providerName: 'cloud_openai', apiKey: 'k' }), /^[a-f0-9]{64}$/);
  assert.throws(() => aiBackendKey({ providerName: 'unknown' }), /endpoint/);
});

test('auth failure pauses all untouched inputs and roles before preparation, across restart', async () => fixture(async f => {
  const e = f.execution(); let calls = 0;
  const failed = f.job(1, ['a'], { submit: async () => { calls++; throw new ProviderRequestError('PRIVATE key', { status: 401 }); } });
  assert.equal((await e.run(failed)).reason, 'provider-auth');
  const reopened = f.open(), next = f.execution(reopened);
  for (let i = 2; i <= 102; i++) assert.equal((await next.run(f.job(i, [`photo-${i}`],
    { role: i % 2 ? 'stack' : 'keeper' }))).state, 'provider-paused');
  f.tick(AI_WINDOW_MS * 10);
  assert.equal((await next.run(failed)).state, 'provider-paused');
  assert.equal(calls, 1); assert.equal(f.counts().prepared, 1);
  assert.deepEqual(reopened.attempts.status('stack', key(1)), { attempts: 1, state: 'failed' });
  assert.equal(reopened.attempts.status('stack', key(3)).attempts, 0);
  assert.equal((await next.run(f.job(103, ['other'], { backendKey: key(200) }))).state, 'succeeded');
}));

test('one bounded recovery honors Retry-After; its failure pauses without further probes', async () => fixture(async f => {
  let calls = 0;
  const failed = f.job(1, ['a'], { submit: async () => { calls++; throw new ProviderRequestError('PRIVATE', { status: 429, retryAfterMs: 60_000 }); } });
  assert.equal((await f.execution().run(failed)).reason, 'provider-unavailable');
  const owner = f.open(), e = f.execution(owner);
  f.tick(30_000); assert.equal((await e.run(failed)).state, 'provider-cooldown');
  f.tick(30_000); assert.equal((await e.run(failed)).reason, 'provider-unavailable');
  f.tick(AI_WINDOW_MS * 10);
  assert.equal((await e.run(f.job(2, ['new']))).state, 'provider-paused');
  assert.equal((await e.run(failed)).state, 'exhausted');
  assert.equal(calls, 2);
  assert.equal(owner.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 2);
}));

test('successful recovery reopens provider, but retains spent attempts', async () => fixture(async f => {
  const e = f.execution();
  await e.run(f.job(1, ['a'], { submit: async () => { throw unavailable(); } }));
  f.tick(30_000);
  assert.equal((await e.run(f.job(1, ['a']))).state, 'succeeded');
  assert.equal(f.attempts.status('stack', key(1)).attempts, 2);
  assert.equal((await e.run(f.job(2, ['b']))).state, 'succeeded');
}));

test('bad answer and content rejection do not pause a healthy provider; unknown faults do', async () => fixture(async f => {
  const e = f.execution();
  for (const [n, extra] of [[1, { validate: () => { throw Error('PRIVATE invalid partition'); } }],
    [2, { submit: async () => { throw new ProviderRequestError('PRIVATE', { invalidResponse: true }); } }],
    [3, { submit: async () => { throw new ProviderRequestError('PRIVATE', { status: 400 }); } }]]) {
    assert.equal((await e.run(f.job(n, [`p${n}`], extra))).state, 'failed');
    assert.equal(f.limits.providerStatus(backendKey).state, 'ready');
  }
  await e.run(f.job(4, ['x'], { submit: async () => { throw Error('PRIVATE integration fault'); } }));
  assert.deepEqual(f.limits.providerStatus(backendKey), { state: 'paused', reason: 'configuration' });
}));

test('per-photo cap follows overlapping photos through splits/merges, independent of role or backend', async () => fixture(async f => {
  const e = f.execution();
  for (const [n, photos] of [[1, ['a', 'b']], [2, ['b', 'c']], [3, ['a', 'b', 'd']]])
    assert.equal((await e.run(f.job(n, photos))).state, 'succeeded');
  const limited = f.job(4, ['b', 'e']);
  assert.equal((await e.run(limited)).state, 'photo-limit');
  assert.equal((await e.run(f.job(5, ['b'], { backendKey: key(200) }))).state, 'photo-limit');
  assert.equal((await e.run(f.job(6, ['b'], { role: 'keeper' }))).state, 'succeeded');
  assert.equal((await e.run(f.job(7, ['e']))).state, 'succeeded');
  assert.equal(f.attempts.status('stack', key(4)).attempts, 0);
  f.tick(AI_WINDOW_MS);
  const next = f.execution(f.open());
  assert.equal((await next.run(limited)).state, 'photo-limit', 'expiry and restart do not revive limited input');
  assert.equal((await next.run(f.job(8, ['b', 'e']))).state, 'succeeded', 'new changed input can use expired allowance');
}));

test('shared kept context does not exhaust distinct stacks; retries still charge actionable photos', async () => fixture(async f => {
  const e = f.execution();
  const contextPhotoIds = ['kept-a', 'kept-b'], options = { role: 'keeper', contextPhotoIds };
  for (let n = 1; n <= 5; n++) {
    assert.equal((await e.run(f.job(n, [`stack-${n}-a`, `stack-${n}-b`, ...contextPhotoIds], options))).state, 'succeeded');
    f.tick(60_000);
  }
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 10);
  const invalid = { ...options, validate: () => { throw Error('bad answer'); } };
  const retry = f.job(6, ['stack-1-a', 'stack-1-b', ...contextPhotoIds], invalid);
  await e.run(retry); await e.run(retry);
  assert.equal((await e.run(f.job(7, retry.photoIds, options))).state, 'photo-limit');
  assert.equal((await e.run(f.job(8, ['new-a', 'new-b', ...contextPhotoIds], options))).state, 'succeeded');
  const freshOwner = f.open();
  assert.equal((await f.execution(freshOwner).run(f.job(9, ['stack-1-a', 'new-c', ...contextPhotoIds], options))).state, 'photo-limit');
}));

test('preparation checkpoints never charge; disabled or stale preparation spends nothing', async () => fixture(async f => {
  const e = f.execution();
  const extra = { prepare: async checkpoint => {
    for (let n = 0; n < 100; n++) checkpoint();
    f.config.curateStackRefereeEnabled = false; checkpoint();
  } };
  assert.equal((await e.run(f.job(1, ['a'], extra))).state, 'disabled');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 0);
  f.config.curateStackRefereeEnabled = true;
  assert.equal((await e.run(f.job())).state, 'succeeded');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 2);
}));

test('atomic admission rolls back all ledgers on database failure', async () => fixture(async f => {
  f.repo.db.exec("CREATE TRIGGER fail_budget BEFORE INSERT ON curate_ai_photo_charges BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  assert.throws(() => f.limits.start(f.job(), f.attempts), /synthetic/);
  assert.equal(f.attempts.status('stack', key(1)).attempts, 0);
  assert.equal(f.limits.providerStatus(backendKey).state, 'ready');
}));

test('interrupted ordinary dispatch gets one recovery opportunity, without refund or restart reset', async () => fixture(async f => {
  const ticket = f.limits.start(f.job(), f.attempts);
  const other = f.open();
  assert.equal(other.limits.providerStatus(backendKey).state, 'busy', 'repository open never steals request');
  assert.equal(other.limits.start(f.job(2), other.attempts).state, 'provider-busy');
  assert.equal(other.limits.recoverInterrupted(other.attempts), 1);
  assert.equal(other.attempts.status('stack', key(1)).attempts, 1);
  const recovery = other.limits.providerStatus(backendKey);
  assert.deepEqual(recovery, { state: 'cooldown', reason: 'interrupted', retryAt: f.time() + 30_000 });
  assert.equal(f.limits.finish(ticket), false);
  assert.equal(f.attempts.finish(ticket, 'succeeded'), false);
  f.tick(10_000);
  assert.equal(other.limits.recoverInterrupted(other.attempts), 0);
  assert.deepEqual(other.limits.providerStatus(backendKey), recovery);
  assert.equal((await f.execution(other).run(f.job())).state, 'provider-cooldown');
  f.tick(20_000);
  assert.equal((await f.execution(other).run(f.job())).state, 'succeeded');
  assert.equal(other.attempts.status('stack', key(1)).attempts, 2);
}));

test('a crash during recovery leaves the connection paused even after another restart and six hours', async () => fixture(async f => {
  const first = f.limits.start(f.job(), f.attempts);
  f.limits.recoverInterrupted(f.attempts);
  f.tick(30_000);
  const recovery = f.limits.start(f.job(), f.attempts);
  assert.equal(recovery.state, 'started');
  const owner = f.open();
  assert.equal(owner.limits.recoverInterrupted(owner.attempts), 1);
  assert.deepEqual(owner.limits.providerStatus(backendKey), { state: 'paused', reason: 'interrupted' });
  assert.equal(owner.attempts.status('stack', key(1)).attempts, 2);
  f.tick(6 * 60 * 60_000);
  assert.equal(owner.limits.recoverInterrupted(owner.attempts), 0);
  assert.equal((await f.execution(owner).run(f.job(2, ['new']))).state, 'provider-paused');
  assert.equal(f.limits.finish(first), false);
  assert.equal(f.limits.finish(recovery), false);
  assert.equal(owner.limits.connectionVerified(backendKey), true);
  assert.equal((await f.execution(owner).run(f.job())).state, 'exhausted', 'explicit verification does not refund work');
  assert.equal((await f.execution(owner).run(f.job(2, ['new']))).state, 'succeeded');
}));

test('context exemptions are a bounded subset and cannot change during preparation', async () => fixture(async f => {
  const e = f.execution();
  for (const [ids, context] of [
    [['a', 'b'], ['a', 'b']], [['a', 'b'], ['absent']], [['a', 'b'], ['b', 'b']],
    [Array.from({ length: 10 }, (_, i) => `p${i}`), Array.from({ length: 9 }, (_, i) => `p${i}`)],
    [Array.from({ length: 31 }, (_, i) => `p${i}`), ['p0']],
  ]) await assert.rejects(e.run(f.job(1, ids, { contextPhotoIds: context })), /identity/);
  const contextPhotoIds = ['kept'];
  assert.equal((await e.run(f.job(1, ['pending', 'kept'], { contextPhotoIds,
    prepare: async checkpoint => { contextPhotoIds.push('pending'); checkpoint(); } }))).state, 'succeeded');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 1);
}));

test('interrupted recovery and cancellation do not grant another recovery attempt', async () => fixture(async f => {
  await f.execution().run(f.job(1, ['a'], { submit: async () => { throw unavailable(); } }));
  f.tick(30_000);
  const ticket = f.limits.start(f.job(1, ['a']), f.attempts);
  assert.equal(f.limits.connectionVerified(backendKey), false, 'connection check cannot release active owner');
  f.limits.finish(ticket, new ProviderRequestError('cancelled', { cancelled: true }));
  f.attempts.finish(ticket, 'failed');
  assert.equal(f.limits.providerStatus(backendKey).state, 'paused');
}));

test('cleanup keeps current/comparison-referenced inputs and pauses, retires only nominated old inactive records', async () => fixture(async f => {
  const e = f.execution();
  await e.run(f.job(1, ['a'])); await e.run(f.job(2, ['b']));
  assert.equal(f.limits.pruneObsolete([{ role: 'stack', inputKey: key(1) }]), 0);
  const running = f.limits.start(f.job(3, ['c']), f.attempts);
  f.tick(AI_WINDOW_MS + 1);
  assert.equal(f.limits.pruneObsolete([{ role: 'stack', inputKey: key(1) }, { role: 'stack', inputKey: key(3) }]), 1);
  assert.equal(f.attempts.status('stack', key(2)).state, 'succeeded');
  assert.equal(f.attempts.status('stack', key(3)).state, 'running');
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempt_age WHERE input_key=?').get(key(1)).n, 0);
  f.limits.finish(running, new ProviderRequestError('PRIVATE', { status: 403 }));
  f.attempts.finish(running, 'failed');
  f.tick(AI_WINDOW_MS + 1); f.limits.pruneObsolete();
  assert.equal(f.limits.providerStatus(backendKey).state, 'paused');
  const saved = JSON.stringify(f.repo.db.prepare('SELECT * FROM curate_ai_backends').all());
  assert.ok(!saved.includes('PRIVATE'));
}));

test('missing, duplicated and oversized participant lists fail before preparing or submitting', async () => fixture(async f => {
  for (const photos of [[], ['x', 'x'], new Array(31).fill(0).map((_, i) => `p${i}`), [''], [null]])
    await assert.rejects(f.execution().run(f.job(1, photos)), /identity/);
  assert.deepEqual(f.counts(), { requests: 0, prepared: 0 });
}));
