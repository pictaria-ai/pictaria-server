import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../../src/enrich/repository.mjs';
import { EnrichTimingStore, TIMING_LIMITS, measureProviderRequest } from '../../src/enrich/timing.mjs';
import { runBatch } from '../../src/enrich/runner.mjs';
import { createProvider } from '../../src/enrich/providers.mjs';
import { captureRunConfiguration } from '../../src/enrich/runConfiguration.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { createEnrichRoutes } from '../../src/routes/enrich.mjs';
import { loadV1Taxonomy, sampleOutput, REPO_ROOT } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();
const response = (output = sampleOutput()) => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
function fixture(t, fetchImpl = async () => response()) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-timing-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const clock = { ms: 0, wall: '2026-09-08T12:00:00.000Z' };
  repo.timings = new EnrichTimingStore(repo.db, { monotonicNow: () => clock.ms, wallNow: () => clock.wall });
  const provider = createProvider('local_lmstudio', { modelName: 'timing-model', fetchImpl });
  const immich = {
    getAsset: async id => ({ id }),
    getAssetThumbnail: async () => { clock.ms += 25; return { data: Buffer.from('image'), contentType: 'image/jpeg' }; },
  };
  const options = { repo, immich, provider, taxonomy, systemPrompt: 'System', userTemplate: '{approved_tags}', assetIds: ['a'], reprocess: true };
  return { repo, clock, provider, immich, options, dir };
}
function photos(h, index = 0) { return h.repo.timings.photos(h.repo.timings.runs().items[index].id).items; }
function attempts(h, photo) { return h.repo.timings.attempts(photo.id).items; }

test('photo timing includes download and persistence; request latency uses monotonic time and survives a later failed rerun', async t => {
  let h; let fail = false;
  h = fixture(t, async () => { h.clock.ms += 120; h.clock.wall = '2026-09-08T11:59:00.000Z'; if (fail) throw new Error('connection refused'); return response(); });
  const persist = h.repo.replaceAssetTags.bind(h.repo);
  h.repo.replaceAssetTags = (...args) => { h.clock.ms += 35; return persist(...args); };
  await runBatch(h.options);
  const first = photos(h)[0];
  assert.equal(first.duration_ms, 180); assert.equal(first.outcome, 'succeeded');
  assert.ok(first.processing_run_id > 0);
  const attempt = attempts(h, first)[0];
  assert.equal(attempt.duration_ms, 120); assert.equal(attempt.outcome, 'accepted'); assert.equal(attempt.http_status, 200);
  assert.ok(attempt.finished_at < attempt.started_at, 'wall clock can move backwards without corrupting elapsed time');
  fail = true; await runBatch(h.options);
  const later = photos(h, 1)[0];
  assert.notEqual(first.id, later.id); assert.equal(later.asset_id, first.asset_id);
  assert.equal(later.outcome, 'failed'); assert.equal(attempts(h, later)[0].outcome, 'transport_error');
  assert.equal(h.repo.db.prepare("SELECT run_id FROM latest_success WHERE asset_id = 'a'").get().run_id, first.processing_run_id);
  assert.deepEqual(attempts(h, first)[0], attempt);
});

test('overload and validation retries record each request, while retry waits belong only to the photo', async t => {
  let h; let calls = 0;
  h = fixture(t, async () => {
    h.clock.ms += 50; calls++;
    if (calls === 1) return new Response('{}', { status: 503, headers: { 'retry-after': '1' } });
    return response(calls === 2 ? {} : sampleOutput());
  });
  await runBatch({ ...h.options, retrySleep: async ms => { h.clock.ms += ms; } });
  const photo = photos(h)[0]; const rows = attempts(h, photo);
  assert.equal(photo.outcome, 'succeeded'); assert.equal(photo.duration_ms, 1175);
  assert.deepEqual(rows.map(r => [r.ordinal, r.duration_ms, r.outcome, r.http_status]), [
    [1, 50, 'http_error', 503], [2, 50, 'invalid_response', 200], [3, 50, 'accepted', 200],
  ]);
});

