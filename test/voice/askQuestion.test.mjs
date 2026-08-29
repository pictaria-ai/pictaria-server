import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAskPrompt, generateAskAnswer, validateAskRequest } from '../../src/voice/askQuestion.mjs';

test('validateAskRequest requires a non-empty question', () => {
  assert.equal(validateAskRequest({}).error, 'question is required.');
  assert.equal(validateAskRequest({ question: '   ' }).error, 'question is required.');
  assert.equal(validateAskRequest({ question: 42 }).error, 'question is required.');
});

test('validateAskRequest trims and returns the question', () => {
  assert.deepEqual(validateAskRequest({ question: '  who painted the mona lisa  ' }), {
    value: { question: 'who painted the mona lisa' },
  });
});

test('validateAskRequest rejects runaway transcripts', () => {
  const result = validateAskRequest({ question: 'a'.repeat(501) });
  assert.match(result.error, /limited to 500 characters/);
});

test('ask prompt pins spoken one-shot behavior', () => {
  const prompt = buildAskPrompt('how far away is the moon');

  assert.match(prompt, /Question: how far away is the moon/);
  assert.match(prompt, /two to four short sentences/);
  assert.match(prompt, /under 130 words/);
  assert.match(prompt, /cannot see the photo currently showing/);
  assert.match(prompt, /never ask a follow-up question/);
  assert.match(prompt, /Do not invent certainty/);
  assert.match(prompt, /no markdown, labels, or quotation marks/);
});

test('a custom template replaces the built-in prompt but keeps the question', () => {
  const prompt = buildAskPrompt('how far away is the moon', 'Answer like a pirate: {question}');

  assert.equal(prompt, 'Answer like a pirate: how far away is the moon');
});

test('an empty template falls back to the built-in prompt', () => {
  assert.equal(buildAskPrompt('why is the sky blue', ''), buildAskPrompt('why is the sky blue'));
});

test('generateAskAnswer fails closed when the chosen provider is unusable', async () => {
  // The default provider is OpenAI, whose key is missing here. The command
  // must surface its own 503 rather than the provider's status: the app
  // reads a 404 from us as "old server, update needed".
  await assert.rejects(
    generateAskAnswer({
      question: 'how far away is the moon',
      config: {
        voice: { proseProvider: 'cloud_openai', openAiAskModel: 'gpt-5.4-nano', askMaxOutputTokens: 600 },
        providers: { cloud_openai: { apiKey: '', modelName: 'gpt-5.5' } },
      },
    }),
    (error) => {
      assert.equal(error.name, 'AskQuestionError');
      assert.equal(error.status, 503);
      assert.equal(error.provider, 'cloud_openai');
      assert.equal(error.model, 'gpt-5.4-nano');
      assert.match(error.message, /OPENAI_API_KEY/);
      return true;
    },
  );
});

test('generateAskAnswer refuses a provider that is not configured at all', async () => {
  await assert.rejects(
    generateAskAnswer({
      question: 'how far away is the moon',
      config: { voice: { proseProvider: 'venice' }, providers: {} },
    }),
    (error) => {
      assert.equal(error.name, 'AskQuestionError');
      assert.equal(error.status, 503);
      assert.equal(error.provider, 'venice');
      assert.equal(error.model, null);
      assert.match(error.message, /Unknown voice provider: venice/);
      return true;
    },
  );
});
