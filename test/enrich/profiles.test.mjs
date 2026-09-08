import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { Repository } from '../../src/enrich/repository.mjs';
import { EnrichmentProfiles } from '../../src/enrich/profiles.mjs';
import { EnrichJobRunner } from '../../src/enrich/jobRunner.mjs';
import { CaptionWritebackService } from '../../src/enrich/captionWriteback.mjs';
import { EnrichScheduler } from '../../src/enrich/scheduler.mjs';
import { createEnrichRoutes } from '../../src/routes/enrich.mjs';
import { loadV1Taxonomy, sampleOutput, REPO_ROOT } from './helpers.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-profiles-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  t.after(() => { repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  const config = { promptsDir: join(REPO_ROOT, 'prompts'), taxonomyPath: join(REPO_ROOT, 'taxonomy/v1.json'),
    promptVersion: 'v1', promptOverrides: { systemPrompt: 'Original custom system', userTemplate: 'Tags {approved_tags}' },
    defaultProvider: 'local_lmstudio', imageSource: 'preview', maxFailuresPerAsset: 2, enrichEnabled: true,
    captionWriteback: true, providers: { local_lmstudio: { modelName: 'vision', baseUrl: 'http://model.test/v1',
      fetchImpl: async (_, options) => { const body = JSON.parse(options.body); calls.push(body);
        return Response.json({ choices: [{ message: { content: JSON.stringify({ ...sampleOutput(), caption: body.messages[0].content }) } }] }); } } } };
  const profiles = new EnrichmentProfiles({ repo, config }); profiles.initialize();
  const taxonomy = loadV1Taxonomy();
  const immich = { getAsset: async id => ({ id }),
    getAssetThumbnail: async () => ({ data: Buffer.from('image'), contentType: 'image/jpeg' }),
    searchMetadata: async () => ({ assets: { items: [{ id: 'a1', type: 'IMAGE' }], nextPage: null } }) };
  const runner = new EnrichJobRunner({ repo, config, taxonomy, immich, profiles });
  const route = createEnrichRoutes({ repo, config, taxonomy, immich, profiles, enrichRunner: runner,
    requireImmich: () => true, review: {}, captionWriteback: {}, referee: null });
  return { repo, config, profiles, taxonomy, immich, runner, route, calls };
}
async function request(route, path, body = {}, method = 'POST') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method; req.headers = { 'content-type': 'application/json' };
  const out = {}; await route(req, { writeHead(status) { out.status = status; }, end(value) { out.body = JSON.parse(value); } }, new URL(path, 'http://test')); return out;
}

test('existing customization migrates once, with legacy queue pinned and restart preserving edits/default', t => {
  const h = setup(t); const original = h.profiles.defaultProfile();
  assert.equal(original.systemPrompt, 'Original custom system');
  h.repo.queueAdd({ title: 'Legacy', filters: { city: 'Paris' } });
  h.profiles.initialize();
  assert.equal(h.repo.queuePage().items[0].profileRevisionId, original.revisionId);
  const custom = h.profiles.create({ ...original, name: 'Travel', systemPrompt: 'Travel prompt' });
  h.profiles.setDefault(custom.id);
  h.config.promptOverrides.systemPrompt = 'Changed legacy fallback';
  h.profiles.initialize();
  assert.equal(h.profiles.list().length, 2);
  assert.equal(h.profiles.defaultProfile().systemPrompt, 'Travel prompt');
  assert.equal(h.repo.queuePage().items[0].profileRevisionId, original.revisionId);
});

