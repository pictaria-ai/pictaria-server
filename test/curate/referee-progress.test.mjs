import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateRefereeProgress } from '../../src/curate/referee-progress.mjs';
import { refereeProgress } from '../../public/curate/referee-status.js';

const status = (state, extra = {}) => ({ state, ...extra });

test('progress covers the pending library across pagination, filters and Decided, without queue or inference work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-referee-progress-'));
  const repo = new Repository(join(dir, 'test.sqlite')); repo.initSchema(); repo.databasePath = ':memory:';
  const curate = new CurateService({ repo, metadataOptions: { automatic: false } });
  curate.start = () => {};
  let clock = 0, reads = 0, enabled = true;
  const stackStates = [status('checked', { reason: 'configuration' }), status('incomplete', { reason: 'attempts-finished' }),
    status('skipped', { reason: 'supported-by-grouping' }), status('skipped', { reason: 'deterministic-pending' }),
    status('incomplete', { reason: 'configuration', scope: 'configuration' })];
  const photoStates = [status('complete', { completed: 3, total: 3 }),
    status('incomplete', { reason: 'photo-limit', completed: 2, total: 3 }),
    status('waiting', { reason: 'stack-pending' }), status('waiting', { reason: 'deterministic-pending' }),
    status('complete', { unavailableReason: 'stack-configuration' })];
  curate.stackReferee = { enabled: () => enabled, activity: () => ({ state: enabled ? 'waiting' : 'off', queued: 2 }),
    status: g => { reads++; return stackStates[Number(g.ids[0].split('-')[1])] ?? status('waiting'); } };
  curate.photoReferee = { enabled: () => enabled, activity: () => ({ state: enabled ? 'waiting' : 'off', queued: 1 }),
    status: g => photoStates[Number(g.ids[0].split('-')[1])] ?? status('waiting') };
  curate.refereeProgress = new CurateRefereeProgress(curate, { now: () => clock });
  try {
    for (let i = 0; i < 60; i++) for (let j = 0; j < 2; j++) {
      const id = `stack-${i}-${j}`;
      repo.reviewListAdd([id], 'test');
      repo.upsertAsset({ id, originalPath: `matching-${i}.jpg`, fileCreatedAt: new Date(1700000000000 + i * 600000 + j * 1000).toISOString() });
    }
    repo.reviewListAdd(['alone'], 'test'); repo.upsertAsset({ id: 'alone' });
    const view = await curate.openView();
    assert.equal(curate.current.groups.length, 61);
    assert.equal(view.refereeProgress.stack.state, 'counting', 'no false completion before the first scan');
    await curate.refereeProgress.refresh();
    const expected = curate.refereeProgress.status();
    assert.deepEqual(expected.stack, { state: 'ready', total: 59, completed: 1, incomplete: 1, remaining: 57,
      waitingForGrouping: 1, waitingForStack: 0, paused: 1 });
    assert.deepEqual(expected.photo, { state: 'ready', total: 60, completed: 1, incomplete: 1, remaining: 58,
      waitingForGrouping: 1, waitingForStack: 1, paused: 1 });
    assert.deepEqual(curate.page(view.viewId, 50).refereeProgress, expected);
    for (const options of [{ kind: 'singles' }, { search: 'matching-42' }, { section: 'decided' }])
      assert.deepEqual((await curate.openView(options)).refereeProgress, expected);
    const before = reads;
    for (let i = 0; i < 20; i++) curate.refereeProgress.status();
    await curate.refereeProgress.refresh();
    assert.equal(reads, before, 'polls reuse one cached summary, not a library scan per tab');
    stackStates[0] = status('incomplete', { reason: 'invalid-answer' });
    clock = 4001; await curate.refereeProgress.refresh();
    assert.equal(curate.refereeProgress.status().stack.incomplete, 2, 'terminal results refresh even without a grouping revision');
    enabled = false;
    assert.deepEqual(curate.refereeProgress.status(), { stack: { state: 'off' }, photo: { state: 'off' } });
    enabled = true; curate.settingsChanged();
    assert.equal(curate.refereeProgress.status().stack.state, 'counting');
    await curate.refereeProgress.refresh();
    repo.curate.bump();
    assert.equal(curate.refereeProgress.status().stack.state, 'counting', 'stale evidence cannot claim completion');
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_ai_attempts').get().n, 0);
  } finally { await curate.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a yielded progress scan cannot publish counts after grouping/settings change or shutdown', async () => {
  for (const change of ['grouping', 'settings', 'close']) {
    let generation = 1, yielded = 0;
    const curate = { store: { generation: () => generation }, current: { generation, groups: [1, 2].map(id => ({ id, ids: ['a', 'b'] })) } };
    curate.stackReferee = { enabled: () => true, status: () => {
      const end = performance.now() + 6; while (performance.now() < end) { /* force a slice boundary */ }
      return status('checked');
    } };
    const progress = new CurateRefereeProgress(curate, { yieldSlice: async () => {
      yielded++;
      if (change === 'grouping') generation++;
      if (change === 'settings') progress.invalidate();
      if (change === 'close') curate.closed = true;
    } });
    await progress.refresh();
    assert.equal(yielded, 1); assert.equal(progress.snapshot, null);
  }
});

test('progress copy distinguishes prerequisites, provider waits, pauses, Off and terminal completion', () => {
  const counts = { state: 'ready', total: 20, completed: 5, incomplete: 3, remaining: 12,
    waitingForGrouping: 0, waitingForStack: 0, paused: 0 };
  const present = (extra = {}, activity = status('idle')) => refereeProgress({ ...counts, ...extra }, activity, 'photo');
  assert.match(present().text, /12 stacks remaining · Queued/);
  assert.equal(present().value, 0.4);
  assert.match(present({ waitingForGrouping: 12 }).text, /Waiting for grouping/);
  assert.match(present({ waitingForGrouping: 4, waitingForStack: 8 }).text, /Waiting for stack checks/);
  assert.match(present({}, status('waiting', { reason: 'shared-provider' })).text, /Waiting for AI/);
  assert.match(present({}, status('checking')).text, /Working/);
  assert.match(present({ paused: 12 }).text, /Paused/);
  assert.match(present({}, status('paused', { reason: 'model-failures' })).detail, /photo comparisons/);
  assert.equal(present({ remaining: 0 }).text, 'Up to date');
  assert.match(present({ remaining: 0 }).detail, /3 finished without a full result/);
  assert.equal(present({ state: 'off' }).text, 'Off');
  assert.equal(present({ state: 'counting' }).value, undefined);
});
