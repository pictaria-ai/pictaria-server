import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Repository } from '../../src/enrich/repository.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { runBatch } from '../../src/enrich/runner.mjs';
import { loadTaxonomy } from '../../src/enrich/taxonomy.mjs';
import { EMBEDDING_LIMITS, EmbeddingService } from '../../src/embeddings/service.mjs';
import { startFakeMl } from '../embeddings/fakeMl.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();
const baseOptions = { taxonomy, systemPrompt: 'system', userTemplate: 'Approved tags:\n{approved_tags}', promptVersion: 'v1' };

function fakeImmich(assets, downloads = []) {
  return {
    async listImageAssets() { return assets; },
    async getAsset(assetId) { return assets.find((asset) => asset.id === assetId) ?? { id: assetId }; },
    async getAssetThumbnail(assetId, size) {
      downloads.push(`${size}:${assetId}`);
      return { data: Buffer.from(`${size}-${assetId}`), contentType: 'image/jpeg' };
    },
    async getAssetOriginal(assetId) {
      downloads.push(`original:${assetId}`);
      return { data: Buffer.from(`original-${assetId}`), contentType: 'image/jpeg' };
    },
  };
}

function fakeProvider({ fail = new Set() } = {}) {
  const seen = [];
  return {
    providerName: 'cloud_openai', modelName: 'test-model', seen,
    async analyzeImage(image) {
      seen.push(image.data.toString());
      if (fail.has(image.assetId)) {
        throw Object.assign(new Error('provider rejected this photo'), { name: 'ProviderRequestError', status: 400 });
      }
      return { rawOutput: {}, normalizedOutput: sampleOutput() };
    },
  };
}

