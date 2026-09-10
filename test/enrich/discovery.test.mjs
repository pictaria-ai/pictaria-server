import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Repository } from '../../src/enrich/repository.mjs';
import { ImmichClient } from '../../src/immich.mjs';
import { EnrichDiscovery, DiscoveryIncompleteError } from '../../src/enrich/discovery.mjs';
import { runBatch } from '../../src/enrich/runner.mjs';
import { captureRunConfiguration } from '../../src/enrich/runConfiguration.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { EnrichScheduler } from '../../src/enrich/scheduler.mjs';
import { loadV1Taxonomy, sampleOutput, REPO_ROOT } from './helpers.mjs';

function photo(n, changes = {}) {
  return { id: `photo-${String(n).padStart(7, '0')}`, type: 'IMAGE', visibility: 'timeline', isTrashed: false,
    fileCreatedAt: new Date(Date.UTC(2020, 0, 1) - n * 1000).toISOString(),
    updatedAt: '2026-01-01T00:00:00.000Z', originalFileName: `${n}.jpg`, ...changes };
}
function fixture(t, rows) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-discovery-')), path = join(dir, 'enrich.sqlite');
  let repo = new Repository(path); repo.initSchema();
  const data = new Map(rows.map(r => [r.id, { ...r }])); let cache = new Map();
  const calls = { pages: [], gets: [], downloads: [] };
  const hooks = {};
  const immich = new ImmichClient({ baseUrl: 'http://fixture.invalid/api', apiKey: 'synthetic-key', fetchImpl: async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/search/metadata')) {
      const body = JSON.parse(init.body); calls.pages.push(body);
      const override = await hooks.search?.(body); if (override) return override;
      // Models the v2 default as well: no visibility means timeline, never broad.
      const visibility = body.visibility ?? 'timeline';
      const cacheKey = JSON.stringify([visibility, body.updatedAfter, body.type, body.withDeleted]);
      if (!cache.has(cacheKey)) cache.set(cacheKey, [...data.values()].filter(r => r.visibility === visibility
        && (!body.type || r.type === body.type) && (body.withDeleted || !r.isTrashed)
        && (!body.updatedAfter || Date.parse(r.updatedAt) >= Date.parse(body.updatedAfter)))
        .sort((a, b) => (b.fileCreatedAt ?? '').localeCompare(a.fileCreatedAt ?? '') || b.id.localeCompare(a.id)));
      const found = cache.get(cacheKey);
      return Response.json({ assets: { items: found.slice((body.page - 1) * body.size, body.page * body.size),
        nextPage: body.page * body.size < found.length ? String(body.page + 1) : null } });
    }
    const id = decodeURIComponent(url.pathname.split('/')[3]);
    if (url.pathname.endsWith('/thumbnail')) {
      calls.downloads.push(id); return new Response('image', { headers: { 'content-type': 'image/jpeg' } });
    }
    calls.gets.push(id);
    const override = await hooks.get?.(id); if (override) return override;
    return data.has(id) ? Response.json(data.get(id)) : Response.json({ message: 'not found' }, { status: 404 });
  } });
  const provider = { providerName: 'cloud_openai', modelName: 'fixture', calls: [], async analyzeImage(image) {
    this.calls.push(image.assetId); return { normalizedOutput: sampleOutput() };
  } };
  const options = { repo, immich, provider, taxonomy: loadV1Taxonomy(), systemPrompt: 'fixture',
    userTemplate: '{approved_tags}', skipAnySuccessful: true, maxAnalyzed: 50, limit: 1000, listForReview: true };
  const configuration = captureRunConfiguration(options); repo.saveRunConfiguration(configuration);
  const runKey = configuration.runKey;
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get repo() { return repo; }, options, immich, calls, provider, hooks, runKey,
    change(id, patch) { Object.assign(data.get(id), patch); cache.clear(); },
    add(row) { data.set(row.id, row); cache.clear(); },
    remove(id) { data.delete(id); cache.clear(); },
    reopen() { repo.close(); repo = new Repository(path); repo.initSchema(); options.repo = repo; return repo; },
    seed(rows, status = 'succeeded', key = runKey) {
      repo.transaction(() => { for (const row of rows) {
        repo.upsertAsset(row); repo.recordProcessingRun({ assetId: row.id, ...key, status });
      } });
    }, dir };
}

