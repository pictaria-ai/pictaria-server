import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupPhotos, planRequest, validateAdvice } from '../../experiments/curate-v13/grouping.mjs';
import { DecisionSpike } from '../../experiments/curate-v13/decisions.mjs';
import { fixtures, photo } from '../../experiments/curate-v13/fixtures.mjs';
import { OpenAiProvider, OpenAiCompatibleProvider, VeniceProvider } from '../../src/enrich/providers.mjs';
import { backendKey, nextTurn, freshLineage, supersede, reserve, finish } from '../../experiments/curate-v13/scheduling.mjs';
import { visionPrompt, compareLabels, evaluateImages, publicEvaluationSummary } from '../../experiments/curate-v13/visual.mjs';

const partition = groups => groups.map(g => [...g].sort().join(',')).sort();
for (const fixture of fixtures) test(`experimental grouping: ${fixture.name}`, () => {
  const result = groupPhotos(fixture.photos, { semanticVeto: true });
  if (fixture.expected) assert.deepEqual(partition(result.groups.map(g => g.ids)), partition(fixture.expected));
  if (fixture.maxSpanSeconds) for (const g of result.groups) {
    const times = fixture.photos.filter(p => g.ids.includes(p.id)).map(p => Date.parse(p.capturedAt));
    assert.ok(Math.max(...times) - Math.min(...times) <= fixture.maxSpanSeconds * 1000);
  }
  assert.deepEqual(result.groups.flatMap(g => g.ids).sort(), fixture.photos.map(p => p.id).sort());
});

test('unknown evidence stays uncertain; semantic veto is opt-in pending visual validation', () => {
  for (const fixture of fixtures.filter(f => f.name.startsWith('landscape-couple-solo'))) {
    const result = groupPhotos(fixture.photos);
    assert.equal(result.groups.length, 1);
    assert.equal(result.groups[0].route, 'uncertain');
  }
});

const portrait = (id, seconds, options = {}) => photo(id, seconds, { people: 1, recognized: ['person'], ...options });

test('optional lookback recovers a supported 62-second gap without bypassing the AI check', () => {
  const rows = [portrait('a', 0), portrait('b', 5), portrait('c', 67)];
  assert.equal(groupPhotos(rows).groups.length, 2);
  const result = groupPhotos(rows, { lookbackDistance: 0.025 });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].route, 'uncertain');
  assert.equal(result.metrics.lookbackJoins, 1);
  assert.equal(result.metrics.lookbackPairComparisons, 3);
  assert.equal(planRequest(result.groups[0], { a: 1, b: 1, c: 1 }, { role: 'check', check: true }).state, 'ready');
});

test('lookback withholds unsupported, conflicting, mismatched or malformed positive evidence', () => {
  for (const changed of [
    { facts: null }, { facts: { contract: 'unknown', peopleCount: 1 } },
    { personIds: null }, { personIds: [] }, { personIds: ['other-person'] }, { personIds: [null] },
    { thumbhash: null }, { thumbhash: '!!!' }, { thumbhash: Buffer.alloc(24, 80).toString('base64') },
    { thumbhash: Buffer.alloc(25, 160).toString('base64') },
    { facts: { contract: 'curate-facts-prototype-1', peopleCount: 2 }, personIds: ['person', 'person'] },
  ]) {
    const result = groupPhotos([portrait('a', 0), portrait('b', 62, changed)], { lookbackDistance: 0.025 });
    assert.equal(result.groups.length, 2, JSON.stringify(changed));
    assert.equal(result.metrics.lookbackJoins, 0);
  }
  for (const distance of [-1, NaN, Infinity, 2, '0.025']) assert.throws(() => groupPhotos([], { lookbackDistance: distance }));
});

