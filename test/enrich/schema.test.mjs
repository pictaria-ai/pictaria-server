import test from 'node:test';
import assert from 'node:assert/strict';

import { OutputValidationError, enrichmentJsonSchema, validateAiOutput } from '../../src/enrich/schema.mjs';
import { loadV1Taxonomy, sampleOutput } from './helpers.mjs';

const taxonomy = loadV1Taxonomy();

test('valid output passes', () => {
  const output = sampleOutput();

  assert.deepEqual(validateAiOutput(output, taxonomy), output);
});

test('unknown tag fails', () => {
  const output = sampleOutput();
  output.candidate_tags.push({ tag: 'mountains', confidence: 0.9, reason: 'Bad free-form tag.' });

  assert.throws(() => validateAiOutput(output, taxonomy), OutputValidationError);
});

test('confidence out of range fails', () => {
  const output = sampleOutput();
  output.candidate_tags[0].confidence = 1.2;

  assert.throws(() => validateAiOutput(output, taxonomy), OutputValidationError);
});

test('manual frame tags are rejected in candidate tags', () => {
  const output = sampleOutput();
  output.candidate_tags.push({ tag: 'frame/eligible', confidence: 0.9, reason: 'Model must not decide this.' });

  assert.throws(() => validateAiOutput(output, taxonomy), OutputValidationError);
});

test('screenshot frame-worthy contradiction fails', () => {
  const output = sampleOutput();
  output.is_screenshot = true;
  output.candidate_tags.push({ tag: 'ai/quality/frame-worthy', confidence: 0.95, reason: 'Contradictory.' });

  assert.throws(() => validateAiOutput(output, taxonomy), OutputValidationError);
});

test('json schema restricts tags to the approved taxonomy', () => {
  const schema = enrichmentJsonSchema(taxonomy);
  const candidateEnum = schema.properties.candidate_tags.items.properties.tag.enum;
  const exclusionEnum = schema.properties.exclusion_reasons.items.properties.tag.enum;

  assert.ok(candidateEnum.includes('ai/quality/frame-worthy'));
  assert.ok(candidateEnum.includes('frame/review'));
  assert.ok(!candidateEnum.includes('frame/eligible'));
  assert.ok(exclusionEnum.every((tag) => tag.startsWith('ai/exclude/')));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.caption.maxLength, 4096);
  assert.equal(schema.properties.subjects.maxItems, 50);
  assert.equal(schema.properties.candidate_tags.items.properties.reason.maxLength, 1024);
});

test('provider-only fields are removed from normalized output without mutating the response', () => {
  const output = sampleOutput();
  output.provider_debug_dump = 'not part of the normalized contract';
  output.quality.provider_latency_ms = 123;
  output.scene.provider_label = 'outdoor';
  output.candidate_tags[0].provider_trace = 'private provider metadata';

  const normalized = validateAiOutput(output, taxonomy);

  assert.deepEqual(normalized, sampleOutput());
  assert.notEqual(normalized, output);
  assert.equal(output.provider_debug_dump, 'not part of the normalized contract');
  assert.equal(output.quality.provider_latency_ms, 123);
  assert.equal(output.scene.provider_label, 'outdoor');
  assert.equal(output.candidate_tags[0].provider_trace, 'private provider metadata');
});

test('oversized normalized output is rejected', () => {
  const longCaption = sampleOutput();
  longCaption.caption = '🙂'.repeat(1100); // 4,400 encoded bytes
  assert.throws(
    () => validateAiOutput(longCaption, taxonomy),
    /caption exceeds the 4096-byte limit/,
  );

  const tooManySubjects = sampleOutput();
  tooManySubjects.subjects = Array.from({ length: 51 }, () => 'person');
  assert.throws(() => validateAiOutput(tooManySubjects, taxonomy), /subjects contains too many items/);

  const aggregate = sampleOutput();
  aggregate.subjects = Array.from({ length: 50 }, () => 's'.repeat(512));
  aggregate.activities = Array.from({ length: 50 }, () => 'a'.repeat(512));
  aggregate.composition = Array.from({ length: 50 }, () => 'c'.repeat(512));
  assert.throws(() => validateAiOutput(aggregate, taxonomy), /AI output exceeds the 65536-byte limit/);
});