test('invalid outer JSON, adapter extraction, HTTP errors, skips and download failures are distinct', async t => {
  for (const [fetchImpl, expected] of [
    [async () => new Response('not json'), 'invalid_response'],
    [async () => Response.json({ choices: [] }), 'invalid_response'],
    [async () => new Response('{}', { status: 401 }), 'http_error'],
  ]) {
    const h = fixture(t, fetchImpl); await runBatch(h.options);
    assert.equal(attempts(h, photos(h)[0])[0].outcome, expected);
  }
  const h = fixture(t); await runBatch(h.options);
  await runBatch({ ...h.options, reprocess: false });
  assert.deepEqual(photos(h, 1), []);
  assert.equal(h.repo.timings.runs().items[1].skipped_successful, 1);
  assert.equal(h.repo.timings.runs().items[1].attempt_count, 0);
  h.immich.getAssetThumbnail = async () => { throw new Error('download failed'); };
  await runBatch(h.options);
  assert.equal(photos(h, 2)[0].error_kind, 'download_error'); assert.deepEqual(attempts(h, photos(h, 2)[0]), []);
});

test('cancellation during retry wait preserves the completed HTTP attempt; cancellation after download makes none', async t => {
  const h = fixture(t, async () => new Response('{}', { status: 503 }));
  let cancelled = false;
  await runBatch({ ...h.options, shouldStop: () => cancelled, retrySleep: async ms => { h.clock.ms += ms; cancelled = true; } });
  const photo = photos(h)[0];
  assert.equal(photo.outcome, 'cancelled'); assert.equal(attempts(h, photo)[0].outcome, 'http_error');
  assert.equal(h.repo.timings.runs().items[0].outcome, 'cancelled');
  cancelled = false;
  h.immich.getAssetThumbnail = async () => { cancelled = true; return { data: Buffer.from('image'), contentType: 'image/jpeg' }; };
  await runBatch({ ...h.options, shouldStop: () => cancelled });
  assert.equal(photos(h, 1)[0].outcome, 'cancelled'); assert.deepEqual(attempts(h, photos(h, 1)[0]), []);
});

async function httpProvider(t, handler, timeoutMs = 500) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return createProvider('local_lmstudio', { modelName: 'native-model', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs });
}

test('native HTTP timeout and cancellation are measured, and pre-dispatch cancellation makes no request', async t => {
  const h = fixture(t);
  let notified; const received = new Promise(resolve => { notified = resolve; });
  const provider = await httpProvider(t, () => notified(), 250);
  h.repo.timings = new EnrichTimingStore(h.repo.db);
  await runBatch({ ...h.options, provider });
  assert.equal(attempts(h, photos(h)[0])[0].outcome, 'timeout');
  assert.ok(attempts(h, photos(h)[0])[0].duration_ms >= 20);
  const controller = new AbortController();
  const secondReceived = new Promise(resolve => { notified = resolve; });
  const running = runBatch({ ...h.options, provider, signal: controller.signal, shouldStop: () => controller.signal.aborted });
  await received; await secondReceived; controller.abort(); await running;
  assert.equal(attempts(h, photos(h, 1)[0])[0].outcome, 'cancelled');
  await runBatch({ ...h.options, provider, signal: controller.signal });
  assert.deepEqual(attempts(h, photos(h, 2)[0]), []);
});

test('multiple actual requests inside an adapter are distinct, and unrelated provider calls are excluded', async t => {
  const h = fixture(t);
  let calls = 0;
  const native = await httpProvider(t, (req, res) => {
    calls++;
    if (calls === 1) return; // timeout, followed by a custom adapter's fallback
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleOutput()) } }] }));
  }, 250);
  const provider = { providerName: 'local_lmstudio', modelName: 'native-model', async analyzeImage(image, options) {
    try { await native.analyzeImage(image, options); } catch { /* adapter-specific fallback */ }
    return native.analyzeImage(image, options);
  } };
  await runBatch({ ...h.options, provider });
  assert.deepEqual(attempts(h, photos(h)[0]).map(r => r.outcome), ['timeout', 'accepted']);
  await native.analyzeImage({ data: Buffer.from('other'), mimeType: 'image/jpeg' }, { systemPrompt: 'other', userPrompt: 'other', jsonSchema: {} });
  assert.equal(attempts(h, photos(h)[0]).length, 2);
});

