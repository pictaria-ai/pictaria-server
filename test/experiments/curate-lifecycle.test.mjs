import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAY, MINUTE, LIFETIME, selectKeptContext, freshCohorts, reconcileCohort,
  reserveCohortBudget, pruneCohortReservations, receiptDisposition, inspectOperation, operationScopeHash } from '../../experiments/curate-v13/lifecycle.mjs';
import { compactIdleCohort } from '../../experiments/curate-v13/lifecycle.mjs';
import { groupPhotos, planRequest, fingerprint } from '../../experiments/curate-v13/grouping.mjs';
import { planKeeperBatches, collectKeeperBatches } from '../../experiments/curate-v13/batching.mjs';
import { dataset } from '../../experiments/curate-v13/fixtures.mjs';

const photo = (id, seconds, state = 'kept') => ({ id, capturedAt: new Date(1700000000000 + seconds * 1000).toISOString(), state });
const decisionPayload = (scopeId = 'comparison', ids = ['a', 'b']) => ({ kind: 'decision', mode: 'manual',
  snapshot: { scopeId, ids, material: 'unchanged-input' }, outcomes: Object.fromEntries(ids.map(id => [id, 'approve'])) });

test('kept context is bounded, deterministic, explicitly omitted and never actionable', () => {
  const pending = [photo('new', 0, 'pending')], candidates = Array.from({ length: 20 }, (_, i) => photo(`old-${i}`, i + 1));
  const result = selectKeptContext(pending, [...candidates].reverse());
  assert.deepEqual(result.actionableIds, ['new']);
  assert.deepEqual(result.contextIds, candidates.slice(0, 8).map(p => p.id));
  assert.equal(result.omitted, true); assert.equal(result.omittedKnown, 12);
  const filtered = selectKeptContext(pending, [pending[0], photo('far', 181), photo('pending', 1, 'pending'),
    { ...photo('gone', 2), available: false }, { ...photo('unknown', 0), capturedAt: null }], { queryLimited: true });
  assert.deepEqual(filtered.contextIds, []); assert.equal(filtered.omitted, true); assert.equal(filtered.omittedKnown, 0);
  assert.throws(() => selectKeptContext(pending, Array.from({ length: 65 }, (_, i) => photo(`x${i}`, i))));
});

test('splits share an allowance; a merge carries history and absent siblings through restart', () => {
  let state = freshCohorts();
  reconcileCohort(state, ['a', 'b'], () => 'origin-a');
  reconcileCohort(state, ['c', 'd'], () => 'origin-c');
  const reserve = (ids, id, slots = 1, role = 'keeper', now = 0) => reserveCohortBudget(state, ids, { id, slots, role, now, revision: id });
  assert.equal(reserve(['a', 'b'], 'first', 2).state, 'reserved');
  assert.equal(reserve(['a'], 'split').state, 'reserved');
  assert.equal(reserve(['b'], 'sibling').state, 'manual-recheck');
  assert.equal(reserve(['c', 'd'], 'other').state, 'reserved');
  reconcileCohort(state, ['b', 'c']);
  state = JSON.parse(JSON.stringify(state));
  assert.equal(state.members.a, state.members.d);
  assert.equal(new Set(state.reservations.map(e => e.cohort)).size, 1);
  assert.equal(reserve(['d'], 'after-merge').state, 'manual-recheck');
  assert.equal(reserve(['a'], 'check-role', 3, 'check').state, 'reserved');
  assert.equal(reserve(['brand-new'], 'independent').state, 'reserved');
  assert.equal(reserve(['d'], 'settled-later', 3, 'keeper', 30 * MINUTE).state, 'reserved');
});

test('reservation replay is deduplicated; pruning keeps active work and does not split a cohort', () => {
  const state = freshCohorts(), request = { id: 'req', role: 'keeper', revision: 'v1', slots: 3, now: 0 };
  reserveCohortBudget(state, ['a', 'b'], request);
  assert.equal(reserveCohortBudget(state, ['b', 'a'], request).replay, true);
  assert.equal(state.reservations.length, 1);
  assert.throws(() => reserveCohortBudget(state, ['a'], request), /reused/);
  pruneCohortReservations(state, 31 * MINUTE, ['req']); assert.equal(state.reservations.length, 1);
  pruneCohortReservations(state, 31 * MINUTE); assert.equal(state.reservations.length, 0);
  assert.equal(reconcileCohort(state, ['a']), reconcileCohort(state, ['b']));
});

