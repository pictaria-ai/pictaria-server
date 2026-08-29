import test from 'node:test';
import assert from 'node:assert/strict';

import { extractAssets } from '../../src/immich.mjs';
import {
  MAX_SMART_ALBUM_FILTER_ITEMS,
  MAX_SMART_ALBUM_ID_LENGTH,
  MAX_SMART_ALBUM_UPSTREAM_REQUESTS,
  assertSmartAlbumWorkBudget,
  computeNextRunAt,
  createSmartAlbumJob,
  getSearchValidationError,
  jobIsDue,
  normalizeFilters,
  runSmartAlbumJob,
  searchAllAssets,
  validateCreateRequest,
  validateJobPatch,
} from '../../src/albums/smartAlbums.mjs';

function createMemoryStore() {
  return {
    jobs: [],
    async addJob(job) {
      this.jobs.push(job);
      return job;
    },
    async updateJob(jobId, updater) {
      const index = this.jobs.findIndex((job) => job.id === jobId);
      if (index === -1) {
        return null;
      }

      this.jobs[index] = { ...this.jobs[index], ...updater(this.jobs[index]) };
      return this.jobs[index];
    },
  };
}

test('extractImmichAssets supports Immich search response shapes', () => {
  assert.deepEqual(extractAssets([{ id: 'a' }]).map((asset) => asset.id), ['a']);
  assert.deepEqual(extractAssets({ assets: { items: [{ id: 'b' }] } }).map((asset) => asset.id), ['b']);
  assert.deepEqual(extractAssets({ items: [{ id: 'c' }] }).map((asset) => asset.id), ['c']);
  assert.deepEqual(extractAssets({ assets: [{ id: 'd' }] }).map((asset) => asset.id), ['d']);
});

test('validateCreateRequest trims required fields and rounds interval', () => {
  const validation = validateCreateRequest({
    query: '  landscapes ',
    albumName: '  Landscapes ',
    smart: true,
    intervalDays: 6.7,
    maxResults: 49.6,
  });

  assert.equal(validation.error, undefined);
  assert.deepEqual(validation.value, {
    query: 'landscapes',
    albumName: 'Landscapes',
    smart: true,
    bestOf: false,
    intervalDays: 7,
    includeAllResults: false,
    maxResults: 50,
    filters: {
      people: [],
      personIds: [],
      peopleMatchMode: 'all',
      peopleOnly: false,
      tags: [],
      tagIds: [],
      tagMatchMode: 'all',
      excludeTags: [],
      excludeTagIds: [],
      excludeTagValues: [],
      excludeTagsConfigured: false,
      city: null,
      cities: [],
      state: null,
      country: null,
      countries: [],
      make: null,
      model: null,
      takenAfter: null,
      takenBefore: null,
    },
  });
});

test('validateCreateRequest rejects invalid smart interval', () => {
  const validation = validateCreateRequest({
    query: 'landscapes',
    albumName: 'Landscapes',
    smart: true,
    intervalDays: 0,
  });

  assert.match(validation.error, /between 1 and 365/);
});

test('validateCreateRequest rejects invalid top photo limit', () => {
  const validation = validateCreateRequest({
    query: 'landscapes',
    albumName: 'Landscapes',
    maxResults: 0,
  });

  assert.match(validation.error, /Top photo limit/);
});

test('Smart Album requests bound every filter collection and identifier', () => {
  const tooManyPeople = validateCreateRequest({
    albumName: 'Crowd',
    filters: {
      personIds: Array.from({ length: MAX_SMART_ALBUM_FILTER_ITEMS + 1 }, (_, index) => `person-${index}`),
    },
  });
  assert.match(tooManyPeople.error, /personIds is limited/);

  const longId = validateCreateRequest({
    albumName: 'Long id',
    filters: { tagIds: ['x'.repeat(MAX_SMART_ALBUM_ID_LENGTH + 1)] },
  });
  assert.match(longId.error, /tagIds entry is limited/);
});

test('normalization deduplicates in linear first-seen order', () => {
  const normalized = normalizeFilters({
    people: [
      { id: 'p2', name: 'First P2' },
      { id: 'p1', name: 'P1' },
      { id: 'p2', name: 'Second P2' },
    ],
    personIds: ['p1', 'p3', 'p2'],
    cities: ['Tokyo', 'Paris', 'Tokyo'],
  });
  assert.deepEqual(normalized.personIds, ['p2', 'p1', 'p3']);
  assert.equal(normalized.people[0].name, 'First P2');
  assert.deepEqual(normalized.cities, ['Tokyo', 'Paris']);
});

test('calculated Smart Album work is rejected before expansion', () => {
  const filters = normalizeFilters({
    peopleMatchMode: 'any',
    personIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    cities: ['A', 'B', 'C', 'D', 'E'],
  });
  assert.throws(
    () => assertSmartAlbumWorkBudget({ config: { maxSearchPages: 25 }, filters }),
    new RegExp(`limit is ${MAX_SMART_ALBUM_UPSTREAM_REQUESTS}`),
  );
});

test('excessive calculated work reaches neither Immich nor persistence', async () => {
  let immichCalls = 0;
  const immich = new Proxy({}, {
    get() {
      return async () => {
        immichCalls += 1;
        throw new Error('Immich must not be called');
      };
    },
  });
  const store = createMemoryStore();
  await assert.rejects(
    createSmartAlbumJob({
      immich,
      store,
      config: { searchPageSize: 1000, maxSearchPages: 25 },
      input: {
        query: '',
        albumName: 'Too expensive',
        smart: true,
        bestOf: false,
        intervalDays: 7,
        includeAllResults: true,
        maxResults: null,
        filters: {
          peopleMatchMode: 'any',
          personIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
          cities: ['A', 'B', 'C', 'D', 'E'],
        },
      },
    }),
    /upstream requests/,
  );
  assert.equal(immichCalls, 0);
  assert.deepEqual(store.jobs, []);
});

test('validateCreateRequest ignores top photo limit when all results are enabled', () => {
  const validation = validateCreateRequest({
    query: 'landscapes',
    albumName: 'Landscapes',
    includeAllResults: true,
    maxResults: 0,
  });

  assert.equal(validation.error, undefined);
  assert.equal(validation.value.includeAllResults, true);
  assert.equal(validation.value.maxResults, null);
});

test('validateCreateRequest allows filter-only albums', () => {
  const validation = validateCreateRequest({
    albumName: 'Denver',
    filters: {
      city: 'Denver',
      takenAfter: '2024-01-01',
    },
  });

  assert.equal(validation.error, undefined);
  assert.equal(validation.value.query, '');
  assert.equal(validation.value.filters.city, 'Denver');
  assert.equal(validation.value.filters.takenAfter, '2024-01-01T00:00:00.000Z');
});

