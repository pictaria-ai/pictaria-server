import { readJsonBody, sendAudio, sendError, sendJson } from '../http.mjs';
import { findFrameTag, FRAME_ELIGIBLE_TAG, FRAME_FAVORITE_TAG, FRAME_NEVER_SHOW_TAG } from '../frame/tags.mjs';
import { applyLocationEnrichment, enrichAssetLocation, getLocationEnrichment } from '../ambient/geocoding.mjs';
import { AskQuestionError, generateAskAnswer, validateAskRequest } from '../voice/askQuestion.mjs';
import { generateInterestingPhotoAnswer, interestingTimeoutFallback, InterestingPhotoError } from '../voice/interestingPhoto.mjs';
import { DEFAULT_ASK_PROMPT, DEFAULT_INTERESTING_PROMPT } from '../voice/promptTemplates.mjs';
import { PhotoShowSearchError, searchShowPhotos, validateShowSearchRequest } from '../voice/photoShowSearch.mjs';
import { buildPhotoAnswers } from '../voice/photoAnswers.mjs';
import { resolveTtsIdentity, synthesizeSpeech, TtsProviderError, validateTtsRequest } from '../voice/tts.mjs';
import { classifyVoiceIntent, validateVoiceIntentRequest } from '../voice/intent.mjs';
import { normalizeVoiceUsageLabel } from '../voice/usageLabels.mjs';
import { configuredSecrets, sanitizeDiagnostic } from '../diagnostics.mjs';

// The Frame abandons "interesting" after 45s and "tell me" after 60s, so a
// server budget above the tighter of those guarantees the answer is thrown
// away even when it arrives. Clamped rather than trusted.
const MAX_VOICE_PROSE_BUDGET_MS = 40000;

// Bounds work that has no deadline of its own — the Immich lookups the
// "interesting" command needs before it can ask a model. This is what
// makes the voice budget bound the RESPONSE rather than merely count
// against it.
//
// Abandoned, not cancelled: the Immich client takes no abort signal, so a
// stage already in flight runs to completion under Immich's own timeout
// and its result is dropped. That is NOT side-effect-free —
// getEnrichedAsset may reverse-geocode (Geoapify) and, when
// IMMICH_METADATA_WRITEBACK is on, upsert location metadata back to
// Immich. Those effects are idempotent and would have happened on the
// next request anyway, but they are real, so the budget is re-checked
// BETWEEN stages: an expired budget must never start new work.
const BUDGET_EXPIRED = Symbol('budgetExpired');

