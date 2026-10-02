import { createHash } from 'node:crypto';
import { captureClient } from '../enrich/runConfiguration.mjs';
import { PHOTO_REFEREE_ENVELOPE, planPhotoRefereeComparisons } from './photo-referee-plan.mjs';

// Preflight the full logical comparison before each paid batch. Only retain
// that batch's bytes; other renditions become compact hashes/sizes immediately.
// This intentionally trades at most three bounded preview passes for no buffer
// cache, disk spool or new recovery state. Retries use the same bounded path.
export async function photoRefereeImages(immich, layout, requestIndex, checkpoint, signal) {
  const client = captureClient(immich), request = layout.requests[requestIndex];
  const selected = new Set([...request.ids, ...request.contextIds]), images = [], renditions = [];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let remaining = PHOTO_REFEREE_ENVELOPE.totalBytes;
  for (const assetId of [...layout.orderedIds, ...layout.contextIds]) {
    checkpoint(); deadline.throwIfAborted();
    const weight = layout.contextIds.includes(assetId) ? layout.requests.length : 1;
    const maxBytes = Math.min(PHOTO_REFEREE_ENVELOPE.imageBytes, Math.floor(remaining / weight));
    if (maxBytes <= 0) throw new Error('Photo previews exceed the comparison envelope.');
    const image = await client.getAssetThumbnail(assetId, 'preview', { maxBytes, signal: deadline });
    checkpoint(); deadline.throwIfAborted();
    const mimeType = typeof image.contentType === 'string' ? image.contentType.toLowerCase().split(';')[0].trim() : '';
    if (!(image.data instanceof Uint8Array) || !image.data.byteLength || image.data.byteLength > maxBytes ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) ||
        (layout.capability.provider === 'local_lmstudio' && mimeType === 'image/webp'))
      throw new Error('Unsupported Photo Referee preview.');
    remaining -= weight * image.data.byteLength;
    renditions.push({ assetId, bytes: image.data.byteLength, mimeType, sha256: createHash('sha256').update(image.data).digest('hex') });
    if (selected.has(assetId)) images.push({ assetId, data: image.data, mimeType });
  }
  const plan = planPhotoRefereeComparisons({ ...layout, renditions });
  if (plan.state !== 'ready') throw new Error('Unsupported Photo Referee comparison.');
  return { plan, images };
}