test('validateCreateRequest allows tag-only albums', () => {
  const validation = validateCreateRequest({
    albumName: 'AI Tags',
    filters: {
      tags: [{ id: 'tag-1', name: 'Beach', value: 'AI/Beach' }],
    },
  });

  assert.equal(validation.error, undefined);
  assert.deepEqual(validation.value.filters.tagIds, ['tag-1']);
  assert.equal(validation.value.filters.tags[0].value, 'AI/Beach');
});

test('validateCreateRequest rejects empty search and filters', () => {
  const validation = validateCreateRequest({
    albumName: 'Empty',
  });

  assert.match(validation.error, /ranked search or at least one structured filter/);
});

test('validateCreateRequest rejects people OR with ranked search', () => {
  const validation = validateCreateRequest({
    query: 'landscapes',
    albumName: 'People OR',
    filters: {
      peopleMatchMode: 'any',
      people: [
        { id: 'person-1', name: 'Alicia' },
        { id: 'person-2', name: 'David' },
      ],
    },
  });

  assert.match(validation.error, /People OR/);
});

test('validateCreateRequest rejects people only with ranked search', () => {
  const validation = validateCreateRequest({
    query: 'portraits',
    albumName: 'Alicia Only',
    filters: {
      peopleOnly: true,
      people: [{ id: 'person-1', name: 'Alicia' }],
    },
  });

  assert.match(validation.error, /Only this person/);
});

test('validateCreateRequest rejects people only without exactly one person', () => {
  const validation = validateCreateRequest({
    albumName: 'Only',
    filters: {
      peopleOnly: true,
      people: [
        { id: 'person-1', name: 'Alicia' },
        { id: 'person-2', name: 'David' },
      ],
    },
  });

  assert.match(validation.error, /exactly one selected person/);
});

test('validateJobPatch allows enable and interval changes', () => {
  const validation = validateJobPatch({
    enabled: true,
    intervalDays: 14,
    maxResults: 25,
  });

  assert.equal(validation.error, undefined);
  assert.deepEqual(validation.value, {
    enabled: true,
    intervalDays: 14,
    maxResults: 25,
  });
});

test('searchAllAssets fetches only requested top ranked assets', async () => {
  const calls = [];
  const immich = {
    async searchSmart(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: '2',
          items: Array.from({ length: body.size }, (_, index) => ({
            id: `${body.page}-${index}`,
            type: 'IMAGE',
          })),
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    query: 'landscapes',
    maxResults: 50,
  });

  assert.equal(result.assetIds.length, 50);
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].size, 50);
});

test('searchAllAssets can fetch all result pages up to the safety page cap', async () => {
  const calls = [];
  const immich = {
    async searchSmart(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: body.page < 2 ? String(body.page + 1) : null,
          items: Array.from({ length: 3 }, (_, index) => ({
            id: `${body.page}-${index}`,
            type: 'IMAGE',
          })),
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 3,
      maxSearchPages: 25,
    },
    query: 'landscapes',
    maxResults: null,
  });

  assert.equal(result.assetIds.length, 6);
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].size, 3);
  assert.equal(calls[1].size, 3);
});

test('searchAllAssets uses metadata search when query is empty', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: null,
          items: [{ id: 'asset-1', type: 'IMAGE' }],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    filters: {
      people: [{ id: 'person-1', name: 'Alicia' }],
      tags: [{ id: 'tag-1', name: 'Beach', value: 'AI/Beach' }],
      city: 'Denver',
      takenBefore: '2024-12-31',
    },
  });

  assert.deepEqual(result.assetIds, ['asset-1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].personIds[0], 'person-1');
  assert.deepEqual(calls[0].tagIds, ['tag-1']);
  assert.equal(calls[0].city, 'Denver');
  assert.equal(calls[0].takenBefore, '2024-12-31T23:59:59.999Z');
  assert.equal(calls[0].order, 'desc');
  assert.equal(calls[0].visibility, 'timeline');
});

test('searchAllAssets keeps the page size constant across capped multi-page searches', async () => {
  const calls = [];
  const immich = {
    async searchSmart(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: String(body.page + 1),
          items: Array.from({ length: body.size }, (_, index) => ({
            id: `${body.page}-${index}`,
            type: 'IMAGE',
          })),
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 3,
      maxSearchPages: 25,
    },
    query: 'landscapes',
    maxResults: 5,
  });

  assert.equal(result.assetIds.length, 5);
  assert.equal(result.truncated, true);
  assert.deepEqual(calls.map((call) => call.size), [3, 3]);
  assert.deepEqual(calls.map((call) => call.page), [1, 2]);
});

test('searchAllAssets filters to photos with only the selected person', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: calls.length === 1 ? 2 : null,
          items: calls.length === 1
            ? [
                { id: 'group-photo', type: 'IMAGE', people: [{ id: 'person-1' }, { id: 'person-2' }] },
                { id: 'alicia-only-1', type: 'IMAGE', people: [{ id: 'person-1' }] },
              ]
            : [
                { id: 'alicia-only-2', type: 'IMAGE', people: [{ id: 'person-1' }] },
                { id: 'no-people', type: 'IMAGE', people: [] },
              ],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 2,
      maxSearchPages: 25,
    },
    filters: {
      peopleOnly: true,
      people: [{ id: 'person-1', name: 'Alicia' }],
    },
    maxResults: 2,
  });

  assert.deepEqual(result.assetIds, ['alicia-only-1', 'alicia-only-2']);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.withPeople === true), true);
  assert.deepEqual(calls.map((call) => call.personIds), [['person-1'], ['person-1']]);
});