test('lookback validates old member pairs and later short-gap arrivals; no similarity chaining', () => {
  const rows = [portrait('a', 0, { tone: 0 }), portrait('b', 5, { tone: 20 }), portrait('c', 67, { tone: 10 })];
  // c is close to BOTH old members, but those members are not close to each other.
  assert.equal(groupPhotos(rows, { lookbackDistance: 0.05 }).groups.length, 2);
  const extended = [portrait('a', 0, { tone: 0 }), portrait('b', 62, { tone: 10 }), portrait('c', 67, { tone: 20 })];
  const result = groupPhotos(extended, { lookbackDistance: 0.05 });
  assert.deepEqual(partition(result.groups.map(g => g.ids)), partition([['a', 'b'], ['c']]));
});

test('lookback keeps span, candidate and human-separation bounds', () => {
  assert.equal(groupPhotos([portrait('a', 0), portrait('b', 181)], { lookbackDistance: 0.025 }).groups.length, 2);
  const rows = [portrait('a', 0), portrait('b', 62)];
  assert.equal(groupPhotos(rows, { lookbackDistance: 0.025, separations: [{ id: 'split', partitions: [['a'], ['b']] }] }).groups.length, 2);
  const crowded = [portrait('a', 0), ...Array.from({ length: 33 }, (_, i) => portrait(`different-${i}`, i + 1,
    { recognized: [`different-${i}`] })), portrait('return', 100)];
  const separations = [{ id: 'separate', partitions: crowded.slice(0, -1).map(p => [p.id]) }];
  const result = groupPhotos(crowded, { lookbackDistance: 0.025, candidateLimit: 32, separations });
  assert.ok(result.groups.every(g => !(g.ids.includes('a') && g.ids.includes('return'))));
});

test('lookback never admits a partially checked group when either comparison budget is spent', () => {
  const rows = [portrait('a', 0), portrait('b', 5), portrait('c', 67)];
  for (const limits of [{ pairsPerCandidate: 2 }, { comparisonBudget: 2 }, { comparisonBudget: 0 }]) {
    const result = groupPhotos(rows, { lookbackDistance: 0.025, ...limits });
    assert.equal(result.groups.length, 2);
    assert.equal(result.metrics.lookbackJoins, 0);
    assert.equal(result.metrics.lookbackLimitedCandidates, 1);
    assert.ok(result.metrics.pairComparisons <= 2);
  }
});

test('human separation survives a time/hash bridge and a limited evidence budget', () => {
  const rows = [photo('a', 0), photo('bridge', 5), photo('b', 10)].map(p => ({ ...p, checksum: 'same-bytes' }));
  const result = groupPhotos(rows, { comparisonBudget: 0, separations: [{ id: 'correction', partitions: [['a'], ['b']] }] });
  assert.ok(result.groups.every(g => !(g.ids.includes('a') && g.ids.includes('b'))));
  assert.equal(groupPhotos(rows).groups.length, 1, 'resetting the correction permits regrouping');
});

test('exhausted evidence budget leaves one unconfirmed group, not arbitrary request chunks', () => {
  const rows = Array.from({ length: 100 }, (_, i) => photo(`dense-${i}`, i));
  const result = groupPhotos(rows, { semanticVeto: true, comparisonBudget: 10 });
  assert.equal(result.metrics.pairComparisons, 10);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].route, 'manual-budget');
});

test('30-photo synthetic contract retains multiple keepers in one bounded request', () => {
  const fixture = fixtures.find(f => f.name === 'thirty-alternatives');
  const group = groupPhotos(fixture.photos).groups[0];
  const sizes = Object.fromEntries(group.ids.map(id => [id, 256 * 1024]));
  const plan = planRequest(group, sizes, { role: 'keeper', referee: true });
  assert.equal(plan.state, 'ready');
  assert.equal(plan.requests.length, 1);
  assert.equal(plan.requests[0].length, 30);
  const advice = validateAdvice(group.ids, { groups: [{ ids: group.ids, keepers: fixture.keepers, reason: 'Two useful expressions.' }] });
  assert.deepEqual(advice.groups[0].keepers, fixture.keepers);
  assert.equal(planRequest({ ...group, ids: [...group.ids, 'extra'] }, { ...sizes, extra: 1 }, { role: 'keeper', referee: true }).state, 'manual-size');
  assert.equal(planRequest(group, Object.fromEntries(group.ids.map(id => [id, 2 * 1024 * 1024])), { role: 'keeper', referee: true }).state, 'manual-size');
});

