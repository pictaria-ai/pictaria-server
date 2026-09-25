import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { AiRequestScheduler, AiSchedulingCancelled, aiResourceKey, ENRICH_TURN_CALLS, ENRICH_TURN_MS } from '../../src/ai/scheduler.mjs';

const provider = (baseUrl = 'http://model.test:8000/v1', extra = {}) => ({ providerName: 'openai_compatible', baseUrl, modelName: 'a', ...extra });
const deferred = () => Promise.withResolvers();
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return { now: () => now,
    setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; },
    clearTimer: key => timers.delete(key),
    advance(ms) { now += ms; for (const [key, t] of timers) if (t.at <= now) { timers.delete(key); t.fn(); } },
    get timers() { return timers.size; },
  };
}
async function fixture(fn) {
  const time = clock(), scheduler = new AiRequestScheduler(time);
  try { await fn(scheduler, time); }
  finally { await scheduler.stop(10); }
}

test('resource identity groups models, credentials, API paths and loopback aliases conservatively', () => {
  const key = aiResourceKey(provider('http://localhost:8000/v1', { apiKey: 'private' }));
  assert.match(key, /^[a-f0-9]{64}$/);
  for (const url of ['http://127.0.0.1:8000/api/', 'http://[::1]:8000/v2'])
    assert.equal(aiResourceKey(provider(url, { providerName: 'local_ollama', modelName: 'other', apiKey: 'different' })), key);
  assert.notEqual(aiResourceKey(provider('http://other.test:8000/v1')), key);
  assert.notEqual(aiResourceKey(provider('http://localhost:9000/v1')), key);
  assert.throws(() => aiResourceKey({ providerName: 'unknown' }), /endpoint/);
  assert.equal(ENRICH_TURN_CALLS, 10); assert.equal(ENRICH_TURN_MS, 300_000);
});

test('ten Enrich calls share a turn across downloads/persistence; Curate gets one call', async () => fixture(async (s, t) => {
  const enrich = s.session(provider(), 'enrich'), curate = s.session(provider(), 'curate');
  const order = [];
  const e = (async () => {
    for (let i = 1; i <= 22; i++) {
      await enrich.run(() => { order.push(`e${i}`); t.advance(10_000); });
      await turn(); // real asynchronous work between individual photos
    }
    enrich.close();
  })();
  const c = (async () => { for (let i = 1; i <= 3; i++) await curate.run(() => order.push(`c${i}`)); curate.close(); })();
  await Promise.all([e, c]);
  assert.deepEqual(order, [
    ...Array.from({length:10},(_,i)=>`e${i+1}`),'c1',
    ...Array.from({length:10},(_,i)=>`e${i+11}`),'c2','e21','e22','c3',
  ]);
}));

for (const [duration, count] of [[20_000, 10], [70_000, 5], [310_000, 1]])
  test(`a ${duration}ms Enrich call yields after ${count}, without preemption`, async () => fixture(async (s, t) => {
    const e = s.session(provider(), 'enrich'), c = s.session(provider(), 'curate'), order = [];
    await Promise.all([(async () => { for (let i=0;i<12;i++) await e.run(() => { order.push('e'); t.advance(duration); }); e.close(); })(),
      c.run(() => order.push('c'))]);
    assert.equal(order.indexOf('c'), count);
  }));

test('five-minute deadline yields during a gap between photos, with no new Enrich call needed', async () => fixture(async (s, t) => {
  const e = s.session(provider(), 'enrich'), c = s.session(provider(), 'curate');
  await e.run(() => {});
  let ran = false; const request = c.run(() => { ran = true; });
  await turn(); assert.equal(ran, false);
  t.advance(299_999); await turn(); assert.equal(ran, false);
  t.advance(1); await request; assert.equal(ran, true);
}));

test('a late-arriving Curate request does not grant an already-used Enrich turn a fresh budget', async () => fixture(async s => {
  const e = s.session(provider(), 'enrich'), c = s.session(provider(), 'curate'), order = [];
  for (let i=0;i<12;i++) await e.run(() => {}); // no waiting Curate: no artificial stop
  await Promise.all([e.run(() => order.push('e')), c.run(() => order.push('c'))]);
  assert.deepEqual(order, ['c','e']);
}));

test('long active requests finish after deadline; waiting requests never overlap them', async () => fixture(async (s,t) => {
  const e = s.session(provider(), 'enrich'), c = s.session(provider(), 'curate'), gate = deferred();
  const active = e.run(() => gate.promise); await turn();
  let ran = false; const waiting = c.run(() => { ran = true; });
  t.advance(600_000); await turn(); assert.equal(ran, false);
  gate.resolve(); await Promise.all([active, waiting]); assert.equal(ran, true);
}));

