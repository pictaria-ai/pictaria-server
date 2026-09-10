import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/enrich/repository.mjs';
import { EnrichmentProfiles } from '../../src/enrich/profiles.mjs';
import { enrichPerformance, enrichPhotoDetails } from '../../src/enrich/performance.mjs';
import { createEnrichRoutes } from '../../src/routes/enrich.mjs';
import { seedPerformanceRun } from './performanceFixtures.mjs';
import { REPO_ROOT } from './helpers.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-performance-')); const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); }); return repo;
}
const accepted = ms => ({ outcome: 'accepted', ms });

test('latency is pooled over accepted attempts from all job outcomes; throughput uses weighted completed-run time including zero-success jobs', t => {
  const repo = fixture(t);
  seedPerformanceRun(repo, { elapsedMs: 10000, photos: [{ requests: [accepted(1000)] }, { requests: [{ outcome: 'timeout', ms: 5000 }, accepted(3000)] }] });
  seedPerformanceRun(repo, { elapsedMs: 90000, photos: [{ requests: [{ outcome: 'invalid_response', ms: 2000 }, accepted(9000)] }] });
  seedPerformanceRun(repo, { status: 'cancelled', elapsedMs: 60000, photos: [{ requests: [accepted(1000)] }] });
  seedPerformanceRun(repo, { elapsedMs: 10000, photos: [{ outcome: 'failed', requests: [{ outcome: 'http_error', httpStatus: 503, ms: 3000 }] }] });
  seedPerformanceRun(repo, { photos: [], skipped: 10000, elapsedMs: 60000 });
  const result = enrichPerformance(repo); assert.equal(result.comparisons.length, 1);
  const m = result.comparisons[0].metrics;
  assert.deepEqual(m.latency, { sampleCount: 4, medianMs: 2000, meanMs: 3500 });
  assert.equal(m.throughputRuns, 3); assert.equal(m.successfulPhotos, 3); assert.equal(m.elapsedMs, 110000);
  assert.equal(m.photosPerMinute, 3 * 60000 / 110000); assert.equal(m.secondsPerPhoto, 110 / 3);
  assert.equal(m.requests, 7); assert.equal(m.accepted, 4); assert.equal(m.timeouts, 1); assert.equal(m.failures, 2);
  assert.equal(m.invalidResponses, 1); assert.equal(m.retries, 2); assert.equal(m.cancelledRuns, 1); assert.equal(m.photoCount, 5);
});

test('material input changes and host labels split comparisons; label-only profile revisions and run sizes do not', t => {
  const repo = fixture(t);
  const config = { promptsDir: join(REPO_ROOT, 'prompts'), taxonomyPath: join(REPO_ROOT, 'taxonomy/v1.json'), promptVersion: 'v1' };
  const profiles = new EnrichmentProfiles({ repo, config }); profiles.initialize();
  const first = profiles.resolve();
  seedPerformanceRun(repo, { profile: first.attribution, host: 'Desktop' });
  const renamed = profiles.update(first.id, { ...profiles.get(first.id), name: 'Renamed profile', expectedRevisionId: first.revisionId });
  const revised = profiles.resolve({ profileRevisionId: renamed.revisionId });
  seedPerformanceRun(repo, { profile: revised.attribution, host: 'Desktop', photos: [] });
  let result = enrichPerformance(repo); assert.equal(result.comparisons.length, 1);
  assert.equal(result.comparisons[0].profileName, 'Renamed profile'); assert.equal(result.comparisons[0].metrics.runCount, 2);
  seedPerformanceRun(repo, { profile: revised.attribution, prompt: 'Different vocabulary and prompt', host: 'Desktop' });
  seedPerformanceRun(repo, { profile: revised.attribution, host: 'Server' });
  seedPerformanceRun(repo, { model: 'Other model', profile: revised.attribution, host: 'Desktop' });
  result = enrichPerformance(repo); assert.equal(result.totalComparisons, 4); assert.equal(result.comparisons.length, 3);
  assert.equal(result.comparisons[0].model, 'Other model');
  assert.equal(enrichPerformance(repo, { limit: 1000 }).comparisons.length, 4);
});