test('validation and optimistic edits preserve usable revisions; rename/archive retain historical identity', t => {
  const { profiles } = setup(t); const initial = profiles.defaultProfile();
  for (const invalid of [{ name: ' ' }, { userTemplate: 'No placeholder' }, { systemPrompt: '' },
    { taxonomy: '{broken' }, { taxonomy: { version: '', categories: {} } }, { systemPrompt: 'x'.repeat(20001) }]) {
    assert.throws(() => profiles.update(initial.id, { ...initial, expectedRevisionId: initial.revisionId, ...invalid }));
    assert.equal(profiles.get(initial.id).revisionId, initial.revisionId);
  }
  const next = profiles.update(initial.id, { ...initial, name: 'Renamed', expectedRevisionId: initial.revisionId });
  assert.equal(next.revision, 2);
  assert.equal(profiles.revision(initial.revisionId).name, 'Default');
  assert.throws(() => profiles.update(initial.id, { ...initial, expectedRevisionId: initial.revisionId }), /another window/);
  assert.throws(() => profiles.archive(initial.id, true), /another default/);
  const second = profiles.create({ ...initial, name: 'Second' }); profiles.setDefault(second.id);
  profiles.archive(initial.id, true);
  assert.throws(() => profiles.resolve({ profileId: initial.id }), /archived/);
  assert.equal(profiles.resolve({ profileRevisionId: initial.revisionId }).name, 'Default');
  profiles.archive(initial.id, false); assert.equal(profiles.get(initial.id).name, 'Renamed');
});

test('queue pins on insertion, distinguishes profiles, survives edit/archive and supports explicit replacement', async t => {
  const h = setup(t); const first = h.profiles.defaultProfile();
  const second = h.profiles.create({ ...first, name: 'Travel', systemPrompt: 'Travel' });
  const add = profileId => request(h.route, '/api/enrich/queue', { filters: { city: 'Paris' }, profileId });
  const a = await add(first.id); const b = await add(second.id);
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.notEqual(a.body.id, b.body.id);
  assert.equal((await add(first.id)).body.duplicate, true);
  h.profiles.update(second.id, { ...second, systemPrompt: 'Edited after queue', expectedRevisionId: second.revisionId });
  h.profiles.archive(second.id, true);
  const run = await request(h.route, `/api/enrich/queue/${b.body.id}/run`, { skipAnySuccessful: false });
  assert.equal(run.status, 202); await h.runner.runPromise;
  assert.equal(h.calls[0].messages[0].content, 'Travel');
  assert.equal(h.repo.listJobRuns()[0].profile.revisionId, second.revisionId);
  const update = await request(h.route, `/api/enrich/queue/${a.body.id}/profile`, { profileId: second.id, expectedRevisionId: first.revisionId }, 'PATCH');
  assert.equal(update.status, 409);
  h.profiles.archive(second.id, false);
  const replaced = await request(h.route, `/api/enrich/queue/${a.body.id}/profile`, { profileId: second.id, expectedRevisionId: first.revisionId }, 'PATCH');
  assert.equal(replaced.status, 200);
  assert.equal(h.repo.queueGet(a.body.id).profileRevisionId, h.profiles.get(second.id).revisionId);
  assert.equal((await request(h.route, `/api/enrich/queue/${a.body.id}/profile`, { profileId: first.id, expectedRevisionId: first.revisionId }, 'PATCH')).status, 409);
});

