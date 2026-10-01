import { enrichmentProviderConfiguration } from '../enrich/providers.mjs';
import { createCurateAiProvider } from './ai-config.mjs';

// Request policy for Pictaria's existing multi-image transports, not a model
// quality allowlist. The chosen model must support vision and multiple images.
// Ten is a conservative application ceiling (also exercised with Venice in
// PIC-366), not a promise that every configured model accepts ten images.
export const STACK_REFEREE_REQUEST_IMAGES = 10;
const adapters = new Set(['cloud_openai', 'openrouter', 'venice', 'local_lmstudio',
  'local_ollama', 'cloud_ollama', 'openai_compatible']);

export function refereeCapability(provider) {
  if (!adapters.has(provider?.providerName) || typeof provider.analyzeImages !== 'function' ||
      typeof provider.modelName !== 'string' || !provider.modelName.trim()) return null;
  try {
    const endpoint = new URL(enrichmentProviderConfiguration(provider).endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) return null;
  } catch { return null; }
  // Preserve the existing contract shape and exact model binding. This grants
  // bounded admission through the adapter; it does not certify model support.
  return { provider: provider.providerName, model: provider.modelName,
    comparative: true, maxImages: STACK_REFEREE_REQUEST_IMAGES };
}

// Settings feedback uses the same effective selection as the worker. Never
// contacts a provider or returns endpoints, credentials or raw error messages.
export function stackRefereeModelStatus(config) {
  try {
    const provider = createCurateAiProvider(config), capability = refereeCapability(provider);
    if (!capability) return { state: 'unavailable' };
    return { state: 'configured', provider: capability.provider, model: capability.model,
      maxImages: capability.maxImages };
  } catch { return { state: 'configuration' }; }
}
