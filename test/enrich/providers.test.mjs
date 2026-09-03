import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { parseJsonContent } from '../../src/enrich/jsonUtils.mjs';
import {
  LmStudioProvider,
  OpenAiCompatibleProvider,
  OllamaCloudProvider,
  OllamaLocalProvider,
  OpenAiProvider,
  OpenRouterProvider,
  VeniceProvider,
  createProvider,
  extractChoiceMessageContent,
  extractOpenAiOutputText,
  extractSchemaConstrainedChoiceContent,
  lmStudioSupportedImage,
} from '../../src/enrich/providers.mjs';

function fakeFetch(responseBody, { status = 200, capture = {} } = {}) {
  return async (url, options) => {
    capture.url = url;
    capture.options = options;
    capture.body = JSON.parse(options.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => JSON.stringify(responseBody),
    };
  };
}

const image = { data: Buffer.from('image-bytes'), mimeType: 'image/jpeg', assetId: 'asset-1' };
const prompts = { systemPrompt: 'system', userPrompt: 'user', jsonSchema: { type: 'object' } };
const OPENROUTER_OVERSIZED_TEST_BYTES = 17 * 1024;

test('json parser accepts plain json, fences, and surrounding prose', () => {
  assert.deepEqual(parseJsonContent('{"caption": "Lake"}'), { caption: 'Lake' });
  assert.deepEqual(parseJsonContent('```json\n{"caption": "Lake"}\n```'), { caption: 'Lake' });
  assert.deepEqual(parseJsonContent('Here is the result:\n{"caption": "Lake"}\nDone.'), { caption: 'Lake' });
});

test('choice message extraction reads openai-compatible responses', () => {
  assert.equal(
    extractChoiceMessageContent({ choices: [{ message: { content: '{"caption": "Lake"}' } }] }),
    '{"caption": "Lake"}',
  );
  assert.equal(extractChoiceMessageContent({ choices: [] }), null);
});

test('schema-constrained choice extraction uses reasoning_content only when content is empty', () => {
  assert.equal(
    extractSchemaConstrainedChoiceContent({
      choices: [{ message: { content: '{"caption":"Content"}', reasoning_content: '{"caption":"Reasoning"}' } }],
    }),
    '{"caption":"Content"}',
  );
  assert.equal(
    extractSchemaConstrainedChoiceContent({
      choices: [{ message: { content: '  ', reasoning_content: '{"caption":"Reasoning"}' } }],
    }),
    '{"caption":"Reasoning"}',
  );
});

test('openai output text extraction supports output_text and output list fallback', () => {
  assert.equal(extractOpenAiOutputText({ output_text: '{"a":1}' }), '{"a":1}');
  assert.equal(
    extractOpenAiOutputText({
      output: [
        { type: 'reasoning', content: [] },
        { type: 'message', content: [{ type: 'output_text', text: '{"b":2}' }] },
      ],
    }),
    '{"b":2}',
  );
  assert.equal(extractOpenAiOutputText({}), null);
});

