import { fetchWithTimeout, RequestTimeoutError } from '../fetchWithTimeout.mjs';
import { configuredSecrets, sanitizeDiagnostic, structuredUpstreamDiagnostic } from '../diagnostics.mjs';

const SUPPORTED_PROVIDERS = new Set(['openai', 'elevenlabs']);

export class TtsProviderError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'TtsProviderError';
    this.status = status;
  }
}

export async function synthesizeSpeech({ config, text, provider, model, voice, format }) {
  const { provider: selectedProvider } = resolveTtsIdentity(config, { provider, model });

  if (!selectedProvider) {
    throw new TtsProviderError('TTS provider is not configured.', 501);
  }

  if (selectedProvider === 'openai') {
    return synthesizeWithOpenAi({ config, text, model, voice, format });
  }

  if (selectedProvider === 'elevenlabs') {
    return synthesizeWithElevenLabs({ config, text, model, voice, format });
  }

  throw new TtsProviderError(`Unsupported TTS provider: ${selectedProvider}`, 400);
}

// Resolves only the non-secret provider/model identity used by diagnostics.
// The spoken text, voice, credentials, and provider request never cross this
// boundary.
export function resolveTtsIdentity(config, { provider, model } = {}) {
  const selectedProvider = normalizeProvider(provider || config.ttsProvider);
  const selectedModel = selectedProvider === 'openai'
    ? model || config.openAiTtsModel
    : selectedProvider === 'elevenlabs'
      ? model || config.elevenLabsTtsModel
      : null;
  return {
    provider: selectedProvider || null,
    model: selectedModel || null,
  };
}

export function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return SUPPORTED_PROVIDERS.has(provider) ? provider : '';
}

export function validateTtsRequest(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';

  if (!text) {
    return { error: 'Text is required.' };
  }

  if (text.length > 500) {
    return { error: 'Text is too long for a brief photo-frame response.' };
  }

  return {
    value: {
      text,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      voice: typeof body.voice === 'string' ? body.voice : undefined,
      format: typeof body.format === 'string' ? body.format : undefined,
    },
  };
}

async function synthesizeWithOpenAi({ config, text, model, voice, format }) {
  if (!config.openAiApiKey) {
    throw new TtsProviderError('OPENAI_API_KEY is not configured.', 503);
  }

  const selectedModel = model || config.openAiTtsModel;
  const selectedVoice = voice || config.openAiTtsVoice;
  const selectedFormat = format || config.openAiTtsFormat;
  const body = {
    model: selectedModel,
    voice: selectedVoice,
    input: text,
    response_format: selectedFormat,
    speed: clampSpeed(config.openAiTtsSpeed),
  };

  if (config.openAiTtsInstructions) {
    body.instructions = config.openAiTtsInstructions;
  }

  let response;

  try {
    response = await fetchWithTimeout(
      'https://api.openai.com/v1/audio/speech',
      {
        method: 'POST',
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      config.openAiRequestTimeoutMs,
      'OpenAI TTS request',
    );
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new TtsProviderError(error.message, 504);
    }
    throw new TtsProviderError(sanitizeDiagnostic(error instanceof Error ? error.message : error, {
      secrets: configuredSecrets(config),
      fallback: 'OpenAI TTS request failed.',
    }));
  }

  if (!response.ok) {
    throw new TtsProviderError(
      await readProviderError(response, 'OpenAI TTS request failed.', configuredSecrets(config)),
      response.status,
    );
  }

  return {
    audio: Buffer.from(await response.arrayBuffer()),
    contentType: contentTypeForOpenAiFormat(selectedFormat),
    model: selectedModel,
    provider: 'openai',
    voice: selectedVoice,
  };
}

async function synthesizeWithElevenLabs({ config, text, model, voice, format }) {
  if (!config.elevenLabsApiKey) {
    throw new TtsProviderError('ELEVENLABS_API_KEY is not configured.', 503);
  }

  const selectedVoice = voice || config.elevenLabsVoiceId;
  if (!selectedVoice) {
    throw new TtsProviderError('ELEVENLABS_VOICE_ID is not configured.', 503);
  }

  const selectedModel = model || config.elevenLabsTtsModel;
  const selectedFormat = format || config.elevenLabsOutputFormat;
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(selectedVoice)}`);
  url.searchParams.set('output_format', selectedFormat);

  let response;

  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': config.elevenLabsApiKey,
        },
        body: JSON.stringify({
          text,
          model_id: selectedModel,
        }),
      },
      config.elevenLabsRequestTimeoutMs,
      'ElevenLabs TTS request',
    );
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new TtsProviderError(error.message, 504);
    }
    throw new TtsProviderError(sanitizeDiagnostic(error instanceof Error ? error.message : error, {
      secrets: configuredSecrets(config),
      fallback: 'ElevenLabs TTS request failed.',
    }));
  }

  if (!response.ok) {
    throw new TtsProviderError(
      await readProviderError(response, 'ElevenLabs TTS request failed.', configuredSecrets(config)),
      response.status,
    );
  }

  return {
    audio: Buffer.from(await response.arrayBuffer()),
    contentType: contentTypeForElevenLabsFormat(selectedFormat),
    model: selectedModel,
    provider: 'elevenlabs',
    voice: selectedVoice,
  };
}

async function readProviderError(response, fallback, secrets) {
  try {
    const body = await response.json();
    return structuredUpstreamDiagnostic(body, { secrets, fallback });
  } catch {
    return fallback;
  }
}

function clampSpeed(value) {
  const speed = Number(value);

  if (!Number.isFinite(speed)) {
    return 1;
  }

  return Math.min(4, Math.max(0.25, speed));
}

function contentTypeForOpenAiFormat(format) {
  if (format === 'wav') {
    return 'audio/wav';
  }

  if (format === 'opus') {
    return 'audio/opus';
  }

  if (format === 'aac') {
    return 'audio/aac';
  }

  if (format === 'flac') {
    return 'audio/flac';
  }

  return 'audio/mpeg';
}

function contentTypeForElevenLabsFormat(format) {
  return String(format).startsWith('pcm_') ? 'audio/pcm' : 'audio/mpeg';
}
