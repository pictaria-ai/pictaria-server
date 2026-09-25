import { createProvider } from '../enrich/providers.mjs';

// Shared Curate selection, resolved once when a job starts. Both upcoming AI
// roles use this same override; the released referee is the first consumer.
// Keep the existing settings keys until the explicit settings/cutover migration.
// No role gate belongs here: constructing a provider does not authorize a call.
export function createCurateAiProvider(config, { minimumTimeoutMs = 0 } = {}) {
  const name = config.curateRefereeProvider || config.defaultProvider;
  const options = { ...(config.providers?.[name] ?? {}) };
  if (config.curateRefereeModel) options.modelName = config.curateRefereeModel;
  if (minimumTimeoutMs > 0) {
    // Preserve a longer user timeout without mutating Enrich's configuration.
    options.timeoutMs = Math.max(Number(options.timeoutMs) || 0, minimumTimeoutMs);
  }
  // Adapters copy their scalar connection/inference options at construction.
  // Later Settings edits affect the next job, never this provider instance.
  // This object contains credentials: keep it in memory, never in job records.
  return createProvider(name, options);
}