test('lm studio posts an openai-compatible vision schema request', async () => {
  const capture = {};
  const provider = new LmStudioProvider({
    modelName: 'local-vision',
    baseUrl: 'http://localhost:1234/v1',
    apiKey: '',
    maxTokens: 1234,
    temperature: 0.2,
    fetchImpl: fakeFetch({
      choices: [{ message: {
        content: '{"caption": "Lake"}',
        reasoning_content: '{"caption": "Wrong channel"}',
      } }],
    }, { capture }),
  });

  const result = await provider.analyzeImage(image, prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.equal(capture.url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(capture.body.model, 'local-vision');
  assert.equal(capture.body.max_tokens, 1234);
  assert.equal(capture.body.temperature, 0.2);
  assert.equal(capture.body.response_format.type, 'json_schema');
  assert.equal(capture.body.messages[1].content[0].text, 'user');
  const imagePart = capture.body.messages[1].content[1];
  assert.equal(imagePart.type, 'image_url');
  assert.ok(imagePart.image_url.url.startsWith('data:image/jpeg;base64,'));
  assert.equal(capture.options.headers.Authorization, undefined);
  assert.equal(capture.options.redirect, 'error');
});

test('lm studio reads strict-schema JSON from reasoning_content when content is empty', async () => {
  const provider = new LmStudioProvider({
    modelName: 'qwen3.5-4b-mlx',
    fetchImpl: fakeFetch({
      choices: [{
        message: { content: '', reasoning_content: '{"caption": "Lake"}' },
        finish_reason: 'stop',
      }],
    }),
  });

  const result = await provider.analyzeImage(image, prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
});

test('OpenAI-compatible provider posts a portable multimodal JSON-object request without auth', async () => {
  const capture = {};
  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['caption'],
    properties: {
      caption: { type: 'string', description: 'A one-sentence description of the photo.' },
    },
  };
  const provider = new OpenAiCompatibleProvider({
    modelName: 'qwen-vision',
    baseUrl: 'http://llama-host:8080/v1/',
    fetchImpl: fakeFetch({
      choices: [{ message: { content: '```json\n{"caption":"Lake"}\n```' } }],
    }, { capture }),
  });

  const result = await provider.analyzeImage(image, { ...prompts, jsonSchema });

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.equal(capture.url, 'http://llama-host:8080/v1/chat/completions');
  assert.equal(capture.body.model, 'qwen-vision');
  assert.equal(capture.body.response_format.type, 'json_object');
  assert.equal(capture.body.max_tokens, 2400);
  assert.equal(capture.body.temperature, 0);
  assert.equal(capture.body.stream, false);
  const promptText = capture.body.messages[1].content[0].text;
  assert.match(promptText, /^user\n\nReturn only one valid JSON object\./);
  assert.ok(promptText.includes('"required":["caption"]'));
  assert.ok(promptText.includes('"description":"A one-sentence description of the photo."'));
  assert.equal(capture.body.messages[1].content[1].type, 'image_url');
  assert.ok(capture.body.messages[1].content[1].image_url.url.startsWith('data:image/jpeg;base64,'));
  assert.equal(capture.options.headers.Authorization, undefined);
});

test('OpenAI-compatible provider sends optional bearer auth and prose without response format', async () => {
  const capture = {};
  const provider = new OpenAiCompatibleProvider({
    modelName: 'local-text',
    baseUrl: 'https://models.example/custom/v1',
    apiKey: 'private-key',
    fetchImpl: fakeFetch({ choices: [{ message: { content: 'A concise answer.' } }] }, { capture }),
  });

  const result = await provider.generateProse({
    systemPrompt: 'system',
    userPrompt: 'question',
    maxOutputTokens: 321,
  });

  assert.equal(result.text, 'A concise answer.');
  assert.equal(capture.url, 'https://models.example/custom/v1/chat/completions');
  assert.equal(capture.options.headers.Authorization, 'Bearer private-key');
  assert.equal(capture.body.max_tokens, 321);
  assert.equal(Object.hasOwn(capture.body, 'response_format'), false);
});

test('lm studio rejects malformed schema output from reasoning_content', async () => {
  const provider = new LmStudioProvider({
    modelName: 'qwen3.5-4b-mlx',
    fetchImpl: fakeFetch({
      choices: [{
        message: { content: '', reasoning_content: 'I think the answer is not JSON' },
        finish_reason: 'stop',
      }],
    }),
  });

  await assert.rejects(
    () => provider.analyzeImage(image, prompts),
    (error) => {
      assert.equal(error.message, 'LM Studio returned schema output that was not valid JSON');
      assert.doesNotMatch(error.message, /I think/i);
      return true;
    },
  );
});

test('lm studio prose never returns reasoning_content', async () => {
  const provider = new LmStudioProvider({
    modelName: 'qwen3.5-4b-mlx',
    fetchImpl: fakeFetch({
      choices: [{ message: { content: '', reasoning_content: 'private model reasoning' } }],
    }),
  });

  const result = await provider.generateProse({
    systemPrompt: 'system',
    userPrompt: 'user',
    maxOutputTokens: 100,
  });

  assert.equal(result.text, '');
});

test('lm studio keeps non-webp image payloads', () => {
  const supported = lmStudioSupportedImage(image);

  assert.equal(supported.data, image.data);
  assert.equal(supported.mimeType, 'image/jpeg');
});

test('openai posts a responses api request with strict schema and token cap', async () => {
  const capture = {};
  const provider = new OpenAiProvider({
    apiKey: 'key',
    modelName: 'gpt-5.5',
    fetchImpl: fakeFetch({ output_text: '{"caption": "Lake"}' }, { capture }),
  });

  const result = await provider.analyzeImage(image, prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.equal(capture.url, 'https://api.openai.com/v1/responses');
  assert.equal(capture.body.text.format.strict, true);
  assert.equal(typeof capture.body.max_output_tokens, 'number');
  assert.equal(capture.body.input[1].content[1].type, 'input_image');
  assert.equal(capture.options.headers.Authorization, 'Bearer key');
});

test('openrouter posts identity headers and parses strict json content', async () => {
  const capture = {};
  const provider = new OpenRouterProvider({
    apiKey: 'key',
    modelName: 'qwen/qwen3-vl-32b-instruct',
    fetchImpl: fakeFetch({ choices: [{ message: { content: '{"caption": "Lake"}' } }] }, { capture }),
  });

  const result = await provider.analyzeImage(image, prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.equal(capture.options.headers['X-Title'], 'Pictaria');
  assert.equal(capture.body.response_format.json_schema.strict, true);
});

test('openrouter projects Gemini schemas to its supported JSON Schema subset', async () => {
  const capture = {};
  const jsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['caption', 'tags'],
    properties: {
      caption: { type: 'string', description: 'What is shown.', maxLength: 4096 },
      tags: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['confidence'],
          properties: {
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
      maxLength: { type: 'string', maxLength: 12 },
    },
  };
  const originalSchema = structuredClone(jsonSchema);
  const provider = new OpenRouterProvider({
    apiKey: 'key',
    modelName: 'google/gemini-2.5-flash',
    fetchImpl: fakeFetch({ choices: [{ message: { content: '{"caption":"Lake","tags":[]}' } }] }, { capture }),
  });

  await provider.analyzeImage(image, { ...prompts, jsonSchema });

  const sent = capture.body.response_format.json_schema.schema;
  assert.equal(capture.body.response_format.json_schema.strict, true);
  assert.equal(sent.properties.caption.maxLength, undefined);
  assert.equal(sent.properties.caption.description, 'What is shown.');
  assert.equal(sent.properties.tags.maxItems, 50);
  assert.equal(sent.properties.tags.items.additionalProperties, false);
  assert.equal(sent.properties.tags.items.properties.confidence.minimum, 0);
  assert.equal(sent.properties.tags.items.properties.confidence.maximum, 1);
  assert.deepEqual(sent.properties.maxLength, { type: 'string' });
  assert.deepEqual(jsonSchema, originalSchema, 'provider projection must not mutate the validation schema');
});

test('openrouter leaves non-Gemini strict schemas unchanged', async () => {
  const capture = {};
  const jsonSchema = {
    type: 'object',
    properties: { caption: { type: 'string', maxLength: 4096 } },
  };
  const provider = new OpenRouterProvider({
    apiKey: 'key',
    modelName: 'qwen/qwen3-vl-32b-instruct',
    fetchImpl: fakeFetch({ choices: [{ message: { content: '{"caption":"Lake"}' } }] }, { capture }),
  });

  await provider.analyzeImage(image, { ...prompts, jsonSchema });

  assert.deepEqual(capture.body.response_format.json_schema.schema, jsonSchema);
});

test('openrouter empty content reports only bounded safe provider metadata', async () => {
  const secret = 'provider:test/+ key';
  const provider = new OpenRouterProvider({
    apiKey: secret,
    modelName: 'google/gemini-2.5-flash',
    fetchImpl: fakeFetch({
      id: 'gen-safe-id',
      provider: 'Google AI Studio',
      choices: [{
        finish_reason: 'error',
        native_finish_reason: 'INVALID_ARGUMENT',
        message: { content: '', reasoning: 'private chain of thought' },
        error: {
          code: 400,
          message: `Unable to process input; Authorization: Bearer ${secret}`,
          debug: 'private provider payload',
        },
      }],
      debug: 'private top-level payload',
    }),
  });

  await assert.rejects(provider.analyzeImage(image, prompts), (error) => {
    assert.match(error.message, /request id: gen-safe-id/);
    assert.match(error.message, /provider: Google AI Studio/);
    assert.match(error.message, /finish reason: error/);
    assert.match(error.message, /native finish reason: INVALID_ARGUMENT/);
    assert.match(error.message, /code: 400; Unable to process input/);
    assert.doesNotMatch(error.message, /provider:test|private chain|private provider|private top-level/i);
    assert.ok(Buffer.byteLength(error.message, 'utf8') <= 600);
    return true;
  });
});

test('ollama embeds the schema in the prompt and tolerates fenced output', async () => {
  const capture = {};
  const provider = new OllamaCloudProvider({
    apiKey: 'key',
    modelName: 'qwen3.5:cloud',
    fetchImpl: fakeFetch({ message: { content: '```json\n{"caption": "Lake"}\n```' } }, { capture }),
  });

  const result = await provider.analyzeImage(image, prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.equal(capture.url, 'https://ollama.com/api/chat');
  assert.ok(capture.body.messages[1].content.includes('"type":"object"'));
  assert.ok(Array.isArray(capture.body.messages[1].images));
  assert.equal(capture.body.stream, false);
});

test('local ollama posts the schema as the native format parameter without auth', async () => {
  const capture = {};
  const provider = new OllamaLocalProvider({
    modelName: 'qwen3-vl',
    fetchImpl: fakeFetch({ message: { content: '```json\n{"caption": "Lake"}\n```' } }, { capture }),
  });

  const second = { data: Buffer.from('more-bytes'), mimeType: 'image/jpeg', assetId: 'asset-2' };
  const result = await provider.analyzeImages([image, second], prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.equal(capture.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(capture.options.headers.Authorization, undefined);
  assert.deepEqual(capture.body.format, prompts.jsonSchema);
  assert.equal(capture.body.messages[1].images.length, 2);
  assert.equal(capture.body.stream, false);
  assert.equal(capture.body.options.temperature, 0);
});

test('local ollama sends a bearer header only when a key is configured, and requires a model', async () => {
  const capture = {};
  const provider = new OllamaLocalProvider({
    apiKey: 'proxy-key',
    modelName: 'qwen3-vl',
    baseUrl: 'http://ollama.lan:11434/',
    fetchImpl: fakeFetch({ message: { content: '{"caption": "Lake"}' } }, { capture }),
  });

  await provider.analyzeImage(image, prompts);

  assert.equal(capture.url, 'http://ollama.lan:11434/api/chat');
  assert.equal(capture.options.headers.Authorization, 'Bearer proxy-key');
  assert.throws(() => new OllamaLocalProvider({}), /Ollama model is required/);
});

test('local provider constructors reject query and fragment delimiters before any request', () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
  };
  for (const baseUrl of [
    'http://internal.invalid/chosen?',
    'http://internal.invalid/chosen?target=metadata',
    'http://internal.invalid/chosen#',
    'http://internal.invalid/chosen#fragment',
  ]) {
    assert.throws(
      () => new LmStudioProvider({ modelName: 'm', baseUrl, fetchImpl }),
      /without credentials, a query, or a fragment/,
    );
    assert.throws(
      () => new OllamaLocalProvider({ modelName: 'm', baseUrl, fetchImpl }),
      /without credentials, a query, or a fragment/,
    );
    assert.throws(
      () => new OpenAiCompatibleProvider({ modelName: 'm', baseUrl, fetchImpl }),
      /without credentials, a query, or a fragment/,
    );
  }
  assert.equal(called, false);
});

test('OpenAI-compatible provider requires both a destination and model', () => {
  assert.throws(
    () => new OpenAiCompatibleProvider({ modelName: 'm' }),
    /OPENAI_COMPATIBLE_BASE_URL is required/,
  );
  assert.throws(
    () => new OpenAiCompatibleProvider({ baseUrl: 'http://llama:8080/v1' }),
    /OPENAI_COMPATIBLE_MODEL is required/,
  );
});

test('local ollama omits think and reads schema JSON from the thinking channel', async () => {
  const capture = {};
  const provider = new OllamaLocalProvider({
    modelName: 'qwen3-vl:8b',
    // Thinking-native models on Ollama 0.32 can return the grammar-constrained
    // JSON in message.thinking with an empty content.
    fetchImpl: fakeFetch({ message: { content: '', thinking: '{"caption": "Lake"}' } }, { capture }),
  });

  const result = await provider.analyzeImage(image, prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.ok(!('think' in capture.body), 'think:false + format misroutes thinking-native models — the field must be absent');
});

test('venice posts openai-format strict schema with its system prompt disabled', async () => {
  const capture = {};
  const provider = new VeniceProvider({
    apiKey: 'key',
    modelName: 'qwen3-vl-235b-a22b',
    fetchImpl: fakeFetch({ choices: [{ message: { content: '```json\n{"caption": "Lake"}\n```' } }] }, { capture }),
  });

  const second = { data: Buffer.from('more-bytes'), mimeType: 'image/jpeg', assetId: 'asset-2' };
  const result = await provider.analyzeImages([image, second], prompts);

  assert.deepEqual(result.normalizedOutput, { caption: 'Lake' });
  assert.equal(capture.url, 'https://api.venice.ai/api/v1/chat/completions');
  assert.equal(capture.options.headers.Authorization, 'Bearer key');
  assert.equal(capture.body.response_format.type, 'json_schema');
  assert.equal(capture.body.response_format.json_schema.strict, true);
  assert.equal(capture.body.venice_parameters.include_venice_system_prompt, false);
  assert.equal(capture.body.venice_parameters.disable_thinking, true);
  assert.equal(capture.body.venice_parameters.strip_thinking_response, true);
  assert.equal(capture.body.temperature, 0);
  assert.equal(capture.body.stream, false);
  // Venice's grammar constraint does not show the model the schema, so the
  // user prompt must carry it (empty-caption regression).
  const textPart = capture.body.messages[1].content.find((part) => part.type === 'text');
  assert.ok(textPart.text.startsWith('user'));
  assert.ok(textPart.text.includes('"type":"object"'));
  const imageParts = capture.body.messages[1].content.filter((part) => part.type === 'image_url');
  assert.equal(imageParts.length, 2);
  assert.ok(imageParts[0].image_url.url.startsWith('data:image/jpeg;base64,'));
});

test('venice requires both an api key and an explicit model', () => {
  assert.throws(() => new VeniceProvider({ modelName: 'm' }), /VENICE_API_KEY is required/);
  assert.throws(() => new VeniceProvider({ apiKey: 'k' }), /Venice model is required/);
});

test('http errors surface provider name, status, and response detail', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'key',
    modelName: 'm',
    fetchImpl: fakeFetch({ error: 'rate limited' }, { status: 429 }),
  });

  await assert.rejects(
    () => provider.analyzeImage(image, prompts),
    /openrouter request failed with status 429.*rate limited/,
  );
});

test('openrouter HTTP errors safely expose structured native-provider metadata', async () => {
  const secret = 'provider:test/+ key';
  const provider = new OpenRouterProvider({
    apiKey: secret,
    modelName: 'google/gemini-2.5-flash',
    fetchImpl: fakeFetch({
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: {
          provider_name: 'Google AI Studio',
          raw: JSON.stringify({
            error: {
              code: 400,
              status: 'INVALID_ARGUMENT',
              message: `Unable to process input image; Authorization: Bearer ${secret}`,
              debug: 'private native debug data',
            },
            request: { prompt: 'private prompt', image: 'private image bytes' },
          }),
          debug: 'private router metadata',
        },
      },
      debug: 'private router response',
    }, { status: 400 }),
  });

  await assert.rejects(provider.analyzeImage(image, prompts), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /code: 400; Provider returned error/);
    assert.match(error.message, /provider: Google AI Studio/);
    assert.match(error.message, /upstream status: INVALID_ARGUMENT/);
    assert.match(error.message, /upstream: code: 400; Unable to process input image/);
    assert.doesNotMatch(error.message, /provider:test|private/i);
    assert.match(error.message, /Authorization: \[redacted\]/);
    assert.ok(Buffer.byteLength(error.message, 'utf8') <= 600);
    return true;
  });
});

