import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { parseJsonContent } from '../../src/enrich/jsonUtils.mjs';
import {
  LmStudioProvider,
  OllamaCloudProvider,
  OllamaLocalProvider,
  OpenAiProvider,
  OpenRouterProvider,
  VeniceProvider,
  createProvider,
  extractChoiceMessageContent,
  extractOpenAiOutputText,
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
    fetchImpl: fakeFetch({ choices: [{ message: { content: '{"caption": "Lake"}' } }] }, { capture }),
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
  }
  assert.equal(called, false);
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
