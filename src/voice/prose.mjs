// Two prose voice commands share this spoken-answer path: "what's interesting
// about this photo" (with an image) and "tell me …" (without one). Both
// resolve a configured provider through the provider layer's generateProse.
//
// The retry-once-on-empty behavior is deliberate and predates this module:
// a model that spends its whole budget on hidden reasoning returns empty
// content rather than an error, and one nudged retry with a bigger budget
// reliably recovers it. Beyond that a spoken command must fail fast — the
// person is standing in front of the frame waiting for it to talk.

import { createProvider, ProviderRequestError } from '../enrich/providers.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

// Voice answers are one or two sentences; these ceilings only exist so a
// runaway generation cannot hold the speaker silent.
const MIN_PROSE_TIMEOUT_MS = 1000;

export class ProseGenerationError extends Error {
  constructor(message, status = 502, { timeout = false, provider = null, model = null } = {}) {
    super(message);
    this.name = 'ProseGenerationError';
    this.status = status;
    // A confirmed deadline, not just any statusless failure: the commands
    // speak a fallback line for this and only this, so it must not be
    // inferred from a DNS error or a refused connection.
    this.timeout = timeout;
    this.provider = provider;
    this.model = model;
  }
}

// Provider messages land verbatim on the frame's answer overlay, so a
// multi-megabyte error body must never get that far. Matches the cap the
// pre-shared Ask implementation applied for the same reason.
const MAX_PROVIDER_DETAIL = 240;

function boundedDetail(message, secrets = []) {
  return sanitizeDiagnostic(message, { secrets, maxBytes: MAX_PROVIDER_DETAIL });
}

// Can this provider actually serve the image command on this machine?
// LM Studio cannot read Immich's WebP previews, and the conversion needs
// macOS, so on any other platform "what's interesting about this photo"
// fails deterministically no matter how well it is configured. Readiness
// has to know that or /api/health promises something that cannot work.
// Platform is a parameter so the rule is testable off macOS.
export function canDescribeImages(providerName, platform = process.platform) {
  return !(providerName === 'local_lmstudio' && platform !== 'darwin');
}

// Which provider answers the voice commands, and with which model. The
// provider is one explicit setting shared by both commands; the model is
// per-command so a large vision model can describe a photo while something
// small and quick handles spoken questions. An empty per-command model
// means "whatever this provider is configured to use" — the same field the
// Enrich page shows for that provider.
export function resolveProseProvider(config, { model = '', openAiDefaultModel = '', timeoutMs } = {}) {
  const providerName = config.voice?.proseProvider || 'cloud_openai';
  const providerOptions = config.providers?.[providerName];
  if (!providerOptions) {
    throw new ProseGenerationError(`Unknown voice provider: ${providerName}.`, 503, { provider: providerName });
  }

  // On OpenAI an unset model keeps the historical per-command default
  // (gpt-5.5 to describe a photo, a nano model for spoken questions) so
  // upgrading changes nothing. Any other provider falls back to the model
  // that provider is already configured with.
  const providerDefault = providerName === 'cloud_openai' && openAiDefaultModel
    ? openAiDefaultModel
    : providerOptions.modelName;
  const resolvedModel = model || providerDefault;
  if (!resolvedModel) {
    throw new ProseGenerationError(
      `No model is configured for ${providerName}. Set one in Settings → Voice, or give ${providerName} a model under Settings → AI Providers.`,
      503,
      { provider: providerName },
    );
  }

  try {
    return createProvider(providerName, {
      ...providerOptions,
      modelName: resolvedModel,
      // Voice is interactive: the frame stands silent until this returns,
      // so it gets its own budget rather than the enrichment timeout,
      // which is measured in minutes for local models.
      timeoutMs: Math.max(MIN_PROSE_TIMEOUT_MS, timeoutMs ?? 25000),
    });
  } catch (error) {
    // createProvider throws when a provider's required credential is
    // missing — a configuration problem, not a transport failure.
    throw new ProseGenerationError(error instanceof Error ? error.message : String(error), 503, {
      provider: providerName,
      model: resolvedModel,
    });
  }
}

