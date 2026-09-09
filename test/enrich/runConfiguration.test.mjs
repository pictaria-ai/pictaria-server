import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import { ImmichClient } from '../../src/immich.mjs';

import { Repository } from '../../src/enrich/repository.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { createProvider } from '../../src/enrich/providers.mjs';
import { buildUserPrompt, captureClient, captureRunConfiguration, MAX_RUN_CONFIGURATION_BYTES } from '../../src/enrich/runConfiguration.mjs';
import { parseTaxonomySource, replaceTaxonomy } from '../../src/enrich/taxonomy.mjs';
import { deriveReview } from '../../src/enrich/reviewBuckets.mjs';
import { createEnrichRoutes } from '../../src/routes/enrich.mjs';
import { loadV1Taxonomy, sampleOutput, REPO_ROOT } from './helpers.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-config-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  return { repo, dir };
}

function snapshot(overrides = {}) {
  return captureRunConfiguration({
    provider: createProvider('local_lmstudio', { modelName: 'vision', apiKey: 'provider-secret' }),
    taxonomy: loadV1Taxonomy(), systemPrompt: 'System A', userTemplate: 'Tags:\n{approved_tags}',
    promptVersion: 'v1-custom', ...overrides,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeRunner(repo, analyze = () => sampleOutput()) {
  const calls = [];
  const config = {
    promptsDir: join(REPO_ROOT, 'prompts'), promptVersion: 'v1',
    promptOverrides: { systemPrompt: 'System A', userTemplate: 'Tags:\n{approved_tags}' },
    defaultProvider: 'local_lmstudio', imageSource: 'preview', maxFailuresPerAsset: 2,
    enrichEnabled: true, captionWriteback: false,
    providers: {
      local_lmstudio: {
        modelName: 'vision', baseUrl: 'http://model.test/v1', apiKey: 'provider-secret',
        fetchImpl: async (url, options) => {
          const body = JSON.parse(options.body);
          calls.push({ url, body });
          const output = await analyze(body, calls.length);
          return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });
        },
      },
    },
  };
  const downloads = [];
  const immich = {
    baseUrl: 'http://library-a.test', apiKey: 'library-secret',
    getAsset: async (id) => ({ id }),
    async getAssetThumbnail(id, size) {
      downloads.push({ baseUrl: this.baseUrl, apiKey: this.apiKey, id, size });
      return { data: Buffer.from('image'), contentType: 'image/jpeg' };
    },
    async searchMetadata() {
      return { assets: { items: [{ id: 'a1', type: 'IMAGE' }, { id: 'a2', type: 'IMAGE' }], nextPage: null } };
    },
  };
  const taxonomy = loadV1Taxonomy();
  const runner = new EnrichJobRunner({ repo, immich, taxonomy, config });
  return { runner, config, taxonomy, immich, calls, downloads };
}

function route(harness, repo) {
  return createEnrichRoutes({
    ...harness, enrichRunner: harness.runner, repo, requireImmich: () => true,
    review: {}, captionWriteback: {}, referee: null,
  });
}

async function request(handler, path, body = {}, method = 'POST') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  const out = {};
  await handler(req, {
    writeHead(status) { out.status = status; },
    end(value) { out.body = JSON.parse(value); },
  }, new URL(path, 'http://pictaria.test'));
  return out;
}

test('inference identity follows effective prompts, vocabulary, model settings, and image selection', () => {
  const original = snapshot();
  for (const change of [
    { systemPrompt: 'System B' },
    { userTemplate: 'Changed instructions:\n{approved_tags}' },
    { imageSource: 'original' },
    { provider: createProvider('local_lmstudio', { modelName: 'other' }) },
    { provider: createProvider('local_lmstudio', { modelName: 'vision', temperature: 0.2 }) },
    { provider: createProvider('local_lmstudio', { modelName: 'vision', maxTokens: 800 }) },
    { provider: createProvider('local_lmstudio', { modelName: 'vision', baseUrl: 'http://other.test/v1' }) },
  ]) assert.notEqual(snapshot(change).inferenceId, original.inferenceId);
  const raw = structuredClone(loadV1Taxonomy().raw);
  raw.categories.scene.push({ tag: 'ai/scene/new-scene' });
  assert.notEqual(snapshot({ taxonomy: parseTaxonomySource(JSON.stringify(raw)) }).inferenceId, original.inferenceId);
});