test('searchAllAssets preserves supported data-array responses', async () => {
  const result = await searchAllAssets({
    immich: {
      async searchSmart() {
        return { data: [{ id: 'asset-1', type: 'IMAGE' }] };
      },
    },
    config: { searchPageSize: 10, maxSearchPages: 2 },
    query: 'landscapes',
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['asset-1']);
});

test('searchAllAssets rejects malformed pages and non-progressing cursors', async (context) => {
  const cases = [
    ['unknown shape', {}],
    ['canonical shape without a cursor', { assets: { items: [{ id: 'valid' }] } }],
    ['conflicting cursors', { assets: { items: [{ id: 'valid' }], nextPage: 2 }, nextPage: 3 }],
    ['conflicting item containers', { assets: { items: [], nextPage: null }, items: [{ id: 'valid' }] }],
    ['mixed invalid entry', { assets: { items: [{ id: 'valid' }, null], nextPage: null } }],
    ['empty id', { assets: { items: [{ id: '' }], nextPage: null } }],
    ['malformed image type', { assets: { items: [{ id: 'valid', type: { unexpected: true } }], nextPage: null } }],
    ['fractional cursor', { assets: { items: [{ id: 'valid' }], nextPage: 2.5 } }],
    ['garbage cursor', { assets: { items: [{ id: 'valid' }], nextPage: '2junk' } }],
    ['repeated cursor', { assets: { items: [{ id: 'valid' }], nextPage: 1 } }],
    ['empty continuation', { assets: { items: [], nextPage: 2 } }],
  ];

  for (const [name, response] of cases) {
    await context.test(name, async () => {
      await assert.rejects(
        searchAllAssets({
          immich: { async searchSmart() { return response; } },
          config: { searchPageSize: 10, maxSearchPages: 2 },
          query: 'landscapes',
          maxResults: null,
        }),
        (error) => error?.code === 'invalid_upstream_pagination',
      );
    });
  }
});

test('searchAllAssets distinguishes a trustworthy All-results prefix from a complete Top N', async () => {
  const immich = {
    async searchSmart() {
      return { assets: { items: [{ id: 'asset-1', type: 'IMAGE' }], nextPage: 2 } };
    },
  };
  const config = { searchPageSize: 10, maxSearchPages: 1 };

  const allResults = await searchAllAssets({ immich, config, query: 'landscapes', maxResults: null });
  assert.deepEqual(allResults.assetIds, ['asset-1']);
  assert.equal(allResults.truncated, true);
  assert.equal(allResults.reconciliationComplete, false);

  const topOne = await searchAllAssets({ immich, config, query: 'landscapes', maxResults: 1 });
  assert.deepEqual(topOne.assetIds, ['asset-1']);
  assert.equal(topOne.truncated, true);
  assert.equal(topOne.reconciliationComplete, true);
});

test('people-only search rejects missing people metadata', async () => {
  await assert.rejects(
    searchAllAssets({
      immich: {
        async searchMetadata() {
          return { assets: { items: [{ id: 'asset-1', type: 'IMAGE' }], nextPage: null } };
        },
      },
      config: { searchPageSize: 10, maxSearchPages: 2 },
      filters: { peopleOnly: true, personIds: ['person-1'] },
      maxResults: null,
    }),
    (error) => error?.code === 'invalid_upstream_pagination' && /invalid asset entry/.test(error.message),
  );
});

test('people-only search rejects malformed people metadata', async () => {
  await assert.rejects(
    searchAllAssets({
      immich: {
        async searchMetadata() {
          return {
            assets: {
              items: [{ id: 'asset-1', type: 'IMAGE', people: [{ id: '' }] }],
              nextPage: null,
            },
          };
        },
      },
      config: { searchPageSize: 10, maxSearchPages: 2 },
      filters: { peopleOnly: true, personIds: ['person-1'] },
      maxResults: null,
    }),
    (error) => error?.code === 'invalid_upstream_pagination' && /invalid asset entry/.test(error.message),
  );
});

test('searchAllAssets rejects repeated asset IDs across pages', async () => {
  await assert.rejects(
    searchAllAssets({
      immich: {
        async searchSmart({ page }) {
          return page === 1
            ? { assets: { items: [{ id: 'repeated', type: 'IMAGE' }], nextPage: 2 } }
            : { assets: { items: [{ id: 'repeated', type: 'IMAGE' }], nextPage: null } };
        },
      },
      config: { searchPageSize: 10, maxSearchPages: 2 },
      query: 'landscapes',
      maxResults: null,
    }),
    (error) => error?.code === 'invalid_upstream_pagination' && /repeated asset entries/.test(error.message),
  );
});

test('searchAllAssets supports OR people metadata searches', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      const personId = body.personIds[0];
      return {
        assets: {
          nextPage: null,
          items: personId === 'person-1'
            ? [
                { id: 'shared', type: 'IMAGE' },
                { id: 'alicia-only', type: 'IMAGE' },
              ]
            : [
                { id: 'shared', type: 'IMAGE' },
                { id: 'david-only', type: 'IMAGE' },
              ],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    filters: {
      peopleMatchMode: 'any',
      people: [
        { id: 'person-1', name: 'Alicia' },
        { id: 'person-2', name: 'David' },
      ],
      city: 'Denver',
    },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['shared', 'alicia-only', 'david-only']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.personIds), [['person-1'], ['person-2']]);
  assert.equal(calls.every((call) => call.city === 'Denver'), true);
});

test('searchAllAssets supports multi-city OR metadata searches', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: null,
          items: body.city === 'San Francisco'
            ? [{ id: 'sf-1', type: 'IMAGE' }, { id: 'sf-2', type: 'IMAGE' }]
            : [{ id: 'burlingame-1', type: 'IMAGE' }],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: { searchPageSize: 1000, maxSearchPages: 25 },
    filters: { cities: ['San Francisco', 'Burlingame'], personIds: ['person-1'] },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['sf-1', 'sf-2', 'burlingame-1']);
  assert.deepEqual(calls.map((call) => call.city), ['San Francisco', 'Burlingame']);
  // Each variant is a single-city search; the OR list never reaches Immich.
  assert.equal(calls.every((call) => call.cities === undefined), true);
  assert.equal(calls.every((call) => call.personIds[0] === 'person-1'), true);
});

test('single city stays a plain filter and legacy jobs round-trip', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      return { assets: { nextPage: null, items: [{ id: 'a1', type: 'IMAGE' }] } };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: { searchPageSize: 1000, maxSearchPages: 25 },
    filters: { city: 'Lisbon' },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['a1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].city, 'Lisbon');
});

test('searchAllAssets supports multi-country OR metadata searches', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: null,
          items: body.country === 'Japan'
            ? [{ id: 'jp-1', type: 'IMAGE' }, { id: 'jp-2', type: 'IMAGE' }]
            : [{ id: 'at-1', type: 'IMAGE' }],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: { searchPageSize: 1000, maxSearchPages: 25 },
    filters: { countries: ['Japan', 'Austria'] },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['jp-1', 'jp-2', 'at-1']);
  assert.deepEqual(calls.map((call) => call.country), ['Japan', 'Austria']);
  // Each variant is a single-country search; the OR list never reaches Immich.
  assert.equal(calls.every((call) => call.countries === undefined), true);
});

test('single country stays a plain filter and legacy jobs round-trip', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      return { assets: { nextPage: null, items: [{ id: 'a1', type: 'IMAGE' }] } };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: { searchPageSize: 1000, maxSearchPages: 25 },
    filters: { country: 'Portugal' },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['a1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].country, 'Portugal');
});

test('normalizeFilters folds country and countries like cities', () => {
  const multi = normalizeFilters({ country: 'Japan', countries: ['Austria', 'Japan'] });
  assert.equal(multi.country, null);
  assert.deepEqual(multi.countries, ['Japan', 'Austria']);

  const single = normalizeFilters({ countries: ['Japan'] });
  assert.equal(single.country, 'Japan');
  assert.deepEqual(single.countries, ['Japan']);
});

