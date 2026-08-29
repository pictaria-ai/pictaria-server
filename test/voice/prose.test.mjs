import assert from 'node:assert/strict';
import test from 'node:test';

import { createProvider, ProviderRequestError } from '../../src/enrich/providers.mjs';
import { canDescribeImages, cleanProseAnswer, generateProse, ProseGenerationError, resolveProseProvider } from '../../src/voice/prose.mjs';

// Both voice commands resolve one configured provider through the provider
// layer, with the response schema turned off for spoken answers.

function configWith(voice = {}, providers = {}) {
  return {
    voice: { proseProvider: 'cloud_openai', ...voice },
    providers: {
      cloud_openai: { apiKey: 'k', modelName: 'enrich-model' },
      venice: { apiKey: 'v', modelName: 'venice-enrich-model', baseUrl: 'https://api.venice.ai/api/v1' },
      local_ollama: { modelName: 'ollama-enrich-model', baseUrl: 'http://127.0.0.1:11434' },
      ...providers,
    },
  };
}

test('an explicit per-command model wins over every default', () => {
  const provider = resolveProseProvider(configWith({ proseProvider: 'venice' }), {
    model: 'small-fast-vlm',
    openAiDefaultModel: 'gpt-5.5',
  });
  assert.equal(provider.providerName, 'venice');
  assert.equal(provider.modelName, 'small-fast-vlm');
});

test('OpenAI keeps its historical per-command default so upgrades change nothing', () => {
  const provider = resolveProseProvider(configWith(), { openAiDefaultModel: 'gpt-5.4-nano' });
  assert.equal(provider.providerName, 'cloud_openai');
  // NOT the enrichment model: the ask command has always used a small
  // model, and switching it silently would cost latency and money.
  assert.equal(provider.modelName, 'gpt-5.4-nano');
});

test('any other provider falls back to the model it is configured with', () => {
  const provider = resolveProseProvider(configWith({ proseProvider: 'venice' }), {
    openAiDefaultModel: 'gpt-5.4-nano', // must not leak onto a non-OpenAI provider
  });
  assert.equal(provider.modelName, 'venice-enrich-model');
});

test('voice gets its own short timeout, not the enrichment budget', () => {
  const fast = resolveProseProvider(configWith({ proseProvider: 'local_ollama' }), { timeoutMs: 9000 });
  assert.equal(fast.timeoutMs, 9000);
  // A local Ollama provider defaults to minutes; the voice path must not
  // inherit that or the frame stands silent.
  const defaulted = resolveProseProvider(configWith({ proseProvider: 'local_ollama' }));
  assert.equal(defaulted.timeoutMs, 25000);
  // Absurdly small budgets are floored rather than making every call fail.
  assert.equal(resolveProseProvider(configWith(), { timeoutMs: 5 }).timeoutMs, 1000);
});

test('misconfiguration is a 503, named so the user can fix it', () => {
  assert.throws(
    () => resolveProseProvider({ voice: { proseProvider: 'venice' }, providers: {} }),
    (error) => error instanceof ProseGenerationError && error.status === 503
      && /Unknown voice provider: venice/.test(error.message),
  );
  assert.throws(
    () => resolveProseProvider(configWith({ proseProvider: 'venice' }, { venice: { apiKey: 'v', modelName: '' } })),
    (error) => error instanceof ProseGenerationError && error.status === 503
      && /No model is configured for venice/.test(error.message)
      && /Settings → AI Providers/.test(error.message),
  );
});

// --- the request each provider shape actually sends ---

function captureFetch(responseBody) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
  return { calls, fetchImpl };
}

test('OpenAI prose sends no schema and honors the caller budget', async () => {
  const { calls, fetchImpl } = captureFetch({ output_text: 'A quiet street in the rain.' });
  const provider = createProvider('cloud_openai', { apiKey: 'k', modelName: 'gpt-5.5', fetchImpl });
  const result = await provider.generateProse({
    systemPrompt: 'sys',
    userPrompt: 'user',
    images: [{ data: Buffer.from('img'), mimeType: 'image/jpeg', detail: 'high' }],
    maxOutputTokens: 420,
    imageDetail: 'high',
  });

  assert.equal(result.text, 'A quiet street in the rain.');
  const [call] = calls;
  assert.equal(call.body.max_output_tokens, 420);
  assert.equal(call.body.text, undefined, 'prose must not request a JSON schema');
  assert.equal(call.body.input[1].content[1].type, 'input_image');
  assert.equal(call.body.input[1].content[1].detail, 'high');
});

