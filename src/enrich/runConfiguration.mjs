import { createHash } from 'node:crypto';
import { ImmichClient } from '../immich.mjs';

import { enrichmentJsonSchema } from './schema.mjs';
import { approvedModelTags, parseTaxonomySource } from './taxonomy.mjs';
import { enrichmentProviderConfiguration } from './providers.mjs';

// Settings accepts at most 2 MiB. The expanded vocabulary, schema, template,
// and original taxonomy can repeat that content; cap their combined record.
export const MAX_RUN_CONFIGURATION_BYTES = 16 * 1024 * 1024;

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

export function buildUserPrompt(userTemplate, taxonomy) {
  const vocabulary = approvedModelTags(taxonomy).join('\n');
  const marker = '{approved_tags}';
  const occurrences = userTemplate.split(marker).length - 1;
  const expandedBytes = Buffer.byteLength(userTemplate)
    + occurrences * (Buffer.byteLength(vocabulary) - marker.length);
  if (expandedBytes > MAX_RUN_CONFIGURATION_BYTES) {
    throw new Error('The expanded Enrich user prompt exceeds the configuration size limit.');
  }
  return userTemplate.replaceAll(marker, vocabulary);
}

// Capture before any asynchronous photo selection. Runtime taxonomy Sets are
// privately reconstructed, never the Settings/Curate object's shared Sets.
// Only explicit non-secret fields enter the durable snapshot; the provider
// and Immich client (including their credentials) remain execution-local.
export function captureRunConfiguration({
  provider, taxonomy, systemPrompt, userTemplate, promptVersion = 'v1',
  imageSource = 'preview', processing = {}, inferenceHostLabel = null, profile = null,
}) {
  const capturedTaxonomy = parseTaxonomySource(JSON.stringify(taxonomy.raw));
  const userPrompt = buildUserPrompt(userTemplate, capturedTaxonomy);
  const jsonSchema = enrichmentJsonSchema(capturedTaxonomy);
  const inference = {
    // Bump when validation, prompt retries, image fallback, or another fixed
    // inference behavior changes in a way that invalidates prior results.
    contractVersion: 1,
    provider: enrichmentProviderConfiguration(provider),
    systemPrompt,
    userPrompt,
    jsonSchema,
    image: { source: imageSource, oversizedOriginalFallback: 'preview' },
  };
  const inferenceId = digest(inference);
  const snapshot = freezeJson(JSON.parse(JSON.stringify({
    formatVersion: 1,
    ...(profile ? { profile } : {}),
    inferenceId,
    inference,
    labels: { promptVersion, taxonomyVersion: capturedTaxonomy.version, inferenceHostLabel },
    userTemplate,
    taxonomy: capturedTaxonomy.raw,
    processing: {
      limit: processing.limit ?? 5,
      offset: processing.offset ?? 0,
      maxAnalyzed: processing.maxAnalyzed ?? null,
      skipAnySuccessful: processing.skipAnySuccessful === true,
      reprocess: processing.reprocess === true,
      maxFailuresPerAsset: processing.maxFailuresPerAsset ?? 2,
      retryFailureLimited: processing.retryFailureLimited === true,
      syncAiTags: processing.syncAiTags === true,
      applyTags: processing.applyTags === true,
      dryRun: processing.dryRun !== false,
      listForReview: processing.listForReview === true,
      reopenDecided: processing.reopenDecided === true,
      captionWriteback: processing.captionWriteback === true,
      providerTimeoutMs: provider.timeoutMs ?? null,
    },
  })));
  if (Buffer.byteLength(canonicalJson(snapshot)) > MAX_RUN_CONFIGURATION_BYTES) {
    throw new Error('The expanded Enrich configuration is too large to save (maximum 16 MiB).');
  }
  const id = digest(snapshot);
  return {
    id, inferenceId, snapshot, taxonomy: capturedTaxonomy,
    systemPrompt, userTemplate, userPrompt, jsonSchema,
    runKey: {
      provider: provider.providerName,
      model: provider.modelName,
      promptVersion,
      taxonomyVersion: capturedTaxonomy.version,
      configurationId: id,
      inferenceId,
    },
  };
}

// ImmichClient uses private methods, so its copy must go through the real
// constructor. Current provider adapters and plain in-memory clients have no
// private members; their scalar settings and transport can be copied directly.
export function captureClient(client) {
  if (client instanceof ImmichClient) return client.clone();
  return Object.assign(Object.create(Object.getPrototypeOf(client)), client);
}
