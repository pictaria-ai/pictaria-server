import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateAiExecution } from '../../src/curate/ai-execution.mjs';
import { CurateAiLifecycle, AI_SETTLE_MS, MAX_AI_PENDING } from '../../src/curate/ai-lifecycle.mjs';
import { AI_WINDOW_MS, aiBackendKey } from '../../src/curate/ai-limits.mjs';
import { AiRequestScheduler } from '../../src/ai/scheduler.mjs';
import { createCurateAiProvider } from '../../src/curate/ai-config.mjs';
import { fingerprint } from '../../src/curate/contracts.mjs';

const deferred = () => Promise.withResolvers();
const availability = { stack: true, keeper: true };
async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-ai-lifecycle-'));
  const path = join(dir, 'enrichment.sqlite');
  const repo = new Repository(path); repo.initSchema();
  let now = Date.now();
  repo.curate.aiLimits.now = () => now;
  const config = { curateBurstGrouping: true, curateStackRefereeEnabled: true, curateKeeperRefereeEnabled: true,
    enrichEnabled: false, defaultProvider: 'local_ollama', providers: { local_ollama: { baseUrl: 'http://127.0.0.1:11434', modelName: 'synthetic' } } };
  const curate = new CurateService({ repo, config });
  const scheduler = new AiRequestScheduler();
  const execution = new CurateAiExecution({ attempts: repo.curate.aiAttempts, limits: repo.curate.aiLimits,
    getConfig: () => config, availability, scheduler, stopped: () => curate.closed });
  const lifecycle = new CurateAiLifecycle({ curate, execution, availability, now: () => now,
    resolveProvider: () => createCurateAiProvider(config) });
  curate.aiLifecycle = lifecycle;
  const calls = [], accepted = [];
  const add = (id, seconds = 0, extra = {}) => {
    repo.reviewListAdd([id], 'test');
    repo.upsertAsset({ id, fileCreatedAt: new Date(1_700_000_000_000 + seconds * 1000).toISOString(), ...extra });
  };
  const plan = (id = 'a', overrides = {}) => ({ role: 'stack', contract: 'synthetic-v1',
    groupId: curate.current.byMember.get(id)?.id,
    prepare: async (checkpoint, input) => { checkpoint(); return input.snapshot; },
    submit: async (input, provider) => { calls.push({ input, model: provider.modelName }); return { valid: true }; },
    validate: response => { assert.equal(response.valid, true); return response; },
    accept: (result, snapshot) => accepted.push(snapshot), ...overrides });
  const run = async () => {
    lifecycle.tick(); const job = lifecycle.active;
    if (job) await job.work;
    return job?.result;
  };
  try { await work({ repo, path, dir, config, curate, scheduler, execution, lifecycle, add, plan, calls, accepted, run,
    advance: ms => { now += ms; }, now: () => now }); }
  finally {
    await curate.close(); await scheduler.stop(1000); repo.close(); rmSync(dir, { recursive: true, force: true });
  }
}

test('settling coalesces changed material without resetting unchanged offers or spending attempts', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  await f.lifecycle.offer(f.plan()); f.advance(20_000);
  await f.lifecycle.offer(f.plan()); assert.equal(f.lifecycle.pending.size, 1);
  assert.equal(await f.run(), undefined);
  f.add('c', 2); await f.curate.refresh(); await f.lifecycle.offer(f.plan());
  assert.equal(f.lifecycle.pending.size, 1); f.advance(29_999); assert.equal(await f.run(), undefined);
  f.advance(1); assert.equal((await f.run()).state, 'succeeded');
  assert.deepEqual(f.calls[0].input.actionable, ['a', 'b', 'c']);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempts').get().n, 1);
  assert.equal((await f.lifecycle.offer(f.plan())).state, 'settled');
}));

test('one active call, only latest overlapping revision, and disjoint replacement children survive', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); f.add('c', 2); f.add('d', 3); await f.curate.refresh();
  const sent = deferred(), response = deferred();
  await f.lifecycle.offer(f.plan('a', { submit: () => { sent.resolve(); return response.promise; } }));
  f.advance(AI_SETTLE_MS); f.lifecycle.tick(); const old = f.lifecycle.active; await sent.promise;
  f.add('c', 100); f.add('d', 101); await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a')); await f.lifecycle.offer(f.plan('c'));
  f.add('b', 2); await f.curate.refresh(); await f.lifecycle.offer(f.plan('a')); await f.lifecycle.offer(f.plan('c'));
  assert.equal(f.lifecycle.pending.size, 2); f.advance(AI_SETTLE_MS); f.lifecycle.tick();
  assert.equal(f.lifecycle.active, old);
  response.resolve({ valid: true }); await old.work;
  assert.equal(old.result.state, 'stale'); assert.equal(f.accepted.length, 0);
  assert.equal((await f.run()).state, 'succeeded'); assert.equal((await f.run()).state, 'succeeded');
  assert.deepEqual(f.accepted.map(s => s.ids).sort(), [['a', 'b'], ['c', 'd']]);
}));

