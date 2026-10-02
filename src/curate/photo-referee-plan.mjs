import { CURATE_AI_MAX_IMAGES, CurateError, fingerprint, validatePartition } from './contracts.mjs';

export const PHOTO_REFEREE_ENVELOPE = Object.freeze({
  images: CURATE_AI_MAX_IMAGES, context: 8, requests: 3,
  imageBytes: 2 * 1024 * 1024, totalBytes: 24 * 1024 * 1024,
});

const invalid = () => { throw new CurateError('Invalid Photo Referee comparison plan.', 'photo_referee_plan', 400); };

// Optional references never consume capacity needed by pending photos. Reserve
// their maximum bytes too, so including them cannot push a supported whole
// comparison over the aggregate budget. Multi-request comparisons use none.
export function photoRefereeContextLimit(memberCount, capability) {
  if (!Number.isSafeInteger(memberCount) || memberCount < 2 ||
      !Number.isSafeInteger(capability?.maxImages) || capability.maxImages < 2) return 0;
  const capacity = Math.min(capability.maxImages, PHOTO_REFEREE_ENVELOPE.images,
    Math.floor(PHOTO_REFEREE_ENVELOPE.totalBytes / PHOTO_REFEREE_ENVELOPE.imageBytes));
  return Math.max(0, Math.min(2, capacity - memberCount));
}

// Transport planning only, not admission to background work. The role worker
// supplies authoritative chronological membership, read-only kept context and
// bounded rendition sizes. It must separately enforce readiness, settings,
// current inputs, attempt/photo limits and shared-provider protection.
export function layoutPhotoRefereeComparisons({ orderedIds, contextIds = [], capability } = {}) {
  if (!Array.isArray(orderedIds) || !Array.isArray(contextIds)) invalid();
  const allIds = [...orderedIds, ...contextIds];
  validatePartition(allIds, [allIds]);
  if (orderedIds.length < 2) return { state: 'manual-context' };
  if (contextIds.length > PHOTO_REFEREE_ENVELOPE.context) return { state: 'input-limit', reason: 'too-much-context' };
  if (orderedIds.length > PHOTO_REFEREE_ENVELOPE.images) return { state: 'input-limit', reason: 'too-many-images' };
  if (!capability || typeof capability.provider !== 'string' || !capability.provider.trim() ||
      typeof capability.model !== 'string' || !capability.model.trim() || capability.comparative !== true ||
      !Number.isSafeInteger(capability.maxImages) || capability.maxImages < 2)
    return { state: 'unknown-capability' };
  // Candidates arrive in the repository's nearest-first order. Only selected
  // references belong in the final plan, requests and rendition inventory.
  contextIds = contextIds.slice(0, photoRefereeContextLimit(orderedIds.length, capability));
  const perRequest = Math.min(PHOTO_REFEREE_ENVELOPE.images, capability.maxImages);
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
  // Context exists only for a single whole-stack request. It consumes image
  // and byte capacity, but is never a new actionable photo.
  const submittedImages = orderedIds.length + count * contextIds.length;
  if (submittedImages > PHOTO_REFEREE_ENVELOPE.images) return { state: 'input-limit', reason: 'too-many-images' };
  return { state: 'ready', orderedIds: [...orderedIds], contextIds: [...contextIds],
    capability: { provider: capability.provider, model: capability.model, comparative: true, maxImages: capability.maxImages },
    requests, coverage: count === 1 ? 'whole-group' : 'within-batches', submittedImages };
}

export function planPhotoRefereeComparisons({ renditions, ...input } = {}) {
  const layout = layoutPhotoRefereeComparisons(input);
  if (layout.state !== 'ready') return layout;
  const { orderedIds, contextIds, requests } = layout, allIds = [...orderedIds, ...contextIds];
  if (!Array.isArray(renditions) || renditions.length !== allIds.length) invalid();
  validatePartition(allIds, [renditions.map(r => r?.assetId)]);
  const byId = new Map(renditions.map(r => [r.assetId, r]));
  if (allIds.some(id => !Number.isSafeInteger(byId.get(id).bytes) || byId.get(id).bytes <= 0))
    return { state: 'unavailable-image' };
  if (renditions.some(r => r.sha256 !== undefined && (!/^[a-f0-9]{64}$/.test(r.sha256) ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(r.mimeType)))) invalid();
  const rawBytes = requests.reduce((sum, r) => sum + [...r.ids, ...r.contextIds].reduce((n, id) => n + byId.get(id).bytes, 0), 0);
  if (allIds.some(id => byId.get(id).bytes > PHOTO_REFEREE_ENVELOPE.imageBytes) || rawBytes > PHOTO_REFEREE_ENVELOPE.totalBytes)
    return { state: 'byte-limit' };
  const plan = {
    ...layout, renditions: allIds.map(assetId => {
      const r = byId.get(assetId);
      return { assetId, bytes: r.bytes, ...(r.sha256 === undefined ? {} : { sha256: r.sha256, mimeType: r.mimeType }) };
    }), rawBytes,
  };
  return { ...plan, planKey: fingerprint(plan) };
}

export function validatePhotoRefereePlan(plan) {
  if (!plan || plan.state !== 'ready') invalid();
  const expected = planPhotoRefereeComparisons(plan);
  if (expected.state !== 'ready' || fingerprint(expected) !== fingerprint(plan)) invalid();
  return expected;
}
