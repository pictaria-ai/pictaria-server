import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveReview, deriveState, reviewConfig } from '../../src/enrich/reviewBuckets.mjs';
import { loadV1Taxonomy } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();

test('review config loads three buckets from the taxonomy in priority order', () => {
  const config = reviewConfig(taxonomy);

  assert.deepEqual(config.buckets.map((bucket) => bucket.id), ['unlikely', 'candidates', 'should_review']);
  assert.equal(config.buckets.at(-1).fallback, true);
  assert.ok(config.privacyReviewTags.has('ai/exclude/private'));
});

test('frame-worthy photos land in candidates and auto-display while undecided', () => {
  const review = deriveReview(new Set(['ai/quality/frame-worthy', 'ai/scene/mountains']), taxonomy, {
    output: { quality: { frame_worthy_score: 0.91 } },
  });

  assert.equal(review.bucket, 'candidates');
  assert.equal(review.state, 'undecided');
  assert.equal(review.autoDisplay, true);
  assert.equal(review.frameScore, 0.91);
});

test('hard exclusions land in unlikely regardless of score', () => {
  const review = deriveReview(new Set(['ai/exclude/screenshot', 'ai/quality/frame-worthy']), taxonomy);

  assert.equal(review.bucket, 'unlikely');
  assert.ok(review.reasons.some((reason) => reason.includes('screenshot')));
});

test('quality hard exclusions land in unlikely via hard-exclusion matching', () => {
  const review = deriveReview(new Set(['ai/quality/blurry']), taxonomy);

  assert.equal(review.bucket, 'unlikely');
  assert.ok(review.reasons.some((reason) => reason.includes('blurry')));
});

test('everything between candidates and unlikely falls into should_review', () => {
  // Former Review Quality, Review Privacy, Good Only, and Neutral all merge.
  const borderline = deriveReview(new Set(['frame/review', 'ai/quality/good']), taxonomy, {
    output: { quality: { frame_worthy_score: 0.72 }, exclusion_reasons: [] },
  });
  const privacy = deriveReview(new Set(['frame/review']), taxonomy, {
    output: {
      quality: { frame_worthy_score: 0.5 },
      exclusion_reasons: [{ tag: 'ai/exclude/private', confidence: 0.55, reason: 'maybe' }],
    },
  });
  const neutral = deriveReview(new Set(['ai/people/none']), taxonomy);

  assert.equal(borderline.bucket, 'should_review');
  assert.ok(borderline.reasons.some((reason) => reason.startsWith('borderline')));
  assert.equal(privacy.bucket, 'should_review');
  assert.ok(privacy.reasons.some((reason) => reason.startsWith('privacy?')));
  assert.equal(neutral.bucket, 'should_review');
  assert.deepEqual(neutral.reasons, ['no strong signal']);
});

test('human state axis is independent of buckets and rejection wins', () => {
  assert.equal(deriveState(new Set(['frame/eligible'])), 'approved');
  assert.equal(deriveState(new Set(['frame/favorite'])), 'approved');
  assert.equal(deriveState(new Set(['frame/never-show', 'frame/reviewed'])), 'rejected');
  assert.equal(deriveState(new Set(['frame/reviewed'])), 'reviewed');
  assert.equal(deriveState(new Set(['ai/quality/good'])), 'undecided');

  const approvedDespiteExclusion = deriveReview(new Set(['frame/eligible', 'ai/exclude/private']), taxonomy);
  assert.equal(approvedDespiteExclusion.state, 'approved');
  assert.equal(approvedDespiteExclusion.autoDisplay, true);
  assert.equal(approvedDespiteExclusion.bucket, 'unlikely');
});

test('manual frame tags never influence bucket matching', () => {
  // frame/never-show is in hard_exclusion_tags but is the human axis.
  const review = deriveReview(new Set(['frame/never-show', 'ai/quality/frame-worthy']), taxonomy, {
    output: { quality: { frame_worthy_score: 0.9 } },
  });

  assert.equal(review.bucket, 'candidates');
  assert.equal(review.state, 'rejected');
  assert.equal(review.autoDisplay, false);
});