test('crash recovery and late completion preserve completed requests and leave incomplete durations unknown', async t => {
  const h = fixture(t); const configuration = captureRunConfiguration(h.options);
  h.repo.saveRunConfiguration(configuration);
  const runId = h.repo.timings.startRun(configuration); const photo = h.repo.timings.startPhoto(runId, 'a');
  let release;
  await photo.analyze(() => measureProviderRequest(async () => 'valid'));
  const completed = attempts(h, { id: photo.id })[0];
  const pending = photo.analyze(() => measureProviderRequest(() => new Promise(resolve => { release = resolve; })));
  const readerDuringRun = new Repository(h.repo.databasePath);
  try { readerDuringRun.initSchema(); assert.equal(readerDuringRun.timings.runs().items[0].outcome, 'running'); } finally { readerDuringRun.close(); }
  h.repo.timings.interrupt();
  let rows = attempts(h, { id: photo.id });
  assert.deepEqual(rows[0], completed);
  assert.equal(rows[1].outcome, 'interrupted'); assert.equal(rows[1].duration_ms, null); assert.equal(rows[1].finished_at, null);
  release('late result'); await pending; photo.finish('succeeded'); h.repo.timings.finishRun(runId, 'finished');
  assert.deepEqual(attempts(h, { id: photo.id }), rows);
  const interrupted = h.repo.timings.photos(runId).items[0];
  assert.equal(interrupted.outcome, 'interrupted'); assert.equal(interrupted.finished_at, null); assert.equal(interrupted.duration_ms, null);
  // Opening a read handle must not interrupt active work. Recovery is explicit at server startup.
  const reader = new Repository(h.repo.databasePath); reader.initSchema();
  try { assert.equal(reader.timings.runs().items[0].outcome, 'interrupted'); } finally { reader.close(); }
});

test('a received response without validation at interruption never becomes an accepted sample', async t => {
  const h = fixture(t); const runId = h.repo.timings.startRun(captureRunConfiguration(h.options));
  const photo = h.repo.timings.startPhoto(runId, 'a'); let release; let received;
  const wait = new Promise(resolve => { received = resolve; });
  const pending = photo.analyze(async () => { await measureProviderRequest(async () => 'body'); received(); await new Promise(resolve => { release = resolve; }); });
  await wait; h.repo.timings.interrupt(); release(); await pending;
  const row = attempts(h, { id: photo.id })[0];
  assert.equal(row.outcome, 'response_received'); assert.notEqual(row.duration_ms, null);
});

test('timing reads paginate with strict bounds; retention exposes gaps and preserves result history', async t => {
  const h = fixture(t); await runBatch(h.options);
  const runId = h.repo.timings.runs().items[0].id;
  // Bulk seed terminal telemetry to exercise actual retention limits cheaply.
  h.repo.transaction(() => {
    const insert = h.repo.db.prepare(`INSERT INTO enrich_photo_executions(timing_run_id, asset_id, started_at, outcome) VALUES (?, 'bulk', '2026-09-08', 'skipped')`);
    for (let i = 0; i < TIMING_LIMITS.photos + 1; i++) insert.run(runId);
    h.repo.db.prepare('UPDATE enrich_timing_runs SET photo_count = ? WHERE id = ?').run(TIMING_LIMITS.photos + 2, runId);
  });
  h.repo.timings.photoWrites = 0;
  const active = h.repo.timings.startRun(captureRunConfiguration(h.options));
  h.repo.timings.startPhoto(active, 'new').finish('skipped');
  assert.equal(h.repo.timings.photos(runId, { limit: 999999 }).items.length, TIMING_LIMITS.page);
  assert.equal(h.repo.timings.photos(runId).truncated, true);
  assert.equal(h.repo.timings.attempts(1), null, 'photo pruning cascades its attempts');
  assert.equal(h.repo.hasAnySuccessfulRun('a'), true);
  const first = h.repo.timings.photos(runId, { limit: 2 });
  const second = h.repo.timings.photos(runId, { limit: 2, afterId: first.nextAfterId });
  assert.ok(first.items[1].id < second.items[0].id);
  const currentPhoto = h.repo.timings.startPhoto(active, 'attempt-cap');
  h.repo.transaction(() => {
    const insert = h.repo.db.prepare(`INSERT INTO enrich_provider_attempts(photo_execution_id, ordinal, started_at, outcome) VALUES (?, ?, '2026-09-08', 'accepted')`);
    for (let i = 1; i <= TIMING_LIMITS.attempts + 1; i++) insert.run(currentPhoto.id, i);
    h.repo.db.prepare('UPDATE enrich_photo_executions SET attempt_count = ? WHERE id = ?').run(TIMING_LIMITS.attempts + 1, currentPhoto.id);
  });
  h.repo.timings.attemptWrites = 0;
  await currentPhoto.analyze(() => measureProviderRequest(async () => 'ok'));
  assert.equal(h.repo.timings.attempts(currentPhoto.id).retained, TIMING_LIMITS.attempts);
  assert.equal(h.repo.timings.attempts(currentPhoto.id).truncated, true);
  assert.equal(h.repo.timings.attempts(currentPhoto.id, { limit: Infinity }).items.length, 50);
  currentPhoto.finish('succeeded'); h.repo.timings.finishRun(active, 'finished');
  for (let i = 0; i < TIMING_LIMITS.runs; i++) h.repo.timings.finishRun(h.repo.timings.startRun(captureRunConfiguration(h.options)), 'finished');
  assert.equal(h.repo.timings.photos(runId), null);
  assert.equal(h.repo.hasAnySuccessfulRun('a'), true);
});

