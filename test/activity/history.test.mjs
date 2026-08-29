import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ActivityQueryError,
  activityExportCsv,
  activityExportJson,
  createActivityHistory,
} from '../../src/activity/history.mjs';
import { Repository } from '../../src/enrich/repository.mjs';

function withHistory(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-activity-history-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const history = createActivityHistory({
    repo,
    now: () => new Date('2026-08-08T15:00:00.000Z'),
  });
  try {
    return work({ repo, history });
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedAllSources(repo, { secret = 'SENTINEL-private-domain-content' } = {}) {
  for (const assetId of ['asset-1', 'asset-2', 'asset-3']) {
    repo.upsertAsset({ id: assetId, originalPath: `/photos/${assetId}.jpg` });
  }
  repo.recordActivityEvent({
    at: '2026-08-08T14:05:00.000Z', category: 'voice', type: 'voice.command',
    source: 'frame', deviceId: 'kitchen', assetId: null, provider: '=formula-provider',
    model: '@formula-model', outcome: 'reported', summary: 'Voice command used: next',
    detailJson: JSON.stringify({ command: 'next' }),
  });
  repo.db.prepare(`
    INSERT INTO job_runs (
      title, provider, model, prompt_version, taxonomy_version, targeted,
      status, error, counters_json, log_json, started_at, finished_at
    ) VALUES (?, ?, ?, 'v1', 'v1', 20, 'finished', ?, NULL, ?, ?, ?)
  `).run(secret, 'openai', 'job-model', secret, JSON.stringify([secret]),
    '2026-08-08T14:03:00.000Z', '2026-08-08T14:04:00.000Z');
  repo.db.prepare(`
    INSERT INTO processing_runs (
      asset_id, provider, model, prompt_version, taxonomy_version, status,
      started_at, finished_at, error, raw_output_json, normalized_output_json
    ) VALUES ('asset-1', 'venice', 'photo-model', 'v1', 'v1', 'failed', ?, ?, ?, ?, ?)
  `).run('2026-08-08T14:03:00.000Z', '2026-08-08T14:03:00.000Z', secret, JSON.stringify(secret), JSON.stringify({ caption: secret }));
  repo.db.prepare(`
    INSERT INTO manual_overrides (asset_id, tag, action, reason, created_at)
    VALUES ('asset-2', 'frame/decision', 'approve', ?, '2026-08-08T14:02:00.000Z')
  `).run(secret);
  repo.db.prepare(`
    INSERT INTO referee_groups (group_key, member_count, same_subject, provider, model, refereed_at, duration_ms)
    VALUES ('group-key', 3, 1, 'ollama', 'referee-model', '2026-08-08T14:01:00.000Z', 2400)
  `).run();
  repo.db.prepare(`
    INSERT INTO referee_picks (asset_id, group_key, rank, keep, eyes_closed, note, subject_group)
    VALUES ('asset-3', 'group-key', 1, 1, NULL, ?, 1)
  `).run(secret);
}

test('merges every retained source chronologically with stable cross-source pagination', () => {
  withHistory(({ repo, history }) => {
    seedAllSources(repo);
    const first = history.list({ limit: 2, since: '2026-08-08T00:00:00.000Z' });
    assert.deepEqual(first.items.map((event) => event.type), ['voice.command', 'enrich.run']);
    assert.ok(first.nextCursor);
    assert.deepEqual(first.items.map((event) => event.retention), ['rolling_90_days', 'domain_history']);

    const second = history.list({
      limit: 2,
      since: '2026-08-08T00:00:00.000Z',
      cursor: first.nextCursor,
    });
    assert.deepEqual(second.items.map((event) => event.type), ['enrich.photo', 'curation.decision']);
    const third = history.list({
      limit: 2,
      since: '2026-08-08T00:00:00.000Z',
      cursor: second.nextCursor,
    });
    assert.deepEqual(third.items.map((event) => event.type), ['curation.referee']);
    assert.equal(third.nextCursor, null);
  });
});

test('applies category, event, time, provider, and model filters identically', () => {
  withHistory(({ repo, history }) => {
    seedAllSources(repo);
    assert.deepEqual(
      history.list({ category: 'enrich' }).items.map((event) => event.type),
      ['enrich.run', 'enrich.photo'],
    );
    assert.deepEqual(
      history.list({ type: 'enrich.photo', provider: 'venice', model: 'photo-model' }).items.map((event) => event.assetId),
      ['asset-1'],
    );
    assert.deepEqual(
      history.list({ since: '2026-08-08T14:03:30.000Z', until: '2026-08-08T14:04:30.000Z' }).items.map((event) => event.type),
      ['enrich.run'],
    );
    const longModel = `model-${'x'.repeat(200)}`;
    repo.db.prepare(`
      INSERT INTO job_runs (
        title, provider, model, targeted, status, started_at, finished_at
      ) VALUES ('Long model', 'local', ?, 1, 'finished', ?, ?)
    `).run(longModel, '2026-08-08T14:06:00.000Z', '2026-08-08T14:06:01.000Z');
    assert.deepEqual(history.list({ model: longModel }).items.map((event) => event.model), [longModel]);
    assert.throws(
      () => history.list({ category: 'voice', type: 'enrich.run' }),
      ActivityQueryError,
    );
    assert.throws(() => history.list({ cursor: 'not-a-real-cursor' }), ActivityQueryError);
  });
});

test('90-day retention bounds operational events without hiding older domain history', () => {
  withHistory(({ repo, history }) => {
    repo.recordActivityEvent({
      at: '2026-04-01T00:00:00.000Z', category: 'system', type: 'system.start',
      source: 'server', outcome: 'succeeded', summary: 'Expired operational event',
    });
    repo.db.prepare(`
      INSERT INTO job_runs (
        title, provider, model, status, started_at, finished_at
      ) VALUES ('Old run', 'local', 'old-model', 'finished', ?, ?)
    `).run('2026-04-01T00:00:00.000Z', '2026-04-01T00:01:00.000Z');
    const all = history.list();
    assert.deepEqual(all.items.map((event) => event.type), ['enrich.run']);
  });
});

test('surfaces a bounded seven-day unrecognized-voice signal without transcripts', () => {
  withHistory(({ repo, history }) => {
    for (const [at, command, summary] of [
      ['2026-08-08T14:00:00.000Z', 'next', 'Voice command used: next'],
      ['2026-08-08T14:01:00.000Z', 'unrecognized', 'Summary wording may change'],
      ['2026-07-01T14:01:00.000Z', 'unrecognized', 'Voice command used: unrecognized'],
    ]) {
      repo.recordActivityEvent({
        at,
        category: 'voice',
        type: 'voice.command',
        source: 'frame',
        outcome: 'reported',
        summary,
        detailJson: JSON.stringify({ command }),
      });
    }
    assert.deepEqual(history.list().signals, {
      voiceCommands7d: 2,
      unrecognizedVoiceCommands7d: 1,
    });
  });
});

test('unknown photo-processing statuses remain neutral instead of being reported as failures', () => {
  withHistory(({ repo, history }) => {
    repo.upsertAsset({ id: 'asset-pending', originalPath: '/photos/pending.jpg' });
    repo.db.prepare(`
      INSERT INTO processing_runs (
        asset_id, provider, model, prompt_version, taxonomy_version,
        status, started_at, finished_at
      ) VALUES ('asset-pending', 'local', 'future-model', 'v1', 'v1', 'future-status', ?, ?)
    `).run('2026-08-08T14:00:00.000Z', '2026-08-08T14:00:00.000Z');

    const [event] = history.list({ type: 'enrich.photo' }).items;
    assert.equal(event.outcome, 'other');
    assert.equal(event.summary, 'Photo enrichment status recorded');
  });
});

test('legacy succeeded enrichment jobs remain successful in Activity', () => {
  withHistory(({ repo, history }) => {
    repo.db.prepare(`
      INSERT INTO job_runs (
        title, provider, model, targeted, status, started_at, finished_at
      ) VALUES ('Legacy successful run', 'local', 'legacy-model', 1, 'succeeded', ?, ?)
    `).run('2026-08-08T14:00:00.000Z', '2026-08-08T14:01:00.000Z');

    const [event] = history.list({ type: 'enrich.run' }).items;
    assert.equal(event.outcome, 'succeeded');
    assert.equal(event.summary, 'Enrichment run finished');
  });
});

test('domain projections and downloads omit sensitive source fields and neutralize spreadsheet formulas', () => {
  withHistory(({ repo, history }) => {
    const secret = 'SENTINEL-private-domain-content';
    seedAllSources(repo, { secret });
    const result = history.export({ since: '2026-08-08T00:00:00.000Z' });
    const json = activityExportJson(result);
    const csv = activityExportCsv(result);
    assert.doesNotMatch(json, new RegExp(secret));
    assert.doesNotMatch(csv, new RegExp(secret));
    assert.match(csv, /"'=formula-provider"/);
    assert.match(csv, /"'@formula-model"/);
    const truncatedCsv = activityExportCsv({ ...result, truncated: true, limit: 5000 });
    assert.match(truncatedCsv, /export_truncated,export_limit/);
    assert.match(truncatedCsv, /,"true","5000"/);
    assert.equal(JSON.parse(json).events.length, 5);
  });
});

test('large per-photo history returns a bounded newest-first window', () => {
  withHistory(({ repo, history }) => {
    const insertAsset = repo.db.prepare(`
      INSERT INTO assets (asset_id, first_seen_at, last_seen_at) VALUES (?, ?, ?)
    `);
    const insert = repo.db.prepare(`
      INSERT INTO processing_runs (
        asset_id, provider, model, prompt_version, taxonomy_version,
        status, started_at, finished_at
      ) VALUES (?, 'local', 'scale-model', 'v1', 'v1', 'succeeded', ?, ?)
    `);
    repo.transaction(() => {
      for (let index = 0; index < 25000; index += 1) {
        const at = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        insertAsset.run(`asset-${index}`, at, at);
        insert.run(`asset-${index}`, at, at);
      }
    });
    const page = history.list({ limit: 50, category: 'enrich', type: 'enrich.photo' });
    assert.equal(page.items.length, 50);
    assert.equal(page.items[0].assetId, 'asset-24999');
    assert.ok(page.nextCursor);
    const indexes = repo.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name);
    assert.ok(indexes.includes('idx_processing_runs_started_at'));
    assert.ok(indexes.includes('idx_processing_runs_provider_started_at'));
    assert.ok(indexes.includes('idx_processing_runs_model_started_at'));
  });
});