test('labels, JSON formatting/order, credentials, timeouts, and review policy do not invalidate inference', () => {
  const original = snapshot();
  const raw = structuredClone(loadV1Taxonomy().raw);
  raw.version = 'renamed';
  raw.thresholds.frame_worthy = 0.99;
  raw.hard_exclusion_tags = [];
  for (const entries of Object.values(raw.categories)) entries.reverse();
  const changed = snapshot({
    taxonomy: parseTaxonomySource(JSON.stringify(raw, null, 4)),
    promptVersion: 'renamed prompt', inferenceHostLabel: 'Another display label',
    provider: createProvider('local_lmstudio', { modelName: 'vision', apiKey: 'new-secret', timeoutMs: 1000 }),
    processing: { captionWriteback: true, maxFailuresPerAsset: 8 },
  });
  assert.equal(changed.inferenceId, original.inferenceId);
  assert.notEqual(changed.id, original.id, 'the complete audit snapshot still records policy and label changes');
  const encoded = JSON.stringify(changed.snapshot);
  assert.ok(!encoded.includes('new-secret'));
  assert.ok(!encoded.includes('apiKey'));
  assert.ok(Object.isFrozen(changed.snapshot.inference));
  const reordered = Object.fromEntries(Object.entries(loadV1Taxonomy().raw).reverse());
  assert.equal(snapshot({ taxonomy: parseTaxonomySource(JSON.stringify(reordered, null, 4)) }).id, original.id);
});

test('custom prompt edits with identical version labels become eligible only when Only unenriched is off', async (t) => {
  const { repo } = fixture(t);
  const { runner, config, calls } = makeRunner(repo);
  runner.start({ assetIds: ['a1'], skipAnySuccessful: false });
  await runner.runPromise;
  const first = repo.listJobRuns()[0];
  config.promptOverrides.systemPrompt = 'System B';
  runner.start({ assetIds: ['a1'], skipAnySuccessful: true });
  await runner.runPromise;
  assert.equal(calls.length, 1);
  runner.start({ assetIds: ['a1'], skipAnySuccessful: false });
  await runner.runPromise;
  const changed = repo.listJobRuns()[0];
  assert.equal(calls.length, 2);
  assert.equal(changed.promptVersion, first.promptVersion);
  assert.notEqual(changed.inferenceId, first.inferenceId);
  runner.start({ assetIds: ['a1'], skipAnySuccessful: false });
  await runner.runPromise;
  assert.equal(calls.length, 2, 'identical configurations still skip; no new force mode');
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM enrich_configurations').get().n, 3);
});

test('taxonomy, prompts, generation settings, and image source stay fixed through automatic retries and later photos', async (t) => {
  const { repo } = fixture(t);
  const entered = deferred();
  const resume = deferred();
  const h = makeRunner(repo, async (_, call) => {
    if (call === 1) { entered.resolve(); await resume.promise; return { invalid: true }; }
    return sampleOutput();
  });
  h.runner.start({ assetIds: ['a1', 'a2'], skipAnySuccessful: false });
  await entered.promise;
  const original = h.runner.status();
  const raw = structuredClone(h.taxonomy.raw);
  raw.version = 'changed-during-call';
  raw.categories.scene = raw.categories.scene.filter((entry) => (entry.tag ?? entry) !== 'ai/scene/mountains');
  replaceTaxonomy(h.taxonomy, parseTaxonomySource(JSON.stringify(raw)));
  h.config.promptOverrides.systemPrompt = 'System B';
  h.config.providers.local_lmstudio.modelName = 'different-model';
  h.config.providers.local_lmstudio.temperature = 0.8;
  h.config.imageSource = 'original';
  resume.resolve();
  await h.runner.runPromise;
  assert.equal(h.runner.status().counters.succeeded, 2);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(({ body }) => body.model === 'vision' && body.temperature === 0));
  assert.ok(h.calls.every(({ body }) => body.messages[0].content === 'System A'));
  assert.ok(h.downloads.every(({ size }) => size === 'preview'));
  const rows = repo.db.prepare('SELECT configuration_id, inference_id, taxonomy_version FROM processing_runs').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.configuration_id, original.configurationId);
    assert.equal(row.inference_id, original.inferenceId);
    assert.equal(row.taxonomy_version, 'v1.2');
  }
  assert.ok(repo.db.prepare('SELECT taxonomy_version FROM asset_tags').all().every((row) => row.taxonomy_version === 'v1.2'));
  const job = repo.listJobRuns()[0];
  assert.equal(job.configurationId, original.configurationId);
  assert.equal(job.taxonomyVersion, 'v1.2');
});

