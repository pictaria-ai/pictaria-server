import test from 'node:test';
import assert from 'node:assert/strict';
import { readMetadataAssets, albumReadConfig } from '../../src/albums/metadataSearch.mjs';
import { needsLegacyMetadataTraversal, legacyMetadataWindows, captureTimestamp } from '../../src/albums/legacyMetadataTraversal.mjs';
import { searchAllAssets, runSmartAlbumJob } from '../../src/albums/smartAlbums.mjs';

const origin = Date.UTC(2024, 0, 1);
const iso = ms => new Date(origin + ms).toISOString();
const config = { searchPageSize: 250, maxSearchPages: 25 };
const makeAsset = (i, ms = i * 10, extra = {}) => ({ id: `asset-${String(i).padStart(6, '0')}`,
  type: 'IMAGE', fileCreatedAt: iso(ms), visibility: 'timeline', ...extra });

function mockLibrary(assets, version = { major: 2, minor: 7, patch: 5 }) {
  const calls = [], mutations = [];
  const memberships = new Set();
  function selected(body) {
    const visibility = body.visibility ?? (version?.major === 2 ? 'timeline' : null);
    return assets.filter(asset => (!visibility || asset.visibility === visibility)
      && (!body.albumIds || memberships.has(asset.id))
      && (!body.tagIds || body.tagIds.some(id => asset.tagIds?.includes(id)))
      && (!body.personIds || body.personIds.every(id => asset.people?.some(person => person.id === id)))
      && (!body.city || asset.city === body.city)
      && (!body.country || asset.country === body.country)
      && (!body.takenAfter || Date.parse(asset.fileCreatedAt) >= Date.parse(body.takenAfter))
      && (!body.takenBefore || Date.parse(asset.fileCreatedAt) <= Date.parse(body.takenBefore)));
  }
  return {
    calls, mutations, memberships, assets,
    async getServerVersion() { calls.push({ version: true }); return version; },
    async listTags() { return [{ id: 'exclude', value: 'frame/never-show' }]; },
    async searchMetadata(body) {
      calls.push({ metadata: body });
      const rows = selected(body);
      // Alternate tie order without moving distinct timestamps out of order.
      const direction = calls.length % 2 ? 1 : -1;
      rows.sort((a, b) => Date.parse(b.fileCreatedAt) - Date.parse(a.fileCreatedAt)
        || direction * a.id.localeCompare(b.id));
      const start = (body.page - 1) * body.size;
      return { assets: { items: rows.slice(start, start + body.size),
        nextPage: rows.length > start + body.size ? String(body.page + 1) : null } };
    },
    async searchStatistics(body) { calls.push({ statistics: body }); return { total: selected(body).length }; },
    async addAssetsToAlbum(id, ids) { mutations.push({ add: ids }); for (const asset of ids) memberships.add(asset); return ids.map(id => ({ id, success: true })); },
    async removeAssetsFromAlbum(id, ids) { mutations.push({ remove: ids }); for (const asset of ids) memberships.delete(asset); return ids.map(id => ({ id, success: true })); },
  };
}

function jobStore(job) {
  return { async getJob() { return job; }, async updateJob(id, update) { Object.assign(job, update(job)); return job; } };
}
function job(extra = {}) { return { id: 'job', albumId: 'album', albumName: 'Fixture', query: '',
  filters: { tagIds: ['include'] }, includeAllResults: true, maxResults: null, smart: true, enabled: true,
  intervalDays: 1, ...extra }; }

test('version boundary is isolated: older, unknown and prerelease use legacy; stable >=3.1 use offset', () => {
  for (const version of [null, { major: 2, minor: 7, patch: 5 }, { major: 3, minor: 0, patch: 3 },
    { major: 3, minor: 1, patch: 0, prerelease: 1 }]) assert.equal(needsLegacyMetadataTraversal(version), true);
  for (const version of [{ major: 3, minor: 1, patch: 0 }, { major: 3, minor: 2, patch: 0 },
    { major: 4, minor: 0, patch: 0 }]) assert.equal(needsLegacyMetadataTraversal(version), false);
});

