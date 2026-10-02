import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateSimilaritySearch } from '../../src/curate/similarity.mjs';
import { embeddingEvidence, stackEmbeddingPolicy } from '../../src/curate/embedding-evidence.mjs';
import { EMBEDDING_BACKEND } from '../../src/embeddings/models.mjs';
import { CALIBRATION_VERSION } from '../../src/embeddings/calibration.mjs';

// End to end through the Curate service and its read-only rebuild worker.
async function setup(t, { n = 3, config = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'curate-embeddings-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  const ids = Array.from({ length: n }, (_, i) => `p${i}`), calls = [];
  for (const [i, id] of ids.entries()) {
    repo.upsertAsset({ id, checksum: `sum-${id}`, fileCreatedAt: new Date(1767225600000 + i * 1000).toISOString() });
    repo.reviewListAdd([id], 'test');
  }
  let now = Date.now();
  const settings = { curateBurstGrouping: true, enrichEmbeddings: { enabled: true, model: 'ViT-B-32__openai' }, ...config };
  const immich = { baseUrl: 'http://synthetic', apiKey: 'synthetic', async requestJson(path, args) {
    calls.push({ path, ...args });
    return { assets: { items: ids.map(id => ({ id, type: 'IMAGE' })) } };
  } };
  const curate = new CurateService({ repo, config: settings, immich, metadataOptions: { automatic: false },
    candidateOptions: { enabled: true, now: () => now, embeddingRecheckMs: 0 } });
  curate.similarity = new CurateSimilaritySearch({ curate, now: () => now });
  curate.start = () => {};
  t.after(async () => { await curate.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); });
  const space = repo.embeddings.resolveSpace({ backend: EMBEDDING_BACKEND, model: 'ViT-B-32__openai',
    calibrationVersion: CALIBRATION_VERSION, calibration: [1, 0, 0, 0] });
  const embed = (id, vector) => repo.embeddings.save({ assetId: id, spaceId: space.id, source: repo.embeddings.sourceOf(id),
    imageSha256: createHash('sha256').update(`${id}:${vector}`).digest('hex'), vector });
  const searchAll = async () => {
    for (let i = 0; i < 8; i++) { await curate.refinement.tick(); now += 5000; await curate.refresh(); }
  };
  return { repo, curate, config: settings, ids, calls, space, embed, searchAll };
}
// Unit vectors: A·B = 0.95 (very similar); C is clearly different from both.
const A = [1, 0, 0, 0], B = [0.95, Math.sqrt(1 - 0.95 ** 2), 0, 0], C = [0.5, 0, Math.sqrt(0.75), 0];
const sizes = view => view.groups.map(g => g.memberCount).sort((a, b) => b - a);

test('Curate Preview stacks with image embeddings and searches nothing for embedded photos', async t => {
  const s = await setup(t);
  s.embed('p0', A); s.embed('p1', B); s.embed('p2', C);
  const view = await s.curate.openView();
  assert.equal(s.curate.current.method, 'candidate-4');
  assert.deepEqual(sizes(view), [2, 1]);
  await s.searchAll();
  assert.equal(s.calls.length, 0, 'no Immich searches');

  s.config.curateEmbeddingStacks = false;
  const off = await s.curate.openView();
  assert.equal(s.curate.current.method, 'candidate-3', 'switching it off restores candidate-3');
  assert.deepEqual(sizes(off), [3]);
  await s.searchAll();
  assert.ok(s.calls.length > 0, 'candidate-3 searches the time window');
});

test('an embedding that arrives later re-checks a settled time window without new searches', async t => {
  const s = await setup(t);
  s.embed('p0', A); s.embed('p1', B);
  await s.curate.openView();
  await s.searchAll();
  const searched = s.calls.length;
  assert.ok(searched > 0, 'the photo without an embedding is searched');
  assert.deepEqual(sizes(await s.curate.openView()), [3], 'reciprocal ranks support p2 under candidate-3 rules');
  assert.equal(s.curate.refinement.saved.settled.size, 1, 'the grouping is saved');

  s.embed('p2', C);
  assert.deepEqual(sizes(await s.curate.openView()), [2, 1], 'p2 is now clearly different');
  await s.searchAll();
  assert.equal(s.calls.length, searched, 'saved search evidence is reused');
});

test('an uncalibrated model, Image embeddings off or no stored set keep candidate-3', async t => {
  const s = await setup(t);
  s.embed('p0', A); s.embed('p1', B); s.embed('p2', C);
  await s.curate.openView();
  assert.equal(s.curate.current.method, 'candidate-4');
  s.config.enrichEmbeddings.model = 'ViT-B-16-SigLIP__webli';
  await s.curate.openView();
  assert.equal(s.curate.current.method, 'candidate-3');
  s.config.enrichEmbeddings = { enabled: false, model: 'ViT-B-32__openai' };
  await s.curate.openView();
  assert.equal(s.curate.current.method, 'candidate-3');
  assert.equal(stackEmbeddingPolicy({ enrichEmbeddings: { enabled: true, model: 'ViT-B-32__openai' } }, { latestSpace: () => null }), null);
});

test('the embedding evidence reads current vectors and notices a replaced one', async t => {
  const s = await setup(t);
  s.embed('p0', A); s.embed('p1', B);
  const policy = stackEmbeddingPolicy(s.config, s.repo.embeddings);
  assert.deepEqual({ model: policy.model, spaceId: policy.spaceId, near: policy.near, far: policy.far, average: policy.average },
    { model: 'ViT-B-32__openai', spaceId: s.space.id, near: 0.9, far: 0.75, average: 0.8 });
  const evidence = embeddingEvidence(s.repo.db, policy);
  evidence.prepare(['p0', 'p1', 'p2']);
  assert.ok(Math.abs(evidence.similarity('p0', 'p1') - 0.95) < 0.002, 'float16 storage keeps the similarity');
  assert.equal(evidence.similarity('p0', 'p2'), null, 'no vector is unknown');
  const before = evidence.signature(['p0', 'p1', 'p2']);
  s.embed('p2', C);
  assert.notEqual(embeddingEvidence(s.repo.db, policy).signature(['p0', 'p1', 'p2']), before);
  // An edited photo's vector is out of date, so it is unknown again.
  s.repo.db.prepare("UPDATE assets SET checksum='edited' WHERE asset_id='p1'").run();
  const edited = embeddingEvidence(s.repo.db, policy);
  edited.prepare(['p0', 'p1']);
  assert.equal(edited.similarity('p0', 'p1'), null);
});