test('invalid or absent durations never become zero latency; zero-success throughput remains explicit', t => {
  const repo = fixture(t);
  seedPerformanceRun(repo, { photos: [{ outcome: 'failed', requests: [{ outcome: 'timeout', ms: null }] }] });
  let m = enrichPerformance(repo).comparisons[0].metrics;
  assert.deepEqual(m.latency, { sampleCount: 0, medianMs: null, meanMs: null }); assert.equal(m.photosPerMinute, 0); assert.equal(m.secondsPerPhoto, null);
  seedPerformanceRun(repo, { photos: [{ requests: [accepted(null), accepted(Infinity), accepted(0)] }] });
  m = enrichPerformance(repo).comparisons[0].metrics;
  assert.equal(m.accepted, 3); assert.deepEqual(m.latency, { sampleCount: 1, medianMs: 0, meanMs: 0 });
});

test('coverage gaps, orphaned interrupted runs, and saved results are explicit and stable across restart', t => {
  const repo = fixture(t);
  const seeded = seedPerformanceRun(repo, { status: 'interrupted', withJob: false,
    photos: [{ outcome: 'interrupted', ms: null, savedResult: true, filename: '<img onerror=alert(1)>.jpg', recordedRequests: 4,
      requests: [accepted(1234), { outcome: 'interrupted', ms: null }] }] });
  const snapshot = enrichPerformance(repo); const m = snapshot.comparisons[0].metrics;
  assert.equal(m.truncated, true); assert.equal(m.interrupted, 1); assert.equal(m.latency.medianMs, 1234); assert.equal(m.throughputRuns, 0);
  assert.equal(snapshot.runs[0].jobId, null);
  const detail = enrichPhotoDetails(repo, seeded.runId, { limit: 1 });
  assert.equal(detail.items[0].savedResultAvailable, true); assert.equal(detail.items[0].resultStatus, null);
  assert.equal(detail.items[0].duration_ms, null); assert.equal(detail.items[0].filename, '<img onerror=alert(1)>.jpg');
  const reader = new Repository(repo.databasePath); reader.initSchema();
  try { assert.deepEqual(enrichPerformance(reader), snapshot); } finally { reader.close(); }
  repo.db.prepare('DELETE FROM enrich_photo_executions WHERE id=?').run(seeded.photoIds[0]);
  assert.equal(enrichPerformance(repo).comparisons[0].metrics.truncated, true);
  assert.equal(enrichPhotoDetails(repo, seeded.runId).truncated, true);
  repo.db.prepare('DELETE FROM enrich_timing_runs WHERE id=?').run(seeded.runId);
  assert.equal(enrichPhotoDetails(repo, seeded.runId), null);
});

