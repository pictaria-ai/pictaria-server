import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseJsonContent } from './jsonUtils.mjs';
import { readBodyBounded } from '../fetchWithTimeout.mjs';
import { appendHttpUrlPath, normalizeHttpUrl } from '../config.mjs';
import { sanitizeDiagnostic, structuredUpstreamDiagnostic } from '../diagnostics.mjs';

// Vision providers. Each analyzeImage(image, { systemPrompt, userPrompt,
// jsonSchema }) returns { rawOutput, normalizedOutput }. An image is
// { data: Buffer|Uint8Array, mimeType, assetId? }.
// analyzeImages(images, options) sends several images in ONE request (the
// group referee: "here are 5 frames of the same moment, rank them");
// analyzeImage delegates to it. options.schemaName labels the response
// schema (defaults to the enrichment schema name).
//
// generateProse({ systemPrompt, userPrompt, images, maxOutputTokens }) returns
// { rawOutput, text } through the same transports, with the response schema
// turned off for spoken answers. Images are optional: "what's interesting
// about this photo" sends one, while "tell me …" sends none. Temperature uses
// each provider's default rather than 0 because these answers are read aloud,
// not parsed. Thinking remains suppressed where the provider exposes a switch,
// since a spoken answer must not include reasoning.

// Generous cap: reasoning models spend hidden reasoning tokens from this
// budget before emitting the JSON, so keep plenty of headroom.
const OPENAI_MAX_OUTPUT_TOKENS = 8192;

// Real schema/prose responses are far smaller. Keep enough room for provider
// envelope metadata while refusing a runaway or misrouted endpoint before it
// can become a large transient allocation.
const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

// Gemini accepts JSON Schema through OpenRouter, but its native structured-
// output API supports only a documented subset of JSON Schema. Keep strict
// generation while projecting out unsupported generation hints; the complete
// Pictaria schema is still enforced by validateAiOutput after the response.
const GEMINI_JSON_SCHEMA_KEYWORDS = new Set([
  '$id',
  '$defs',
  '$ref',
  '$anchor',
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  'propertyOrdering',
]);

// Transport-level provider failure. `infrastructure` separates "the provider
// or network is unhealthy" (timeouts, refused connections, auth, rate limits,
// 5xx) from "the provider judged this request's content" — the runner only
// charges an asset's permanent failure allowance for the latter.
export class ProviderRequestError extends Error {
  constructor(message, { status = null, timeout = false } = {}) {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
    // Callers that answer a person in real time (the voice commands) need
    // to tell a genuine deadline apart from a refused connection, a DNS
    // failure, or an unparseable body — all of which also arrive without
    // an HTTP status. Carried explicitly rather than sniffed from the
    // message text.
    this.timeout = timeout;
    this.infrastructure =
      status === null || status === 401 || status === 403 || status === 429 || status >= 500;
  }
}

export function createProvider(name, options) {
  if (name === 'cloud_openai') {
    return new OpenAiProvider(options);
  }
  if (name === 'local_lmstudio') {
    return new LmStudioProvider(options);
  }
  if (name === 'openrouter') {
    return new OpenRouterProvider(options);
  }
  if (name === 'cloud_ollama') {
    return new OllamaCloudProvider(options);
  }
  if (name === 'local_ollama') {
    return new OllamaLocalProvider(options);
  }
  if (name === 'venice') {
    return new VeniceProvider(options);
  }
  throw new Error(`Unsupported provider: ${name}`);
}

export class OpenAiProvider {
  providerName = 'cloud_openai';

  constructor({ apiKey, modelName, timeoutMs = 120000, fetchImpl = fetch } = {}) {
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for cloud_openai');
    }
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async analyzeImage(image, options) {
    return this.analyzeImages([image], options);
  }

