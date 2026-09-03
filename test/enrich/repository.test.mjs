import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ENRICH_QUEUE_MAX_AGE_MS,
  ENRICH_QUEUE_MAX_ITEM_BYTES,
  ENRICH_QUEUE_MAX_ITEMS_GLOBAL,
  MAX_SYNC_JOB_ASSET_IDS_BYTES,
  MAX_SYNC_JOB_TAGS_BYTES,
  Repository,
} from '../../src/enrich/repository.mjs';

function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-repo-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  try {
    return work(repo, dir);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('latestEnrichment serves the latest run caption with provider and model', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'asset-1' });
    assert.equal(repo.latestEnrichment('asset-1'), null);

    repo.recordProcessingRun({
      assetId: 'asset-1',
      provider: 'venice',
      model: 'mistral-small-2603',
      promptVersion: 'v2',
      taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: { caption: 'First pass caption.', short_caption: 'First' },
    });
    assert.deepEqual(repo.latestEnrichment('asset-1'), {
      caption: 'First pass caption.',
      provider: 'venice',
      model: 'mistral-small-2603',
    });

    repo.recordProcessingRun({
      assetId: 'asset-1',
      provider: 'venice',
      model: 'qwen3-vl-235b-a22b',
      promptVersion: 'v2',
      taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: { caption: 'A newer, fuller caption spanning several sentences.', short_caption: 'Newer' },
    });
    assert.deepEqual(repo.latestEnrichment('asset-1'), {
      caption: 'A newer, fuller caption spanning several sentences.',
      provider: 'venice',
      model: 'qwen3-vl-235b-a22b',
    });

    // Enriched with an empty caption: attribution still reported, caption null.
    repo.recordProcessingRun({
      assetId: 'asset-1',
      provider: 'cloud_openai',
      model: 'gpt-5.5',
      promptVersion: 'v2',
      taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: { caption: '', short_caption: '' },
    });
    assert.deepEqual(repo.latestEnrichment('asset-1'), {
      caption: null,
      provider: 'cloud_openai',
      model: 'gpt-5.5',
    });

    assert.equal(repo.latestEnrichment('never-enriched'), null);
  });
});

test('processing runs retain only the newest bounded normalized result and never raw envelopes', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'asset-1' });
    for (const caption of ['first', 'second']) {
      repo.recordProcessingRun({
        assetId: 'asset-1',
        provider: 'p',
        model: 'm',
        promptVersion: 'v1',
        taxonomyVersion: 'v1',
        status: 'succeeded',
        rawOutput: { padding: 'raw provider envelope' },
        normalizedOutput: { caption, short_caption: caption },
      });
    }

    const rows = repo.db.prepare(`
      SELECT raw_output_json, normalized_output_json
      FROM processing_runs WHERE asset_id = ? ORDER BY id
    `).all('asset-1');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].raw_output_json, null);
    assert.equal(rows[1].raw_output_json, null);
    assert.equal(rows[0].normalized_output_json, null);
    assert.equal(JSON.parse(rows[1].normalized_output_json).caption, 'second');

    assert.throws(
      () => repo.recordProcessingRun({
        assetId: 'asset-1', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
        status: 'succeeded', normalizedOutput: { caption: 'x'.repeat(70 * 1024) },
      }),
      /storage limit/,
    );
  });
});

test('hasAnySuccessfulRun ignores failed runs', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'asset-1' });
    assert.equal(repo.hasAnySuccessfulRun('asset-1'), false);

    repo.recordProcessingRun({
      assetId: 'asset-1',
      provider: 'openrouter',
      model: 'qwen/qwen3-vl-32b-instruct',
      promptVersion: 'v1',
      taxonomyVersion: 'v1',
      status: 'failed',
      error: 'bad json',
    });
    assert.equal(repo.hasAnySuccessfulRun('asset-1'), false);

    repo.recordProcessingRun({
      assetId: 'asset-1',
      provider: 'cloud_openai',
      model: 'gpt-5.5',
      promptVersion: 'v1',
      taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: {},
    });
    assert.equal(repo.hasAnySuccessfulRun('asset-1'), true);
  });
});

test('failureCount matches provider, model, prompt, and taxonomy', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'asset-1' });
    const base = { assetId: 'asset-1', promptVersion: 'v1', taxonomyVersion: 'v1', status: 'failed', error: 'x' };
    repo.recordProcessingRun({ ...base, provider: 'a', model: 'm1' });
    repo.recordProcessingRun({ ...base, provider: 'a', model: 'm1' });
    repo.recordProcessingRun({ ...base, provider: 'b', model: 'm2' });

    assert.equal(repo.failureCount({ assetId: 'asset-1', provider: 'a', model: 'm1', promptVersion: 'v1', taxonomyVersion: 'v1' }), 2);
    assert.equal(repo.failureCount({ assetId: 'asset-1', provider: 'b', model: 'm2', promptVersion: 'v1', taxonomyVersion: 'v1' }), 1);
    assert.equal(repo.failureCount({ assetId: 'asset-1', provider: 'a', model: 'm2', promptVersion: 'v1', taxonomyVersion: 'v1' }), 0);
  });
});

