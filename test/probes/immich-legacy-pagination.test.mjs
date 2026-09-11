import test from 'node:test';
import assert from 'node:assert/strict';
import { collectByDate, inspectOffset, ProofIncomplete, timestamp } from '../../scripts/probes/immich-legacy-pagination.mjs';

const iso = ms => new Date(Date.UTC(2024, 0, 1) + ms).toISOString();
const photo = (id, ms) => ({ id, type: 'IMAGE', fileCreatedAt: iso(ms) });
function upstream(assets, { orderTies = true } = {}) {
  const calls = [];
  return { calls, search: async body => {
    calls.push(body);
    const lo = body.takenAfter ? timestamp(body.takenAfter).ns : null;
    const hi = body.takenBefore ? timestamp(body.takenBefore).ns : null;
    const selected = assets.filter(a => {
      const time = timestamp(a.fileCreatedAt).ns;
      return (lo === null || time >= lo) && (hi === null || time <= hi);
    });
    // Shuffle ties on every request, as a database is free to do without a
    // secondary ORDER BY. The filtered set itself stays fixed.
    const pivot = orderTies ? calls.length % Math.max(1, assets.length) : 0;
    selected.sort((a, b) => {
      const delta = timestamp(b.fileCreatedAt).ns - timestamp(a.fileCreatedAt).ns;
      return delta ? (delta > 0n ? 1 : -1)
        : (assets.indexOf(a) + pivot) % assets.length - (assets.indexOf(b) + pivot) % assets.length;
    });
    const offset = (body.page - 1) * body.size;
    return { assets: { items: selected.slice(offset, offset + body.size),
      nextPage: selected.length > offset + body.size ? String(body.page + 1) : null } };
  } };
}

test('complete covering search retrieves reordered ties and only requests page one', async () => {
  const assets = Array.from({ length: 80 }, (_, i) => photo(`photo-${i}`, Math.floor(i / 3) * 10));
  const mock = upstream(assets);
  const result = await collectByDate({ search: mock.search, size: 10 });
  assert.deepEqual(result.ids, new Set(assets.map(a => a.id)));
  assert.ok(result.boundaryRepeats > 0);
  assert.ok(mock.calls.every(c => c.page === 1));
});

test('a partial first page with omissions and no duplicates is never treated as complete', async () => {
  const assets = Array.from({ length: 31 }, (_, i) => photo(`p-${i}`, i * 10));
  const mock = upstream(assets);
  const result = await collectByDate({ search: mock.search, size: 5 });
  assert.equal(result.ids.size, 31);
  assert.ok(result.completeWindows > 1);
});

test('empty and exact full terminal pages finish without a speculative second page', async () => {
  for (const count of [0, 1, 10]) {
    const mock = upstream(Array.from({ length: count }, (_, i) => photo(`p-${i}`, 0)));
    const result = await collectByDate({ search: mock.search, size: 10 });
    assert.equal(result.ids.size, count);
    assert.equal(result.requests, 1);
  }
});

test('multiple exact-size pages with distinct dates remain complete', async () => {
  const mock = upstream(Array.from({ length: 20 }, (_, i) => photo(`p-${i}`, i * 10)));
  assert.equal((await collectByDate({ search: mock.search, size: 10 })).ids.size, 20);
});

test('timestamp ties larger than a page fail in bounded work without returning partial IDs', async () => {
  const mock = upstream([photo('old', -10), ...Array.from({ length: 11 }, (_, i) => photo(`p-${i}`, 0)), photo('new', 10)]);
  await assert.rejects(collectByDate({ search: mock.search, size: 10, maxRequests: 16 }), /indivisible millisecond/);
  assert.ok(mock.calls.length <= 16);
});

test('inclusive splits preserve sub-millisecond photos instead of subtracting a millisecond', async () => {
  const assets = [photo('old', -10), photo('exact', 0),
    { ...photo('micro', 0), fileCreatedAt: '2024-01-01T00:00:00.000123Z' },
    photo('next', 1), photo('new', 10)];
  const result = await collectByDate({ search: upstream(assets).search, size: 3 });
  assert.deepEqual(result.ids, new Set(assets.map(a => a.id)));
});

test('an oversized sub-millisecond group fails rather than dropping hidden precision', async () => {
  const assets = Array.from({ length: 11 }, (_, i) => ({ ...photo(`p-${i}`, 0),
    fileCreatedAt: `2024-01-01T00:00:00.000${String(i).padStart(3, '0')}Z` }));
  await assert.rejects(collectByDate({ search: upstream(assets).search, size: 10 }), /indivisible millisecond/);
});

