import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import {
  ReviewService,
  annotateBursts,
  chunkByLargestGap,
  MAX_STACK_MEMBERS,
  THUMBHASH_ALL_PAIRS_MAX_ITEMS,
  THUMBHASH_COMPARISON_BUDGET,
  THUMBHASH_MAX_BYTES,
  thumbhashDistance,
} from '../../src/enrich/reviewService.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();
const DECISION_ID = '00000000-0000-0000-0000-000000000001';
const syncAssetId = (index) => `00000000-0000-0000-0001-${String(index + 1).padStart(12, '0')}`;

class FakeImmich {
  constructor() {
    this.calls = [];
    this.assetTags = new Map(); // assetId -> Set of tag values (stateful, like real Immich)
    this.tags = [
      { id: 'tag-frame/eligible', value: 'frame/eligible' },
      { id: 'tag-frame/favorite', value: 'frame/favorite' },
      { id: 'tag-frame/never-show', value: 'frame/never-show' },
      { id: 'tag-frame/reviewed', value: 'frame/reviewed' },
    ];
  }

  #valueForId(tagId) {
    return String(tagId).replace(/^tag-/, '');
  }

  async listTags() {
    this.calls.push(['listTags']);
    return [...this.tags];
  }

  async upsertTags(tags) {
    this.calls.push(['upsertTags', tags]);
    const created = tags.map((tag) => ({ id: `tag-${tag}`, value: tag }));
    this.tags.push(...created.filter((tag) => !this.tags.some((known) => known.id === tag.id)));
    return created;
  }

  async createTag(tag) {
    return { id: `tag-${tag}`, value: tag };
  }

  async tagAssetsBulk({ assetIds, tagIds }) {
    this.calls.push(['tag', tagIds, assetIds]);
    for (const assetId of assetIds) {
      const tags = this.assetTags.get(assetId) ?? new Set();
      for (const tagId of tagIds) tags.add(this.#valueForId(tagId));
      this.assetTags.set(assetId, tags);
    }
    return { count: assetIds.length };
  }

  async untagAssets({ tagId, assetIds }) {
    this.calls.push(['untag', tagId, assetIds]);
    for (const assetId of assetIds) {
      this.assetTags.get(assetId)?.delete(this.#valueForId(tagId));
    }
    return [];
  }

  async getAsset(assetId) {
    this.calls.push(['getAsset', assetId]);
    const tags = [...(this.assetTags.get(assetId) ?? [])].map((value) => ({ id: `tag-${value}`, value }));
    return { id: assetId, tags };
  }

  async getAssetThumbnail() {
    return { data: Buffer.from('img'), contentType: 'image/jpeg' };
  }
}

function withService(work, { config = null, log = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-review-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const immich = new FakeImmich();
  const service = new ReviewService({ repo, immich, taxonomy, config, log, verifyDelayMs: 0 });
  return Promise.resolve(work({ repo, immich, service })).finally(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function seedAsset(repo, assetId, { frameScore = 0.9, capturedAt = null, decisions = null, thumbhash = null } = {}) {
  repo.upsertAsset({ id: assetId, originalPath: `/photos/${assetId}.jpg`, fileCreatedAt: capturedAt, thumbhash });
  const output = sampleOutput();
  output.quality.frame_worthy_score = frameScore;
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
    decisions: decisions ?? [
      { tag: frameScore >= 0.78 ? 'ai/quality/frame-worthy' : 'ai/quality/good', confidence: frameScore, source: 'ai', reason: 'test' },
    ],
    model: 'm',
    taxonomyVersion: 'v1',
  });
  // Membership is explicit now: enriched photos reach Curate only when the
  // job sends them (which these tests assume).
  repo.reviewListAdd([assetId], 'test');
}

test('photos sent to Curate without enrichment appear as Candidates', async () => {
  await withService(async ({ repo, service }) => {
    // Direct "Send to Curate": asset metadata only, no processing run.
    repo.upsertAsset({ id: 'plain-1', originalPath: '/photos/plain-1.jpg' });
    repo.reviewListAdd(['plain-1'], 'send');
    seedAsset(repo, 'good-1', { frameScore: 0.9 });

    const response = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    const plain = response.assets.find((asset) => asset.assetId === 'plain-1');
    assert.ok(plain, 'un-enriched photo should be in the candidates view');
    assert.equal(plain.state, 'undecided');
    assert.deepEqual(plain.reasons, ['not enriched']);
    assert.deepEqual(plain.aiTags, []);
    // Enriched photos still bucket normally alongside it.
    assert.ok(response.assets.some((asset) => asset.assetId === 'good-1'));
  });
});

test('enriched photos NOT sent to Curate stay out of the review queue', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, 'listed-1');
    // Enriched with "send to Curate" off: run + tags exist, no membership.
    repo.upsertAsset({ id: 'unlisted-1', originalPath: '/photos/unlisted-1.jpg' });
    repo.recordProcessingRun({
      assetId: 'unlisted-1',
      provider: 'p',
      model: 'm',
      promptVersion: 'v1',
      taxonomyVersion: 'v1',
      status: 'succeeded',
      normalizedOutput: sampleOutput(),
    });

    const response = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    assert.deepEqual(response.assets.map((asset) => asset.assetId), ['listed-1']);
  });
});

test('assetsResponse buckets undecided photos and counts decided separately', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, 'good-1', { frameScore: 0.9 });
    seedAsset(repo, 'mid-1', { frameScore: 0.7 });
    seedAsset(repo, 'bad-1', {
      frameScore: 0.2,
      decisions: [{ tag: 'ai/exclude/screenshot', confidence: 0.95, source: 'ai', reason: 'ui' }],
    });
    seedAsset(repo, 'done-1', { frameScore: 0.85 });
    repo.setManualFrameTags({ assetIds: ['done-1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });

    const response = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    const byId = Object.fromEntries(response.buckets.map((bucket) => [bucket.id, bucket.count]));

    assert.equal(byId.candidates, 1);
    assert.equal(byId.should_review, 1);
    assert.equal(byId.unlikely, 1);
    assert.equal(response.decidedCount, 1);
    assert.deepEqual(response.assets.map((asset) => asset.assetId), ['good-1']);
    assert.equal(response.buckets[0].id, 'candidates');
  });
});

test('candidates sort by frame score descending', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, 'low', { frameScore: 0.8 });
    seedAsset(repo, 'high', { frameScore: 0.97 });
    seedAsset(repo, 'mid', { frameScore: 0.88 });

    const response = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));

    assert.deepEqual(response.assets.map((asset) => asset.assetId), ['high', 'mid', 'low']);
  });
});