test('profile edits during selection cannot change a reserved run; latest result/caption/index and human decisions remain authoritative', async t => {
  const h = setup(t); const original = h.profiles.defaultProfile();
  h.runner.start({ assetIds: ['a1'], profileId: original.id }); await h.runner.runPromise;
  h.repo.setManualFrameTags({ assetIds: ['a1'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
  const second = h.profiles.create({ ...original, name: 'Second', systemPrompt: 'Second unique caption' });
  const reservation = h.runner.reserve({ profileId: second.id, skipAnySuccessful: false });
  h.profiles.update(second.id, { ...second, systemPrompt: 'New prompt after reservation', expectedRevisionId: second.revisionId });
  reservation.start({ assetIds: ['a1'] }); await h.runner.runPromise;
  assert.equal(h.calls.length, 2);
  const result = h.repo.latestEnrichment('a1');
  assert.equal(result.caption, 'Second unique caption'); assert.equal(result.profile.revisionId, second.revisionId);
  assert.equal(h.repo.db.prepare("SELECT COUNT(*) AS n FROM asset_tags WHERE source = 'manual' AND tag = 'frame/eligible'").get().n, 1);
  assert.equal(h.repo.db.prepare("SELECT caption FROM caption_index WHERE asset_id = 'a1'").get().caption, 'Second unique caption');
  assert.ok(h.repo.db.prepare("SELECT 1 FROM caption_writeback WHERE asset_id = 'a1'").get());
  const writes = [];
  const writeback = new CaptionWritebackService({ repo: h.repo, config: h.config, immich: {
    getAsset: async () => ({ exifInfo: { description: '' } }),
    updateAsset: async (id, body) => writes.push({ id, ...body }),
  } });
  await writeback.pushOne(h.repo.captionWritebackNext(1)[0]);
  assert.deepEqual(writes, [{ id: 'a1', description: 'Second unique caption' }]);
  h.repo.captionWritebackEnqueue(['a1']);
  writeback.immich.getAsset = async () => ({ exifInfo: { description: 'Human description' } });
  await writeback.pushOne(h.repo.captionWritebackNext(1)[0]);
  assert.equal(writes.length, 1, 'profile results cannot overwrite human-authored descriptions');
  h.runner.start({ assetIds: ['a1'], profileId: second.id, skipAnySuccessful: true }); await h.runner.runPromise;
  assert.equal(h.calls.length, 2, 'Only unenriched skips any previous success');
});

test('renames and duplicates change attribution but identical inference still skips; policy stays live and separate', async t => {
  const h = setup(t); const first = h.profiles.defaultProfile();
  h.runner.start({ assetIds: ['a1'], profileId: first.id }); await h.runner.runPromise;
  const copy = h.profiles.create({ ...first, name: 'Same inference' });
  h.runner.start({ assetIds: ['a1'], profileId: copy.id, skipAnySuccessful: false }); await h.runner.runPromise;
  assert.equal(h.calls.length, 1);
  const raw = structuredClone(copy.taxonomy); raw.thresholds.frame_worthy = 0.99;
  h.profiles.update(copy.id, { ...copy, taxonomy: raw, expectedRevisionId: copy.revisionId });
  assert.notEqual(h.taxonomy.thresholds.frame_worthy, 0.99, 'profile edits do not replace the global review policy');
  h.runner.start({ assetIds: ['a1'], profileId: copy.id, skipAnySuccessful: false }); await h.runner.runPromise;
  assert.equal(h.calls.length, 1, 'policy-only profile edits do not change inference identity');
});

test('Daily Enrich resolves the explicit default at start while queued revisions remain pinned', async t => {
  const h = setup(t); const original = h.profiles.defaultProfile();
  const q = h.repo.queueAdd({ title: 'Original', filters: { city: 'Paris' }, profileRevisionId: original.revisionId });
  const daily = h.profiles.create({ ...original, name: 'Daily', systemPrompt: 'Daily prompt' }); h.profiles.setDefault(daily.id);
  h.config.enrichSchedule = { enabled: true, time: '03:00', timeZone: 'UTC', photoBudget: 1 };
  const scheduler = new EnrichScheduler({ runner: h.runner, repo: h.repo, config: h.config, log() {}, warn() {} });
  t.after(() => scheduler.stop());
  assert.equal(scheduler.tick(new Date('2026-09-07T04:00:00Z')), true);
  await h.runner.runPromise;
  assert.equal(h.repo.listJobRuns()[0].profile.revisionId, daily.revisionId);
  assert.equal(h.repo.queueGet(q.id).profileRevisionId, original.revisionId);
});

test('profile revision cannot be replaced while queue selection or Run all owns it', async t => {
  const h = setup(t); const first = h.profiles.defaultProfile();
  const q = await request(h.route, '/api/enrich/queue', { filters: { city: 'Paris' } });
  let release; h.immich.searchMetadata = () => new Promise(resolve => { release = resolve; });
  const starting = request(h.route, `/api/enrich/queue/${q.body.id}/run`, {});
  while (!release) await new Promise(resolve => setImmediate(resolve));
  try {
    const update = await request(h.route, `/api/enrich/queue/${q.body.id}/profile`, { profileId: first.id, expectedRevisionId: first.revisionId }, 'PATCH');
    assert.equal(update.status, 409); assert.match(update.body.error.message, /Cancel/);
  } finally { release({ assets: { items: [], nextPage: null } }); }
  await starting;
});

test('manual runs and retry use the selected current profile; failures preserve the earlier successful result', async t => {
  const h = setup(t); const first = h.profiles.defaultProfile();
  const original = await request(h.route, '/api/enrich/run', { assetIds: ['a1'], profileId: first.id });
  assert.equal(original.status, 202); await h.runner.runPromise;
  const second = h.profiles.create({ ...first, name: 'Failure profile', systemPrompt: 'Failure prompt' });
  h.config.providers.local_lmstudio.fetchImpl = async () => Response.json({ error: { message: 'synthetic unavailable' } }, { status: 400 });
  await request(h.route, '/api/enrich/run', { assetIds: ['a1', 'a2'], profileId: second.id, skipAnySuccessful: false }); await h.runner.runPromise;
  assert.equal(h.repo.latestEnrichment('a1').profile.id, first.id);
  const failedRun = h.repo.listJobRuns()[0];
  const retry = await request(h.route, `/api/enrich/runs/${failedRun.id}/retry`, { profileId: first.id });
  assert.equal(retry.status, 202); assert.equal(retry.body.profile.id, first.id);
  assert.equal(retry.body.provider, failedRun.provider); await h.runner.runPromise;
  assert.equal(h.repo.latestEnrichment('a1').profile.id, first.id);
});


test('schema-8 fixture migrates to profiles without inventing old run attribution', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-profile-v8-'));
  const path = join(dir, 'enrichment.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec(readFileSync(join(REPO_ROOT, 'test/fixtures/upgrades/enrichment-v8.sql'), 'utf8'));
  db.exec("PRAGMA user_version = 8; INSERT INTO enrich_queue (title, filters_json, requested_at) VALUES ('Old queued work', '{}', '2026-09-07');");
  db.close();
  const repo = new Repository(path);
  try {
    assert.deepEqual(repo.initSchema().applied, [9]);
    const config = { promptsDir: join(REPO_ROOT, 'prompts'), promptVersion: 'v1', taxonomyPath: join(REPO_ROOT, 'taxonomy/v1.json'),
      promptOverrides: { systemPrompt: 'Migrated customization' } };
    const profiles = new EnrichmentProfiles({ repo, config }); profiles.initialize();
    const pinned = repo.queuePage().items[0].profileRevisionId;
    assert.equal(profiles.revision(pinned).systemPrompt, 'Migrated customization');
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM enrich_configurations').get().n, 0);
    assert.deepEqual(repo.initSchema().applied, []);
  } finally { repo.close(); }
});


test('Run all preserves each profile pin and allows changed-input passes without clearing decisions', async t => {
  const h = setup(t); const first = h.profiles.defaultProfile();
  const second = h.profiles.create({ ...first, name: 'Second', systemPrompt: 'Second profile' });
  const a = await request(h.route, '/api/enrich/queue', { filters: { city: 'Paris' }, profileId: first.id });
  const b = await request(h.route, '/api/enrich/queue', { filters: { city: 'Paris' }, profileId: second.id });
  const run = await request(h.route, '/api/enrich/queue/run-all', { plan: [a.body.id, b.body.id].map(id => ({ id, skipAnySuccessful: false })) });
  assert.equal(run.status, 202);
  for (let i = 0; i < 100 && h.repo.queuePage().total; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.repo.queuePage().total, 0);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.repo.listJobRuns().map(r => r.profile.revisionId), [second.revisionId, first.revisionId]);
});
