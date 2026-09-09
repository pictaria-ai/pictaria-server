import { createProvider } from '../../src/enrich/providers.mjs';
import { captureRunConfiguration } from '../../src/enrich/runConfiguration.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

let sequence = 0;
export function seedPerformanceRun(repo, { model = 'Vision model', provider = 'local_lmstudio', prompt = 'Fixture prompt',
  profile = null, host = null, status = 'finished', elapsedMs = 10000, photos = [{ requests: [{ outcome: 'accepted', ms: 8000 }] }],
  analyzed = photos.length, successes = photos.filter(p => (p.outcome ?? 'succeeded') === 'succeeded').length,
  skipped = 0, title = 'Library sweep', withJob = true } = {}) {
  const seq = ++sequence; const start = new Date(Date.UTC(2026, 8, 1, 12, seq)).toISOString();
  const end = new Date(Date.parse(start) + elapsedMs).toISOString();
  const configuration = captureRunConfiguration({ provider: createProvider(provider, { modelName: model, apiKey: 'fixture-provider-key' }),
    taxonomy: loadV1Taxonomy(), systemPrompt: prompt, userTemplate: '{approved_tags}', profile, inferenceHostLabel: host });
  repo.saveRunConfiguration(configuration);
  const runId = repo.timings.startRun(configuration); const photoIds = [];
  for (const [index, p] of photos.entries()) {
    const assetId = p.assetId ?? `fixture-photo-${seq}-${index}`;
    repo.upsertAsset({ id: assetId, originalPath: `/fixture/photos/${p.filename ?? `Photo ${seq}-${index + 1}.jpg`}` });
    let processingId = null;
    if ((p.outcome ?? 'succeeded') === 'succeeded' || p.savedResult) processingId = repo.recordProcessingRun({ assetId,
      ...configuration.runKey, status: 'succeeded', normalizedOutput: sampleOutput() });
    const id = Number(repo.db.prepare(`INSERT INTO enrich_photo_executions
      (timing_run_id,asset_id,processing_run_id,started_at,finished_at,duration_ms,outcome,attempt_count)
      VALUES(?,?,?,?,?,?,?,?)`).run(runId, assetId, p.outcome === 'interrupted' ? null : processingId, start,
      p.outcome === 'interrupted' ? null : end, p.ms === undefined ? 10000 : p.ms, p.outcome ?? 'succeeded', p.recordedRequests ?? p.requests.length).lastInsertRowid);
    photoIds.push(id);
    for (const [i, a] of p.requests.entries()) repo.db.prepare(`INSERT INTO enrich_provider_attempts
      (photo_execution_id,ordinal,started_at,finished_at,duration_ms,outcome,http_status) VALUES(?,?,?,?,?,?,?)`)
      .run(id, a.ordinal ?? i + 1, start, a.outcome === 'interrupted' ? null : end, a.ms ?? null, a.outcome, a.httpStatus ?? (a.outcome === 'accepted' ? 200 : null));
  }
  repo.db.prepare(`UPDATE enrich_timing_runs SET started_at=?,finished_at=?,outcome=?,photo_count=?,attempt_count=?,skipped_successful=? WHERE id=?`)
    .run(start, status === 'interrupted' ? null : end, status, photos.length, photos.reduce((n, p) => n + (p.recordedRequests ?? p.requests.length), 0), skipped, runId);
  if (withJob) repo.recordJobRun({ timingRunId: runId, title, provider, model, configurationId: configuration.id, inferenceId: configuration.inferenceId,
    inferenceHostLabel: host, status, counters: { succeeded: successes, analyzed, failed: Math.max(0, analyzed - successes), skippedSuccessful: skipped },
    startedAt: start, finishedAt: end });
  return { runId, photoIds, configuration, start, end };
}