test('independent role gates, unresolved check and pending singleton context', () => {
  const group = groupPhotos([photo('a', 0), photo('b', 5)]).groups[0], sizes = { a: 20, b: 20 };
  assert.equal(planRequest(group, sizes, { role: 'check', check: true }).state, 'ready');
  assert.equal(planRequest(group, sizes, { role: 'keeper', check: true }).state, 'disabled');
  assert.equal(planRequest(group, sizes, { role: 'keeper', referee: true }).state, 'ready');
  assert.equal(planRequest(group, sizes, { role: 'check', stacks: false, check: true }).state, 'disabled');
  assert.equal(planRequest(group, sizes, { role: 'keeper', check: true, referee: true }).state, 'waiting-for-check');
  assert.equal(planRequest(group, sizes, { role: 'keeper', check: true, referee: true, checkState: 'failed' }).state, 'waiting-for-check');
  const newcomer = groupPhotos(fixtures.find(f => f.name === 'pending-newcomer').photos).groups[0];
  assert.deepEqual(newcomer.pendingIds, ['new']);
  assert.deepEqual(newcomer.keptContextIds, ['kept']);
  assert.equal(planRequest(newcomer, { new: 10, kept: 10 }, { role: 'keeper', referee: true }).state, 'manual-context');
});

test('strict partitions distinguish explicit none from incomplete/duplicated/invented advice', () => {
  const valid = { groups: [{ ids: ['a', 'b'], keepers: [], reason: 'Both blurred.' }] };
  assert.deepEqual(validateAdvice(['a', 'b'], valid), valid);
  for (const groups of [
    [{ ids: ['a'], keepers: [], reason: 'Missing member.' }],
    [{ ids: ['a', 'a'], keepers: [], reason: 'Duplicate member.' }],
    [{ ids: ['a', 'unknown'], keepers: [], reason: 'Invented member.' }],
    [{ ids: ['a', 'b'], reason: 'Missing selection.' }],
    [{ ids: ['a', 'b'], keepers: ['a', 'a'], reason: 'Duplicate keeper.' }],
    [{ ids: ['a', 'b'], keepers: ['unknown'], reason: 'Invented keeper.' }],
  ]) assert.throws(() => validateAdvice(['a', 'b'], { groups }));
  assert.throws(() => validateAdvice(['a', 'b'], valid, 'check'), /invalid group/);
});

function setup() {
  const ledger = new DecisionSpike();
  ledger.seed([{ id: 'a', tags: ['custom/trip'] }, { id: 'b' }, { id: 'unrelated' }]);
  ledger.scope('comparison', ['a', 'b'], { revision: 'advice-1', keepers: ['a'] });
  return ledger;
}
const apply = (ledger, id, snapshot = ledger.snapshot('comparison'), mode = 'manual') =>
  ledger.apply({ requestId: id, snapshot, mode, outcomes: { a: 'approve', b: 'reviewed' } });

test('AI-only repartition and unrelated evidence do not veto an explicit manual set', () => {
  const ledger = setup();
  try {
    const snapshot = ledger.snapshot('comparison');
    ledger.scope('comparison', ['a', 'b'], { revision: 'split-2', keepers: ['b'] });
    ledger.db.prepare('UPDATE photos SET input=? WHERE id=?').run('enriched-v2', 'unrelated');
    ledger.db.prepare('UPDATE photos SET tags=? WHERE id=?').run(JSON.stringify(['custom/trip', 'custom/new']), 'a');
    assert.throws(() => apply(ledger, 'advice-stale', snapshot, 'advice'), /conflict/);
    assert.equal(apply(ledger, 'manual', snapshot).sync, 'pending');
    assert.deepEqual(JSON.parse(ledger.photo('a').tags), ['custom/new', 'custom/trip', 'frame/eligible']);
  } finally { ledger.close(); }
});

