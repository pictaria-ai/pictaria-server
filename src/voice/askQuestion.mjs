import { generateProse, ProseGenerationError, proseTimeoutFallback, resolveProseProvider } from './prose.mjs';
import { DEFAULT_ASK_PROMPT, renderPromptTemplate } from './promptTemplates.mjs';

const ASK_PROMPT_VERSION = 'ask-v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 600;
// Below this there is no point asking a model: the round trip alone
// would outlast what is left of the budget.
const MIN_USEFUL_BUDGET_MS = 1500;
const TIMEOUT_FALLBACK_TEXT = 'Sorry — that took too long to answer. Please try again.';
const EMPTY_RETRY_MAX_OUTPUT_TOKENS = 900;
// Spoken questions are one sentence; anything longer than this is a
// runaway transcript, not a question.
const MAX_QUESTION_LENGTH = 500;

export class AskQuestionError extends Error {
  constructor(message, status = 502, { provider = null, model = null } = {}) {
    super(message);
    this.name = 'AskQuestionError';
    this.status = status;
    this.provider = provider;
    this.model = model;
  }
}

export function validateAskRequest(body) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';

  if (!question) {
    return { error: 'question is required.' };
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return { error: `Questions are limited to ${MAX_QUESTION_LENGTH} characters.` };
  }

  return { value: { question } };
}

export async function generateAskAnswer({ question, config, promptTemplate = '', budgetMs = null }) {
  const prompt = buildAskPrompt(question, promptTemplate);
  // Floored: the settings number coercion allows fractions, and OpenAI
  // rejects a non-integer max_output_tokens outright.
  const maxOutputTokens = Number.isFinite(config.voice.askMaxOutputTokens)
    ? Math.floor(config.voice.askMaxOutputTokens)
    : DEFAULT_MAX_OUTPUT_TOKENS;

  const remainingMs = budgetMs ? budgetMs() : null;
  if (remainingMs !== null && remainingMs <= MIN_USEFUL_BUDGET_MS) {
    // The work before this already spent the budget; asking a model now
    // only guarantees the Frame throws the answer away.
    console.warn('[Pictaria] Voice budget was spent before the model was asked; speaking the fallback line.');
    return {
      promptVersion: ASK_PROMPT_VERSION,
      ...proseTimeoutFallback({ provider: null, model: null, spokenFallback: TIMEOUT_FALLBACK_TEXT }),
    };
  }

  let resolved = null;
  const answer = await asAskError(() => {
    const provider = resolveProseProvider(config, {
      model: config.voice.askModel,
      openAiDefaultModel: config.voice.openAiAskModel,
      // What is left of the route's end-to-end budget, so slow Immich
      // work cannot push the answer past the Frame's own deadline.
      timeoutMs: remainingMs ?? config.voice.proseTimeoutMs,
    });
    resolved = provider;
    return generateProse({
      provider,
      prompt,
      maxOutputTokens,
      emptyRetryMaxOutputTokens: EMPTY_RETRY_MAX_OUTPUT_TOKENS,
      retryNudge: 'Return one concise spoken answer even if you must simplify.',
      label: 'ask answer',
    });
  }, () => resolved);

  return {
    // "-custom" flags answers produced by a Settings → Prompts override,
    // so odd answers can be traced to the prompt without guessing.
    promptVersion: promptTemplate ? `${ASK_PROMPT_VERSION}-custom` : ASK_PROMPT_VERSION,
    text: answer.text,
    speakText: answer.text,
    model: answer.model,
    provider: answer.provider,
    // Marks a spoken timeout line rather than a real answer, so metrics and
    // a future app version can tell them apart.
    ...(answer.fallback ? { fallback: true } : {}),
  };
}

export function buildAskPrompt(question, promptTemplate = '') {
  return renderPromptTemplate(promptTemplate || DEFAULT_ASK_PROMPT, { question });
}

// Keeps this module's error contract stable across the provider switch.
// A confirmed voice deadline is answered out loud above rather than thrown.
// Of what remains, only our own 503 (local misconfiguration) keeps its
// meaning; every provider and transport failure normalizes to 502, because
// the app reads OUR 404 as "old server, update needed" and would read a
// passed-through provider 503 as our own misconfiguration.
async function asAskError(work, getProvider = () => null) {
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
      throw new AskQuestionError(error.message, error.status === 503 ? 503 : 502, {
        provider: provider?.providerName ?? error.provider ?? null,
        model: provider?.modelName ?? error.model ?? null,
      });
    }
    throw error;
  }
}
