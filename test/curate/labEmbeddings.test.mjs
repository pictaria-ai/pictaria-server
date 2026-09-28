import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessPair, combinedPartition, COMBINED_DEFAULTS } from '../../public/curate/combined-evidence.js';
import { partition } from '../../public/curate/stacking-model.js';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { LabEmbeddings } from '../../src/curate/lab-embeddings.mjs';
import { EMBEDDING_LIMITS, EmbeddingService } from '../../src/embeddings/service.mjs';
import { startFakeMl } from '../embeddings/fakeMl.mjs';

const hash = (byte) => Buffer.alloc(21, byte).toString('base64');
const photo = (id, time, byte = 0, category = null) => ({ id, time, thumbhash: byte === null ? null : hash(byte), peopleCategory: category });
const ids = (groups) => groups.map((g) => g.map((p) => p.id));
const table = (entries) => {
  const values = new Map(entries.map(([a, b, v]) => [[a, b].sort().join('|'), v]));
  return (a, b) => values.get([a, b].sort().join('|')) ?? null;
};

test('individual filters require every pair to reach the embedding threshold; missing embeddings cannot pass', () => {
  const photos = [photo('a', 0), photo('b', 1000), photo('c', 2000)];
  const similarity = table([['a', 'b', 0.96], ['a', 'c', 0.7], ['b', 'c', 0.93]]);
  const settings = { gapMs: 15000, embeddings: true, embeddingThreshold: 0.9, embeddingSimilarity: similarity };
  const result = partition(photos, settings);
  assert.deepEqual(ids(result.groups), [['a', 'b'], ['c']], 'b–c alone cannot chain c to a');
  assert.match(result.reasons.get('c'), /embedding difference/);
  assert.deepEqual(ids(partition(photos, { ...settings, embeddingThreshold: 0.6 }).groups), [['a', 'b', 'c']]);
  const partial = partition(photos, { ...settings, embeddingSimilarity: table([['a', 'b', 0.99]]) });
  assert.deepEqual(ids(partial.groups), [['a', 'b'], ['c']]);
  assert.match(partial.reasons.get('c'), /embedding unavailable/);
  assert.equal(partition(photos, { gapMs: 15000, embeddingSimilarity: similarity }).groups.length, 1, 'rule off');
  assert.throws(() => partition(photos, { ...settings, embeddingThreshold: 2 }), /Invalid/);
});

test('combined mode: very similar embeddings support alone, the middle band needs independent corroboration', () => {
  const base = { ...COMBINED_DEFAULTS, gapMs: 15000, thumbhash: true, people: true, embeddings: true };
  const a = photo('a', 0, 0, 'one'), b = photo('b', 1000, 255, 'one'), c = photo('c', 2000, null, null);
  // Very similar embeddings recover a coarse-hash difference only when the hash is not clearly different.
  assert.deepEqual(assessPair(a, c, { ...base, embeddingSimilarity: table([['a', 'c', 0.97]]) }),
    { state: 'supported', reason: 'Very similar embeddings without observed conflict', notes: ['ThumbHash unknown', 'Enrich people unknown', 'Embedding 0.970 (very similar)'] });
  assert.equal(assessPair(a, b, { ...base, embeddingSimilarity: table([['a', 'b', 0.97]]) }).reason, 'ThumbHash and embeddings disagree');
  // The middle band needs people agreement or a middle-band hash, not search ranks.
  const middle = table([['a', 'b', 0.9]]);
  assert.equal(assessPair(a, b, { ...base, thumbhash: false, embeddingSimilarity: middle }).state, 'supported');
  assert.equal(assessPair(a, b, { ...base, thumbhash: false, people: false, embeddingSimilarity: middle }).state, 'uncertain');
  const rows = new Map(['a', 'b'].map(id => [id, { state: 'complete', photos: [{ id, rank: null }, { id: id === 'a' ? 'b' : 'a', rank: 1 }] }]));
  const ranked = assessPair(a, b, { ...base, thumbhash: false, people: false, ranks: true, embeddingSimilarity: middle }, rows);
  assert.equal(ranked.state, 'uncertain');
  assert.match(ranked.reason, /may come from the same model/);
  // Unknown stays unknown.
  assert.equal(assessPair(a, c, { ...base, embeddingSimilarity: table([]) }).state, 'uncertain');
});