test('disjoint keeper batches coexist while shared context is derived and not charged', async () => fixture(async f => {
  for (const [i, id] of ['a', 'b', 'c', 'd', 'context'].entries()) f.add(id, i);
  f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES('context','frame/eligible','human','2026-01-01')").run();
  await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a', { role: 'keeper', photoIds: ['a', 'b'], includeContext: true }));
  await f.lifecycle.offer(f.plan('a', { role: 'keeper', photoIds: ['c', 'd'], includeContext: true }));
  assert.equal(f.lifecycle.pending.size, 2); f.advance(AI_SETTLE_MS);
  await f.run(); await f.run(); assert.equal(f.accepted.length, 2);
  assert.deepEqual(f.calls[0].input.contextIds, ['context']);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_photo_charges').get().n, 4);
}));

test('human decision during preparation stops dispatch even if adapter omits checkpoints', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a', { prepare: async () => {
    f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES('a','frame/reviewed','human','2026-01-01')").run();
  } })); f.advance(AI_SETTLE_MS);
  assert.equal((await f.run()).state, 'stale'); assert.equal(f.calls.length, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempts').get().n, 0);
}));

for (const change of ['new-neighbor', 'flushed-neighbor', 'human', 'context', 'separation', 'unavailable'])
  test(`paid result discarded after ${change} changes without waiting for a rebuild`, async () => fixture(async f => {
    f.add('a'); f.add('b', 1); f.add('context', 2);
    f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES('context','frame/eligible','human','2026-01-01')").run();
    await f.curate.refresh();
    const sent = deferred(), response = deferred();
    await f.lifecycle.offer(f.plan('a', { includeContext: true, submit: () => { sent.resolve(); return response.promise; } }));
    f.advance(AI_SETTLE_MS); f.lifecycle.tick(); const job = f.lifecycle.active; await sent.promise;
    if (change.includes('neighbor')) { f.add('c', 60); if (change === 'flushed-neighbor') f.repo.curate.flushIds(['c']); }
    if (change === 'human') f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES('a','frame/reviewed','human','2026-01-01')").run();
    if (change === 'context') f.repo.db.prepare("DELETE FROM asset_tags WHERE asset_id='context'").run();
    if (change === 'separation') {
      f.repo.db.prepare("INSERT INTO curate_separations VALUES('split',1,1,?,?)").run(f.now(), f.now()+1000);
      f.repo.db.exec("INSERT INTO curate_separation_members VALUES('split','a',0),('split','b',1)");
    }
    if (change === 'unavailable') f.repo.db.prepare("DELETE FROM review_list WHERE asset_id='b'").run();
    response.resolve({ valid: true }); await job.work;
    assert.equal(job.result.state, 'stale'); assert.equal(f.accepted.length, 0);
    assert.equal(f.repo.curate.aiAttempts.status('stack', job.snapshot.inputKey).attempts, 1);
  }));

test('unrelated source changes and toggle-off do not discard applicable paid work', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a', { submit: async () => {
    f.add('elsewhere', 3600); f.repo.curate.flushIds(['elsewhere']);
    f.config.curateStackRefereeEnabled = false;
    return { valid: true };
  } })); f.advance(AI_SETTLE_MS);
  assert.equal((await f.run()).state, 'succeeded'); assert.equal(f.accepted.length, 1);
  assert.equal((await f.lifecycle.offer(f.plan())).state, 'disabled');
}));

test('open comparison and deterministic checks defer work, then resume without opting out', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  let focused = true, checking = true;
  f.curate.refinement = { isFocused: () => focused, groupStatus: () => ({ state: checking ? 'checking' : 'incomplete' }), close: async () => {}, settingsChanged: () => {}, revision: 0 };
  await f.lifecycle.offer(f.plan()); f.advance(AI_SETTLE_MS); assert.equal(await f.run(), undefined);
  focused = false; assert.equal(await f.run(), undefined);
  checking = false; assert.equal((await f.run()).state, 'succeeded');
}));

test('latest saved provider/model is resolved after scheduling and pinned during preparation', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  const sent = deferred(), release = deferred();
  const session = f.scheduler.session(createCurateAiProvider(f.config), 'enrich');
  const busy = session.run(async () => { sent.resolve(); await release.promise; }); await sent.promise;
  await f.lifecycle.offer(f.plan('a', { prepare: async (_, { snapshot, provider }) => {
    assert.equal(provider.modelName, 'new-model'); f.config.providers.local_ollama.modelName = 'later-model'; return snapshot;
  } })); f.advance(AI_SETTLE_MS); f.lifecycle.tick(); const job = f.lifecycle.active;
  await setImmediate(); f.config.providers.local_ollama.modelName = 'new-model'; release.resolve(); await busy; session.close(); await job.work;
  assert.equal(job.result.state, 'succeeded'); assert.equal(f.calls[0].model, 'new-model');
}));