test('queue selection, covered-photo bookkeeping, and inference use the same captured configuration', async (t) => {
  const { repo } = fixture(t);
  const h = makeRunner(repo);
  h.runner.start({ assetIds: ['a1'], skipAnySuccessful: false });
  await h.runner.runPromise;
  const original = repo.listJobRuns()[0];
  const entered = deferred();
  const resume = deferred();
  const search = h.immich.searchMetadata;
  h.immich.searchMetadata = async () => { entered.resolve(); await resume.promise; return search(); };
  const queued = repo.queueAdd({ title: 'Test slice', filters: { city: 'Paris' } });
  const response = request(route(h, repo), `/api/enrich/queue/${queued.id}/run`, { skipAnySuccessful: false });
  await entered.promise;
  h.config.promptOverrides.systemPrompt = 'System B';
  h.config.maxFailuresPerAsset = 100;
  resume.resolve();
  const result = await response;
  assert.equal(result.status, 202, JSON.stringify(result.body));
  await h.runner.runPromise;
  assert.equal(h.calls.length, 2, 'a1 was covered; only a2 was analyzed from the queue');
  assert.equal(h.calls[1].body.messages[0].content, 'System A');
  assert.equal(repo.listJobRuns()[0].configurationId, original.configurationId);
  assert.equal(repo.queueGet(queued.id), null);
});

test('changing the Immich connection invalidates pending selection before any queue or Curate writes', async (t) => {
  const { repo } = fixture(t);
  const h = makeRunner(repo);
  const entered = deferred();
  const resume = deferred();
  const sources = [];
  h.immich.searchMetadata = async function () {
    entered.resolve(); await resume.promise;
    sources.push(this.baseUrl);
    return { assets: { items: [{ id: 'a1', type: 'IMAGE' }], nextPage: null } };
  };
  const queued = repo.queueAdd({ title: 'Test slice', filters: { city: 'Paris' } });
  const response = request(route(h, repo), `/api/enrich/queue/${queued.id}/run`);
  await entered.promise;
  h.runner.sourceChanged();
  h.immich.baseUrl = 'http://library-b.test';
  h.immich.apiKey = 'replacement-secret';
  resume.resolve();
  assert.equal((await response).status, 409);
  assert.deepEqual(sources, ['http://library-a.test']);
  assert.ok(repo.queueGet(queued.id));
  assert.equal(repo.listJobRuns().length, 0);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM review_list').get().n, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.runner.isBusy(), false);
});

test('history retry uses original provider with current configuration and persists its source-run link', async (t) => {
  const { repo } = fixture(t);
  let fail = true;
  const h = makeRunner(repo, () => fail ? { invalid: true } : sampleOutput());
  h.runner.start({ assetIds: ['a1'], skipAnySuccessful: false });
  await h.runner.runPromise;
  const failed = repo.listJobRuns()[0];
  assert.equal(failed.retryableFailures, 1);
  h.config.promptOverrides.systemPrompt = 'Corrected prompt';
  h.config.defaultProvider = 'unconfigured';
  fail = false;
  const result = await request(route(h, repo), `/api/enrich/runs/${failed.id}/retry`);
  assert.equal(result.status, 202);
  await h.runner.runPromise;
  const retry = repo.listJobRuns()[0];
  assert.equal(retry.retrySourceRunId, failed.id);
  assert.equal(retry.provider, failed.provider);
  assert.notEqual(retry.inferenceId, failed.inferenceId);
  assert.equal(repo.getRunConfiguration(retry.configurationId).snapshot.inference.systemPrompt, 'Corrected prompt');
  assert.equal(repo.jobRunRetryFailures(failed.id).count, 0);
});