test('openrouter HTTP errors ignore unstructured or oversized raw metadata', async () => {
  for (const raw of [
    'private prompt and image bytes',
    JSON.stringify({ error: { message: 'private ' + 'x'.repeat(OPENROUTER_OVERSIZED_TEST_BYTES) } }),
  ]) {
    const provider = new OpenRouterProvider({
      apiKey: 'key',
      modelName: 'google/gemini-2.5-flash',
      fetchImpl: fakeFetch({
        error: {
          code: 400,
          message: 'Provider returned error',
          metadata: { provider_name: 'Google AI Studio', raw },
        },
      }, { status: 400 }),
    });

    await assert.rejects(provider.analyzeImage(image, prompts), (error) => {
      assert.match(error.message, /provider: Google AI Studio/);
      assert.doesNotMatch(error.message, /private prompt|private x/i);
      return true;
    });
  }
});

test('non-OpenRouter providers do not expose OpenRouter metadata envelopes', async () => {
  const provider = new VeniceProvider({
    apiKey: 'key',
    modelName: 'qwen3-vl-235b-a22b',
    fetchImpl: fakeFetch({
      error: {
        code: 400,
        message: 'Provider returned error',
        metadata: {
          provider_name: 'must-not-survive',
          raw: JSON.stringify({ error: { message: 'must-not-survive' } }),
        },
      },
    }, { status: 400 }),
  });

  await assert.rejects(provider.analyzeImage(image, prompts), (error) => {
    assert.match(error.message, /code: 400; Provider returned error/);
    assert.doesNotMatch(error.message, /must-not-survive/);
    return true;
  });
});