test('multiple countries reject queries, cities, and states', () => {
  const base = normalizeFilters({ countries: ['Japan', 'Austria'] });
  assert.equal(getSearchValidationError({ query: '', filters: base }), null);
  assert.match(
    getSearchValidationError({ query: 'skiing', filters: base }),
    /filter-only/,
  );
  assert.match(
    getSearchValidationError({ query: '', filters: normalizeFilters({ countries: ['Japan', 'Austria'], city: 'Vienna' }) }),
    /cannot be combined with a city or state/,
  );
  assert.match(
    getSearchValidationError({ query: '', filters: normalizeFilters({ countries: ['Japan', 'Austria'], state: 'Tyrol' }) }),
    /cannot be combined with a city or state/,
  );
  assert.match(
    getSearchValidationError({ query: '', filters: normalizeFilters({ countries: ['Japan', 'Austria'], cities: ['Vienna', 'Kyoto'] }) }),
    /cannot be combined with a city or state/,
  );
});

test('searchAllAssets supports OR tag metadata searches', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      const tagId = body.tagIds[0];
      return {
        assets: {
          nextPage: null,
          items: tagId === 'tag-1'
            ? [
                { id: 'shared', type: 'IMAGE' },
                { id: 'beach-only', type: 'IMAGE' },
              ]
            : [
                { id: 'shared', type: 'IMAGE' },
                { id: 'dining-only', type: 'IMAGE' },
              ],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    filters: {
      tagMatchMode: 'any',
      tags: [
        { id: 'tag-1', name: 'Beach', value: 'AI/Beach' },
        { id: 'tag-2', name: 'Dining', value: 'AI/Dining' },
      ],
      country: 'Mexico',
    },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['shared', 'beach-only', 'dining-only']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.tagIds), [['tag-1'], ['tag-2']]);
  assert.equal(calls.every((call) => call.country === 'Mexico'), true);
});

test('searchAllAssets propagates incomplete All-results traversal through OR tags', async () => {
  const immich = {
    async searchMetadata(body) {
      return {
        assets: {
          nextPage: 2,
          items: [{ id: `${body.tagIds[0]}-asset`, type: 'IMAGE' }],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: { searchPageSize: 10, maxSearchPages: 1 },
    filters: {
      tagMatchMode: 'any',
      tagIds: ['tag-1', 'tag-2'],
    },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['tag-1-asset', 'tag-2-asset']);
  assert.equal(result.truncated, true);
  assert.equal(result.reconciliationComplete, false);
});

test('searchAllAssets supports AND tag metadata searches', async () => {
  const calls = [];
  const immich = {
    async searchMetadata(body) {
      calls.push(body);
      const tagId = body.tagIds[0];
      return {
        assets: {
          nextPage: null,
          items: tagId === 'tag-1'
            ? [
                { id: 'shared-1', type: 'IMAGE' },
                { id: 'shared-2', type: 'IMAGE' },
                { id: 'beach-only', type: 'IMAGE' },
              ]
            : [
                { id: 'shared-2', type: 'IMAGE' },
                { id: 'shared-1', type: 'IMAGE' },
                { id: 'dining-only', type: 'IMAGE' },
              ],
        },
      };
    },
  };

  const result = await searchAllAssets({
    immich,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    filters: {
      tagMatchMode: 'all',
      tags: [
        { id: 'tag-1', name: 'Beach', value: 'AI/Beach' },
        { id: 'tag-2', name: 'Dining', value: 'AI/Dining' },
      ],
      city: 'Denver',
    },
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, ['shared-1', 'shared-2']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.tagIds), [['tag-1'], ['tag-2']]);
  assert.equal(calls.every((call) => call.city === 'Denver'), true);
});

test('bounded AND-tag searches reject a capped internal full traversal', async () => {
  const immich = {
    async searchMetadata(body) {
      return {
        assets: {
          nextPage: 2,
          items: [{ id: `${body.tagIds[0]}-asset`, type: 'IMAGE' }],
        },
      };
    },
  };

  await assert.rejects(
    searchAllAssets({
      immich,
      config: { searchPageSize: 10, maxSearchPages: 1 },
      filters: {
        tagMatchMode: 'all',
        tagIds: ['tag-1', 'tag-2'],
      },
      maxResults: 1,
    }),
    (error) => error?.code === 'invalid_upstream_pagination' && /page traversal limit/.test(error.message),
  );
});

test('searchAllAssets rejects OR people with ranked search', async () => {
  await assert.rejects(
    () => searchAllAssets({
      immich: {},
      config: {
        searchPageSize: 1000,
        maxSearchPages: 25,
      },
      query: 'landscapes',
      filters: {
        peopleMatchMode: 'any',
        personIds: ['person-1', 'person-2'],
      },
    }),
    /People OR/,
  );
});

test('searchAllAssets rejects OR tags with ranked search', async () => {
  await assert.rejects(
    () => searchAllAssets({
      immich: {},
      config: {
        searchPageSize: 1000,
        maxSearchPages: 25,
      },
      query: 'landscapes',
      filters: {
        tagMatchMode: 'any',
        tagIds: ['tag-1', 'tag-2'],
      },
    }),
    /Tag OR/,
  );
});

test('searchAllAssets rejects people only with ranked search', async () => {
  await assert.rejects(
    () => searchAllAssets({
      immich: {},
      config: {
        searchPageSize: 1000,
        maxSearchPages: 25,
      },
      query: 'portraits',
      filters: {
        peopleOnly: true,
        personIds: ['person-1'],
      },
    }),
    /Only this person/,
  );
});

test('searchAllAssets applies structured filters to smart search', async () => {
  const calls = [];
  const immich = {
    async searchSmart(body) {
      calls.push(body);
      return {
        assets: {
          nextPage: null,
          items: [{ id: 'asset-1', type: 'IMAGE' }],
        },
      };
    },
  };

  await searchAllAssets({
    immich,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    query: 'landscapes',
    filters: {
      country: 'United States',
      personIds: ['person-1'],
      tagIds: ['tag-1'],
    },
    maxResults: 10,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, 'landscapes');
  assert.equal(calls[0].country, 'United States');
  assert.deepEqual(calls[0].personIds, ['person-1']);
  assert.deepEqual(calls[0].tagIds, ['tag-1']);
});

test('createSmartAlbumJob adds all assets in conservative batches', async () => {
  const addCalls = [];
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: Array.from({ length: 123 }, (_, index) => ({
            id: `asset-${index}`,
            type: 'IMAGE',
          })),
        },
      };
    },
    async createAlbum() {
      return { id: 'album-1' };
    },
    async addAssetsToAlbum(albumId, assetIds) {
      addCalls.push({ albumId, assetIds });
    },
  };
  const store = createMemoryStore();

  const job = await createSmartAlbumJob({
    immich,
    store,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    input: {
      query: 'landscapes',
      albumName: 'Landscapes',
      filters: {},
      smart: false,
      intervalDays: 0,
      includeAllResults: true,
      maxResults: null,
    },
  });

  assert.equal(job.lastResult.addedCount, 123);
  assert.deepEqual(addCalls.map((call) => call.assetIds.length), [50, 50, 23]);
  assert.equal(addCalls.every((call) => call.albumId === 'album-1'), true);
});