  async analyzeImages(images, { systemPrompt, userPrompt, jsonSchema, schemaName = 'pictaria_photo_enrichment' }) {
    const body = {
      model: this.modelName,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userPrompt },
            ...images.map((image) => ({ type: 'input_image', image_url: toDataUrl(image) })),
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      },
      max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    };
    const rawOutput = await postJson(this, 'https://api.openai.com/v1/responses', body, {
      Authorization: `Bearer ${this.apiKey}`,
    });
    const outputText = extractOpenAiOutputText(rawOutput);
    if (!outputText) {
      throw new Error('OpenAI response did not include output_text');
    }
    return { rawOutput, normalizedOutput: JSON.parse(outputText) };
  }

  async generateProse({ systemPrompt, userPrompt, images = [], maxOutputTokens, imageDetail }) {
    const body = {
      model: this.modelName,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: userPrompt },
            ...images.map((image) => ({
              type: 'input_image',
              image_url: toDataUrl(image),
              ...(imageDetail ? { detail: imageDetail } : {}),
            })),
          ],
        },
      ],
      max_output_tokens: maxOutputTokens,
    };
    const rawOutput = await postJson(this, 'https://api.openai.com/v1/responses', body, {
      Authorization: `Bearer ${this.apiKey}`,
    });
    // A refusal is a real answer here ("I can't help with that"), and the
    // frame should speak it rather than retry into a misleading "empty
    // answer" error. Deliberately not folded into
    // extractOpenAiOutputText: enrichment JSON.parses that return value.
    return { rawOutput, text: extractOpenAiProseText(rawOutput) };
  }
}

export class LmStudioProvider {
  providerName = 'local_lmstudio';

  constructor({
    modelName,
    baseUrl = 'http://127.0.0.1:1234/v1',
    apiKey = 'lm-studio',
    timeoutMs = 300000,
    maxTokens = 1600,
    temperature = 0,
    fetchImpl = fetch,
  } = {}) {
    if (!modelName) {
      throw new Error('LMSTUDIO_MODEL is required for local_lmstudio');
    }
    this.modelName = modelName;
    this.baseUrl = normalizeHttpUrl(baseUrl);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.fetchImpl = fetchImpl;
  }

  async analyzeImage(image, options) {
    return this.analyzeImages([image], options);
  }

  async analyzeImages(images, { systemPrompt, userPrompt, jsonSchema, schemaName = 'pictaria_photo_enrichment' }) {
    const body = {
      model: this.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            ...images.map((image) => ({
              type: 'image_url',
              image_url: { url: toDataUrl(lmStudioSupportedImage(image)) },
            })),
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      },
      temperature: this.temperature,
      stream: false,
    };
    if (this.maxTokens !== null && this.maxTokens !== undefined) {
      body.max_tokens = this.maxTokens;
    }
    const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/chat/completions'), body, headers);
    const outputText = extractSchemaConstrainedChoiceContent(rawOutput);
    if (!outputText) {
      throw new Error('LM Studio response did not include message content');
    }
    try {
      return { rawOutput, normalizedOutput: parseJsonContent(outputText) };
    } catch (error) {
      // The fallback channel can contain private chain-of-thought rather than
      // the requested schema JSON. JSON.parse errors quote the rejected input,
      // so replace them with a fixed diagnostic when that channel was used.
      const ordinaryContent = extractChoiceMessageContent(rawOutput);
      if (!(typeof ordinaryContent === 'string' && ordinaryContent.trim())) {
        throw new Error('LM Studio returned schema output that was not valid JSON');
      }
      throw error;
    }
  }

  async generateProse({ systemPrompt, userPrompt, images = [], maxOutputTokens }) {
    const body = chatCompletionsProseBody({
      model: this.modelName,
      systemPrompt,
      userPrompt,
      images: images.map((image) => lmStudioSupportedImage(image, LM_WEBP_VOICE_GUIDANCE)),
      maxOutputTokens,
    });
    const headers = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/chat/completions'), body, headers);
    return { rawOutput, text: extractChoiceMessageContent(rawOutput) };
  }
}

