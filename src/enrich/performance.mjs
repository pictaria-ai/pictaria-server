import { TIMING_LIMITS } from './timing.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const validDuration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function metric() {
  return { runCount: 0, photoCount: 0, recordedRequests: 0, retainedPhotos: 0, requests: 0,
    accepted: 0, timeouts: 0, failures: 0, invalidResponses: 0, cancelled: 0, interrupted: 0, unvalidated: 0, running: 0,
    retries: 0, latencies: [], throughputRuns: 0, successfulPhotos: 0, elapsedMs: 0,
    failedRuns: 0, cancelledRuns: 0, interruptedRuns: 0, activeRuns: 0 };
}
function addRun(m, r) {
  m.runCount++; m.photoCount += count(r.photo_count); m.recordedRequests += count(r.attempt_count);
  if (r.outcome === 'failed') m.failedRuns++;
  if (r.outcome === 'cancelled') m.cancelledRuns++;
  if (r.outcome === 'interrupted') m.interruptedRuns++;
  if (r.outcome === 'running') m.activeRuns++;
  // Whole-run throughput uses only completed jobs that actually processed
  // photos, including zero-success jobs. Never average individual rates.
  if (r.job_status !== 'finished') return;
  let counters; try { counters = JSON.parse(r.counters_json); } catch { return; }
  const ms = Date.parse(r.job_finished_at) - Date.parse(r.job_started_at);
  if (!counters || !Number.isSafeInteger(counters.succeeded) || counters.succeeded < 0
    || !Number.isSafeInteger(counters.analyzed) || counters.analyzed <= 0 || counters.succeeded > counters.analyzed || !Number.isFinite(ms) || ms <= 0) return;
  m.throughputRuns++; m.successfulPhotos += counters.succeeded; m.elapsedMs += ms;
}
function addAttempt(m, a) {
  m.requests++;
  if (a.ordinal > 1) m.retries++;
  if (a.outcome === 'accepted') {
    m.accepted++;
    if (validDuration(a.duration_ms)) m.latencies.push(a.duration_ms);
  } else if (a.outcome === 'timeout') m.timeouts++;
  else if (a.outcome === 'cancelled') m.cancelled++;
  else if (a.outcome === 'interrupted') m.interrupted++;
  else if (a.outcome === 'running') m.running++;
  else if (a.outcome === 'response_received') m.unvalidated++;
  else { m.failures++; if (a.outcome === 'invalid_response') m.invalidResponses++; }
}
function finish(m) {
  const { latencies, ...result } = m;
  latencies.sort((a, b) => a - b);
  const n = latencies.length;
  return { ...result, latency: { sampleCount: n,
    medianMs: n ? (latencies[Math.floor((n - 1) / 2)] + latencies[Math.floor(n / 2)]) / 2 : null,
    meanMs: n ? latencies.reduce((a, b) => a + b, 0) / n : null },
    photosPerMinute: m.elapsedMs > 0 ? m.successfulPhotos * 60000 / m.elapsedMs : null,
    secondsPerPhoto: m.successfulPhotos > 0 ? m.elapsedMs / 1000 / m.successfulPhotos : null,
    truncated: m.retainedPhotos < m.photoCount || m.requests < m.recordedRequests };
}

export function enrichPerformance(repo, { limit = 3 } = {}) {
  const db = repo.db;
  // No configuration blobs or logs are loaded. Identity and profile labels
  // already have indexed columns; the host label belongs to the job summary.
  const runs = db.prepare(`SELECT t.*, c.inference_id, p.profile_id, p.revision, p.name AS profile_name,
      j.id AS job_id, j.status AS job_status, j.started_at AS job_started_at,
      j.finished_at AS job_finished_at, j.counters_json, j.inference_host_label
    FROM enrich_timing_runs t
    LEFT JOIN enrich_configurations c ON c.id = t.configuration_id
    LEFT JOIN enrich_profile_revisions p ON p.id = c.profile_revision_id
    LEFT JOIN job_runs j ON j.timing_run_id = t.id
    ORDER BY t.id DESC LIMIT ?`).all(TIMING_LIMITS.runs);
  const groups = new Map(); const byRun = new Map();
  for (const r of runs) {
    // Effective inference identity splits prompt/vocabulary/model/image
    // changes, but not a renamed revision or different run size. Profile ID
    // keeps deliberately separate profiles distinct. Unknown identities or
    // missing job-host attribution must never become a comparable cohort.
    const key = JSON.stringify([r.inference_id ?? `run:${r.id}`, r.profile_id,
      r.provider, r.model, r.job_id ? r.inference_host_label : `unknown-host:${r.id}`]);
    if (!groups.has(key)) groups.set(key, { provider: r.provider, model: r.model,
      profileName: r.profile_name, profileRevision: r.revision, host: r.inference_host_label,
      hostKnown: r.job_id != null, configurationId: r.configuration_id,
      lastUsedAt: r.started_at, timingRunId: r.id, m: metric() });
    const group = groups.get(key); const m = metric(); addRun(m, r); addRun(group.m, r);
    byRun.set(r.id, { m, group, jobId: r.job_id, outcome: r.outcome });
  }
  if (runs.length) {
    const marks = runs.map(() => '?').join(','); const ids = runs.map(r => r.id);
    const photos = db.prepare(`SELECT id, timing_run_id FROM enrich_photo_executions
      WHERE timing_run_id IN (${marks}) ORDER BY id DESC LIMIT ?`).all(...ids, TIMING_LIMITS.photos + 100);
    for (const p of photos) { const r = byRun.get(p.timing_run_id); r.m.retainedPhotos++; r.group.m.retainedPhotos++; }
    const attempts = db.prepare(`SELECT a.ordinal, a.outcome, a.duration_ms, p.timing_run_id
      FROM enrich_provider_attempts a JOIN enrich_photo_executions p ON p.id = a.photo_execution_id
      WHERE p.timing_run_id IN (${marks}) ORDER BY a.id DESC LIMIT ?`).all(...ids, TIMING_LIMITS.attempts + 100);
    for (const a of attempts) { const r = byRun.get(a.timing_run_id); addAttempt(r.m, a); addAttempt(r.group.m, a); }
  }
  const max = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 3;
  return {
    comparisons: [...groups.values()].slice(0, max).map(({ m, ...g }) => ({ ...g, metrics: finish(m) })),
    totalComparisons: groups.size,
    runs: [...byRun].map(([timingRunId, r]) => ({ timingRunId, jobId: r.jobId, outcome: r.outcome, metrics: finish(r.m) })),
    window: { runCount: runs.length, oldestAt: runs.at(-1)?.started_at ?? null, newestAt: runs[0]?.started_at ?? null,
      maxRuns: TIMING_LIMITS.runs, partial: [...groups.values()].some(g => g.m.retainedPhotos < g.m.photoCount || g.m.requests < g.m.recordedRequests) },
  };
}

export function enrichPhotoDetails(repo, runId, options) {
  const page = repo.timings.photos(runId, options);
  if (!page) return null;
  const lookup = repo.db.prepare(`SELECT a.original_path, l.run_id AS saved_run_id,
    pr.status AS result_status FROM assets a
    LEFT JOIN latest_success l ON l.asset_id = a.asset_id
    LEFT JOIN processing_runs pr ON pr.id = ? WHERE a.asset_id = ?`);
  return { ...page, items: page.items.map(p => {
    const info = lookup.get(p.processing_run_id, p.asset_id);
    return { ...p, filename: info?.original_path?.split(/[\\/]/).at(-1) || null,
      savedResultAvailable: info?.saved_run_id != null, resultStatus: info?.result_status ?? null };
  }) };
}
