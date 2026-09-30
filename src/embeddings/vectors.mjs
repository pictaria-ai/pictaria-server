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

// Photo vectors are stored as unit-length IEEE 754 half precision: half the
// size of float32, and error near 1e-4 in a cosine, far below any threshold.
// Calibration vectors stay float32 for the 0.9995 space match.
export function encodeHalfVector(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 1;
  const buffer = Buffer.alloc(vector.length * 2);
  for (let i = 0; i < vector.length; i++) buffer.writeUInt16LE(toHalf(vector[i] * scale), i * 2);
  return buffer;
}

// A stored photo vector: float16, or float32 from builds before float16.
export function decodeStoredVector(value, dims) {
  const bytes = value instanceof Uint8Array ? value : null;
  if (!bytes || !(dims > 0)) return null;
  if (bytes.byteLength === dims * 4) return decodeVector(bytes);
  if (bytes.byteLength !== dims * 2) return null;
  const vector = new Float32Array(dims);
  for (let i = 0; i < dims; i++) vector[i] = fromHalf(bytes[i * 2] | (bytes[i * 2 + 1] << 8));
  return vector;
}

const halfScratch = new DataView(new ArrayBuffer(4));

// Round to nearest, ties to even, including subnormals.
export function toHalf(value) {
  halfScratch.setFloat32(0, value);
  const bits = halfScratch.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 112;
  const mantissa = bits & 0x7fffff;
  if (((bits >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  if (exponent >= 0x1f) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const full = mantissa | 0x800000, shift = 14 - exponent;
    const rest = full & ((1 << shift) - 1), halfway = 1 << (shift - 1);
    let half = full >>> shift;
    if (rest > halfway || (rest === halfway && (half & 1))) half++;
    return sign | half;
  }
  let half = (exponent << 10) | (mantissa >>> 13);
  const rest = mantissa & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half++;
  return sign | half;
}

export function fromHalf(half) {
  const sign = half & 0x8000 ? -1 : 1, exponent = (half >>> 10) & 0x1f, mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
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