// The OpenAI-compatible /chat/completions request shared by LM Studio,
// OpenRouter, and Venice for prose: no response_format, a caller-supplied
// token budget, and the provider's default temperature.
function chatCompletionsProseBody({ model, systemPrompt, userPrompt, images, maxOutputTokens }) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          ...images.map((image) => ({ type: 'image_url', image_url: { url: toDataUrl(image) } })),
        ],
      },
    ],
    max_tokens: maxOutputTokens,
    stream: false,
  };
}

export class OpenRouterProvider {
  providerName = 'openrouter';

  constructor({ apiKey, modelName, baseUrl = 'https://openrouter.ai/api/v1', timeoutMs = 180000, fetchImpl = fetch } = {}) {
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required for openrouter');
    }
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.baseUrl = normalizeHttpUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async analyzeImage(image, options) {
    return this.analyzeImages([image], options);
  }

  async analyzeImages(images, { systemPrompt, userPrompt, jsonSchema, schemaName = 'pictaria_photo_enrichment' }) {
    const providerJsonSchema = openRouterJsonSchema(this.modelName, jsonSchema);
    const body = {
      model: this.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            ...images.map((image) => ({ type: 'image_url', image_url: { url: toDataUrl(image) } })),
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: providerJsonSchema,
        },
      },
      temperature: 0,
      stream: false,
    };
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/chat/completions'), body, {
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/pictaria-ai/pictaria-server',
      'X-Title': 'Pictaria',
    });
    const outputText = extractChoiceMessageContent(rawOutput);
    if (!outputText) {
      const detail = openRouterEmptyContentDiagnostic(rawOutput, this.apiKey);
      throw new Error(`OpenRouter response did not include message content${detail ? `: ${detail}` : ''}`);
    }
    return { rawOutput, normalizedOutput: JSON.parse(outputText) };
  }

  async generateProse({ systemPrompt, userPrompt, images = [], maxOutputTokens }) {
    const body = chatCompletionsProseBody({
      model: this.modelName,
      systemPrompt,
      userPrompt,
      images,
      maxOutputTokens,
    });
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/chat/completions'), body, {
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/pictaria-ai/pictaria-server',
      'X-Title': 'Pictaria',
    });
    return { rawOutput, text: extractChoiceMessageContent(rawOutput) };
  }
}

function openRouterJsonSchema(modelName, jsonSchema) {
  if (!String(modelName ?? '').toLowerCase().startsWith('google/gemini-')) {
    return jsonSchema;
  }
  return projectGeminiJsonSchema(jsonSchema);
}

function projectGeminiJsonSchema(value, context = 'schema') {
  if (Array.isArray(value)) {
    return value.map((item) => projectGeminiJsonSchema(item, context));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (context === 'properties' || context === '$defs') {
    return Object.fromEntries(
      Object.entries(value).map(([key, schema]) => [key, projectGeminiJsonSchema(schema)]),
    );
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => GEMINI_JSON_SCHEMA_KEYWORDS.has(key))
      .map(([key, child]) => [key, projectGeminiJsonSchema(child, key)]),
  );
}

function openRouterEmptyContentDiagnostic(response, apiKey) {
  const choice = response?.choices?.[0];
  const fields = [];
  for (const [label, value] of [
    ['request id', response?.id],
    ['provider', response?.provider],
    ['finish reason', choice?.finish_reason],
    ['native finish reason', choice?.native_finish_reason],
  ]) {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) fields.push(`${label}: ${text}`);
    }
  }
  for (const error of [response?.error, choice?.error]) {
    const detail = structuredUpstreamDiagnostic(error, { secrets: [apiKey], maxBytes: 256 });
    if (detail) fields.push(`error: ${detail}`);
  }
  return sanitizeDiagnostic(fields.join('; '), { secrets: [apiKey], maxBytes: 512 });
}

export class VeniceProvider {
  providerName = 'venice';

