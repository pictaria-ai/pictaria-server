// Reproduce the production traversal cliff with synthetic data, not a live server.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ImmichClient } from '../../src/immich.mjs';
import { runBatch } from '../../src/enrich/runner.mjs';
import { loadV1Taxonomy } from '../../test/enrich/helpers.mjs';
import { library, sandbox, SyntheticSource, history } from './discovery-fixture.mjs';
const rows = library(100050, false), source = new SyntheticSource(rows), box = sandbox();
let calls = 0;
try {
  box.repo.transaction(() => { for (const row of rows.slice(0, -50)) history(box.repo, row); });
  const immich = { listImageAssets: ImmichClient.prototype.listImageAssets,
    async searchMetadata({ page, size }) {
      const result = await source.scan({ page, size, updatedAfter: null });
      return { assets: { items: result.items, nextPage: result.nextPage } };
    } };
  const provider = { providerName: 'cloud_openai', modelName: 'fixture',
    async analyzeImage() { calls++; throw Error('Unexpected provider dispatch'); } };
  const started = performance.now(); let error;
  try { await runBatch({ repo: box.repo, immich, provider, taxonomy: loadV1Taxonomy(), systemPrompt: 'fixture',
    userTemplate: '{approved_tags}', promptVersion: 'v1', skipAnySuccessful: true, limit: 1000, maxAnalyzed: 50 }); }
  catch (e) { error = e; }
  assert.match(error?.message ?? '', /100000-item traversal limit/);
  assert.equal(calls, 0);
  console.log(JSON.stringify({ libraryPhotos: rows.length, enrichedPrefix: 100000,
    localMs: Math.round(performance.now() - started), ...source.calls, providerCalls: calls, error: error.message }));
} finally { box.close(); }