test('performance API validates limits and empty state without depending on Prometheus or Immich', async t => {
  const repo = fixture(t); const handler = createEnrichRoutes({ repo });
  async function get(path) { const out = {}; await handler({ method: 'GET' }, { writeHead(status) { out.status = status; }, end(body) { out.body = JSON.parse(body); } }, new URL(path, 'http://test')); return out; }
  for (const value of ['0', '101', 'NaN', '3.5', '-1']) await assert.rejects(get(`/api/enrich/performance?limit=${value}`), /1–100/);
  const empty = await get('/api/enrich/performance'); assert.equal(empty.status, 200); assert.deepEqual(empty.body.comparisons, []);
  for (let i = 0; i < 5; i++) seedPerformanceRun(repo, { model: `Model ${i}` });
  assert.equal((await get('/api/enrich/performance')).body.comparisons.length, 3);
  assert.equal((await get('/api/enrich/performance?limit=100')).body.comparisons.length, 5);
  const latest = repo.listJobRuns()[0];
  assert.deepEqual((await get(`/api/enrich/runs/${latest.id}`)).body.run, latest);
  assert.equal((await get('/api/enrich/runs/999999')).status, 404);
  assert.equal((await get('/api/enrich/runs/9007199254740992')).status, 404);
  assert.equal((await get('/api/enrich/runs/0')).status, 404);
  const oldest = repo.listJobRuns(100).at(-1);
  for (let i = 0; i < 25; i++) seedPerformanceRun(repo, { photos: [] });
  assert.deepEqual((await get(`/api/enrich/runs/${oldest.id}`)).body.run, oldest);
  assert.equal('log' in (await get(`/api/enrich/runs/${oldest.id}`)).body.run, false);
  const page = await get(`/api/enrich/timings/${latest.timingRunId}/photos`); assert.ok(page.body.items[0].filename);
  assert.equal(page.body.immichUrl, null);
  assert.equal(page.body.items[0].requests.items[0].outcome, 'accepted');
  assert.equal(page.body.items[0].requests.nextCursor, null);
  assert.equal('nextAfterId' in page.body.items[0].requests, false);
  const retries = seedPerformanceRun(repo, { photos: [{ requests: Array.from({length:22}, () => accepted(1000)) }] });
  const details = await get(`/api/enrich/timings/${retries.runId}/photos`);
  const initial = details.body.items[0].requests;
  assert.equal(initial.items.length, 20); assert.equal(initial.retained, 22);
  const rest = await get(`/api/enrich/timings/photos/${retries.photoIds[0]}/attempts?cursor=${encodeURIComponent(initial.nextCursor)}`);
  assert.equal(rest.body.items.length, 2); assert.equal(rest.body.nextCursor, null);
  assert.equal(rest.body.items[0].ordinal, 21);
});

test('the comparison cohort is bounded to retained runs and unknown identities never collapse together', t => {
  const repo = fixture(t);
  for (let i = 0; i < 105; i++) seedPerformanceRun(repo, { model: `Setup ${i}`, photos: [] });
  const page = enrichPerformance(repo, { limit: 100 }); assert.equal(page.runs.length, 100); assert.equal(page.comparisons.length, 100);
  assert.equal(page.comparisons[0].model, 'Setup 104'); assert.equal(page.comparisons.at(-1).model, 'Setup 5');
  repo.db.prepare("UPDATE enrich_timing_runs SET configuration_id = 'unknown', model = 'same model'").run();
  assert.equal(enrichPerformance(repo, { limit: 100 }).comparisons.length, 100);
});

test('maximum retained detail aggregates without loading payload blobs or changing sample counts', t => {
  const repo = fixture(t); const seeded = seedPerformanceRun(repo, { photos: [], analyzed: 10000, successes: 10000, elapsedMs: 1000000 });
  repo.transaction(() => {
    const photo = repo.db.prepare(`INSERT INTO enrich_photo_executions(timing_run_id,asset_id,started_at,outcome,attempt_count) VALUES(?,'fixture','2026-09-01','succeeded',6)`);
    const attempt = repo.db.prepare(`INSERT INTO enrich_provider_attempts(photo_execution_id,ordinal,started_at,outcome,duration_ms) VALUES(?,?,'2026-09-01',?,?)`);
    for (let i = 0; i < 10000; i++) {
      const id = Number(photo.run(seeded.runId).lastInsertRowid);
      for (let j = 1; j <= 6; j++) attempt.run(id, j, j === 6 ? 'accepted' : 'http_error', j === 6 ? 8000 : 1000);
    }
    repo.db.prepare('UPDATE enrich_timing_runs SET photo_count=10000,attempt_count=60000 WHERE id=?').run(seeded.runId);
  });
  const start = performance.now(); const result = enrichPerformance(repo); const m = result.comparisons[0].metrics;
  t.diagnostic(`Aggregated 10k photos / 60k requests in ${Math.round(performance.now() - start)} ms`);
  assert.equal(m.latency.sampleCount, 10000); assert.equal(m.latency.medianMs, 8000); assert.equal(m.latency.meanMs, 8000);
  assert.equal(m.requests, 60000); assert.equal(m.retries, 50000); assert.equal(m.retainedPhotos, 10000); assert.equal(m.truncated, false);
  assert.ok(JSON.stringify(result).length < 10000, 'only compact summaries leave the server');
});
