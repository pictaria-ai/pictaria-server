import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/enrich/repository.mjs';
import { enrichPerformance } from '../../src/enrich/performance.mjs';
import { loadConfig } from '../../src/config.mjs';
import { SettingsStore } from '../../src/settings.mjs';
import { seedPerformanceRun } from './performanceFixtures.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-history-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  return { repo, dir };
}
const job = n => ({ title: `Run ${n}`, provider: 'venice', model: 'fixture', promptVersion: 'v1', taxonomyVersion: 'v1', status: 'finished',
  counters: { analyzed: 1, succeeded: 1 }, log: [`Finished photo ${n}`],
  startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z' });
const count = (repo, table) => repo.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test('larger history aligns run and performance windows, prunes immediately, and protects active work and results', t => {
  const { repo } = fixture(t); repo.setHistoryRetention({ runs: 1000, logs: 100 });
  const first = seedPerformanceRun(repo);
  const active = repo.timings.startRun(first.configuration);
  for (let n = 0; n < 1000; n++) seedPerformanceRun(repo, { host: `Host ${n}`, photos: [] });
  assert.equal(count(repo, 'job_runs'), 1000);
  assert.equal(count(repo, 'enrich_timing_runs'), 1001); // active older run is protected
  const started = performance.now();
  const performanceResult = enrichPerformance(repo, { limit: 1000 });
  t.diagnostic(`1,000 setups: ${Math.round(performance.now() - started)} ms, ${Buffer.byteLength(JSON.stringify(performanceResult))} response bytes`);
  assert.equal(performanceResult.runs.length, 1000); assert.equal(performanceResult.comparisons.length, 1000);
  assert.equal(performanceResult.window.maxRuns, 1000);
  repo.setHistoryRetention({ runs: 100, logs: 0 });
  assert.equal(count(repo, 'job_runs'), 100); assert.equal(count(repo, 'enrich_timing_runs'), 101);
  repo.timings.finishRun(active, 'finished');
  assert.equal(count(repo, 'enrich_timing_runs'), 100);
  assert.equal(count(repo, 'enrich_photo_executions'), 0); // timing expiry cascades
  assert.equal(count(repo, 'enrich_provider_attempts'), 0);
  assert.equal(count(repo, 'processing_runs'), 1); assert.equal(count(repo, 'latest_success'), 1);
  assert.equal(enrichPerformance(repo).window.maxRuns, 100);
});

test('log caps are independent, keyset pages cover the maximum, and history is not resurrected', t => {
  const { repo } = fixture(t); repo.setHistoryRetention({ runs: 1000, logs: 10 });
  for (let n = 1; n <= 1005; n++) repo.recordJobRun(job(n));
  assert.equal(count(repo, 'job_runs'), 1000);
  assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM job_runs WHERE log_json IS NOT NULL').get().n, 10);
  const ids = []; let beforeId;
  do {
    const page = repo.jobRunsPage({ beforeId, limit: 50 });
    assert.ok(page.runs.every(r => !Object.hasOwn(r, 'log')));
    ids.push(...page.runs.map(r => r.id)); beforeId = page.nextBeforeId;
  } while (beforeId);
  assert.deepEqual(ids, Array.from({ length: 1000 }, (_, n) => 1005 - n));
  assert.equal(repo.getJobRunLog(6).log.length, 0);
  assert.equal(repo.getJobRunLog(1005).log.length, 1);
  repo.setHistoryRetention({ runs: 100, logs: 0 });
  repo.setHistoryRetention({ runs: 1000, logs: 100 });
  assert.equal(count(repo, 'job_runs'), 100);
  assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM job_runs WHERE log_json IS NOT NULL').get().n, 0);
});

test('an old retained failed run remains retryable after its log expires', t => {
  const { repo } = fixture(t); repo.setHistoryRetention({ runs: 1000, logs: 0 });
  repo.upsertAsset({ id: 'failed-photo' });
  repo.recordProcessingRun({ assetId: 'failed-photo', provider: 'venice', model: 'fixture', promptVersion: 'v1', taxonomyVersion: 'v1', status: 'failed',
    startedAt: job(0).startedAt, finishedAt: job(0).finishedAt });
  // recordProcessingRun owns its timestamp; include it in the job boundary.
  const at = repo.db.prepare('SELECT started_at FROM processing_runs').get().started_at;
  repo.recordJobRun({ ...job(0), status: 'failed', startedAt: at, finishedAt: at });
  for (let n = 1; n < 1000; n++) repo.recordJobRun(job(n));
  assert.deepEqual(repo.jobRunRetryFailures(1).assetIds, ['failed-photo']);
  repo.setHistoryRetention({ runs: 100, logs: 0 }); assert.equal(repo.jobRunRetryFailures(1), null);
});

test('settings apply retention live, survive restart and backup, and reject invalid bounds before persistence', t => {
  const { repo, dir } = fixture(t); const config = loadConfig({ ENRICH_HISTORY_RUNS: '500', ENRICH_HISTORY_LOGS: '30' });
  const path = join(dir, 'settings.json');
  const store = new SettingsStore({ filePath: path, config, env: { ENRICH_HISTORY_RUNS: '500', ENRICH_HISTORY_LOGS: '30' } }).load();
  store.onApplied = () => repo.setHistoryRetention({ runs: config.enrichHistoryRuns, logs: config.enrichHistoryLogs });
  store.onApplied(); assert.deepEqual(repo.historyRetention, { runs: 500, logs: 30 });
  store.update({ enrich: { historyRuns: 1000, historyLogs: 0 } });
  for (let n = 0; n < 1000; n++) repo.recordJobRun(job(n));
  for (const patch of [{ historyRuns: 1001 }, { historyRuns: 99 }, { historyRuns: 100.5 }, { historyLogs: 101 }, { historyLogs: -1 }, { historyLogs: 1.5 }]) {
    assert.throws(() => store.update({ enrich: patch }));
    assert.equal(store.describe().enrich.historyRuns.value, 1000);
  }
  const restoredConfig = loadConfig({}); new SettingsStore({ filePath: path, config: restoredConfig, env: {} }).load();
  const backup = join(dir, 'backup.sqlite'); repo.backupTo(backup);
  const restored = new Repository(backup); restored.initSchema();
  try {
    restored.setHistoryRetention({ runs: restoredConfig.enrichHistoryRuns, logs: restoredConfig.enrichHistoryLogs });
    assert.equal(count(restored, 'job_runs'), 1000); assert.equal(restored.timings.runLimit, 1000);
  } finally { restored.close(); }
  store.update({ enrich: { historyRuns: 100, historyLogs: 0 } }); assert.equal(count(repo, 'job_runs'), 100);
  assert.equal(loadConfig({ ENRICH_HISTORY_RUNS: '999999', ENRICH_HISTORY_LOGS: '-1' }).enrichHistoryRuns, 1000);
  assert.equal(loadConfig({ ENRICH_HISTORY_LOGS: '-1' }).enrichHistoryLogs, 0);
});

test('maximum summary history keeps realistic and full-size diagnostic logs within a separate byte bound', t => {
  const { repo } = fixture(t); repo.setHistoryRetention({ runs: 1000, logs: 100 });
  for (let n = 0; n < 1000; n++) repo.recordJobRun(job(n));
  repo.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  t.diagnostic(`1,000 ordinary summaries + 100 short logs: ${statSync(repo.databasePath).size} database bytes`);
  const log = Array.from({ length: 500 }, () => 'D'.repeat(512));
  for (let n = 0; n < 150; n++) repo.recordJobRun({ ...job(n), log });
  const bytes = repo.db.prepare('SELECT SUM(length(CAST(log_json AS BLOB))) n FROM job_runs').get().n;
  assert.ok(bytes > 20 * 1024 * 1024); assert.ok(bytes <= 100 * 256 * 1024);
  assert.equal(count(repo, 'job_runs'), 1000);
  repo.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  t.diagnostic(`1,000 summaries + 100 near-cap logs: ${bytes} log bytes, ${statSync(repo.databasePath).size} database bytes`);
});