test('search matches frame tags, state, and reasons in the decided view', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, 'approved-1');
    seedAsset(repo, 'rejected-1');
    repo.setManualFrameTags({ assetIds: ['approved-1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    repo.setManualFrameTags({ assetIds: ['rejected-1'], addTags: ['frame/never-show'], removeTags: [], action: 'reject' });

    const byEligible = service.assetsResponse(new URLSearchParams({ view: 'decided', q: 'eligible' }));
    assert.deepEqual(byEligible.assets.map((asset) => asset.assetId), ['approved-1']);

    const byState = service.assetsResponse(new URLSearchParams({ view: 'decided', q: 'rejected' }));
    assert.deepEqual(byState.assets.map((asset) => asset.assetId), ['rejected-1']);
  });
});

test('decisions record locally, queue durably, and the worker pushes to Immich', async () => {
  await withService(async ({ repo, immich, service }) => {
    seedAsset(repo, DECISION_ID);
    const result = service.applyDecision({ action: 'approve', assetIds: [DECISION_ID] });

    assert.equal(result.ok, true);
    assert.equal(result.sync.pending, 1);
    assert.equal(immich.calls.length, 0, 'decision must not wait on Immich');

    const job = repo.nextSyncJob();
    await service.pushDecisionToImmich(job);
    repo.completeSyncJob(job.id);

    const tagCalls = immich.calls.filter(([kind]) => kind === 'tag');
    assert.ok(tagCalls.some(([, tagIds]) => tagIds.includes('tag-frame/eligible')));
    // Verification confirms Immich actually holds the tags after the push.
    assert.ok(immich.assetTags.get(DECISION_ID).has('frame/eligible'));
    assert.equal(repo.pendingSyncJobCount(), 0);
  });
});

