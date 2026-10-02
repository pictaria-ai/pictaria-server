import { CURATE_AI_MAX_IMAGES, CurateError, fingerprint, validatePartition } from './contracts.mjs';

export const PHOTO_REFEREE_ENVELOPE = Object.freeze({
  images: CURATE_AI_MAX_IMAGES, context: 8, requests: 3,
  imageBytes: 2 * 1024 * 1024, totalBytes: 24 * 1024 * 1024,
});

const invalid = () => { throw new CurateError('Invalid Photo Referee comparison plan.', 'photo_referee_plan', 400); };

// Transport planning only, not admission to background work. The role worker
// supplies authoritative chronological membership, read-only kept context and
// bounded rendition sizes. It must separately enforce readiness, settings,
// current inputs, attempt/photo limits and shared-provider protection.
export function planPhotoRefereeComparisons({ orderedIds, contextIds = [], capability, renditions } = {}) {
  if (!Array.isArray(orderedIds) || !Array.isArray(contextIds)) invalid();
  const allIds = [...orderedIds, ...contextIds];
  validatePartition(allIds, [allIds]);
  if (orderedIds.length < 2) return { state: 'manual-context' };
  if (contextIds.length > PHOTO_REFEREE_ENVELOPE.context) return { state: 'input-limit', reason: 'too-much-context' };
  if (allIds.length > PHOTO_REFEREE_ENVELOPE.images) return { state: 'input-limit', reason: 'too-many-images' };
  if (!capability || typeof capability.provider !== 'string' || !capability.provider.trim() ||
      typeof capability.model !== 'string' || !capability.model.trim() || capability.comparative !== true ||
      !Number.isSafeInteger(capability.maxImages) || capability.maxImages < 2)
    return { state: 'unknown-capability' };
  const perRequest = Math.min(PHOTO_REFEREE_ENVELOPE.images, capability.maxImages) - contextIds.length;
  if (perRequest < 2) return { state: 'manual-layout' };
  const count = Math.ceil(orderedIds.length / perRequest);
  if (count > PHOTO_REFEREE_ENVELOPE.requests) return { state: 'request-limit' };
  const small = Math.floor(orderedIds.length / count), extra = orderedIds.length % count;
  if (small < 2) return { state: 'manual-layout' };
  let offset = 0;
  const requests = Array.from({ length: count }, (_, index) => {
    const ids = orderedIds.slice(offset, offset + small + Number(index < extra));
    offset += ids.length;
    return { ids, contextIds: [...contextIds] };
  });
  // Context is repeated in each comparison. It consumes the aggregate image
  // and byte envelope each time, even though it is not a new actionable photo.
  const submittedImages = orderedIds.length + count * contextIds.length;
  if (submittedImages > PHOTO_REFEREE_ENVELOPE.images) return { state: 'input-limit', reason: 'too-many-images' };
  if (!Array.isArray(renditions) || renditions.length !== allIds.length) invalid();
  validatePartition(allIds, [renditions.map(r => r?.assetId)]);
  const byId = new Map(renditions.map(r => [r.assetId, r.bytes]));
  if (allIds.some(id => !Number.isSafeInteger(byId.get(id)) || byId.get(id) <= 0))
    return { state: 'unavailable-image' };
  const rawBytes = requests.reduce((sum, r) => sum + [...r.ids, ...r.contextIds].reduce((n, id) => n + byId.get(id), 0), 0);
  if (allIds.some(id => byId.get(id) > PHOTO_REFEREE_ENVELOPE.imageBytes) || rawBytes > PHOTO_REFEREE_ENVELOPE.totalBytes)
    return { state: 'byte-limit' };
  const plan = {
    state: 'ready', orderedIds: [...orderedIds], contextIds: [...contextIds],
    capability: { provider: capability.provider, model: capability.model, comparative: true, maxImages: capability.maxImages },
    renditions: allIds.map(assetId => ({ assetId, bytes: byId.get(assetId) })),
    requests, coverage: count === 1 ? 'whole-group' : 'within-batches', submittedImages, rawBytes,
  };
  return { ...plan, planKey: fingerprint(plan) };
}

export function validatePhotoRefereePlan(plan) {
  if (!plan || plan.state !== 'ready') invalid();
  const expected = planPhotoRefereeComparisons(plan);
  if (expected.state !== 'ready' || fingerprint(expected) !== fingerprint(plan)) invalid();
  return expected;
}