test('Venice prose keeps thinking suppressed and its own system prompt out', async () => {
  const { calls, fetchImpl } = captureFetch({ choices: [{ message: { content: 'Snow on the ridge.' } }] });
  const provider = createProvider('venice', { apiKey: 'v', modelName: 'qwen-vl', fetchImpl });
  const result = await provider.generateProse({
    systemPrompt: 'sys',
    userPrompt: 'user',
    images: [{ data: Buffer.from('img'), mimeType: 'image/jpeg' }],
    maxOutputTokens: 300,
  });

  assert.equal(result.text, 'Snow on the ridge.');
  const [call] = calls;
  assert.equal(call.body.response_format, undefined, 'prose must not constrain the grammar');
  assert.equal(call.body.max_tokens, 300);
  assert.equal(call.body.venice_parameters.include_venice_system_prompt, false);
  // A <think> block read aloud would be worse than silence.
  assert.equal(call.body.venice_parameters.disable_thinking, true);
  assert.equal(call.body.venice_parameters.strip_thinking_response, true);
});

test('Ollama prose omits format, disables thinking, and sends images only when present', async () => {
  const { calls, fetchImpl } = captureFetch({ message: { content: 'A birthday cake.' } });
  const provider = createProvider('local_ollama', { modelName: 'qwen3-vl:8b', fetchImpl });

  await provider.generateProse({ systemPrompt: 'sys', userPrompt: 'text only', images: [], maxOutputTokens: 200 });
  await provider.generateProse({
    systemPrompt: 'sys',
    userPrompt: 'with image',
    images: [{ data: Buffer.from('img'), mimeType: 'image/jpeg' }],
    maxOutputTokens: 200,
  });

  const [textOnly, withImage] = calls;
  assert.equal(textOnly.body.format, undefined, 'no schema on the prose path');
  assert.equal(textOnly.body.think, false);
  assert.equal(textOnly.body.options.num_predict, 200);
  assert.equal(textOnly.body.messages[1].images, undefined, 'a text question sends no image');
  assert.equal(withImage.body.messages[1].images.length, 1);
});

test('an Ollama thinking channel is never spoken as the answer', async () => {
  // Enrichment legitimately reads a misrouted schema-constrained answer out
  // of `thinking`; prose must not, because there it is chain-of-thought.
  const { fetchImpl } = captureFetch({ message: { content: '', thinking: 'Let me consider the pixels…' } });
  const provider = createProvider('local_ollama', { modelName: 'm', fetchImpl });
  const result = await provider.generateProse({ systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 100 });
  assert.equal(cleanProseAnswer(result.text), '');
});

// --- the shared retry/cleanup contract ---

test('an empty answer is retried once with a nudge and a bigger budget, then fails', async () => {
  const attempts = [];
  const provider = {
    providerName: 'test',
    modelName: 'test-model',
    async generateProse({ userPrompt, maxOutputTokens }) {
      attempts.push({ userPrompt, maxOutputTokens });
      return { rawOutput: {}, text: attempts.length === 1 ? '' : 'The second time it answered.' };
    },
  };

  const answer = await generateProse({
    provider,
    prompt: 'describe this',
    maxOutputTokens: 400,
    emptyRetryMaxOutputTokens: 700,
    retryNudge: 'Answer concisely.',
  });

  assert.equal(answer.text, 'The second time it answered.');
  assert.equal(answer.provider, 'test');
  assert.equal(answer.model, 'test-model');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].maxOutputTokens, 400);
  assert.equal(attempts[1].maxOutputTokens, 800, 'doubled, floored at the retry minimum');
  assert.match(attempts[1].userPrompt, /Answer concisely\./);

  // Still empty after the retry → a clean error, not an empty spoken answer.
  const alwaysEmpty = { providerName: 'test', modelName: 'm', generateProse: async () => ({ text: '  ' }) };
  await assert.rejects(
    generateProse({ provider: alwaysEmpty, prompt: 'p', maxOutputTokens: 100 }),
    (error) => error instanceof ProseGenerationError && /empty/.test(error.message),
  );
});