test('two invalid answers settle; restart, toggles and time do not reset attempts', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  const invalid = f.plan('a', { validate: () => { throw Error('bad synthetic answer'); } });
  await f.lifecycle.offer(invalid); f.advance(AI_SETTLE_MS);
  assert.equal((await f.run()).reason, 'invalid-answer'); assert.equal(f.lifecycle.pending.size, 1);
  f.advance(AI_SETTLE_MS); assert.equal((await f.run()).reason, 'invalid-answer'); assert.equal(f.lifecycle.pending.size, 0);
  f.config.curateStackRefereeEnabled = false; f.lifecycle.settingsChanged(); f.config.curateStackRefereeEnabled = true;
  f.advance(AI_WINDOW_MS * 2); f.lifecycle.maintain();
  assert.equal((await f.lifecycle.offer(invalid)).state, 'exhausted');
  const reopened = new Repository(f.path); reopened.initSchema();
  try { assert.equal(reopened.curate.aiAttempts.status('stack', f.calls[0].input.inputKey).attempts, 2); }
  finally { reopened.close(); }
}));

test('input cleanup preserves current, queued, comparison, Undo, sync and valid advice references', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  await f.lifecycle.offer(f.plan()); f.advance(AI_SETTLE_MS); await f.run();
  const old = f.accepted[0]; f.advance(AI_WINDOW_MS+1);
  assert.equal(f.lifecycle.maintain(), 0); // unchanged, even after its window
  f.add('c', 2); await f.curate.refresh();
  assert.equal(f.lifecycle.inputs.prune(new Set([old.inputKey])), 0);
  const compare = f.repo.curate.lease('comparison', { ids: ['a', 'b'] }, f.now());
  assert.equal(f.lifecycle.maintain(), 0); f.repo.curate.releaseLease(compare.id);
  f.repo.db.prepare('INSERT INTO decision_operations VALUES(?,?,?,?,?,?)')
    .run('op', 'hash', JSON.stringify({undo:{expiresAt:f.now()+1000}}), '[]', f.now(), f.now());
  f.repo.db.prepare('INSERT INTO decision_operation_members VALUES(?,?,?,?)').run('op', 'a', 1, '{}');
  assert.equal(f.lifecycle.maintain(), 0); f.advance(1001);
  f.repo.db.prepare('UPDATE decision_operations SET settled_at=NULL').run();
  assert.equal(f.lifecycle.maintain(), 0);
  f.repo.db.prepare('UPDATE decision_operations SET settled_at=?').run(f.now());
  const key = fingerprint(['a','b'].map(id => [id, f.repo.curate.photo(id).inputKey]));
  f.repo.curate.saveAdvice({role:'check',ids:['a','b'],inputKey:key,schemaVersion:'v1',result:{groups:[{ids:['a','b'],reason:'Similar'}]}});
  assert.equal(f.lifecycle.maintain(), 0);
  f.repo.db.prepare('DELETE FROM curate_advice').run();
  assert.equal(f.lifecycle.maintain(), 1);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 0);
}));

test('bounded pending queue rejects excess work and close cancels waiting jobs', async () => fixture(async f => {
  for (let i=0;i<=MAX_AI_PENDING;i++) { f.add(`a${i}`, i*1000); f.add(`b${i}`, i*1000+1); }
  await f.curate.refresh();
  for (let i=0;i<MAX_AI_PENDING;i++) assert.equal((await f.lifecycle.offer(f.plan(`a${i}`))).state, 'queued');
  assert.equal((await f.lifecycle.offer(f.plan(`a${MAX_AI_PENDING}`))).state, 'queue-full');
  f.lifecycle.close(); f.advance(AI_SETTLE_MS); assert.equal(await f.run(), undefined); assert.equal(f.calls.length, 0);
}));

test('membership churn charges the same actionable photos and window expiry cannot repair a limited input', async () => fixture(async f => {
  f.add('a'); f.add('b', 1);
  for (let i=0;i<4;i++) {
    f.add(`new${i}`, i+2); await f.curate.refresh(); await f.lifecycle.offer(f.plan()); f.advance(AI_SETTLE_MS);
    assert.equal((await f.run()).state, i<3 ? 'succeeded' : 'photo-limit');
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 4);
  f.advance(AI_WINDOW_MS+1); f.lifecycle.maintain();
  assert.equal((await f.lifecycle.offer(f.plan())).state, 'photo-limit');
  assert.equal(f.lifecycle.pending.size, 0); assert.equal(f.calls.length, 3);
}));