test('real budgeted runner finds 50 behind a 100k prefix; warm sweeps query only changes and never resend success', async t => {
  const rows = Array.from({ length: 100050 }, (_, n) => photo(n)); const h = fixture(t, rows);
  h.seed(rows.slice(0, 100000)); const log = [];
  const result = await runBatch({ ...h.options, log: m => log.push(m) });
  assert.equal(result.counters.succeeded, 50); assert.equal(result.counters.skippedSuccessful, 0);
  assert.equal(h.calls.gets.length, 50); assert.equal(h.calls.downloads.length, 50);
  assert.equal(h.repo.reviewListRows().length, 50); // historical successes are not swept into Curate
  assert.equal(h.calls.pages.length, 104); // 101 full pages plus three delta partitions
  assert.match(log.join('\n'), /50 candidates, 50 validated, 0 rejected/);
  h.calls.pages.length = 0; h.calls.gets.length = 0;
  const repeat = await runBatch(h.options);
  assert.equal(repeat.counters.analyzed, 0); assert.equal(h.calls.pages.length, 3); assert.equal(h.calls.gets.length, 0);
  assert.ok(h.calls.pages.every(p => p.updatedAfter === '2026-01-01T00:00:00.001Z'));
});

test('checkpoint survives a bounded incomplete run, backup and reopen; cancellation cannot publish a late page', async t => {
  const h = fixture(t, Array.from({ length: 2001 }, (_, n) => photo(n)));
  const d = new EnrichDiscovery(h.repo, h.immich, { maxPages: 1 });
  await assert.rejects(d.prepare(), DiscoveryIncompleteError);
  assert.equal(d.state().ready, false); assert.equal(d.state().scan.page, 2); d.close();
  const backup = join(h.dir, 'backup.sqlite'); h.repo.backupTo(backup);
  const restored = new Repository(backup); restored.initSchema();
  const copy = new EnrichDiscovery(restored, h.immich); await copy.prepare();
  assert.equal(copy.state().ready, true); assert.equal(copy.db.prepare('SELECT COUNT(*) n FROM enrich_inventory').get().n, 2001);
  copy.close(); restored.close();
  let stop = false;
  const resumed = new EnrichDiscovery(h.reopen(), h.immich, { shouldStop: () => stop });
  h.hooks.search = () => { stop = true; };
  await resumed.prepare(); assert.equal(resumed.state().scan.page, 2); assert.equal(resumed.state().ready, false); resumed.close();
  delete h.hooks.search;
  const complete = new EnrichDiscovery(h.repo, h.immich); await complete.prepare();
  assert.equal(complete.state().ready, true); complete.close();
});

test('broad partitions invalidate hidden/archive/trash and old-capture uploads appear promptly', async t => {
  const rows = Array.from({ length: 5 }, (_, n) => photo(n)); const h = fixture(t, rows);
  const d = new EnrichDiscovery(h.repo, h.immich); await d.prepare(); d.close();
  const updatedAt = '2026-02-01T00:00:00.000Z';
  h.change(rows[0].id, { visibility: 'hidden', updatedAt }); h.change(rows[1].id, { visibility: 'archive', updatedAt });
  h.change(rows[2].id, { isTrashed: true, updatedAt });
  h.add(photo(20, { updatedAt, fileCreatedAt: '1990-01-01T00:00:00.000Z' }));
  const next = new EnrichDiscovery(h.repo, h.immich); await next.prepare();
  const ids = next.candidates({ runKey: h.runKey }).map(r => r.asset_id);
  assert.deepEqual(ids, [rows[3].id, rows[4].id, photo(20).id]); next.close();
  await runBatch(h.options); assert.deepEqual(h.calls.gets, ids);
});

test('a changed inference reuses the inventory but Only unenriched still prevents paid reprocessing', async t => {
  const h = fixture(t, [photo(0)]);
  assert.equal((await runBatch(h.options)).counters.succeeded, 1);
  h.provider.modelName = 'another-model';
  assert.equal((await runBatch(h.options)).counters.analyzed, 0);
  assert.equal((await runBatch({ ...h.options, skipAnySuccessful: false })).counters.succeeded, 1);
  assert.equal((await runBatch({ ...h.options, skipAnySuccessful: false })).counters.analyzed, 0);
  assert.equal(h.calls.downloads.length, 2);
});