test('evidence to partition to multiple-keeper decision, with kept context excluded from actions', () => {
  const fixture = fixtures.find(f => f.name === 'thirty-alternatives');
  const group = groupPhotos(fixture.photos).groups[0];
  const verdict = validateAdvice(group.ids, { groups: [{ ids: group.ids, keepers: fixture.keepers, reason: 'Fixture choice.' }] });
  const ledger = new DecisionSpike();
  try {
    ledger.seed([...fixture.photos, { id: 'context', tags: ['frame/eligible'] }]);
    ledger.scope('comparison', group.pendingIds, { revision: 'v1', keepers: verdict.groups[0].keepers });
    const request = { requestId: 'apply', mode: 'advice', snapshot: ledger.snapshot('comparison'),
      outcomes: Object.fromEntries(group.pendingIds.map(id => [id, fixture.keepers.includes(id) ? 'approve' : 'reviewed'])) };
    assert.throws(() => ledger.apply({ ...request, outcomes: { ...request.outcomes, context: 'reviewed' } }), /incomplete/);
    ledger.apply(request);
    assert.deepEqual(group.pendingIds.filter(id => JSON.parse(ledger.photo(id).tags).includes('frame/eligible')).sort(), [...fixture.keepers].sort());
    assert.deepEqual(JSON.parse(ledger.photo('context').tags), ['frame/eligible']);
    assert.equal(ledger.pending().length, 30);
  } finally { ledger.close(); }
});

test('shared backend alternates workloads and bounds interactive priority; endpoint aliases are explicit', () => {
  const state = {}, sequence = Array.from({ length: 12 }, () => nextTurn(state, { enrich: true, interactive: true, background: true }));
  assert.deepEqual(sequence, ['enrich', 'interactive', 'enrich', 'interactive', 'enrich', 'background', 'enrich', 'interactive', 'enrich', 'interactive', 'enrich', 'background']);
  assert.equal(nextTurn({}, { background: true }), 'background');
  assert.equal(backendKey('http://model.invalid/v1'), backendKey('http://model.invalid/other-model'));
  assert.equal(backendKey('http://one.invalid', 'same-gpu'), backendKey('http://two.invalid', 'same-gpu'));
  assert.notEqual(backendKey('http://one.invalid'), backendKey('http://two.invalid'));
});

test('coalescing, failure cooldown and aggregate churn survive serialized restart and revisions', () => {
  let state = freshLineage(), backend = {};
  supersede(state, 'a', 0); supersede(state, 'b', 1000);
  assert.equal(reserve(state, backend, 20000), 'settling');
  assert.equal(reserve(state, backend, 31000), 'reserved');
  supersede(state, 'c', 32000); supersede(state, 'd', 33000);
  assert.equal(state.queued, 'd'); assert.equal(state.active, 'b');
  finish(state, backend, 34000, { success: false });
  ({ state, backend } = JSON.parse(JSON.stringify({ state, backend })));
  assert.equal(reserve(state, backend, 70000), 'provider-paused');
  assert.equal(reserve(state, backend, 94000), 'reserved');
  finish(state, backend, 95000, { success: true });
  supersede(state, 'e', 96000); assert.equal(reserve(state, backend, 126000), 'reserved');
  finish(state, backend, 127000, { success: true });
  supersede(state, 'f', 128000); assert.equal(reserve(state, backend, 158000), 'manual-recheck');
  assert.equal(reserve(state, backend, 158000, { explicit: true, paused: true }), 'paused');
  assert.equal(reserve(state, backend, 158000, { explicit: true }), 'reserved');
});

test('one automatic retry does not become a fresh allowance after failure or restart', () => {
  let state = freshLineage(), backend = {};
  supersede(state, 'a', 0);
  assert.equal(reserve(state, backend, 30000), 'reserved'); finish(state, backend, 31000, { success: false });
  ({ state, backend } = JSON.parse(JSON.stringify({ state, backend })));
  assert.equal(reserve(state, backend, 91000), 'reserved'); finish(state, backend, 92000, { success: false });
  assert.equal(reserve(state, backend, 152000), 'manual-recheck');
  backend.blocked = true;
  assert.equal(reserve(state, backend, 152000, { explicit: true }), 'provider-paused');
});

