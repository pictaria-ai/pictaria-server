import { crc32, deflateSync } from 'node:zlib';

// A model name alone does not identify the vectors a service returns: Immich
// releases can change CLIP resizing/cropping, and NPU builds run quantised
// variants. Every session embeds this fixed synthetic image first. Vectors
// share an embedding space only when their calibration vectors agree.
//
// The image is wider than tall with distinct content at both edges, so a
// centre crop and a squash resize produce clearly different vectors. Change
// the pixels only together with CALIBRATION_VERSION.
export const CALIBRATION_VERSION = 1;

// Repeated inference on one host is effectively exact; cross-runtime noise is
// far smaller than a preprocessing change. Validated against live services.
export const CALIBRATION_MATCH = 0.9995;

const WIDTH = 384, HEIGHT = 256;
let cached = null;

export function calibrationImage() {
  cached ??= encodePng(WIDTH, HEIGHT, calibrationPixels());
  return { data: cached, contentType: 'image/png' };
}

// Raw RGB rows of the calibration image (bin/ml-probe.mjs derives cropped and
// squashed variants from these to measure preprocessing sensitivity).
export function calibrationPixels() {
  const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) rgb.set(pixel(x, y), (y * WIDTH + x) * 3);
  }
  return rgb;
}
export const CALIBRATION_SIZE = Object.freeze({ width: WIDTH, height: HEIGHT });

function pixel(x, y) {
  if ((x - 48) ** 2 + (y - 128) ** 2 <= 40 ** 2) return [220, 30, 30];
  if (x >= WIDTH - 80 && x < WIDTH - 16 && y >= 64 && y < 192) return [20, 40, 200];
  if (y < 24) return [30, 160, 60];
  if (x >= 144 && x < 240 && y >= 80 && y < 176 && ((x >> 4) + (y >> 4)) % 2 === 0) return [245, 245, 245];
  return [Math.round((255 * x) / (WIDTH - 1)), Math.round((255 * y) / (HEIGHT - 1)), 128];
}

// Minimal 8-bit RGB PNG encoder (node:zlib only).
export function encodePng(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    // Filter byte 0 (none) starts each scanline.
    rgb.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