test('legacy sync jobs reconcile remote work in bounded slices', async () => {
  await withService(async ({ repo, immich, service }) => {
    const assetIds = Array.from({ length: 101 }, (_, index) => syncAssetId(index));
    repo.recordDecision({
      action: 'approve',
      assetIds,
      addTags: ['frame/eligible'],
      removeTags: [],
    });
    service.startSyncWorker();
    for (let attempt = 0; attempt < 100 && repo.pendingSyncJobCount() > 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await service.stopSyncWorker();
    const bulkCalls = immich.calls.filter(([kind]) => kind === 'tag');
    assert.equal(bulkCalls.length, 3);
    assert.ok(bulkCalls.every(([, , ids]) => ids.length <= 50));
    assert.equal(immich.calls.filter(([kind]) => kind === 'getAsset').length, assetIds.length * 2);
    assert.equal(repo.pendingSyncJobCount(), 0);
  });
});

test('successful sync slices advance durably before a later slice fails', async () => {
  await withService(async ({ repo, immich, service }) => {
    const assetIds = Array.from({ length: 75 }, (_, index) => syncAssetId(index));
    const jobId = repo.recordDecision({ action: 'approve', assetIds, addTags: ['frame/eligible'], removeTags: [] });
    const original = immich.tagAssetsBulk.bind(immich);
    let calls = 0;
    let signalSecondSlice;
    const secondSliceAttempted = new Promise((resolve) => {
      signalSecondSlice = resolve;
    });
    immich.tagAssetsBulk = async (request) => {
      calls += 1;
      if (calls === 2) {
        // Let the worker enter its interruptible retry sleep before the test
        // stops it; signaling in this microtask would miss the pending wake.
        setTimeout(signalSecondSlice, 0);
        throw new Error('second slice unavailable');
      }
      return original(request);
    };
    service.startSyncWorker();
    let timeout;
    try {
      await Promise.race([
        secondSliceAttempted,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('sync worker did not attempt the second slice within 5 seconds')),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      await service.stopSyncWorker();
    }
    const remaining = repo.nextSyncJob();
    assert.equal(remaining.id, jobId);
    assert.deepEqual(remaining.assetIds, assetIds.slice(50));
    assert.equal(remaining.attempts, 1);
  });
});

test('startup parks a malformed restored sync head and continues with later valid work', async () => {
  await withService(async ({ repo, immich, service }) => {
    const secret = 'restored-secret-that-must-not-leak';
    const malformedId = Number(repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES ('approve', ?, '["frame/eligible"]', '[]', 0, ?)
    `).run(`["${secret}"`, new Date().toISOString()).lastInsertRowid);
    const validId = syncAssetId(200);
    repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES ('approve', ?, '["frame/eligible"]', '[]', 0, ?)
    `).run(JSON.stringify([validId]), new Date().toISOString());

    service.startSyncWorker();
    for (let attempt = 0; attempt < 100 && repo.pendingSyncJobCount() > 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await service.stopSyncWorker(), true);

    assert.equal(repo.pendingSyncJobCount(), 0);
    assert.equal(repo.deadSyncJobCount(), 1);
    const [parked] = service.deadSyncJobs();
    assert.equal(parked.id, malformedId);
    assert.match(parked.lastError, /Malformed restored review sync job/);
    assert.doesNotMatch(parked.lastError, /Error:/);
    assert.doesNotMatch(JSON.stringify(parked), new RegExp(secret));
    assert.ok(immich.calls.some(([kind, assetId]) => kind === 'getAsset' && assetId === validId));
    assert.ok(immich.calls.every((call) => !JSON.stringify(call).includes(secret)));

    // Retrying cannot make corrupt persisted fields valid. It safely parks
    // the row again, without letting the malformed payload reach Immich.
    const callsBeforeRetry = immich.calls.length;
    assert.equal(service.retryDeadSyncJobs(malformedId), 1);
    service.startSyncWorker();
    for (let attempt = 0; attempt < 100 && repo.pendingSyncJobCount() > 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await service.stopSyncWorker(), true);
    assert.equal(repo.pendingSyncJobCount(), 0);
    assert.equal(repo.deadSyncJobCount(), 1);
    assert.equal(immich.calls.length, callsBeforeRetry);
    const [reparked] = service.deadSyncJobs();
    assert.doesNotMatch(reparked.lastError, /Error:/);
    assert.doesNotMatch(JSON.stringify(reparked), new RegExp(secret));
  });
});

test('status reads leave malformed scalars untouched until the worker parks and logs them', async () => {
  const logs = [];
  await withService(async ({ repo, immich, service }) => {
    const secret = 'oversized-restored-scalar-must-not-leak';
    const oversizedAction = secret.repeat(5000);
    const malformedId = Number(repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES (?, '["00000000-0000-0000-0000-000000000001"]',
        '["frame/eligible"]', '[]', 9223372036854775807, ?)
    `).run(oversizedAction, new Date().toISOString()).lastInsertRowid);
    const validId = syncAssetId(201);
    repo.db.prepare(`
      INSERT INTO pending_sync_jobs (
        action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at
      ) VALUES ('approve', ?, '["frame/eligible"]', '[]', 0, ?)
    `).run(JSON.stringify([validId]), new Date().toISOString());

    for (let read = 0; read < 3; read += 1) {
      const status = service.syncStatus();
      assert.equal(status.pending, 2);
      assert.equal(status.dead, 0);
      assert.match(status.lastError, /Malformed restored review sync job/);
    }
    const untouched = repo.db.prepare(`
      SELECT CAST(attempts AS TEXT) AS attempts, last_error, dead_at
      FROM pending_sync_jobs WHERE id = ?
    `).get(malformedId);
    assert.equal(untouched.attempts, '9223372036854775807');
    assert.equal(untouched.last_error, null);
    assert.equal(untouched.dead_at, null);

    service.startSyncWorker();
    for (let attempt = 0; attempt < 100 && repo.pendingSyncJobCount() > 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(await service.stopSyncWorker(), true);

    assert.equal(repo.pendingSyncJobCount(), 0);
    assert.equal(repo.deadSyncJobCount(), 1);
    assert.ok(immich.calls.some(([kind, assetId]) => kind === 'getAsset' && assetId === validId));
    assert.ok(logs.some((line) => line.includes(`parked malformed restored job ${malformedId}`)));
    assert.ok(logs.every((line) => !line.includes(secret)));
  }, { log: (line) => logs.push(line) });
});

test('stopSyncWorker resolves promptly while the worker idles', async () => {
  await withService(async ({ service }) => {
    service.startSyncWorker();

    const started = Date.now();
    await service.stopSyncWorker();

    // An idle loop parks in a 5s poll sleep; stop must wake it, not wait it out.
    assert.ok(Date.now() - started < 1000, 'stop should not wait out the idle poll');
  });
});

test('stopSyncWorker waits for the in-flight push to finish', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, DECISION_ID);
    let releaseJob;
    let jobStarted;
    const jobRunning = new Promise((resolve) => {
      jobStarted = resolve;
    });
    service.pushDecisionToImmich = () => {
      jobStarted();
      return new Promise((resolve) => {
        releaseJob = resolve;
      });
    };

    service.applyDecision({ action: 'approve', assetIds: [DECISION_ID] });
    service.startSyncWorker();
    await jobRunning;

    let stopped = false;
    const stopPromise = service.stopSyncWorker().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, 'stop must wait for the in-flight job');

    releaseJob();
    await stopPromise;
    // The job it waited for completed and left the durable queue.
    assert.equal(repo.pendingSyncJobCount(), 0);
  });
});

const TWO_AI_TAGS = [
  { tag: 'ai/quality/frame-worthy', confidence: 0.9, source: 'ai', reason: 'test' },
  { tag: 'ai/scene/mountains', confidence: 0.9, source: 'ai', reason: 'test' },
];

test('ai tag additions batch into one bulk call per shared tag set', async () => {
  await withService(async ({ repo, immich, service }) => {
    seedAsset(repo, 'a1', { decisions: TWO_AI_TAGS });
    seedAsset(repo, 'a2', { decisions: TWO_AI_TAGS });
    await service.syncAiTagsForAssets(['a1', 'a2'], {});

    const tagCalls = immich.calls.filter(([kind]) => kind === 'tag');
    // Both assets share the same ai tag set, so ONE bulk call covers all
    // additions for both assets (one mutation event per asset).
    assert.equal(tagCalls.length, 1);
    assert.deepEqual(tagCalls[0][2], ['a1', 'a2']);
    assert.equal(tagCalls[0][1].length, 2);
  });
});

test('a dropped tag is detected by verification and repaired', async () => {
  await withService(async ({ repo, immich, service }) => {
    seedAsset(repo, 'droppy', { decisions: TWO_AI_TAGS });
    // Simulate Immich dropping one tag on the first bulk write only.
    const originalBulk = immich.tagAssetsBulk.bind(immich);
    let dropped = false;
    immich.tagAssetsBulk = async ({ assetIds, tagIds }) => {
      const result = await originalBulk({ assetIds, tagIds });
      if (!dropped && tagIds.length > 1) {
        dropped = true;
        immich.assetTags.get(assetIds[0])?.delete(String(tagIds[0]).replace(/^tag-/, ''));
      }
      return result;
    };

    const job = { id: 1, action: 'approve', assetIds: ['droppy'], add: ['frame/eligible'], remove: [], attempts: 0 };
    await service.pushDecisionToImmich(job);

    const finalTags = immich.assetTags.get('droppy');
    assert.ok(finalTags.has('frame/eligible'));
    for (const tag of repo.loadAssetTagsFor(['droppy'], { prefix: 'ai/' }).droppy ?? []) {
      assert.ok(finalTags.has(tag), `expected repaired tag ${tag}`);
    }
  });
});

test('burst annotation groups photos captured within the tight chain window', () => {
  const rows = [
    { assetId: 'x1', capturedAt: '2026-07-01T10:00:00.000Z' },
    { assetId: 'x2', capturedAt: '2026-07-01T10:00:10.000Z' },
    { assetId: 'x3', capturedAt: '2026-07-01T10:00:24.000Z' },
    { assetId: 'far', capturedAt: '2026-07-01T14:00:00.000Z' },
    { assetId: 'untimed', capturedAt: null },
  ];

  annotateBursts(rows);

  const burst = rows.filter((row) => row.burstSize === 3);
  assert.equal(burst.length, 3);
  assert.deepEqual(burst[0].burstAssetIds, ['x1', 'x2', 'x3']);
  assert.equal(rows.find((row) => row.assetId === 'far').burstSize, undefined);
  assert.equal(rows.find((row) => row.assetId === 'untimed').burstSize, undefined);
});

test('beyond the tight window, dissimilar photos no longer chain (the stroll case)', () => {
  // A walk shooting a different subject every ~60s used to chain into one
  // giant transitive group; without visual similarity these stay separate.
  const rows = [
    { assetId: 's1', capturedAt: '2026-07-01T10:00:00.000Z', thumbhash: hash(BASE_HASH) },
    { assetId: 's2', capturedAt: '2026-07-01T10:01:00.000Z', thumbhash: hash(BASE_HASH.map((b) => 255 - b)) },
    { assetId: 's3', capturedAt: '2026-07-01T10:02:00.000Z', thumbhash: hash(BASE_HASH.map((b) => (b * 7) % 256)) },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, undefined);
  assert.equal(rows[1].burstSize, undefined);
  assert.equal(rows[2].burstSize, undefined);
});

test('beyond the tight window, similar-looking photos still chain (the re-frame case)', () => {
  const near = [...BASE_HASH];
  near[3] -= 90;
  near[9] -= 90;
  near[15] -= 90; // 270/6375 ≈ 0.042 — similar scene, but not a near-dup (>0.025)
  const rows = [
    { assetId: 'r1', capturedAt: '2026-07-01T10:00:00.000Z', thumbhash: hash(BASE_HASH) },
    { assetId: 'r2', capturedAt: '2026-07-01T10:01:30.000Z', thumbhash: hash(near) },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, 2);
  assert.deepEqual(rows[0].burstAssetIds, ['r1', 'r2']);
});

test('similar-looking photos beyond the wide window do not time-chain', () => {
  const similar = [...BASE_HASH];
  similar[3] -= 90;
  similar[9] -= 90;
  similar[15] -= 90; // ≈0.042 — similar scene but NOT a near-dup (>0.025)
  const rows = [
    { assetId: 'w1', capturedAt: '2026-07-01T10:00:00.000Z', thumbhash: hash(BASE_HASH) },
    { assetId: 'w2', capturedAt: '2026-07-01T10:03:30.000Z', thumbhash: hash(similar) }, // 3.5 min
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, undefined);
  assert.equal(rows[1].burstSize, undefined);
});

test('ordinary shooting days keep exact all-pairs thumbhash matching', () => {
  const base = Buffer.alloc(25, 100);
  const near = Buffer.from(base);
  near[0] += 90; // 90 / 6375 ~= 0.014, inside the near-duplicate threshold
  const rows = Array.from({ length: THUMBHASH_ALL_PAIRS_MAX_ITEMS }, (_, index) => ({
    assetId: `ordinary-${String(index).padStart(3, '0')}`,
    capturedAt: new Date(Date.UTC(2026, 6, 1) + index * 240_000).toISOString(),
    thumbhash: Buffer.alloc(25, index % 2 ? 0 : 255).toString('base64'),
  }));
  rows[0].thumbhash = base.toString('base64');
  rows.at(-1).thumbhash = near.toString('base64');

  const metrics = {};
  annotateBursts(rows, { metrics });

  assert.equal(rows[0].burstId, rows.at(-1).burstId, 'an all-day pair remains discoverable at the exact-mode ceiling');
  assert.equal(metrics.boundedFallbackDays, 0);
});

test('oversized shooting days use bounded matching without losing exact or nearby duplicates', () => {
  const count = THUMBHASH_ALL_PAIRS_MAX_ITEMS + 1;
  const exact = Buffer.alloc(25, 17);
  const nearA = Buffer.alloc(25, 100);
  const nearB = Buffer.from(nearA);
  nearB[0] += 70;
  nearB[1] -= 70; // same byte sum, non-identical, distance ~= 0.022
  const rows = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.alloc(25);
    for (let byte = 0; byte < bytes.length; byte += 1) bytes[byte] = (index * 37 + byte * 19) % 256;
    return {
      assetId: `z-${String(index).padStart(3, '0')}`,
      capturedAt: new Date(Date.UTC(2026, 6, 2) + index * 240_000).toISOString(),
      thumbhash: bytes.toString('base64'),
    };
  });
  rows[0] = { ...rows[0], assetId: 'exact-first', thumbhash: exact.toString('base64') };
  rows.at(-1).assetId = 'exact-last';
  rows.at(-1).thumbhash = exact.toString('base64');
  rows[1] = { ...rows[1], assetId: 'near-a', thumbhash: nearA.toString('base64') };
  rows[2] = { ...rows[2], assetId: 'near-b', thumbhash: nearB.toString('base64') };

  const metrics = {};
  annotateBursts(rows, { metrics });

  assert.equal(rows[0].burstId, rows.at(-1).burstId, 'byte-identical hashes join regardless of distance in the day');
  assert.equal(rows[1].burstId, rows[2].burstId, 'bounded candidates still use the exact distance gate');
  assert.equal(metrics.boundedFallbackDays, 1);
  assert.ok(metrics.thumbhashComparisons <= count * 8);
});

test('30k dense thumbhash rows stay inside the hard work budget and return control promptly', async () => {
  const rows = [];
  const perDay = 300;
  for (let index = 0; index < 30_000; index += 1) {
    const day = Math.floor(index / perDay);
    const withinDay = index % perDay;
    const bytes = Buffer.alloc(25);
    for (let byte = 0; byte < bytes.length; byte += 1) bytes[byte] = (index * 31 + byte * 17) % 256;
    rows.push({
      assetId: `dense-${String(index).padStart(5, '0')}`,
      capturedAt: new Date(Date.UTC(2025, 0, 1 + day) + withinDay * 270_000).toISOString(),
      thumbhash: bytes.toString('base64'),
    });
  }

  let timerFired = false;
  const timer = setTimeout(() => { timerFired = true; }, 0);
  const started = performance.now();
  const metrics = {};
  annotateBursts(rows, { metrics });
  const elapsedMs = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearTimeout(timer);

  assert.equal(metrics.boundedFallbackDays, 100);
  assert.ok(metrics.thumbhashComparisons <= THUMBHASH_COMPARISON_BUDGET);
  assert.equal(timerFired, true, 'the event loop resumes immediately after the bounded synchronous rebuild');
  assert.ok(elapsedMs < 1_500, `30k-row annotation took ${elapsedMs.toFixed(1)}ms`);
});

test('oversized or malformed thumbhash values are ignored before decode or comparison', () => {
  const atLimit = Buffer.alloc(THUMBHASH_MAX_BYTES, 42).toString('base64');
  const oversized = Buffer.alloc(THUMBHASH_MAX_BYTES + 1, 42).toString('base64');
  const rows = [
    { assetId: 'valid-a', capturedAt: '2026-07-01T01:00:00.000Z', thumbhash: atLimit },
    { assetId: 'valid-b', capturedAt: '2026-07-01T05:00:00.000Z', thumbhash: atLimit },
    { assetId: 'oversized-a', capturedAt: '2026-07-02T01:00:00.000Z', thumbhash: oversized },
    { assetId: 'oversized-b', capturedAt: '2026-07-02T05:00:00.000Z', thumbhash: oversized },
    { assetId: 'malformed-a', capturedAt: '2026-07-03T01:00:00.000Z', thumbhash: '@@@@' },
    { assetId: 'malformed-b', capturedAt: '2026-07-03T05:00:00.000Z', thumbhash: '@@@@' },
  ];

  const metrics = {};
  annotateBursts(rows, { metrics });

  assert.equal(rows[0].burstId, rows[1].burstId, 'the conservative valid envelope remains usable');
  assert.equal(rows[2].burstId, undefined);
  assert.equal(rows[3].burstId, undefined);
  assert.equal(rows[4].burstId, undefined);
  assert.equal(rows[5].burstId, undefined);
  assert.equal(metrics.thumbhashComparisons, 1, 'only the valid pair reaches the distance function');
});

test('burst best pick follows frame score with aesthetic tiebreak', () => {
  const rows = [
    { assetId: 'b1', capturedAt: '2026-07-01T10:00:00.000Z', frameScore: 0.7, aestheticScore: 0.9 },
    { assetId: 'b2', capturedAt: '2026-07-01T10:00:05.000Z', frameScore: 0.9, aestheticScore: 0.5 },
    { assetId: 'b3', capturedAt: '2026-07-01T10:00:10.000Z', frameScore: 0.9, aestheticScore: 0.8 },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstBestAssetId, 'b3'); // ties on frame score → higher aesthetic wins
  assert.ok(rows.every((row) => row.burstBestAssetId === 'b3'));
});

test('burst with no scores suggests no best pick', () => {
  const rows = [
    { assetId: 'u1', capturedAt: '2026-07-01T10:00:00.000Z', frameScore: null, aestheticScore: null },
    { assetId: 'u2', capturedAt: '2026-07-01T10:00:05.000Z', frameScore: null, aestheticScore: null },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, 2);
  assert.equal(rows[0].burstBestAssetId, null);
});

test('chunkByLargestGap splits oversized runs at their largest time gaps', () => {
  // 12 nodes 10s apart, except a 40s seam after the 7th: the split lands there.
  const nodes = [];
  let time = 0;
  for (let i = 0; i < 12; i++) {
    nodes.push({ id: i, time });
    time += i === 6 ? 40000 : 10000;
  }
  const chunks = chunkByLargestGap(nodes, 10);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [7, 5]);
  assert.equal(chunks[0].at(-1).id, 6);
});

test('chunkByLargestGap keeps groups at the cap whole and halves untimed groups', () => {
  const small = Array.from({ length: 10 }, (_, i) => ({ time: i * 1000 }));
  assert.equal(chunkByLargestGap(small, 10).length, 1);
  // No usable gap (e.g. an Immich duplicate group without timestamps): halve.
  const untimed = Array.from({ length: 12 }, () => ({ time: NaN }));
  assert.deepEqual(chunkByLargestGap(untimed, 10).map((chunk) => chunk.length), [6, 6]);
});

test('uniform runs halve instead of peeling singles off the front', () => {
  // Same-timestamp import batch: every gap is 0 — must not shed 1-photo
  // chunks one at a time.
  const sameStamp = Array.from({ length: 12 }, () => ({ time: 1000 }));
  assert.deepEqual(chunkByLargestGap(sameStamp, 10).map((chunk) => chunk.length), [6, 6]);
  // Fixed-interval sequence (timelapse): equal gaps throughout.
  const interval = Array.from({ length: 50 }, (_, i) => ({ id: i, time: i * 10000 }));
  const chunks = chunkByLargestGap(interval, 10);
  assert.ok(chunks.every((chunk) => chunk.length <= 10));
  assert.ok(chunks.every((chunk) => chunk.length >= 3), `no peeled slivers: ${chunks.map((c) => c.length)}`);
  // Capture order is preserved across chunks.
  assert.deepEqual(chunks.flat().map((node) => node.id), interval.map((node) => node.id));
});

test('chunkByLargestGap survives huge chained runs without overflowing the stack', () => {
  // A timelapse folder chains into ONE union group; the recursive version
  // blew the call stack at ~10k members.
  const huge = Array.from({ length: 20000 }, (_, i) => ({ time: i * 10000 }));
  const chunks = chunkByLargestGap(huge, 10);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), 20000);
  assert.ok(chunks.every((chunk) => chunk.length <= 10));
});

test('an oversized moment splits into stacks at its largest gap (stack cap)', () => {
  // 12 photos chain into one union group (every gap inside the tight window),
  // with the biggest gap — 14s — after the 7th photo.
  const rows = [];
  let time = Date.parse('2026-07-01T10:00:00.000Z');
  for (let i = 0; i < 12; i++) {
    rows.push({ assetId: `c${i}`, capturedAt: new Date(time).toISOString() });
    time += i === 6 ? 14000 : 10000;
  }
  annotateBursts(rows);
  assert.equal(new Set(rows.map((row) => row.burstId)).size, 2);
  assert.equal(rows[0].burstSize, 7);
  assert.deepEqual(rows[0].burstAssetIds, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.equal(rows[7].burstSize, 5);
});

test('a moment at exactly the stack cap stays one stack', () => {
  const rows = [];
  let time = Date.parse('2026-07-01T10:00:00.000Z');
  for (let i = 0; i < MAX_STACK_MEMBERS; i++) {
    rows.push({ assetId: `m${i}`, capturedAt: new Date(time).toISOString() });
    time += 10000;
  }
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, MAX_STACK_MEMBERS);
  assert.ok(rows.every((row) => row.burstId === rows[0].burstId));
});

test('a 1-photo chunk after splitting renders as a single, not a stack', () => {
  // 11 photos, biggest gap right before the last one: 10 + 1.
  const rows = [];
  let time = Date.parse('2026-07-01T10:00:00.000Z');
  for (let i = 0; i < 11; i++) {
    rows.push({ assetId: `s${i}`, capturedAt: new Date(time).toISOString() });
    time += i === 9 ? 14000 : 10000;
  }
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, 10);
  assert.equal(rows[10].burstId, undefined);
});

test('stack identity derives from membership, not annotation order', () => {
  // While an enrichment run streams photos in, groups regrow and re-chunk on
  // every arrival. The client holds rows from several regenerations at once,
  // so ids must never collide across them: the same photos always mint the
  // same id, and any membership change mints a fresh one.
  const makeRows = (ids) =>
    ids.map((id, i) => ({
      assetId: id,
      capturedAt: new Date(Date.parse('2026-07-01T10:00:00.000Z') + i * 10000).toISOString(),
    }));
  const six = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'];
  const first = makeRows(six);
  annotateBursts(first);
  const second = makeRows(six);
  second.push({ assetId: 'x-unrelated', capturedAt: '2026-07-02T10:00:00.000Z' });
  annotateBursts(second);
  assert.equal(second[0].burstId, first[0].burstId, 'same membership → same id, whatever else is present');
  const grown = makeRows([...six, 'p6']);
  annotateBursts(grown);
  assert.notEqual(grown[0].burstId, first[0].burstId, 'changed membership → new id');
});

test('member filenames ride the annotation for compare-view stubs', () => {
  const rows = [
    { assetId: 'f0', filename: 'IMG_1.JPG', capturedAt: '2026-07-01T10:00:00.000Z' },
    { assetId: 'f1', filename: 'IMG_2.JPG', capturedAt: '2026-07-01T10:00:05.000Z' },
  ];
  annotateBursts(rows);
  assert.deepEqual(rows[0].burstMemberFiles, { f0: 'IMG_1.JPG', f1: 'IMG_2.JPG' });
  assert.deepEqual(rows[1].burstMemberFiles, rows[0].burstMemberFiles);
});

function hash(bytes) {
  return Buffer.from(bytes).toString('base64');
}
const BASE_HASH = Array.from({ length: 25 }, (_, i) => 100 + i);

test('near-identical thumbhashes merge beyond the time gap on the same day', () => {
  const near = [...BASE_HASH];
  near[5] += 40; // 40/(25*255) ≈ 0.006 — well under the near-dup threshold
  const rows = [
    { assetId: 't1', capturedAt: '2026-07-01T10:00:00.000Z', thumbhash: hash(BASE_HASH) },
    { assetId: 't2', capturedAt: '2026-07-01T11:45:00.000Z', thumbhash: hash(near) }, // 105 min later
    { assetId: 'other', capturedAt: '2026-07-01T12:30:00.000Z', thumbhash: hash(BASE_HASH.map((b) => 255 - b)) },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, 2);
  assert.deepEqual(rows[0].burstAssetIds, ['t1', 't2']);
  assert.equal(rows[2].burstSize, undefined);
});

test('identical thumbhashes on different days stay separate', () => {
  const rows = [
    { assetId: 'd1', capturedAt: '2026-07-01T10:00:00.000Z', thumbhash: hash(BASE_HASH) },
    { assetId: 'd2', capturedAt: '2026-07-02T10:00:00.000Z', thumbhash: hash(BASE_HASH) },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, undefined);
  assert.equal(rows[1].burstSize, undefined);
});

test('different-length thumbhashes (different aspect ratios) never merge', () => {
  const rows = [
    { assetId: 'l1', capturedAt: '2026-07-01T10:00:00.000Z', thumbhash: hash(BASE_HASH) },
    { assetId: 'l2', capturedAt: '2026-07-01T10:30:00.000Z', thumbhash: hash(BASE_HASH.slice(0, 20)) },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, undefined);
});

test('shared Immich duplicateId merges regardless of time, even untimed', () => {
  const rows = [
    { assetId: 'p1', capturedAt: '2026-07-01T10:00:00.000Z', duplicateId: 'dup-1' },
    { assetId: 'p2', capturedAt: '2026-09-15T10:00:00.000Z', duplicateId: 'dup-1' },
    { assetId: 'p3', capturedAt: null, duplicateId: 'dup-1' },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, 3);
  assert.deepEqual(rows[0].burstAssetIds, ['p1', 'p2', 'p3']); // untimed sorts last
});

test('time chains and thumbhash edges union into one group', () => {
  const rows = [
    { assetId: 'u1', capturedAt: '2026-07-01T10:00:00.000Z', frameScore: 0.5 },
    { assetId: 'u2', capturedAt: '2026-07-01T10:00:10.000Z', frameScore: 0.9, thumbhash: hash(BASE_HASH) },
    { assetId: 'u3', capturedAt: '2026-07-01T15:00:00.000Z', frameScore: 0.7, thumbhash: hash(BASE_HASH) },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstSize, 3); // u1—u2 by time, u2—u3 by thumbhash
  assert.equal(rows[0].burstBestAssetId, 'u2');
});

test('thumbhashDistance is normalized and guards nulls', () => {
  const a = Uint8Array.from(BASE_HASH);
  const same = Uint8Array.from(BASE_HASH);
  const far = Uint8Array.from(new Array(25).fill(255));
  assert.equal(thumbhashDistance(a, same), 0);
  assert.ok(thumbhashDistance(a, far) > 0.5);
  assert.equal(thumbhashDistance(a, null), 1);
  assert.equal(thumbhashDistance(a, Uint8Array.from([1, 2])), 1);
});

test('a referee verdict outranks per-photo scores for the burst star', () => {
  const rows = [
    { assetId: 'v1', capturedAt: '2026-07-01T10:00:00.000Z', frameScore: 0.95, refereeRank: 2 },
    { assetId: 'v2', capturedAt: '2026-07-01T10:00:05.000Z', frameScore: 0.7, refereeRank: 1 },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstBestAssetId, 'v2'); // referee's #1 beats the higher score
  assert.equal(rows[0].burstPickSource, 'referee');
});

test('referee subject groups split one moment into per-subject stacks', () => {
  const t = (sec) => `2026-07-01T10:00:${String(sec).padStart(2, '0')}.000Z`;
  const rows = [
    { assetId: 'p1', capturedAt: t(0), frameScore: 0.9, refereeRank: 2, refereeSubjectGroup: 1 },
    { assetId: 'p2', capturedAt: t(2), frameScore: 0.8, refereeRank: 1, refereeSubjectGroup: 1 },
    { assetId: 'l1', capturedAt: t(4), frameScore: 0.95, refereeRank: 3, refereeSubjectGroup: 2 },
    { assetId: 'l2', capturedAt: t(6), frameScore: 0.7, refereeRank: 4, refereeSubjectGroup: 2 },
  ];
  annotateBursts(rows);
  const people = rows.filter((r) => ['p1', 'p2'].includes(r.assetId));
  const scenery = rows.filter((r) => ['l1', 'l2'].includes(r.assetId));
  assert.equal(people[0].burstId, people[1].burstId);
  assert.equal(scenery[0].burstId, scenery[1].burstId);
  assert.notEqual(people[0].burstId, scenery[0].burstId); // two stacks now
  assert.equal(people[0].burstSize, 2);
  assert.equal(people[0].burstBestAssetId, 'p2'); // best rank within the subject
  assert.equal(scenery[0].burstBestAssetId, 'l1');
  assert.equal(scenery[0].burstPickSource, 'referee');
});

test('a lone photo in its own subject group leaves the stack entirely', () => {
  const t = (sec) => `2026-07-01T10:00:${String(sec).padStart(2, '0')}.000Z`;
  const rows = [
    { assetId: 'a', capturedAt: t(0), frameScore: 0.9, refereeRank: 1, refereeSubjectGroup: 1 },
    { assetId: 'b', capturedAt: t(2), frameScore: 0.8, refereeRank: 2, refereeSubjectGroup: 1 },
    { assetId: 'solo', capturedAt: t(4), frameScore: 0.5, refereeRank: 3, refereeSubjectGroup: 2 },
  ];
  annotateBursts(rows);
  assert.equal(rows.find((r) => r.assetId === 'solo').burstId, undefined);
  assert.equal(rows.find((r) => r.assetId === 'a').burstSize, 2);
});

test('a group with unjudged members never splits (verdict pending)', () => {
  const t = (sec) => `2026-07-01T10:00:${String(sec).padStart(2, '0')}.000Z`;
  const rows = [
    { assetId: 'a', capturedAt: t(0), frameScore: 0.9, refereeRank: 1, refereeSubjectGroup: 1 },
    { assetId: 'b', capturedAt: t(2), frameScore: 0.8, refereeRank: 2, refereeSubjectGroup: 2 },
    { assetId: 'new', capturedAt: t(4), frameScore: 0.7 }, // no verdict yet
  ];
  annotateBursts(rows);
  assert.equal(new Set(rows.map((r) => r.burstId)).size, 1); // one stack of 3
  assert.equal(rows[0].burstSize, 3);
});

test('v1 verdicts (no subject groups) render as one stack', () => {
  const t = (sec) => `2026-07-01T10:00:${String(sec).padStart(2, '0')}.000Z`;
  const rows = [
    { assetId: 'a', capturedAt: t(0), frameScore: 0.9, refereeRank: 1, refereeSubjectGroup: null },
    { assetId: 'b', capturedAt: t(2), frameScore: 0.8, refereeRank: 2, refereeSubjectGroup: null },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstId, rows[1].burstId);
  assert.equal(rows[0].burstSize, 2);
});

test('score-based stars carry the silver source label', () => {
  const rows = [
    { assetId: 's1', capturedAt: '2026-07-01T10:00:00.000Z', frameScore: 0.9 },
    { assetId: 's2', capturedAt: '2026-07-01T10:00:05.000Z', frameScore: 0.7 },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstPickSource, 'score');
});

test('burst best pick skips unscored members but still suggests a scored one', () => {
  const rows = [
    { assetId: 'm1', capturedAt: '2026-07-01T10:00:00.000Z', frameScore: null, aestheticScore: null },
    { assetId: 'm2', capturedAt: '2026-07-01T10:00:05.000Z', frameScore: 0.4, aestheticScore: 0.4 },
  ];
  annotateBursts(rows);
  assert.equal(rows[0].burstBestAssetId, 'm2');
});

test('a group never straddles a page: members cluster and the page completes the group', async () => {
  await withService(async ({ repo, service }) => {
    // A burst whose members sort far apart within the bucket (0.95 leads,
    // 0.80 trails), with solo photos ranking in between.
    seedAsset(repo, 'burst-hi', { frameScore: 0.95, capturedAt: '2026-07-01T10:00:00.000Z' });
    seedAsset(repo, 'burst-lo', { frameScore: 0.8, capturedAt: '2026-07-01T10:00:10.000Z' });
    seedAsset(repo, 'solo-1', { frameScore: 0.9 });
    seedAsset(repo, 'solo-2', { frameScore: 0.85 });

    // Members sit together at the best member's rank despite the score gap.
    const all = service.assetsResponse(new URLSearchParams({ view: 'candidates', limit: '10' }));
    const ids = all.assets.map((asset) => asset.assetId);
    assert.ok(ids.includes('burst-hi') && ids.includes('burst-lo'), `both members in view: ${ids}`);
    assert.equal(Math.abs(ids.indexOf('burst-hi') - ids.indexOf('burst-lo')), 1);

    // A page boundary inside the group extends the page to finish it.
    const page = service.assetsResponse(new URLSearchParams({ view: 'candidates', limit: '1' }));
    assert.deepEqual(page.assets.map((asset) => asset.assetId).sort(), ['burst-hi', 'burst-lo']);
    assert.equal(page.total, 4);

    // The next page starts after the whole group — no duplicates.
    const next = service.assetsResponse(new URLSearchParams({ view: 'candidates', limit: '1', offset: '2' }));
    assert.equal(next.assets.length, 1);
    assert.ok(!next.assets.some((asset) => asset.burstId));
  });
});

test('group filter serves stacks-only or singles-only passes', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, 'g-burst-1', { frameScore: 0.9, capturedAt: '2026-07-01T10:00:00.000Z' });
    seedAsset(repo, 'g-burst-2', { frameScore: 0.8, capturedAt: '2026-07-01T10:00:05.000Z' });
    seedAsset(repo, 'g-solo', { frameScore: 0.85, capturedAt: '2026-07-01T14:00:00.000Z' });

    const stacks = service.assetsResponse(new URLSearchParams({ view: 'candidates', group: 'stacks' }));
    assert.deepEqual(stacks.assets.map((a) => a.assetId).sort(), ['g-burst-1', 'g-burst-2']);
    assert.equal(stacks.total, 2);
    assert.ok(stacks.assets.every((a) => a.burstId));

    const singles = service.assetsResponse(new URLSearchParams({ view: 'candidates', group: 'singles' }));
    assert.deepEqual(singles.assets.map((a) => a.assetId), ['g-solo']);
    assert.equal(singles.total, 1);

    const all = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    assert.equal(all.total, 3);
  });
});

test('burst grouping off serves a flat queue: no stacks, plain pagination', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, 'flat-1', { frameScore: 0.95, capturedAt: '2026-07-01T10:00:00.000Z' });
    seedAsset(repo, 'flat-2', { frameScore: 0.8, capturedAt: '2026-07-01T10:00:05.000Z' });

    const all = service.assetsResponse(new URLSearchParams({ view: 'candidates', limit: '10' }));
    assert.ok(all.assets.every((asset) => asset.burstId === undefined));

    // Without groups a limit-1 page stays one photo — nothing to complete.
    const page = service.assetsResponse(new URLSearchParams({ view: 'candidates', limit: '1' }));
    assert.equal(page.assets.length, 1);
  }, { config: { curateBurstGrouping: false } });
});

test('unknown actions and empty selections are rejected', async () => {
  await withService(({ service }) => {
    assert.throws(() => service.applyDecision({ action: 'nuke', assetIds: [DECISION_ID] }), /Unsupported action/);
    assert.throws(() => service.applyDecision({ action: 'approve', assetIds: [] }), /non-empty asset id array/);
  });
});

test('decisions reject malformed, oversized, and stale review batches before writing', async () => {
  await withService(({ repo, service }) => {
    seedAsset(repo, DECISION_ID);
    assert.throws(
      () => service.applyDecision({ action: 'approve', assetIds: [' not-a-uuid '] }),
      /canonical lowercase UUID/,
    );
    assert.throws(
      () => service.applyDecision({ action: 'approve', assetIds: Array(1001).fill(DECISION_ID) }),
      /At most 1000/,
    );
    assert.throws(
      () => service.applyDecision({ action: 'approve', assetIds: ['00000000-0000-0000-0000-000000000002'] }),
      /current review set/,
    );
    assert.equal(repo.pendingSyncJobCount(), 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM manual_overrides').get().count, 0);
  });
});

test('deciding a middle photo cannot mint a stack the full timeline does not contain', async () => {
  await withService(async ({ repo, service }) => {
    // Regression geometry: two similar landscape shots 142s apart
    // with a dissimilar shot between them. Nothing chains in the full
    // timeline — 15s–180s adjacency requires each ADJACENT pair to look
    // alike, and the middle photo matches neither neighbor.
    const similar = [...BASE_HASH];
    similar[3] -= 90;
    similar[9] -= 90;
    similar[15] -= 90; // ≈0.042 — similar scene, but not a near-dup (>0.025)
    seedAsset(repo, 'pair-a', { capturedAt: '2026-07-01T10:41:05.000Z', thumbhash: hash(BASE_HASH) });
    seedAsset(repo, 'mid', { capturedAt: '2026-07-01T10:41:55.000Z', thumbhash: hash(BASE_HASH.map((b) => 255 - b)) });
    seedAsset(repo, 'pair-b', { capturedAt: '2026-07-01T10:43:27.000Z', thumbhash: hash(similar) });

    const before = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    assert.equal(before.assets.length, 3);
    assert.ok(before.assets.every((asset) => asset.burstId === undefined), 'no stack exists in the full timeline');

    // Deciding the dissimilar middle photo removes it from the Candidates
    // view. Under filtered-view grouping the two survivors became adjacent
    // and chained into a phantom stack the referee could never see; full-set
    // grouping keeps stack identity decision-independent.
    repo.setManualFrameTags({ assetIds: ['mid'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    const after = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    assert.deepEqual(after.assets.map((asset) => asset.assetId).sort(), ['pair-a', 'pair-b']);
    assert.ok(after.assets.every((asset) => asset.burstId === undefined), 'a decision must not reshape stack identity');
  });
});

test('a partially decided stack keeps its context and its remnant reviews like a single', async () => {
  await withService(async ({ repo, service }) => {
    seedAsset(repo, 'twin-1', { frameScore: 0.9, capturedAt: '2026-07-01T10:00:00.000Z' });
    seedAsset(repo, 'twin-2', { frameScore: 0.85, capturedAt: '2026-07-01T10:00:05.000Z' });
    seedAsset(repo, 'lone', { frameScore: 0.8, capturedAt: '2026-07-02T09:00:00.000Z' });
    seedAsset(repo, 'duo-1', { frameScore: 0.9, capturedAt: '2026-07-03T09:00:00.000Z' });
    seedAsset(repo, 'duo-2', { frameScore: 0.82, capturedAt: '2026-07-03T09:00:05.000Z' });
    repo.setManualFrameTags({ assetIds: ['twin-1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });

    // Stack identity is decision-independent: the remnant still knows its
    // moment, decided member included, so the UI can say "part of a stack
    // whose other photos are already decided".
    const response = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    const remnant = response.assets.find((asset) => asset.assetId === 'twin-2');
    assert.equal(remnant.burstSize, 2);
    assert.deepEqual(remnant.burstAssetIds, ['twin-1', 'twin-2']);

    // The stacks/singles review rhythm counts members IN VIEW: a lone
    // remnant has nothing on-screen to compare against, so it reviews as a
    // single, while a fully visible pair stays in the stacks pass.
    const stacks = service.assetsResponse(new URLSearchParams({ view: 'candidates', group: 'stacks' }));
    assert.deepEqual(stacks.assets.map((asset) => asset.assetId).sort(), ['duo-1', 'duo-2']);
    const singles = service.assetsResponse(new URLSearchParams({ view: 'candidates', group: 'singles' }));
    assert.deepEqual(singles.assets.map((asset) => asset.assetId).sort(), ['lone', 'twin-2']);
  });
});

test('a stack hoists to the highest bucket any undecided member earned', async () => {
  await withService(async ({ repo, service }) => {
    // One tight moment: a candidate-grade shot and an excluded screenshot
    // that would land in Unlikely on its own.
    seedAsset(repo, 'hoist-good', { frameScore: 0.9, capturedAt: '2026-07-01T10:00:00.000Z' });
    seedAsset(repo, 'hoist-bad', {
      frameScore: 0.2,
      capturedAt: '2026-07-01T10:00:05.000Z',
      decisions: [{ tag: 'ai/exclude/screenshot', confidence: 0.95, source: 'ai', reason: 'ui' }],
    });

    const cands = service.assetsResponse(new URLSearchParams({ view: 'candidates' }));
    assert.deepEqual(cands.assets.map((asset) => asset.assetId).sort(), ['hoist-bad', 'hoist-good']);
    const counts = Object.fromEntries(cands.buckets.map((bucket) => [bucket.id, bucket.count]));
    assert.equal(counts.candidates, 2, 'the whole moment counts under Candidates');
    assert.equal(counts.unlikely, 0);
    const unlikely = service.assetsResponse(new URLSearchParams({ view: 'unlikely' }));
    assert.deepEqual(unlikely.assets, [], 'a hoisted member must not also appear in its own bucket');
    // Placement hoists; the member keeps its own bucket facts and reasons.
    assert.equal(cands.assets.find((asset) => asset.assetId === 'hoist-bad').bucket, 'unlikely');

    // Deciding the candidate returns the leftover to its own bucket, and
    // its member states carry the sibling's outcome for the remnant UI.
    repo.setManualFrameTags({ assetIds: ['hoist-good'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    const after = service.assetsResponse(new URLSearchParams({ view: 'unlikely' }));
    assert.deepEqual(after.assets.map((asset) => asset.assetId), ['hoist-bad']);
    assert.deepEqual(after.assets[0].burstMemberStates, { 'hoist-good': 'approved', 'hoist-bad': 'undecided' });
  });
});
