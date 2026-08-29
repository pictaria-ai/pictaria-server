export const MAX_REVIEW_ASSET_IDS = 1000;

// Immich asset identifiers are canonical lowercase UUIDs. Keeping this
// contract at the HTTP/service boundary prevents oversized or ambiguous
// identifiers from becoming durable review, audit, or sync state.
const IMMICH_ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AssetBatchError extends Error {
  constructor(message, { code = 'invalid_asset_batch', status = 400 } = {}) {
    super(message);
    this.name = 'AssetBatchError';
    this.code = code;
    this.status = status;
  }
}

export function validateAssetBatch(assetIds, {
  code = 'invalid_asset_batch',
  max = MAX_REVIEW_ASSET_IDS,
} = {}) {
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    throw new AssetBatchError('Expected a non-empty asset id array.', { code });
  }
  if (assetIds.length > max) {
    throw new AssetBatchError(`At most ${max} asset ids may be submitted at once.`, { code });
  }
  const unique = new Set();
  for (const assetId of assetIds) {
    if (typeof assetId !== 'string' || !IMMICH_ASSET_ID.test(assetId)) {
      throw new AssetBatchError('Every asset id must be a canonical lowercase UUID.', { code });
    }
    unique.add(assetId);
  }
  return [...unique].sort();
}