async function withEnvironment(work, { url = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-enrich-embeddings-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const ml = await startFakeMl();
  const service = new EmbeddingService({ repo, config: { enrichEmbeddings: { enabled: true, url: url ?? ml.url, model: 'ViT-B-32__openai' } },
    limits: { ...EMBEDDING_LIMITS, calibrationWaitMs: 1_000, settleMs: 1_000 } });
  try { await work({ repo, ml, service }); } finally { await ml.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function enrich({ repo, service, assets, imageSource = 'preview', provider = fakeProvider(), downloads = [] }) {
  const log = [];
  const embeddings = service.session({ log: (message) => log.push(message) });
  await embeddings.start();
  try {
    const result = await runBatch({ ...baseOptions, immich: fakeImmich(assets, downloads), repo, provider, limit: assets.length,
      imageSource, embeddings, log: (message) => log.push(message) });
    return { ...result, log };
  } finally { await embeddings.close(); }
}

const vectorCount = (repo) => repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n;

test('Enrich embeds the preview it already downloaded, alongside the vision call', async () => {
  await withEnvironment(async ({ repo, ml, service }) => {
    const downloads = [], provider = fakeProvider();
    const assets = [{ id: 'a1', checksum: 's1', thumbhash: 'h1' }, { id: 'a2', checksum: 's2', thumbhash: 'h2' }];
    const { counters, log } = await enrich({ repo, service, assets, provider, downloads });
    assert.equal(counters.succeeded, 2);
    assert.deepEqual(downloads, ['preview:a1', 'preview:a2'], 'no second download for the embedding');
    assert.deepEqual(provider.seen, ['preview-a1', 'preview-a2']);
    const embedded = ml.state.requests.slice(1).map((request) => request.bytes);
    assert.deepEqual(embedded, [Buffer.from('preview-a1').length, Buffer.from('preview-a2').length]);
    assert.equal(vectorCount(repo), 2);
    assert.deepEqual(repo.db.prepare('SELECT source_checksum, source_thumbhash FROM asset_embeddings ORDER BY asset_id').all()
      .map((row) => ({ ...row })), [{ source_checksum: 's1', source_thumbhash: 'h1' }, { source_checksum: 's2', source_thumbhash: 'h2' }]);
    assert.match(log.join('\n'), /image embeddings: 2 new, 0 already current, 0 skipped, 0 failed/);
    // Timing records only the photo's enrichment; the embedding wait is outside it.
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM enrich_photo_executions').get().n, 2);
  });
});

test('a failed vision call keeps its vector; other renditions embed a separately fetched preview', async () => {
  await withEnvironment(async ({ repo, service }) => {
    const downloads = [];
    const assets = [{ id: 'a1', checksum: 's1', thumbhash: 'h1' }, { id: 'a2', checksum: 's2', thumbhash: 'h2' }];
    const { counters } = await enrich({ repo, service, assets, imageSource: 'original', downloads,
      provider: fakeProvider({ fail: new Set(['a2']) }) });
    assert.equal(counters.succeeded, 1);
    assert.equal(counters.failed, 1);
    assert.deepEqual(downloads, ['original:a1', 'preview:a1', 'original:a2', 'preview:a2']);
    assert.equal(vectorCount(repo), 2);
    assert.equal(repo.db.prepare("SELECT status FROM processing_runs WHERE asset_id='a2'").get().status, 'failed');
  });
});

test('an unavailable machine-learning service never affects enrichment', async () => {
  await withEnvironment(async ({ repo, service }) => {
    const assets = [{ id: 'a1' }, { id: 'a2' }];
    const { counters, log } = await enrich({ repo, service, assets });
    assert.equal(counters.succeeded, 2);
    assert.equal(counters.failed, 0);
    assert.equal(vectorCount(repo), 0);
    assert.match(log.join('\n'), /image embeddings paused for this run/);
    assert.match(log.at(-1), /0 new, 0 already current, 2 skipped, 0 failed/);
  }, { url: 'http://127.0.0.1:9' });
});

test('the job runner opens one session per run and closes it before recording history', async () => {
  const events = [];
  const embeddings = {
    session: ({ log }) => ({
      start: async () => { events.push('start'); log('image embeddings: on (test-model)'); },
      embed: ({ assetId }) => { events.push(`embed:${assetId}`); return null; },
      settle: async () => {},
      close: async ({ cancelled }) => { events.push(`close:${cancelled}`); log('image embeddings: 0 new, 0 already current, 1 skipped, 0 failed'); },
    }),
  };
  const runs = [];
  const repo = {
    saveRunConfiguration() {}, upsertAsset() {}, hasAnySuccessfulRun: () => false, hasSuccessfulRun: () => false,
    failureCount: () => 0, isAssetDiscarded: () => false, recordProcessingRun() {}, recordJobRun(row) { runs.push(row); },
    reviewListAdd: () => 0, markAssetsMissing: () => 0,
  };
  const config = {
    promptsDir: fileURLToPath(new URL('../../prompts', import.meta.url)), promptVersion: 'v1',
    promptOverrides: { systemPrompt: '', userTemplate: '' }, defaultProvider: 'local_lmstudio', imageSource: 'preview',
    maxFailuresPerAsset: 2, providers: { local_lmstudio: { modelName: 'test-model', baseUrl: 'http://127.0.0.1:9', apiKey: 'lm-studio' } },
  };
  const runner = new EnrichJobRunner({
    repo, taxonomy: loadTaxonomy(fileURLToPath(new URL('../../taxonomy/v1.json', import.meta.url))), config, embeddings,
    immich: { getAsset: async (id) => ({ id }), getAssetThumbnail: async (id) => ({ data: Buffer.from(id), contentType: 'image/jpeg' }) },
  });
  runner.start({ assetIds: ['a1'], sendToCurate: false });
  for (let i = 0; i < 300 && runner.isRunning(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ['start', 'embed:a1', 'close:false']);
  assert.equal(runs.length, 1);
  const log = runner.status().log.join('\n');
  assert.match(log, /image embeddings: on \(test-model\)/);
  assert.match(log, /image embeddings: 0 new/);
  assert.equal(runner.status().liveCounters.failed, 1, 'embedding log lines are not counted as photo outcomes');
});