  constructor({ apiKey, modelName, baseUrl = 'https://api.venice.ai/api/v1', timeoutMs = 180000, fetchImpl = fetch } = {}) {
    if (!apiKey) {
      throw new Error('VENICE_API_KEY is required for venice');
    }
    // No built-in default: Venice's catalog moves fast and only some models
    // accept images, so the user must pick a vision-capable model.
    if (!modelName) {
      throw new Error('A Venice model is required for venice (pick a vision-capable model in Settings)');
    }
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.baseUrl = normalizeHttpUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async analyzeImage(image, options) {
    return this.analyzeImages([image], options);
  }

  async analyzeImages(images, { systemPrompt, userPrompt, jsonSchema, schemaName = 'pictaria_photo_enrichment' }) {
    // Venice's response_format constrains the output grammar but — unlike
    // OpenAI's structured outputs — does not show the model the schema, so
    // free-text fields came back as type-satisfying empty strings (caption:
    // ""). Embed the schema in the prompt (the cloud_ollama pattern) so the
    // model sees each field's meaning; response_format still guarantees
    // shape.
    const schemaText = JSON.stringify(sortKeysDeep(jsonSchema));
    const schemaAwareUserPrompt =
      `${userPrompt}\n\n` +
      'Your response must be one JSON object conforming to this schema. ' +
      'Use each field\'s description to decide its content; free-text fields ' +
      'like captions must be genuinely filled in, not left empty:\n' +
      schemaText;
    const body = {
      model: this.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: schemaAwareUserPrompt },
            ...images.map((image) => ({ type: 'image_url', image_url: { url: toDataUrl(image) } })),
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      },
      temperature: 0,
      stream: false,
      venice_parameters: {
        // Venice prepends its own default system prompt unless told not to;
        // it would contaminate the strict enrichment/referee prompts.
        include_venice_system_prompt: false,
        // Reasoning models (observed live with two Qwen families) spend
        // unbounded thinking time before the constrained answer and blow the
        // request timeout; this is temperature-0 schema-constrained
        // extraction, so turn thinking off entirely.
        disable_thinking: true,
        // Belt to the above's suspenders: if a model thinks anyway, strip
        // the <think> block so message content is only the JSON answer.
        strip_thinking_response: true,
      },
    };
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/chat/completions'), body, {
      Authorization: `Bearer ${this.apiKey}`,
    });
    const outputText = extractChoiceMessageContent(rawOutput);
    if (!outputText) {
      throw new Error('Venice response did not include message content');
    }
    // Tolerant parse: Venice models without response-schema support may still
    // fence or pad the JSON.
    return { rawOutput, normalizedOutput: parseJsonContent(outputText) };
  }

  async generateProse({ systemPrompt, userPrompt, images = [], maxOutputTokens }) {
    const body = {
      ...chatCompletionsProseBody({
        model: this.modelName,
        systemPrompt,
        userPrompt,
        images,
        maxOutputTokens,
      }),
      venice_parameters: {
        // Same reasons as the enrichment path: Venice's own system prompt
        // would contaminate ours, and a reasoning model must neither burn
        // the voice budget thinking nor leak a <think> block into an
        // answer that is about to be read out loud.
        include_venice_system_prompt: false,
        disable_thinking: true,
        strip_thinking_response: true,
      },
    };
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/chat/completions'), body, {
      Authorization: `Bearer ${this.apiKey}`,
    });
    return { rawOutput, text: extractChoiceMessageContent(rawOutput) };
  }
}

export class OllamaCloudProvider {
  providerName = 'cloud_ollama';