test('stable descendants regain separate budgets only after a full quiet window with no active work', () => {
  const state = freshCohorts(), origin = reconcileCohort(state, ['a', 'b', 'c', 'd']);
  reserveCohortBudget(state, ['a', 'b'], { id: 'old', role: 'keeper', revision: 'v1', slots: 3, now: 0 });
  let n = 0;
  const options = { now: 30 * MINUTE, settledSince: 0, createId: () => `renewed-${++n}` };
  assert.equal(compactIdleCohort(state, origin, [['a', 'b'], ['c', 'd']], { ...options, now: 29 * MINUTE }), false);
  assert.equal(compactIdleCohort(state, origin, [['a', 'b'], ['c', 'd']], { ...options, activeCohorts: [origin] }), false);
  assert.throws(() => compactIdleCohort(state, origin, [['a'], ['c', 'd']], options), /incomplete/);
  assert.deepEqual(compactIdleCohort(state, origin, [['a', 'b'], ['c', 'd']], options), ['renewed-1', 'renewed-2']);
  assert.notEqual(state.members.a, state.members.c); assert.equal(state.reservations.length, 0);
});

test('receipt windows preserve pending work and Undo dependencies beyond ordinary retention', () => {
  const settled = { completedAt: 0 };
  assert.equal(receiptDisposition(settled, 30 * DAY - 1), 'receipt');
  assert.equal(receiptDisposition(settled, 30 * DAY), 'tombstone');
  assert.equal(receiptDisposition(settled, 60 * DAY), 'forget');
  for (const protectedRecord of [{ pendingSync: true }, { undoDependency: true }, { completedAt: null }]) {
    assert.equal(receiptDisposition({ ...settled, ...protectedRecord }, 90 * DAY), 'receipt');
  }
});

test('expired/forgotten action IDs cannot become fresh operations after SQLite restart and pruning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curate-lifetime-')); let db;
  try {
    const path = join(dir, 'records.sqlite'); db = new DatabaseSync(path);
    db.exec('CREATE TABLE records(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    const save = (id, value) => db.prepare('INSERT OR REPLACE INTO records VALUES(?,?)').run(id, JSON.stringify(value));
    const read = id => { const row = db.prepare('SELECT data FROM records WHERE id=?').get(id); return row ? JSON.parse(row.data) : null; };
    const operationId = 'issued-operation', payload = decisionPayload(), lookups = [];
    const lookup = id => { lookups.push(id); return { lease: read(`lease:${id}`), saved: read(`receipt:${id}`) }; };
    const inspect = (now, body = payload, id = operationId) => inspectOperation({ operationId: id, payload: body, now }, lookup);
    save(`lease:${operationId}`, { operationId, scopeHash: operationScopeHash(payload), expiresAt: LIFETIME.lease });
    assert.equal(inspect(0), 'new');
    assert.equal(inspect(0, decisionPayload('another-comparison', ['c', 'd'])), 'conflict');
    assert.equal(inspect(0, payload, 'unknown-operation'), 'expired');
    assert.deepEqual(lookups, [operationId, operationId, 'unknown-operation']);
    save(`receipt:${operationId}`, { operationId, payloadHash: fingerprint(payload), receipt: { requestId: operationId }, completedAt: 0 });
    db.close(); db = new DatabaseSync(path);
    assert.equal(inspect(DAY), 'replay');
    assert.equal(inspect(DAY, { ...payload, outcomes: { a: 'reviewed', b: 'approve' } }), 'conflict');
    const full = read(`receipt:${operationId}`); assert.equal(receiptDisposition(full, 30 * DAY), 'tombstone');
    save(`receipt:${operationId}`, { ...full, receipt: null });
    assert.equal(inspect(30 * DAY), 'expired');
    assert.equal(receiptDisposition(read(`receipt:${operationId}`), 60 * DAY), 'forget');
    db.exec('DELETE FROM records');
    assert.equal(inspect(60 * DAY), 'expired');
  } finally { db?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a live lease cannot authorize a different operation ID, snapshot, mode or Undo target', () => {
  const payload = decisionPayload(), request = { operationId: 'op-a', payload, now: 0 };
  const lease = { operationId: 'op-a', scopeHash: operationScopeHash(payload), expiresAt: LIFETIME.lease };
  const lookup = () => ({ lease });
  assert.equal(inspectOperation(request, lookup), 'new');
  assert.equal(inspectOperation({ ...request, operationId: 'op-b' }, lookup), 'conflict');
  for (const body of [decisionPayload('another-comparison'), decisionPayload('comparison', ['c', 'd']),
    { ...payload, snapshot: { ...payload.snapshot, material: 'changed-input' } },
    { ...payload, outcomes: { c: 'approve', d: 'approve' } },
    { ...payload, outcomes: { a: 'approve' } },
    { ...payload, mode: 'advice' }, { kind: 'undo', targetOperationId: 'prior-op' }]) {
    assert.equal(inspectOperation({ ...request, payload: body }, lookup), 'conflict');
  }
  const undo = { kind: 'undo', targetOperationId: 'prior-op' };
  const undoLookup = () => ({ lease: { ...lease, scopeHash: operationScopeHash(undo) } });
  assert.equal(inspectOperation({ ...request, payload: undo }, undoLookup), 'new');
  assert.equal(inspectOperation({ ...request, payload: { ...undo, targetOperationId: 'other-op' } }, undoLookup), 'conflict');
});