test('createSmartAlbumJob safely fills a new album from a capped All-results prefix', async () => {
  const addCalls = [];
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: 2,
          items: [{ id: 'asset-1', type: 'IMAGE' }],
        },
      };
    },
    async createAlbum() {
      return { id: 'album-1' };
    },
    async addAssetsToAlbum(albumId, assetIds) {
      addCalls.push({ albumId, assetIds });
    },
  };
  const store = createMemoryStore();

  const job = await createSmartAlbumJob({
    immich,
    store,
    config: { searchPageSize: 10, maxSearchPages: 1 },
    input: {
      query: 'landscapes',
      albumName: 'Landscapes',
      filters: {
        excludeTagsConfigured: true,
        excludeTags: [],
        excludeTagIds: [],
        excludeTagValues: [],
      },
      smart: false,
      bestOf: false,
      intervalDays: 0,
      includeAllResults: true,
      maxResults: null,
    },
  });

  assert.deepEqual(addCalls, [{ albumId: 'album-1', assetIds: ['asset-1'] }]);
  assert.equal(job.lastResult.truncated, true);
  assert.equal(job.lastResult.reconciliationComplete, false);
  assert.match(job.lastResult.warnings[0], /existing album members will be preserved/);
});

test('createSmartAlbumJob stores the job before adding so add failures leave no orphan album', async () => {
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: [{ id: 'asset-1', type: 'IMAGE' }],
        },
      };
    },
    async createAlbum() {
      return { id: 'album-1' };
    },
    async addAssetsToAlbum() {
      throw new Error('immich add failed');
    },
  };
  const store = createMemoryStore();

  await assert.rejects(
    () => createSmartAlbumJob({
      immich,
      store,
      config: {
        searchPageSize: 1000,
        maxSearchPages: 25,
      },
      input: {
        query: 'landscapes',
        albumName: 'Landscapes',
        filters: {},
        smart: false,
        intervalDays: 0,
        includeAllResults: true,
        maxResults: null,
      },
    }),
    /immich add failed/,
  );

  assert.equal(store.jobs.length, 1);
  assert.equal(store.jobs[0].albumId, 'album-1');
  assert.match(store.jobs[0].lastError, /immich add failed/);
});

test('createSmartAlbumJob deletes the just-created album when job persistence fails', async () => {
  const deleteCalls = [];
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: [{ id: 'asset-1', type: 'IMAGE' }],
        },
      };
    },
    async createAlbum() {
      return { id: 'album-1' };
    },
    async deleteAlbum(albumId) {
      deleteCalls.push(albumId);
    },
    async addAssetsToAlbum() {
      throw new Error('should never be reached');
    },
  };
  const store = {
    async addJob() {
      throw new Error('disk full');
    },
  };

  await assert.rejects(
    () => createSmartAlbumJob({
      immich,
      store,
      config: {
        searchPageSize: 1000,
        maxSearchPages: 25,
      },
      input: {
        query: 'landscapes',
        albumName: 'Landscapes',
        filters: {},
        smart: false,
        intervalDays: 0,
        includeAllResults: true,
        maxResults: null,
      },
    }),
    /disk full/,
  );

  // No unmanaged album is left behind in Immich.
  assert.deepEqual(deleteCalls, ['album-1']);
});

test('runSmartAlbumJob checks existing assets with album metadata search', async () => {
  const metadataCalls = [];
  const addCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {},
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: [
            { id: 'existing', type: 'IMAGE' },
            { id: 'new-1', type: 'IMAGE' },
            { id: 'new-2', type: 'IMAGE' },
          ],
        },
      };
    },
    async searchMetadata(body) {
      metadataCalls.push(body);
      return {
        assets: {
          nextPage: null,
          items: [{ id: 'existing', type: 'IMAGE' }],
        },
      };
    },
    async getAlbum() {
      throw new Error('getAlbum should not be used for existing asset lookup');
    },
    async addAssetsToAlbum(albumId, assetIds) {
      addCalls.push({ albumId, assetIds });
    },
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      assert.equal(jobId, 'job-1');
      return {
        ...currentJob,
        ...updater(currentJob),
      };
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    jobId: 'job-1',
  });

  assert.deepEqual(metadataCalls.map((call) => call.albumIds), [['album-1']]);
  assert.deepEqual(addCalls, [{ albumId: 'album-1', assetIds: ['new-1', 'new-2'] }]);
  assert.equal(job.lastResult.addedCount, 2);
  assert.equal(job.lastResult.skippedCount, 1);
});

test('runSmartAlbumJob removes album assets tagged frame/never-show', async () => {
  const metadataCalls = [];
  const removeCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {},
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: [{ id: 'existing', type: 'IMAGE' }],
        },
      };
    },
    async searchMetadata(body) {
      metadataCalls.push(body);

      if (body.tagIds?.includes('never-show-tag')) {
        return {
          assets: {
            nextPage: null,
            items: [
              { id: 'hidden-1', type: 'IMAGE' },
              { id: 'hidden-2', type: 'IMAGE' },
              { id: 'hidden-elsewhere', type: 'IMAGE' },
            ],
          },
        };
      }

      return {
        assets: {
          nextPage: null,
          items: [
            { id: 'existing', type: 'IMAGE' },
            { id: 'hidden-1', type: 'IMAGE' },
            { id: 'hidden-2', type: 'IMAGE' },
          ],
        },
      };
    },
    async listTags() {
      return [{ id: 'never-show-tag', value: 'frame/never-show' }];
    },
    async addAssetsToAlbum() {},
    async removeAssetsFromAlbum(albumId, assetIds) {
      removeCalls.push({ albumId, assetIds });
    },
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      assert.equal(jobId, 'job-1');
      return {
        ...currentJob,
        ...updater(currentJob),
      };
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    jobId: 'job-1',
  });

  // First metadata call is the global never-show lookup, second is album membership.
  assert.deepEqual(metadataCalls.map((call) => call.albumIds ?? null), [null, ['album-1']]);
  assert.deepEqual(metadataCalls[0].tagIds, ['never-show-tag']);
  assert.equal(metadataCalls[1].tagIds, undefined);
  // Reconciliation removes the album members that are not in the desired set.
  assert.deepEqual(removeCalls, [{ albumId: 'album-1', assetIds: ['hidden-1', 'hidden-2'] }]);
  assert.equal(job.lastResult.removedCount, 2);
});