  constructor({ apiKey, modelName, baseUrl = 'https://ollama.com', timeoutMs = 180000, fetchImpl = fetch } = {}) {
    if (!apiKey) {
      throw new Error('OLLAMA_API_KEY is required for cloud_ollama');
    }
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.baseUrl = normalizeHttpUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async analyzeImage(image, options) {
    return this.analyzeImages([image], options);
  }

  async analyzeImages(images, { systemPrompt, userPrompt, jsonSchema }) {
    const schemaText = JSON.stringify(sortKeysDeep(jsonSchema));
    const strictUserPrompt =
      `${userPrompt}\n\n` +
      'Return only one valid JSON object. Do not include markdown fences, commentary, or extra text.\n' +
      'The JSON object must conform to this schema:\n' +
      schemaText;
    const body = {
      model: this.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: strictUserPrompt,
          images: images.map((image) => Buffer.from(image.data).toString('base64')),
        },
      ],
      stream: false,
      think: false,
      options: { temperature: 0 },
    };
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/api/chat'), body, {
      Authorization: `Bearer ${this.apiKey}`,
    });
    const content = extractOllamaMessageContent(rawOutput);
    if (!content) {
      throw new Error('Ollama response did not include message content');
    }
    return { rawOutput, normalizedOutput: parseJsonContent(content) };
  }

  async generateProse({ systemPrompt, userPrompt, images = [], maxOutputTokens }) {
    const body = ollamaProseBody({ model: this.modelName, systemPrompt, userPrompt, images, maxOutputTokens });
    const rawOutput = await postJson(this, appendHttpUrlPath(this.baseUrl, '/api/chat'), body, {
      Authorization: `Bearer ${this.apiKey}`,
    });
    return { rawOutput, text: extractOllamaProseContent(rawOutput) };
  }
}

// Ollama's /api/chat request for prose (cloud and local alike): no `format`,
// so nothing constrains the grammar, and `think: false` because a spoken
// answer must not carry reasoning. Suppressing thinking is safe here in a
// way it is not for enrichment — constrained output is misrouted only when
// `think: false` is combined with `format`, and prose sends no schema.
function ollamaProseBody({ model, systemPrompt, userPrompt, images, maxOutputTokens }) {
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: userPrompt,
        ...(images.length > 0
          ? { images: images.map((image) => Buffer.from(image.data).toString('base64')) }
          : {}),
      },
    ],
    stream: false,
    think: false,
    options: { num_predict: maxOutputTokens },
  };
}

// Prose must never fall back to the thinking channel the way schema-
// constrained output legitimately does (see extractOllamaMessageContent):
// with no `format` in play, `thinking` really is chain-of-thought, and
// speaking it aloud would be worse than saying nothing.
function extractOllamaProseContent(response) {
  const content = response?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  return typeof response?.response === 'string' ? response.response : null;
}

export class OllamaLocalProvider {
  providerName = 'local_ollama';

  // Local Ollama is unauthenticated by default; apiKey is optional and only
  // adds a Bearer header for setups behind an authenticating proxy.
  constructor({ apiKey = '', modelName, baseUrl = 'http://127.0.0.1:11434', timeoutMs = 180000, fetchImpl = fetch } = {}) {
    if (!modelName) {
      throw new Error('An Ollama model is required for local_ollama (the name `ollama list` shows)');
    }
    this.apiKey = apiKey;
    this.modelName = modelName;
    this.baseUrl = normalizeHttpUrl(baseUrl);
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async analyzeImage(image, options) {
    return this.analyzeImages([image], options);
  }

  async analyzeImages(images, { systemPrompt, userPrompt, jsonSchema }) {
    const body = {
      model: this.modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: userPrompt,
          images: images.map((image) => Buffer.from(image.data).toString('base64')),
        },
      ],
      // Unlike cloud_ollama's schema-embedded-in-prompt approach, local
      // Ollama gets the schema as the native `format` parameter, which
      // constrains decoding to schema-valid JSON. No `think` field: sending
      // `think: false` together with `format` makes thinking-native models
      // (qwen3-vl on Ollama 0.32) emit constrained JSON into the thinking
      // channel with empty content. Omitting the field works for thinking and
      // non-thinking models alike.
      format: jsonSchema,
      stream: false,
      options: { temperature: 0 },
    };
    const rawOutput = await postJson(
      this,
      appendHttpUrlPath(this.baseUrl, '/api/chat'),
      body,
      this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    );
    const content = extractOllamaMessageContent(rawOutput);
    if (!content) {
      throw new Error('Ollama response did not include message content');
    }
    return { rawOutput, normalizedOutput: parseJsonContent(content) };
  }

  async generateProse({ systemPrompt, userPrompt, images = [], maxOutputTokens }) {
    const body = ollamaProseBody({ model: this.modelName, systemPrompt, userPrompt, images, maxOutputTokens });
    const rawOutput = await postJson(
      this,
      appendHttpUrlPath(this.baseUrl, '/api/chat'),
      body,
      this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    );
    return { rawOutput, text: extractOllamaProseContent(rawOutput) };
  }
}

