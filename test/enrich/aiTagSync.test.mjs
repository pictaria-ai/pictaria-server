import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { ReviewService } from '../../src/enrich/reviewService.mjs';
import { AiTagSyncService } from '../../src/enrich/aiTagSync.mjs';
import { TagWriteCoordinator } from '../../src/enrich/tagWriteCoordinator.mjs';
import { ImmichApiError } from '../../src/immich.mjs';
import { runBatch } from '../../src/enrich/runner.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const taxonomy = loadV1Taxonomy();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

class Immich {
  tags = new Map();
  photos = new Map();
  calls = [];
  error = null;
  onWrite = null;
  dropRemoval = false;
  async getAsset(assetId) {
    this.calls.push(['get', assetId]);
    if (this.error) throw this.error;
    if (!this.photos.has(assetId)) throw new ImmichApiError('gone', 404);
    return { id: assetId, type: 'IMAGE', tags: [...this.photos.get(assetId)].map(value => ({ id: value, value })) };
  }
  async getAssetThumbnail() { return { data: Buffer.from('photo'), contentType: 'image/jpeg' }; }
  async listTags() { this.calls.push(['list']); return [...this.tags].map(([value]) => ({ id: value, value })); }
  async upsertTags(tags) { for (const tag of tags) this.tags.set(tag, tag); return tags.map(value => ({ id: value, value })); }
  async tagAssetsBulk({ assetIds, tagIds }) {
    this.calls.push(['add', assetIds, tagIds]);
    await this.onWrite?.();
    for (const assetId of assetIds) for (const tag of tagIds) this.photos.get(assetId).add(tag);
  }
  async untagAssets({ assetIds, tagId }) {
    this.calls.push(['remove', assetIds, tagId]);
    if (!this.dropRemoval) for (const assetId of assetIds) this.photos.get(assetId).delete(tagId);
  }
}

