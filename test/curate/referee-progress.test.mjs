import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateRefereeProgress } from '../../src/curate/referee-progress.mjs';
import { refereeProgress, curateStatus } from '../../public/curate/referee-status.js';

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
    assert.equal(expected.remaining, 58, 'overlapping referee work counts each stack once');
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
    assert.deepEqual(curate.refereeProgress.status(), { remaining: 0, stack: { state: 'off' }, photo: { state: 'off' } });
    enabled = true; curate.settingsChanged();
    assert.equal(curate.refereeProgress.status().stack.state, 'counting');
    await curate.refereeProgress.refresh();
    repo.curate.bump();
    assert.equal(curate.refereeProgress.status().stack.state, 'counting', 'stale evidence cannot claim completion');
    assert.equal(curate.refereeProgress.status().remaining, null);
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
  assert.equal(present().text, '12 stacks left');
  assert.equal(present().status, 'Queued');
  assert.equal(present().value, 0.4);
  assert.match(present({ waitingForGrouping: 12 }).status, /Waiting for grouping/);
  assert.match(present({ waitingForGrouping: 4, waitingForStack: 8 }).status, /Waiting for stack checks/);
  assert.match(present({}, status('waiting', { reason: 'shared-provider' })).status, /Waiting for AI/);
  assert.match(present({}, status('checking')).status, /Comparing photos/);
  assert.equal(present({ paused: 12 }).status, 'Needs attention');
  assert.match(present({}, status('paused', { reason: 'model-failures' })).detail, /photo comparisons/);
  assert.equal(present({ remaining: 0 }).text, 'Up to date');
  assert.match(present({ remaining: 0 }).detail, /3 finished without a full result/);
  assert.equal(present({ state: 'off' }).text, 'Off');
  assert.equal(present({ state: 'off' }).value, 0, 'Off has a neutral track, not a full or animated bar');
  assert.equal(present({ state: 'counting' }).value, 0);
});

test('one chip represents global activity, terminal completion, disabled roles and actionable pauses', () => {
  const off = { state: 'off' }, work = { state: 'ready', total: 20, completed: 17, incomplete: 0, remaining: 3,
    waitingForGrouping: 0, waitingForStack: 0, paused: 0 };
  const view = { refereeProgress: { remaining: 0, stack: off, photo: off }, refinement: { state: 'idle', remainingGroups: 0 } };
  assert.equal(curateStatus(view).phase, 'hidden');
  view.refinement = { state: 'waiting', remainingGroups: 2 };
  assert.equal(curateStatus(view).phase, 'grouping');
  assert.equal(curateStatus(view).count, 2);
  view.refereeProgress = { remaining: 3, stack: work, photo: work };
  view.photoRefereeActivity = status('checking');
  assert.equal(curateStatus(view).text, 'Picking best photos · 3 stacks left');
  assert.equal(curateStatus(view).count, 3, 'the API union count is not the sum of the roles');
  view.refereeProgress.photo = { ...work, remaining: 0 };
  assert.equal(curateStatus(view).phase, 'running', 'live work is visible before the count snapshot catches up');
  view.refinement = { state: 'idle', remainingGroups: 0 };
  view.refereeProgress.stack = off;
  view.refereeProgress.photo = work;
  view.photoRefereeActivity = status('waiting', { reason: 'shared-provider' });
  assert.equal(curateStatus(view).text, 'Waiting for AI · 3 stacks left');
  view.enrichRunning = true;
  assert.equal(curateStatus(view).text, 'Waiting for Enrich · 3 stacks left');
  assert.equal(curateStatus(view).phase, 'waiting');
  view.photoRefereeActivity = status('paused', { reason: 'configuration' });
  assert.equal(curateStatus(view).phase, 'attention');
  assert.equal(curateStatus(view).text, 'Photo Referee: setup needed');
  view.refereeProgress.photo = { ...work, remaining: 0, incomplete: 3 };
  assert.equal(curateStatus(view).roles[1].status, 'Can’t run: check AI settings', 'a stale count cannot hide a live pause');
  view.photoRefereeActivity = status('idle');
  view.refereeProgress.remaining = 0;
  assert.equal(curateStatus(view).phase, 'idle', 'terminal incomplete checks are finished');
  view.metadata = { state: 'refreshing' };
  assert.equal(curateStatus(view).phase, 'grouping');
  view.metadata = null;
  view.refereeProgress.photo = { state: 'counting' };
  assert.equal(curateStatus(view).phase, 'counting');
  assert.equal(curateStatus(view).count, null);
  view.photoRefereeActivity = status('checking');
  assert.equal(curateStatus(view).phase, 'running');
  view.refinement = { state: 'paused', remainingGroups: 1 };
  assert.equal(curateStatus(view).text, 'Grouping paused');
  assert.equal(curateStatus(view).roles[1].phase, 'running', 'independent work remains visible in the breakdown');
});

