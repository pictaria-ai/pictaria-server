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

test('existing customization and active choice survive restart; legacy pending pins are removed', t => {
  const h = setup(t); const original = h.profiles.activeProfile();
  assert.equal(original.systemPrompt, 'Original custom system');
  h.repo.queueAdd({ title: 'Legacy', filters: { city: 'Paris' } });
  h.repo.db.prepare('UPDATE enrich_queue SET profile_revision_id = ?').run(original.revisionId);
  h.profiles.initialize();
  assert.equal(h.repo.db.prepare('SELECT profile_revision_id FROM enrich_queue').get().profile_revision_id, null);
  const custom = h.profiles.create({ ...original, name: 'Travel', systemPrompt: 'Travel prompt' });
  h.profiles.setActive(custom.id);
  h.config.promptOverrides.systemPrompt = 'Changed legacy fallback';
  h.profiles.initialize();
  assert.equal(h.profiles.list().length, 2);
  assert.equal(h.profiles.activeProfile().systemPrompt, 'Travel prompt');
  assert.equal(h.repo.db.prepare('SELECT profile_revision_id FROM enrich_queue').get().profile_revision_id, null);
});

test('validation and optimistic edits preserve usable revisions; rename/archive retain historical identity', t => {
  const { profiles } = setup(t); const initial = profiles.activeProfile();
  for (const invalid of [{ name: ' ' }, { userTemplate: 'No placeholder' }, { systemPrompt: '' },
    { taxonomy: '{broken' }, { taxonomy: { version: '', categories: {} } }, { systemPrompt: 'x'.repeat(20001) }]) {
    assert.throws(() => profiles.update(initial.id, { ...initial, expectedRevisionId: initial.revisionId, ...invalid }));
    assert.equal(profiles.get(initial.id).revisionId, initial.revisionId);
  }
  const next = profiles.update(initial.id, { ...initial, name: 'Renamed', expectedRevisionId: initial.revisionId });
  assert.equal(next.revision, 2);
  assert.equal(profiles.revision(initial.revisionId).name, 'My profile');
  assert.throws(() => profiles.update(initial.id, { ...initial, expectedRevisionId: initial.revisionId }), /another window/);
  assert.throws(() => profiles.archive(initial.id, true), /another active/);
  const second = profiles.create({ ...initial, name: 'Second' }); profiles.setActive(second.id);
  profiles.archive(initial.id, true);
  assert.throws(() => profiles.resolve({ profileId: initial.id }), /archived/);
  assert.equal(profiles.resolve({ profileRevisionId: initial.revisionId }).name, 'My profile');
  profiles.archive(initial.id, false); assert.equal(profiles.get(initial.id).name, 'Renamed');
});

test('queue stores photos only and uses the active current revision when started', async t => {
  const h = setup(t); const first = h.profiles.activeProfile();
  const second = h.profiles.create({ ...first, name: 'Travel', systemPrompt: 'Travel' });
  const a = await request(h.route, '/api/enrich/queue', { filters: { city: 'Paris' } });
  h.profiles.setActive(second.id);
  const duplicate = await request(h.route, '/api/enrich/queue', { filters: { city: 'Paris' } });
  assert.equal(duplicate.body.id, a.body.id); assert.equal(duplicate.body.duplicate, true);
  const edited = h.profiles.update(second.id, { ...second, systemPrompt: 'Edited after queue', expectedRevisionId: second.revisionId });
  const run = await request(h.route, `/api/enrich/queue/${a.body.id}/run`, { skipAnySuccessful: false });
  assert.equal(run.status, 202); await h.runner.runPromise;
  assert.equal(h.calls[0].messages[0].content, 'Edited after queue');
  assert.equal(h.repo.listJobRuns()[0].profile.revisionId, edited.revisionId);
  assert.equal((await request(h.route, `/api/enrich/queue/${a.body.id}/profile`, {}, 'PATCH')).status, 410);
  assert.equal((await request(h.route, '/api/enrich/queue', { filters:{city:'Paris'}, profileId:first.id })).status, 400);
});

