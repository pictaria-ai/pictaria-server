import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveDisplayStatus } from '../../src/enrich/displayStatus.mjs';
import { loadV1Taxonomy } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();

test('frame-worthy without exclusions auto-displays', () => {
  const status = deriveDisplayStatus(new Set(['ai/quality/frame-worthy', 'ai/scene/mountains']), taxonomy);

  assert.equal(status.status, 'auto_candidate');
  assert.equal(status.autoDisplay, true);
});

test('hard exclusion blocks auto display', () => {
  const status = deriveDisplayStatus(new Set(['ai/quality/frame-worthy', 'ai/exclude/private']), taxonomy);

  assert.equal(status.status, 'excluded');
  assert.equal(status.autoDisplay, false);
});

test('manual eligible overrides ai exclusion', () => {
  const status = deriveDisplayStatus(
    new Set(['frame/eligible', 'ai/quality/frame-worthy', 'ai/exclude/private']),
    taxonomy,
  );

  assert.equal(status.status, 'manual_eligible');
  assert.equal(status.autoDisplay, true);
});

test('reviewed ai exclusion moves to reviewed_excluded', () => {
  const status = deriveDisplayStatus(
    new Set(['frame/reviewed', 'ai/quality/frame-worthy', 'ai/exclude/private']),
    taxonomy,
  );

  assert.equal(status.status, 'reviewed_excluded');
  assert.equal(status.autoDisplay, false);
});

test('reviewed never-show moves to reviewed_excluded', () => {
  const status = deriveDisplayStatus(
    new Set(['frame/reviewed', 'frame/never-show', 'ai/quality/frame-worthy']),
    taxonomy,
  );

  assert.equal(status.status, 'reviewed_excluded');
  assert.equal(status.autoDisplay, false);
});

test('reviewed neutral moves to reviewed', () => {
  const status = deriveDisplayStatus(new Set(['frame/reviewed', 'ai/people/none']), taxonomy);

  assert.equal(status.status, 'reviewed');
  assert.equal(status.autoDisplay, false);
});

test('reviewed good moves to reviewed', () => {
  const status = deriveDisplayStatus(new Set(['frame/reviewed', 'ai/quality/good', 'ai/scene/outdoors']), taxonomy);

  assert.equal(status.status, 'reviewed');
  assert.equal(status.autoDisplay, false);
});

test('review with privacy uncertainty is privacy review', () => {
  const status = deriveDisplayStatus(new Set(['frame/review', 'ai/quality/good']), taxonomy, {
    output: {
      quality: { frame_worthy_score: 0.72 },
      exclusion_reasons: [{ tag: 'ai/exclude/private', confidence: 0.55, reason: 'Possible private info.' }],
    },
  });

  assert.equal(status.status, 'review_privacy');
  assert.equal(status.autoDisplay, false);
});

test('review with only borderline score is quality review', () => {
  const status = deriveDisplayStatus(new Set(['frame/review', 'ai/quality/good']), taxonomy, {
    output: { quality: { frame_worthy_score: 0.72 }, exclusion_reasons: [] },
  });

  assert.equal(status.status, 'review_quality');
  assert.equal(status.autoDisplay, false);
});

test('good without review is good_not_candidate', () => {
  const status = deriveDisplayStatus(new Set(['ai/quality/good', 'ai/subject/food']), taxonomy);

  assert.equal(status.status, 'good_not_candidate');
  assert.equal(status.autoDisplay, false);
});
