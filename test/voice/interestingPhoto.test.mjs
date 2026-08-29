import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildInterestingPhotoContext,
  buildInterestingPhotoPrompt,
} from '../../src/voice/interestingPhoto.mjs';
import { cleanProseAnswer } from '../../src/voice/prose.mjs';

test('builds useful prompt context from asset metadata', () => {
  const context = buildInterestingPhotoContext({
    id: 'asset-1',
    originalFileName: 'IMG_1234.JPG',
    exifInfo: {
      city: 'Kanda-awajicho',
      state: 'Tokyo',
      country: 'Japan',
      dateTimeOriginal: '2024-03-08T14:20:00+09:00',
    },
  });

  assert.deepEqual(context, {
    dateTaken: 'March 8, 2024',
    location: 'Tokyo, Japan',
    originalFileName: 'IMG_1234.JPG',
  });
});

test('a custom template still receives the photo context block', () => {
  const prompt = buildInterestingPhotoPrompt(
    { localDateTime: '2024-01-05T12:00:00.000Z', locationLabel: 'Wyoming, USA' },
    'Focus on the people, not the place.\n\n{context}\n\nOne warm sentence.',
  );

  assert.match(prompt, /^Focus on the people, not the place\./);
  assert.match(prompt, /Date taken: January 5, 2024/);
  assert.match(prompt, /Location: Wyoming, USA/);
  assert.match(prompt, /One warm sentence\.$/);
});

test('interesting photo prompt asks for a concise grounded interesting answer', () => {
  const prompt = buildInterestingPhotoPrompt({
    localDateTime: '2024-01-05T12:00:00.000Z',
    locationLabel: 'Wyoming, USA',
  });

  assert.match(prompt, /less than 120 words/);
  assert.match(prompt, /interesting fact, quirk/);
  assert.match(prompt, /Preferably you can allude to something in the image/);
  assert.match(prompt, /Do not invent certainty/);
  assert.match(prompt, /Date taken: January 5, 2024/);
  assert.match(prompt, /Location: Wyoming, USA/);
});

test('cleans provider answer for display and speech', () => {
  assert.equal(cleanProseAnswer('  "A cool thing\\nabout this photo."  '), 'A cool thing about this photo.');
});
