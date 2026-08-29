import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProvider, synthesizeSpeech, validateTtsRequest } from '../../src/voice/tts.mjs';

test('validates brief tts requests', () => {
  assert.deepEqual(validateTtsRequest({ text: '  Hello there. ', provider: 'openai' }), {
    value: {
      text: 'Hello there.',
      provider: 'openai',
      model: undefined,
      voice: undefined,
      format: undefined,
    },
  });
});

test('rejects missing tts text', () => {
  assert.deepEqual(validateTtsRequest({ text: '' }), {
    error: 'Text is required.',
  });
});

test('rejects long tts text', () => {
  assert.deepEqual(validateTtsRequest({ text: 'x'.repeat(501) }), {
    error: 'Text is too long for a brief photo-frame response.',
  });
});

test('normalizes provider names', () => {
  assert.equal(normalizeProvider(' OpenAI '), 'openai');
  assert.equal(normalizeProvider('ElevenLabs'), 'elevenlabs');
  assert.equal(normalizeProvider('openia'), '');
});

test('treats unsupported configured tts provider as not configured', async () => {
  await assert.rejects(
    synthesizeSpeech({
      config: {
        ttsProvider: 'openia',
      },
      text: 'Hello there.',
    }),
    (error) => {
      assert.equal(error.name, 'TtsProviderError');
      assert.equal(error.status, 501);
      assert.equal(error.message, 'TTS provider is not configured.');
      return true;
    },
  );
});

test('TTS errors expose only bounded allowlisted detail with credentials redacted', async () => {
  const secret = 'tts:test/+ key';
  await assert.rejects(
    synthesizeSpeech({
      config: {
        ttsProvider: 'openai',
        openAiApiKey: secret,
        openAiTtsModel: 'test-model',
        openAiTtsVoice: 'test-voice',
        openAiTtsFormat: 'mp3',
        openAiTtsSpeed: 1,
        openAiRequestTimeoutMs: 1000,
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          body: null,
          json: async () => ({
            error: {
              code: 'bad_key',
              message: `exact ${secret}; encoded ${encodeURIComponent(secret)}; Authorization: Bearer reflected-value`,
            },
            headers: { authorization: secret },
          }),
        }),
      },
      text: 'Hello there.',
    }),
    (error) => {
      assert.match(error.message, /code: bad_key/);
      assert.doesNotMatch(error.message, /tts:test|tts%3Atest|reflected-value|headers/i);
      assert.ok(Buffer.byteLength(error.message, 'utf8') <= 512);
      return true;
    },
  );
});