test('configuration matching drives failure caps in both batch selection and per-photo checks', (t) => {
  const { repo } = fixture(t);
  const first = snapshot();
  const changed = snapshot({ systemPrompt: 'Changed' });
  repo.saveRunConfiguration(first);
  repo.saveRunConfiguration(changed);
  repo.upsertAsset({ id: 'a1' });
  for (let i = 0; i < 2; i += 1) repo.recordProcessingRun({ assetId: 'a1', ...first.runKey, status: 'failed', error: 'invalid output' });
  for (const [configuration, limited] of [[first, true], [changed, false]]) {
    assert.equal(repo.failureCount({ assetId: 'a1', ...configuration.runKey }), limited ? 2 : 0);
    const result = repo.assetIdsNeedingWork(['a1'], { runKey: configuration.runKey, skipAnySuccessful: false, maxFailuresPerAsset: 2 });
    assert.equal(result.failureLimited.has('a1'), limited);
    assert.equal(repo.failureLimitedAssetIds({ runKey: configuration.runKey, maxFailuresPerAsset: 2 }).count, limited ? 1 : 0);
  }
  assert.equal(repo.assetFailureDetails(['a1'], { runKey: first.runKey })[0].lastError, 'invalid output');
  assert.equal(repo.assetFailureDetails(['a1'], { runKey: changed.runKey })[0].lastError, null);
});

test('referenced snapshots survive job pruning, database backup/restore, and latest-success replacement', (t) => {
  const { repo, dir } = fixture(t);
  const first = snapshot();
  const second = snapshot({ systemPrompt: 'Second' });
  for (const configuration of [first, second]) repo.saveRunConfiguration(configuration);
  repo.upsertAsset({ id: 'a1' });
  repo.setManualFrameTags({ assetIds: ['a1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  repo.recordProcessingRun({ assetId: 'a1', ...first.runKey, status: 'succeeded', normalizedOutput: sampleOutput() });
  const output = sampleOutput(); output.caption = 'The latest caption.';
  repo.recordProcessingRun({ assetId: 'a1', ...second.runKey, status: 'succeeded', normalizedOutput: output });
  for (let i = 0; i < 101; i += 1) repo.recordJobRun({
    title: 'Run', ...second.runKey, configurationId: i === 0 ? first.id : second.id,
    status: 'finished', counters: { failed: 0 }, startedAt: '2026-09-01T00:00:00Z', finishedAt: '2026-09-01T00:00:01Z',
  });
  assert.equal(repo.listJobRuns(100).length, 50, 'history pages stay capped');
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM job_runs').get().n, 100);
  assert.ok(repo.getRunConfiguration(first.id));
  repo.backupTo(join(dir, 'restored.sqlite'));
  const restored = new Repository(join(dir, 'restored.sqlite'));
  try {
    assert.deepEqual(restored.initSchema().applied, []);
    assert.equal(restored.getRunConfiguration(first.id).snapshot.inference.systemPrompt, 'System A');
    assert.equal(restored.latestEnrichment('a1').caption, 'The latest caption.');
    assert.equal(restored.latestEnrichment('a1').configurationId, second.id);
    assert.equal(restored.latestEnrichment('a1').inferenceId, second.inferenceId);
    assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM asset_tags WHERE tag = 'frame/eligible' AND source = 'manual'").get().n, 1);
  } finally { restored.close(); }
});

test('v7 upgrade preserves successes as unknown identity, with no invented snapshots or replay', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-config-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'enrichment.sqlite');
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(REPO_ROOT, 'test/fixtures/upgrades/enrichment-v7.sql'), 'utf8'));
  db.exec(`PRAGMA user_version = 7;
    INSERT INTO assets (asset_id, first_seen_at, last_seen_at) VALUES ('a1', 'old', 'old');
    INSERT INTO processing_runs (asset_id, provider, model, prompt_version, taxonomy_version, status, started_at)
    VALUES ('a1', 'local_lmstudio', 'vision', 'v1-custom', 'v1.2', 'succeeded', 'old');`);
  db.close();
  const repo = new Repository(path);
  try {
    assert.deepEqual(repo.initSchema().applied, [8, 9, 10]);
    const config = snapshot();
    assert.equal(repo.hasAnySuccessfulRun('a1'), true);
    assert.equal(repo.hasSuccessfulRun({ assetId: 'a1', ...config.runKey }), false);
    assert.equal(repo.assetIdsNeedingWork(['a1'], { runKey: config.runKey, skipAnySuccessful: true }).successful.size, 1);
    assert.equal(repo.assetIdsNeedingWork(['a1'], { runKey: config.runKey, skipAnySuccessful: false }).needy.size, 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM enrich_configurations').get().n, 0);
    assert.equal(repo.db.prepare('SELECT configuration_id FROM processing_runs').get().configuration_id, null);
    assert.deepEqual(repo.initSchema().applied, []);
  } finally { repo.close(); }
});