test('changed provider endpoint while queued obtains a new turn without charging old connection', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  const entered = deferred(), release = deferred(), original = createCurateAiProvider(f.config);
  const session = f.scheduler.session(original, 'enrich');
  const busy = session.run(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  await f.lifecycle.offer(f.plan()); f.advance(AI_SETTLE_MS); f.lifecycle.tick(); const job = f.lifecycle.active;
  await setImmediate(); f.config.providers.local_ollama.baseUrl = 'http://127.0.0.1:11435';
  release.resolve(); await busy; session.close(); await job.work;
  assert.equal(job.result.state, 'provider-changed'); assert.equal(f.calls.length, 0);
  assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempts').get().n, 0);
  f.advance(1000); assert.equal((await f.run()).state, 'succeeded');
  assert.equal(f.repo.db.prepare('SELECT backend_key FROM curate_ai_backends').get().backend_key,
    aiBackendKey(createCurateAiProvider(f.config)));
}));

test('disabling during preparation and changing scope policy cancel without paying', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a', { prepare: async () => { f.config.curateStackRefereeEnabled = false; } }));
  f.advance(AI_SETTLE_MS); assert.equal((await f.run()).state, 'disabled'); assert.equal(f.calls.length, 0);
  f.config.curateStackRefereeEnabled = true;
  f.config.curateStackRefereeScope = 'all';
  f.curate.current.byMember.get('a').route = 'candidate-supported';
  await f.lifecycle.offer(f.plan('a', { prepare: async () => { f.config.curateStackRefereeScope = 'uncertain'; } }));
  f.advance(AI_SETTLE_MS); assert.equal((await f.run()).state, 'waiting'); assert.equal(f.calls.length, 0);
}));

test('old exact duplicates arriving outside the time window invalidate basic grouping results', async () => fixture(async f => {
  f.add('a', 0, {checksum:'same'}); f.add('b', 1, {checksum:'same'}); await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a', { submit: async () => {
    f.add('c', 3600, {checksum:'same'}); f.repo.curate.flushIds(['c']); return {valid:true};
  } })); f.advance(AI_SETTLE_MS);
  assert.equal((await f.run()).state, 'stale'); assert.equal(f.accepted.length, 0);
}));

test('disjoint batches with different context envelopes do not supersede one another', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); f.add('context', 2);
  f.repo.db.prepare("INSERT INTO asset_tags(asset_id,tag,source,created_at) VALUES('context','frame/eligible','human','2026-01-01')").run();
  await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a', {role:'keeper',photoIds:['a'],includeContext:true}));
  await f.lifecycle.offer(f.plan('a', {role:'keeper',photoIds:['b'],includeContext:false}));
  assert.equal(f.lifecycle.pending.size, 2); f.advance(AI_SETTLE_MS);
  assert.equal((await f.run()).state, 'succeeded'); assert.equal((await f.run()).state, 'succeeded');
  assert.deepEqual(f.calls.map(c => c.input.contextIds), [['context'], []]);
}));

test('restart protects current exact inputs with roles off and can retire obsolete authoritative references', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh(); await f.lifecycle.offer(f.plan());
  f.advance(AI_SETTLE_MS); await f.run(); f.advance(AI_WINDOW_MS+1);
  const repo = new Repository(f.path); repo.initSchema(); repo.curate.aiLimits.now = f.now;
  const curate = new CurateService({repo,config:{curateStackRefereeEnabled:false,curateBurstGrouping:true}});
  const lifecycle = new CurateAiLifecycle({curate,execution:f.execution,resolveProvider:()=>{throw Error('Must not resolve');},availability,now:f.now});
  try {
    await curate.refresh(); assert.equal(lifecycle.maintain(), 0);
    assert.equal((await lifecycle.offer(f.plan())).state, 'disabled');
    f.add('c', 2); await curate.refresh(); assert.equal(lifecycle.maintain(), 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_inputs').get().n, 0);
  } finally { await curate.close(); repo.close(); }
}));

test('Stacks-off rebuild does not discard an applicable already submitted answer', async () => fixture(async f => {
  f.add('a'); f.add('b', 1); await f.curate.refresh();
  await f.lifecycle.offer(f.plan('a', { submit: async () => {
    f.config.curateBurstGrouping = false; await f.curate.refresh();
    assert.equal(f.curate.current.groups.length, 2); return {valid:true};
  } })); f.advance(AI_SETTLE_MS);
  assert.equal((await f.run()).state, 'succeeded'); assert.equal(f.accepted.length, 1);
  assert.equal((await f.lifecycle.offer(f.plan())).state, 'disabled');
}));