async function postJson(provider, url, body, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extraHeaders,
  };
  // The built-in fetch enforces its own ~300s header timeout underneath any
  // AbortController, which kills long local-model generations (a referee
  // group can run 10+ minutes). Default transport is node:http(s) with a
  // single wall-clock deadline; injected fetchImpl (tests, custom) is kept.
  if (provider.fetchImpl === fetch) {
    return nodePostJson(provider, url, headers, JSON.stringify(body));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs);
  let response;
  try {
    response = await provider.fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    const reason = timedOut ? `timed out after ${provider.timeoutMs}ms` : error?.message ?? error;
    throw new ProviderRequestError(
      `${provider.providerName} request failed: ${sanitizeDiagnostic(reason, { secrets: [provider.apiKey] })}`,
      { timeout: timedOut },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response, provider);
    throw new ProviderRequestError(providerStatusMessage(provider.providerName, response.status, detail), {
      status: response.status,
    });
  }
  try {
    if (typeof response.body?.getReader !== 'function' && typeof response.text !== 'function') {
      // Minimal injected test doubles may expose only json(). Production
      // Response objects always take one of the byte-bounded text paths.
      const parsed = await response.json();
      if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new Error(`response exceeded the ${MAX_PROVIDER_RESPONSE_BYTES}-byte limit`);
      }
      return parsed;
    }
    const text = typeof response.body?.getReader === 'function'
      ? (await readBodyBounded(response, MAX_PROVIDER_RESPONSE_BYTES, 'Provider')).toString('utf8')
      : await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error(`response exceeded the ${MAX_PROVIDER_RESPONSE_BYTES}-byte limit`);
    }
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderRequestError(
      `${provider.providerName} request failed: ${sanitizeDiagnostic(error?.message ?? error, { secrets: [provider.apiKey] })}`,
    );
  }
}

// A real provider error payload is short; this path only runs with an
// injected fetchImpl (the default transport is nodePostJson, bounded at
// MAX_PROVIDER_RESPONSE_BYTES), but defense in depth: read the detail
// bounded, and degrade to no detail rather than throw — the status-coded
// error we are building is the failure that matters.
const ERROR_DETAIL_MAX_BYTES = 64 * 1024;
async function readErrorDetail(response, provider) {
  try {
    // Injected doubles without a body stream (tests) read whole.
    if (typeof response.body?.getReader === 'function') {
      return providerErrorDetail(
        (await readBodyBounded(response, ERROR_DETAIL_MAX_BYTES, 'Provider')).toString('utf8'),
        provider.providerName,
        provider.apiKey,
      );
    }
    return providerErrorDetail(await response.text(), provider.providerName, provider.apiKey);
  } catch {
    return '';
  }
}