test('legacy requests page one at size 1000 and retrieves the complete set despite reordered ties', async () => {
  const assets = Array.from({ length: 3600 }, (_, i) => makeAsset(i, Math.floor(i / 6) * 10));
  const immich = mockLibrary(assets);
  const result = await readMetadataAssets({ immich, config, filters: { visibility: 'timeline' } });
  assert.equal(result.complete, true);
  assert.deepEqual(new Set(result.assets.map(a => a.id)), new Set(assets.map(a => a.id)));
  assert.ok(immich.calls.filter(c => c.metadata).every(c => c.metadata.page === 1 && c.metadata.size === 1000));
  assert.equal(immich.calls.filter(c => c.statistics).length, 1);
  assert.equal(immich.calls.filter(c => c.version).length, 1);
});

test('modern offset traversal retains configured size and strict repeated-ID detection', async () => {
  const immich = mockLibrary(Array.from({ length: 750 }, (_, i) => makeAsset(i)), { major: 3, minor: 1, patch: 0 });
  const result = await readMetadataAssets({ immich, config, filters: { visibility: 'timeline' } });
  assert.equal(result.assets.length, 750);
  assert.deepEqual(immich.calls.filter(c => c.metadata).map(c => c.metadata.page), [1, 2, 3]);
  assert.ok(!immich.calls.some(c => c.statistics));
  immich.searchMetadata = async body => ({ assets: { items: [makeAsset(1)], nextPage: body.page === 1 ? '2' : null } });
  await assert.rejects(readMetadataAssets({ immich, config, filters: {} }), /repeated asset entries/);
});

test('unknown version selects the safe traversal; network and auth errors do not masquerade as unknown', async () => {
  const immich = mockLibrary([makeAsset(1)]);
  immich.getServerVersion = async () => ({ unexpected: true });
  assert.equal((await readMetadataAssets({ immich, config, filters: { visibility: 'timeline' } })).assets.length, 1);
  immich.getServerVersion = async () => { throw Object.assign(new Error('absent'), { status: 404 }); };
  assert.equal((await readMetadataAssets({ immich, config, filters: { visibility: 'timeline' } })).assets.length, 1);
  for (const error of [new Error('network failure'), Object.assign(new Error('rejected'), { status: 403 })]) {
    immich.getServerVersion = async () => { throw error; };
    const before = immich.calls.length;
    await assert.rejects(readMetadataAssets({ immich, config, filters: {} }), e => e === error);
    assert.equal(immich.calls.length, before);
  }
});

test('all-visibility legacy reads include archive and hidden and count each partition separately', async () => {
  const immich = mockLibrary(['timeline', 'archive', 'hidden'].map((visibility, i) => makeAsset(i, i, { visibility })));
  const result = await readMetadataAssets({ immich, config, filters: {} });
  assert.equal(result.assets.length, 3);
  assert.deepEqual(immich.calls.filter(c => c.metadata).map(c => c.metadata.visibility), ['timeline', 'archive', 'hidden']);
  assert.equal(immich.calls.filter(c => c.statistics).length, 3);
});

test('count mismatch retries once and discards the first result', async () => {
  const immich = mockLibrary([makeAsset(1)]);
  let counts = 0;
  immich.searchStatistics = async () => ({ total: ++counts === 1 ? 2 : 1 });
  const result = await readMetadataAssets({ immich, config, filters: { visibility: 'timeline' } });
  assert.equal(result.assets.length, 1);
  assert.equal(counts, 2);
  assert.equal(immich.calls.filter(c => c.metadata).length, 2);
});

test('persistent mismatch or invalid statistics yields no add-only result', async () => {
  for (const value of [2, null, 'not-a-count', -1]) {
    const immich = mockLibrary([makeAsset(1)]);
    immich.searchStatistics = async () => ({ total: value });
    await assert.rejects(readMetadataAssets({ immich, config, filters: { visibility: 'timeline' }, allowPartial: true }), /count/);
  }
});

test('Top-N uses stable ordering within ties and compares the full raw window count', async () => {
  const assets = Array.from({ length: 1500 }, (_, i) => makeAsset(i, Math.floor(i / 6) * 10));
  const immich = mockLibrary(assets);
  const expected = assets.toSorted((a, b) => Date.parse(b.fileCreatedAt) - Date.parse(a.fileCreatedAt) || b.id.localeCompare(a.id)).slice(0, 5);
  const result = await readMetadataAssets({ immich, config, filters: { visibility: 'timeline' }, limit: 5 });
  assert.deepEqual(result.assets.map(a => a.id), expected.map(a => a.id));
  assert.equal(result.complete, true);
  assert.equal(result.truncated, true);
  assert.ok(immich.calls.find(c => c.statistics).statistics.takenAfter);
});