test('provider errors redact exact, encoded, and echoed-header API credentials', async () => {
  const secret = 'provider:test/+ key';
  const provider = new OpenRouterProvider({
    apiKey: secret,
    modelName: 'm',
    fetchImpl: fakeFetch({
      error: {
        code: 'bad_key',
        message: `exact ${secret}; encoded ${encodeURIComponent(secret)}; x-api-key: reflected-value`,
      },
      debug: { authorization: `Bearer ${secret}` },
    }, { status: 401 }),
  });

  await assert.rejects(provider.analyzeImage(image, prompts), (error) => {
    assert.match(error.message, /code: bad_key/);
    assert.doesNotMatch(error.message, /provider:test|provider%3Atest|reflected-value/i);
    assert.doesNotMatch(error.message, /debug|authorization/i);
    assert.ok(Buffer.byteLength(error.message, 'utf8') <= 512);
    return true;
  });
});

test('an injected transport reads huge error bodies bounded and keeps the status', async () => {
  // 96KB streamed error page, past the 64KB error-detail cap: the read must
  // abort instead of buffering, and the status-coded error still surfaces
  // (with the detail dropped, not a masking ResponseTooLargeError).
  const provider = new OpenRouterProvider({
    apiKey: 'key',
    modelName: 'm',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(48 * 1024).fill(120));
            controller.enqueue(new Uint8Array(48 * 1024).fill(120));
            controller.close();
          },
        }),
        { status: 500 },
      ),
  });

  await assert.rejects(
    () => provider.analyzeImage(image, prompts),
    (error) => {
      assert.equal(error.name, 'ProviderRequestError');
      assert.equal(error.status, 500);
      assert.match(error.message, /openrouter request failed with status 500/);
      assert.ok(error.message.length < 200, 'the flood must not land in the error message');
      return true;
    },
  );
});