test('permanent cleanup triggers bounded full catch-up within this run, rather than empty daily attempts', async t => {
  const rows = Array.from({ length: 6050 }, (_, n) => photo(n)); const h = fixture(t, rows);
  const d = new EnrichDiscovery(h.repo, h.immich); await d.prepare(); d.close();
  for (const row of rows.slice(0, 6000)) h.remove(row.id);
  const log = []; const result = await runBatch({ ...h.options, log: m => log.push(m) });
  assert.equal(result.counters.succeeded, 50); assert.equal(h.calls.gets.length, 150);
  assert.match(log.join('\n'), /refreshing the inventory/);
  assert.match(log.join('\n'), /150 candidates, 150 validated, 100 rejected/);
});

test('eligibility SQL matches queue rules for configuration changes, infra/content failures and human discard', async t => {
  const rows = Array.from({ length: 250 }, (_, n) => photo(n)); const h = fixture(t, rows);
  h.seed(rows.slice(0, 50)); h.seed(rows.slice(50, 100), 'failed'); h.seed(rows.slice(50, 100), 'failed');
  h.seed(rows.slice(100, 150), 'failed_infra');
  h.repo.upsertAsset(rows[150]); h.repo.db.prepare('UPDATE assets SET enrich_discarded_at=? WHERE asset_id=?').run('2026-01-01', rows[150].id);
  const d = new EnrichDiscovery(h.repo, h.immich); await d.prepare();
  for (const runKey of [h.runKey, { ...h.runKey, inferenceId: 'b'.repeat(64) }, { ...h.runKey, inferenceId: null }]) {
    for (const skipAnySuccessful of [true, false]) {
      const opts = { runKey, skipAnySuccessful, maxFailuresPerAsset: 2 };
      const expected = h.repo.assetIdsNeedingWork(rows.map(r => r.id), opts).needy;
      assert.deepEqual(d.candidates(opts).map(r => r.asset_id), rows.filter(r => expected.has(r.id)).slice(0, 100).map(r => r.id));
    }
  }
  d.close();
});

test('outages and malformed pages preserve inventory; a second owner cannot interleave; credential changes reset only inventory', async t => {
  const h = fixture(t, [photo(0), photo(1)]); h.seed([photo(0)]);
  const d = new EnrichDiscovery(h.repo, h.immich); await d.prepare();
  const other = new EnrichDiscovery(h.repo, h.immich);
  await assert.rejects(other.prepare(), /Another library discovery/);
  const before = d.state(); d.close();
  h.hooks.search = () => Response.json({ assets: { items: [{ id: 'broken' }], nextPage: null } });
  const bad = new EnrichDiscovery(h.repo, h.immich);
  await assert.rejects(bad.prepare(), /incomplete discovery metadata/);
  assert.equal(bad.state().watermark, before.watermark); assert.equal(bad.state().ready, true); bad.close();
  h.hooks.search = () => Response.json({ message: 'offline' }, { status: 503 });
  const offline = new EnrichDiscovery(h.repo, h.immich); await assert.rejects(offline.prepare(), e => e.status === 503); offline.close();
  delete h.hooks.search; h.immich.apiKey = 'different-synthetic-key'; h.remove(photo(1).id);
  const changed = new EnrichDiscovery(h.repo, h.immich); await changed.prepare();
  assert.equal(changed.db.prepare('SELECT COUNT(*) n FROM enrich_inventory').get().n, 1);
  assert.equal(h.repo.hasAnySuccessfulRun(photo(0).id), true); changed.close();
});

test('late equal-timestamp arrivals and silent access changes reconcile after 24 hours without replaying the timestamp boundary', async t => {
  const h = fixture(t, [photo(0)]); let now = 100000;
  const make = () => new EnrichDiscovery(h.repo, h.immich, { now: () => now });
  let d = make(); await d.prepare(); d.close(); h.add(photo(1));
  d = make(); await d.prepare(); assert.equal(d.candidates({ runKey: h.runKey }).length, 1); d.close();
  now += 24 * 60 * 60 * 1000;
  d = make(); await d.prepare(); assert.equal(d.candidates({ runKey: h.runKey }).length, 2); d.close();
});