async function withinBudget(work, remainingMs) {
  let timer = null;
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(BUDGET_EXPIRED), Math.max(0, remainingMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function voiceProseBudgetMs(config) {
  const configured = Number(config.voice?.proseTimeoutMs);
  return Math.min(Number.isFinite(configured) && configured > 0 ? configured : 25000, MAX_VOICE_PROSE_BUDGET_MS);
}

export function createVoiceRoutes({ immich, config, requireImmich, voiceMetrics = null, activityLog = null }) {
  const voiceConfig = config.voice;
  const ambientConfig = config.ambient;
  const promptsConfig = config.prompts ?? {};

  return async function handleVoiceRoute(request, response, url) {
    if (request.method === 'POST' && url.pathname === '/api/voice/transcribe') {
      await readJsonBody(request);
      sendError(response, 501, 'provider_not_configured', 'Voice transcription provider is not configured yet.');
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/voice/intent') {
      const validation = validateVoiceIntentRequest(await readJsonBody(request));
      if (validation.error) {
        sendError(response, 400, 'invalid_voice_intent_request', validation.error);
        return true;
      }
      sendJson(response, 200, { intent: classifyVoiceIntent(validation.value.transcript) });
      return true;
    }

    // The built-in prompt templates, so the Settings → Prompts section can
    // show the real text behind the "Load built-in text to edit" buttons.
    if (request.method === 'GET' && url.pathname === '/api/voice/prompts') {
      sendJson(response, 200, {
        builtin: {
          interestingPrompt: DEFAULT_INTERESTING_PROMPT,
          askPrompt: DEFAULT_ASK_PROMPT,
        },
      });
      return true;
    }

    // One-shot LLM Q&A behind the "tell me …" voice command. The question
    // is used for the provider call only — never logged and never stored
    // (the same rule transcripts follow everywhere else).
    if (request.method === 'POST' && url.pathname === '/api/voice/ask') {
      const validation = validateAskRequest(await readJsonBody(request));
      if (validation.error) {
        sendError(response, 400, 'invalid_ask_request', validation.error);
        return true;
      }
      // The clock starts here, not inside the provider call: everything
      // between now and the answer counts against the person waiting.
      const askDeadline = Date.now() + voiceProseBudgetMs(config);
      try {
        const answer = await generateAskAnswer({
          budgetMs: () => askDeadline - Date.now(),
          config,
          promptTemplate: promptsConfig.askPrompt || '',
          question: validation.value.question,
        });
        activityLog?.voiceAnswer({
          kind: 'tell-me',
          provider: answer.provider,
          model: answer.model,
          outcome: answer.fallback ? 'fallback' : 'succeeded',
        });
        sendJson(response, 200, answer);
      } catch (error) {
        if (error instanceof AskQuestionError) {
          activityLog?.voiceAnswer({
            kind: 'tell-me',
            provider: error.provider,
            model: error.model,
            outcome: 'failed',
          });
          sendError(response, error.status, 'ask_error', sanitizeDiagnostic(error.message, {
            secrets: configuredSecrets(config, immich),
          }));
          return true;
        }
        activityLog?.voiceAnswer({ kind: 'tell-me', outcome: 'failed' });
        throw error;
      }
      return true;
    }

    // Pictaria Frame reports each executed voice command here (label only,
    // e.g. "next" or "show-search" — never the transcript). The intent
    // endpoint above is just the voice.html test console, so it does not
    // count toward usage. deviceId is the app's self-chosen device name
    // (same identity as display reports); older builds omit it and their
    // counts land in the unattributed bucket.
    if (request.method === 'POST' && url.pathname === '/api/voice/command-used') {
      const body = await readJsonBody(request);
      const reportedLabel = String(body?.label ?? '').trim().slice(0, 64);
      if (!reportedLabel) {
        sendError(response, 400, 'invalid_voice_command_label', 'label is required.');
        return true;
      }
      const label = normalizeVoiceUsageLabel(reportedLabel);
      voiceMetrics?.record(label, { deviceId: String(body?.deviceId ?? '').trim().slice(0, 64) });
      activityLog?.voiceCommand({
        label,
        deviceId: String(body?.deviceId ?? '').trim().slice(0, 64),
      });
      sendJson(response, 200, { ok: true });
      return true;
    }

    // ?device= filters to one device ('' = counts never attributed to a
    // device); omit the param for all devices combined. The devices list in
    // the response is always complete either way.
    if (request.method === 'GET' && url.pathname === '/api/voice/metrics') {
      sendJson(
        response,
        200,
        voiceMetrics
          ? voiceMetrics.summary(url.searchParams.get('device'))
          : { available: false, totalUses: 0, commands: [], devices: [] },
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/voice/tts') {
      await sendTts(response, await readJsonBody(request));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/photos/show-search') {
      if (!requireImmich(response)) {
        return true;
      }
      const validation = validateShowSearchRequest(await readJsonBody(request));
      if (validation.error) {
        sendError(response, 400, 'invalid_show_search_request', validation.error);
        return true;
      }
      try {
        sendJson(response, 200, await searchShowPhotos({ immich, ...validation.value }));
      } catch (error) {
        if (error instanceof PhotoShowSearchError) {
          sendError(response, error.status, error.code, error.message);
          return true;
        }
        throw error;
      }
      return true;
    }

    const metadataMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/metadata$/);
    if (request.method === 'GET' && metadataMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const enrichedAsset = await getEnrichedAsset(decodeURIComponent(metadataMatch[1]));
      sendJson(response, 200, {
        asset: enrichedAsset,
        answers: buildPhotoAnswers(enrichedAsset),
      });
      return true;
    }

    const interestingMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/interesting$/);
    if (request.method === 'POST' && interestingMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const assetId = decodeURIComponent(interestingMatch[1]);
      // Started before the Immich round trips: fetching the asset and its
      // preview is part of how long the frame stands silent, and on a slow
      // Immich it can eat the whole budget on its own.
      const interestingDeadline = Date.now() + voiceProseBudgetMs(config);
      try {
        // Raced per stage against the budget: an Immich that stalls past it
        // must not hold the frame silent until the app gives up at 45s, and
        // an expired budget must not start the next fetch.
        const asset = await withinBudget(
          getEnrichedAsset(assetId, () => Date.now() < interestingDeadline),
          interestingDeadline - Date.now(),
        );
        if (asset === BUDGET_EXPIRED) {
          console.warn('[Pictaria] Immich did not answer inside the voice budget; speaking the fallback line.');
          activityLog?.voiceAnswer({ kind: 'interesting', assetId, outcome: 'fallback' });
          sendJson(response, 200, interestingTimeoutFallback());
          return true;
        }
        const image = await withinBudget(
          immich.getAssetThumbnail(assetId, 'preview'),
          interestingDeadline - Date.now(),
        );
        if (image === BUDGET_EXPIRED) {
          console.warn('[Pictaria] The preview did not arrive inside the voice budget; speaking the fallback line.');
          activityLog?.voiceAnswer({ kind: 'interesting', assetId, outcome: 'fallback' });
          sendJson(response, 200, interestingTimeoutFallback());
          return true;
        }
        const answer = await generateInterestingPhotoAnswer({
          budgetMs: () => interestingDeadline - Date.now(),
          asset,
          config,
          image: { buffer: image.data, contentType: image.contentType },
          promptTemplate: promptsConfig.interestingPrompt || '',
        });
        activityLog?.voiceAnswer({
          kind: 'interesting',
          assetId,
          provider: answer.provider,
          model: answer.model,
          outcome: answer.fallback ? 'fallback' : 'succeeded',
        });
        sendJson(response, 200, answer);
      } catch (error) {
        if (error instanceof InterestingPhotoError) {
          activityLog?.voiceAnswer({
            kind: 'interesting',
            assetId,
            provider: error.provider,
            model: error.model,
            outcome: 'failed',
          });
          sendError(response, error.status, 'interesting_photo_error', sanitizeDiagnostic(error.message, {
            secrets: configuredSecrets(config, immich),
          }));
          return true;
        }
        activityLog?.voiceAnswer({ kind: 'interesting', assetId, outcome: 'failed' });
        throw error;
      }
      return true;
    }

    const favoriteMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/favorite$/);
    if (request.method === 'POST' && favoriteMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const assetId = decodeURIComponent(favoriteMatch[1]);
      try {
        const tags = await immich.upsertTags([FRAME_FAVORITE_TAG]);
        const favoriteTag = findFrameTag(tags, FRAME_FAVORITE_TAG);
        if (!favoriteTag?.id) {
          activityLog?.assetFavorited({ assetId, outcome: 'failed' });
          sendError(response, 502, 'favorite_tag_missing', 'Immich did not return the favorite tag ID.');
          return true;
        }
        await immich.tagAssetsBulk({ tagIds: [favoriteTag.id], assetIds: [assetId] });
        activityLog?.assetFavorited({ assetId });
        sendJson(response, 200, { assetId, tag: favoriteTag });
      } catch (error) {
        activityLog?.assetFavorited({ assetId, outcome: 'failed' });
        throw error;
      }
      return true;
    }

    const neverShowMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/never-show$/);
    if (request.method === 'POST' && neverShowMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const assetId = decodeURIComponent(neverShowMatch[1]);
      try {
        const tags = await immich.upsertTags([FRAME_NEVER_SHOW_TAG]);
        const neverShowTag = findFrameTag(tags, FRAME_NEVER_SHOW_TAG);
        if (!neverShowTag?.id) {
          activityLog?.assetHidden({ assetId, outcome: 'failed' });
          sendError(response, 502, 'never_show_tag_missing', 'Immich did not return the never-show tag ID.');
          return true;
        }
        await immich.tagAssetsBulk({ tagIds: [neverShowTag.id], assetIds: [assetId] });

        const allTags = await immich.listTags();
        const eligibleTag = findFrameTag(allTags, FRAME_ELIGIBLE_TAG);
        if (eligibleTag?.id) {
          await immich.untagAssets({ tagId: eligibleTag.id, assetIds: [assetId] });
        }

        activityLog?.assetHidden({ assetId });
        sendJson(response, 200, {
          addedTag: neverShowTag,
          assetId,
          removedTag: eligibleTag ?? null,
        });
      } catch (error) {
        activityLog?.assetHidden({ assetId, outcome: 'failed' });
        throw error;
      }
      return true;
    }

    return false;
  };

  async function sendTts(response, requestBody) {
    const validation = validateTtsRequest(requestBody);
    if (validation.error) {
      sendError(response, 400, 'invalid_tts_request', validation.error);
      return;
    }
    const identity = resolveTtsIdentity(voiceConfig, validation.value);
    try {
      const result = await synthesizeSpeech({ config: voiceConfig, ...validation.value });
      activityLog?.voiceTts({ provider: result.provider, model: result.model, outcome: 'succeeded' });
      sendAudio(response, 200, result);
    } catch (error) {
      if (error instanceof TtsProviderError) {
        activityLog?.voiceTts({ ...identity, outcome: 'failed' });
        sendError(response, error.status, 'tts_provider_error', sanitizeDiagnostic(error.message, {
          secrets: configuredSecrets(config, immich),
        }));
        return;
      }
      activityLog?.voiceTts({ ...identity, outcome: 'failed' });
      throw error;
    }
  }

  // `shouldContinue` lets a caller working to a deadline stop this chain
  // between its external calls. The voice commands pass one: once their
  // budget expires the answer has already been spoken, so no further
  // metadata read, reverse geocode, or writeback may START — those reach
  // outside the process (Geoapify, and an Immich write when
  // IMMICH_METADATA_WRITEBACK is on) and would otherwise run unbounded
  // behind an answer nobody is waiting for. A call already in flight
  // still finishes; the Immich client takes no abort signal.
  async function getEnrichedAsset(assetId, shouldContinue = () => true) {
    const asset = await immich.getAsset(assetId);
    if (!shouldContinue()) {
      return asset;
    }

    const storedEnrichment = await readStoredLocationEnrichment(assetId);
    const storedAsset = storedEnrichment ? applyLocationEnrichment(asset, storedEnrichment) : asset;
    if (!shouldContinue()) {
      return storedAsset;
    }

    const enrichedAsset = await enrichAssetLocation(storedAsset, ambientConfig);

    if (!storedEnrichment && shouldContinue()) {
      await writeLocationEnrichment(assetId, enrichedAsset);
    }

    return enrichedAsset;
  }

  async function readStoredLocationEnrichment(assetId) {
    if (!ambientConfig.immichMetadataWriteback) {
      return null;
    }
    try {
      const metadata = await immich.getAssetMetadataByKey(assetId, ambientConfig.immichLocationMetadataKey);
      return metadata?.value ?? null;
    } catch (error) {
      console.warn(
        `Failed to read Immich metadata key ${ambientConfig.immichLocationMetadataKey}.`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  async function writeLocationEnrichment(assetId, asset) {
    if (!ambientConfig.immichMetadataWriteback) {
      return;
    }
    const enrichment = getLocationEnrichment(asset);
    if (!enrichment) {
      return;
    }
    try {
      await immich.upsertAssetMetadata(assetId, [
        { key: ambientConfig.immichLocationMetadataKey, value: enrichment },
      ]);
    } catch (error) {
      console.warn(
        `Failed to write Immich metadata key ${ambientConfig.immichLocationMetadataKey}.`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
