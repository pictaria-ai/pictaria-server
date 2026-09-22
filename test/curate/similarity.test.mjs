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

test('slow successful searches back off, then healthy responses restore two-second pacing', async t => {
  let elapsed = 0;
  const s = setup(t, (args, count) => {
    if (count === 1) { elapsed += 6000; s.advance(6000); }
    return { assets: { items: [item('b')] } };
  }, { elapsedNow: () => elapsed });
  await s.search.search('a');
  assert.equal(s.search.nextAt - s.search.now(), 6000);
  await assert.rejects(s.search.search('b'), { code: 'similarity_cooldown' });
  assert.equal((await s.search.search('a')).cached, true);
  s.advance(6000); await s.search.search('b');
  assert.equal(s.search.nextAt - s.search.now(), 2000);
  assert.equal(s.search.metrics.requests, 2);
  assert.equal(s.search.metrics.cacheHits, 1);
  assert.equal(s.search.metrics.searchMs, 6000);
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

function rankView(curate, ids) {
  curate.lab.views.set('rank-view', { expiresAt: Date.now() + 60000,
    groups: [ids.map((id, time) => ({ id, time }))] });
  return { viewId: 'rank-view', groupId: 0 };
}
async function rankPass(curate, body, signal = new AbortController().signal) {
  const plan = curate.lab.ranks.plan(body), events = [];
  await curate.lab.ranks.run({ ...body, admission: plan.admission }, { signal, emit: async value => events.push(value) });
  return { plan, events };
}

test('group rank passes admit eight new requests, keep directions distinct, and expose only selected ranks', async t => {
  const { curate, repo, calls, advance } = setup(t, args => ({ assets: { items: args.body.queryAssetId === 'a'
    ? [item('outside-private'), item('b')] : [item('a')] } }));
  const ids = ['a', 'b', 'c', ...Array.from({ length: 7 }, (_, i) => `more-${i}`)];
  for (const id of ids.slice(3)) { repo.upsertAsset({ id }); repo.reviewListAdd([id], 'test'); }
  const body = rankView(curate, ids);
  const waits = []; curate.lab.ranks.wait = async ms => { waits.push(ms); advance(ms); };
  const first = await rankPass(curate, body);
  assert.equal(first.plan.newSearches, 8); assert.equal(first.plan.remaining, 2);
  assert.equal(calls.length, 8); assert.deepEqual(waits, Array(7).fill(limits.minIntervalMs));
  const rows = first.events.filter(e => e.type === 'row').map(e => e.row);
  assert.equal(rows[0].photos.find(p => p.id === 'b').rank, 2);
  assert.equal(rows[1].photos.find(p => p.id === 'a').rank, 1);
  assert.equal(rows[0].photos.find(p => p.id === 'c').rank, null);
  assert.doesNotMatch(JSON.stringify(first), /outside-private|synthetic-secret|privateMetadata/);
  const second = await rankPass(curate, { ...body, completed: rows.map(r => r.referenceId), scope: first.plan.scope });
  assert.equal(second.plan.newSearches, 2); assert.equal(calls.length, 10);
  const cached = await rankPass(curate, body);
  assert.equal(cached.plan.newSearches, 0); assert.equal(cached.plan.cached, 10); assert.equal(calls.length, 10);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
});

test('rank admission rejects expired cache estimates, changed sources and forged completed scope before work', async t => {
  const { curate, repo, calls, advance, search } = setup(t, () => ({ assets: { items: [item('a'), item('b')] } }));
  const body = rankView(curate, ['a', 'b']);
  await search.search('a');
  const plan = curate.lab.ranks.plan(body);
  advance(limits.cacheMs);
  await assert.rejects(curate.lab.ranks.run({ ...body, admission: plan.admission }, {
    signal: new AbortController().signal, emit: async () => assert.fail('no stream before admission'),
  }), { code: 'lab_rank_estimate_changed' });
  assert.equal(calls.length, 1);
  assert.throws(() => curate.lab.ranks.plan({ ...body, completed: ['a'] }), { code: 'lab_rank_changed' });
  repo.updateAssetVisuals('a', { thumbhash: 'AQID' });
  assert.throws(() => curate.lab.ranks.plan({ ...body, scope: plan.scope }), { code: 'lab_rank_changed' });
});

test('cancel between rank requests stops the pass; one lane is reserved even while pacing', async t => {
  const { curate, calls, search } = setup(t, () => ({ assets: { items: [item('a'), item('b')] } }));
  const body = rankView(curate, ['a', 'b', 'c']), controller = new AbortController();
  curate.lab.ranks.wait = async (_ms, signal) => {
    await assert.rejects(search.search('c'), { code: 'similarity_busy' });
    await assert.rejects(rankPass(curate, body), { code: 'similarity_busy' });
    controller.abort(); signal.throwIfAborted();
  };
  await assert.rejects(rankPass(curate, body, controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 1); assert.equal(search.owner, null);
});

test('rank failure stops without retry and changed connection cannot leak mixed-library evidence', async t => {
  const { curate, calls, advance, client, search } = setup(t, (_args, n) => {
    if (n === 2) throw Error('private backend error');
    return { assets: { items: [item('a')] } };
  });
  const body = rankView(curate, ['a', 'b', 'c']);
  curate.lab.ranks.wait = async ms => advance(ms);
  const { events } = await rankPass(curate, body);
  assert.equal(calls.length, 2); assert.equal(events.at(-1).stopped, true);
  assert.equal(events.filter(e => e.type === 'row').at(-1).row.state, 'failed');
  assert.doesNotMatch(JSON.stringify(events), /private backend error/);
  assert.equal(search.owner, null);
  const plan = curate.lab.ranks.plan(body);
  await assert.rejects(curate.lab.ranks.run({ ...body, admission: plan.admission }, {
    signal: new AbortController().signal, emit: async event => { if (event.type === 'start') client.apiKey = 'replacement-secret'; },
  }), { code: 'lab_rank_changed' });
  assert.equal(calls.length, 2); assert.equal(search.owner, null);
});

test('oversized rank groups are rejected without sampling; expired views and shutdown stop passes', async t => {
  const { curate, calls, search } = setup(t, () => ({ assets: { items: [] } }));
  const body = rankView(curate, Array.from({ length: 41 }, (_, i) => `p${i}`));
  assert.throws(() => curate.lab.ranks.plan(body), { code: 'lab_rank_size' });
  rankView(curate, ['a', 'b']);
  curate.lab.ranks.wait = async () => { await search.close(); };
  await assert.rejects(rankPass(curate, body), { name: 'AbortError' });
  assert.equal(calls.length, 1); assert.equal(search.owner, null);
  curate.lab.views.clear();
  assert.throws(() => curate.lab.ranks.plan(body), { code: 'lab_expired' });
});
