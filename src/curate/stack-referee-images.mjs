import { captureClient } from '../enrich/runConfiguration.mjs';
import { STACK_REFEREE_ENVELOPE } from './stack-referee-contract.mjs';

// Preview only: no originals, silent thumbnail downgrade, conversion process,
// or second download pass. Oversized/unavailable previews remain manual.
export async function stackRefereeImages(immich, ids, checkpoint, signal) {
  const client = captureClient(immich), images = [];
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let remaining = STACK_REFEREE_ENVELOPE.totalBytes;
  for (const assetId of ids) {
    checkpoint(); deadline.throwIfAborted();
    const maxBytes = Math.min(STACK_REFEREE_ENVELOPE.imageBytes, remaining);
    if (maxBytes <= 0) throw new Error('Stack previews exceed the request envelope.');
    const image = await client.getAssetThumbnail(assetId, 'preview', { maxBytes, signal: deadline });
    checkpoint(); deadline.throwIfAborted();
    // Check injected clients too; production reads enforce this while streaming.
    if (!(image.data instanceof Uint8Array) || !image.data.byteLength || image.data.byteLength > maxBytes)
      throw new Error('Unsupported Stack Referee preview.');
    remaining -= image.data.byteLength;
    images.push({ assetId, data: image.data, mimeType: image.contentType });
  }
  return images;
}
