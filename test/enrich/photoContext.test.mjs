import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnrichmentPhotoContext } from '../../src/enrich/photoContext.mjs';

test('buildEnrichmentPhotoContext handles empty or null asset gracefully', () => {
  assert.equal(buildEnrichmentPhotoContext(null), '');
  assert.equal(buildEnrichmentPhotoContext({}), '');
  assert.equal(buildEnrichmentPhotoContext({ asset: {} }), '- People: none detected by face recognition');
});

test('buildEnrichmentPhotoContext formats named people and unnamed faces correctly', () => {
  const assetNamed = {
    people: [
      { id: 'p1', name: 'Alice' },
      { id: 'p2', name: 'Bob' },
    ],
  };
  const ctxNamed = buildEnrichmentPhotoContext({ asset: assetNamed });
  assert.ok(ctxNamed.includes('People identified: Alice, Bob (2 persons)'));

  const assetUnnamed = {
    people: [
      { id: 'p1', name: '' },
      { id: 'p2', name: null },
    ],
  };
  const ctxUnnamed = buildEnrichmentPhotoContext({ asset: assetUnnamed });
  assert.ok(ctxUnnamed.includes('People: 2 unidentified faces detected'));
});

test('buildEnrichmentPhotoContext formats date, time, season, and time of day', () => {
  const asset = {
    exifInfo: { dateTimeOriginal: '2024-07-15T14:30:00.000Z' },
  };
  const ctx = buildEnrichmentPhotoContext({ asset });
  assert.ok(ctx.includes('Date & time: July 15, 2024'));
  assert.ok(ctx.includes('summer'));
  assert.ok(ctx.includes('afternoon') || ctx.includes('evening') || ctx.includes('morning'));
});

test('buildEnrichmentPhotoContext prioritizes enrichedLocation over EXIF location', () => {
  const asset = {
    exifInfo: {
      city: 'Paris',
      country: 'France',
      latitude: 48.8584,
      longitude: 2.2945,
    },
  };
  const enrichedLocation = {
    label: 'Eiffel Tower, Paris, France',
  };
  const ctx = buildEnrichmentPhotoContext({ asset, enrichedLocation });
  assert.ok(ctx.includes('Location: Eiffel Tower, Paris, France (coordinates: 48.8584, 2.2945)'));
});

test('buildEnrichmentPhotoContext formats camera and lens settings', () => {
  const asset = {
    exifInfo: {
      make: 'Sony',
      model: 'ILCE-7M4',
      lensModel: 'FE 24-70mm F2.8 GM II',
      focalLength: 50,
      fNumber: 2.8,
      exposureTime: '0.004',
      iso: 200,
    },
  };
  const ctx = buildEnrichmentPhotoContext({ asset });
  assert.ok(ctx.includes('Sony ILCE-7M4 FE 24-70mm F2.8 GM II (50mm, f/2.8, 1/250s, ISO 200)'));
});

test('buildEnrichmentPhotoContext includes Immich machine learning signals', () => {
  const asset = {
    smartInfo: {
      clipDescription: 'A dog playing in a grassy park under sunlight',
      tags: ['dog', 'outdoor', 'park', 'grass'],
      objects: ['dog', 'tree'],
    },
  };
  const ctx = buildEnrichmentPhotoContext({ asset });
  assert.ok(ctx.includes('Immich CLIP scene description: A dog playing in a grassy park under sunlight'));
  assert.ok(ctx.includes('Immich smart tags: dog, outdoor, park, grass'));
  assert.ok(ctx.includes('Detected objects: dog, tree'));
});
