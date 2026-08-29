import test from 'node:test';
import assert from 'node:assert/strict';

import { mapOutputToTags } from '../../src/enrich/mapTags.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();

function tagsFor(output) {
  return new Set(mapOutputToTags(output, taxonomy).map((decision) => decision.tag));
}

test('frame-worthy without exclusions', () => {
  const tags = tagsFor(sampleOutput());

  assert.ok(tags.has('ai/quality/frame-worthy'));
  assert.ok(!tags.has('ai/quality/good'));
  assert.ok(tags.has('ai/scene/mountains'));
  assert.ok(tags.has('ai/people/none'));
});

test('license plate alone does not block frame-worthy', () => {
  const output = sampleOutput();
  output.has_license_plate = true;
  const tags = tagsFor(output);

  assert.ok(tags.has('ai/quality/frame-worthy'));
});

test('borderline quality adds review', () => {
  const output = sampleOutput();
  output.quality.frame_worthy_score = 0.7;
  const tags = tagsFor(output);

  assert.ok(tags.has('frame/review'));
  assert.ok(!tags.has('ai/quality/frame-worthy'));
});

test('high-confidence exclusion suppresses frame-worthy and good', () => {
  const output = sampleOutput();
  output.exclusion_reasons = [
    { tag: 'ai/exclude/screenshot', confidence: 0.9, reason: 'UI capture.' },
  ];
  const tags = tagsFor(output);

  assert.ok(tags.has('ai/exclude/screenshot'));
  assert.ok(!tags.has('ai/quality/frame-worthy'));
  assert.ok(!tags.has('ai/quality/good'));
});

test('near-threshold exclusion blocks frame-worthy but keeps good', () => {
  const output = sampleOutput();
  output.exclusion_reasons = [
    { tag: 'ai/exclude/whiteboard', confidence: 0.65, reason: 'Possible whiteboard.' },
  ];
  const tags = tagsFor(output);

  assert.ok(!tags.has('ai/exclude/whiteboard'));
  assert.ok(!tags.has('ai/quality/frame-worthy'));
  assert.ok(tags.has('ai/quality/good'));
});

test('privacy uncertainty triggers review', () => {
  const output = sampleOutput();
  output.exclusion_reasons = [
    { tag: 'ai/exclude/private', confidence: 0.5, reason: 'Possible private info.' },
  ];
  const tags = tagsFor(output);

  assert.ok(tags.has('frame/review'));
});

test('decisions keep the highest confidence per tag and sort by tag', () => {
  const output = sampleOutput();
  output.candidate_tags.push({ tag: 'ai/scene/mountains', confidence: 0.99, reason: 'Stronger duplicate.' });
  const decisions = mapOutputToTags(output, taxonomy);
  const mountains = decisions.find((decision) => decision.tag === 'ai/scene/mountains');

  assert.equal(mountains.confidence, 0.99);
  const tags = decisions.map((decision) => decision.tag);
  assert.deepEqual(tags, [...tags].sort());
});
