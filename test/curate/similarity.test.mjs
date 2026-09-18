import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateSimilaritySearch, SIMILARITY_LIMITS as limits } from '../../src/curate/similarity.mjs';
import { ImmichClient, ImmichApiError } from '../../src/immich.mjs';

const item = id => ({ id, type: 'IMAGE', privateMetadata: 'must not escape' });
function setup(t, respond, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'curate-similarity-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  for (const id of ['a', 'b', 'c']) {
    repo.upsertAsset({ id, fileCreatedAt: '2026-01-01T00:00:00Z' });
    repo.reviewListAdd([id], 'test');
  }
  const calls = [];
  const client = { baseUrl: 'http://synthetic', apiKey: 'synthetic-secret', async requestJson(path, args) {
    calls.push({ path, ...args }); return respond(args, calls.length);
  } };
  const curate = new CurateService({ repo, immich: client, metadataOptions: { automatic: false } });
  let now = 1_000_000;
  curate.similarity = new CurateSimilaritySearch({ curate, now: () => now, ...options });
  t.after(async () => { await curate.close(); repo.close(); rmSync(dir, { recursive: true, force: true }); });
  return { repo, curate, client, calls, search: curate.similarity, advance: ms => { now += ms; } };
}

test('one bounded search preserves global ranks, removes reference anywhere, and maps only selected photos', async t => {
  const items = [item('outside-1'), item('b'), item('a'), ...Array.from({ length: 48 }, (_, i) => item(`outside-${i + 2}`))];
  const { curate, calls } = setup(t, () => ({ assets: { items, nextPage: '2' } }));
  curate.lab.views.set('view', { expiresAt: Date.now() + 60000, groups: [[{ id: 'a', time: 1 }, { id: 'b', time: 2 }, { id: 'c', time: 3 }]] });
  const value = await curate.lab.similarityRanking('view', 0);
  assert.deepEqual(calls.map(({ path, method, body, maxBytes }) => ({ path, method, body, maxBytes })), [{
    path: '/search/smart', method: 'POST', body: { queryAssetId: 'a', type: 'IMAGE', visibility: 'timeline', size: 51, withExif: false }, maxBytes: limits.responseBytes,
  }]);
  assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(value.photos, [{ id: 'a', rank: null }, { id: 'b', rank: 2 }, { id: 'c', rank: null }]);
  assert.equal(value.referenceId, 'a'); assert.equal(value.returned, 50);
  assert.equal(value.limit, 50); assert.equal(value.cached, false); assert.ok(value.elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(value), /outside|privateMetadata|synthetic-secret/);
  const cached = await curate.lab.similarityRanking('view', 0);
  assert.equal(cached.cached, true); assert.equal(calls.length, 1);
  assert.equal(curate.repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
});

test('reference absent, short and empty results keep honest coverage without invented ranks', async t => {
  for (const n of [0, 3, 51]) await t.test(String(n), async t => {
    const { search } = setup(t, () => ({ assets: { items: Array.from({ length: n }, (_, i) => item(`p${i}`)) } }));
    const result = await search.search('a');
    assert.equal(result.ids.length, Math.min(n, 50));
    if (n) assert.equal(result.ids[0], 'p0');
  });
});

test('malformed pages fail as a whole and never become not-found ranks; failures back off without retry', async t => {
  for (const response of [{}, { assets: { items: null } }, { assets: { items: [item('a'), item('a')] } },
    { assets: { items: [{ id: 'b', type: 'VIDEO' }] } }, { assets: { items: [{ type: 'IMAGE' }] } },
    { assets: { items: Array.from({ length: 52 }, (_, i) => item(`p${i}`)) } }]) await t.test(JSON.stringify(response).slice(0, 80), async t => {
    const { search, calls, advance } = setup(t, () => response);
    await assert.rejects(search.search('a'), { code: 'similarity_invalid_response' });
    assert.equal(search.cache.size, 0);
    advance(limits.minIntervalMs);
    await assert.rejects(search.search('b'), { code: 'similarity_cooldown' });
    assert.equal(calls.length, 1);
  });
});

test('one lane across references; abort stops work and does not cache a late response', async t => {
  let release;
  const { search, calls } = setup(t, () => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController();
  const running = search.search('a', { signal: controller.signal });
  await assert.rejects(search.search('b'), { code: 'similarity_busy' });
  controller.abort();
  assert.equal(calls[0].signal.aborted, true);
  release({ assets: { items: [item('b')] } });
  await assert.rejects(running, /interrupted or timed out/);
  assert.equal(calls.length, 1); assert.equal(search.cache.size, 0);
});

test('cache has bounded size and lifetime; cached arrays cannot be mutated by callers', async t => {
  const { repo, search, calls, advance } = setup(t, () => ({ assets: { items: [item('b')] } }));
  const first = await search.search('a'); first.ids.push('injected');
  assert.deepEqual((await search.search('a')).ids, ['b']);
  advance(limits.cacheMs);
  assert.equal((await search.search('a')).cached, false);
  for (let i = 0; i < limits.cacheEntries; i++) {
    const id = `ref-${i}`; repo.upsertAsset({ id }); repo.reviewListAdd([id], 'test');
    advance(limits.minIntervalMs); await search.search(id);
  }
  assert.equal(search.cache.size, limits.cacheEntries);
  advance(limits.minIntervalMs);
  assert.equal((await search.search('a')).cached, false, 'oldest entry was evicted');
  assert.equal(calls.length, limits.cacheEntries + 3);
});

test('cached results are invalidated by connection/image changes and cannot bypass reference membership', async t => {
  const { repo, search, client, calls, advance } = setup(t, () => ({ assets: { items: [item('b')] } }));
  await search.search('a'); advance(limits.minIntervalMs);
  client.apiKey = 'changed-secret'; search.settingsChanged();
  assert.equal(search.cache.size, 0); await search.search('a'); advance(limits.minIntervalMs);
  repo.updateAssetVisuals('a', { thumbhash: 'changed' });
  assert.equal((await search.search('a')).cached, false);
  repo.db.prepare('DELETE FROM review_list WHERE asset_id=?').run('a');
  await assert.rejects(search.search('a'), { code: 'similarity_reference_changed' });
  assert.equal(calls.length, 3);
});

test('source or connection changes during a request withhold the response', async t => {
  for (const change of ['source', 'connection', 'close']) await t.test(change, async t => {
    let release;
    const { repo, search, client, calls } = setup(t, () => new Promise(resolve => { release = resolve; }));
    const running = search.search('a');
    let closing;
    if (change === 'source') repo.updateAssetVisuals('a', { thumbhash: 'changed' });
    if (change === 'connection') { client.baseUrl = 'http://changed'; search.settingsChanged(); }
    if (change === 'close') closing = search.close();
    if (change !== 'source') assert.equal(calls[0].signal.aborted, true);
    release({ assets: { items: [item('b')] } });
    await assert.rejects(running); await closing;
    assert.equal(search.cache.size, 0);
  });
});

test('lab rejects expired, oversized and single groups before any upstream work', async t => {
  const { curate, calls } = setup(t, () => { throw Error('unexpected request'); });
  curate.lab.views.set('view', { expiresAt: Date.now() + 60000, groups: [[{ id: 'a' }], Array(251).fill({ id: 'a' })] });
  await assert.rejects(curate.lab.similarityRanking('view', 0), /at least two/);
  await assert.rejects(curate.lab.similarityRanking('view', 1), /No photos were sampled/);
  await assert.rejects(curate.lab.similarityRanking('missing', 0), /expired/);
  assert.equal(calls.length, 0);
});

test('real HTTP adapter enforces response byte limit and whole-exchange deadline', async t => {
  for (const mode of ['oversize', 'timeout']) await t.test(mode, async t => {
    const { curate, search } = setup(t, () => {}, { timeoutMs: 20 });
    let attempts = 0;
    curate.immich = new ImmichClient({ baseUrl: 'http://synthetic', apiKey: 'secret', fetchImpl: async (url, args) => {
      attempts++;
      if (mode === 'oversize') return new Response(' '.repeat(limits.responseBytes + 1));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('deadline not applied')), 1000);
        args.signal.addEventListener('abort', () => { clearTimeout(timer); reject(args.signal.reason); }, { once: true });
      });
    } });
    await assert.rejects(search.search('a'), mode === 'timeout' ? /timed out/ : /Could not load/);
    assert.equal(attempts, 1); assert.equal(search.cache.size, 0);
  });
});

test('upstream errors give actionable messages without forwarding private diagnostics', async t => {
  for (const [status, expected] of [[400, /Smart Search/], [401, /asset.read/], [429, /Immich is busy/], [500, /Could not load/]]) await t.test(String(status), async t => {
    const { search, calls } = setup(t, () => { throw new ImmichApiError('private-photo-and-secret', status); });
    await assert.rejects(search.search('a'), error => { assert.match(error.message, expected); assert.doesNotMatch(error.message, /private-photo|secret/); return true; });
    assert.equal(calls.length, 1);
  });
});