test('spoken answers are unwrapped and collapsed onto one line', () => {
  assert.equal(cleanProseAnswer('  "Taken in Kyoto\\nin spring."  '), 'Taken in Kyoto in spring.');
  assert.equal(cleanProseAnswer(null), '');
});

// --- deadline and fallback regressions ---

test('a confirmed timeout is spoken, not thrown — silence is the worst answer', async (t) => {
  // The Frame speaks only successful responses; its error path paints the
  // overlay and says nothing. An error here is dead air in TTS-only mode.
  // A socket that accepts and then hangs is the only way to exercise a real
  // deadline — a refused connection is a transport error, not a timeout.
  const { createServer } = await import('node:http');
  const hang = createServer(() => { /* never responds */ });
  await new Promise((resolve) => hang.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => hang.close(resolve)));

  const { generateAskAnswer } = await import('../../src/voice/askQuestion.mjs');
  const answer = await generateAskAnswer({
    question: 'how far away is the moon',
    config: {
      voice: { proseProvider: 'local_ollama', proseTimeoutMs: 1000, askMaxOutputTokens: 600 },
      providers: { local_ollama: { modelName: 'm', baseUrl: `http://127.0.0.1:${hang.address().port}` } },
    },
  });

  assert.equal(answer.fallback, true);
  assert.match(answer.speakText, /took too long/);
  assert.equal(answer.text, answer.speakText, 'the overlay and the speech agree');
  assert.equal(answer.provider, 'local_ollama', 'the fallback still names who was asked');
});

test('a transport failure that is not a timeout stays a 502 error', async () => {
  // DNS failures, refused connections and unparseable bodies also arrive
  // without an HTTP status; only a real deadline may claim 504/fallback.
  const provider = {
    providerName: 'test',
    modelName: 'm',
    timeoutMs: 5000,
    async generateProse() {
      throw new ProviderRequestError('test request failed: getaddrinfo ENOTFOUND nope.invalid');
    },
  };
  await assert.rejects(
    generateProse({ provider, prompt: 'p', maxOutputTokens: 100 }),
    (error) => error instanceof ProseGenerationError && error.status === 502 && error.timeout === false,
  );
});

test('provider error detail is bounded before it reaches the frame overlay', async () => {
  const provider = {
    providerName: 'test',
    modelName: 'm',
    timeoutMs: 5000,
    async generateProse() {
      throw new ProviderRequestError(`test request failed: ${'x'.repeat(100000)}`);
    },
  };
  await assert.rejects(
    generateProse({ provider, prompt: 'p', maxOutputTokens: 100 }),
    (error) => error.message.length <= 240,
  );
});

test('the retry shares one deadline instead of getting a fresh full budget', async () => {
  // Two attempts each taking the full timeout would run to ~2x the
  // configured budget — past the 45s the Frame waits before giving up.
  const budgets = [];
  let clock = 0;
  const provider = {
    providerName: 'test',
    modelName: 'm',
    timeoutMs: 25000,
    async generateProse() {
      budgets.push(provider.timeoutMs);
      clock += 20000; // the first attempt burns most of the deadline
      return { text: budgets.length === 1 ? '' : 'answered on the retry' };
    },
  };
  const answer = await generateProse({
    provider,
    prompt: 'p',
    maxOutputTokens: 100,
    now: () => clock,
  });

  assert.equal(answer.text, 'answered on the retry');
  assert.equal(budgets[0], 25000);
  assert.equal(budgets[1], 5000, 'the retry only gets what is left of the deadline');
});

test('an empty answer with no budget left reports the deadline, not an empty model', async () => {
  let clock = 0;
  const provider = {
    providerName: 'test',
    modelName: 'm',
    timeoutMs: 25000,
    async generateProse() {
      clock += 25000;
      return { text: '' };
    },
  };
  await assert.rejects(
    generateProse({ provider, prompt: 'p', maxOutputTokens: 100, now: () => clock }),
    (error) => error.status === 504 && error.timeout === true && /ran out of time/.test(error.message),
  );
});

