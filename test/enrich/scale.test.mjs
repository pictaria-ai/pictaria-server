import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import { ReviewService } from '../../src/enrich/reviewService.mjs';
import { replaceTaxonomy } from '../../src/enrich/taxonomy.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

// Scale contract of the review path: request work is proportional to the
// review list / requested ids, never to the whole library, and repeated
// polls with no writes are served from the generation cache.

function withService(work, { config = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-scale-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const taxonomy = loadV1Taxonomy();
  const service = new ReviewService({ repo, immich: null, taxonomy, config, verifyDelayMs: 0 });
  try {
    return work({ repo, service, taxonomy });
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedAsset(repo, assetId, { output = sampleOutput(), tags = null, listed = true, capturedAt = null } = {}) {
  repo.upsertAsset({ id: assetId, originalPath: `/photos/${assetId}.jpg`, fileCreatedAt: capturedAt });
  repo.recordProcessingRun({
    assetId,
    provider: 'p',
    model: 'm',
    promptVersion: 'v1',
    taxonomyVersion: 'v1',
    status: 'succeeded',
    normalizedOutput: output,
  });
  repo.replaceAssetTags({
    assetId,
    decisions: tags ?? [{ tag: 'ai/quality/frame-worthy', confidence: 0.9, source: 'ai', reason: 'test' }],
    model: 'm',
    taxonomyVersion: 'v1',
  });
  if (listed) {
    repo.reviewListAdd([assetId], 'test');
  }
}

test('reviewRows is cached until a review-relevant write bumps the generation', () => {
  withService(({ repo, service, taxonomy }) => {
    seedAsset(repo, 'cached-1');
    seedAsset(repo, 'cached-2');

    const first = service.reviewRows();
    const second = service.reviewRows();
    assert.equal(second, first, 'no writes: the same array reference comes back');

    const before = repo.generation;
    repo.setManualFrameTags({ assetIds: ['cached-1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    assert.ok(repo.generation > before, 'a decision bumps the generation');

    const third = service.reviewRows();
    assert.notEqual(third, first, 'the write invalidated the cache');
    assert.equal(third.find((row) => row.assetId === 'cached-1').state, 'approved');

    // A taxonomy swap (Settings override) replaces raw in place on the live
    // object — that alone must recompute, thresholds are read-time.
    const fourth = service.reviewRows();
    replaceTaxonomy(taxonomy, loadV1Taxonomy());
    assert.notEqual(service.reviewRows(), fourth);
  });
});

test('every review-relevant write method bumps the generation', () => {
  withService(({ repo }) => {
    const bumps = [
      () => repo.upsertAsset({ id: 'g1' }),
      () => repo.updateAssetVisuals('g1', { thumbhash: 'AA==' }),
      () => repo.recordProcessingRun({
        assetId: 'g1', provider: 'p', model: 'm', promptVersion: 'v1',
        taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: sampleOutput(),
      }),
      () => repo.replaceAssetTags({ assetId: 'g1', decisions: [{ tag: 'ai/scene/water', confidence: 0.9, source: 'ai', reason: 'x' }], model: 'm', taxonomyVersion: 'v1' }),
      () => repo.reviewListAdd(['g1'], 'test'),
      () => repo.recordDecision({ assetIds: ['g1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' }),
      () => repo.setManualFrameTags({ assetIds: ['g1'], addTags: [], removeTags: ['frame/eligible'], action: 'clear' }),
      () => repo.refereeRecordGroup({ groupKey: 'k', memberCount: 1, sameSubject: true, provider: 'p', model: 'm', picks: [{ assetId: 'g1', rank: 1, keep: true }] }),
      () => repo.deleteAssetTagDecisions('ai/scene/water'),
    ];
    for (const write of bumps) {
      const before = repo.generation;
      write();
      assert.ok(repo.generation > before, `${write.toString().slice(0, 60)} must bump`);
    }
  });
});

test('latest_success write-through: newest succeeded run always wins', () => {
  withService(({ repo }) => {
    repo.upsertAsset({ id: 'proj-1' });
    const run = (output) =>
      repo.recordProcessingRun({
        assetId: 'proj-1', provider: 'p', model: 'm', promptVersion: 'v1',
        taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: output,
      });

    const first = sampleOutput();
    first.exclusion_reasons = [{ tag: 'ai/exclude/private', confidence: 0.5, reason: 'ignored detail' }];
    first.needs_review = true;
    const firstRunId = run(first);

    let row = repo.db.prepare("SELECT * FROM latest_success WHERE asset_id = 'proj-1'").get();
    assert.equal(row.run_id, firstRunId);
    assert.equal(row.short_caption, 'Mountain lake.');
    assert.equal(row.frame_score, 0.91);
    assert.equal(row.aesthetic_score, 0.86);
    assert.equal(row.needs_review, 1);
    // Only tag + confidence survive the projection; the rest of the entry doesn't.
    assert.deepEqual(JSON.parse(row.exclusion_reasons_json), [{ tag: 'ai/exclude/private', confidence: 0.5 }]);

    // Failed runs never touch the projection.
    repo.recordProcessingRun({
      assetId: 'proj-1', provider: 'p', model: 'm', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'failed', error: 'x',
    });
    assert.equal(repo.db.prepare("SELECT run_id FROM latest_success WHERE asset_id = 'proj-1'").get().run_id, firstRunId);

    // Re-enrichment replaces the row with the newest run.
    const second = sampleOutput();
    second.short_caption = 'Alpine lake.';
    second.quality.frame_worthy_score = 0.4;
    const secondRunId = run(second);
    row = repo.db.prepare("SELECT * FROM latest_success WHERE asset_id = 'proj-1'").get();
    assert.equal(row.run_id, secondRunId);
    assert.equal(row.short_caption, 'Alpine lake.');
    assert.equal(row.frame_score, 0.4);
    assert.equal(row.needs_review, 0);
    assert.equal(row.exclusion_reasons_json, null);
  });
});

test('a pre-v3 database backfills latest_success from the latest succeeded runs', () => {
  withService(({ repo }) => {
    seedAsset(repo, 'bf-1');
    const newer = sampleOutput();
    newer.short_caption = 'Newest caption.';
    repo.recordProcessingRun({
      assetId: 'bf-1', provider: 'p', model: 'm2', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: newer,
    });
    repo.upsertAsset({ id: 'bf-failed' });
    repo.recordProcessingRun({
      assetId: 'bf-failed', provider: 'p', model: 'm', promptVersion: 'v1',
      taxonomyVersion: 'v1', status: 'failed', error: 'x',
    });

    // Simulate a pre-v3 database, then re-init as an upgraded server would.
    repo.db.exec('DROP TABLE latest_success');
    repo.db.exec('PRAGMA user_version = 2');
    assert.deepEqual(repo.initSchema().applied, [3, 4, 5, 6]);

    const rows = repo.db.prepare('SELECT * FROM latest_success ORDER BY asset_id').all();
    assert.equal(rows.length, 1, 'only assets with a succeeded run are projected');
    assert.equal(rows[0].asset_id, 'bf-1');
    assert.equal(rows[0].short_caption, 'Newest caption.');
    assert.equal(rows[0].model, 'm2');

    // Re-init must not run the migration again.
    assert.deepEqual(repo.initSchema().applied, []);
  });
});

test('reviewAssetTagRows returns tags for review-list members only', () => {
  withService(({ repo }) => {
    seedAsset(repo, 'in-list');
    seedAsset(repo, 'not-listed', { listed: false });

    const grouped = repo.reviewAssetTagRows();
    assert.deepEqual(Object.keys(grouped), ['in-list']);
    assert.equal(grouped['in-list'][0].tag, 'ai/quality/frame-worthy');
    assert.equal(grouped['in-list'][0].confidence, 0.9);
  });
});

test('scoped id reads chunk past 500 ids and handle empty input', () => {
  withService(({ repo }) => {
    const ids = Array.from({ length: 550 }, (_, i) => `bulk-${String(i).padStart(4, '0')}`);
    repo.transaction(() => {
      for (const id of ids) {
        repo.upsertAsset({ id });
        repo.recordProcessingRun({
          assetId: id, provider: 'p', model: 'm', promptVersion: 'v1',
          taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: sampleOutput(),
        });
        repo.replaceAssetTags({
          assetId: id,
          decisions: [{ tag: 'ai/scene/mountains', confidence: 0.9, source: 'ai', reason: 'x' }],
          model: 'm',
          taxonomyVersion: 'v1',
        });
      }
    });

    const tags = repo.loadAssetTagsFor([...ids, 'missing', ''], { prefix: 'ai/' });
    assert.equal(Object.keys(tags).length, 550);
    assert.deepEqual(tags['bulk-0549'], ['ai/scene/mountains']);
    assert.equal('missing' in tags, false);
    assert.deepEqual(repo.loadAssetTagsFor([]), {});

    const success = repo.latestSuccessFor([...ids, 'missing']);
    assert.equal(success.length, 550);
    assert.deepEqual(repo.latestSuccessFor([]), []);
    assert.equal(repo.loadAssetTagsFor(ids, { prefix: 'frame/' })['bulk-0000'], undefined);
  });
});

test('assetsResponse still derives everything the full output used to provide', () => {
  withService(({ repo, service }) => {
    // Borderline photo with privacy uncertainty and a model review request:
    // exercises every field the projection carries. Expected values computed
    // from the pre-projection pipeline (full normalized_output_json parse).
    const output = sampleOutput();
    output.short_caption = 'Kitchen table papers.';
    output.quality.frame_worthy_score = 0.7; // review_low 0.65 <= 0.7 < frame_worthy 0.78
    output.quality.aesthetic_score = 0.6;
    output.needs_review = true;
    output.exclusion_reasons = [{ tag: 'ai/exclude/private', confidence: 0.5 }]; // 0.45 <= 0.5 < 0.7
    seedAsset(repo, 'contract-1', {
      output,
      tags: [{ tag: 'ai/quality/good', confidence: 0.7, source: 'ai', reason: 'test' }],
    });

    const response = service.assetsResponse(new URLSearchParams({ view: 'should_review' }));
    assert.equal(response.assets.length, 1);
    const asset = response.assets[0];
    assert.equal(asset.caption, 'Kitchen table papers.');
    assert.equal(asset.bucket, 'should_review');
    assert.equal(asset.state, 'undecided');
    assert.equal(asset.frameScore, 0.7);
    assert.equal(asset.aestheticScore, 0.6);
    assert.deepEqual(asset.reasons, ['privacy? private 0.50', 'borderline 0.70', 'model requested review']);
    assert.deepEqual(asset.aiTags, ['ai/quality/good']);
  });
});

test('grouping toggled off serves flat pages while shared annotations stay on the cached rows', () => {
  withService(({ repo, service }) => {
    seedAsset(repo, 'stack-1', { capturedAt: '2026-07-01T10:00:00.000Z' });
    seedAsset(repo, 'stack-2', { capturedAt: '2026-07-01T10:00:05.000Z' });
    seedAsset(repo, 'solo-1', { capturedAt: '2026-07-02T10:00:00.000Z' });

    // The referee and grid share one full-set annotation, so cached rows keep
    // their stacks even when the display toggle is off…
    const rows = service.annotatedReviewRows();
    assert.ok(rows.some((row) => row.burstId));

    // …and the flat-queue view strips the burst fields at serialization
    // instead of resetting the shared objects the referee still reads.
    const flat = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    assert.ok(flat.assets.every((asset) => asset.burstId === undefined));
    assert.ok(rows.some((row) => row.burstId), 'serving a flat view must not strip the shared rows');
    assert.equal(service.reviewRows(), rows, 'reads never invalidate the cache');
  }, { config: { curateBurstGrouping: false } });
});

test('10k-asset library: warm assetsResponse stays fast', () => {
  withService(({ repo, service }) => {
    const COUNT = 10000;
    repo.transaction(() => {
      for (let i = 0; i < COUNT; i += 1) {
        const id = `perf-${String(i).padStart(5, '0')}`;
        const output = sampleOutput();
        output.quality.frame_worthy_score = 0.5 + (i % 50) / 100;
        repo.upsertAsset({
          id,
          originalPath: `/photos/${id}.jpg`,
          fileCreatedAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
        });
        repo.recordProcessingRun({
          assetId: id, provider: 'p', model: 'm', promptVersion: 'v1',
          taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: output,
        });
        repo.replaceAssetTags({
          assetId: id,
          decisions: [{ tag: i % 2 ? 'ai/quality/frame-worthy' : 'ai/quality/good', confidence: 0.8, source: 'ai', reason: 'x' }],
          model: 'm',
          taxonomyVersion: 'v1',
        });
      }
      repo.reviewListAdd(Array.from({ length: COUNT }, (_, i) => `perf-${String(i).padStart(5, '0')}`), 'test');
    });

    service.assetsResponse(new URLSearchParams({ view: 'candidates', limit: '100' })); // warm the cache
    const started = process.hrtime.bigint();
    const response = service.assetsResponse(new URLSearchParams({ view: 'candidates', limit: '100' }));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(response.assets.length >= 100, true);
    // Generous smoke budget — structural assertions above carry the real
    // guarantees; this only catches an accidental return to O(library) work.
    assert.ok(elapsedMs < 2000, `warm assetsResponse took ${elapsedMs.toFixed(0)}ms`);
  });
});