test('profile edits during selection cannot change a reserved run; latest result/caption/index and human decisions remain authoritative', async t => {
  const h = setup(t); const original = h.profiles.activeProfile();
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
  const h = setup(t); const first = h.profiles.activeProfile();
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

test('Daily Enrich resolves the active profile at start without pinning pending work', async t => {
  const h = setup(t); const original = h.profiles.activeProfile();
  const q = h.repo.queueAdd({ title: 'Original', filters: { city: 'Paris' } });
  const daily = h.profiles.create({ ...original, name: 'Daily', systemPrompt: 'Daily prompt' }); h.profiles.setActive(daily.id);
  h.config.enrichSchedule = { enabled: true, time: '03:00', timeZone: 'UTC', photoBudget: 1 };
  const scheduler = new EnrichScheduler({ runner: h.runner, repo: h.repo, config: h.config, log() {}, warn() {} });
  t.after(() => scheduler.stop());
  assert.equal(scheduler.tick(new Date('2026-09-07T04:00:00Z')), true);
  await h.runner.runPromise;
  assert.equal(h.repo.listJobRuns()[0].profile.revisionId, daily.revisionId);
  assert.equal(h.repo.queueGet(q.id).profileRevisionId, undefined);
});

test('retired queued-profile endpoint is rejected even while selection is in flight', async t => {
  const h = setup(t); const first = h.profiles.activeProfile();
  const q = await request(h.route, '/api/enrich/queue', { filters: { city: 'Paris' } });
  let release; h.immich.searchMetadata = () => new Promise(resolve => { release = resolve; });
  const starting = request(h.route, `/api/enrich/queue/${q.body.id}/run`, {});
  while (!release) await new Promise(resolve => setImmediate(resolve));
  try {
    const update = await request(h.route, `/api/enrich/queue/${q.body.id}/profile`, { profileId: first.id, expectedRevisionId: first.revisionId }, 'PATCH');
    assert.equal(update.status, 410);
  } finally { release({ assets: { items: [], nextPage: null } }); }
  await starting;
});

test('manual runs and retry use the active profile; failures preserve the earlier successful result', async t => {
  const h = setup(t); const first = h.profiles.activeProfile();
  const original = await request(h.route, '/api/enrich/run', { assetIds: ['a1'] });
  assert.equal(original.status, 202); await h.runner.runPromise;
  const second = h.profiles.create({ ...first, name: 'Failure profile', systemPrompt: 'Failure prompt' });
  h.config.providers.local_lmstudio.fetchImpl = async () => Response.json({ error: { message: 'synthetic unavailable' } }, { status: 400 });
  h.profiles.setActive(second.id);
  await request(h.route, '/api/enrich/run', { assetIds: ['a1', 'a2'], skipAnySuccessful: false }); await h.runner.runPromise;
  assert.equal(h.repo.latestEnrichment('a1').profile.id, first.id);
  const failedRun = h.repo.listJobRuns()[0];
  h.profiles.setActive(first.id);
  const retry = await request(h.route, `/api/enrich/runs/${failedRun.id}/retry`, {});
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
    assert.deepEqual(repo.initSchema().applied, [9, 10]);
    const config = { promptsDir: join(REPO_ROOT, 'prompts'), promptVersion: 'v1', taxonomyPath: join(REPO_ROOT, 'taxonomy/v1.json'),
      promptOverrides: { systemPrompt: 'Migrated customization' } };
    const profiles = new EnrichmentProfiles({ repo, config }); profiles.initialize();
    assert.equal(repo.queuePage().items[0].profileRevisionId, undefined);
    assert.equal(profiles.activeProfile().systemPrompt, 'Migrated customization');
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM enrich_configurations').get().n, 0);
    assert.deepEqual(repo.initSchema().applied, []);
  } finally { repo.close(); }
});


test('Run all freezes one profile revision before selection, despite activation/edit/archive between jobs', async t => {
  const h = setup(t); const first = h.profiles.activeProfile();
  const second = h.profiles.create({ ...first, name:'Second', systemPrompt:'Second profile' });
  const a = await request(h.route, '/api/enrich/queue', {filters:{city:'Paris'}});
  const b = await request(h.route, '/api/enrich/queue', {filters:{city:'London'}});
  let searches = 0;
  h.immich.searchMetadata = async () => {
    searches++;
    if (searches === 1) {
      h.profiles.update(first.id, {...first, systemPrompt:'Edited after Run all', expectedRevisionId:first.revisionId});
      h.profiles.setActive(second.id); h.profiles.archive(first.id, true);
    }
    return {assets:{items:[{id:`photo${searches}`,type:'IMAGE'}],nextPage:null}};
  };
  const run = await request(h.route, '/api/enrich/queue/run-all', {expectedActiveRevisionId:first.revisionId, plan:[a.body.id,b.body.id].map(id=>({id,skipAnySuccessful:false}))});
  assert.equal(run.status,202);
  for(let i=0;i<100 && h.repo.queuePage().total;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(h.repo.queuePage().total,0); assert.equal(h.calls.length,2);
  assert.deepEqual(h.repo.listJobRuns().map(r=>r.profile.revisionId),[first.revisionId,first.revisionId]);
  assert.ok(h.calls.every(c=>c.messages[0].content===first.systemPrompt));
  assert.equal(h.profiles.activeProfile().id,second.id);
});

test('stale active selections and stale start requests cannot run another profile silently', async t => {
  const h = setup(t); const first=h.profiles.activeProfile();
  const second=h.profiles.create({...first,name:'Second'});
  const activated=await request(h.route,'/api/enrich/profiles/active',{profileId:second.id,expectedActiveRevisionId:first.revisionId});
  assert.equal(activated.status,200);
  assert.equal((await request(h.route,'/api/enrich/profiles/active',{profileId:first.id,expectedActiveRevisionId:first.revisionId})).status,409);
  const q=await request(h.route,'/api/enrich/queue',{filters:{city:'Paris'}});
  for(const [path,body] of [['/api/enrich/run',{assetIds:['a1']}],[`/api/enrich/queue/${q.body.id}/run`,{}],['/api/enrich/queue/run-all',{plan:[{id:q.body.id}]}]]) {
    const result=await request(h.route,path,{...body,expectedActiveRevisionId:first.revisionId});
    assert.equal(result.status,409); assert.match(result.body.error.message,/active profile changed/);
  }
  assert.equal(h.calls.length,0); assert.equal(h.runner.isBusy(),false);
  assert.equal((await request(h.route,'/api/enrich/run',{profileId:first.id})).status,400);
});


test('an untouched preview starter is renamed once without rewriting old attribution or copying content', t => {
  const { profiles, repo } = setup(t); const initial = profiles.activeProfile();
  // Simulate the earlier preview's initial record, before the starter rename.
  repo.db.prepare("UPDATE enrich_profiles SET name = 'Default' WHERE id = ?").run(initial.id);
  repo.db.prepare("UPDATE enrich_profile_revisions SET name = 'Default' WHERE id = ?").run(initial.revisionId);
  const other = profiles.create({ ...initial, name: 'Default' });
  profiles.initialize();
  const renamed = profiles.activeProfile();
  assert.equal(renamed.id, initial.id); assert.equal(renamed.name, 'My profile');
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.systemPrompt, initial.systemPrompt);
  assert.equal(renamed.userTemplate, initial.userTemplate);
  assert.deepEqual(renamed.taxonomy, initial.taxonomy);
  assert.equal(profiles.revision(initial.revisionId).name, 'Default');
  assert.equal(profiles.get(other.id).name, 'Default');
  profiles.initialize(); assert.equal(profiles.activeProfile().revisionId, renamed.revisionId);
});

test('startup preserves edited starter names and avoids creating duplicate My profile names', t => {
  const { profiles, repo } = setup(t); const initial = profiles.activeProfile();
  const edited = profiles.update(initial.id, { ...initial, name: 'Default', systemPrompt: 'Custom instructions', expectedRevisionId: initial.revisionId });
  profiles.initialize(); assert.equal(profiles.activeProfile().revisionId, edited.revisionId);
  assert.equal(profiles.activeProfile().name, 'Default');
  repo.db.prepare('UPDATE enrich_profiles SET current_revision_id = ? WHERE id = ?').run(initial.revisionId, initial.id);
  repo.db.prepare("UPDATE enrich_profile_revisions SET name = 'Default' WHERE id = ?").run(initial.revisionId);
  profiles.create({ ...initial, name: 'My profile' });
  profiles.initialize(); assert.equal(profiles.activeProfile().name, 'Default');
});