test('people-only filtering happens after the statistics comparison and can fill a capped selection', async () => {
  const assets = Array.from({ length: 20 }, (_, i) => makeAsset(i, i, { people: i % 2 ? [{ id: 'p' }] : [{ id: 'p' }, { id: 'other' }] }));
  const immich = mockLibrary(assets);
  const result = await searchAllAssets({ immich, config, filters: { personIds: ['p'], peopleOnly: true }, maxResults: 5 });
  assert.equal(result.assets.length, 5);
  assert.ok(result.assets.every(a => a.people.length === 1));
  const countBody = immich.calls.find(c => c.statistics).statistics;
  assert.deepEqual(countBody.personIds, ['p']);
  assert.equal(Object.hasOwn(countBody, 'withPeople'), false);
});

test('legacy query variants preserve tag AND/OR and caller date limits', async () => {
  const assets = [makeAsset(1, 10, { tagIds: ['a'] }), makeAsset(2, 20, { tagIds: ['b'] }),
    makeAsset(3, 30, { tagIds: ['a', 'b'] }), makeAsset(4, 40, { tagIds: ['a', 'b'] })];
  for (const [mode, expected] of [['all', [3]], ['any', [1, 3, 2]]]) {
    const result = await searchAllAssets({ immich: mockLibrary(assets), config, maxResults: null,
      filters: { tagIds: ['a', 'b'], tagMatchMode: mode, takenBefore: iso(30) } });
    assert.deepEqual(new Set(result.assets.map(a => a.id)), new Set(expected.map(i => makeAsset(i).id)));
  }
});

test('an oversized timestamp group fails closed without modifying an album', async () => {
  const immich = mockLibrary(Array.from({ length: 1200 }, (_, i) => makeAsset(i, 0, { tagIds: ['include'] })));
  const saved = job();
  await assert.rejects(runSmartAlbumJob({ immich, config, jobId: saved.id, store: jobStore(saved) }), /capture times too close/);
  assert.equal(immich.mutations.length, 0);
});

test('bounded matching may return completed windows as incomplete, but strict reads fail', async () => {
  const assets = Array.from({ length: 12000 }, (_, i) => makeAsset(i));
  for (const allowPartial of [true, false]) {
    const immich = mockLibrary(assets);
    const read = readMetadataAssets({ immich, config: { ...config, maxSearchPages: 1 },
      filters: { visibility: 'timeline' }, allowPartial });
    if (allowPartial) {
      const result = await read;
      assert.equal(result.complete, false);
      assert.ok(result.assets.length > 0 && result.assets.length < assets.length);
    } else await assert.rejects(read, /request.*limit/);
  }
});

test('failed exclusions and failed membership never allow additions or removals', async () => {
  for (const failure of ['exclusions', 'membership']) {
    const immich = mockLibrary([makeAsset(1, 0, { tagIds: ['include'] })]);
    const original = immich.searchStatistics;
    immich.searchStatistics = async body => {
      if (failure === 'exclusions' && body.tagIds?.includes('exclude') || failure === 'membership' && body.albumIds) {
        return { total: 1234 };
      }
      return original(body);
    };
    const saved = job();
    await assert.rejects(runSmartAlbumJob({ immich, config, jobId: saved.id, store: jobStore(saved) }), /counts changed/);
    assert.equal(immich.mutations.length, 0);
  }
});

test('a controlled album adds matches, removes excluded/archive members, and uses one version lookup', async () => {
  const assets = [makeAsset(1, 10, { tagIds: ['include'] }), makeAsset(2, 20, { tagIds: ['include', 'exclude'] }),
    makeAsset(3, 30, { tagIds: ['include', 'exclude'], visibility: 'archive' }),
    makeAsset(4, 40, { tagIds: ['include', 'exclude'], visibility: 'hidden' })];
  const immich = mockLibrary(assets);
  for (const asset of assets.slice(1)) immich.memberships.add(asset.id);
  const saved = job();
  await runSmartAlbumJob({ immich, config, jobId: saved.id, store: jobStore(saved) });
  assert.deepEqual(immich.memberships, new Set([assets[0].id]));
  assert.equal(immich.calls.filter(c => c.version).length, 1);
});

test('the shared budget bounds work across calls, partitions and retries', async () => {
  const immich = mockLibrary([]);
  const shared = albumReadConfig(config);
  await assert.rejects(async () => {
    for (let i = 0; i < 300; i++) await readMetadataAssets({ immich, config: shared, filters: { visibility: 'timeline' } });
  }, /request or time limit/);
  assert.ok(immich.calls.length <= 500);
});