test('returning to an active or completed revision cancels obsolete replacement work', () => {
  let state = freshLineage(); const backend = {};
  supersede(state, 'a', 0); reserve(state, backend, 30000);
  supersede(state, 'b', 31000); supersede(state, 'a', 32000);
  assert.equal(state.queued, null);
  finish(state, backend, 33000, { success: true });
  state = JSON.parse(JSON.stringify(state));
  supersede(state, 'b', 34000); supersede(state, 'a', 35000);
  assert.equal(reserve(state, backend, 65000), 'idle');
});

test('material changes and partial outcomes conflict without any local or queued changes', () => {
  for (const mutate of [
    l => l.scope('comparison', ['a', 'b', 'unrelated']),
    l => l.db.prepare('UPDATE photos SET input=? WHERE id=?').run('new-image-revision', 'a'),
    l => l.db.prepare('UPDATE photos SET available=0 WHERE id=?').run('b'),
  ]) {
    const ledger = setup();
    try { const view = ledger.snapshot('comparison'); mutate(ledger); assert.throws(() => apply(ledger, 'stale', view), /conflict/); assert.equal(ledger.pending().length, 0); }
    finally { ledger.close(); }
  }
  const ledger = setup();
  try { assert.throws(() => ledger.apply({ requestId: 'partial', snapshot: ledger.snapshot('comparison'), outcomes: { a: 'approve' } }), /incomplete/); }
  finally { ledger.close(); }
});

test('advice application must match its stored keeper set, including every keeper', () => {
  const ledger = setup();
  try {
    ledger.scope('comparison', ['a', 'b'], { revision: 'two', keepers: ['a', 'b'] });
    const view = ledger.snapshot('comparison');
    assert.throws(() => apply(ledger, 'drops-second', view, 'advice'), /differ from advice/);
    ledger.apply({ requestId: 'both', snapshot: view, mode: 'advice', outcomes: { a: 'approve', b: 'approve' } });
    assert.ok(JSON.parse(ledger.photo('b').tags).includes('frame/eligible'));
  } finally { ledger.close(); }
});

test('failure midway rolls back all photos, receipts and outbox; lost-response retry is idempotent', () => {
  const ledger = setup();
  try {
    const request = { requestId: 'choice', snapshot: ledger.snapshot('comparison'), outcomes: { a: 'approve', b: 'reviewed' } };
    assert.throws(() => ledger.apply(request, () => { throw Error('power loss'); }), /power loss/);
    assert.equal(ledger.pending().length, 0);
    assert.deepEqual(JSON.parse(ledger.photo('a').tags), ['custom/trip']);
    const receipt = ledger.apply(request);
    assert.deepEqual(ledger.apply(request), receipt);
    assert.equal(ledger.pending().length, 2);
    assert.throws(() => ledger.apply({ ...request, outcomes: { a: 'reviewed', b: 'reviewed' } }), /reused/);
  } finally { ledger.close(); }
});

test('Frame Hide supersedes an older in-flight approval; stale ack/Undo cannot erase it', () => {
  const ledger = setup();
  try {
    apply(ledger, 'approval');
    const oldWrite = ledger.pending().find(j => j.id === 'a');
    ledger.scope('frame', ['a']);
    ledger.apply({ requestId: 'hide', snapshot: ledger.snapshot('frame'), outcomes: { a: 'frame_hide' } });
    assert.equal(ledger.acknowledge('a', oldWrite.revision), false);
    const latest = ledger.pending().find(j => j.id === 'a');
    assert.equal(latest.patch['frame/eligible'], false);
    assert.equal(latest.patch['frame/never-show'], true);
    assert.throws(() => ledger.undo('stale-undo', 'approval'), /undo conflict/);
    assert.ok(JSON.parse(ledger.photo('b').tags).includes('frame/reviewed'));
  } finally { ledger.close(); }
});