test('caller date bounds and all other filter semantics are passed through', async () => {
  const assets = Array.from({ length: 30 }, (_, i) => photo(`p-${i}`, i * 10));
  const mock = upstream(assets);
  const filters = { takenAfter: iso(50), takenBefore: iso(200), tagIds: ['tag'], personIds: ['person'],
    albumIds: ['album'], visibility: null, withDeleted: false, withPeople: true, city: 'Example' };
  const result = await collectByDate({ search: mock.search, filters, size: 5 });
  assert.equal(result.ids.size, 16);
  for (const call of mock.calls) {
    for (const [key, value] of Object.entries(filters)) {
      if (!['takenAfter', 'takenBefore'].includes(key)) assert.deepEqual(call[key], value);
    }
    assert.ok(Date.parse(call.takenAfter) >= Date.parse(filters.takenAfter));
    assert.ok(Date.parse(call.takenBefore) <= Date.parse(filters.takenBefore));
  }
});

test('unsafe query precision and pagination overrides are rejected before a request', async () => {
  for (const filters of [{ takenAfter: '2024-01-01T00:00:00.000123Z' }, { page: 2 }, { size: 2000 }, { order: 'asc' }]) {
    await assert.rejects(collectByDate({ search: () => assert.fail('must not request'), filters }), ProofIncomplete);
  }
});

test('invalid page shapes, duplicates, ordering and dates fail closed', async () => {
  for (const response of [
    {}, { assets: { items: [] } },
    { assets: { items: [photo('a', 0), photo('a', 0)], nextPage: null } },
    { assets: { items: [photo('a', 0), photo('b', 10)], nextPage: null } },
    { assets: { items: [{ id: 'a', type: 'IMAGE' }], nextPage: null } },
    { assets: { items: [], nextPage: '2' } },
  ]) await assert.rejects(collectByDate({ search: async () => response }), ProofIncomplete);
});

test('upstream ignoring date bounds fails closed', async () => {
  const response = { assets: { items: [photo('outside', 10)], nextPage: null } };
  await assert.rejects(collectByDate({ search: async () => response, filters: { takenBefore: iso(0) } }), /outside/);
});

test('request, item and elapsed-time limits discard the partial traversal', async () => {
  const assets = Array.from({ length: 30 }, (_, i) => photo(`p-${i}`, i * 10));
  await assert.rejects(collectByDate({ search: upstream(assets).search, size: 5, maxRequests: 2 }), /request limit/);
  await assert.rejects(collectByDate({ search: upstream(assets).search, size: 5, maxItems: 4 }), /response-item limit/);
  let tick = 0;
  await assert.rejects(collectByDate({ search: upstream(assets).search, size: 5, timeoutMs: 2, now: () => tick++ }), /deadline/);
});

test('a later request failure does not yield earlier complete windows', async () => {
  const mock = upstream(Array.from({ length: 20 }, (_, i) => photo(`p-${i}`, i * 10)));
  let requests = 0;
  await assert.rejects(collectByDate({ size: 5, search: async body => {
    if (++requests === 4) throw new Error('network failure');
    return mock.search(body);
  } }), /network failure/);
});

test('stable secondary ordering on newer servers needs no special treatment in the proof', async () => {
  const assets = Array.from({ length: 40 }, (_, i) => photo(`p-${i}`, Math.floor(i / 2) * 10));
  const result = await collectByDate({ search: upstream(assets, { orderTies: false }).search, size: 10 });
  assert.deepEqual(result.ids, new Set(assets.map(a => a.id)));
});

test('offset comparator independently checks boundary groups and reports omitted members', async () => {
  const assets = [photo('new', 10), photo('a', 0), photo('b', 0), photo('c', 0), photo('d', 0), photo('old', -10)];
  const mock = upstream(assets);
  const diagnostic = await inspectOffset({ expectedIds: new Set(assets.map(a => a.id)), size: 5,
    filters: {}, search: async body => {
      if (body.page === 1 && !body.takenAfter && !body.takenBefore) {
        return { assets: { items: [assets[0], assets[1], assets[2], assets[3], assets[4]], nextPage: '2' } };
      }
      if (body.page === 2) {
        // Synthetic offset drift repeats a previously seen photo and omits
        // the last one. Independent bounded queries still expose the source.
        return { assets: { items: [assets[4]], nextPage: null } };
      }
      return mock.search(body);
    } });
  assert.equal(diagnostic.repeatedEntries, 1);
  assert.equal(diagnostic.dateOnly, 1);
  assert.equal(diagnostic.offsetOnly, 0);
  assert.equal(diagnostic.missingFromDate, 0);
  assert.ok(diagnostic.boundaryGroups.some(g => g.photos === 4));
});

test('a timestamp moving between complete windows is detected when the ID repeats', async () => {
  let count = 0;
  await assert.rejects(collectByDate({ size: 2, search: async () => {
    count++;
    if (count === 1) return { assets: { items: [photo('new', 10), photo('moved', 0)], nextPage: '2' } };
    if (count === 2) return { assets: { items: [photo('new', 10), photo('moved', 0)], nextPage: null } };
    return { assets: { items: [photo('moved', -10)], nextPage: null } };
  } }), /changing metadata/);
});
