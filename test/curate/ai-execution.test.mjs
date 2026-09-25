import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';

const key = 'a'.repeat(64), other = 'b'.repeat(64);
const deferred = () => Promise.withResolvers();
async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-ai-execution-'));
  const path = join(dir, 'enrichment.sqlite');
  const handles = [];
  const open = () => {
    const repo = new Repository(path); repo.initSchema(); handles.push(repo); return repo;
  };
  const repo = open();
  const config = { curateBurstGrouping: true, curateStackRefereeEnabled: true,
    curateKeeperRefereeEnabled: true, enrichEnabled: false };
  const execution = (overrides = {}) => new CurateAiExecution({ attempts: repo.curate.aiAttempts,
    getConfig: () => config, availability: { stack: true, keeper: true }, admit: () => true, ...overrides });
  let preparations = 0, requests = 0, accepted = 0;
  const job = (overrides = {}) => ({ role: 'stack', inputKey: key, isCurrent: () => true,
    prepare: async () => { preparations++; return 'private rendition'; },
    submit: async () => { requests++; return 'private response'; },
    validate: response => response,
    accept: () => { accepted++; }, ...overrides });
  try { await work({ repo, open, config, execution, job,
    counts: () => ({ preparations, requests, accepted }) }); }
  finally {
    for (const repo of handles) { try { repo.close(); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('role gates cover all combinations independently of Enrich', async () => fixture(async f => {
  for (const stacks of [false, true]) for (const stack of [false, true])
    for (const keeper of [false, true]) for (const enrich of [false, true]) {
      Object.assign(f.config, { curateBurstGrouping: stacks, curateStackRefereeEnabled: stack,
        curateKeeperRefereeEnabled: keeper, enrichEnabled: enrich });
      for (const role of ['stack', 'keeper']) {
        // Fresh input per experiment, not a way to bypass the future churn guard.
        const inputKey = (++counter).toString(16).padStart(64, '0');
        const result = await f.execution().run(f.job({ role, inputKey }));
        assert.equal(result.state, stacks && (role === 'stack' ? stack : keeper) ? 'succeeded' : 'disabled');
      }
    }
}));
let counter = 0;

test('server availability and mandatory admission fail closed before preparation', async () => fixture(async f => {
  for (const options of [{ availability: undefined }, { admit: undefined },
    { admit: async () => true }, { stopped: () => true }]) {
    const state = (await f.execution(options).run(f.job())).state;
    assert.ok(['disabled', 'waiting', 'stopped'].includes(state));
  }
  assert.deepEqual(f.counts(), { preparations: 0, requests: 0, accepted: 0 });
}));

for (const field of ['curateBurstGrouping', 'curateStackRefereeEnabled'])
  test(`switching ${field} off during preparation prevents submission without spending an attempt`, async () => fixture(async f => {
    const ready = deferred(), finish = deferred();
    const run = f.execution().run(f.job({ prepare: async checkpoint => {
      checkpoint(); ready.resolve(); await finish.promise; checkpoint();
      assert.fail('must stop before the next download');
    } }));
    await ready.promise; f.config[field] = false; finish.resolve();
    assert.equal((await run).state, 'disabled');
    assert.equal(f.counts().requests, 0);
    assert.equal(f.repo.curate.aiAttempts.status('stack', key).attempts, 0);
  }));

test('final submission gate catches a preparation adapter that did not checkpoint', async () => fixture(async f => {
  const result = await f.execution().run(f.job({ prepare: async () => { f.config.curateKeeperRefereeEnabled = false; }, role: 'keeper' }));
  assert.equal(result.state, 'disabled'); assert.equal(f.counts().requests, 0);
}));

test('provider/cohort admission and shutdown are rechecked after preparation', async () => fixture(async f => {
  let allowed = true, stopped = false;
  const e = f.execution({ admit: () => allowed, stopped: () => stopped });
  assert.equal((await e.run(f.job({ prepare: async () => { allowed = false; } }))).state, 'waiting');
  allowed = true;
  assert.equal((await e.run(f.job({ prepare: async () => { stopped = true; } }))).state, 'stopped');
  assert.equal(f.counts().requests, 0);
}));

test('submitted work may finish after disable, but a disabled dependent role cannot start', async () => fixture(async f => {
  const sent = deferred(), response = deferred();
  const e = f.execution();
  const run = e.run(f.job({ submit: () => { sent.resolve(); return response.promise; } }));
  await sent.promise; f.config.curateStackRefereeEnabled = false; f.config.curateKeeperRefereeEnabled = false;
  response.resolve('answer');
  assert.equal((await run).state, 'succeeded'); assert.equal(f.counts().accepted, 1);
  assert.equal((await e.run(f.job({ role: 'keeper' }))).state, 'disabled');
}));

test('changes before submission or during inference invalidate the job', async () => fixture(async f => {
  let current = true;
  const e = f.execution();
  assert.equal((await e.run(f.job({ isCurrent: () => current, prepare: async () => { current = false; } }))).state, 'stale');
  assert.equal(f.counts().requests, 0);
  current = true;
  assert.equal((await e.run(f.job({ isCurrent: () => current, submit: async () => { current = false; } }))).state, 'stale');
  assert.equal(f.counts().accepted, 0);
  assert.deepEqual(f.repo.curate.aiAttempts.status('stack', key), { attempts: 1, state: 'stale' });
  current = true;
  assert.equal((await e.run(f.job())).state, 'settled');
}));

test('validation cannot make stale results applicable; acceptance is atomic with success accounting', async () => fixture(async f => {
  const e = f.execution(); let current = true;
  assert.equal((await e.run(f.job({ isCurrent: () => current, validate: () => { current = false; } }))).state, 'stale');
  assert.equal(f.counts().accepted, 0);
  const before = f.repo.curate.generation();
  const failed = await e.run(f.job({ inputKey: other, accept: () => {
    f.repo.curate.bump(); throw new Error('synthetic write failure');
  } }));
  assert.equal(failed.reason, 'acceptance-failed');
  assert.equal(f.repo.curate.generation(), before);
  assert.deepEqual(f.repo.curate.aiAttempts.status('stack', other), { attempts: 1, state: 'failed' });
}));

test('concurrent work is blocked during preparation and across roles/instances during submission', async () => fixture(async f => {
  const ready = deferred(), finish = deferred();
  const e = f.execution();
  const run = e.run(f.job({ prepare: async () => { ready.resolve(); await finish.promise; } }));
  await ready.promise;
  assert.equal((await e.run(f.job({ role: 'keeper' }))).state, 'busy');
  finish.resolve(); assert.equal((await run).state, 'succeeded');
  const sent = deferred(), answer = deferred();
  const second = e.run(f.job({ inputKey: other, submit: () => { sent.resolve(); return answer.promise; } }));
  await sent.promise;
  const repo2 = f.open();
  assert.equal(repo2.curate.aiAttempts.start('keeper', other).state, 'busy');
  assert.equal((await f.execution().run(f.job({ role: 'keeper' }))).state, 'busy');
  answer.resolve('answer'); await second;
}));

test('failure then restart allows only one further invocation and never stores raw errors', async () => fixture(async f => {
  let calls = 0;
  const job = f.job({ submit: async () => { calls++; throw new ProviderRequestError('SECRET request body', { timeout: true }); } });
  assert.equal((await f.execution().run(job)).reason, 'provider-unavailable');
  f.repo.close(); const repo2 = f.open();
  const e = f.execution({ attempts: repo2.curate.aiAttempts });
  assert.equal((await e.run(job)).reason, 'provider-unavailable');
  assert.equal((await e.run(job)).state, 'exhausted');
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(repo2.db.prepare('SELECT * FROM curate_ai_attempts').all()), /SECRET|request body/);
}));

test('interrupted work keeps its charge; recovery is explicit and stale completion cannot release new work', async () => fixture(async f => {
  const old = f.repo.curate.aiAttempts.start('stack', key);
  f.repo.close(); const repo2 = f.open(), store = repo2.curate.aiAttempts;
  assert.equal(store.eligibility('keeper', key), 'busy');
  assert.equal(store.recoverInterrupted(), 1);
  const retry = store.start('stack', key);
  assert.equal(retry.attempts, 2);
  assert.equal(store.finish(old, 'succeeded'), false);
  assert.equal(store.eligibility('keeper', key), 'busy');
  assert.equal(store.finish(retry, 'failed'), true);
  assert.equal(store.start('stack', key).state, 'exhausted');
}));

test('successful work remains settled across restart and has independent role accounting', async () => fixture(async f => {
  await f.execution().run(f.job()); f.repo.close();
  const reopened = f.open();
  const e = f.execution({ attempts: reopened.curate.aiAttempts });
  assert.equal((await e.run(f.job())).state, 'settled');
  assert.equal((await e.run(f.job({ role: 'keeper' }))).state, 'succeeded');
  assert.equal(f.counts().requests, 2);
}));

test('bad answers are local failures, distinct from provider auth/outage and preparation errors', async () => fixture(async f => {
  const cases = [
    ['prepare', new Error('private missing image'), 'preparation-failed'],
    ['validate', new Error('private invalid membership'), 'invalid-answer'],
    ['submit', new ProviderRequestError('private credentials', { status: 401 }), 'provider-auth'],
    ['submit', new ProviderRequestError('private rejection', { status: 404 }), 'provider-rejected'],
  ];
  for (const [phase, error, reason] of cases) {
    const inputKey = (++counter).toString(16).padStart(64, '0');
    const result = await f.execution().run(f.job({ inputKey, [phase]: () => { throw error; } }));
    assert.deepEqual(result, { state: 'failed', reason, phase });
  }
}));

test('attempt store rejects unsupported roles, non-digest identities and forged completion tickets', async () => fixture(async f => {
  const store = f.repo.curate.aiAttempts;
  assert.throws(() => store.start('unknown', key));
  assert.throws(() => store.start('stack', 'raw private metadata'));
  const ticket = store.start('stack', key);
  assert.equal(store.finish({ ...ticket, token: 'wrong' }, 'succeeded'), false);
  assert.equal(store.status('stack', key).state, 'running');
}));

test('async validation/acceptance is an adapter error, retaining the dispatched attempt', async () => fixture(async f => {
  for (const phase of ['validate', 'accept']) for (const rejects of [false, true]) {
    const inputKey = (++counter).toString(16).padStart(64, '0');
    const before = f.repo.curate.generation();
    const result = await f.execution().run(f.job({ inputKey, [phase]: () => {
      if (phase === 'accept') f.repo.curate.bump();
      return rejects ? Promise.reject(new Error('private adapter detail')) : Promise.resolve('answer');
    } }));
    assert.deepEqual(result, { state: 'failed', reason: 'adapter-error', phase });
    assert.deepEqual(f.repo.curate.aiAttempts.status('stack', inputKey), { attempts: 1, state: 'failed' });
    assert.equal(f.repo.curate.generation(), before, 'synchronous acceptance writes roll back');
  }
  assert.equal(f.counts().requests, 4);
  assert.equal(f.counts().accepted, 0, 'async validation never reaches acceptance');
}));