test('empty full reconciliation retains the completed broad watermark instead of repeatedly scanning hidden history', async t => {
  const h = fixture(t, [photo(0)]); let now = 100000;
  const make = () => new EnrichDiscovery(h.repo, h.immich, { now: () => now });
  let d = make(); await d.prepare(); d.close();
  const updatedAt = '2026-02-01T00:00:00.000Z'; h.change(photo(0).id, { visibility: 'hidden', updatedAt });
  d = make(); await d.prepare(); d.close(); now += 24 * 60 * 60 * 1000;
  h.calls.pages.length = 0;
  d = make(); await d.prepare();
  assert.equal(d.state().watermark, Date.parse(updatedAt));
  assert.equal(d.db.prepare('SELECT COUNT(*) n FROM enrich_inventory').get().n, 0);
  assert.equal(h.calls.pages.length, 4);
  assert.ok(h.calls.pages.slice(1).every(p => p.updatedAfter === '2026-02-01T00:00:00.001Z'));
  d.close();
});

test('validation exhaustion is explicitly incomplete and permission errors never become confirmed missing', async t => {
  const h = fixture(t, [photo(0), photo(1)]);
  const d = new EnrichDiscovery(h.repo, h.immich, { maxValidations: 1, rejectionBurst: 5 }); await d.prepare();
  h.remove(photo(0).id);
  await assert.rejects(d.next({ runKey: h.runKey }), DiscoveryIncompleteError); d.close();
  h.hooks.get = () => Response.json({ message: 'forbidden' }, { status: 403 });
  const denied = new EnrichDiscovery(h.repo, h.immich); await denied.prepare();
  await assert.rejects(denied.next({ runKey: h.runKey }), e => e.status === 403);
  assert.equal(denied.db.prepare('SELECT eligible FROM enrich_inventory WHERE asset_id=?').get(photo(1).id).eligible, 1);
  denied.close();
});

test('Daily Enrich uses inventory discovery and manual discovery failures are visible in run history', async t => {
  const h = fixture(t, [photo(0), photo(1)]);
  const providerServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleOutput()) } }] })); });
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { providerServer.closeAllConnections(); providerServer.close(resolve); }));
  const config = { promptsDir: join(REPO_ROOT, 'prompts'), promptVersion: 'v1', promptOverrides: {},
    defaultProvider: 'local_lmstudio', imageSource: 'preview', maxFailuresPerAsset: 2,
    enrichEnabled: true, enrichSchedule: { enabled: true, timeZone: 'UTC', time: '00:00', photoBudget: 1 },
    providers: { local_lmstudio: { modelName: 'fixture', baseUrl: `http://127.0.0.1:${providerServer.address().port}/v1` } } };
  const runner = new EnrichJobRunner({ repo: h.repo, immich: h.immich, taxonomy: h.options.taxonomy, config });
  const scheduler = new EnrichScheduler({ runner, repo: h.repo, config, log: () => {} });
  assert.equal(scheduler.tick(new Date()), true); await runner.runPromise;
  assert.equal(runner.status().counters.succeeded, 1); assert.equal(runner.status().error, null);
  assert.equal(h.calls.gets.length, 1); assert.equal(h.repo.reviewListRows().length, 1);
  assert.equal(scheduler.tick(new Date()), false);
  h.hooks.search = () => Response.json({ assets: { items: [photo(0)], nextPage: '1' } });
  runner.start({ maxAnalyzed: 1 }); await runner.runPromise;
  assert.match(runner.status().error, /invalid or non-progressing next page/);
  const row = h.repo.db.prepare('SELECT status,error FROM job_runs ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.status, 'failed'); assert.match(row.error, /next page/);
  assert.equal(h.calls.downloads.length, 1);
  // Source changes cancel discovery before an old-client response can publish.
  const previous = h.repo.db.prepare('SELECT state_json FROM enrich_discovery').get().state_json;
  h.hooks.search = () => { runner.sourceChanged(); h.immich.apiKey = 'replacement-key'; };
  runner.start({ maxAnalyzed: 1 }); await runner.runPromise;
  assert.equal(runner.status().cancelled, true);
  assert.equal(h.repo.db.prepare('SELECT state_json FROM enrich_discovery').get().state_json, previous);
  assert.equal(h.calls.downloads.length, 1); await runner.stop();
});
