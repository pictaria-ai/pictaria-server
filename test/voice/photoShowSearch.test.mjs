import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseShowSearchQuery,
  PhotoShowSearchError,
  searchShowPhotos,
  validateShowSearchRequest,
} from '../../src/voice/photoShowSearch.mjs';

test('parses a single person, place, and year', () => {
  assert.deepEqual(parseShowSearchQuery('show David in Paris in 2025'), {
    dateLabel: '2025',
    dateRange: {
      takenAfter: '2025-01-01T00:00:00.000Z',
      takenBefore: '2026-01-01T00:00:00.000Z',
    },
    personName: 'David',
    place: 'Paris',
  });
});

test('parses a single person, place, month, and year', () => {
  assert.deepEqual(parseShowSearchQuery('show David in Mexico City in September 2025'), {
    dateLabel: 'September 2025',
    dateRange: {
      takenAfter: '2025-09-01T00:00:00.000Z',
      takenBefore: '2025-10-01T00:00:00.000Z',
    },
    personName: 'David',
    place: 'Mexico City',
  });
});

test('parses abbreviated month and year ranges', () => {
  assert.deepEqual(parseShowSearchQuery('show David in Mexico City in Sept 2025'), {
    dateLabel: 'Sept 2025',
    dateRange: {
      takenAfter: '2025-09-01T00:00:00.000Z',
      takenBefore: '2025-10-01T00:00:00.000Z',
    },
    personName: 'David',
    place: 'Mexico City',
  });
});

test('validates show search requests', () => {
  assert.deepEqual(validateShowSearchRequest({ query: ' David ', limit: 100 }), {
    value: {
      frameEligibleOnly: true,
      limit: 50,
      query: 'David',
    },
  });
  assert.deepEqual(validateShowSearchRequest({ query: '' }), {
    error: 'Search query is required.',
  });
});

test('searches frame eligible photos for one resolved person', async () => {
  const calls = [];
  const immich = {
    async listTags() {
      return [{ id: 'eligible-tag-id', value: 'frame/eligible' }];
    },
    async searchPeople(name) {
      calls.push(['searchPeople', name]);
      return [{ id: 'person-david', name: 'David' }];
    },
    async searchMetadata(body) {
      calls.push(['searchMetadata', body]);
      return [
        { id: 'asset-1', type: 'IMAGE', exifInfo: { city: 'Paris' } },
        { id: 'asset-2', type: 'IMAGE', city: 'Paris' },
      ];
    },
    async searchSmart() {
      throw new Error('smart fallback should not run');
    },
    async searchRandom() {
      throw new Error('random search should not run');
    },
  };

  const response = await searchShowPhotos({
    immich,
    limit: 20,
    query: 'David in Paris in 2025',
  });

  assert.equal(response.displayTitle, 'David in Paris in 2025');
  assert.equal(response.assets.length, 2);
  assert.deepEqual(calls[0], ['searchPeople', 'David']);
  assert.equal(calls[1][0], 'searchMetadata');
  assert.deepEqual(calls[1][1].personIds, ['person-david']);
  assert.deepEqual(calls[1][1].tagIds, ['eligible-tag-id']);
  assert.equal(calls[1][1].city, 'Paris');
  assert.equal(calls[1][1].takenAfter, '2025-01-01T00:00:00.000Z');
});

test('falls back to smart search after nonmatching metadata place results', async () => {
  const calls = [];
  const immich = {
    async listTags() {
      return [{ id: 'eligible-tag-id', value: 'frame/eligible' }];
    },
    async searchMetadata() {
      calls.push('searchMetadata');
      return [{ id: 'asset-kyoto', type: 'IMAGE', exifInfo: { city: 'Kyoto' } }];
    },
    async searchRandom() {
      throw new Error('random search should not run');
    },
    async searchSmart() {
      calls.push('searchSmart');
      return [{ id: 'asset-paris', type: 'IMAGE', exifInfo: { city: 'Paris' } }];
    },
  };

  const response = await searchShowPhotos({
    immich,
    query: 'photos in Paris in 2025',
  });

  assert.deepEqual(response.assets.map((asset) => asset.id), ['asset-paris']);
  assert.deepEqual(calls, ['searchMetadata', 'searchSmart']);
});

test('matches accented place names after normalization', async () => {
  const immich = {
    async listTags() {
      return [{ id: 'eligible-tag-id', value: 'frame/eligible' }];
    },
    async searchMetadata() {
      return [{ id: 'asset-zurich', type: 'IMAGE', exifInfo: { city: 'Zürich' } }];
    },
    async searchRandom() {
      throw new Error('random search should not run');
    },
    async searchSmart() {
      throw new Error('smart fallback should not run when metadata place matches');
    },
  };

  const response = await searchShowPhotos({
    immich,
    query: 'photos in Zürich in 2025',
  });

  assert.equal(response.criteria.place, 'Zurich');
  assert.deepEqual(response.assets.map((asset) => asset.id), ['asset-zurich']);
});

test('rejects nonmatching place results returned by Immich smart search', async () => {
  const immich = {
    async listTags() {
      return [{ id: 'eligible-tag-id', value: 'frame/eligible' }];
    },
    async searchMetadata() {
      return [];
    },
    async searchRandom() {
      throw new Error('random search should not run for a place query');
    },
    async searchSmart() {
      return [{ id: 'asset-windsor', type: 'IMAGE', exifInfo: { city: 'Windsor' } }];
    },
  };

  const response = await searchShowPhotos({
    immich,
    query: 'photos in Paris in 2025',
  });

  assert.deepEqual(response.assets, []);
});

test('fails when a person search is ambiguous', async () => {
  const immich = {
    async listTags() {
      return [{ id: 'eligible-tag-id', value: 'frame/eligible' }];
    },
    async searchPeople() {
      return [
        { id: 'person-1', name: 'David' },
        { id: 'person-2', name: 'David' },
      ];
    },
  };

  await assert.rejects(
    () => searchShowPhotos({ immich, query: 'David in Paris' }),
    (error) =>
      error instanceof PhotoShowSearchError &&
      error.status === 409 &&
      error.code === 'person_ambiguous',
  );
});