// One spoken answer. `image` is optional — omit it for text-only commands.
export async function generateProse({
  provider,
  systemPrompt = 'You are the voice of a digital photo frame. Answer in a natural spoken sentence or two.',
  prompt,
  image = null,
  maxOutputTokens,
  emptyRetryMaxOutputTokens,
  retryNudge = 'Return one concise spoken answer.',
  label = 'answer',
  now = () => Date.now(),
}) {
  const images = image ? [image] : [];
  // ONE deadline for the whole command, not one per attempt. The retry used
  // to get a fresh full budget, so a configured 25s could run to ~50s — past
  // the 45s the Frame waits before abandoning the request, which would throw
  // away an answer that did eventually arrive.
  const deadline = now() + provider.timeoutMs;
  const request = (userPrompt, budget) => provider.generateProse({
    systemPrompt,
    userPrompt,
    images,
    maxOutputTokens: budget,
    ...(image?.detail ? { imageDetail: image.detail } : {}),
  });

  let result = await callProvider(provider, request, prompt, maxOutputTokens, label);
  let text = cleanProseAnswer(result.text);

  if (!text) {
    const remainingMs = deadline - now();
    if (remainingMs <= MIN_PROSE_TIMEOUT_MS) {
      // No budget left to try again; say so as a deadline rather than
      // claiming the model had nothing to say.
      throw new ProseGenerationError(
        `${provider.providerName} ran out of time before it produced an ${label}.`,
        504,
        { timeout: true },
      );
    }
    console.warn(`[Pictaria] ${provider.providerName} returned an empty ${label}; retrying once.`);
    // The retry gets only what is left of the command's deadline. The
    // provider owns its own timer, and this instance was built for this one
    // command in resolveProseProvider, so narrowing it here affects nothing
    // else.
    provider.timeoutMs = Math.max(MIN_PROSE_TIMEOUT_MS, remainingMs);
    result = await callProvider(
      provider,
      request,
      `${prompt}\n\n${retryNudge}`,
      Math.max(maxOutputTokens * 2, emptyRetryMaxOutputTokens ?? maxOutputTokens * 2),
      label,
    );
    text = cleanProseAnswer(result.text);
  }

  if (!text) {
    console.warn(`[Pictaria] ${provider.providerName} returned an empty ${label} after retry.`);
    throw new ProseGenerationError(`${provider.providerName} returned an empty ${label}.`);
  }

  return { text, model: provider.modelName, provider: provider.providerName };
}

// Status meanings are ours, not the provider's: 504 means OUR voice
// deadline expired, 503 means local misconfiguration. Everything else a
// provider or the transport can produce — a refused connection, DNS
// failure, an unparseable body, any upstream HTTP status — normalizes to
// 502 so the app never reads a provider's 404 as "old server, update
// needed" or a provider's 503 as our own misconfiguration.
async function callProvider(provider, request, userPrompt, maxOutputTokens, label) {
  const secrets = configuredSecrets(provider);
  try {
    return await request(userPrompt, maxOutputTokens);
  } catch (error) {
    if (error instanceof ProseGenerationError) {
      throw error;
    }
    if (error instanceof ProviderRequestError && error.timeout) {
      throw new ProseGenerationError(boundedDetail(error.message, secrets), 504, { timeout: true });
    }
    throw new ProseGenerationError(boundedDetail(error instanceof Error ? error.message : error, secrets), 502);
  }
}

// A confirmed deadline gets a spoken answer rather than an error. The
// Frame speaks only successful responses — its error path paints the
// overlay and says nothing — so returning an error here is literal silence
// for anyone using TTS-only mode. Saying "that took too long" out loud is
// the whole point of the command. `fallback: true` marks it so metrics and
// a future app version can tell it apart from a real answer.
export function proseTimeoutFallback({ provider, model, spokenFallback }) {
  return {
    text: spokenFallback,
    speakText: spokenFallback,
    model,
    provider,
    fallback: true,
  };
}

// Spoken answers are read aloud verbatim: collapse the whitespace a model
// may have formatted with, and strip the quotes some wrap the answer in.
export function cleanProseAnswer(value) {
  return String(value || '')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}