test('blockers distinguish setup, model failures and cooldowns without claiming automatic recovery for unknown failures', () => {
  const work = { state: 'ready', total: 3, completed: 0, incomplete: 0, remaining: 3, paused: 3 };
  for (const [reason, text, phase, row] of [
    ...['configuration', 'stack-configuration', 'provider-auth', 'provider-configuration', 'unknown-capability', 'unsupported-provider']
      .map(reason => [reason, 'AI setup needed', 'attention', 'Can’t run: check AI settings']),
    ['model-failures', 'AI model needs attention', 'attention', 'Model needs attention'],
    ['preview-cooldown', 'Temporarily paused', 'waiting', 'Temporarily paused'],
    ['provider-cooldown', 'Temporarily paused', 'waiting', 'Temporarily paused'],
    ['provider-interrupted', 'AI needs attention', 'attention', 'Needs attention'],
    ['PRIVATE UNKNOWN ERROR', 'AI needs attention', 'attention', 'Needs attention'],
  ]) {
    const view = { refereeProgress: { stack: work, photo: work, remaining: 3 },
      stackRefereeActivity: status('paused', { reason }), photoRefereeActivity: status('paused', { reason }) };
    const result = curateStatus(view);
    assert.equal(result.text, text, reason);
    assert.equal(result.phase, phase, reason);
    assert.equal(result.count, 3);
    assert.ok(result.roles.every(r => r.status === row));
    assert.doesNotMatch(JSON.stringify(result.roles.map(r => r.detail)), /PRIVATE|resumes shortly/);
    view.refereeProgress.photo = { state: 'counting' };
    assert.equal(curateStatus(view).text, text, 'live blockers also apply before the scan finishes');
    view.photoRefereeActivity = status('checking');
    assert.match(curateStatus(view).text, /^Stack Referee:/, 'only name the blocked role');
    assert.equal(curateStatus(view).roles[1].status, 'Comparing photos');
    view.refereeProgress.stack = { state: 'off' };
    assert.equal(curateStatus(view).phase, 'running', 'Off ignores stale blocker activity');
  }
  const mixed = { refereeProgress: { stack: work, photo: work, remaining: 3 },
    stackRefereeActivity: status('paused', { reason: 'provider-auth' }), photoRefereeActivity: status('paused', { reason: 'model-failures' }) };
  assert.equal(curateStatus(mixed).text, 'AI needs attention', 'different blockers do not imply one shared cause');
  assert.deepEqual(curateStatus(mixed).roles.map(r => r.status), ['Can’t run: check AI settings', 'Model needs attention']);
  mixed.photoRefereeActivity.reason = 'configuration';
  assert.equal(curateStatus(mixed).text, 'AI setup needed', 'related setup blockers share a concise message');
});

test('cooldown details show only known retry eligibility, not a recovery promise', () => {
  const retryAt = Date.UTC(2026, 9, 8, 12, 30);
  for (const role of ['stack', 'photo']) for (const reason of ['preview-cooldown', 'provider-cooldown']) {
    const present = retryAt => refereeProgress({ state: 'counting' }, status('paused', { reason, retryAt }), role);
    assert.match(present(retryAt).detail, /Retry eligible after/);
    assert.ok(present(retryAt).detail.includes(new Date(retryAt).toLocaleString()));
    assert.doesNotMatch(present(retryAt).detail, /resumes shortly|will resume/);
    for (const invalid of [undefined, null, 0, -1, 'tomorrow', NaN, Infinity, Number.MAX_SAFE_INTEGER])
      assert.doesNotMatch(present(invalid).detail, /Retry eligible|Invalid Date/);
  }
  assert.doesNotMatch(refereeProgress(null, status('paused', { reason: 'provider-auth', retryAt })).detail, /Retry eligible/);
});
