import { enrichmentProviderConfiguration } from '../enrich/providers.mjs';

// Server-owned evidence, not a vision-model catalog or a paid capability probe.
// PIC-366 exercised this exact hosted model at ten images and rejected thirty.
// Ten is our evaluated ceiling, not a claim about its absolute service maximum.
// The new prompt/schema still needs acceptance before role activation.
const evaluated = Object.freeze({
  provider: 'venice', model: 'qwen3-vl-235b-a22b', comparative: true, maxImages: 10,
});

export function refereeCapability(provider) {
  if (provider?.providerName !== evaluated.provider || provider?.modelName !== evaluated.model ||
      typeof provider.analyzeImages !== 'function') return null;
  try {
    // An arbitrary compatible endpoint or locally assigned model name cannot
    // inherit the hosted model's evidence merely by using the same label.
    if (enrichmentProviderConfiguration(provider).endpoint !== 'https://api.venice.ai/api/v1') return null;
  } catch { return null; }
  return { ...evaluated };
}