test('runSmartAlbumJob never adds assets tagged frame/never-show', async () => {
  const addCalls = [];
  const removeCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {},
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: [
            { id: 'banned', type: 'IMAGE' },
            { id: 'new-1', type: 'IMAGE' },
          ],
        },
      };
    },
    async searchMetadata(body) {
      if (body.tagIds?.includes('never-show-tag')) {
        return {
          assets: {
            nextPage: null,
            items: [{ id: 'banned', type: 'IMAGE' }],
          },
        };
      }

      return {
        assets: {
          nextPage: null,
          items: [],
        },
      };
    },
    async listTags() {
      return [{ id: 'never-show-tag', value: 'frame/never-show' }];
    },
    async addAssetsToAlbum(albumId, assetIds) {
      addCalls.push({ albumId, assetIds });
    },
    async removeAssetsFromAlbum(albumId, assetIds) {
      removeCalls.push({ albumId, assetIds });
    },
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      return {
        ...currentJob,
        ...updater(currentJob),
      };
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    jobId: 'job-1',
  });

  assert.deepEqual(addCalls, [{ albumId: 'album-1', assetIds: ['new-1'] }]);
  assert.deepEqual(removeCalls, []);
  assert.equal(job.lastResult.addedCount, 1);
  assert.equal(job.lastResult.skippedCount, 1);
  assert.equal(job.lastResult.removedCount, 0);
});

test('runSmartAlbumJob applies configured blanket exclusion tags', async () => {
  const addCalls = [];
  const removeCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {
      excludeTags: [{ id: 'custom-exclude-tag', name: 'Do Not Show', value: 'frame/do-not-show' }],
    },
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: [
            { id: 'custom-hidden', type: 'IMAGE' },
            { id: 'new-1', type: 'IMAGE' },
          ],
        },
      };
    },
    async searchMetadata(body) {
      if (body.tagIds?.includes('custom-exclude-tag')) {
        return {
          assets: {
            nextPage: null,
            items: [
              { id: 'custom-hidden', type: 'IMAGE' },
              { id: 'hidden-elsewhere', type: 'IMAGE' },
            ],
          },
        };
      }

      return {
        assets: {
          nextPage: null,
          items: [{ id: 'custom-hidden', type: 'IMAGE' }],
        },
      };
    },
    async addAssetsToAlbum(albumId, assetIds) {
      addCalls.push({ albumId, assetIds });
    },
    async removeAssetsFromAlbum(albumId, assetIds) {
      removeCalls.push({ albumId, assetIds });
    },
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      return {
        ...currentJob,
        ...updater(currentJob),
      };
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    jobId: 'job-1',
  });

  assert.deepEqual(addCalls, [{ albumId: 'album-1', assetIds: ['new-1'] }]);
  assert.deepEqual(removeCalls, [{ albumId: 'album-1', assetIds: ['custom-hidden'] }]);
  assert.equal(job.lastResult.addedCount, 1);
  assert.equal(job.lastResult.skippedCount, 1);
  assert.equal(job.lastResult.removedCount, 1);
});

test('runSmartAlbumJob removes assets that no longer match the rule', async () => {
  const removeCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {},
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      return {
        assets: {
          nextPage: null,
          items: [
            { id: 'existing', type: 'IMAGE' },
            { id: 'new-1', type: 'IMAGE' },
          ],
        },
      };
    },
    async searchMetadata(body) {
      if (body.tagIds) {
        return { assets: { nextPage: null, items: [] } };
      }
      // Album membership: one still-matching asset, one that stopped matching,
      // and one added by hand in Immich.
      return {
        assets: {
          nextPage: null,
          items: [
            { id: 'existing', type: 'IMAGE' },
            { id: 'stale-1', type: 'IMAGE' },
            { id: 'manual-1', type: 'IMAGE' },
          ],
        },
      };
    },
    async listTags() {
      return [{ id: 'never-show-tag', value: 'frame/never-show' }];
    },
    async addAssetsToAlbum() {},
    async removeAssetsFromAlbum(albumId, assetIds) {
      removeCalls.push({ albumId, assetIds });
    },
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      return {
        ...currentJob,
        ...updater(currentJob),
      };
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: {
      searchPageSize: 1000,
      maxSearchPages: 25,
    },
    jobId: 'job-1',
  });

  assert.deepEqual(removeCalls, [{ albumId: 'album-1', assetIds: ['stale-1', 'manual-1'] }]);
  assert.equal(job.lastResult.removedCount, 2);
});

test('runSmartAlbumJob adds a capped All-results prefix without removing unconfirmed members', async () => {
  const addCalls = [];
  const removeCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    albumName: 'Landscapes',
    query: 'landscapes',
    filters: {
      excludeTagsConfigured: true,
      excludeTags: [],
      excludeTagIds: [],
      excludeTagValues: [],
    },
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  let stored = currentJob;
  const store = {
    async getJob() {
      return stored;
    },
    async updateJob(jobId, updater) {
      assert.equal(jobId, 'job-1');
      stored = { ...stored, ...updater(stored) };
      return stored;
    },
  };
  const immich = {
    async searchSmart() {
      return {
        assets: {
          items: [
            { id: 'existing', type: 'IMAGE' },
            { id: 'new-1', type: 'IMAGE' },
          ],
          nextPage: 2,
        },
      };
    },
    async searchMetadata() {
      return {
        assets: {
          items: [
            { id: 'existing', type: 'IMAGE' },
            { id: 'stale-or-unseen', type: 'IMAGE' },
            { id: 'manual', type: 'IMAGE' },
          ],
          nextPage: null,
        },
      };
    },
    async addAssetsToAlbum(albumId, assetIds) {
      addCalls.push({ albumId, assetIds });
    },
    async removeAssetsFromAlbum(albumId, assetIds) {
      removeCalls.push({ albumId, assetIds });
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: { searchPageSize: 10, maxSearchPages: 1 },
    jobId: 'job-1',
  });

  assert.deepEqual(addCalls, [{ albumId: 'album-1', assetIds: ['new-1'] }]);
  assert.deepEqual(removeCalls, []);
  assert.equal(job.lastError, null);
  assert.equal(job.lastResult.removedCount, 0);
  assert.equal(job.lastResult.truncated, true);
  assert.equal(job.lastResult.reconciliationComplete, false);
  assert.match(job.lastResult.warnings[0], /existing album members will be preserved/);
});

