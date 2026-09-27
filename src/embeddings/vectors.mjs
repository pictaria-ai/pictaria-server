// Stored vectors are float32 little-endian regardless of host byte order, so a
// database restored onto another architecture reads the same values.
export function encodeVector(vector) {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buffer.writeFloatLE(vector[i], i * 4);
  return buffer;
}

export function decodeVector(value) {
  const bytes = value instanceof Uint8Array ? value : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < vector.length; i++) vector[i] = view.getFloat32(i * 4, true);
  return vector;
}

// Cosine similarity of two same-length vectors; null when either is unusable.
// Scale is irrelevant, so raw model output needs no normalisation first.
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return null;
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  if (!(left > 0) || !(right > 0)) return null;
  const value = dot / Math.sqrt(left * right);
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : null;
}