test('missing message content raises a clear error', async () => {
  const provider = new LmStudioProvider({
    modelName: 'm',
    fetchImpl: fakeFetch({ choices: [{ message: {} }] }),
  });

  await assert.rejects(() => provider.analyzeImage(image, prompts), /did not include message content/);
});

test('lm studio node transport isolates consecutive requests from stale keep-alive sockets', async () => {
  let connectionCount = 0;
  const connectionHeaders = [];
  const server = createServer((request, response) => {
    request.resume();
    connectionHeaders.push(request.headers.connection);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"caption":"Lake"}' } }] }));
  });
  server.on('connection', () => {
    connectionCount += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const provider = new LmStudioProvider({
    modelName: 'm',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  });

  try {
    await provider.analyzeImage(image, prompts);
    await provider.analyzeImage(image, prompts);

    assert.equal(connectionCount, 2);
    assert.deepEqual(connectionHeaders, ['close', 'close']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OpenAI-compatible node transport also isolates consecutive requests', async () => {
  let connectionCount = 0;
  const connectionHeaders = [];
  const server = createServer((request, response) => {
    request.resume();
    connectionHeaders.push(request.headers.connection);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"caption":"Lake"}' } }] }));
  });
  server.on('connection', () => {
    connectionCount += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const provider = new OpenAiCompatibleProvider({
    modelName: 'm',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  });

  try {
    await provider.analyzeImage(image, prompts);
    await provider.analyzeImage(image, prompts);

    assert.equal(connectionCount, 2);
    assert.deepEqual(connectionHeaders, ['close', 'close']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('node transport caps a runaway provider response body', async () => {
  // Streams far past the 2MB cap; the client must abort mid-body instead of
  // accumulating chunks without bound.
  const chunk = Buffer.alloc(1024 * 1024, 'a');
  const server = createServer((request, response) => {
    request.resume();
    response.on('error', () => {});
    response.writeHead(200, { 'content-type': 'application/json' });
    let sentMb = 0;
    const write = () => {
      while (sentMb < 64) {
        sentMb += 1;
        if (!response.write(chunk)) {
          response.once('drain', write);
          return;
        }
      }
      response.end();
    };
    write();
  });
  server.on('clientError', (error, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // No fetchImpl injected, so postJson takes the node:http transport path.
  const provider = new LmStudioProvider({
    modelName: 'm',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  });

  try {
    await assert.rejects(() => provider.analyzeImage(image, prompts), /byte limit/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an injected transport also caps a successful provider response', async () => {
  const provider = new OpenRouterProvider({
    apiKey: 'key',
    modelName: 'm',
    fetchImpl: async () => new Response(JSON.stringify({ padding: 'x'.repeat(3 * 1024 * 1024) })),
  });

  await assert.rejects(
    () => provider.analyzeImage(image, prompts),
    (error) => {
      assert.equal(error.name, 'ProviderRequestError');
      assert.match(error.message, /byte limit/);
      assert.ok(Buffer.byteLength(error.message, 'utf8') <= 512);
      return true;
    },
  );
});

test('createProvider maps names to implementations and rejects unknowns', () => {
  assert.equal(createProvider('cloud_openai', { apiKey: 'k', modelName: 'm' }).providerName, 'cloud_openai');
  assert.equal(createProvider('local_lmstudio', { modelName: 'm' }).providerName, 'local_lmstudio');
  assert.equal(
    createProvider('openai_compatible', { baseUrl: 'http://llama:8080/v1', modelName: 'm' }).providerName,
    'openai_compatible',
  );
  assert.equal(createProvider('openrouter', { apiKey: 'k', modelName: 'm' }).providerName, 'openrouter');
  assert.equal(createProvider('cloud_ollama', { apiKey: 'k', modelName: 'm' }).providerName, 'cloud_ollama');
  assert.equal(createProvider('local_ollama', { modelName: 'm' }).providerName, 'local_ollama');
  assert.equal(createProvider('venice', { apiKey: 'k', modelName: 'm' }).providerName, 'venice');
  assert.throws(() => createProvider('nope', {}), /Unsupported provider/);
});

test('WebP for LM Studio off macOS fails fast with the Image source guidance', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    assert.throws(
      () => lmStudioSupportedImage({ data: Buffer.from('not-a-real-webp'), mimeType: 'image/webp' }),
      /Image source.*original/s,
    );
    // Non-WebP images pass through untouched on any platform.
    const jpeg = { data: Buffer.from('x'), mimeType: 'image/jpeg' };
    assert.equal(lmStudioSupportedImage(jpeg), jpeg);
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
