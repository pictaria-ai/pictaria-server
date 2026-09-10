// Identity and eligibility shared by targeted selection and library discovery.
// Modern inference IDs never match NULL legacy identity; label matching is
// reserved for historical queries and imports.
export function matchingRun(runKey, prefix = '') {
  if (runKey.inferenceId) return { sql: `${prefix}inference_id = ?`, params: [runKey.inferenceId] };
  return {
    sql: `${prefix}provider = ? AND ${prefix}model = ? AND ${prefix}prompt_version = ? AND ${prefix}taxonomy_version = ?`,
    params: [runKey.provider, runKey.model, runKey.promptVersion, runKey.taxonomyVersion],
  };
}

// Callers join candidate alias i(asset_id) to assets alias a.
export function workEligibility({ runKey, skipAnySuccessful = true, reprocess = false, maxFailuresPerAsset = 0 }) {
  const match = matchingRun(runKey, 'p.');
  const parts = ['a.enrich_discarded_at IS NULL'];
  const params = [];
  if (skipAnySuccessful || !reprocess) {
    parts.push(`NOT EXISTS (SELECT 1 FROM processing_runs p WHERE p.asset_id=i.asset_id
      AND p.status='succeeded'${skipAnySuccessful ? '' : ` AND ${match.sql}`})`);
    if (!skipAnySuccessful) params.push(...match.params);
  }
  if (!reprocess && maxFailuresPerAsset > 0) {
    parts.push(`(SELECT COUNT(*) FROM processing_runs p WHERE p.asset_id=i.asset_id
      AND p.status='failed' AND ${match.sql}) < ?`);
    params.push(...match.params, maxFailuresPerAsset);
  }
  return { sql: parts.join(' AND '), params };
}