test('job history links the timing run and read-only API exposes bounded pages and legacy unknowns', async t => {
  const h = fixture(t);
  const config = { defaultProvider: 'local_lmstudio', imageSource: 'preview', promptsDir: join(REPO_ROOT, 'prompts'), promptVersion: 'v1',
    providers: { local_lmstudio: { modelName: 'timing-model', fetchImpl: async () => response() } } };
  const runner = new EnrichJobRunner({ repo: h.repo, immich: h.immich, taxonomy, config });
  h.repo.db.exec(`CREATE TRIGGER fail_timing_run BEFORE INSERT ON enrich_timing_runs BEGIN SELECT RAISE(ABORT, 'timing unavailable'); END;`);
  assert.throws(() => runner.start({ assetIds: ['a'] }), /timing unavailable/);
  assert.equal(runner.isBusy(), false, 'failed telemetry startup must not leave a stuck runner');
  h.repo.db.exec('DROP TRIGGER fail_timing_run');
  runner.start({ assetIds: ['a', 'b'] }); await runner.runPromise;
  const job = h.repo.listJobRuns()[0];
  assert.ok(job.timingRunId); assert.equal(h.repo.timings.runs().items[0].job_run_id, job.id);
  const handler = createEnrichRoutes({ repo: h.repo, enrichRunner: runner, config, taxonomy, requireImmich: () => true });
  async function get(path) {
    const result = {}; await handler({ method: 'GET' }, { writeHead(status) { result.status = status; }, end(body) { result.body = JSON.parse(body); } }, new URL(path, 'http://test'));
    return result;
  }
  const first = await get(`/api/enrich/timings/${job.timingRunId}/photos?limit=1`);
  assert.equal(first.status, 200); assert.equal(first.body.items.length, 1); assert.ok(first.body.nextCursor);
  const second = await get(`/api/enrich/timings/${job.timingRunId}/photos?limit=1&cursor=${first.body.nextCursor}`);
  assert.equal(second.body.nextCursor, null); assert.notEqual(second.body.items[0].id, first.body.items[0].id);
  const requests = await get(`/api/enrich/timings/photos/${first.body.items[0].id}/attempts`);
  assert.equal(requests.body.items[0].outcome, 'accepted');
  assert.equal((await get('/api/enrich/timings/999999/photos')).status, 404);
  await assert.rejects(get('/api/enrich/timings?limit=999999'), /pages must contain/);
  await assert.rejects(get('/api/enrich/timings?cursor=invalid!'), /Invalid/);
  h.repo.recordJobRun({ title: 'Legacy', provider: 'local_lmstudio', status: 'finished', counters: { failed: 0 }, startedAt: '2026-09-01', finishedAt: '2026-09-01' });
  assert.equal(h.repo.listJobRuns()[0].timingRunId, null);
});