test('combined mode: clearly different embeddings corroborate separation but never separate alone', () => {
  const base = { ...COMBINED_DEFAULTS, gapMs: 15000, thumbhash: true, people: true, embeddings: true };
  const solo = photo('solo', 0, 0, 'one'), couple = photo('couple', 1000, 0, 'couple'), landscape = photo('landscape', 2000, 255, null);
  const far = table([['solo', 'couple', 0.7], ['solo', 'landscape', 0.6], ['couple', 'landscape', 0.6]]);
  // Same backdrop (identical hash) with a people-category change and distant embeddings.
  assert.deepEqual(assessPair(solo, couple, { ...base, embeddingSimilarity: far }).state, 'separate');
  assert.equal(assessPair(solo, couple, { ...base, embeddingSimilarity: far }).reason, 'Clearly different embeddings corroborate a people difference');
  // Without the embedding rule the same pair stays uncertain: close hash, conflicting people.
  assert.equal(assessPair(solo, couple, { ...base, embeddings: false }).state, 'uncertain');
  // Clearly different embeddings and ThumbHash together separate.
  assert.equal(assessPair(solo, landscape, { ...base, people: false, embeddingSimilarity: far }).reason, 'Clearly different embeddings and ThumbHash');
  // Alone they do not.
  const alone = assessPair(solo, photo('x', 3000, null, null), { ...base, embeddingSimilarity: table([['solo', 'x', 0.5]]) });
  assert.deepEqual([alone.state, alone.reason], ['uncertain', 'Clearly different embeddings need corroboration']);
  // Very similar embeddings contradicting people evidence stay uncertain.
  assert.equal(assessPair(solo, couple, { ...base, embeddingSimilarity: table([['solo', 'couple', 0.99]]) }).reason,
    'Very similar embeddings conflict with people evidence');
  const result = combinedPartition([solo, couple, landscape], { ...base, embeddingSimilarity: far });
  assert.deepEqual(ids(result.groups), [['solo'], ['couple'], ['landscape']]);
  assert.throws(() => combinedPartition([solo, couple], { ...base, nearEmbedding: 0.8, farEmbedding: 0.9, embeddingSimilarity: far }), /ordered embedding bands/);
});

test('with embeddings off the combined rules are unchanged, whatever similarities exist', () => {
  const base = { ...COMBINED_DEFAULTS, gapMs: 15000, thumbhash: true, people: true };
  const photos = [photo('a', 0, 0, 'one'), photo('b', 1000, 40, 'one'), photo('c', 2000, 255, 'couple')];
  const similarity = table([['a', 'b', 0.2], ['a', 'c', 0.99], ['b', 'c', 0.99]]);
  const off = combinedPartition(photos, base), ignored = combinedPartition(photos, { ...base, embeddingSimilarity: similarity });
  assert.deepEqual(ids(ignored.groups), ids(off.groups));
  for (const [x, y] of [['a', 'b'], ['a', 'c'], ['b', 'c']]) assert.deepEqual(ignored.pair(x, y), off.pair(x, y));
});