async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pic347-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  const immich = new Immich(); const config = { enrichEnabled: true };
  const tagWrites = new TagWriteCoordinator();
  const review = new ReviewService({ repo, immich, taxonomy, config, tagWrites, verifyDelayMs: 0 });
  const sync = new AiTagSyncService({ repo, immich, review, config, tagWrites }); sync.stopped = false;
  function seed(n, tags = ['ai/scene/mountains']) {
    const assetId = id(n); repo.upsertAsset({ id: assetId });
    if (!immich.photos.has(assetId)) immich.photos.set(assetId, new Set());
    const runId = repo.recordProcessingRun({ assetId, provider: 'test', model: 'test', promptVersion: 'v1', taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: sampleOutput() });
    repo.replaceAssetTags({ assetId, decisions: tags.map(tag => ({ tag, source: 'ai', confidence: 1, reason: 'test' })), model: 'test', taxonomyVersion: 'v1' });
    repo.aiTagSync.enqueue(assetId, runId); return assetId;
  }
  try { await work({ repo, immich, sync, review, config, tagWrites, seed, dir }); }
  finally { await sync.stop(); repo.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('AI sync reconciles stale tags, preserves frame and user tags, and makes no Curate decision', async () => {
  await fixture(async ({ repo, immich, sync, seed }) => {
    const assetId = seed(1); immich.photos.get(assetId).add('ai/scene/old'); immich.photos.get(assetId).add('frame/never-show'); immich.photos.get(assetId).add('holiday');
    await sync.tick();
    assert.deepEqual([...immich.photos.get(assetId)].sort(), ['ai/scene/mountains', 'frame/never-show', 'holiday']);
    assert.equal(repo.aiTagSync.status().written, 1);
    assert.equal(repo.pendingSyncJobCount(), 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM review_list').get().n, 0);
  });
});

test('unresolved tag IDs defer AI sync without removing tags and recover on retry', async () => {
  await fixture(async ({ repo, immich, sync, seed }) => {
    const assetId = seed(1);
    const originalTags = ['ai/scene/old', 'frame/favorite', 'holiday'];
    for (const tag of originalTags) immich.photos.get(assetId).add(tag);
    const upsert = immich.upsertTags.bind(immich);
    immich.upsertTags = async () => []; // Successful response, no IDs in the refresh either.
    await sync.tick();
    assert.deepEqual([...immich.photos.get(assetId)], originalTags);
    assert.equal(immich.calls.filter(([kind]) => kind === 'list').length, 2);
    assert.equal(repo.aiTagSync.status().pending, 1);
    assert.equal(repo.aiTagSync.status().written, 0);
    assert.match(repo.aiTagSync.status().lastError, /Unable to resolve Immich tag IDs/);
    assert.ok(repo.aiTagSync.status().retryAfter > Date.now());
    assert.equal(await sync.tick(), false);

    // Immich creates the tags but omits them from its successful upsert response.
    immich.upsertTags = async tags => { await upsert(tags); return []; };
    sync.retry();
    await sync.tick();
    assert.equal(repo.aiTagSync.status().written, 1);
    assert.equal(repo.aiTagSync.status().pending, 0);
    assert.deepEqual([...immich.photos.get(assetId)].sort(), ['ai/scene/mountains', 'frame/favorite', 'holiday']);
    assert.equal(repo.pendingSyncJobCount(), 0);
  });
});

test('new enrichment during an HTTP write survives stale completion and converges to latest tags', async () => {
  await fixture(async ({ immich, sync, seed, repo }) => {
    const assetId = seed(1); const entered = deferred(); const release = deferred();
    immich.onWrite = async () => { entered.resolve(); await release.promise; };
    const first = sync.tick(); await entered.promise;
    seed(1, ['ai/scene/water']); release.resolve(); await first;
    assert.equal(repo.aiTagSync.status().pending, 1);
    immich.onWrite = null; await sync.tick();
    assert.deepEqual([...immich.photos.get(assetId)], ['ai/scene/water']);
    assert.equal(repo.aiTagSync.status().written, 1);
  });
});

test('outage pauses only AI sync; Curate decisions can still be recorded and sent during backoff', async () => {
  await fixture(async ({ seed, immich, repo, sync, review }) => {
    for (let n = 1; n <= 30; n++) seed(n);
    immich.error = new ImmichApiError('permission unavailable', 403);
    await sync.tick();
    assert.equal(repo.aiTagSync.status().pending, 30); assert.equal(repo.aiTagSync.status().failed, 0);
    assert.equal(repo.pendingSyncJobCount(), 0);
    assert.equal(repo.db.prepare('SELECT SUM(attempts) n FROM ai_tag_sync').get().n, 0);
    repo.reviewListAdd([id(1)], 'test'); review.applyDecision({ action: 'favorite', assetIds: [id(1)] });
    immich.error = null; await review.pushDecisionToImmich(repo.nextSyncJob());
    assert.ok(immich.photos.get(id(1)).has('frame/favorite'));
    assert.equal(await sync.tick(), false); // still in AI backoff
    sync.retry(); await sync.tick(); assert.equal(repo.aiTagSync.status().written, 10);
  });
});

test('human work has priority between AI slices and never overlaps tag writes', async () => {
  const lock = new TagWriteCoordinator(); const entered = deferred(); const release = deferred(); const order = [];
  const first = lock.run(async () => { order.push('ai1'); entered.resolve(); await release.promise; order.push('ai1 done'); }, { priority: 0 });
  await entered.promise;
  const second = lock.run(() => { order.push('ai2'); }, { priority: 0 });
  const human = lock.run(() => { order.push('decision'); }, { priority: 2 });
  release.resolve(); await Promise.all([first, second, human]);
  assert.deepEqual(order, ['ai1', 'ai1 done', 'decision', 'ai2']);
});

test('deleted photo is skipped; disabled Enrich pauses and a slice is bounded', async () => {
  await fixture(async ({ seed, immich, sync, repo, config }) => {
    for (let n = 1; n <= 25; n++) seed(n);
    immich.photos.delete(id(1)); config.enrichEnabled = false;
    assert.equal(await sync.tick(), false); assert.equal(immich.calls.length, 0);
    config.enrichEnabled = true; await sync.tick();
    assert.equal(repo.aiTagSync.status().skipped, 1); assert.equal(repo.aiTagSync.status().written, 9); assert.equal(repo.aiTagSync.status().pending, 15);
    assert.equal(immich.calls.filter(c => c[0] === 'list').length, 1);
  });
});

test('a silently dropped removal is verified and never acknowledged as synced', async () => {
  await fixture(async ({ seed, immich, repo, sync }) => {
    const assetId = seed(1); immich.photos.get(assetId).add('ai/scene/old'); immich.dropRemoval = true;
    await sync.tick(); assert.equal(repo.aiTagSync.status().written, 0); assert.equal(repo.aiTagSync.status().pending, 1);
    assert.match(repo.aiTagSync.status().lastError, /Still present/);
    immich.dropRemoval = false; sync.retry(); await sync.tick();
    assert.equal(repo.aiTagSync.status().written, 1);
  });
});

test('pending work and backoff survive database reopen; stale failure cannot fail a newer generation', async () => {
  await fixture(async ({ seed, repo, dir }) => {
    seed(1); const old = repo.aiTagSync.next()[0]; seed(1, ['ai/scene/water']);
    repo.aiTagSync.failure(old, 'old failure'); repo.aiTagSync.mark(old, 'written');
    repo.aiTagSync.defer('temporary outage', Date.now() + 30000);
    const reopened = new Repository(join(dir, 'enrichment.sqlite')); reopened.initSchema();
    try {
      assert.equal(reopened.aiTagSync.status().pending, 1); assert.equal(reopened.aiTagSync.next()[0].attempts, 0);
      assert.match(reopened.aiTagSync.status().lastError, /temporary outage/);
    } finally { reopened.close(); }
  });
});

for (const listForReview of [false, true]) test(`each successful photo queues tags before the batch ends (Send to Curate ${listForReview})`, async () => {
  await fixture(async ({ repo, immich, sync }) => {
    for (const n of [1, 2]) immich.photos.set(id(n), new Set());
    const entered = deferred(); const release = deferred(); let calls = 0;
    const provider = { providerName: 'local_lmstudio', modelName: 'test', async analyzeImage() {
      if (++calls === 2) { entered.resolve(); await release.promise; }
      return { normalizedOutput: sampleOutput() };
    } };
    const running = runBatch({ immich, repo, provider, taxonomy, systemPrompt: 'test', userTemplate: '{approved_tags}',
      assetIds: [id(1), id(2)], limit: 2, syncAiTags: true, listForReview });
    await entered.promise;
    try {
      assert.equal(repo.aiTagSync.status().pending, 1);
      await sync.tick(); assert.ok(immich.photos.get(id(1)).has('ai/scene/mountains'));
      assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM review_list').get().n, listForReview ? 1 : 0);
    } finally { release.resolve(); }
    const result = await running; assert.equal(result.counters.succeeded, 2); assert.equal(repo.aiTagSync.status().pending, 1);
  });
});

test('curating the same photo during AI write preserves the decision and completes both operations', async () => {
  await fixture(async ({ seed, repo, immich, sync, review }) => {
    const assetId = seed(1); repo.reviewListAdd([assetId], 'test');
    const entered = deferred(); const release = deferred();
    immich.onWrite = async () => { entered.resolve(); await release.promise; };
    const ai = sync.tick(); await entered.promise;
    review.applyDecision({ action: 'reject', assetIds: [assetId] });
    const decision = review.pushDecisionToImmich(repo.nextSyncJob());
    release.resolve(); await Promise.all([ai, decision]);
    assert.ok(immich.photos.get(assetId).has('frame/never-show'));
    assert.ok(!immich.photos.get(assetId).has('frame/eligible'));
    assert.ok(immich.photos.get(assetId).has('ai/scene/mountains'));
    assert.equal(repo.aiTagSync.status().written, 1);
  });
});

test('a persistently inconsistent photo is parked without failing successfully verified neighbors', async () => {
  await fixture(async ({ seed, repo, immich, sync }) => {
    const bad = seed(1); seed(2); immich.photos.get(bad).add('ai/scene/old'); immich.dropRemoval = true;
    for (let n = 0; n < 5; n++) { repo.aiTagSync.defer(null, 0); await sync.tick(); }
    assert.equal(repo.aiTagSync.status().failed, 1); assert.equal(repo.aiTagSync.status().written, 1);
    immich.dropRemoval = false; assert.equal(sync.retry(), 1); await sync.tick();
    assert.equal(repo.aiTagSync.status().written, 2);
  });
});