test('schema 9 upgrades without inventing old timing, and the migration is restart-idempotent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-timing-upgrade-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'enrichment.sqlite'); const db = new DatabaseSync(path);
  db.exec(readFileSync(join(REPO_ROOT, 'test/fixtures/upgrades/enrichment-v9.sql'), 'utf8'));
  db.exec("PRAGMA user_version = 9; INSERT INTO job_runs(title, provider, status, started_at, finished_at) VALUES ('Old', 'venice', 'finished', '2026-09-01', '2026-09-01');"); db.close();
  const repo = new Repository(path);
  try {
    assert.deepEqual(repo.initSchema().applied, [10, 11]);
    assert.equal(repo.listJobRuns()[0].timingRunId, null); assert.deepEqual(repo.timings.runs().items, []);
    assert.deepEqual(repo.initSchema().applied, []);
  } finally { repo.close(); }
});

test('a successful request remains available when a later scan failure aborts the job', async t => {
  const h = fixture(t); let scans = 0;
  h.immich.listImageAssets = async () => {
    if (++scans > 1) throw new Error('metadata scan failed');
    return [{ id: 'a', type: 'IMAGE' }];
  };
  await assert.rejects(runBatch({ ...h.options, assetIds: null, limit: 1, maxAnalyzed: 2 }), /metadata scan failed/);
  assert.equal(h.repo.timings.runs().items[0].outcome, 'failed');
  assert.equal(attempts(h, photos(h)[0])[0].outcome, 'accepted');
});

test('cold restart preserves completed attempts and marks only pending work interrupted', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-timing-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'enrichment.sqlite');
  const repo = new Repository(path); repo.initSchema();
  const configuration = captureRunConfiguration({ provider: createProvider('local_lmstudio', { modelName: 'fixture' }), taxonomy, systemPrompt: 'System', userTemplate: '{approved_tags}' });
  repo.saveRunConfiguration(configuration);
  const runId = repo.timings.startRun(configuration); const photo = repo.timings.startPhoto(runId, 'a');
  await photo.analyze(() => measureProviderRequest(async () => 'accepted'));
  const before = repo.timings.attempts(photo.id).items[0];
  // A dispatched request whose promise never settles models process death.
  photo.analyze(() => measureProviderRequest(() => new Promise(() => {})));
  repo.close();
  const restarted = new Repository(path);
  try {
    restarted.initSchema(); restarted.timings.interrupt();
    const rows = restarted.timings.attempts(photo.id).items;
    assert.deepEqual(rows[0], before);
    assert.equal(rows[1].outcome, 'interrupted'); assert.equal(rows[1].duration_ms, null); assert.equal(rows[1].finished_at, null);
    assert.equal(restarted.timings.runs().items[0].outcome, 'interrupted');
    restarted.timings.interrupt(); assert.deepEqual(restarted.timings.attempts(photo.id).items, rows);
  } finally { restarted.close(); }
});

test('a failed timing write cannot commit a photo or request without its lifetime counters', async t => {
  const h = fixture(t); const runId = h.repo.timings.startRun(captureRunConfiguration(h.options));
  h.repo.db.exec(`CREATE TRIGGER fail_photo_count BEFORE UPDATE OF photo_count ON enrich_timing_runs BEGIN SELECT RAISE(ABORT, 'counter unavailable'); END;`);
  assert.throws(() => h.repo.timings.startPhoto(runId, 'a'), /counter unavailable/);
  assert.equal(h.repo.timings.photos(runId).items.length, 0);
  h.repo.db.exec('DROP TRIGGER fail_photo_count');
  const photo = h.repo.timings.startPhoto(runId, 'a'); let dispatched = false;
  h.repo.db.exec(`CREATE TRIGGER fail_attempt_count BEFORE UPDATE OF attempt_count ON enrich_timing_runs BEGIN SELECT RAISE(ABORT, 'counter unavailable'); END;`);
  await assert.rejects(photo.analyze(() => measureProviderRequest(async () => { dispatched = true; })), /counter unavailable/);
  assert.equal(dispatched, false);
  assert.equal(h.repo.timings.attempts(photo.id).items.length, 0);
  assert.equal(h.repo.timings.attempts(photo.id).photo.attempt_count, 0);
});