test('runSmartAlbumJob still reconciles a complete Top-N selection reached at the page cap', async () => {
  const addCalls = [];
  const removeCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    albumName: 'Top landscape',
    query: 'landscapes',
    filters: {
      excludeTagsConfigured: true,
      excludeTags: [],
      excludeTagIds: [],
      excludeTagValues: [],
    },
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: false,
    maxResults: 1,
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      assert.equal(jobId, 'job-1');
      return { ...currentJob, ...updater(currentJob) };
    },
  };
  const immich = {
    async searchSmart() {
      return {
        assets: {
          items: [{ id: 'new-top', type: 'IMAGE' }],
          nextPage: 2,
        },
      };
    },
    async searchMetadata() {
      return {
        assets: {
          items: [{ id: 'old-top', type: 'IMAGE' }],
          nextPage: null,
        },
      };
    },
    async addAssetsToAlbum(albumId, assetIds) {
      addCalls.push({ albumId, assetIds });
    },
    async removeAssetsFromAlbum(albumId, assetIds) {
      removeCalls.push({ albumId, assetIds });
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: { searchPageSize: 10, maxSearchPages: 1 },
    jobId: 'job-1',
  });

  assert.deepEqual(addCalls, [{ albumId: 'album-1', assetIds: ['new-top'] }]);
  assert.deepEqual(removeCalls, [{ albumId: 'album-1', assetIds: ['old-top'] }]);
  assert.equal(job.lastResult.removedCount, 1);
  assert.equal(job.lastResult.truncated, true);
  assert.equal(job.lastResult.reconciliationComplete, true);
  assert.deepEqual(job.lastResult.warnings, []);
});

test('runSmartAlbumJob fails before any membership mutation when an upstream traversal is unsafe', async (context) => {
  const baseJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {
      excludeTagsConfigured: true,
      excludeTags: [],
      excludeTagIds: [],
      excludeTagValues: [],
    },
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const cases = [
    {
      name: 'malformed desired search',
      searchSmart: async () => ({ unexpected: 'successful 2xx shape' }),
      searchMetadata: async () => ({ assets: { items: [{ id: 'existing' }], nextPage: null } }),
    },
    {
      name: 'desired search with an omitted canonical cursor',
      searchSmart: async () => ({ assets: { items: [{ id: 'partial' }] } }),
      searchMetadata: async () => ({ assets: { items: [{ id: 'existing' }], nextPage: null } }),
    },
    {
      name: 'desired search with conflicting cursors',
      searchSmart: async () => ({
        assets: { items: [{ id: 'partial' }], nextPage: 2 },
        nextPage: 3,
      }),
      searchMetadata: async () => ({ assets: { items: [{ id: 'existing' }], nextPage: null } }),
    },
    {
      name: 'desired search with conflicting item containers',
      searchSmart: async () => ({
        assets: { items: [], nextPage: null },
        items: [{ id: 'existing' }],
      }),
      searchMetadata: async () => ({ assets: { items: [{ id: 'existing' }], nextPage: null } }),
    },
    {
      name: 'desired search with a malformed asset type',
      searchSmart: async () => ({
        assets: { items: [{ id: 'existing', type: { unexpected: true } }], nextPage: null },
      }),
      searchMetadata: async () => ({ assets: { items: [{ id: 'existing' }], nextPage: null } }),
    },
    {
      name: 'desired search that repeats an asset across pages',
      searchSmart: async ({ page }) => (page === 1
        ? { assets: { items: [{ id: 'existing' }], nextPage: 2 } }
        : { assets: { items: [{ id: 'existing' }], nextPage: null } }),
      searchMetadata: async () => ({ assets: { items: [{ id: 'existing' }], nextPage: null } }),
    },
    {
      name: 'malformed blanket-exclusion search',
      job: { ...baseJob, filters: {} },
      listTags: async () => [{ id: 'never-show-tag', value: 'frame/never-show' }],
      searchSmart: async () => ({ assets: { items: [{ id: 'new-1' }], nextPage: null } }),
      searchMetadata: async (body) => (
        body.tagIds ? {} : { assets: { items: [{ id: 'existing' }], nextPage: null } }
      ),
    },
    {
      name: 'malformed existing-membership search',
      searchSmart: async () => ({ assets: { items: [{ id: 'new-1' }], nextPage: null } }),
      searchMetadata: async () => ({}),
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const addCalls = [];
      const removeCalls = [];
      const job = scenario.job ?? baseJob;
      let stored = job;
      const store = {
        async getJob() {
          return stored;
        },
        async updateJob(jobId, updater) {
          assert.equal(jobId, 'job-1');
          stored = { ...stored, ...updater(stored) };
          return stored;
        },
      };
      const immich = {
        searchSmart: scenario.searchSmart,
        searchMetadata: scenario.searchMetadata,
        ...(scenario.listTags ? { listTags: scenario.listTags } : {}),
        async addAssetsToAlbum(albumId, assetIds) {
          addCalls.push({ albumId, assetIds });
        },
        async removeAssetsFromAlbum(albumId, assetIds) {
          removeCalls.push({ albumId, assetIds });
        },
      };

      await assert.rejects(
        runSmartAlbumJob({
          immich,
          store,
          config: { searchPageSize: 10, maxSearchPages: scenario.maxSearchPages ?? 2 },
          jobId: 'job-1',
        }),
        (error) => error?.code === 'invalid_upstream_pagination',
      );
      assert.deepEqual(addCalls, []);
      assert.deepEqual(removeCalls, []);
      assert.match(stored.lastError, /Immich/);
    });
  }
});

test('runSmartAlbumJob still removes every member for a valid terminal empty result', async () => {
  const removeCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {
      excludeTagsConfigured: true,
      excludeTags: [],
      excludeTagIds: [],
      excludeTagValues: [],
    },
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      assert.equal(jobId, 'job-1');
      return { ...currentJob, ...updater(currentJob) };
    },
  };
  const immich = {
    async searchSmart() {
      return { assets: { items: [], nextPage: null } };
    },
    async searchMetadata() {
      return {
        assets: {
          items: [{ id: 'existing-1', type: 'IMAGE' }, { id: 'existing-2', type: 'IMAGE' }],
          nextPage: null,
        },
      };
    },
    async addAssetsToAlbum() {},
    async removeAssetsFromAlbum(albumId, assetIds) {
      removeCalls.push({ albumId, assetIds });
    },
  };

  const result = await runSmartAlbumJob({
    immich,
    store,
    config: { searchPageSize: 10, maxSearchPages: 2 },
    jobId: 'job-1',
  });

  assert.deepEqual(removeCalls, [{ albumId: 'album-1', assetIds: ['existing-1', 'existing-2'] }]);
  assert.equal(result.lastResult.removedCount, 2);
});

