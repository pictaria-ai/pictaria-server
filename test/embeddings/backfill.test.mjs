import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { EMBEDDING_LIMITS, EmbeddingService } from '../../src/embeddings/service.mjs';
import { BACKFILL_LIMITS, EmbeddingBackfill } from '../../src/embeddings/backfill.mjs';
import { startFakeMl } from './fakeMl.mjs';

const serviceLimits = { ...EMBEDDING_LIMITS, calibrationWaitMs: 200, settleMs: 200, testTimeoutMs: 2_000 };
const backfillLimits = { ...BACKFILL_LIMITS, enrichPollMs: 20, drainMs: 1_000 };

async function withBackfill(work, { enabled = true, url = null, immichReady = () => true, limits = backfillLimits } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-embedding-backfill-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const ml = await startFakeMl();
  const config = { enrichEmbeddings: { enabled, url: url ?? ml.url, model: 'ViT-B-32__openai' } };
  const service = new EmbeddingService({ repo, config, limits: serviceLimits });
  const downloads = [];
  const immich = {
    fail: new Set(),
    async getAssetThumbnail(id, size, { signal } = {}) {
      signal?.throwIfAborted();
      downloads.push(id);
      if (immich.fail.has(id)) throw new Error('preview not found');
      return { data: Buffer.from(`preview-${id}`), contentType: 'image/jpeg' };
    },
  };
  const log = [];
  const backfill = new EmbeddingBackfill({ service, immich, immichReady, log: (message) => log.push(message), limits });
  try {
    await work({ repo, ml, config, service, backfill, immich, downloads, log });
  } finally {
    await backfill.close();
    await ml.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// An enriched photo has a successful enrichment (latest_success).
function photo(repo, id, { day = 1, enriched = true, missing = false, discarded = false } = {}) {
  repo.upsertAsset({ id, checksum: `sum-${id}`, thumbhash: `hash-${id}`, fileCreatedAt: `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z` });
  if (enriched) repo.db.prepare('INSERT OR REPLACE INTO latest_success (asset_id, run_id) VALUES (?, 1)').run(id);
  if (missing) repo.db.prepare("UPDATE assets SET missing_since='2026-09-20T00:00:00Z' WHERE asset_id=?").run(id);
  if (discarded) repo.db.prepare("UPDATE assets SET enrich_discarded_at='2026-09-20T00:00:00Z' WHERE asset_id=?").run(id);
}

const vectors = (repo) => repo.db.prepare('SELECT asset_id FROM asset_embeddings ORDER BY asset_id').all().map((row) => row.asset_id);
const job = (backfill) => backfill.status().backfill;

async function until(condition, { timeoutMs = 3_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('embeds enriched photos without a current embedding, newest capture first, and nothing else', async () => {
  await withBackfill(async ({ repo, ml, backfill, downloads, log }) => {
    photo(repo, 'a1', { day: 3 }); photo(repo, 'a2', { day: 1 }); photo(repo, 'a3', { day: 2 });
    photo(repo, 'never-enriched', { day: 4, enriched: false });
    photo(repo, 'gone', { day: 5, missing: true });
    photo(repo, 'discarded', { day: 6, discarded: true });
    assert.deepEqual(backfill.status().enriched, { total: 3, current: 0, missing: 3 });
    const started = backfill.start();
    assert.equal(started.running, true);
    await backfill.promise;
    assert.deepEqual(downloads, ['a1', 'a3', 'a2']);
    assert.deepEqual(vectors(repo), ['a1', 'a2', 'a3']);
    const done = job(backfill);
    assert.deepEqual({ state: done.state, total: done.total, done: done.done, embedded: done.embedded, failed: done.failed, running: done.running },
      { state: 'finished', total: 3, done: 3, embedded: 3, failed: 0, running: false });
    assert.deepEqual(backfill.status().enriched, { total: 3, current: 3, missing: 0 });
    assert.match(log.join('\n'), /finished — 3 embedded/);
    // Starting again with full coverage only checks the service.
    const requests = ml.state.requests.length;
    backfill.start();
    await backfill.promise;
    assert.equal(ml.state.requests.length, requests + 1, 'one calibration request, no photos');
    assert.equal(job(backfill).state, 'finished');
    assert.equal(job(backfill).embedded, 0);
  });
});

test('an Enrich run pauses the backfill, which then continues without repeating work', async () => {
  await withBackfill(async ({ repo, ml, service, backfill }) => {
    for (const [i, id] of ['a1', 'a2', 'a3'].entries()) photo(repo, id, { day: 3 - i });
    ml.state.delayMs = 150;
    backfill.start();
    await until(() => ml.state.inFlight === 1 && job(backfill).state === 'running' && ml.state.requests.length >= 2, { what: 'the first photo' });
    const enrich = service.session({});
    await until(() => job(backfill).state === 'waiting', { what: 'the backfill to wait' });
    assert.ok(ml.state.maxInFlight <= 1, 'never two predictions at once');
    await enrich.close({ cancelled: true });
    await backfill.promise;
    assert.equal(job(backfill).state, 'finished');
    assert.deepEqual(vectors(repo), ['a1', 'a2', 'a3']);
    assert.equal(job(backfill).embedded, 3, 'the interrupted photo is embedded once, after the run');
    assert.ok(ml.state.maxInFlight <= 1);
  });
});

test('photos that move behind the cursor or become missing while Enrich runs are embedded before it finishes', async () => {
  await withBackfill(async ({ repo, ml, service, backfill, downloads }) => {
    for (const [i, id] of ['a1', 'a2', 'a3', 'a4', 'a5'].entries()) photo(repo, id, { day: 5 - i });
    ml.state.delayMs = 150;
    backfill.start();
    await until(() => job(backfill).embedded === 1 && ml.state.inFlight === 1, { what: 'the second photo' });
    const enrich = service.session({});
    await until(() => job(backfill).state === 'waiting', { what: 'the backfill to wait' });
    // Meanwhile Enrich refreshes the oldest photo's capture time from Immich, so
    // it sorts ahead of the cursor, and enriches a new photo without an embedding.
    repo.db.prepare("UPDATE assets SET file_created_at='2026-09-28T12:00:00.000Z' WHERE asset_id='a5'").run();
    photo(repo, 'n1', { day: 29 });
    await enrich.close({ cancelled: true });
    await backfill.promise;
    const done = job(backfill);
    assert.deepEqual({ state: done.state, total: done.total, done: done.done, embedded: done.embedded },
      { state: 'finished', total: 6, done: 6, embedded: 6 });
    assert.deepEqual(vectors(repo), ['a1', 'a2', 'a3', 'a4', 'a5', 'n1']);
    assert.deepEqual(backfill.status().enriched, { total: 6, current: 6, missing: 0 });
    assert.deepEqual(downloads.slice(-2), ['n1', 'a5'], 'a second walk from the top finds them');
    assert.equal(downloads.filter((id) => id === 'a5').length, 1);
  }, { limits: { ...backfillLimits, pageSize: 2 } });
});

test('Stop keeps completed photos, writes nothing afterwards, and starting again continues', async () => {
  await withBackfill(async ({ repo, ml, backfill }) => {
    for (const [i, id] of ['a1', 'a2', 'a3', 'a4'].entries()) photo(repo, id, { day: 4 - i });
    ml.state.delayMs = 100;
    backfill.start();
    await until(() => job(backfill).embedded >= 1, { what: 'one embedded photo' });
    const stopped = await backfill.stop();
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.reason, 'you stopped it');
    const kept = vectors(repo).length;
    assert.ok(kept >= 1 && kept < 4);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(vectors(repo).length, kept, 'nothing is written after Stop');
    ml.state.delayMs = 0;
    backfill.start();
    await backfill.promise;
    assert.equal(job(backfill).state, 'finished');
    assert.equal(job(backfill).embedded, 4 - kept, 'only the photos still missing');
    assert.equal(vectors(repo).length, 4);
  });
});

test('server shutdown cancels a backfill promptly and nothing is written afterwards', async () => {
  await withBackfill(async ({ repo, ml, backfill }) => {
    photo(repo, 'a1'); photo(repo, 'a2', { day: 2 });
    ml.state.delayMs = 400;
    backfill.start();
    // The fake records a prediction when it answers: once the calibration has
    // answered, the next prediction in flight is the first photo's.
    await until(() => ml.state.requests.length === 1 && ml.state.inFlight === 1, { what: 'the first photo request' });
    const started = Date.now();
    await backfill.close();
    assert.ok(Date.now() - started < 1_500, 'close returns promptly');
    assert.equal(job(backfill).state, 'stopped');
    assert.equal(job(backfill).reason, 'the server stopped');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(vectors(repo), []);
    assert.throws(() => backfill.start(), { code: 'backfill_unavailable' });
  });
});

test('an unreadable preview is skipped; repeated failures stop the job with the reason', async () => {
  await withBackfill(async ({ repo, backfill, immich, downloads }) => {
    for (const [i, id] of ['a1', 'a2', 'a3'].entries()) photo(repo, id, { day: 3 - i });
    immich.fail.add('a2');
    backfill.start();
    await backfill.promise;
    assert.deepEqual({ state: job(backfill).state, embedded: job(backfill).embedded, failed: job(backfill).failed }, { state: 'finished', embedded: 2, failed: 1 });
    assert.equal(downloads.filter((id) => id === 'a2').length, 1, 'a skipped photo is not retried within the job');
    // Immich unreachable for every preview: stop instead of walking the list.
    for (let i = 0; i < 12; i++) { photo(repo, `b${i}`, { day: 10 + i }); immich.fail.add(`b${i}`); }
    backfill.start();
    await backfill.promise;
    assert.equal(job(backfill).state, 'stopped');
    assert.equal(job(backfill).failed, 10);
    assert.match(job(backfill).reason, /10 photos in a row could not be embedded/);
  });
  await withBackfill(async ({ repo, ml, backfill }) => {
    for (let i = 0; i < 6; i++) photo(repo, `c${i}`, { day: 10 - i });
    ml.state.delayMs = 50;
    backfill.start();
    await until(() => job(backfill).embedded >= 1, { what: 'one embedded photo' });
    ml.state.status = 500;
    await backfill.promise;
    assert.equal(job(backfill).state, 'stopped');
    assert.ok(job(backfill).failed >= 3);
    assert.ok(job(backfill).reason, 'the service failure is explained');
  });
});

test('refuses to start without the switch, a URL, Immich or enriched photos, or during a lab pass; a lab pass waits for it', async () => {
  await withBackfill(async ({ repo, backfill }) => {
    photo(repo, 'a1');
    assert.throws(() => backfill.start(), { code: 'ml_off' });
  }, { enabled: false });
  await withBackfill(async ({ repo, backfill }) => {
    photo(repo, 'a1');
    assert.throws(() => backfill.start(), { code: 'ml_not_configured' });
  }, { url: '' });
  await withBackfill(async ({ repo, backfill }) => {
    photo(repo, 'a1');
    assert.throws(() => backfill.start(), { code: 'immich_not_configured' });
  }, { immichReady: () => false });
  await withBackfill(async ({ repo, ml, service, backfill }) => {
    assert.throws(() => backfill.start(), { code: 'backfill_nothing' });
    photo(repo, 'a1'); photo(repo, 'a2', { day: 2 });
    const lab = service.labPass({});
    assert.throws(() => backfill.start(), { code: 'ml_busy' });
    await lab.close({ cancelled: true });
    ml.state.delayMs = 150;
    backfill.start();
    assert.throws(() => backfill.start(), { code: 'backfill_running' });
    await until(() => service.passActive(), { what: 'the backfill pass' });
    assert.throws(() => service.labPass({}), { code: 'ml_busy' });
    await backfill.stop();
  });
});

test('changing the model or turning embeddings off stops the job with the reason', async () => {
  await withBackfill(async ({ repo, ml, config, backfill }) => {
    for (const [i, id] of ['a1', 'a2', 'a3'].entries()) photo(repo, id, { day: 3 - i });
    ml.state.delayMs = 80;
    backfill.start();
    await until(() => job(backfill).embedded >= 1, { what: 'one embedded photo' });
    config.enrichEmbeddings.model = 'ViT-B-16-SigLIP__webli';
    await backfill.promise;
    assert.equal(job(backfill).state, 'stopped');
    assert.match(job(backfill).reason, /model changed/);
    config.enrichEmbeddings.model = 'ViT-B-32__openai';
    backfill.start();
    await until(() => job(backfill).state === 'running', { what: 'the restart' });
    config.enrichEmbeddings.enabled = false;
    await backfill.promise;
    assert.equal(job(backfill).state, 'stopped');
    assert.match(job(backfill).reason, /turned off/);
  });
});