test('replaceAssetTags keeps manual rows and replaces ai/system rows', () => {
  withRepo((repo) => {
    repo.setManualFrameTags({ assetIds: ['asset-1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    repo.replaceAssetTags({
      assetId: 'asset-1',
      decisions: [{ tag: 'ai/scene/mountains', confidence: 0.9, source: 'ai', reason: 'Mountains.' }],
      model: 'm1',
      taxonomyVersion: 'v1',
    });
    repo.replaceAssetTags({
      assetId: 'asset-1',
      decisions: [{ tag: 'ai/scene/water', confidence: 0.8, source: 'ai', reason: 'Water.' }],
      model: 'm1',
      taxonomyVersion: 'v1',
    });

    const tags = repo.loadAssetTagsFor(['asset-1'])['asset-1'];
    assert.deepEqual(tags, ['ai/scene/water', 'frame/eligible']);
  });
});

test('manual overrides append every decision', () => {
  withRepo((repo) => {
    repo.setManualFrameTags({ assetIds: ['asset-1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    repo.setManualFrameTags({ assetIds: ['asset-1'], addTags: ['frame/never-show'], removeTags: ['frame/eligible'], action: 'reject' });

    const rows = repo.db
      .prepare('SELECT action FROM manual_overrides WHERE asset_id = ? ORDER BY id')
      .all('asset-1');
    assert.deepEqual(rows.map((row) => row.action), ['approve', 'reject']);
  });
});

test('legacy manual_overrides schema migrates with rows preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-repo-'));
  const path = join(dir, 'enrichment.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE manual_overrides (
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(asset_id, tag)
      )
    `);
    legacy
      .prepare('INSERT INTO manual_overrides VALUES (?, ?, ?, ?, ?)')
      .run('asset-1', 'frame/decision', 'approve', null, '2026-01-01T00:00:00Z');
    legacy.close();

    const repo = new Repository(path);
    repo.initSchema();
    repo.initSchema(); // idempotent
    repo.setManualFrameTags({ assetIds: ['asset-1'], addTags: [], removeTags: [], action: 'reject' });

    const rows = repo.db
      .prepare('SELECT action FROM manual_overrides WHERE asset_id = ? ORDER BY id')
      .all('asset-1');
    assert.deepEqual(rows.map((row) => row.action), ['approve', 'reject']);
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recordDecision writes tags and sync job atomically and round-trips the queue', () => {
  withRepo((repo) => {
    const assetIds = [
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    ];
    const jobId = repo.recordDecision({
      assetIds,
      addTags: ['frame/eligible'],
      removeTags: ['frame/never-show'],
      action: 'approve',
    });

    assert.equal(repo.pendingSyncJobCount(), 1);
    const job = repo.nextSyncJob();
    assert.equal(job.id, jobId);
    assert.deepEqual(job.assetIds, assetIds);
    assert.deepEqual(job.add, ['frame/eligible']);
    assert.equal(job.attempts, 0);

    repo.recordSyncJobFailure(jobId, 'immich down');
    const retried = repo.nextSyncJob();
    assert.equal(retried.attempts, 1);
    assert.equal(retried.lastError, 'immich down');

    repo.completeSyncJob(jobId);
    assert.equal(repo.pendingSyncJobCount(), 0);
    assert.equal(repo.nextSyncJob(), null);

    assert.deepEqual(repo.loadAssetTagsFor([assetIds[0]], { prefix: 'frame/' })[assetIds[0]], ['frame/eligible']);
  });
});

test('restored sync jobs become safe envelopes when fields are malformed or oversized', () => {
  withRepo((repo) => {
    const insert = repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const secret = 'raw-secret-that-must-not-be-reported';
    const malformedId = Number(insert.run(
      'approve',
      `["${secret}"`,
      '["frame/eligible"]',
      '[]',
      0,
      new Date().toISOString(),
    ).lastInsertRowid);

    const malformed = repo.nextSyncJob();
    assert.equal(malformed.id, malformedId);
    assert.equal(malformed.action, 'invalid');
    assert.deepEqual(malformed.assetIds, []);
    assert.match(malformed.invalidReason, /invalid JSON/);
    assert.doesNotMatch(malformed.invalidReason, /Error:/);
    assert.doesNotMatch(malformed.invalidReason, new RegExp(secret));

    repo.deadLetterSyncJob(malformedId, malformed.invalidReason);
    const oversizedAssetsId = Number(insert.run(
      'approve',
      'x'.repeat(MAX_SYNC_JOB_ASSET_IDS_BYTES + 1),
      '["frame/eligible"]',
      '[]',
      0,
      new Date().toISOString(),
    ).lastInsertRowid);
    const oversizedAssets = repo.nextSyncJob();
    assert.equal(oversizedAssets.id, oversizedAssetsId);
    assert.match(oversizedAssets.invalidReason, /exceed the recovery limit/);

    repo.deadLetterSyncJob(oversizedAssetsId, oversizedAssets.invalidReason);
    const oversizedTagsId = Number(insert.run(
      'approve',
      '["00000000-0000-0000-0000-000000000001"]',
      'x'.repeat(MAX_SYNC_JOB_TAGS_BYTES + 1),
      '[]',
      0,
      new Date().toISOString(),
    ).lastInsertRowid);
    const oversizedTags = repo.nextSyncJob();
    assert.equal(oversizedTags.id, oversizedTagsId);
    assert.match(oversizedTags.invalidReason, /exceed the recovery limit/);

    repo.deadLetterSyncJob(oversizedTagsId, oversizedTags.invalidReason);
    const mismatchedActionId = Number(insert.run(
      'approve',
      '["00000000-0000-0000-0000-000000000001"]',
      '["frame/never-show"]',
      '[]',
      0,
      new Date().toISOString(),
    ).lastInsertRowid);
    const mismatchedAction = repo.nextSyncJob();
    assert.equal(mismatchedAction.id, mismatchedActionId);
    assert.match(mismatchedAction.invalidReason, /do not match the decision action/);
  });
});

test('unreadable restored sync scalars return a bounded envelope without mutating state', () => {
  withRepo((repo) => {
    const huge = 'x'.repeat(128 * 1024);
    repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES (?, '["00000000-0000-0000-0000-000000000001"]', '["frame/eligible"]', '[]',
        9223372036854775807, ?)
    `).run(huge, huge);
    const healthyId = Number(repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES ('approve', '["00000000-0000-0000-0000-000000000002"]',
        '["frame/eligible"]', '[]', 0, ?)
    `).run(new Date().toISOString()).lastInsertRowid);

    const malformed = repo.nextSyncJob();
    assert.equal(malformed.id, healthyId - 1);
    assert.match(malformed.invalidReason, /unsupported decision action/);
    assert.doesNotMatch(JSON.stringify(malformed), new RegExp(huge.slice(0, 100)));
    assert.equal(repo.pendingSyncJobCount(), 2);
    assert.equal(repo.deadSyncJobCount(), 0);
    const stored = repo.db.prepare(`
      SELECT CAST(attempts AS TEXT) AS attempts, last_error, dead_at
      FROM pending_sync_jobs WHERE id = ?
    `).get(malformed.id);
    assert.equal(stored.attempts, '9223372036854775807');
    assert.equal(stored.last_error, null);
    assert.equal(stored.dead_at, null);
  });
});

test('an out-of-range restored sync id remains exact through bounded read and dead-letter', () => {
  withRepo((repo) => {
    const unsafeId = '9223372036854775807';
    repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        id, action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES (9223372036854775807, 'approve',
        '["00000000-0000-0000-0000-000000000001"]', '["frame/eligible"]', '[]', 0, ?)
    `).run(new Date().toISOString());

    const malformed = repo.nextSyncJob();
    assert.equal(malformed.id, unsafeId);
    assert.match(malformed.invalidReason, /invalid row identifier/);
    assert.equal(repo.deadSyncJobCount(), 0);
    repo.deadLetterSyncJob(malformed.id, malformed.invalidReason);
    const [parked] = repo.deadSyncJobs();
    assert.equal(parked.id, unsafeId);
    assert.match(parked.invalidReason, /invalid row identifier/);
    assert.equal(repo.dismissDeadSyncJob(unsafeId), true);
  });
});