test('an OpenAI refusal is spoken instead of being retried into an empty-answer error', async () => {
  const { calls, fetchImpl } = captureFetch({
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I can’t help with that.' }] }],
  });
  const provider = createProvider('cloud_openai', { apiKey: 'k', modelName: 'gpt-5.5', fetchImpl });
  const answer = await generateProse({ provider, prompt: 'p', maxOutputTokens: 100 });

  assert.equal(answer.text, 'I can’t help with that.');
  assert.equal(calls.length, 1, 'a refusal is an answer — it must not burn the retry');
});

test('the budget covers the work before the model, not just the model call', async () => {
  // The route starts the clock before its Immich lookups. If those spend
  // the budget, asking a model only guarantees the Frame discards the
  // answer — say the fallback line instead.
  const { generateAskAnswer } = await import('../../src/voice/askQuestion.mjs');
  const answer = await generateAskAnswer({
    question: 'how far away is the moon',
    // Whatever ran before us already burned it.
    budgetMs: () => 200,
    config: {
      voice: { proseProvider: 'cloud_openai', askMaxOutputTokens: 600, proseTimeoutMs: 25000 },
      providers: { cloud_openai: { apiKey: 'k', modelName: 'gpt-5.5' } },
    },
  });

  assert.equal(answer.fallback, true);
  assert.match(answer.speakText, /took too long/);
});

test('a healthy remaining budget still answers normally', async () => {
  const { generateAskAnswer } = await import('../../src/voice/askQuestion.mjs');
  const { createServer } = await import('node:http');
  const ollama = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: { content: 'About 239,000 miles.' } }));
  });
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  try {
    const answer = await generateAskAnswer({
      question: 'how far away is the moon',
      budgetMs: () => 20000,
      config: {
        voice: { proseProvider: 'local_ollama', askMaxOutputTokens: 600, proseTimeoutMs: 25000 },
        providers: { local_ollama: { modelName: 'm', baseUrl: `http://127.0.0.1:${ollama.address().port}` } },
      },
    });
    assert.equal(answer.text, 'About 239,000 miles.');
    assert.equal(answer.fallback, undefined, 'a real answer is not flagged as a fallback');
  } finally {
    await new Promise((resolve) => ollama.close(resolve));
  }
});

test('the LM Studio voice guidance survives the error cap intact', async () => {
  // It is our own message, not untrusted provider detail: truncating it
  // mid-sentence would hide both workarounds it exists to offer.
  const { LM_WEBP_VOICE_GUIDANCE } = await import('../../src/enrich/providers.mjs');
  assert.ok(LM_WEBP_VOICE_GUIDANCE.length <= 240, 'must fit under the voice error cap');
  assert.match(LM_WEBP_VOICE_GUIDANCE, /Settings → Voice/);
});

test('readiness knows LM Studio cannot describe images off macOS', () => {
  // Health must not promise a combination that fails deterministically —
  // constructing the provider succeeds on Linux, so the rule lives here.
  assert.equal(canDescribeImages('local_lmstudio', 'darwin'), true);
  assert.equal(canDescribeImages('local_lmstudio', 'linux'), false);
  // Every other provider is fine everywhere.
  for (const name of ['cloud_openai', 'venice', 'openrouter', 'cloud_ollama', 'local_ollama']) {
    assert.equal(canDescribeImages(name, 'linux'), true, name);
  }
});

test('an OpenAI answer split across parts is spoken whole, not truncated', async () => {
  // The enrichment extractor returns the first part — right for a single
  // JSON document, wrong for a sentence read aloud, which would simply
  // stop mid-thought.
  const { calls, fetchImpl } = captureFetch({
    output: [{
      type: 'message',
      content: [
        { type: 'output_text', text: 'Taken in Kyoto in spring.' },
        { type: 'output_text', text: 'The blossom suggests early April.' },
      ],
    }],
  });
  const provider = createProvider('cloud_openai', { apiKey: 'k', modelName: 'gpt-5.5', fetchImpl });
  const answer = await generateProse({ provider, prompt: 'p', maxOutputTokens: 200 });

  assert.equal(answer.text, 'Taken in Kyoto in spring. The blossom suggests early April.');
  assert.equal(calls.length, 1, 'a complete answer must not burn the retry');
});