test('Frame Favorite outside Curate does not imply approval; Undo preserves unrelated tags', () => {
  const ledger = setup();
  try {
    ledger.scope('frame', ['unrelated']);
    ledger.apply({ requestId: 'favorite', snapshot: ledger.snapshot('frame'), outcomes: { unrelated: 'frame_favorite' } });
    assert.deepEqual(JSON.parse(ledger.photo('unrelated').tags), ['frame/favorite']);
    ledger.db.prepare('UPDATE photos SET tags=? WHERE id=?').run(JSON.stringify(['frame/favorite', 'custom/new']), 'unrelated');
    ledger.undo('undo', 'favorite');
    assert.deepEqual(JSON.parse(ledger.photo('unrelated').tags), ['custom/new']);
  } finally { ledger.close(); }
});

test('receipt, conditional Undo and pending intent survive reopening SQLite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-curate-spike-'));
  let ledger;
  try {
    const path = join(dir, 'spike.sqlite'); ledger = new DecisionSpike(path);
    ledger.seed([{ id: 'a' }, { id: 'b' }]); ledger.scope('comparison', ['a', 'b']);
    const view = ledger.snapshot('comparison'), receipt = apply(ledger, 'operation', view);
    ledger.close(); ledger = new DecisionSpike(path);
    assert.deepEqual(apply(ledger, 'operation', view), receipt);
    ledger.acknowledge('a', 'operation');
    ledger.undo('undo', 'operation');
    assert.equal(ledger.pending().length, 2);
    for (const job of ledger.pending()) ledger.acknowledge(job.id, job.revision);
    assert.equal(ledger.pending().length, 0, 'no perpetual reassertion after completion');
  } finally { ledger?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('visual evaluation reports grouping errors separately from keeper agreement', () => {
  const expected = { groups: [{ ids: ['p0', 'p1'], keepers: ['p0'], reason: 'Alternatives.' }, { ids: ['p2'], keepers: ['p2'], reason: 'Different.' }] };
  const actual = { groups: [{ ids: ['p0', 'p1', 'p2'], keepers: ['p0', 'p2'], reason: 'Wrong merge, same keepers.' }] };
  assert.deepEqual(compareLabels(['p0', 'p1', 'p2'], actual, expected), { referenceLabelsProvided: true, falseMergePairs: 2, missedAlternativePairs: 0, exactPartition: false, exactKeeperSet: true });
  assert.deepEqual(compareLabels(['p0', 'p1', 'p2'], actual), { referenceLabelsProvided: false });
  assert.ok(!visionPrompt(['p0', 'p1'], 'check').jsonSchema.properties.groups.items.properties.keepers);
});

test('an HTTP-success-shaped answer with duplicate groups is rejected, retained privately, and never retried', async () => {
  let calls = 0;
  const output = { groups: [{ ids: ['p0', 'p1'], reason: 'private response text' }, { ids: ['p0', 'p1'], reason: 'another grouping' }] };
  const report = await evaluateImages({ analyzeImages: async () => { calls++; return { normalizedOutput: output }; } }, [], ['p0', 'p1'], 'check');
  assert.equal(calls, 1);
  assert.equal(report.status, 'invalid-answer');
  assert.equal(report.failure.reason, 'invalid membership');
  assert.deepEqual(report.output, output);
  assert.equal(report.scores, undefined);
  assert.ok(!JSON.stringify(publicEvaluationSummary(report)).includes('private response text'));
});

test('provider failures expose bounded diagnostics and preserve zero/one/multiple valid keeper answers', async () => {
  const failure = await evaluateImages({ analyzeImages: async () => { throw Object.assign(new Error('private provider details'), { status: 429 }); } }, [], ['p0', 'p1'], 'keeper');
  assert.equal(failure.status, 'provider-error');
  assert.equal(failure.failure.httpStatus, 429);
  assert.ok(!JSON.stringify(failure).includes('private provider details'));
  for (const keepers of [[], ['p0'], ['p0', 'p1']]) {
    const output = { groups: [{ ids: ['p0', 'p1'], keepers, reason: 'Synthetic explicit selection.' }] };
    const result = await evaluateImages({ analyzeImages: async () => ({ normalizedOutput: output }) }, [], ['p0', 'p1'], 'keeper', output);
    assert.equal(result.status, 'valid');
    assert.deepEqual(result.output.groups[0].keepers, keepers);
    assert.equal(result.scores.exactKeeperSet, true);
  }
});

test('visual CLI writes invalid model output only to the private report and exits unsuccessfully', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'curate-visual-failure-'));
  let calls = 0;
  const output = { groups: [{ ids: ['p0', 'p1'], reason: 'private answer' }, { ids: ['p0', 'p1'], reason: 'duplicate grouping' }] };
  const server = createServer((req, res) => {
    calls++; req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(join(dir, 'invented.jpg'), Buffer.alloc(32));
    const manifest = join(dir, 'case.json'), out = join(dir, 'report.json');
    writeFileSync(manifest, JSON.stringify({ photos: ['p0', 'p1'].map(id => ({ id, file: 'invented.jpg', mimeType: 'image/jpeg' })) }));
    const command = fileURLToPath(new URL('../../experiments/curate-v13/visual.mjs', import.meta.url));
    const child = spawn(process.execPath, [command, `--manifest=${manifest}`, '--role=check', '--submit', `--out=${out}`], { env: {
      CURATE_EVAL_PROVIDER: 'venice', CURATE_EVAL_MODEL: 'synthetic-model', CURATE_EVAL_API_KEY: 'synthetic-test-key',
      CURATE_EVAL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(exit, 1, stderr);
    assert.equal(calls, 1);
    assert.equal(JSON.parse(stdout).status, 'invalid-answer');
    assert.ok(!stdout.includes('private answer'));
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(report.output, output);
    assert.equal(report.promptVersion, 'curate_prototype_check_v2');
    assert.equal(statSync(out).mode & 0o777, 0o600);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('visual CLI is offline by default and rejects unsupported request sizes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'curate-visual-dry-run-'));
  try {
    writeFileSync(join(dir, 'synthetic.jpg'), Buffer.alloc(32));
    const manifest = { photos: ['p0', 'p1'].map(id => ({ id, file: 'synthetic.jpg', mimeType: 'image/jpeg' })) };
    const path = join(dir, 'case.json'); writeFileSync(path, JSON.stringify(manifest));
    const command = fileURLToPath(new URL('../../experiments/curate-v13/visual.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [command, `--manifest=${path}`], { env: {}, encoding: 'utf8' });
    const result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).requests, 0);
    manifest.photos = Array.from({ length: 31 }, (_, i) => ({ ...manifest.photos[0], id: `p${i}` }));
    writeFileSync(path, JSON.stringify(manifest)); assert.equal(run().status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const Provider of [OpenAiProvider, OpenAiCompatibleProvider, VeniceProvider]) test(`${Provider.name} transport preserves 30 inputs in one request (mocked, not vision quality)`, async () => {
  let submitted;
  const output = { groups: [{ ids: Array.from({ length: 30 }, (_, i) => `p${i}`), keepers: ['p3', 'p4'], reason: 'Two expressions.' }] };
  const provider = new Provider({ apiKey: 'synthetic-test-key', baseUrl: 'https://provider.invalid/v1', modelName: 'synthetic-model', fetchImpl: async (_url, request) => {
    submitted = JSON.parse(request.body);
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ output_text: JSON.stringify(output), choices: [{ message: { content: JSON.stringify(output) } }] }) };
  } });
  const images = Array.from({ length: 30 }, () => ({ data: Buffer.alloc(256 * 1024), mimeType: 'image/jpeg' }));
  const result = await provider.analyzeImages(images, visionPrompt(output.groups[0].ids, 'keeper'));
  const messages = submitted.input ?? submitted.messages;
  assert.equal(messages[1].content.filter(p => ['image_url', 'input_image'].includes(p.type)).length, 30);
  assert.deepEqual(validateAdvice(output.groups[0].ids, result.normalizedOutput).groups[0].keepers, ['p3', 'p4']);
});