// POST JSON over node:http(s): same semantics as the fetch path (throws the
// provider-labelled error on failure, resolves with parsed JSON), but the
// only timeout is our own absolute deadline.
function nodePostJson(provider, url, headers, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const makeRequest = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const chunks = [];
    const fail = (reason, { timeout = false } = {}) => reject(
      new ProviderRequestError(
        `${provider.providerName} request failed: ${sanitizeDiagnostic(reason, { secrets: [provider.apiKey] })}`,
        { timeout },
      ),
    );
    // Set when our own deadline destroys the socket, so the resulting
    // 'error' event is reported as a timeout rather than a generic
    // transport failure.
    let timedOut = false;
    const request = makeRequest(target, { method: 'POST', headers }, (response) => {
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        // Destroying the request surfaces the reason via its 'error' event.
        if (received > MAX_PROVIDER_RESPONSE_BYTES) {
          request.destroy(new Error(`response exceeded the ${MAX_PROVIDER_RESPONSE_BYTES}-byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', (error) => fail(error?.message ?? error));
      response.on('end', () => {
        clearTimeout(deadline);
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const detail = providerErrorDetail(text, provider.providerName, provider.apiKey);
          reject(new ProviderRequestError(providerStatusMessage(provider.providerName, response.statusCode, detail), {
            status: response.statusCode,
          }));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          fail('response was not valid JSON');
        }
      });
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      request.destroy(new Error(`timed out after ${provider.timeoutMs}ms`));
    }, provider.timeoutMs);
    if (typeof deadline.unref === 'function') deadline.unref();
    request.on('error', (error) => {
      clearTimeout(deadline);
      fail(error?.message ?? error, { timeout: timedOut });
    });
    request.end(payload);
  });
}

const OPENROUTER_RAW_ERROR_MAX_BYTES = 16 * 1024;

function providerErrorDetail(text, providerName, apiKey) {
  try {
    const body = JSON.parse(text);
    const options = { secrets: [apiKey] };
    if (providerName !== 'openrouter') {
      return structuredUpstreamDiagnostic(body, options);
    }
    const primary = structuredUpstreamDiagnostic(body, { ...options, maxBytes: 256 });
    const metadata = openRouterErrorMetadataDiagnostic(body, options);
    return sanitizeDiagnostic([primary, metadata].filter(Boolean).join('; '), {
      ...options,
      maxBytes: 512,
    });
  } catch {
    // Arbitrary HTML/plaintext bodies are not diagnostics. The status and
    // provider identity still explain the failure without retaining a dump.
    return '';
  }
}

// OpenRouter wraps the useful native-provider failure inside
// error.metadata.raw. Never surface that field directly: it is untrusted and
// could contain request data. Accept only a small JSON object, run it through
// the same field allowlist as every other upstream diagnostic, and ignore
// plaintext, arrays, debug objects, headers, prompts, and image data.
function openRouterErrorMetadataDiagnostic(body, options) {
  const metadata = body?.error?.metadata;
  if (!isPlainObject(metadata)) return '';

  const fields = [];
  if (typeof metadata.provider_name === 'string' || typeof metadata.provider_name === 'number') {
    const providerName = sanitizeDiagnostic(metadata.provider_name, { ...options, maxBytes: 96 });
    if (providerName) fields.push(`provider: ${providerName}`);
  }

  if (typeof metadata.raw === 'string'
    && Buffer.byteLength(metadata.raw, 'utf8') <= OPENROUTER_RAW_ERROR_MAX_BYTES) {
    try {
      const nativeError = JSON.parse(metadata.raw);
      if (isPlainObject(nativeError)) {
        const status = nativeError.status ?? nativeError.error?.status ?? nativeError.detail?.status;
        if (typeof status === 'string' || typeof status === 'number') {
          const safeStatus = sanitizeDiagnostic(status, { ...options, maxBytes: 96 });
          if (safeStatus) fields.push(`upstream status: ${safeStatus}`);
        }
        const detail = structuredUpstreamDiagnostic(nativeError, { ...options, maxBytes: 256 });
        if (detail) fields.push(`upstream: ${detail}`);
      }
    } catch {
      // Raw plaintext or malformed JSON is intentionally not diagnostic data.
    }
  }

  return sanitizeDiagnostic(fields.join('; '), { ...options, maxBytes: 384 });
}

function providerStatusMessage(providerName, status, detail) {
  return `${providerName} request failed with status ${status}${detail ? `: ${detail}` : ''}`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDataUrl(image) {
  const base64 = Buffer.from(image.data).toString('base64');
  return `data:${image.mimeType};base64,${base64}`;
}

export function extractOpenAiOutputText(response) {
  if (typeof response?.output_text === 'string' && response.output_text) {
    return response.output_text;
  }
  if (!Array.isArray(response?.output)) {
    return null;
  }
  for (const item of response.output) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  return null;
}

// The Responses API can answer with { type: 'refusal', refusal: '…' }
// instead of output text. Only the prose path treats that as the answer.
export function extractOpenAiRefusal(response) {
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'refusal' && typeof content.refusal === 'string' && content.refusal.trim()) {
        return content.refusal;
      }
    }
  }
  return null;
}

// Prose reads EVERY text part, in order. extractOpenAiOutputText returns
// the first one, which is right for enrichment — that payload is a single
// JSON document — but a spoken answer split across parts would lose
// everything after the first, so the sentence the frame reads aloud would
// simply stop mid-thought. Falls back to the refusal when there is no
// text at all.
export function extractOpenAiProseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text;
  }
  const parts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') {
        parts.push(content.text);
      }
    }
  }
  const text = parts.join(' ').trim();
  return text || extractOpenAiRefusal(response);
}

export function extractChoiceMessageContent(response) {
  const message = response?.choices?.[0]?.message;
  return typeof message?.content === 'string' ? message.content : null;
}

export function extractSchemaConstrainedChoiceContent(response) {
  const content = extractChoiceMessageContent(response);
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  // Some thinking-capable models in LM Studio route the entire
  // grammar-constrained JSON answer into reasoning_content while leaving
  // content empty. This extractor is used only for strict-schema requests;
  // prose continues to read content alone so genuine reasoning is never
  // displayed or spoken.
  const reasoningContent = response?.choices?.[0]?.message?.reasoning_content;
  if (typeof reasoningContent === 'string' && reasoningContent.trim()) {
    return reasoningContent;
  }
  return content;
}

export function extractOllamaMessageContent(response) {
  const content = response?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  // Thinking-capable models can misroute grammar-constrained output into the
  // thinking channel, leaving content empty. When non-empty, that thinking
  // string is the answer rather than chain-of-thought: with `format` active,
  // the whole generation is schema-constrained.
  const thinking = response?.message?.thinking;
  if (typeof thinking === 'string' && thinking.trim()) {
    return thinking;
  }
  if (typeof content === 'string') {
    return content;
  }
  return typeof response?.response === 'string' ? response.response : null;
}

// LM Studio cannot ingest WebP (Immich's preview format); convert via macOS
// sips when available. Everywhere else (the Docker image runs Alpine Linux)
// there is no converter, so fail fast with the actual way out instead of
// failing every photo with an opaque spawn error.
// TODO(packaging): a pure-JS WebP decode would remove the guidance path.
const LM_WEBP_GUIDANCE =
  'LM Studio cannot read Immich WebP previews, and converting them needs macOS (sips) — '
  + 'not available on this system (e.g. inside Docker). Set "Image source" to original in '
  + 'Settings → Enrich (IMAGE_SOURCE=original) so runs send original files instead. '
  + 'Originals are typically JPEG; HEIC originals may still be rejected by LM Studio.';

// The spoken "interesting" command always sends Immich's WebP preview and
// has no image-source setting of its own, so pointing at Settings → Enrich
// (as the enrichment guidance does) would send the user somewhere that
// cannot help. Say the two things that actually work instead.
export const LM_WEBP_VOICE_GUIDANCE =
  'LM Studio cannot read Immich WebP previews outside macOS. Pick a different '
  + 'voice answer provider in Settings → Voice.';

export function lmStudioSupportedImage(image, guidance = LM_WEBP_GUIDANCE) {
  const mime = String(image.mimeType).toLowerCase().split(';')[0].trim();
  if (mime !== 'image/webp') {
    return image;
  }
  return { ...image, data: convertWebpToJpeg(image.data, guidance), mimeType: 'image/jpeg' };
}

function convertWebpToJpeg(data, guidance = LM_WEBP_GUIDANCE) {
  if (process.platform !== 'darwin') {
    throw new Error(guidance);
  }
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-enrich-'));
  const inputPath = join(dir, 'input.webp');
  const outputPath = join(dir, 'output.jpg');
  try {
    writeFileSync(inputPath, Buffer.from(data));
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', inputPath, '--out', outputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(guidance);
      }
      const detail = error?.stderr ? String(error.stderr).trim() : error?.message ?? error;
      throw new Error(`Failed to convert WebP preview for LM Studio: ${detail}`);
    }
    return readFileSync(outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}