test('runSmartAlbumJob rejects a second concurrent run of the same job', async () => {
  let releaseSearch;
  const gate = new Promise((resolve) => {
    releaseSearch = resolve;
  });
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: {},
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      await gate;
      return { assets: { nextPage: null, items: [] } };
    },
    async searchMetadata() {
      return { assets: { nextPage: null, items: [] } };
    },
    async listTags() {
      return [{ id: 'never-show-tag', value: 'frame/never-show' }];
    },
    async addAssetsToAlbum() {},
    async removeAssetsFromAlbum() {},
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      return {
        ...currentJob,
        ...updater(currentJob),
      };
    },
  };
  const config = { searchPageSize: 1000, maxSearchPages: 25 };

  const first = runSmartAlbumJob({ immich, store, config, jobId: 'job-1' });
  await Promise.resolve();
  await assert.rejects(
    runSmartAlbumJob({ immich, store, config, jobId: 'job-1' }),
    (error) => error.code === 'job_running',
  );
  releaseSearch();
  await first;

  // The lock releases with the run: a follow-up run succeeds.
  const again = await runSmartAlbumJob({ immich, store, config, jobId: 'job-1' });
  assert.ok(again);
});

test('persisted jobs are revalidated before manual or scheduled execution', async () => {
  let immichCalls = 0;
  const persisted = {
    id: 'oversized-job',
    albumId: 'album-1',
    albumName: 'Oversized',
    query: '',
    filters: {
      cities: Array.from({ length: MAX_SMART_ALBUM_FILTER_ITEMS + 1 }, (_, index) => `City ${index}`),
    },
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const store = {
    job: persisted,
    async getJob() { return structuredClone(this.job); },
    async updateJob(jobId, updater) {
      this.job = { ...this.job, ...updater(structuredClone(this.job)) };
      return structuredClone(this.job);
    },
  };
  const immich = new Proxy({}, {
    get() {
      return async () => {
        immichCalls += 1;
        throw new Error('Immich must not be called');
      };
    },
  });

  await assert.rejects(
    runSmartAlbumJob({
      immich,
      store,
      config: { searchPageSize: 1000, maxSearchPages: 25 },
      jobId: persisted.id,
    }),
    /cities is limited/,
  );
  assert.equal(immichCalls, 0);
  assert.match(store.job.lastError, /cities is limited/);
});

test('computeNextRunAt adds whole day intervals', () => {
  const fromDate = new Date('2026-06-17T12:00:00.000Z');
  assert.equal(computeNextRunAt(fromDate, 7).toISOString(), '2026-06-24T12:00:00.000Z');
});

test('jobIsDue only returns true for enabled smart jobs past nextRunAt', () => {
  const now = new Date('2026-06-17T12:00:00.000Z');

  assert.equal(jobIsDue({
    smart: true,
    enabled: true,
    nextRunAt: '2026-06-17T11:59:00.000Z',
  }, now), true);

  assert.equal(jobIsDue({
    smart: true,
    enabled: false,
    nextRunAt: '2026-06-17T11:59:00.000Z',
  }, now), false);

  assert.equal(jobIsDue({
    smart: true,
    enabled: true,
    scheduleQuarantined: true,
    nextRunAt: '2026-06-17T11:59:00.000Z',
  }, now), false);
});

test('normalizeFilters is idempotent for the exclusion default', async () => {
  const { normalizeFilters } = await import('../../src/albums/smartAlbums.mjs');

  // Unconfigured (v1 jobs / API callers): default survives repeated normalization.
  const unconfigured = normalizeFilters(normalizeFilters(normalizeFilters({ city: 'Denver' })));
  assert.equal(unconfigured.excludeTagsConfigured, false);

  // Explicitly none: opt-out survives repeated normalization.
  const optedOut = normalizeFilters(normalizeFilters({ excludeTags: [] }));
  assert.equal(optedOut.excludeTagsConfigured, true);
  assert.deepEqual(optedOut.excludeTagValues, []);

  // Explicit custom exclusion survives repeated normalization.
  const custom = normalizeFilters(normalizeFilters({ excludeTags: [{ value: 'frame/private' }] }));
  assert.equal(custom.excludeTagsConfigured, true);
  assert.deepEqual(custom.excludeTagValues, ['frame/private']);
});

test('runSmartAlbumJob applies the never-show default to jobs stored without exclusion keys', async () => {
  const metadataCalls = [];
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    // Simulates a v1 job round-tripped through store normalization: exclusion
    // keys present but never explicitly configured by the user.
    filters: (await import('../../src/albums/smartAlbums.mjs')).normalizeFilters({}),
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      return { assets: { nextPage: null, items: [{ id: 'new-1', type: 'IMAGE' }] } };
    },
    async searchMetadata(body) {
      metadataCalls.push(body);
      return { assets: { nextPage: null, items: [] } };
    },
    async listTags() {
      return [{ id: 'never-show-tag', value: 'frame/never-show' }];
    },
    async addAssetsToAlbum() {},
    async removeAssetsFromAlbum() {},
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      return { ...currentJob, ...updater(currentJob) };
    },
  };

  await runSmartAlbumJob({
    immich,
    store,
    config: { searchPageSize: 1000, maxSearchPages: 25 },
    jobId: 'job-1',
  });

  const exclusionSearches = metadataCalls.filter((call) => call.tagIds?.includes('never-show-tag'));
  assert.ok(exclusionSearches.length > 0, 'expected the never-show default exclusion search to run');
});

test('runSmartAlbumJob surfaces unresolved blanket exclusion tags as warnings', async () => {
  const currentJob = {
    id: 'job-1',
    albumId: 'album-1',
    query: 'landscapes',
    filters: { excludeTags: [{ value: 'frame/deleted-tag' }] },
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: true,
    maxResults: null,
  };
  const immich = {
    async searchSmart() {
      return { assets: { nextPage: null, items: [{ id: 'new-1', type: 'IMAGE' }] } };
    },
    async searchMetadata() {
      return { assets: { nextPage: null, items: [] } };
    },
    async listTags() {
      return [{ id: 'other-tag', value: 'frame/other' }];
    },
    async addAssetsToAlbum() {},
    async removeAssetsFromAlbum() {},
  };
  const store = {
    async getJob() {
      return currentJob;
    },
    async updateJob(jobId, updater) {
      return { ...currentJob, ...updater(currentJob) };
    },
  };

  const job = await runSmartAlbumJob({
    immich,
    store,
    config: { searchPageSize: 1000, maxSearchPages: 25 },
    jobId: 'job-1',
  });

  assert.equal(job.lastResult.warnings.length, 1);
  assert.match(job.lastResult.warnings[0], /frame\/deleted-tag/);
});
