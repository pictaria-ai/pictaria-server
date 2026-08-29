import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLocationEnrichment, buildLocationEnrichment, formatLocationLabel } from '../../src/ambient/geocoding.mjs';

test('formats state and country from reverse geocoding', () => {
  assert.equal(
    formatLocationLabel({
      state: 'Wyoming',
      country: 'United States',
      countryCode: 'us',
    }),
    'Wyoming, USA',
  );
});

test('preserves existing Immich location fields when applying enrichment', () => {
  const asset = applyLocationEnrichment(
    {
      id: 'asset-1',
      exifInfo: {
        city: 'Jackson',
        state: 'Wyoming',
        country: 'United States of America',
      },
    },
    {
      schemaVersion: 1,
      label: 'Montana, USA',
      city: null,
      state: 'Montana',
      country: 'United States',
      countryCode: 'US',
      latitude: 45,
      longitude: -110,
      source: 'geoapify',
      createdAt: '2026-06-23T00:00:00.000Z',
    },
  );

  assert.equal(asset.locationLabel, 'Montana, USA');
  assert.equal(asset.exifInfo.city, 'Jackson');
  assert.equal(asset.exifInfo.state, 'Wyoming');
  assert.equal(asset.exifInfo.country, 'United States of America');
});

test('builds a stable enrichment payload', () => {
  assert.deepEqual(
    buildLocationEnrichment(
      {
        state: 'Wyoming',
        country: 'United States',
        countryCode: 'us',
        source: 'geoapify',
      },
      { latitude: 44.942078, longitude: -109.776389 },
      new Date('2026-06-23T00:00:00.000Z'),
    ),
    {
      schemaVersion: 1,
      label: 'Wyoming, USA',
      city: null,
      state: 'Wyoming',
      country: 'United States',
      countryCode: 'US',
      latitude: 44.942078,
      longitude: -109.776389,
      source: 'geoapify',
      createdAt: '2026-06-23T00:00:00.000Z',
    },
  );
});
