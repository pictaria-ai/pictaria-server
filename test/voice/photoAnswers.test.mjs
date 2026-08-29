import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPhotoAnswers, buildWhenAnswer, buildWhereAnswer, formatPlace, parseDateParts } from '../../src/voice/photoAnswers.mjs';

test('formats US places as city, state', () => {
  assert.equal(
    buildWhereAnswer({
      city: 'Denver',
      state: 'Colorado',
      country: 'United States',
    }).text,
    'This was taken in Denver, Colorado.',
  );
});

test('normalizes US state abbreviations to full state names', () => {
  assert.equal(
    buildWhereAnswer({
      city: 'Jackson',
      state: 'WY',
      country: 'United States',
    }).text,
    'This was taken in Jackson, Wyoming.',
  );
});

test('formats non-US places as city, country', () => {
  assert.equal(
    buildWhereAnswer({
      city: 'Kyoto',
      country: 'Japan',
    }).text,
    'This was taken in Kyoto, Japan.',
  );
});

test('promotes known non-US parent display places', () => {
  assert.equal(
    buildWhereAnswer({
      city: 'Kanda-awajicho',
      state: 'Tokyo',
      country: 'Japan',
    }).text,
    'This was taken in Tokyo, Japan.',
  );
  assert.equal(
    buildWhereAnswer({
      city: 'Roma Norte',
      state: 'Mexico City',
      country: 'Mexico',
    }).text,
    'This was taken in Mexico City, Mexico.',
  );
  assert.equal(
    buildWhereAnswer({
      city: 'Quinze-Vingts',
      state: 'Île-de-France',
      country: 'France',
    }).text,
    'This was taken in Paris, France.',
  );
});

test('uses partial location metadata', () => {
  assert.equal(formatPlace({ city: '', state: '', country: 'Japan' }), 'Japan');
  assert.equal(formatPlace({ city: '', state: 'Colorado', country: '' }), 'Colorado');
});

test('uses enriched location label when specific raw location fields are unavailable', () => {
  assert.equal(
    buildWhereAnswer({
      locationLabel: 'Wyoming, USA',
      exifInfo: {
        country: 'United States of America',
      },
    }).text,
    'This was taken in Wyoming, USA.',
  );
});

test('prefers computed display location over legacy labels when raw fields are available', () => {
  assert.equal(
    buildWhereAnswer({
      locationLabel: 'Kanda-awajicho, Japan',
      exifInfo: {
        city: 'Kanda-awajicho',
        state: 'Tokyo',
        country: 'Japan',
      },
    }).text,
    'This was taken in Tokyo, Japan.',
  );
});

test('returns missing metadata response for location without metadata', () => {
  assert.equal(buildWhereAnswer({}).text, "This photo doesn't have that metadata.");
});

test('formats date without time of day', () => {
  assert.equal(
    buildWhenAnswer({
      exifInfo: {
        dateTimeOriginal: '2023-04-12T17:42:00-06:00',
      },
    }).text,
    'This was taken on April 12, 2023.',
  );
});

test('supports Immich localDateTime date fallback', () => {
  assert.equal(
    buildPhotoAnswers({
      localDateTime: '2024-01-05T12:00:00.000Z',
    }).when.text,
    'This was taken on January 5, 2024.',
  );
});

test('returns missing metadata response for date without metadata', () => {
  assert.equal(buildWhenAnswer({}).text, "This photo doesn't have that metadata.");
});

test('parses date parts defensively', () => {
  assert.deepEqual(parseDateParts('2024-02-29T12:00:00Z'), { year: 2024, month: 2, day: 29 });
  assert.equal(parseDateParts('2023-02-29T12:00:00Z'), null);
  assert.equal(parseDateParts('not-a-date'), null);
});
