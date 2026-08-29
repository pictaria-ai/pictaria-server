import { formatPlace, parseDateParts } from './photoAnswers.mjs';
import { generateProse, ProseGenerationError, proseTimeoutFallback, resolveProseProvider } from './prose.mjs';
import { DEFAULT_INTERESTING_PROMPT, renderPromptTemplate } from './promptTemplates.mjs';

const INTERESTING_PROMPT_VERSION = 'interesting-v2';
const DEFAULT_IMAGE_DETAIL = 'high';
const DEFAULT_MAX_OUTPUT_TOKENS = 420;
// Below this there is no point asking a model: the round trip alone
// would outlast what is left of the budget.
const MIN_USEFUL_BUDGET_MS = 1500;
const TIMEOUT_FALLBACK_TEXT = 'Sorry — I could not think of something in time. Please try again.';
const EMPTY_RETRY_MAX_OUTPUT_TOKENS = 700;

export class InterestingPhotoError extends Error {
  constructor(message, status = 502, { provider = null, model = null } = {}) {
    super(message);
    this.name = 'InterestingPhotoError';
    this.status = status;
    this.provider = provider;
    this.model = model;
  }
}

// The spoken line for when the command cannot even reach a model — used
// by the route when the Immich lookups outlive the voice budget.
export function interestingTimeoutFallback() {
  return {
    promptVersion: INTERESTING_PROMPT_VERSION,
    ...proseTimeoutFallback({ provider: null, model: null, spokenFallback: TIMEOUT_FALLBACK_TEXT }),
  };
}

export async function generateInterestingPhotoAnswer({ asset, config, image, promptTemplate = '', budgetMs = null }) {
  const prompt = buildInterestingPhotoPrompt(asset, promptTemplate);
  const maxOutputTokens = Number.isFinite(config.voice.interestingMaxOutputTokens)
    ? Math.floor(config.voice.interestingMaxOutputTokens)
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const providerImage = toProviderImage(image, config.voice.openAiInterestingImageDetail);

  const remainingMs = budgetMs ? budgetMs() : null;
  if (remainingMs !== null && remainingMs <= MIN_USEFUL_BUDGET_MS) {
    // The work before this already spent the budget; asking a model now
    // only guarantees the Frame throws the answer away.
    console.warn('[Pictaria] Voice budget was spent before the model was asked; speaking the fallback line.');
    return {
      promptVersion: INTERESTING_PROMPT_VERSION,
      ...proseTimeoutFallback({ provider: null, model: null, spokenFallback: TIMEOUT_FALLBACK_TEXT }),
    };
  }

  let resolved = null;
  const answer = await asInterestingError(() => {
    const provider = resolveProseProvider(config, {
      model: config.voice.interestingModel,
      openAiDefaultModel: config.voice.openAiInterestingModel,
      // What is left of the route's end-to-end budget, so slow Immich
      // work cannot push the answer past the Frame's own deadline.
      timeoutMs: remainingMs ?? config.voice.proseTimeoutMs,
    });
    resolved = provider;
    return generateProse({
      provider,
      prompt,
      image: providerImage,
      maxOutputTokens,
      emptyRetryMaxOutputTokens: EMPTY_RETRY_MAX_OUTPUT_TOKENS,
      retryNudge:
        'Return one concise spoken answer. If the exact subject is uncertain, use a safe '
        + 'observation about the visible scene, location, or date.',
      label: 'interesting photo answer',
    });
  }, () => resolved);

  return {
    // "-custom" flags answers produced by a Settings → Prompts override,
    // so odd answers can be traced to the prompt without guessing.
    promptVersion: promptTemplate ? `${INTERESTING_PROMPT_VERSION}-custom` : INTERESTING_PROMPT_VERSION,
    text: answer.text,
    speakText: answer.text,
    model: answer.model,
    provider: answer.provider,
    // Marks a spoken timeout line rather than a real answer, so metrics and
    // a future app version can tell them apart.
    ...(answer.fallback ? { fallback: true } : {}),
  };
}

// Keeps this module's error contract stable across the provider switch.
// A confirmed voice deadline is answered out loud above rather than thrown.
// Of what remains, only our own 503 (local misconfiguration) keeps its
// meaning; every provider and transport failure normalizes to 502, because
// the app reads OUR 404 as "old server, update needed" and would read a
// passed-through provider 503 as our own misconfiguration.
async function asInterestingError(work, getProvider = () => null) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProseGenerationError && error.timeout) {
      // Spoken, not thrown: see proseTimeoutFallback — an error here is
      // silence on a frame set to TTS-only.
      console.warn(`[Pictaria] Voice answer timed out; speaking the fallback line. ${error.message}`);
      const provider = getProvider();
      return proseTimeoutFallback({
        provider: provider?.providerName ?? null,
        model: provider?.modelName ?? null,
        spokenFallback: TIMEOUT_FALLBACK_TEXT,
      });
    }
    if (error instanceof ProseGenerationError) {
      const provider = getProvider();
      throw new InterestingPhotoError(error.message, error.status === 503 ? 503 : 502, {
        provider: provider?.providerName ?? error.provider ?? null,
        model: provider?.modelName ?? error.model ?? null,
      });
    }
    throw error;
  }
}

// The provider layer speaks { data, mimeType }; Immich handed us
// { buffer, contentType }. `detail` rides along for OpenAI, the only
// provider with an image-fidelity knob.
function toProviderImage(image, imageDetail) {
  const buffer = Buffer.isBuffer(image?.buffer) ? image.buffer : Buffer.from(image?.buffer || []);

  if (buffer.length === 0) {
    throw new InterestingPhotoError('Immich returned an empty image preview.');
  }

  return {
    data: buffer,
    mimeType: normalizeImageContentType(image?.contentType),
    detail: normalizeImageDetail(imageDetail),
  };
}

export function buildInterestingPhotoPrompt(asset, promptTemplate = '') {
  const context = buildInterestingPhotoContext(asset);
  const contextLines = [
    `Date taken: ${context.dateTaken || 'unknown'}`,
    `Location: ${context.location || 'unknown'}`,
    `Original filename: ${context.originalFileName || 'unknown'}`,
  ];

  return renderPromptTemplate(promptTemplate || DEFAULT_INTERESTING_PROMPT, {
    context: contextLines.join('\n'),
  });
}

export function buildInterestingPhotoContext(asset) {
  const dateTaken = formatDateForPrompt(
    asset?.exifInfo?.dateTimeOriginal || asset?.localDateTime || asset?.fileCreatedAt,
  );
  const rawLocation = {
    city: asset?.city || asset?.exifInfo?.city,
    state: asset?.state || asset?.exifInfo?.state,
    country: asset?.country || asset?.exifInfo?.country,
  };
  const location = formatPlace(rawLocation) || cleanText(asset?.locationLabel);

  return {
    dateTaken,
    location,
    originalFileName: cleanText(asset?.originalFileName),
  };
}

function normalizeImageContentType(value) {
  const contentType = String(value || '').split(';')[0].trim().toLowerCase();
  return contentType && contentType.startsWith('image/') ? contentType : 'image/jpeg';
}

function normalizeImageDetail(value) {
  return ['low', 'high', 'original', 'auto'].includes(value) ? value : DEFAULT_IMAGE_DETAIL;
}

function formatDateForPrompt(value) {
  const date = parseDateParts(value);

  if (!date) {
    return '';
  }

  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}

function cleanText(value) {
  return String(value || '').trim();
}