async function labFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-lab-embeddings-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  const ml = await startFakeMl();
  const config = { curateBurstGrouping: false, enrichEmbeddings: { enabled: false, url: ml.url, model: 'ViT-B-32__openai' } };
  const curate = new CurateService({ repo, config });
  const downloads = [];
  curate.immich = { async getAssetThumbnail(id, size, { signal } = {}) {
    signal?.throwIfAborted();
    downloads.push(`${size}:${id}`);
    return { data: Buffer.from(`preview-${id}`), contentType: 'image/jpeg' };
  } };
  const service = new EmbeddingService({ repo, config, limits: { ...EMBEDDING_LIMITS, calibrationWaitMs: 1_000, settleMs: 1_000 } });
  const lab = new LabEmbeddings(curate.lab, service);
  const add = (id, time) => {
    repo.upsertAsset({ id, originalPath: `/synthetic/${id}.jpg`, checksum: `sum-${id}`, fileCreatedAt: new Date(time).toISOString(), thumbhash: hash(0) });
    repo.reviewListAdd([id], 'test');
  };
  for (const [i, id] of ['a', 'b', 'c'].entries()) add(id, i * 1000);
  t.after(async () => { await curate.close(); await ml.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const view = await curate.lab.open();
  return { repo, ml, config, curate, service, lab, downloads, view, body: { viewId: view.viewId, groupId: 0 } };
}

async function collect(lab, body) {
  const events = [];
  await lab.run(body, { signal: new AbortController().signal, emit: async (event) => { events.push(event); } });
  return events;
}

test('a lab pass embeds only missing photos, stores them permanently and reports pairwise similarity', async (t) => {
  const { repo, ml, config, lab, downloads, body } = await labFixture(t);
  const plan = lab.plan(body);
  assert.deepEqual({ configured: plan.configured, enrichEnabled: plan.enrichEnabled, total: plan.total, current: plan.current,
    missing: plan.missing, newEmbeddings: plan.newEmbeddings, space: plan.space },
  { configured: true, enrichEnabled: false, total: 3, current: 0, missing: 3, newEmbeddings: 3, space: null });
  assert.deepEqual(plan.similarity, { ids: ['a', 'b', 'c'], values: [null, null, null] });
  assert.equal(ml.predictions(), 0, 'planning never contacts the service');

  await assert.rejects(lab.run({ ...body, admission: 'stale' }, { signal: new AbortController().signal, emit: async () => {} }), /estimate changed/);
  const events = await collect(lab, { ...body, admission: plan.admission });
  assert.deepEqual(events.map((e) => e.type), ['start', 'calibrating', 'space', 'progress', 'photo', 'progress', 'photo', 'progress', 'photo', 'done']);
  assert.deepEqual(events[2], { type: 'space', created: true, replacesEarlier: false, dims: 512, current: 0, newEmbeddings: 3, remaining: 0 });
  assert.deepEqual(events.filter((e) => e.type === 'photo').map((e) => e.outcome), ['embedded', 'embedded', 'embedded']);
  assert.equal(events.at(-1).message, 'Pass complete.');
  assert.deepEqual(downloads, ['preview:a', 'preview:b', 'preview:c']);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 3);
  const after = lab.plan(body);
  assert.equal(after.current, 3);
  assert.equal(after.space.dims, 512);
  assert.ok(after.similarity.values.every((value) => typeof value === 'number' && value >= -1 && value <= 1));
  assert.equal(after.newEmbeddings, 0);
  assert.equal(config.enrichEmbeddings.enabled, false, 'the pass needs no automatic Enrich switch');

  // A photo that changes in Immich loses its current vector; the next pass embeds only it.
  repo.upsertAsset({ id: 'b', originalPath: '/synthetic/b.jpg', checksum: 'sum-b', fileCreatedAt: new Date(1000).toISOString(), thumbhash: hash(9) });
  const stale = lab.plan(body);
  assert.deepEqual([stale.current, stale.missing], [2, 1]);
  assert.deepEqual(stale.similarity.values.map((v) => v === null), [true, false, true]);
  const before = ml.predictions();
  const again = await collect(lab, { ...body, admission: stale.admission });
  assert.deepEqual(again.filter((e) => e.type === 'photo').map((e) => [e.assetId, e.outcome]), [['b', 'current']],
    'identical preview bytes are adopted without a request');
  assert.equal(ml.predictions(), before + 1, 'only the calibration');
});

test('a lab pass needs a machine-learning URL, yields to Enrich and stops cleanly on service failure', async (t) => {
  const { ml, config, service, lab, body } = await labFixture(t);
  config.enrichEmbeddings.url = '';
  assert.equal(lab.plan(body).configured, false);
  await assert.rejects(collect(lab, { ...body, admission: lab.plan(body).admission }), /Set the Immich machine-learning URL/);
  config.enrichEmbeddings.url = ml.url;
  config.enrichEmbeddings.enabled = true;
  const enrich = service.session();
  assert.equal(lab.plan(body).busy, true);
  await assert.rejects(collect(lab, { ...body, admission: lab.plan(body).admission }), /An Enrich run is embedding photos/);
  await enrich.close({ cancelled: true });
  const enrichSummary = service.lastSession;
  ml.state.status = 503;
  const failed = await collect(lab, { ...body, admission: lab.plan(body).admission });
  assert.equal(failed.at(-1).type, 'done');
  assert.equal(failed.at(-1).stopped, true);
  assert.match(failed.at(-1).message, /temporarily unavailable/);
  assert.equal(service.active.size, 0, 'the pass released the machine-learning service');
  assert.equal(service.lastSession, enrichSummary, 'lab passes do not replace the last Enrich run summary');
});

test('cancelling a lab pass stops further requests and keeps completed photos', async (t) => {
  const { repo, ml, lab, body } = await labFixture(t);
  Object.assign(ml.state, { slowAfter: 2, slowMs: 400 });
  const controller = new AbortController();
  const events = [];
  const running = lab.run({ ...body, admission: lab.plan(body).admission }, { signal: controller.signal, emit: async (event) => {
    events.push(event);
    if (event.type === 'photo') controller.abort();
  } });
  await assert.rejects(running);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 1);
  assert.equal(ml.predictions(), 2, 'calibration and the first photo only');
});