test('configuration details are explicit, bounded, and do not put prompts in run-list payloads', async (t) => {
  const { repo } = fixture(t);
  const h = makeRunner(repo);
  h.runner.start({ assetIds: ['a1'] });
  await h.runner.runPromise;
  const run = repo.listJobRuns()[0];
  const handler = route(h, repo);
  const result = await request(handler, `/api/enrich/configurations/${run.configurationId}`, {}, 'GET');
  assert.equal(result.status, 200);
  assert.equal(result.body.snapshot.inference.systemPrompt, 'System A');
  assert.ok(!JSON.stringify(result.body).includes('provider-secret'));
  assert.ok(!JSON.stringify(result.body).includes('library-secret'));
  assert.ok(!JSON.stringify(repo.jobRunsPage()).includes('System A'));
  assert.equal((await request(handler, '/api/enrich/configurations/bad-id', {}, 'GET')).status, 404);
  assert.equal((await request(handler, `/api/enrich/configurations/${'0'.repeat(64)}`, {}, 'GET')).status, 404);
});


test('review-policy edits remain live, without changing inference eligibility or human decisions', async (t) => {
  const { repo } = fixture(t);
  const h = makeRunner(repo);
  h.runner.start({ assetIds: ['a1'], skipAnySuccessful: false });
  await h.runner.runPromise;
  const original = repo.listJobRuns()[0];
  repo.setManualFrameTags({ assetIds: ['a1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  const tags = new Set(repo.db.prepare("SELECT tag FROM asset_tags WHERE asset_id = 'a1'").all().map((row) => row.tag));
  assert.equal(deriveReview(tags, h.taxonomy).bucket, 'candidates');
  const raw = structuredClone(h.taxonomy.raw);
  raw.review.buckets.find((bucket) => bucket.id === 'candidates').match.any_tags = ['ai/scene/not-present'];
  raw.thresholds.frame_worthy = 0.99;
  replaceTaxonomy(h.taxonomy, parseTaxonomySource(JSON.stringify(raw)));
  assert.equal(deriveReview(tags, h.taxonomy).bucket, 'should_review');
  assert.equal(deriveReview(tags, h.taxonomy).state, 'approved');
  h.runner.start({ assetIds: ['a1'], skipAnySuccessful: false });
  await h.runner.runPromise;
  assert.equal(h.calls.length, 1);
  assert.equal(repo.listJobRuns()[0].inferenceId, original.inferenceId);
  assert.notEqual(repo.listJobRuns()[0].configurationId, original.configurationId);
});

test('changing the connection while downloading cannot redirect an active execution', async (t) => {
  const { repo } = fixture(t);
  const h = makeRunner(repo);
  const entered = deferred();
  const resume = deferred();
  let source;
  h.immich.getAssetThumbnail = async function () {
    entered.resolve(); await resume.promise;
    source = { baseUrl: this.baseUrl, apiKey: this.apiKey };
    return { data: Buffer.from('image'), contentType: 'image/jpeg' };
  };
  h.runner.start({ assetIds: ['a1', 'a2'] });
  await entered.promise;
  h.runner.sourceChanged();
  h.immich.baseUrl = 'http://library-b.test';
  h.immich.apiKey = 'replacement-secret';
  resume.resolve();
  await h.runner.runPromise;
  assert.deepEqual(source, { baseUrl: 'http://library-a.test', apiKey: 'library-secret' });
  assert.equal(h.calls.length, 0);
  assert.equal(repo.listJobRuns()[0].status, 'cancelled');
});

test('expanded prompts and stored details have explicit size ceilings', (t) => {
  const raw = structuredClone(loadV1Taxonomy().raw);
  raw.categories.scene.push(...Array.from({ length: 2000 }, (_, i) => `ai/scene/long-test-tag-${i}`));
  assert.throws(() => buildUserPrompt('{approved_tags}'.repeat(1000), parseTaxonomySource(JSON.stringify(raw))), /size limit/);
  const { repo } = fixture(t);
  const config = snapshot();
  repo.saveRunConfiguration(config);
  repo.db.prepare('UPDATE enrich_configurations SET snapshot_json = zeroblob(?) WHERE id = ?').run(MAX_RUN_CONFIGURATION_BYTES + 1, config.id);
  assert.equal(repo.getRunConfiguration(config.id), null, 'oversize persisted data is rejected before materializing it in JavaScript');
});

test('a captured real ImmichClient preserves private methods and connection settings across repeated capture', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, apiKey: options.headers['x-api-key'] });
    return Response.json({ id: 'a1' });
  };
  const original = new ImmichClient({ baseUrl: 'http://original.test', apiKey: 'original-key', timeoutMs: 12345, fetchImpl });
  const captured = captureClient(captureClient(original));
  original.baseUrl = 'http://changed.test';
  original.apiKey = 'changed-key';
  original.timeoutMs = 1;
  original.fetchImpl = () => { throw new Error('must use the captured transport'); };
  assert.notEqual(captured, original);
  assert.ok(captured instanceof ImmichClient);
  assert.equal(captured.timeoutMs, 12345);
  assert.equal(captured.fetchImpl, fetchImpl);
  assert.deepEqual(await captured.getAsset('a1'), { id: 'a1' });
  assert.deepEqual(calls, [{ url: 'http://original.test/api/assets/a1', apiKey: 'original-key' }]);
});