test('recordDecision rejects a full durable sync backlog before local state changes', () => {
  withRepo((repo) => {
    repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES ('approve', ?, '[]', '[]', 0, ?)
    `).run(JSON.stringify(Array(10000).fill('legacy')), new Date().toISOString());

    assert.throws(
      () => repo.recordDecision({
        assetIds: ['new-asset'],
        addTags: ['frame/eligible'],
        removeTags: [],
        action: 'approve',
      }),
      (error) => error.code === 'review_sync_backlog_full' && error.status === 409,
    );
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM manual_overrides').get().count, 0);
    assert.deepEqual(repo.loadAssetTagsFor(['new-asset'], { prefix: 'frame/' }), {});
    assert.equal(repo.pendingSyncJobCount(), 1);
  });
});

test('dead sync job listing is bounded without deleting unresolved work', () => {
  withRepo((repo) => {
    const ids = [];
    for (let index = 0; index < 101; index += 1) {
      ids.push(repo.recordDecision({
        assetIds: [`asset-${index}`],
        addTags: [],
        removeTags: [],
        action: 'clear',
      }));
    }
    for (const id of ids) repo.deadLetterSyncJob(id, 'gone');
    assert.equal(repo.deadSyncJobCount(), 101);
    assert.equal(repo.deadSyncJobs().length, 100);
    assert.equal(repo.deadSyncJobs().at(-1).id, ids[1]);
    assert.ok(repo.db.prepare('SELECT 1 FROM pending_sync_jobs WHERE id = ?').get(ids[0]));
  });
});

test('manual history pruning preserves every asset newest decision beyond the global window', () => {
  withRepo((repo) => {
    repo.db.prepare(`
      INSERT INTO manual_overrides (asset_id, tag, action, reason, created_at)
      VALUES ('old-only', 'frame/decision', 'approve', NULL, '2020-01-01T00:00:00Z')
    `).run();
    const insert = repo.db.prepare(`
      INSERT INTO manual_overrides (asset_id, tag, action, reason, created_at)
      VALUES ('churn', 'frame/decision', 'approve', NULL, ?)
    `);
    repo.transaction(() => {
      for (let index = 0; index < 100001; index += 1) insert.run(new Date(index).toISOString());
    });

    assert.throws(
      () => repo.transaction(() => {
        repo.setManualFrameTags({ assetIds: ['churn'], addTags: [], removeTags: [], action: 'clear' });
        throw new Error('later composed write failed');
      }),
      /later composed write failed/,
    );
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM manual_overrides').get().count, 100002);

    repo.setManualFrameTags({ assetIds: ['churn'], addTags: [], removeTags: [], action: 'clear' });
    assert.equal(repo.db.prepare("SELECT COUNT(*) AS count FROM manual_overrides WHERE asset_id = 'old-only'").get().count, 1);
    assert.equal(repo.libraryStats().curatedTotal, 2);
    const prunedCount = repo.db.prepare('SELECT COUNT(*) AS count FROM manual_overrides').get().count;
    assert.ok(prunedCount <= 100001);

    // Ordinary decisions inside the 10k-row cadence do not repay the
    // full-table prune. Once the interval is reached, the same retention
    // projection runs again and preserves the per-asset newest row.
    repo.setManualFrameTags({ assetIds: ['churn'], addTags: [], removeTags: [], action: 'clear' });
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM manual_overrides').get().count, prunedCount + 1);
    repo.transaction(() => {
      for (let index = 0; index < 9999; index += 1) insert.run(new Date(index).toISOString());
    });
    repo.setManualFrameTags({ assetIds: ['churn'], addTags: [], removeTags: [], action: 'clear' });
    assert.equal(repo.db.prepare("SELECT COUNT(*) AS count FROM manual_overrides WHERE asset_id = 'old-only'").get().count, 1);
    assert.ok(repo.db.prepare('SELECT COUNT(*) AS count FROM manual_overrides').get().count <= 100001);
  });
});

test('dead-lettered sync jobs stop blocking the queue and can be retried or dismissed', () => {
  withRepo((repo) => {
    const stuckId = repo.recordDecision({
      assetIds: ['gone-asset'],
      addTags: ['frame/eligible'],
      removeTags: [],
      action: 'approve',
    });
    const laterId = repo.recordDecision({
      assetIds: ['healthy-asset'],
      addTags: ['frame/eligible'],
      removeTags: [],
      action: 'approve',
    });

    repo.deadLetterSyncJob(stuckId, 'asset deleted from Immich');

    // The parked job releases the head of the queue.
    assert.equal(repo.nextSyncJob().id, laterId);
    assert.equal(repo.pendingSyncJobCount(), 1);
    assert.equal(repo.deadSyncJobCount(), 1);

    const dead = repo.deadSyncJobs();
    assert.equal(dead.length, 1);
    assert.equal(dead[0].id, stuckId);
    assert.equal(dead[0].lastError, 'asset deleted from Immich');
    assert.ok(dead[0].deadAt);

    // Retry re-queues with a fresh attempt allowance, at its original position.
    assert.equal(repo.retryDeadSyncJobs(stuckId), 1);
    assert.equal(repo.deadSyncJobCount(), 0);
    assert.equal(repo.nextSyncJob().id, stuckId);
    assert.equal(repo.nextSyncJob().attempts, 0);

    // Dismiss only touches dead jobs.
    assert.equal(repo.dismissDeadSyncJob(stuckId), false);
    repo.deadLetterSyncJob(stuckId, 'still gone');
    assert.equal(repo.dismissDeadSyncJob(stuckId), true);
    assert.equal(repo.pendingSyncJobCount(), 1);
  });
});

test('enrichment queue admission is atomic at capacity and duplicates remain no-ops', () => {
  withRepo((repo) => {
    const ids = [];
    for (let index = 0; index < ENRICH_QUEUE_MAX_ITEMS_GLOBAL; index += 1) {
      const result = repo.queueAdd({ title: `Slice ${index}`, filters: { city: `City ${index}` } });
      ids.push(result.id);
      assert.equal(result.duplicate, false);
    }
    const duplicate = repo.queueAdd({ title: 'Same slice', filters: { city: 'City 0' } });
    assert.deepEqual(duplicate, { id: ids[0], duplicate: true });
    assert.throws(
      () => repo.queueAdd({ title: 'Excess', filters: { city: 'One too many' } }),
      (error) => error.code === 'enrich_queue_full' && error.status === 409,
    );
    assert.equal(repo.queuePage({ limit: ENRICH_QUEUE_MAX_ITEMS_GLOBAL }).total, ENRICH_QUEUE_MAX_ITEMS_GLOBAL);
  });
});

test('enrichment queue measures encoded bytes and rejects oversized items before persistence', () => {
  withRepo((repo) => {
    const multilingualCities = Array.from(
      { length: 500 },
      (_, index) => `กรุงเทพมหานคร${String(index).padStart(3, '0')}`,
    );
    assert.ok(Buffer.byteLength(JSON.stringify({ cities: multilingualCities }), 'utf8') > 16 * 1024);
    assert.equal(repo.queueAdd({ title: 'Thai cities', filters: { cities: multilingualCities } }).duplicate, false);

    assert.throws(
      () => repo.queueAdd({
        title: 'Unicode',
        filters: { city: 'é'.repeat(Math.ceil(ENRICH_QUEUE_MAX_ITEM_BYTES / 2)) },
      }),
      (error) => error.code === 'enrich_queue_item_too_large' && error.status === 413,
    );
    assert.equal(repo.queuePage().total, 1);
  });
});

test('enrichment queue enforces its aggregate encoded-byte ceiling before the item ceiling', () => {
  withRepo((repo) => {
    let accepted = 0;
    let rejected = null;
    for (let index = 0; index < ENRICH_QUEUE_MAX_ITEMS_GLOBAL; index += 1) {
      try {
        repo.queueAdd({ title: `Large ${index}`, filters: { city: `${index}-${'x'.repeat(7900)}` } });
        accepted += 1;
      } catch (error) {
        rejected = error;
        break;
      }
    }
    assert.ok(accepted < ENRICH_QUEUE_MAX_ITEMS_GLOBAL);
    assert.equal(rejected?.code, 'enrich_queue_full');
    assert.equal(repo.queuePage({ limit: ENRICH_QUEUE_MAX_ITEMS_GLOBAL }).total, accepted);
  });
});

test('enrichment queue pages remain stable across deletes and later inserts', () => {
  withRepo((repo) => {
    const ids = Array.from({ length: 5 }, (_, index) => repo.queueAdd({
      title: `Slice ${index}`,
      filters: { city: `City ${index}` },
    }).id);
    const first = repo.queuePage({ limit: 2 });
    assert.deepEqual(first.items.map((item) => item.id), ids.slice(0, 2));
    assert.equal(first.nextAfterId, ids[1]);
    repo.queueRemove(ids[2]);
    const laterId = repo.queueAdd({ title: 'Later', filters: { city: 'Later' } }).id;
    const second = repo.queuePage({ afterId: first.nextAfterId, limit: 2 });
    assert.deepEqual(second.items.map((item) => item.id), [ids[3], ids[4]]);
    const third = repo.queuePage({ afterId: second.nextAfterId, limit: 2 });
    assert.deepEqual(third.items.map((item) => item.id), [laterId]);
    assert.equal(third.nextAfterId, null);
  });
});

test('enrichment queue maintenance expires old work and reconciles legacy excess without evicting active work', () => {
  withRepo((repo) => {
    const now = new Date('2026-08-25T12:00:00.000Z');
    const expiredId = repo.queueAdd({
      title: 'Expired',
      filters: { city: 'Old' },
      now: new Date(now.getTime() - ENRICH_QUEUE_MAX_AGE_MS - 1),
    }).id;
    const activeId = repo.queueAdd({
      title: 'Active old item',
      filters: { city: 'Protected' },
      now: new Date(now.getTime() - ENRICH_QUEUE_MAX_AGE_MS - 1),
    }).id;
    const legacyOversizedId = Number(repo.db.prepare(`
      INSERT INTO enrich_queue (title, filters_json, estimated_count, requested_at)
      VALUES ('Legacy oversized', ?, NULL, ?)
    `).run(JSON.stringify({ city: 'x'.repeat(ENRICH_QUEUE_MAX_ITEM_BYTES + 1) }), now.toISOString()).lastInsertRowid);
    const protectedOversizedId = Number(repo.db.prepare(`
      INSERT INTO enrich_queue (title, filters_json, estimated_count, requested_at)
      VALUES ('Protected oversized', ?, NULL, ?)
    `).run(JSON.stringify({ city: 'y'.repeat(ENRICH_QUEUE_MAX_ITEM_BYTES + 1) }), now.toISOString()).lastInsertRowid);
    for (let index = 0; index < ENRICH_QUEUE_MAX_ITEMS_GLOBAL + 5; index += 1) {
      repo.db.prepare(`
        INSERT INTO enrich_queue (title, filters_json, estimated_count, requested_at)
        VALUES (?, ?, NULL, ?)
      `).run(`Legacy ${index}`, JSON.stringify({ city: `Legacy ${index}` }), now.toISOString());
    }

    repo.queueMaintain({ protectedIds: [activeId, protectedOversizedId], now });
    const page = repo.queuePage({ limit: ENRICH_QUEUE_MAX_ITEMS_GLOBAL });
    assert.ok(page.total <= ENRICH_QUEUE_MAX_ITEMS_GLOBAL);
    assert.equal(repo.queueGet(expiredId), null);
    assert.ok(repo.queueGet(activeId));
    assert.equal(repo.queueGet(legacyOversizedId), null);
    assert.ok(repo.queueGet(protectedOversizedId));
    assert.ok(page.items.some((item) => item.id === activeId));
    assert.ok(page.items.every((item) => item.id <= page.items.at(-1).id));
  });
});

test('transaction() composes nested repository writes into one atomic unit', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'a' });
    assert.throws(
      () =>
        repo.transaction(() => {
          repo.recordProcessingRun({
            assetId: 'a',
            provider: 'p',
            model: 'm',
            promptVersion: 'v1',
            taxonomyVersion: 'v1',
            status: 'succeeded',
            normalizedOutput: { caption: 'x' },
          });
          repo.reviewListAdd(['a'], 'enrich'); // opens a nested transaction — joins the outer one
          throw new Error('boom after partial writes');
        }),
      /boom/,
    );
    // Everything rolled back: no success record, no caption index, no review row.
    assert.equal(repo.hasAnySuccessfulRun('a'), false);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM review_list').get().n, 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM caption_index').get().n, 0);

    // And the connection is reusable afterwards.
    repo.reviewListAdd(['a'], 'enrich');
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM review_list').get().n, 1);
  });
});

test('infrastructure failures do not count toward the per-asset failure allowance', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'a' });
    const key = { assetId: 'a', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1' };
    repo.recordProcessingRun({ ...key, status: 'failed_infra', error: 'provider timed out' });
    repo.recordProcessingRun({ ...key, status: 'failed_infra', error: 'provider timed out' });
    repo.recordProcessingRun({ ...key, status: 'failed', error: 'model rejected image' });
    assert.equal(repo.failureCount(key), 1);
    assert.equal(repo.hasAnySuccessfulRun('a'), false);
  });
});

test('latestSuccessFor reflects the newest run per asset and only the requested ids', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'a' });
    repo.upsertAsset({ id: 'b' });
    const base = { provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1', status: 'succeeded' };
    repo.recordProcessingRun({ ...base, assetId: 'a', normalizedOutput: { quality: { frame_worthy_score: 0.5 } } });
    repo.recordProcessingRun({ ...base, assetId: 'a', normalizedOutput: { quality: { frame_worthy_score: 0.9, aesthetic_score: 0.8 } } });
    repo.recordProcessingRun({ ...base, assetId: 'b', normalizedOutput: {} });

    const rows = repo.latestSuccessFor(['a', 'unknown']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].asset_id, 'a');
    assert.equal(rows[0].frame_score, 0.9); // re-enrichment wins
    assert.equal(rows[0].aesthetic_score, 0.8);

    const forB = repo.latestSuccessFor(['b']);
    assert.equal(forB.length, 1, 'a success without quality still marks the asset enriched');
    assert.equal(forB[0].frame_score, null);
    assert.deepEqual(repo.latestSuccessFor([]), []);
  });
});

test('backupTo produces an openable snapshot', () => {
  withRepo((repo, dir) => {
    repo.upsertAsset({ id: 'asset-1' });
    const backupPath = repo.backupTo(join(dir, 'backups', 'snap.sqlite'));

    const snapshot = new DatabaseSync(backupPath);
    const row = snapshot.prepare('SELECT COUNT(*) AS count FROM assets').get();
    snapshot.close();
    assert.equal(Number(row.count), 1);
  });
});

test('libraryStats counts distinct enriched and curated assets', () => {
  withRepo((repo) => {
    const runKey = { provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1' };
    repo.upsertAsset({ id: 'a1' });
    repo.upsertAsset({ id: 'a2' });
    repo.recordProcessingRun({ assetId: 'a1', ...runKey, status: 'succeeded', rawOutput: {}, normalizedOutput: {} });
    repo.recordProcessingRun({ assetId: 'a1', ...runKey, status: 'succeeded', rawOutput: {}, normalizedOutput: {} });
    repo.recordProcessingRun({ assetId: 'a2', ...runKey, status: 'failed', error: 'x' });
    repo.recordDecision({ assetIds: ['a1', 'a2'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    repo.recordDecision({ assetIds: ['a2'], addTags: [], removeTags: ['frame/eligible'], action: 'reject' });

    assert.deepEqual(repo.libraryStats(), { enrichedTotal: 1, curatedTotal: 2 });
  });
});

test('review list: add dedupes, rows join the latest-success projection, un-enriched rows carry nulls', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'a1', originalPath: '/p/a1.jpg' });
    repo.upsertAsset({ id: 'a2', originalPath: '/p/a2.jpg' });
    repo.recordProcessingRun({
      assetId: 'a1', provider: 'p', model: 'm', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: { short_caption: 'hi' },
    });

    assert.equal(repo.reviewListAdd(['a1', 'a2'], 'send'), 2);
    assert.equal(repo.reviewListAdd(['a1', 'a2', ''], 'enrich'), 0); // all already listed

    const rows = repo.reviewListRows();
    assert.equal(rows.length, 2);
    const byId = Object.fromEntries(rows.map((row) => [row.asset_id, row]));
    assert.equal(byId.a1.short_caption, 'hi');
    assert.ok(byId.a1.latest_run_id != null);
    assert.equal(byId.a2.latest_run_id, null);
    assert.equal(byId.a2.short_caption, null);
    assert.equal(byId.a2.original_path, '/p/a2.jpg');
  });
});

test('review list migration seeds once from enriched assets, then never again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-repo-'));
  try {
    const path = join(dir, 'enrichment.sqlite');
    const repo = new Repository(path);
    repo.initSchema();
    repo.upsertAsset({ id: 'old-1' });
    repo.recordProcessingRun({
      assetId: 'old-1', provider: 'p', model: 'm', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: {},
    });
    // Simulate a pre-review-list database: drop the table, then re-init as
    // an upgraded server process would on boot.
    repo.db.exec('DROP TABLE review_list');
    repo.db.exec('PRAGMA user_version = 0'); // a real pre-review-list DB predates the version stamp
    repo.initSchema();
    assert.equal(repo.reviewListRows().length, 1, 'existing enriched asset is grandfathered');

    // A later enrichment with "send to Curate" off must NOT be re-seeded by
    // the next boot: seeding only happens when the table is first created.
    repo.upsertAsset({ id: 'new-1' });
    repo.recordProcessingRun({
      assetId: 'new-1', provider: 'p', model: 'm', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: {},
    });
    repo.initSchema();
    assert.equal(repo.reviewListRows().length, 1, 'no re-seed on subsequent boots');
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('coverageFor reports enriched and curated flags from local data', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'cov-enriched' });
    repo.recordProcessingRun({
      assetId: 'cov-enriched', provider: 'p', model: 'm', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: {},
    });
    repo.upsertAsset({ id: 'cov-decided' });
    repo.setManualFrameTags({ assetIds: ['cov-decided'], addTags: ['frame/never-show'], removeTags: [], action: 'reject' });
    repo.upsertAsset({ id: 'cov-failed' });
    repo.recordProcessingRun({
      assetId: 'cov-failed', provider: 'p', model: 'm', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'failed', error: 'x',
    });

    const coverage = repo.coverageFor(['cov-enriched', 'cov-decided', 'cov-failed', 'cov-unknown', 'cov-enriched']);
    assert.deepEqual(coverage['cov-enriched'], { enriched: true, curated: false });
    assert.deepEqual(coverage['cov-decided'], { enriched: false, curated: true });
    assert.deepEqual(coverage['cov-failed'], { enriched: false, curated: false });
    assert.deepEqual(coverage['cov-unknown'], { enriched: false, curated: false });
  });
});

test('job run logs round-trip and stay out of the list payload', () => {
  withRepo((repo) => {
    repo.recordJobRun({
      title: 'With log', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
      targeted: 2, status: 'finished', error: null, counters: { analyzed: 2 },
      log: ['12:00:00 started', '12:00:40 done'],
      startedAt: '2026-07-09T12:00:00Z', finishedAt: '2026-07-09T12:00:40Z',
    });
    repo.recordJobRun({
      title: 'No log', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
      targeted: null, status: 'failed', error: 'x', counters: null, log: [],
      startedAt: '2026-07-09T12:01:00Z', finishedAt: '2026-07-09T12:01:05Z',
    });

    const runs = repo.listJobRuns();
    assert.equal(runs[0].hasLog, false);
    assert.equal(runs[1].hasLog, true);
    assert.equal('log' in runs[1], false);
    assert.deepEqual(repo.getJobRunLog(runs[1].id).log, ['12:00:00 started', '12:00:40 done']);
    assert.deepEqual(repo.getJobRunLog(runs[0].id).log, []);
    assert.equal(repo.getJobRunLog(9999), null);
  });
});

test('job run history derives honest end-to-end throughput and snapshots bounded host context', () => {
  withRepo((repo) => {
    repo.recordJobRun({
      title: 'Comparable run', provider: 'local_lmstudio', model: 'vision-model',
      promptVersion: 'v2', taxonomyVersion: 'v1', inferenceHostLabel: 'Original host',
      targeted: 30, status: 'cancelled', error: null,
      counters: { analyzed: 15, succeeded: 12, failed: 3, skippedSuccessful: 10 }, log: [],
      startedAt: '2026-07-09T12:00:00.000Z', finishedAt: '2026-07-09T12:02:00.000Z',
    });
    repo.recordJobRun({
      title: 'Nothing succeeded', provider: 'local_lmstudio', model: 'vision-model',
      promptVersion: 'v2', taxonomyVersion: 'v1', inferenceHostLabel: '',
      targeted: 1, status: 'failed', error: 'offline',
      counters: { analyzed: 1, succeeded: 0, failed: 1 }, log: [],
      startedAt: '2026-07-09T12:03:00.000Z', finishedAt: '2026-07-09T12:04:00.000Z',
    });
    repo.recordJobRun({
      title: 'Invalid duration', provider: 'local_lmstudio', model: 'vision-model',
      promptVersion: 'v2', taxonomyVersion: 'v1', targeted: 1,
      status: 'finished', error: null, counters: { succeeded: 1 }, log: [],
      startedAt: '2026-07-09T12:05:00.000Z', finishedAt: '2026-07-09T12:05:00.000Z',
    });

    const comparableId = repo.db.prepare("SELECT id FROM job_runs WHERE title = 'Comparable run'").get().id;
    // A restored/tampered database cannot turn the bounded API field into an
    // arbitrarily large response even though normal writes already clamp it.
    repo.db.prepare('UPDATE job_runs SET inference_host_label = ? WHERE id = ?')
      .run(`  ${'M'.repeat(140)}  `, comparableId);

    const [invalid, empty, comparable] = repo.listJobRuns(3);
    assert.equal(invalid.throughput, null);
    assert.equal(empty.throughput, null);
    assert.equal(empty.inferenceHostLabel, null);
    assert.deepEqual(comparable.throughput, {
      basis: 'end_to_end',
      photosPerMinute: 6,
      secondsPerPhoto: 10,
    });
    assert.equal(comparable.inferenceHostLabel, 'M'.repeat(120));
    assert.equal(repo.getJobRunLog(comparable.id).inferenceHostLabel, 'M'.repeat(120));
  });
});

test('job run retries reconstruct content and infrastructure failures that still need work', () => {
  withRepo((repo) => {
    const key = { provider: 'openrouter', model: 'vision-model', promptVersion: 'v2', taxonomyVersion: 'v1' };
    const recordAt = (assetId, status, startedAt, overrides = {}) => {
      repo.upsertAsset({ id: assetId });
      const id = repo.recordProcessingRun({
        assetId,
        ...key,
        ...overrides,
        status,
        ...(status === 'succeeded' ? { normalizedOutput: {} } : { error: `${status} test` }),
      });
      repo.db.prepare('UPDATE processing_runs SET started_at = ?, finished_at = ? WHERE id = ?')
        .run(startedAt, startedAt, id);
      return id;
    };

    recordAt('content-failure', 'failed', '2026-07-09T12:02:00.000Z');
    recordAt('infra-failure', 'failed_infra', '2026-07-09T12:03:00.000Z');
    recordAt('later-success', 'failed', '2026-07-09T12:04:00.000Z');
    recordAt('later-success', 'succeeded', '2026-07-09T12:20:00.000Z', { provider: 'venice' });
    recordAt('outside-window', 'failed', '2026-07-09T11:59:59.000Z');
    recordAt('other-model', 'failed', '2026-07-09T12:05:00.000Z', { model: 'other-model' });
    recordAt('missing', 'failed_infra', '2026-07-09T12:06:00.000Z');
    repo.markAssetsMissing(['missing']);
    recordAt('discarded', 'failed', '2026-07-09T12:07:00.000Z');
    repo.discardAssets(['discarded']);

    repo.recordJobRun({
      title: 'Original sweep', ...key, targeted: 8, status: 'finished', error: null,
      counters: { failed: 6 }, log: [],
      startedAt: '2026-07-09T12:00:00.000Z', finishedAt: '2026-07-09T12:10:00.000Z',
    });
    const run = repo.listJobRuns(1)[0];
    assert.equal(run.retryableFailures, 2);
    assert.deepEqual(repo.jobRunRetryFailures(run.id), {
      runId: run.id,
      title: 'Original sweep',
      provider: 'openrouter',
      model: 'vision-model',
      promptVersion: 'v2',
      taxonomyVersion: 'v1',
      count: 2,
      assetIds: ['content-failure', 'infra-failure'],
      truncated: false,
    });
    assert.deepEqual(repo.jobRunRetryFailures(run.id, { limit: 1 }).assetIds, ['content-failure']);
    assert.equal(repo.jobRunRetryFailures(run.id, { limit: 1 }).count, 2);
    assert.equal(repo.jobRunRetryFailures(run.id, { limit: 1 }).truncated, true);
    assert.equal(repo.jobRunRetryFailures(run.id, { limit: 0 }).truncated, false);

    // A success after the history card was rendered removes the photo from
    // the live retry set and therefore updates the card count too.
    recordAt('content-failure', 'succeeded', '2026-07-09T12:30:00.000Z', { provider: 'cloud_openai' });
    assert.deepEqual(repo.jobRunRetryFailures(run.id).assetIds, ['infra-failure']);
    assert.equal(repo.listJobRuns(1)[0].retryableFailures, 1);
    assert.equal(repo.jobRunRetryFailures(9999), null);

    repo.recordJobRun({
      title: 'Clean sweep', ...key, targeted: 1, status: 'finished', error: null,
      counters: { analyzed: 1, succeeded: 1, failed: 0 }, log: [],
      startedAt: '2026-07-09T13:00:00.000Z', finishedAt: '2026-07-09T13:01:00.000Z',
    });
    const originalRetryFailures = repo.jobRunRetryFailures.bind(repo);
    const queriedRunIds = [];
    repo.jobRunRetryFailures = (id, options) => {
      queriedRunIds.push(id);
      return originalRetryFailures(id, options);
    };
    const listed = repo.listJobRuns(2);
    assert.equal(listed[0].retryableFailures, 0);
    assert.equal(listed[1].retryableFailures, 1);
    assert.deepEqual(queriedRunIds, [run.id]);
  });
});

test('job history has aggregate retention and bounded logs with a marker', () => {
  withRepo((repo) => {
    const largeLog = Array.from({ length: 700 }, (_, index) => `${index} ${'x'.repeat(1000)}`);
    for (let index = 0; index < 105; index += 1) {
      repo.recordJobRun({
        title: `Run ${index}`, provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
        targeted: null, status: 'finished', error: null, counters: null,
        log: index === 104 ? largeLog : [],
        startedAt: '2026-07-09T12:00:00Z', finishedAt: '2026-07-09T12:00:01Z',
      });
    }

    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM job_runs').get().n, 100);
    const latest = repo.listJobRuns(1)[0];
    const stored = repo.getJobRunLog(latest.id).log;
    assert.match(stored[0], /earlier log entries omitted/);
    assert.ok(stored.length <= 501);
    assert.ok(Buffer.byteLength(JSON.stringify(stored), 'utf8') <= 256 * 1024);
  });
});

test('job_runs without log_json gains the column on init (migration)', () => {
  withRepo((repo) => {
    // Rebuild job_runs in its pre-log shape, then re-init as an upgraded
    // server would on boot.
    repo.db.exec('DROP TABLE job_runs');
    repo.db.exec('PRAGMA user_version = 0'); // a real pre-log_json DB predates the version stamp
    repo.db.exec(`CREATE TABLE job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT, prompt_version TEXT, taxonomy_version TEXT, targeted INTEGER,
      status TEXT NOT NULL, error TEXT, counters_json TEXT,
      started_at TEXT NOT NULL, finished_at TEXT NOT NULL)`);
    repo.db.exec(`INSERT INTO job_runs (title, provider, status, started_at, finished_at)
      VALUES ('old run', 'p', 'finished', '2026-07-01T00:00:00Z', '2026-07-01T00:10:00Z')`);
    repo.initSchema();

    const runs = repo.listJobRuns();
    assert.equal(runs[0].title, 'old run');
    assert.equal(runs[0].hasLog, false);
    assert.equal(runs[0].inferenceHostLabel, null);
    assert.equal(runs[0].throughput, null);
  });
});

test('caption index: write-through on success, latest run wins, search ranks', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'cap-1' });
    repo.upsertAsset({ id: 'cap-2' });
    repo.recordProcessingRun({
      assetId: 'cap-1', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: { caption: 'Golden retriever running on a sandy beach at sunset.', short_caption: 'Dog on beach' },
    });
    repo.recordProcessingRun({
      assetId: 'cap-2', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: { caption: 'Birthday cake with lit candles on a kitchen table.', short_caption: 'Birthday cake' },
    });
    // Failed runs never touch the index.
    repo.recordProcessingRun({
      assetId: 'cap-1', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
      status: 'failed', error: 'x',
    });

    assert.deepEqual(repo.searchCaptions('beach').map((r) => r.assetId), ['cap-1']);
    assert.equal(repo.searchCaptions('beach')[0].shortCaption, 'Dog on beach');
    // Prefix matching: partial words hit.
    assert.deepEqual(repo.searchCaptions('birthd').map((r) => r.assetId), ['cap-2']);
    // AND semantics: both tokens must match.
    assert.deepEqual(repo.searchCaptions('beach candles'), []);
    // FTS5 syntax can't break the query: operators become literal tokens
    // (words starting with beach/and/not → no photo has all three) instead
    // of throwing a syntax error.
    assert.deepEqual(repo.searchCaptions('"beach" AND (NOT*'), []);
    assert.deepEqual(repo.searchCaptions('"beach"').map((r) => r.assetId), ['cap-1']);
    assert.deepEqual(repo.searchCaptions('   '), []);

    // Re-enrichment replaces the indexed caption (latest run wins).
    repo.recordProcessingRun({
      assetId: 'cap-1', provider: 'p', model: 'm2', promptVersion: 'v1', taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: { caption: 'Dog swimming in a mountain lake.', short_caption: 'Dog in lake' },
    });
    assert.deepEqual(repo.searchCaptions('beach'), []);
    assert.deepEqual(repo.searchCaptions('lake').map((r) => r.assetId), ['cap-1']);
  });
});

test('caption index backfills once from latest succeeded runs', () => {
  withRepo((repo) => {
    repo.upsertAsset({ id: 'bf-1' });
    repo.recordProcessingRun({
      assetId: 'bf-1', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
      status: 'succeeded', normalizedOutput: { caption: 'Snowy mountain cabin.', short_caption: 'Cabin' },
    });
    // Simulate a pre-index database, then re-init as an upgraded server would.
    repo.db.exec('DROP TABLE caption_vocab');
    repo.db.exec('DROP TABLE caption_index');
    repo.db.exec('PRAGMA user_version = 0'); // a real pre-caption-index DB predates the version stamp
    repo.initSchema();
    assert.deepEqual(repo.searchCaptions('snowy cabin').map((r) => r.assetId), ['bf-1']);
    // Re-init must not duplicate index rows.
    repo.initSchema();
    assert.equal(repo.searchCaptions('cabin').length, 1);
  });
});

test('captionTerms returns photo counts without grammatical stopwords', () => {
  withRepo((repo) => {
    const captions = [
      'A dog on the beach with the waves.',
      'The dog and the ball on the grass.',
      'Beach umbrella with the family.',
    ];
    captions.forEach((caption, index) => {
      repo.upsertAsset({ id: `t-${index}` });
      repo.recordProcessingRun({
        assetId: `t-${index}`, provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
        status: 'succeeded', normalizedOutput: { caption, short_caption: '' },
      });
    });
    const terms = repo.captionTerms({ limit: 10 });
    const byTerm = Object.fromEntries(terms.map((t) => [t.term, t.count]));
    assert.equal(byTerm.dog, 2);
    assert.equal(byTerm.beach, 2);
    assert.equal('the' in byTerm, false);
    assert.equal('with' in byTerm, false);
  });
});

test('assetIdsNeedingWork mirrors the runner skip checks in batch', () => {
  withRepo((repo) => {
    const runKey = { provider: 'venice', model: 'm1', promptVersion: 'v1', taxonomyVersion: 't1' };
    const run = (assetId, overrides = {}) => {
      repo.recordProcessingRun({ assetId, ...runKey, status: 'succeeded', normalizedOutput: {}, ...overrides });
    };
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a6']) {
      repo.upsertAsset({ id });
    }
    run('a1'); // succeeded under the run key
    run('a2', { model: 'm2' }); // succeeded under a different model only
    run('a3', { status: 'failed' }); // at the failure limit (2 strikes)
    run('a3', { status: 'failed' });
    run('a4', { status: 'failed_infra' }); // infra failures never count
    run('a4', { status: 'failed_infra' });
    run('a6', { status: 'failed' }); // one strike — still under the limit
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', '', null];

    // skipAnySuccessful: any success drops the asset, whatever the config.
    let result = repo.assetIdsNeedingWork(ids, { runKey, skipAnySuccessful: true, maxFailuresPerAsset: 2 });
    assert.deepEqual([...result.needy].sort(), ['a4', 'a5', 'a6']);
    assert.deepEqual([...result.successful].sort(), ['a1', 'a2']); // for Curate review-listing
    assert.deepEqual([...result.failureLimited], ['a3']); // unresolved, not "covered"

    // Matching-config mode: the other-model success no longer counts.
    result = repo.assetIdsNeedingWork(ids, { runKey, skipAnySuccessful: false, maxFailuresPerAsset: 2 });
    assert.deepEqual([...result.needy].sort(), ['a2', 'a4', 'a5', 'a6']);
    assert.deepEqual([...result.successful], ['a1']);

    // No failure limit: the twice-failed asset is needy again.
    result = repo.assetIdsNeedingWork(ids, { runKey, skipAnySuccessful: true, maxFailuresPerAsset: 0 });
    assert.deepEqual([...result.needy].sort(), ['a3', 'a4', 'a5', 'a6']);
    assert.deepEqual([...result.failureLimited], []);

    // Failures under a different model don't count against this run key.
    result = repo.assetIdsNeedingWork(['a3'], {
      runKey: { ...runKey, model: 'm2' },
      skipAnySuccessful: false,
      maxFailuresPerAsset: 2,
    });
    assert.deepEqual([...result.needy], ['a3']);

    // Successful wins over failure-limited, matching the runner's check
    // order: a photo that eventually succeeded is covered, not stuck.
    repo.upsertAsset({ id: 'a7' });
    run('a7', { status: 'failed' });
    run('a7', { status: 'failed' });
    run('a7');
    result = repo.assetIdsNeedingWork(['a7'], { runKey, skipAnySuccessful: true, maxFailuresPerAsset: 2 });
    assert.deepEqual([...result.successful], ['a7']);
    assert.deepEqual([...result.failureLimited], []);
  });
});

test('failureLimitedAssetIds finds the library-wide stuck set under one run key', () => {
  withRepo((repo) => {
    const runKey = { provider: 'venice', model: 'm1', promptVersion: 'v2', taxonomyVersion: 'v1' };
    const fail = (assetId, overrides = {}) => repo.recordProcessingRun({
      assetId,
      provider: runKey.provider,
      model: runKey.model,
      promptVersion: runKey.promptVersion,
      taxonomyVersion: runKey.taxonomyVersion,
      status: 'failed',
      error: 'content failure',
      ...overrides,
    });
    for (const id of ['stuck-a', 'stuck-b', 'covered', 'one-fail', 'other-model', 'infra']) {
      repo.upsertAsset({ id });
    }
    // At the limit with no success anywhere → stuck.
    fail('stuck-a');
    fail('stuck-a');
    fail('stuck-b');
    fail('stuck-b');
    fail('stuck-b');
    // At the limit but a later success under a DIFFERENT key covers it.
    fail('covered');
    fail('covered');
    repo.recordProcessingRun({
      assetId: 'covered',
      provider: 'other',
      model: 'x',
      promptVersion: 'v2',
      taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: { caption: 'ok' },
    });
    // Below the limit → not stuck.
    fail('one-fail');
    // Failures under another run key → not stuck under this one.
    fail('other-model', { model: 'm2' });
    fail('other-model', { model: 'm2' });
    // Infra failures never count toward the content limit.
    fail('infra', { status: 'failed_infra' });
    fail('infra', { status: 'failed_infra' });

    const result = repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2 });
    assert.deepEqual(result, { count: 2, assetIds: ['stuck-a', 'stuck-b'], truncated: false });

    // Without any-success skipping, only a same-key success would cover, so
    // the cross-key-covered asset re-enters the stuck set (last: its
    // failures are the most recent).
    const strict = repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2, skipAnySuccessful: false });
    assert.deepEqual(strict.assetIds, ['stuck-a', 'stuck-b', 'covered']);

    // A disabled limit means nothing can be stuck.
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 0 }),
      { count: 0, assetIds: [], truncated: false },
    );

    // The cap slices ids but the count and truncation stay honest.
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2, limit: 1 }),
      { count: 2, assetIds: ['stuck-a'], truncated: true },
    );

    // Rotation: a photo that fails again writes a newer row and moves to the
    // back, so a capped window cycles instead of starving the tail.
    fail('stuck-a');
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2, limit: 1 }).assetIds,
      ['stuck-b'],
    );

    // A photo confirmed gone from Immich leaves the set entirely — even at
    // the front of a capped window it cannot starve valid photos behind it.
    repo.markAssetsMissing(['stuck-b']);
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2, limit: 1 }).assetIds,
      ['stuck-a'],
    );
    // A deleted-only stuck set clears completely.
    repo.markAssetsMissing(['stuck-a']);
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2 }),
      { count: 0, assetIds: [], truncated: false },
    );
    // A restored photo — seen through Immich again — re-enters the set.
    repo.upsertAsset({ id: 'stuck-a' });
    assert.deepEqual(
      repo.failureLimitedAssetIds({ runKey, maxFailuresPerAsset: 2 }).assetIds,
      ['stuck-a'],
    );
  });
});