const count = (repo, table) => repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('closing Curate cancels a lab pass during calibration: prompt, released, and nothing written later', async (t) => {
  const { repo, ml, curate, service, lab, body } = await labFixture(t);
  curate.lab.embeddings = lab;
  Object.assign(ml.state, { slowAfter: 0, slowMs: 800 });
  let calibrating;
  const reached = new Promise((resolve) => { calibrating = resolve; });
  const running = lab.run({ ...body, admission: lab.plan(body).admission }, { signal: new AbortController().signal,
    emit: async (event) => { if (event.type === 'calibrating') calibrating(); } });
  running.catch(() => {});
  await reached;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = Date.now();
  await curate.close();
  assert.ok(Date.now() - started < 1_500, 'close does not wait for the slow calibration');
  await assert.rejects(running);
  assert.equal(service.active.size, 0, 'the pass released its ownership');
  assert.equal(service.lane.busy, false);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(count(repo, 'embedding_spaces'), 0, 'no space is created after close');
  assert.equal(count(repo, 'asset_embeddings'), 0);
  await assert.rejects(lab.run({ ...body, admission: 'x' }, { signal: new AbortController().signal, emit: async () => {} }), /stopping/);
});

test('closing Curate cancels a lab pass mid-photo: no vector is written after close returns', async (t) => {
  const { repo, ml, curate, service, lab, body } = await labFixture(t);
  curate.lab.embeddings = lab;
  Object.assign(ml.state, { slowAfter: 1, slowMs: 800 });
  let photoStarted;
  const reached = new Promise((resolve) => { photoStarted = resolve; });
  const running = lab.run({ ...body, admission: lab.plan(body).admission }, { signal: new AbortController().signal,
    emit: async (event) => { if (event.type === 'progress') photoStarted(); } });
  running.catch(() => {});
  await reached;
  await new Promise((resolve) => setTimeout(resolve, 50));
  await curate.close();
  assert.equal(service.active.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(count(repo, 'embedding_spaces'), 1, 'the calibration finished before close');
  assert.equal(count(repo, 'asset_embeddings'), 0, 'the delayed photo answer was discarded');
});

test('recheck at full coverage detects a changed service, rebuilds the worklist, and returns to a stored space', async (t) => {
  const { repo, ml, lab, body } = await labFixture(t);
  const pass = async () => {
    const plan = lab.plan(body);
    const events = await collect(lab, { ...body, admission: plan.admission });
    return { plan, events, space: events.find((e) => e.type === 'space'), done: events.at(-1) };
  };
  const first = await pass();
  assert.equal(first.plan.missing, 3);
  assert.equal(lab.plan(body).current, 3);

  // Full coverage: plans stay free of requests, but the recheck calibrates.
  const full = lab.plan(body);
  assert.deepEqual([full.missing, full.newEmbeddings], [0, 0]);
  let before = ml.predictions();
  const unchanged = await pass();
  assert.deepEqual(unchanged.space, { type: 'space', created: false, replacesEarlier: false, dims: 512, current: 3, newEmbeddings: 0, remaining: 0 });
  assert.match(unchanged.done.message, /Checked: every photo in this group already has a current embedding/);
  assert.equal(ml.predictions(), before + 1, 'only the calibration');

  // The service's preprocessing changes under the same model name.
  ml.state.variant = 1;
  assert.equal(lab.plan(body).current, 3, 'plans alone cannot know; the recheck finds out');
  const changed = await pass();
  assert.deepEqual([changed.space.created, changed.space.replacesEarlier, changed.space.newEmbeddings], [true, true, 3]);
  assert.equal(changed.events.filter((e) => e.type === 'photo').length, 3);
  const afterChange = lab.plan(body);
  assert.deepEqual([afterChange.current, afterChange.missing], [3, 0]);
  assert.equal(count(repo, 'embedding_spaces'), 2);

  // Returning to the earlier output reuses its stored vectors without requests.
  ml.state.variant = 0;
  before = ml.predictions();
  const returned = await pass();
  assert.deepEqual([returned.space.created, returned.space.current, returned.space.newEmbeddings], [false, 3, 0]);
  assert.equal(ml.predictions(), before + 1);
  assert.equal(count(repo, 'embedding_spaces'), 2);

  // Partial coverage into a new space embeds every photo that space lacks,
  // not just the photos the pre-calibration estimate counted.
  repo.db.prepare("DELETE FROM asset_embeddings WHERE asset_id='c'").run();
  const partialPlan = lab.plan(body);
  assert.deepEqual([partialPlan.current, partialPlan.missing], [2, 1]);
  ml.state.variant = 2;
  const partial = await pass();
  assert.deepEqual([partial.space.created, partial.space.newEmbeddings], [true, 3]);
  assert.equal(partial.events.filter((e) => e.type === 'photo').length, 3);
  assert.equal(partial.done.message, 'Pass complete.');
  assert.equal(lab.plan(body).current, 3);
});