test('real Immich HTTP requests reach successful enrichment through sweeps, targeted runs, and queue resolution', async (t) => {
  for (const mode of ['sweep', 'targeted', 'queue']) {
    await t.test(mode, async (t) => {
      const { repo } = fixture(t);
      const h = makeRunner(repo);
      const requests = [];
      const asset = { id: 'a1', type: 'IMAGE', fileCreatedAt: '2026-01-01T00:00:00Z' };
      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          requests.push({ path: req.url, apiKey: req.headers['x-api-key'] });
          // This mutation happens after the run/reservation captured the
          // client but before its first metadata response arrives.
          h.immich.baseUrl = 'http://127.0.0.1:9';
          h.immich.apiKey = 'changed-key';
          const path = new URL(req.url, 'http://stub.test').pathname;
          if (path === '/api/assets/a1/thumbnail') {
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(Buffer.from('synthetic-image'));
          } else if (path === '/api/assets/a1' || path === '/api/search/metadata') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(path === '/api/assets/a1' ? asset : { assets: { items: [asset], nextPage: null } }));
          } else {
            res.writeHead(404); res.end();
          }
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      h.immich = new ImmichClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'captured-key' });
      h.runner = new EnrichJobRunner({ repo, immich: h.immich, taxonomy: h.taxonomy, config: h.config });
      let queueId;
      if (mode === 'queue') {
        queueId = repo.queueAdd({ title: 'Real client queue', filters: { city: 'Paris' } }).id;
        const result = await request(route(h, repo), `/api/enrich/queue/${queueId}/run`);
        assert.equal(result.status, 202, JSON.stringify(result.body));
      } else {
        h.runner.start(mode === 'targeted' ? { assetIds: ['a1'] } : { limit: 1 });
      }
      await h.runner.runPromise;
      assert.equal(h.runner.status().error, null);
      assert.equal(h.runner.status().counters.succeeded, 1);
      assert.equal(h.calls.length, 1, 'the provider received the photo through the real client');
      assert.ok(requests.some(({ path }) => path.startsWith('/api/assets/a1/thumbnail')));
      assert.ok(requests.every(({ apiKey }) => apiKey === 'captured-key'));
      assert.equal(repo.listJobRuns()[0].status, 'finished');
      assert.equal(repo.latestEnrichment('a1').caption, sampleOutput().caption);
      if (queueId) assert.equal(repo.queueGet(queueId), null);
    });
  }
});