test('partial matching adds verified candidates but preserves existing nonmatching members', async () => {
  const assets = Array.from({ length: 12000 }, (_, i) => makeAsset(i, i * 10, { tagIds: ['include'] }));
  const retained = makeAsset(20000, -10, { tagIds: [] });
  const immich = mockLibrary([...assets, retained]);
  immich.memberships.add(retained.id);
  const saved = job();
  await runSmartAlbumJob({ immich, config: { ...config, maxSearchPages: 1 }, jobId: saved.id, store: jobStore(saved) });
  assert.equal(saved.lastResult.reconciliationComplete, false);
  assert.ok(immich.memberships.size > 1);
  assert.ok(immich.memberships.has(retained.id));
  assert.ok(!immich.mutations.some(mutation => mutation.remove));
});

test('the legacy iterator covers microsecond timestamps even when responses truncate them', async () => {
  const source = Array.from({ length: 3600 }, (_, i) => {
    const ms = Math.floor(i / 6) * 10;
    const micro = i % 6;
    return { asset: makeAsset(i, ms), ns: BigInt(origin + ms) * 1_000_000n + BigInt(micro) * 1000n };
  });
  for (const truncatedResponse of [true, false]) {
    const found = new Set();
    let requests = 0;
    const windows = legacyMetadataWindows({ filters: {}, fetchPage: async body => {
      requests++;
      const lo = body.takenAfter ? captureTimestamp(body.takenAfter).ns : null;
      const hi = body.takenBefore ? captureTimestamp(body.takenBefore).ns : null;
      const rows = source.filter(row => (lo === null || row.ns >= lo) && (hi === null || row.ns <= hi))
        .sort((a, b) => a.ns > b.ns ? -1 : a.ns < b.ns ? 1 : 0);
      return { items: rows.slice(0, 1000).map(row => ({ ...row.asset,
        fileCreatedAt: truncatedResponse ? row.asset.fileCreatedAt
          : row.asset.fileCreatedAt.replace('Z', `${String(Number(row.ns % 1_000_000n / 1000n)).padStart(3, '0')}Z`) })),
      nextPage: rows.length > 1000 ? 2 : null };
    } });
    for await (const window of windows) for (const asset of window.items) found.add(asset.id);
    assert.equal(found.size, source.length);
    assert.ok(requests < 30);
  }
});

test('an exact full single-millisecond page completes; a larger one fails before partial reconciliation', async () => {
  const immich = mockLibrary(Array.from({ length: 1000 }, (_, i) => makeAsset(i, 0)));
  const result = await readMetadataAssets({ immich, config, filters: { visibility: 'timeline' } });
  assert.equal(result.assets.length, 1000);
  assert.equal(immich.calls.filter(c => c.metadata).length, 1);
  immich.assets.push(makeAsset(1001, 0));
  await assert.rejects(readMetadataAssets({ immich, config, filters: { visibility: 'timeline' }, allowPartial: true }), /capture times too close/);
});

test('legacy missing dates, ignored bounds and unexpectedly changing timestamps fail closed', async () => {
  const immich = mockLibrary([makeAsset(1)]);
  immich.searchMetadata = async () => ({ assets: { items: [{ id: 'missing', type: 'IMAGE' }], nextPage: null } });
  await assert.rejects(readMetadataAssets({ immich, config, filters: {} }), /capture timestamp/);
  immich.searchMetadata = async () => ({ assets: { items: [makeAsset(1, 10)], nextPage: null } });
  await assert.rejects(readMetadataAssets({ immich, config, filters: { takenBefore: iso(0) } }), /bounds/);
  let calls = 0;
  await assert.rejects(async () => {
    const windows = legacyMetadataWindows({ filters: {}, fetchPage: async () => {
      calls++;
      if (calls <= 2) return { items: Array.from({ length: 1000 }, (_, i) => makeAsset(999 - i, (999 - i) * 10)),
        nextPage: calls === 1 ? 2 : null };
      return { items: [makeAsset(0, -10)], nextPage: null };
    } });
    for await (const window of windows) { /* consume without mutating */ }
  }, /changed or overlapped/);
});

test('elapsed-time limits are checked after a request as well as before it', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock += 200_000);
  await assert.rejects(readMetadataAssets({ immich: mockLibrary([]), config, filters: {} }), /time limit/);
});
