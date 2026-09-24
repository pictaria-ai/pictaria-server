// Stable public diagnostics, never upstream messages, photo IDs or credentials.
export const SEARCH_PROBLEMS = Object.freeze({
  similarity_embedding_missing: 'Immich has no search embedding for one or more photos.',
  similarity_search_disabled: 'Smart Search is disabled in Immich. Enable it to check these photos.',
  similarity_access_denied: 'Immich denied similarity searches. Check the API key’s asset.read permission.',
  similarity_rate_limited: 'Immich was busy or limiting requests.',
  similarity_reference_unavailable: 'Immich could not search from a reference photo. Check its availability and Smart Search processing.',
  similarity_timeout: 'The similarity search timed out or was interrupted.',
  similarity_invalid_response: 'Immich returned an unusable similarity ranking.',
  similarity_unavailable: 'Could not load similarity ranks from Immich.',
});
export function problemCode(error) {
  return Object.hasOwn(SEARCH_PROBLEMS, error?.code) ? error.code : 'similarity_unavailable';
}
export const problemMessage = code => SEARCH_PROBLEMS[code] ?? SEARCH_PROBLEMS.similarity_unavailable;

export function classifySearchError(error, aborted) {
  if (aborted) return 'similarity_timeout';
  // Immich 3.2 SearchService.resolveEmbedding uses this explicit HTTP 400
  // diagnostic. Unknown 400s stay generic; never infer absence from status alone.
  if (error?.status === 400 && /\bAsset\s+\S+\s+has no embedding\b/i.test(error.message ?? ''))
    return 'similarity_embedding_missing';
  if (error?.status === 400 && /\bSmart search is not enabled\b/i.test(error.message ?? ''))
    return 'similarity_search_disabled';
  if ([401, 403].includes(error?.status)) return 'similarity_access_denied';
  if (error?.status === 429) return 'similarity_rate_limited';
  if ([400, 404, 422].includes(error?.status)) return 'similarity_reference_unavailable';
  return 'similarity_unavailable';
}