test('an Enrich error/backoff releases its turn; other work is not held for five minutes', async () => fixture(async s => {
  const e = s.session(provider(), 'enrich'), c = s.session(provider(), 'curate'), order=[];
  const first = e.run(() => { order.push('failure'); throw Error('synthetic'); });
  const other = c.run(() => order.push('curate'));
  await assert.rejects(first, /synthetic/); await other;
  await e.run(() => order.push('retry'));
  assert.deepEqual(order,['failure','curate','retry']);
}));

test('Enrich-only and Curate-only work proceed continuously', async () => fixture(async s => {
  for (const lane of ['enrich','curate']) {
    const session = s.session(provider(),lane); let calls=0;
    for (let i=0;i<15;i++) await session.run(() => calls++);
    assert.equal(calls,15); session.close();
  }
}));

test('independent endpoints overlap; a settings/model change cannot move a pinned session', async () => fixture(async s => {
  const p=provider(), gate=deferred();
  const e=s.session(p,'enrich'), same=s.session(provider(undefined,{modelName:'b'}),'curate');
  p.baseUrl='http://other.test/v1'; p.modelName='new';
  const different=s.session(p,'enrich');
  const active=e.run(() => gate.promise); await turn();
  let sameRan=false; const waiting=same.run(() => {sameRan=true;});
  await different.run(() => 'independent'); assert.equal(sameRan,false);
  gate.resolve(); await active; e.close(); await waiting;
}));

test('both Curate roles share one global slot, even across independent backends', async () => fixture(async s => {
  const stack=s.session(provider(),'curate'), photo=s.session(provider('http://other.test/v1'),'curate'), gate=deferred();
  const first=stack.run(() => gate.promise); await turn();
  let ran=false; const next=photo.run(() => {ran=true;}); await turn(); assert.equal(ran,false);
  gate.resolve(); await Promise.all([first,next]); assert.equal(ran,true);
}));

test('preferred upcoming comparisons cannot starve the oldest background comparison', async () => fixture(async s => {
  const gate=deferred(), order=[];
  const active=s.session(provider(),'curate').run(() => gate.promise); await turn();
  const sessions=[s.session(provider(),'curate'), ...Array.from({length:5},()=>s.session(provider(),'curate',{priority:true}))];
  const requests=sessions.map((session,i)=>session.run(()=>order.push(i)));
  gate.resolve(); await Promise.all([active,...requests]);
  assert.deepEqual(order,[1,2,0,3,4,5]);
}));

test('queued cancellation and a disabled role do not run, consume a turn, or block other work', async () => fixture(async s => {
  const gate=deferred(), e=s.session(provider(),'enrich');
  const active=e.run(()=>gate.promise); await turn();
  const abort=new AbortController(); let enabled=true;
  const cancelled=s.session(provider(),'curate',{signal:abort.signal});
  const disabled=s.session(provider(),'curate',{eligible:()=>enabled});
  const a=assert.rejects(cancelled.run(()=>assert.fail('cancelled work ran')), AiSchedulingCancelled);
  const b=assert.rejects(disabled.run(()=>assert.fail('disabled work ran')), AiSchedulingCancelled);
  abort.abort(); enabled=false; s.refresh(); await Promise.all([a,b]);
  gate.resolve(); await active;
  await e.run(()=>{}); // no false competitor retained
}));

test('shutdown rejects queued work and drains the active call without aborting it', async () => fixture(async s => {
  const gate=deferred(); const active=s.session(provider(),'enrich').run(()=>gate.promise); await turn();
  const waiting=assert.rejects(s.session(provider(),'curate').run(()=>assert.fail()),AiSchedulingCancelled);
  const stopped=s.stop(1000); await waiting;
  assert.throws(()=>s.session(provider(),'enrich'),AiSchedulingCancelled);
  gate.resolve('complete'); assert.equal(await active,'complete'); assert.equal(await stopped,true);
}));

test('session close and explicit yield release unused time; completed sessions leave no timers', async () => fixture(async (s,t) => {
  const e=s.session(provider(),'enrich'), c=s.session(provider(),'curate');
  await e.run(()=>{}); const waiting=c.run(()=>{}); await turn(); assert.equal(t.timers,1);
  e.yield(); await waiting; assert.equal(t.timers,0);
  e.close();c.close();await turn();assert.equal(s.sessions.size,0);assert.equal(s.resources.size,0);
}));