test('receipt replay requires the requested operation identity and complete canonical payload', () => {
  const payload = decisionPayload(), request = { operationId: 'op-a', payload, now: DAY };
  const saved = { operationId: 'op-a', payloadHash: fingerprint(payload), receipt: { requestId: 'op-a' } };
  assert.equal(inspectOperation(request, () => ({ saved })), 'replay');
  assert.equal(inspectOperation({ ...request, operationId: 'op-b' }, () => ({ saved })), 'conflict');
  assert.equal(inspectOperation({ ...request, payload: decisionPayload('different') }, () => ({ saved })), 'conflict');
  assert.equal(inspectOperation({ ...request, payload: { ...payload, outcomes: { a: 'reviewed', b: 'approve' } } }, () => ({ saved })), 'conflict');
});

test('large-group role matrix distinguishes a known check size limit and never hides excess requests', () => {
  const ids = dataset(30).map(p => p.id), group = groupPhotos(dataset(30)).groups[0];
  const sizes = Object.fromEntries(ids.map(id => [id, 1000]));
  for (const stacks of [false, true]) for (const check of [false, true]) for (const referee of [false, true]) {
    const options = { stacks, check, referee, maxImages: 10, orderedIds: ids };
    const checking = planRequest(group, sizes, { ...options, role: 'check' });
    const keeping = planKeeperBatches(group, sizes, { ...options, checkState: checking.checkState ?? 'pending' });
    assert.equal(checking.state, stacks && check ? 'manual-provider' : 'disabled');
    assert.equal(keeping.state, !stacks || !referee ? 'disabled' : 'ready');
    if (stacks && check && referee) assert.equal(keeping.checkCoverage, 'unchecked-size');
  }
  assert.equal(planKeeperBatches(group, sizes, { orderedIds: ids, maxImages: 10, referee: true, check: true, checkState: 'valid' }).state, 'ready');
  assert.equal(planKeeperBatches(group, sizes, { orderedIds: ids, maxImages: 8, referee: true }).state, 'manual-request-budget');
});

test('unchecked keeper batches require a confirmed size limit and retain their warning through collection', () => {
  const ids = dataset(30).map(p => p.id), group = groupPhotos(dataset(30)).groups[0];
  const sizes = Object.fromEntries(ids.map(id => [id, 1000]));
  const options = { orderedIds: ids, maxImages: 10, referee: true, check: true, checkState: 'unsupported-size' };
  const plan = planKeeperBatches(group, sizes, options);
  assert.equal(plan.state, 'ready'); assert.equal(plan.checkNotice, 'Stack not checked: too large');
  const answers = plan.requests.map(ids => ({ status: 'valid', output: { groups: [{ ids, keepers: [ids[0]], reason: 'Local alternatives.' }] } }));
  const result = collectKeeperBatches(plan, answers);
  assert.equal(result.canApplyAll, true); assert.equal(result.wholeGroupCompared, false);
  assert.equal(result.checkCoverage, 'unchecked-size'); assert.equal(result.checkNotice, plan.checkNotice);
  answers[0] = { status: 'provider-error' };
  assert.equal(collectKeeperBatches(plan, answers).canApplyAll, false);
  for (const checkState of ['pending', 'failed', 'unsupported', 'auth-error', 'unknown']) {
    assert.equal(planKeeperBatches(group, sizes, { ...options, checkState }).state, 'waiting-for-check');
  }
  assert.equal(planKeeperBatches(group, sizes, { ...options, maxImages: null }).state, 'unsupported-provider');
  assert.equal(planKeeperBatches(group, sizes, { ...options, maxImages: 30 }).state, 'waiting-for-check');
  assert.equal(planKeeperBatches(group, { ...sizes, [ids[0]]: 3 * 1024 * 1024 }, options).state, 'manual-size');
  assert.equal(planKeeperBatches(group, sizes, { ...options, stacks: false }).state, 'disabled');
});

test('mixed subjects within a keeper batch withhold full-group advice application', () => {
  const plan = { state: 'ready', groupId: 'g', requests: [['a', 'b'], ['c', 'd']], coverage: 'within-batches' };
  const answer = ids => ({ status: 'valid', output: { groups: [{ ids, keepers: [ids[0]], reason: 'Alternatives.' }] } });
  assert.equal(collectKeeperBatches(plan, plan.requests.map(answer)).canApplyAll, true);
  const mixed = { status: 'valid', output: { groups: [
    { ids: ['a'], keepers: ['a'], reason: 'Landscape.' }, { ids: ['b'], keepers: ['b'], reason: 'Portrait.' },
  ] } };
  const result = collectKeeperBatches(plan, [mixed, answer(['c', 'd'])]);
  assert.equal(result.state, 'complete'); assert.equal(result.canApplyAll, false);
  assert.equal(result.wholeGroupCompared, false); assert.deepEqual(result.keeperIds, ['a', 'b', 'c']);
  assert.equal(collectKeeperBatches({ ...plan, requests: [['a', 'b']], coverage: 'whole-group' }, [mixed]).canApplyAll, true);
});
